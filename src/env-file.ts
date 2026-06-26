/** Load `.agentbridge/secrets.env` when env vars are not already set. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENTBRIDGE_DIR = '.agentbridge';
export const SECRETS_ENV_REL = `${AGENTBRIDGE_DIR}/secrets.env`;
export const SECRETS_ENV_EXAMPLE_REL = `${AGENTBRIDGE_DIR}/secrets.env.example`;
export const AGENTBRIDGE_GITIGNORE_REL = `${AGENTBRIDGE_DIR}/.gitignore`;

export const SECRETS_ENV_EXAMPLE = `# Paste your session link from the AgentBridge UI, then reload your MCP host.
# This file is gitignored — safe for tokens.

AGENTBRIDGE_SESSION_LINK=https://your-relay.example/s/your-session?token=agt_your_token
AGENTBRIDGE_AGENT_NAME=agentbridge-agent
`;

export const AGENTBRIDGE_GITIGNORE = 'secrets.env\n';

/**
 * Parse a minimal dotenv file (KEY=VALUE, # comments, optional quotes).
 * Only sets keys that are not already present in process.env.
 */
export function applySecretsFile(text: string): number {
  let applied = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied += 1;
  }
  return applied;
}

/** Load `.agentbridge/secrets.env` from cwd if AGENTBRIDGE_SESSION_LINK is unset. */
export function loadAgentbridgeSecretsFile(cwd = process.cwd()): boolean {
  if (process.env.AGENTBRIDGE_SESSION_LINK) return false;
  const path = resolve(cwd, SECRETS_ENV_REL);
  if (!existsSync(path)) return false;
  applySecretsFile(readFileSync(path, 'utf8'));
  return Boolean(process.env.AGENTBRIDGE_SESSION_LINK);
}
