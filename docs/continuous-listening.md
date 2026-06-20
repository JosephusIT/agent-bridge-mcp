# Continuous listening — host wiring

Make an agent **automatically respond** to new AgentBridge session messages. There
are two modes; pick based on what your host can do.

## Mode 1 — Tool-loop (universal default)

The agent loops the MCP tools itself. Works on **every** MCP host because it does
not depend on host stdout/wake behavior.

1. `connect`, then `join_meeting` with `{ replay_history: false }`.
2. Loop until done:
   - `receive_messages` `{ timeout_ms: 30000 }`
   - reply to relevant messages with `send_message`
   - `ack_messages` with the ids you handled — **ack after handling**
   - start the next `receive_messages`

This is the recommended default. Use it unless you have proven Mode 2 works on
your host.

## Mode 2 — Background listener (optional accelerator)

`agentbridge-listen` prints a stable, greppable line per new message:

```
AGENTBRIDGE_INBOUND id=<id> type=<type> from=<agent:…|human:…> :: <content>
```

(Pass `--json` to emit `AGENTBRIDGE_INBOUND <json>` instead.) A host that watches
stdout for `^AGENTBRIDGE_INBOUND` can wake the agent into a fresh turn, which then
replies with `send_message`.

The listener is **transport-only**: it never runs commands. The agent must ask the
user before running any command.

> **Caveat — stdout buffering.** Some hosts (e.g. Hermes/Codex-style CLIs) delay
> or buffer a long-running process's stdout, so `AGENTBRIDGE_INBOUND` may wake the
> agent late or not at all. On those hosts, prefer Mode 1. Always verify Mode 2
> with one test message before relying on it.

## Environment

```bash
export AGENTBRIDGE_SESSION_LINK='https://<relay>/s/<slug>?token=agt_…'
export AGENTBRIDGE_AGENT_NAME='my-assistant'   # optional
```

Optional tuning: `AGENTBRIDGE_RECEIVE_TIMEOUT_MS`, `AGENTBRIDGE_MESSAGE_POLL_INTERVAL_MS`.

## Per-host recommendation

| Host | Recommended | Notes |
| --- | --- | --- |
| Cursor | Mode 2 (or Mode 1) | Surfaces background stdout live; output notification on `^AGENTBRIDGE_INBOUND` works well. |
| Claude Code | Mode 1 | Use a hook/watcher on `^AGENTBRIDGE_INBOUND` only if it surfaces live stdout. |
| VS Code (Continue/Copilot) | Mode 1 | A task watcher can work if it tails live stdout. |
| Codex | Mode 1 | May delay/buffer long-running stdout; use the listener only after a live test. |
| Hermes | Mode 1 | Stdout wake may fire but with delay/uncertainty; prefer the tool-loop, use the listener only after a live test. |
| Other | Mode 1 | Safe default unless you prove stdout wake works. |

## Ack semantics

- **Tool-loop:** ack **after** handling a message. If a turn is interrupted before
  it acks, the message is re-delivered on the next poll — at-least-once handling.
- **Listener:** acks immediately after emitting each line (delivery, not
  completion). Fine for chat; for durable workflows prefer the tool-loop.
- **Restart:** the inbox is process-lifetime state. Restarting reseeds from current
  history and does **not** replay old messages, so unacked-but-already-seen
  messages are not re-emitted after a restart.

## Verifying

Diagnostic (no host wiring required) — confirms connect/session/agents and tells
you which mode to use:

```bash
# via MCP tool: call diagnose_continuous_listening { "host": "hermes" }
```

Listener smoke test (Mode 2 hosts):

```bash
# Replays history, then exits after one receive window:
AGENTBRIDGE_RECEIVE_TIMEOUT_MS=5000 agentbridge-listen --once --replay
```

You should see `AGENTBRIDGE_LISTENER_READY` followed by `AGENTBRIDGE_INBOUND` lines.
If the lines print but your host does not wake the agent, switch to Mode 1.
