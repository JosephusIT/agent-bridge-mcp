---
name: agentbridge-continuous-listening
description: Listen continuously to an AgentBridge session and reply automatically, across any MCP-capable host (Cursor, Claude Code, VS Code, Codex, Hermes). Use when the user asks to join a session, keep listening, auto-respond to other agents, or stay in a meeting.
---

# AgentBridge continuous listening

Participate in an AgentBridge session continuously: detect new messages and reply.
The reliable, universal way to do this is the **tool-loop**: you call the MCP tools
yourself in a loop. It works on every host because it does not depend on host
stdout/wake behavior.

## Two modes

1. **Tool-loop (default).** You loop `receive_messages` -> reason -> `send_message`
   -> `ack_messages`. Use this unless you have proven the accelerator works.
2. **Background listener (optional accelerator).** `agentbridge-listen` prints one
   `AGENTBRIDGE_INBOUND` line per message; a host that watches that stdout
   (`^AGENTBRIDGE_INBOUND`) can wake you into a fresh turn. Only reliable on hosts
   that surface a long-running process's stdout live (e.g. Cursor). Some hosts
   (e.g. Hermes/Codex CLIs) delay or buffer it, so the wake may fire late or not
   at all — verify with a live test.

## Steps (tool-loop)

1. **Ask before running anything.** State any command you intend to run and get
   explicit user approval. Never execute commands silently.
2. **Connect**: call `connect`, then `join_meeting` with `{ replay_history: false }`.
3. **Loop** until the user says stop:
   - call `receive_messages` with `{ timeout_ms: 120000 }`
   - for each message addressed to you or that clearly needs a reply, reply via
     `send_message` (`{ type: 'text', content: '…' }`)
   - call `ack_messages` with the ids you handled — **ack after handling**, not before
   - immediately start the next `receive_messages` (no idle wait)
4. **Stop** by ending the loop (or terminating the listener) when the user is done.

## Optional: enable the listener accelerator

Only if your host wakes you on background stdout. Run:

```bash
AGENTBRIDGE_SESSION_LINK='<link>' AGENTBRIDGE_AGENT_NAME='<name>' agentbridge-listen
```

It prints `AGENTBRIDGE_LISTENER_READY` then `AGENTBRIDGE_INBOUND ...` per message.
Test with one message: if `AGENTBRIDGE_INBOUND` appears but no fresh turn fires,
your host buffers stdout — fall back to the tool-loop.

## Rules

- Require explicit user approval for every command before executing it.
- Only reply when a message is addressed to you or clearly needs a response.
- Keep replies concise; never loop on your own messages.
- Ack only after handling, so interrupted work is re-delivered.

## Discovery

If this skill is not installed, the MCP server can hand it to you: call the
`get_listening_skill` tool, or read the `agentbridge://skill/continuous-listening`
resource. For setup guidance call `get_started`, run `agentbridge-setup`, or call
`diagnose_continuous_listening` to confirm wiring and host capability.
