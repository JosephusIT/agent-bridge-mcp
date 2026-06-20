/**
 * Single source of truth for the continuous-listening setup guidance and the
 * portable agent skill. Surfaced through the MCP server (so configuring the
 * server teaches the agent how to listen) and through the `agentbridge-setup`
 * CLI. Kept as inline strings so they ship inside `dist/` without extra files.
 */

export const INBOUND_SENTINEL = 'AGENTBRIDGE_INBOUND';
export const READY_SENTINEL = 'AGENTBRIDGE_LISTENER_READY';

/** Concise, host-agnostic setup guide. */
export const SETUP_GUIDE = `# AgentBridge — continuous listening setup

Goal: the agent automatically reacts to new session messages, cross-OS and
cross-agent, with no bespoke configuration.

## How it works

An MCP server cannot push into a model's reasoning, so continuous listening uses
three portable pieces:

1. **Background listener** — \`agentbridge-listen\` connects, joins meeting mode,
   long-polls for new messages, and prints one line per message prefixed with
   \`${INBOUND_SENTINEL}\`. It is transport-only and never runs commands.
2. **Host wake-up** — the host watches the listener's stdout for the
   \`${INBOUND_SENTINEL}\` prefix and wakes the agent into a fresh turn.
3. **Agent turn** — the agent reads the new message and replies via the
   \`send_message\` MCP tool.

## One-time setup

1. Configure the MCP server (env: \`AGENTBRIDGE_SESSION_LINK\`, optional
   \`AGENTBRIDGE_AGENT_NAME\`).
2. Install the listening skill for your host (see below) or run:

   \`\`\`bash
   npx -y -p @agentbridge/mcp-server agentbridge-setup --host <cursor|claude-code|vscode|codex|generic> [--write]
   \`\`\`

3. Start listening (the skill does this for you):

   \`\`\`bash
   AGENTBRIDGE_SESSION_LINK='<link>' AGENTBRIDGE_AGENT_NAME='<name>' agentbridge-listen
   \`\`\`

## Host wake-up wiring

- **Cursor** — run \`agentbridge-listen\` as a background shell with an output
  notification whose regex is \`^${INBOUND_SENTINEL}\`. Each match wakes the agent.
- **Claude Code** — run \`agentbridge-listen\` and use a hook/watcher on the
  \`${INBOUND_SENTINEL}\` line to send a follow-up prompt.
- **VS Code (Continue/Copilot)** — run the listener in a task; a small watcher
  forwards \`${INBOUND_SENTINEL}\` lines into a new chat turn.
- **Codex / Hermes / other** — any host that can watch a process's stdout for the
  \`${INBOUND_SENTINEL}\` sentinel works; this is the universal contract.

## Safety

The agent must ask the user for approval before running any command the skill
suggests. The listener itself only reads/acks messages; replies go out only when
the agent explicitly calls \`send_message\`.
`;

/** Portable skill the agent should follow to listen and respond. */
export const LISTENING_SKILL = `# Skill: AgentBridge continuous listening

Use this skill to participate in an AgentBridge session continuously: listen for
new messages and reply, across any MCP-capable host.

## When to use

When the user asks you to join a session, "keep listening", auto-respond to other
agents, or stay in a meeting.

## Prerequisites

- The \`agentbridge\` MCP server is configured (\`AGENTBRIDGE_SESSION_LINK\`,
  optional \`AGENTBRIDGE_AGENT_NAME\`).
- The \`agentbridge-listen\` CLI is available (ships with the MCP package).

## Steps

1. **Ask before running anything.** Before starting the background listener or
   any shell command, tell the user exactly what you will run and get explicit
   approval. Never execute commands silently.
2. **Start the listener** in the background:
   \`AGENTBRIDGE_SESSION_LINK=… AGENTBRIDGE_AGENT_NAME=… agentbridge-listen\`
   It prints \`${READY_SENTINEL}\` once, then one \`${INBOUND_SENTINEL}\` line per
   new message.
3. **Wake on the sentinel.** Configure your host to watch the listener output for
   the regex \`^${INBOUND_SENTINEL}\` and surface a fresh turn when it matches.
4. **On each wake**, read the new \`${INBOUND_SENTINEL}\` line(s), decide whether a
   reply is warranted (ignore your own echoes and noise), and reply with the
   \`send_message\` MCP tool (\`{ type: 'text', content: '…' }\`).
5. **Stop** by terminating the listener process when the user is done.

## Rules

- Require explicit user approval for every command before executing it.
- Only reply when a message is addressed to you or clearly needs a response.
- Keep replies concise; do not loop on your own messages.
`;

export function setupGuideForHost(host: string): string {
  const normalized = host.toLowerCase();
  const known = ['cursor', 'claude-code', 'vscode', 'codex', 'hermes', 'generic'];
  const label = known.includes(normalized) ? normalized : 'generic';
  return `${SETUP_GUIDE}\n\n---\nSelected host: ${label}\n`;
}
