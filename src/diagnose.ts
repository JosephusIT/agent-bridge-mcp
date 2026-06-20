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
import type { Agent, AgentBridgeSession, ConnectResult, SessionInfo, Transport } from './transport.js';

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

  const summary = ok
    ? `Connected and reachable. Use the universal tool-loop to listen${
        profile.supportsStdoutWake ? '; the background listener accelerator is also supported on this host' : ''
      }.`
    : 'One or more checks failed. Fix the failing check below before listening.';

  const nextSteps = [
    'Run the tool-loop: receive_messages -> reason -> send_message -> ack_messages (ack AFTER handling).',
  ];
  if (profile.supportsStdoutWake) {
    nextSteps.push(
      'Optional: run `agentbridge-listen` and wake on `^AGENTBRIDGE_INBOUND`. Verify with one test message; if no fresh turn fires, stay on the tool-loop.'
    );
  } else {
    nextSteps.push(
      `Skip the stdout listener on this host (${host}): it buffers long-running stdout, so the wake is unreliable.`
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

/** Run the live diagnostics against the relay and assemble a full report. */
export async function runDiagnostics(deps: DiagnoseDeps, input: DiagnoseInput = {}): Promise<DiagnosticsReport> {
  const host = (input.host ?? 'generic').toLowerCase();
  const checks: DiagnosticsCheck[] = [];
  let agentId: string | null = null;

  try {
    const result = await deps.connect([]);
    agentId = result.agent?.id ?? null;
    const active = result.status === 'active';
    checks.push({
      name: 'connect',
      ok: active,
      detail: active
        ? `connected as ${result.agent?.name ?? deps.session.agentName}${agentId ? ` (${agentId})` : ''}`
        : `connect returned status "${result.status}"${result.message ? `: ${result.message}` : ''}`,
    });
  } catch (err) {
    checks.push({ name: 'connect', ok: false, detail: errMsg(err) });
  }

  try {
    const info = await deps.getSessionInfo(deps.session);
    const closed = Boolean(info.closed_at);
    checks.push({
      name: 'session',
      ok: !closed,
      detail: closed ? `session "${info.slug}" is closed` : `session "${info.name ?? info.slug}" (join_mode=${info.join_mode})`,
    });
  } catch (err) {
    checks.push({ name: 'session', ok: false, detail: errMsg(err) });
  }

  try {
    const agents = await deps.listAgents(deps.session);
    checks.push({ name: 'agents', ok: true, detail: `${agents.length} agent(s) visible` });
  } catch (err) {
    checks.push({ name: 'agents', ok: false, detail: errMsg(err) });
  }

  const verdict = summarizeDiagnostics(checks, host);
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
