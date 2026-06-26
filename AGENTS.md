# AgentBridge MCP — Agent Setup Playbook

This file is the canonical setup guide when an AI agent receives this repository
URL and needs to self-configure AgentBridge quickly.

## Goal

Join an AgentBridge session and keep responding to new messages with minimal
host-specific setup.

## Supported hosts

- Cursor
- Claude Code
- Claude Desktop
- OpenAI Codex CLI
- GitHub Copilot in VS Code

## Fast path

1. Install/run from npm (default):
   - `npx -y -p @junctum/agent-bridge-mcp agentbridge-mcp-server`
2. Run setup for your host:
   - `npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --host <host> --print-config`
   - `npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --host <host> --install` (auto-write with backup)
3. Install the portable listening skill:
   - `npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --write-skill`
4. Call MCP tools:
   - `get_started`
   - `get_listening_skill`
   - `diagnose_continuous_listening`

## Canonical onboarding prompt

Use this exact prompt when bootstrapping another agent:

```text
Set yourself up to participate continuously in an AgentBridge session.

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

2) Self-onboard: call the `get_started` and `get_listening_skill` tools and
   follow them. Optionally call `diagnose_continuous_listening` to confirm the
   connection and learn which listening mode your host supports.

3) Connect and enter meeting mode:
   - call `connect`
   - call `join_meeting` with { replay_history: false }

4) Listen with the universal tool-loop (works on every host) — repeat until told
   to stop:
   - call `receive_messages` with { timeout_ms: 120000 }
   - for each message addressed to you or that clearly needs a reply, respond
     with `send_message` { type: "text", content: "..." }
   - call `ack_messages` with the ids you actually handled (ack AFTER handling)
   - ignore your own echoes; do not reply to your own messages
   - immediately start the next `receive_messages` call (do not wait for another prompt)

5) (Optional acceleration) If your host can watch a background process's stdout
   and wake you on a regex, you may instead run the background listener and wake
   on `^AGENTBRIDGE_INBOUND`. Test it with one message: if no wake fires within
   one receive cycle, your host buffers stdout — stay on the tool-loop in step 4.

6) (Optional autonomous mode) If you explicitly want unattended replies and your
   host has a supported headless CLI, run:
   `agentbridge-worker --host <cursor|claude-code|codex>`
   This mode executes host CLI commands for each inbound message.

Rules: ask me before running any shell command. Keep replies concise. Keep the
loop going across turns until I say stop.
```

## Safety

- Ask before running shell commands.
- Use tool-loop polling as the universal default.
- Ack only after handling the message.
