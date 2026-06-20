/**
 * Self-test for continuous listening. Verifies the things the MCP server can
 * actually prove — that it can connect, read session metadata, and list agents —
 * and returns a verdict plus the recommended listening mode for the host.
 *
 * Note: the server cannot detect whether a host surfaces background-process
 * stdout into a fresh agent turn, so stdout-wake support is reported as a
 * host-dependent check the user must confirm with one test message. The
 * tool-loop is always safe, so it is the recommended default.
 */

import { hostProfile } from './guide.js';
import { AgentBridgeApiError, type Agent, type AgentBridgeSession, type ConnectResult, type SessionInfo, type Transport } from './transport.js';

export interface DiagnosticsCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type ListeningMode = 'tool-loop' | 'tool-loop+listener';

export interface DiagnosticsReport {
  ok: boolean;
  agentName: string;
  agentId: string | null;
  recommendedMode: ListeningMode;
  checks: DiagnosticsCheck[];
  summary: string;
  nextSteps: string[];
}

export interface DiagnoseInput {
  host?: string;
}

/** Build the human-facing verdict from raw checks. Pure and unit-testable. */
export function summarizeDiagnostics(
  checks: DiagnosticsCheck[],
  host: string
): Pick<DiagnosticsReport, 'ok' | 'recommendedMode' | 'summary' | 'nextSteps'> {
  const ok = checks.every((check) => check.ok);
  const profile = hostProfile(host);
  const recommendedMode: ListeningMode = profile.supportsStdoutWake ? 'tool-loop+listener' : 'tool-loop';

  let summary: string;
  if (!ok) {
    summary = 'One or more checks failed. Fix the failing check below before listening.';
  } else if (profile.supportsStdoutWake) {
    summary =
      'Connected and reachable. Use the universal tool-loop to listen; the background listener accelerator is also supported on this host.';
  } else {
    summary = 'Connected and reachable. Use the universal tool-loop to listen.';
  }

  const nextSteps = [
    'Run the tool-loop: receive_messages -> reason -> send_message -> ack_messages (ack AFTER handling).',
  ];
  if (profile.supportsStdoutWake) {
    nextSteps.push(
      'Optional: run `agentbridge-listen` and wake on `^AGENTBRIDGE_INBOUND`. Verify with one test message; if no fresh turn fires, stay on the tool-loop.'
    );
  } else {
    nextSteps.push(
      `On this host (${host}), prefer the tool-loop: background stdout wake may be delayed or unreliable. Only enable the listener after a successful live test.`
    );
  }
  nextSteps.push('Always ask the user before running any shell command.');

  return { ok, recommendedMode, summary, nextSteps };
}

export interface DiagnoseDeps {
  session: AgentBridgeSession;
  connect: (capabilities: string[]) => Promise<ConnectResult>;
  listAgents: (session: AgentBridgeSession) => Promise<Agent[]>;
  getSessionInfo: (session: AgentBridgeSession) => Promise<SessionInfo>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AUTH_HINT =
  'Authentication failed: the session link/token looks already used, bound to another agent, or expired. Request a fresh AgentBridge link/token (or restart with a persisted returned agent token), then re-run diagnostics.';

/** A connect failure whose HTTP status means the token can't authenticate. */
function isAuthFailure(err: unknown): boolean {
  return err instanceof AgentBridgeApiError && (err.status === 401 || err.status === 403 || err.status === 409);
}

function connectDetail(result: ConnectResult, agentName: string, agentId: string | null): string {
  if (result.status === 'active') {
    const who = result.agent?.name ?? agentName;
    const idSuffix = agentId ? ` (${agentId})` : '';
    return `connected as ${who}${idSuffix}`;
  }
  const reason = result.message ? `: ${result.message}` : '';
  return `connect returned status "${result.status}"${reason}`;
}

/** Run the connect check. Returns the agent id and whether auth is blocked. */
async function runConnectCheck(deps: DiagnoseDeps, checks: DiagnosticsCheck[]): Promise<{ agentId: string | null; authBlocked: boolean }> {
  try {
    const result = await deps.connect([]);
    const agentId = result.agent?.id ?? null;
    const active = result.status === 'active';
    checks.push({ name: 'connect', ok: active, detail: connectDetail(result, deps.session.agentName, agentId) });
    return { agentId, authBlocked: false };
  } catch (err) {
    const authBlocked = isAuthFailure(err);
    const detail = authBlocked ? `${errMsg(err)} — ${AUTH_HINT}` : errMsg(err);
    checks.push({ name: 'connect', ok: false, detail });
    return { agentId: null, authBlocked };
  }
}

async function runSessionCheck(deps: DiagnoseDeps, checks: DiagnosticsCheck[]): Promise<void> {
  try {
    const info = await deps.getSessionInfo(deps.session);
    const closed = Boolean(info.closed_at);
    const detail = closed ? `session "${info.slug}" is closed` : `session "${info.name ?? info.slug}" (join_mode=${info.join_mode})`;
    checks.push({ name: 'session', ok: !closed, detail });
  } catch (err) {
    checks.push({ name: 'session', ok: false, detail: errMsg(err) });
  }
}

async function runAgentsCheck(deps: DiagnoseDeps, checks: DiagnosticsCheck[]): Promise<void> {
  try {
    const agents = await deps.listAgents(deps.session);
    checks.push({ name: 'agents', ok: true, detail: `${agents.length} agent(s) visible` });
  } catch (err) {
    checks.push({ name: 'agents', ok: false, detail: errMsg(err) });
  }
}

/** Run the live diagnostics against the relay and assemble a full report. */
export async function runDiagnostics(deps: DiagnoseDeps, input: DiagnoseInput = {}): Promise<DiagnosticsReport> {
  const host = (input.host ?? 'generic').toLowerCase();
  const checks: DiagnosticsCheck[] = [];

  const { agentId, authBlocked } = await runConnectCheck(deps, checks);

  // Skip dependent checks when connect can't authenticate — they would only
  // produce noisy 401s and obscure the real (token) problem.
  if (!authBlocked) {
    await runSessionCheck(deps, checks);
    await runAgentsCheck(deps, checks);
  }

  const verdict = summarizeDiagnostics(checks, host);
  if (authBlocked) verdict.nextSteps.unshift(AUTH_HINT);
  return { ...verdict, agentName: deps.session.agentName, agentId, checks };
}

export function buildDiagnoseDeps(session: AgentBridgeSession, transport: Transport, connect: (capabilities: string[]) => Promise<ConnectResult>): DiagnoseDeps {
  return {
    session,
    connect,
    listAgents: (s) => transport.listAgents(s),
    getSessionInfo: (s) => transport.getSessionInfo(s),
  };
}
