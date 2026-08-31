/** Signal emitted when the session may have new inbound messages. */
export interface KnockEvent {
  hasMessages: boolean;
  checkedAt: string; // ISO-8601
}

export interface AgentBridgeSession {
  baseUrl: string;
  apiBaseUrl: string;
  slug: string;
  /** @deprecated use slug */
  sessionId: string;
  agentName: string;
  /**
   * Bearer used for API calls. After a successful connect this is typically the
   * short-lived agent JWT (`access_token`). The original session-link `agt_`
   * token is preserved in `linkToken` for 401 re-auth.
   */
  token?: string;
  /**
   * Original session-link bearer (`agt_…`) from AGENTBRIDGE_SESSION_LINK.
   * Preserved across connect so expired JWTs can be refreshed without restart.
   */
  linkToken?: string;
}

export type AgentStatus = 'pending' | 'active' | 'paused' | 'denied' | 'revoked';
export type MessageType = 'text' | 'task' | 'result' | 'error' | 'human';

export interface Agent {
  id: string;
  session_id?: string;
  name: string;
  capabilities?: string[];
  status: AgentStatus;
  joined_at?: string | null;
  approved_at?: string | null;
}

export interface Message {
  id: string;
  session_id?: string;
  from_agent_id?: string | null;
  from_user_id?: string | null;
  to_agent_id?: string | null;
  type: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SessionInfo {
  id?: string;
  slug: string;
  name?: string;
  description?: string | null;
  owner_display_name?: string | null;
  owner?: { id?: string; name?: string; display_name?: string };
  join_mode: 'open' | 'token';
  expires_at?: string | null;
  closed_at?: string | null;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConnectInput {
  capabilities?: string[];
}

export interface ConnectResult {
  status: 'active' | 'pending';
  knock_id?: string;
  message?: string;
  agent?: Agent;
  session?: SessionInfo;
  backfill?: Message[];
  token?: string;
  agent_token?: string;
  access_token?: string;
  [key: string]: unknown;
}

export interface SendMessageInput {
  type: MessageType;
  content: string;
  to_agent_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GetMessagesInput {
  limit?: number;
  before?: string;
  include_direct?: boolean;
}

export interface Transport {
  connect(session: AgentBridgeSession, input?: ConnectInput): Promise<ConnectResult>;
  sendMessage(session: AgentBridgeSession, input: SendMessageInput): Promise<Message>;
  getMessages(session: AgentBridgeSession, input?: GetMessagesInput): Promise<Message[]>;
  listAgents(session: AgentBridgeSession): Promise<Agent[]>;
  getSessionInfo(session: AgentBridgeSession): Promise<SessionInfo>;
  getKnock(session: AgentBridgeSession, knockId: string): Promise<Record<string, unknown>>;
  onKnock(fn: (event: KnockEvent) => void): void;
  close(): void;
}

export class AgentBridgeApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public details?: unknown
  ) {
    super(`${code}: ${message}`);
    this.name = 'AgentBridgeApiError';
  }
}

/**
 * Wrap a raw fetch failure (DNS, refused connection, TLS, timeout) in a
 * user-actionable error instead of surfacing "TypeError: fetch failed".
 * The original error is preserved as `cause` for diagnostics.
 */
export function relayUnreachableError(url: string, cause: unknown): AgentBridgeApiError {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw URL when it cannot be parsed; the hint still helps.
  }
  const error = new AgentBridgeApiError(
    'RELAY_UNREACHABLE',
    `could not reach ${host} — check the session link host and relay status`
  );
  error.cause = cause;
  return error;
}

interface RequestOptions {
  /** When false, a 401 is not followed by reconnect+retry (used by connect / retry). */
  allowReauth?: boolean;
}

/** Live HTTP transport using the AgentBridge REST API contract. */
export class HttpTransport implements Transport {
  async connect(session: AgentBridgeSession, input: ConnectInput = {}): Promise<ConnectResult> {
    this.preserveLinkToken(session);
    const result = await this.request<ConnectResult>(
      session,
      `sessions/${session.slug}/connect`,
      {
        method: 'POST',
        body: JSON.stringify({
          agent_name: session.agentName,
          name: session.agentName,
          capabilities: input.capabilities ?? [],
        }),
      },
      { allowReauth: false }
    );
    this.captureReturnedToken(session, result);
    return result;
  }

  async sendMessage(session: AgentBridgeSession, input: SendMessageInput): Promise<Message> {
    return this.request<Message>(session, `sessions/${session.slug}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        type: input.type,
        content: input.content,
        to_agent_id: input.to_agent_id ?? null,
        metadata: input.metadata ?? {},
      }),
    });
  }

  async getMessages(session: AgentBridgeSession, input: GetMessagesInput = {}): Promise<Message[]> {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set('limit', String(input.limit));
    if (input.before) qs.set('before', input.before);
    if (input.include_direct !== undefined) qs.set('include_direct', String(input.include_direct));
    const query = qs.size ? `?${qs}` : '';
    return this.request<Message[]>(session, `sessions/${session.slug}/messages${query}`);
  }

  async listAgents(session: AgentBridgeSession): Promise<Agent[]> {
    return this.request<Agent[]>(session, `sessions/${session.slug}/agents`);
  }

  async getSessionInfo(session: AgentBridgeSession): Promise<SessionInfo> {
    return this.request<SessionInfo>(session, `sessions/${session.slug}`);
  }

  async getKnock(session: AgentBridgeSession, knockId: string): Promise<Record<string, unknown>> {
    // Knock polling during approval uses whatever bearer we have; do not
    // trigger a connect-loop on 401 here (open joins may have no token yet).
    return this.request<Record<string, unknown>>(
      session,
      `sessions/${session.slug}/knocks/${knockId}`,
      {},
      { allowReauth: false }
    );
  }

  onKnock(_fn: (event: KnockEvent) => void): void {
    // HTTP transport is request/response only; knock events are surfaced via the
    // separate polling client, so there is nothing to subscribe here.
  }

  close(): void {
    // no persistent HTTP resources
  }

  private async request<T>(
    session: AgentBridgeSession,
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const allowReauth = options.allowReauth !== false;
    const url = `${session.apiBaseUrl}/${path}`;
    const timeoutMs = Number(process.env.AGENTBRIDGE_FETCH_TIMEOUT_MS ?? 30_000);
    const signal =
      init.signal ??
      (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal,
        headers: { ...this.headers(session), ...init.headers },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new AgentBridgeApiError('POLL_TIMEOUT', `request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw relayUnreachableError(url, err);
    }

    if (res.status === 401 && allowReauth) {
      await this.reauthenticate(session);
      return this.request(session, path, init, { allowReauth: false });
    }

    if (!res.ok) await this.throwApiError(res);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /**
   * On expired agent JWT (401), reconnect using the original session link
   * (`agt_` or open join) and capture the new access_token in memory.
   */
  private async reauthenticate(session: AgentBridgeSession): Promise<void> {
    this.preserveLinkToken(session);
    const linkToken = session.linkToken;
    // Restore the pre-auth bearer when we have one; otherwise clear the JWT so
    // open-join reconnects by agent name alone.
    if (linkToken && linkToken.startsWith('agt_')) {
      session.token = linkToken;
    } else {
      session.token = undefined;
    }

    let result: ConnectResult;
    try {
      result = await this.connect(session, { capabilities: [] });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AgentBridgeApiError(
        'REAUTH_FAILED',
        `agent JWT expired and reconnect failed: ${detail}`,
        401
      );
    }

    if (result.status !== 'active') {
      throw new AgentBridgeApiError(
        'REAUTH_FAILED',
        `agent JWT expired and reconnect returned status=${result.status}` +
          (result.knock_id ? ` (knock ${result.knock_id})` : ''),
        401
      );
    }
  }

  private headers(session: AgentBridgeSession): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
    };
  }

  private preserveLinkToken(session: AgentBridgeSession): void {
    if (!session.linkToken && session.token?.startsWith('agt_')) {
      session.linkToken = session.token;
    }
  }

  private captureReturnedToken(session: AgentBridgeSession, result: ConnectResult): void {
    this.preserveLinkToken(session);
    const token = result.access_token ?? result.agent_token ?? result.token;
    if (typeof token === 'string' && token.length > 0) session.token = token;
  }

  private async throwApiError(res: Response): Promise<never> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const maybe = body as { code?: unknown; message?: unknown; detail?: unknown; details?: unknown } | undefined;
    // FastAPI structured errors are `{ detail: { code, message } }`. Also accept
    // a top-level `{ code, message }` (legacy mocks) and string/array `detail`.
    const detailObj =
      maybe?.detail && typeof maybe.detail === 'object' && !Array.isArray(maybe.detail)
        ? (maybe.detail as { code?: unknown; message?: unknown })
        : undefined;
    const code =
      (typeof detailObj?.code === 'string' && detailObj.code) ||
      (typeof maybe?.code === 'string' && maybe.code) ||
      `HTTP_${res.status}`;
    let detailMessage = res.statusText;
    if (typeof detailObj?.message === 'string') {
      detailMessage = detailObj.message;
    } else if (typeof maybe?.message === 'string') {
      detailMessage = maybe.message;
    } else if (typeof maybe?.detail === 'string') {
      detailMessage = maybe.detail;
    } else if (Array.isArray(maybe?.detail)) {
      detailMessage = JSON.stringify(maybe.detail);
    }
    throw new AgentBridgeApiError(code, detailMessage, res.status, maybe?.details ?? maybe?.detail);
  }
}
