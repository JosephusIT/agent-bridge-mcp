# Continuous Listening

AgentBridge can deliver messages to any MCP-capable agent, but model wake-up is controlled by the host. A seamless setup therefore has two layers:

1. A portable receive loop that watches the AgentBridge session.
2. A host-specific trigger that wakes the agent when the receive loop prints an inbound message.

This package ships both a listener command and an agent skill template so hosts can make that wiring explicit instead of asking users to invent it.

## Quick Start

Configure the MCP server as usual, then start the listener:

```bash
export AGENTBRIDGE_SESSION_LINK='https://agentbridge.example.com/s/your-session?token=agt_xxx'
export AGENTBRIDGE_AGENT_NAME='my-assistant'
agentbridge-listener --session-link "$AGENTBRIDGE_SESSION_LINK" --agent-name "$AGENTBRIDGE_AGENT_NAME"
```

The listener prints stable stdout sentinels:

```text
AGENTBRIDGE_LISTENER_READY {"connected":true,...}
AGENTBRIDGE_INBOUND {"id":"msg_123","type":"text","content":"hello",...}
AGENTBRIDGE_LISTENER_ERROR <message>
```

Configure your host to watch for:

```text
^AGENTBRIDGE_INBOUND 
```

When that line appears, the host should start a fresh agent turn. The agent reads the inbound JSON, decides whether to reply, then calls the MCP `send_message` tool.

## What The Listener Does

`agentbridge-listener` is a small MCP stdio client. It launches the local AgentBridge MCP server, calls `join_meeting`, loops on `receive_messages`, prints every inbound message as `AGENTBRIDGE_INBOUND <json>`, and calls `ack_messages` after printing each batch.

It does not try to keep the model itself alive forever. That is intentional: Cursor, VS Code, Claude Code, Codex, Hermes, and other hosts all have different automation APIs. The listener provides the same transport contract everywhere; the host decides how to wake the model.

## Command Options

```bash
agentbridge-listener --session-link <url> [options]
```

Options:

- `--agent-name <name>` sets the display name used in the AgentBridge session.
- `--timeout-ms <ms>` controls each long-poll `receive_messages` call. Default: `30000`.
- `--replay-history` replays visible history on startup. By default only new messages are delivered.
- `--command <cmd>` launches a custom MCP server command instead of the package server.
- `--arg <value>` passes an extra argument to `--command`; repeat for multiple arguments.

Environment variables are also supported:

- `AGENTBRIDGE_SESSION_LINK`
- `AGENTBRIDGE_AGENT_NAME`
- `AGENTBRIDGE_RECEIVE_TIMEOUT_MS`

## Host Setup Pattern

Use this same pattern in every host:

1. Ask the user to approve starting a long-running listener command if the host requires command approval.
2. Run `agentbridge-listener` with the session link and agent name.
3. Watch stdout for `^AGENTBRIDGE_INBOUND `.
4. On each match, wake the model into a fresh turn with the inbound JSON.
5. The model handles the message and replies with the MCP `send_message` tool when appropriate.

## Cursor

Cursor can run the listener as a background shell command and monitor output with a regex notification. The monitored pattern should be:

```text
^AGENTBRIDGE_INBOUND |^AGENTBRIDGE_LISTENER_ERROR
```

In the wake-up turn, read the listener output, summarize the inbound message to the user when useful, and call `send_message` if a response is needed.

## VS Code And Generic MCP Hosts

Use the host's task runner, terminal monitor, extension command, or automation API to run the listener and watch stdout. If the host cannot wake an agent from terminal output, keep the listener visible and have an automation periodically hand new `AGENTBRIDGE_INBOUND` lines to the agent.

## Claude Code, Codex, Hermes, And CLI Agents

Run `agentbridge-listener` beside the agent process. The wrapper, supervisor, or CLI integration should treat `AGENTBRIDGE_INBOUND` as an event and start a new prompt with:

- the inbound JSON,
- the instruction to respond only if useful,
- access to the configured AgentBridge MCP server for `send_message`.

## Packaged Skill

The skill template in `skills/agentbridge-continuous-listening/SKILL.md` tells an agent how to:

- explain the required long-running command to the user,
- request approval before starting it when required,
- monitor `AGENTBRIDGE_INBOUND`,
- reply through the MCP `send_message` tool.

Copy or import that skill into your agent host, then tell users: "Run the AgentBridge continuous listening skill for this session."

## Reliability Notes

- The listener acks messages after printing them. If a host needs durable delivery, persist each `AGENTBRIDGE_INBOUND` line before asking the model to act.
- Only one blocking `receive_messages` call can run per MCP server process.
- Restarting the MCP server loses its in-process unacked inbox. Start the listener again to continue from the current session cursor.
- The MCP server may emit logging notifications, but stdout sentinels are the most portable cross-host contract.
