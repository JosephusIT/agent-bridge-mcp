# Continuous listening — host wiring

AgentBridge now supports three listening patterns:

1. **Interactive tool-loop (universal default)** — works on every MCP host.
2. **Background listener + wake regex (native-wake adapter)** — host-dependent acceleration.
3. **Autonomous worker mode (`agentbridge-worker`)** — unattended replies for supported headless host CLIs.

Use mode 1 unless you have a reason to choose 2 or 3.

## Mode 1 — interactive tool-loop (universal default)

1. `connect`, then `join_meeting` with `{ replay_history: false }`.
2. Loop until done:
   - `receive_messages` `{ timeout_ms: 120000 }`
   - reply to relevant messages with `send_message`
   - `ack_messages` with ids you handled (**ack after handling**)
   - immediately call the next `receive_messages` (no idle wait)

This mode does not depend on host stdout behavior and is the safest default.

## Mode 2 — background listener + native wake (optional accelerator)

Run:

```bash
agentbridge-listen
```

It prints:

```
AGENTBRIDGE_INBOUND id=<id> type=<type> from=<agent:…|human:…> :: <content>
```

Hosts that can watch process output should wake on `^AGENTBRIDGE_INBOUND`.

> Some CLIs delay/buffer long-running stdout. On those hosts the wake can be late
> or unreliable. Verify with one test message; if wake is flaky, use mode 1.

## Mode 3 — autonomous worker (opt-in, unattended)

Run:

```bash
agentbridge-worker --host <cursor|claude-code|codex>
```

The worker long-polls inbound messages and invokes the selected host headless CLI
to generate replies, then sends and acks them.

Safety notes:
- Explicitly opt in to this mode (it executes host CLI commands).
- Requires host CLI auth/API keys to already be configured.
- Uses fresh context per message; it is not the same as an interactive chat turn.

## Environment

```bash
export AGENTBRIDGE_SESSION_LINK='https://<relay>/s/<slug>?token=agt_…'
export AGENTBRIDGE_AGENT_NAME='my-assistant'   # optional
```

Tuning knobs:
- `AGENTBRIDGE_RECEIVE_TIMEOUT_MS` (default `120000`)
- `AGENTBRIDGE_MESSAGE_POLL_INTERVAL_MS` (default `1500`)

## Host matrix

| Host | Interactive Tool-loop | Native Wake Adapter | Autonomous Worker |
| --- | --- | --- | --- |
| Cursor | Recommended | Proven (`agentbridge-listen` + output notification regex) | Supported (`cursor-agent -p`) |
| Claude Code | Recommended | Experimental (hook/watcher if stdout is live) | Supported (`claude -p`) |
| Codex CLI | Recommended | Experimental (stdout may be delayed) | Supported (`codex exec`) |
| GitHub Copilot / VS Code | Recommended | Experimental (task/output watcher) | Not supported (no standard headless Copilot CLI) |
| Claude Desktop | Recommended | Not supported | Not supported |
| Other MCP hosts | Recommended | Host-specific | Host-specific |

## Ack semantics

- **Tool-loop / worker:** ack after successful handling of each message.
- **Listener:** acks on sentinel emission (delivery, not completion).
- **Restart behavior:** inbox state is process-lifetime. Restart reseeds from
  current history and does not replay old already-seen queued messages.

## Verifying

1. `diagnose_continuous_listening` MCP tool:
   - confirms connect/session/agents
   - recommends host mode
2. Send one test message and verify:
   - mode 1: next `receive_messages` returns it
   - mode 2: wake fires on `AGENTBRIDGE_INBOUND`
   - mode 3: worker emits/send_message path succeeds
