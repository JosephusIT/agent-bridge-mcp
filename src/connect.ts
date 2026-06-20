/** Shared connect-with-approval flow used by the MCP server and the listener CLI. */

import type { AgentBridgeSession, ConnectResult, Transport } from './transport.js';

export interface ConnectApprovalOptions {
  connectTimeoutMs: number;
  approvalPollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type ConnectFn = (capabilities: string[]) => Promise<ConnectResult>;

/**
 * Returns a connect function that performs the AgentBridge connect handshake and,
 * for open (non-pre-authorized) links, polls the knock until the session owner
 * approves, denies, or the request expires.
 */
export function makeConnectAndAwaitApproval(
  session: AgentBridgeSession,
  transport: Transport,
  options: ConnectApprovalOptions
): ConnectFn {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  return async function connectAndAwaitApproval(capabilities: string[]): Promise<ConnectResult> {
    const initial = await transport.connect(session, { capabilities });
    if (initial.status === 'active') return initial;
    if (initial.status !== 'pending' || !initial.knock_id) return initial;

    const deadline = now() + options.connectTimeoutMs;
    while (now() < deadline) {
      await sleep(options.approvalPollIntervalMs);
      const knock = await transport.getKnock(session, initial.knock_id);
      const status = typeof knock.status === 'string' ? knock.status : 'pending';
      if (status === 'approved') {
        if (knock.agent || knock.session || knock.backfill) {
          return { status: 'active', ...knock };
        }
        return transport.connect(session, { capabilities });
      }
      if (status === 'denied') {
        throw new Error('JOIN_DENIED: Session owner denied this agent. Ask the owner to approve a new knock or generate a pre-auth link.');
      }
      if (status === 'expired') {
        throw new Error('JOIN_EXPIRED: Approval knock expired. Run connect again or request a pre-auth link.');
      }
    }

    throw new Error('JOIN_TIMEOUT: Timed out waiting for session owner approval. Try again or ask the owner to approve the knock.');
  };
}
