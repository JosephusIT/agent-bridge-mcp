/**
 * Single source of truth for the continuous-listening setup guidance, the
 * portable agent skill, and the paste-ready onboarding prompt. Surfaced through
 * the MCP server (so configuring the server teaches the agent how to listen) and
 * through the `agentbridge-setup` CLI. Kept as inline strings so they ship inside
 * `dist/` without extra files.
 *
 * Design note (learned the hard way): the **direct MCP tool-loop is the universal
 * default** because it does not depend on host stdout/wake behavior. The
 * background `agentbridge-listen` + `AGENTBRIDGE_INBOUND` sentinel is a
 * progressive enhancement for hosts that reliably surface a long-running
 * process's stdout into a fresh agent turn (e.g. Cursor). Some hosts buffer that
 * stdout until the process exits, so the sentinel never wakes the agent — those
 * hosts must use the tool-loop.
 */

export const INBOUND_SENTINEL = 'AGENTBRIDGE_INBOUND';
export const READY_SENTINEL = 'AGENTBRIDGE_LISTENER_READY';

/**
 * Paste-ready onboarding prompt. An agent that receives this can configure the
 * MCP server and start listening reliably on any host with no extra reasoning.
 * Replace the session link and agent name before pasting.
 */
export const ONBOARDING_PROMPT = `Set yourself up to participate continuously in an AgentBridge session.

1) Install the AgentBridge MCP server. Add this to your MCP config and reload:

{
  "mcpServers": {
    "agentbridge": {
      "command": "npx",
      "args": ["-y", "-p", "@junctum/agent-bridge-mcp", "agentbridge-mcp-server"],
      "env": {
        "AGENTBRIDGE_SESSION_LINK": "<your session link>",
        "AGENTBRIDGE_AGENT_NAME": "<your agent name>"
      }
    }
  }
}

2) Self-onboard: call the \`get_started\` and \`get_listening_skill\` tools and
   follow them. Optionally call \`diagnose_continuous_listening\` to confirm the
   connection and learn which listening mode your host supports.

3) Connect and enter meeting mode:
   - call \`connect\`
   - call \`join_meeting\` with { replay_history: false }

4) Listen with the universal tool-loop (works on every host) — repeat until told
   to stop:
   - call \`receive_messages\` with { timeout_ms: 30000 }
   - for each message addressed to you or that clearly needs a reply, respond
     with \`send_message\` { type: "text", content: "..." }
   - call \`ack_messages\` with the ids you actually handled (ack AFTER handling)
   - ignore your own echoes; do not reply to your own messages
   - immediately start the next \`receive_messages\` call

5) (Optional acceleration) If your host can watch a background process's stdout
   and wake you on a regex, you may instead run the background listener and wake
   on \`^${INBOUND_SENTINEL}\`. Test it with one message: if no wake fires within
   one receive cycle, your host buffers stdout — stay on the tool-loop in step 4.

Rules: ask me before running any shell command. Keep replies concise. Keep the
loop going across turns until I say stop.`;

/** Concise, host-agnostic setup guide. Leads with the universal tool-loop. */
export const SETUP_GUIDE = `# AgentBridge — continuous listening setup

Goal: the agent automatically reacts to new session messages, cross-OS and
cross-agent, with no bespoke configuration.

## Fastest path — paste this into your agent

${ONBOARDING_PROMPT}

## The two modes

1. **Tool-loop (universal default).** The agent itself loops the MCP tools:
   \`receive_messages\` -> reason -> \`send_message\` -> \`ack_messages\`. This works
   on **every** MCP host because it never depends on host stdout/wake behavior.
   Use this unless you have proven the accelerator below works on your host.
2. **Background listener (optional accelerator).** \`agentbridge-listen\` connects,
   joins meeting mode, long-polls, and prints one line per message prefixed with
   \`${INBOUND_SENTINEL}\`. A host that watches that stdout (regex \`^${INBOUND_SENTINEL}\`)
   can wake the agent into a fresh turn. Lower overhead, but only reliable on
   hosts that surface a long-running process's stdout live (e.g. Cursor).

> Why two modes: some hosts (e.g. certain CLIs) delay or buffer a long-running
> process's stdout, so \`${INBOUND_SENTINEL}\` may wake the agent late or not at
> all. The tool-loop sidesteps that entirely, so it is the safe default.

## One-time setup

1. Configure the MCP server (env: \`AGENTBRIDGE_SESSION_LINK\`, optional
   \`AGENTBRIDGE_AGENT_NAME\`).
2. Optionally confirm wiring and host capability:

   \`\`\`bash
   npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --host <cursor|claude-code|vscode|codex|hermes|generic> [--write]
   \`\`\`

   Or call the \`diagnose_continuous_listening\` MCP tool, which verifies connect /
   session / agents and tells you which mode to use.
3. Start listening — tool-loop (default) or, if your host supports stdout wake:

   \`\`\`bash
   AGENTBRIDGE_SESSION_LINK='<link>' AGENTBRIDGE_AGENT_NAME='<name>' agentbridge-listen
   \`\`\`

## Self-test (one message)

After setup, send one test message into the session and confirm:

- **Tool-loop:** your next \`receive_messages\` returns it. ✅ You are listening.
- **Listener accelerator:** you see \`${READY_SENTINEL}\` then an \`${INBOUND_SENTINEL}\`
  line AND your host wakes you. If \`${INBOUND_SENTINEL}\` appears but no fresh turn
  fires, your host buffers stdout — fall back to the tool-loop.

## Host notes

- **Cursor** — both modes work. The listener + an output notification on
  \`^${INBOUND_SENTINEL}\` is a good fit because Cursor surfaces background stdout live.
- **Claude Code / VS Code** — use the tool-loop, or wire a hook/watcher on
  \`^${INBOUND_SENTINEL}\` if your setup surfaces live stdout.
- **Hermes / Codex / other CLIs** — prefer the **tool-loop**; background stdout
  wake may be delayed or unreliable, so only enable the listener after a
  successful live test.

## Ack semantics

The tool-loop should \`ack_messages\` **after** it has handled a message, so an
interrupted turn re-delivers unfinished work. The background listener acks
immediately after emitting each line (delivery, not completion) — fine for chat,
but for durable workflows prefer the tool-loop with ack-after-handling. Inbox
state is process-lifetime: a restart reseeds from current history and does not
replay old messages.

## Safety

The agent must ask the user for approval before running any command. The listener
only reads/acks messages; replies are sent only when the agent explicitly calls
\`send_message\`.
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

## Choose a mode

- **Tool-loop (default).** Loop the MCP tools yourself. Works on every host.
- **Background listener (optional).** Only if your host reliably wakes you when a
  background process prints to stdout. Run \`agentbridge-listen\` and wake on
  \`^${INBOUND_SENTINEL}\`. Verify with one test message; if no wake fires, switch
  back to the tool-loop. Never assume it works without testing.

## Steps (tool-loop)

1. **Ask before running anything.** Before starting any background listener or
   shell command, tell the user exactly what you will run and get explicit
   approval. Never execute commands silently.
2. **Connect** with \`connect\`, then \`join_meeting\` with { replay_history: false }.
3. **Loop**:
   - call \`receive_messages\` with { timeout_ms: 30000 }
   - for each message addressed to you or that clearly needs a reply, respond with
     \`send_message\` ({ type: 'text', content: '…' })
   - call \`ack_messages\` with the ids you handled — **ack after handling**, not before
   - immediately start the next \`receive_messages\`
4. **Stop** when the user is done (end the loop / terminate the listener).

## Rules

- Require explicit user approval for every command before executing it.
- Only reply when a message is addressed to you or clearly needs a response.
- Keep replies concise; do not loop on your own messages or echoes.
- Ack only after you have handled a message, so interrupted work is re-delivered.
`;

export interface HostProfile {
  /** Whether this host typically surfaces a long-running process's stdout live. */
  supportsStdoutWake: boolean;
  /** One-line recommendation for this host. */
  recommendation: string;
}

const HOST_PROFILES: Record<string, HostProfile> = {
  cursor: {
    supportsStdoutWake: true,
    recommendation:
      'Both modes work. The background listener + an output notification on `^AGENTBRIDGE_INBOUND` is a good fit.',
  },
  'claude-code': {
    supportsStdoutWake: false,
    recommendation:
      'Prefer the tool-loop. Wire a hook/watcher on `^AGENTBRIDGE_INBOUND` only if your setup surfaces live stdout.',
  },
  vscode: {
    supportsStdoutWake: false,
    recommendation:
      'Prefer the tool-loop. A task watcher on `^AGENTBRIDGE_INBOUND` can work if it surfaces live stdout.',
  },
  codex: {
    supportsStdoutWake: false,
    recommendation:
      'Prefer the tool-loop. Codex-style CLIs may delay or buffer long-running stdout, so only enable the listener after a successful live test.',
  },
  hermes: {
    supportsStdoutWake: false,
    recommendation:
      'Prefer the tool-loop. On Hermes the stdout wake may fire but with delay/uncertainty, so only enable the listener after a successful live test.',
  },
  generic: {
    supportsStdoutWake: false,
    recommendation:
      'Use the tool-loop unless you have proven your host wakes the agent on background stdout.',
  },
};

export function hostProfile(host: string): HostProfile {
  return HOST_PROFILES[host.toLowerCase()] ?? HOST_PROFILES.generic;
}

export function setupGuideForHost(host: string): string {
  const normalized = host.toLowerCase();
  const known = Object.keys(HOST_PROFILES);
  const label = known.includes(normalized) ? normalized : 'generic';
  const profile = hostProfile(label);
  const mode = profile.supportsStdoutWake ? 'tool-loop (listener accelerator also supported)' : 'tool-loop';
  return `${SETUP_GUIDE}\n\n---\nSelected host: ${label}\nRecommended mode: ${mode}\n${profile.recommendation}\n`;
}
