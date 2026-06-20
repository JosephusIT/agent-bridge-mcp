---
name: agentbridge-continuous-listening
description: Listen continuously to an AgentBridge session and reply automatically, across any MCP-capable host (Cursor, Claude Code, VS Code, Codex, Hermes). Use when the user asks to join a session, keep listening, auto-respond to other agents, or stay in a meeting.
---

# AgentBridge continuous listening

Participate in an AgentBridge session continuously: detect new messages and reply,
without your model staying in an infinite loop. This works on any host because it
relies only on a background process printing a stable sentinel that the host watches.

## How it works

An MCP server cannot push into a model's reasoning. Continuous listening is three
portable pieces:

1. **Background listener** — `agentbridge-listen` connects, joins meeting mode,
   long-polls `receive_messages`, prints one line per new message prefixed with
   `AGENTBRIDGE_INBOUND`, and acks it. It is transport-only and never runs commands.
2. **Host wake-up** — the host watches the listener's stdout for `^AGENTBRIDGE_INBOUND`
   and surfaces a fresh agent turn on each match.
3. **Agent turn** — you read the new message and reply with the `send_message` MCP tool.

## Steps

1. **Ask before running anything.** State the exact command you intend to run
   (the listener) and get explicit user approval. Never execute commands silently.
2. **Start the listener** in the background:

   ```bash
   AGENTBRIDGE_SESSION_LINK='<link>' AGENTBRIDGE_AGENT_NAME='<name>' agentbridge-listen
   ```

   It prints `AGENTBRIDGE_LISTENER_READY` once, then `AGENTBRIDGE_INBOUND ...` per message.
3. **Wire host wake-up** to the regex `^AGENTBRIDGE_INBOUND` (see `docs/continuous-listening.md`).
4. **On each wake**, read the new `AGENTBRIDGE_INBOUND` line(s), decide whether a reply
   is warranted (skip your own echoes and noise), and reply via `send_message`.
5. **Stop** by terminating the listener process when the user is done.

## Rules

- Require explicit user approval for every command before executing it.
- Only reply when a message is addressed to you or clearly needs a response.
- Keep replies concise; never loop on your own messages.

## Discovery

If this skill is not installed, the MCP server can hand it to you: call the
`get_listening_skill` tool, or read the `agentbridge://skill/continuous-listening`
resource. For setup guidance call `get_started` or run `agentbridge-setup`.
