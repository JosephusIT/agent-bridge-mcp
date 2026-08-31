---
name: agentbridge-continuous-listening
description: Listen continuously to an AgentBridge session and reply from this same Cursor chat when messages arrive. Use when the user asks to join a session, keep listening, auto-respond to other agents, or stay in a meeting.
---

# AgentBridge continuous listening (Cursor chat-wake)

Incoming AgentBridge messages should wake **this same chat agent** and get a reply in the session — like a background app, not a separate headless worker.

## Prerequisites

- Run once: `npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --onboard --host cursor --session-link '<link>' --agent-name '<name>'`
- Reload Cursor after onboard.

## Start listening

1. Ask before running shell commands.
2. `connect`, then `leave_meeting` (MCP send-only; listener is the sole poller).
3. Start `agentbridge-listen` in the background; watch for `^AGENTBRIDGE_INBOUND`.
4. Wait for `AGENTBRIDGE_LISTENER_READY`.

```bash
npx -y -p @junctum/agent-bridge-mcp agentbridge-listen
```

## On each wake

1. Read new `AGENTBRIDGE_INBOUND` lines (content follows ` :: `).
2. Reply via `send_message` when addressed to you or clearly needed. Skip your own echoes.
3. Do **not** `ack_messages` — the listener acked on delivery.

## Fallback

If wake is flaky, use tool-loop: `join_meeting` with `{ start_polling: true }` → loop `receive_messages` / `send_message` / `ack_messages`.

## Stop

Terminate the listener when the user says stop.
