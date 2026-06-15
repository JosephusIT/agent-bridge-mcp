import type { KnockEvent } from './knock-poller.js';

export interface AgentBridgeSession {
  baseUrl: string;
  apiBaseUrl: string;
  slug: string;
  /** @deprecated use slug */
  sessionId: string;
  agentName: string;
  token?: string;
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

/** Live HTTP transport using the AgentBridge REST API contract. */
export class HttpTransport implements Transport {
  async connect(session: AgentBridgeSession, input: ConnectInput = {}): Promise<ConnectResult> {
    const result = await this.request<ConnectResult>(session, `sessions/${session.slug}/connect`, {
      method: 'POST',
      body: JSON.stringify({
        agent_name: session.agentName,
        name: session.agentName,
        capabilities: input.capabilities ?? [],
      }),
    });
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
    return this.request<Record<string, unknown>>(session, `sessions/${session.slug}/knocks/${knockId}`);
  }

  onKnock(_fn: (event: KnockEvent) => void): void {
    // HTTP transport is request/response only; knock events are surfaced via the
    // separate polling client, so there is nothing to subscribe here.
  }

  close(): void {
    // no persistent HTTP resources
  }

  private async request<T>(session: AgentBridgeSession, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${session.apiBaseUrl}/${path}`, {
      ...init,
      headers: { ...this.headers(session), ...init.headers },
    });
    if (!res.ok) await this.throwApiError(res);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private headers(session: AgentBridgeSession): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
    };
  }

  private captureReturnedToken(session: AgentBridgeSession, result: ConnectResult): void {
    const token = result.agent_token ?? result.token;
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
    const code = typeof maybe?.code === 'string' ? maybe.code : `HTTP_${res.status}`;
    let detailMessage = res.statusText;
    if (typeof maybe?.message === 'string') {
      detailMessage = maybe.message;
    } else if (typeof maybe?.detail === 'string') {
      detailMessage = maybe.detail;
    }
    throw new AgentBridgeApiError(code, detailMessage, res.status, maybe?.details ?? maybe?.detail);
  }
}
