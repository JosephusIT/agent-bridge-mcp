# Continuous listening — host wiring

This guide shows how to make an agent **automatically respond** to new AgentBridge
session messages on each host. The contract is identical everywhere:

1. Run the bundled listener: `agentbridge-listen`.
2. It prints `AGENTBRIDGE_LISTENER_READY` once, then one line per new message:

   ```
   AGENTBRIDGE_INBOUND id=<id> type=<type> from=<agent:…|human:…> :: <content>
   ```

   (Pass `--json` to emit `AGENTBRIDGE_INBOUND <json>` instead.)
3. The host watches stdout for the regex `^AGENTBRIDGE_INBOUND` and wakes the agent
   into a fresh turn.
4. The agent reads the line and replies with the `send_message` MCP tool.

The listener is **transport-only**: it never runs commands. Replies happen only when
the agent explicitly calls `send_message`, and the agent must ask the user before
running any command.

## Environment

```bash
export AGENTBRIDGE_SESSION_LINK='https://<relay>/s/<slug>?token=agt_…'
export AGENTBRIDGE_AGENT_NAME='my-assistant'   # optional
```

Optional tuning: `AGENTBRIDGE_RECEIVE_TIMEOUT_MS`, `AGENTBRIDGE_MESSAGE_POLL_INTERVAL_MS`.

## Cursor

Run the listener as a background shell with an **output notification** whose regex is
`^AGENTBRIDGE_INBOUND`. Each match surfaces a task notification that gives the agent a
fresh turn; the agent reads the new line and calls `send_message`.

```bash
agentbridge-listen
```

## Claude Code

Start the listener in the background and use a hook/watcher that fires when a line
matches `^AGENTBRIDGE_INBOUND`, sending a follow-up prompt that asks the agent to read
the new message and reply.

## VS Code (Continue / Copilot / custom)

Run `agentbridge-listen` as a task. A small watcher tails the task output and, on each
`^AGENTBRIDGE_INBOUND` line, opens/continues a chat turn with the message content.

## Codex / Hermes / other MCP hosts

Any host that can watch a process's stdout works. Run `agentbridge-listen`, match
`^AGENTBRIDGE_INBOUND`, and route the line into a new agent turn. Hosts without output
watchers can instead loop the `receive_messages` MCP tool directly (the universal
fallback).

## Verifying

```bash
# One-shot smoke test (replays history, then exits after one receive window):
AGENTBRIDGE_RECEIVE_TIMEOUT_MS=5000 agentbridge-listen --once --replay
```

You should see `AGENTBRIDGE_LISTENER_READY` followed by `AGENTBRIDGE_INBOUND` lines.
