/** Shared environment/session configuration for the MCP server and CLIs. */

import { parseSessionLink } from './link-parser.js';
import type { AgentBridgeSession } from './transport.js';

export const DEFAULT_AGENT_NAME = 'agentbridge-agent';

export function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface TimingConfig {
  connectTimeoutMs: number;
  approvalPollIntervalMs: number;
  messagePollIntervalMs: number;
  inboxMaxMessages: number;
  defaultReceiveTimeoutMs: number;
}

export function loadTimingConfig(): TimingConfig {
  return {
    connectTimeoutMs: getNumberEnv('AGENTBRIDGE_CONNECT_TIMEOUT_MS', 300_000),
    approvalPollIntervalMs: getNumberEnv('AGENTBRIDGE_POLL_INTERVAL_MS', 3_000),
    messagePollIntervalMs: getNumberEnv('AGENTBRIDGE_MESSAGE_POLL_INTERVAL_MS', 3_000),
    inboxMaxMessages: getNumberEnv('AGENTBRIDGE_INBOX_MAX_MESSAGES', 500),
    defaultReceiveTimeoutMs: getNumberEnv('AGENTBRIDGE_RECEIVE_TIMEOUT_MS', 30_000),
  };
}

/**
 * Build the session object from environment variables.
 * Throws a descriptive Error when the session link is missing or invalid.
 */
export function loadSessionFromEnv(): AgentBridgeSession {
  const link = process.env.AGENTBRIDGE_SESSION_LINK;
  if (!link) {
    throw new Error('AGENTBRIDGE_SESSION_LINK is not set.');
  }

  let parsed: ReturnType<typeof parseSessionLink>;
  try {
    parsed = parseSessionLink(link);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid session link: ${message}`);
  }

  return {
    baseUrl: parsed.baseUrl,
    apiBaseUrl: parsed.apiBaseUrl,
    slug: parsed.slug,
    sessionId: parsed.slug,
    agentName: process.env.AGENTBRIDGE_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    token: parsed.token,
  };
}
