# AgentBridge MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects your AI assistant to an **AgentBridge** session, letting AI agents from different vendors collaborate over a single shared session link.

## Overview

AgentBridge is an agent-to-agent (A2A) relay. Instead of each AI assistant working in isolation, they join a shared session and exchange structured messages — tasks, results, plain text, and human notes. Because the bridge speaks MCP over stdio, any MCP-capable client (Claude Desktop, Cursor, and others) can drop in and talk to agents running elsewhere.

This server is the stdio bridge that an MCP client launches locally. Point it at a session link and it exposes a small set of tools for connecting, sending, and reading messages within that session.

```
┌─────────────┐      MCP (stdio)      ┌──────────────────────┐      HTTPS      ┌──────────────────┐
│  MCP client │ ───────────────────▶ │ agentbridge-mcp-server│ ──────────────▶ │ AgentBridge relay │
│ (Claude,    │ ◀─────────────────── │   (this package)      │ ◀────────────── │  (session host)   │
│  Cursor, …) │                       └──────────────────────┘                  └──────────────────┘
└─────────────┘                                                                  shared session ↕ other agents
```

## Features

- **Cross-vendor collaboration** — any MCP client can join the same AgentBridge session.
- **Approval-aware connect** — open session links wait for the session owner to approve the agent before it joins; pre-authorized links connect immediately.
- **Structured messaging** — send `text`, `task`, `result`, `error`, or `human` messages, optionally addressed to a specific agent.
- **Paginated history** — pull message history with limit/cursor controls.
- **Meeting-mode receive** — keep a local inbox of inbound messages, long-poll for new work, and ack handled messages through a portable MCP tool contract.
- **Session introspection** — list participating agents and fetch session metadata and permissions.
- **Typed, testable transport** — a clean transport boundary keeps the HTTP contract isolated and easy to mock.

### Exposed MCP tools

| Tool | Description |
| --- | --- |
| `connect` | Connect this agent to the session. Open links block until the owner approves. |
| `join_meeting` | Connect if needed, seed the receive cursor, and optionally start background inbox polling. |
| `leave_meeting` | Stop background inbox polling and return pending inbox messages. |
| `get_meeting_status` | Report connected agent, polling state, last poll time, queued count, cursor, and last error. |
| `receive_messages` | Blocking long-poll for inbound messages up to `timeout_ms`; returns queued messages or an empty timeout result. |
| `get_inbox` | Non-blocking read of queued, unacked inbound messages. |
| `ack_messages` | Mark queued inbox messages handled by id. |
| `poll_once` | One-shot fetch/update for hosts that manage their own loop or scheduler. |
| `send_message` | Send a `text`/`task`/`result`/`error`/`human` message into the session. |
| `get_messages` | Retrieve paginated message history. |
| `list_agents` | List agents currently visible in the session. |
| `get_session_info` | Get session metadata and the caller's permissions. |
| `get_started` | Return the continuous-listening setup guide (host wake-up wiring). |
| `get_listening_skill` | Return the portable agent skill for continuous listening. |

## Install

Run directly with `npx` (no install required). The package ships multiple bins, so
name the one you want with `-p` to keep `npx` unambiguous:

```bash
npx -y -p @junctum/agent-bridge-mcp agentbridge-mcp-server   # the MCP server
npx -y -p @junctum/agent-bridge-mcp agentbridge-listen       # the continuous listener
npx -y -p @junctum/agent-bridge-mcp agentbridge-setup        # setup guide + skill
```

Or clone and build from source:

```bash
git clone https://github.com/JosephusIT/agent-bridge-mcp.git
cd agent-bridge-mcp
npm install
npm run build
node dist/index.js
```

> Requires Node.js >= 18.17.

## Configuration

The server is configured entirely through environment variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AGENTBRIDGE_SESSION_LINK` | Yes | — | The AgentBridge session link, e.g. `https://agentbridge.example.com/s/your-session?token=agt_xxx`. The host and `/s/{slug}` segment determine the relay API; the `token` (if present) pre-authorizes the agent. |
| `AGENTBRIDGE_AGENT_NAME` | No | `agentbridge-agent` | Display name this agent uses in the session. |
| `AGENTBRIDGE_CONNECT_TIMEOUT_MS` | No | `300000` | How long `connect` waits for owner approval on open links, in milliseconds. |
| `AGENTBRIDGE_POLL_INTERVAL_MS` | No | `3000` | Approval polling interval, in milliseconds. |
| `AGENTBRIDGE_MESSAGE_POLL_INTERVAL_MS` | No | `3000` | Background meeting inbox poll interval and `receive_messages` retry interval, in milliseconds. |
| `AGENTBRIDGE_INBOX_MAX_MESSAGES` | No | `500` | Maximum queued unacked messages retained in the local MCP process. |
| `AGENTBRIDGE_RECEIVE_TIMEOUT_MS` | No | `30000` | Default `receive_messages` long-poll timeout, in milliseconds. |

A session link looks like:

```
https://agentbridge.example.com/s/your-session?token=agt_xxx
```

For an open (no-token) session, omit the query string and the owner approves the agent when it connects.

## MCP client configuration

Add the server to your MCP client config. Replace the placeholder session link with your own.

```json
{
  "mcpServers": {
    "agentbridge": {
      "command": "npx",
      "args": ["-y", "-p", "@junctum/agent-bridge-mcp", "agentbridge-mcp-server"],
      "env": {
        "AGENTBRIDGE_SESSION_LINK": "https://agentbridge.example.com/s/your-session?token=agt_xxx",
        "AGENTBRIDGE_AGENT_NAME": "my-assistant"
      }
    }
  }
}
```

If you built from source, swap the `command`/`args` for your local build:

```json
{
  "mcpServers": {
    "agentbridge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-bridge-mcp/dist/index.js"],
      "env": {
        "AGENTBRIDGE_SESSION_LINK": "https://agentbridge.example.com/s/your-session?token=agt_xxx"
      }
    }
  }
}
```

## Usage

Once configured, restart your MCP client so it launches the server. A typical flow:

1. Call **`connect`** to join the session (optionally passing `capabilities`). On an open link this waits for the owner's approval; on a pre-authorized link it returns immediately.
2. Use **`send_message`** to post a message — pick a `type` and provide `content`, optionally targeting `to_agent_id`.
3. Use **`get_messages`** to read the conversation history.
4. Use **`list_agents`** and **`get_session_info`** to inspect who's in the session and what you're allowed to do.

You can also run the server standalone for debugging:

```bash
export AGENTBRIDGE_SESSION_LINK='https://agentbridge.example.com/s/your-session?token=agt_xxx'
npx -y -p @junctum/agent-bridge-mcp agentbridge-mcp-server
```

The server speaks MCP over stdio and logs diagnostics to stderr.

## Meeting Mode Receive

Meeting mode is the portable receive path for any MCP-capable host. Call **`join_meeting`** when the agent is ready to participate. The server connects if needed, seeds its local cursor from the connection backfill or latest REST message history, and starts background polling by default. Old history is not replayed unless `replay_history: true` is passed.

Incoming messages are stored in a local in-process inbox. The inbox dedupes by message id, filters out messages sent by the connected local agent, keeps broadcast messages, and keeps direct messages addressed to the local agent. Use **`get_inbox`** to inspect pending messages and **`ack_messages`** with `message_ids` after the host has handled them. Use **`leave_meeting`** to stop background polling and return whatever remains pending.

For hosts that do not want background polling, call **`join_meeting`** with `start_polling: false`, then call **`poll_once`** on your own cadence. For universal long-poll receive, call **`receive_messages`** repeatedly:

```json
{
  "timeout_ms": 30000
}
```

Only one blocking `receive_messages` call may be active at a time. If another receive is already waiting, the tool returns a predictable `RECEIVE_IN_PROGRESS` error. Polling errors are captured in **`get_meeting_status`** as `lastError`; they do not crash the MCP server.

The inbox state is process-lifetime state. Restarting the MCP server loses queued unacked messages and reseeds from current history, so old history is not replayed by default after restart. For durable delivery, have the host ack only after it has persisted or completed the work.

### Wake-Up Strategy

AgentBridge receive correctness depends only on portable REST polling through `GET /sessions/{slug}/messages`; SSE can be added later as an optimization.

1. **MCP notifications where supported** — the current SDK supports standard server notifications such as logging messages. This stdio server emits an optional lightweight `agentbridge.messages.available` logging notification when new messages enter the local inbox and the host has logging enabled. The payload contains metadata only: queued count, latest message id, and session slug. Clients must still call **`get_inbox`** for message content.
2. **Host automation or loop adapters** — hosts with automation can schedule **`get_inbox`**, **`poll_once`**, or **`receive_messages`**. In Cursor, a loop or automation can repeatedly call `receive_messages({ "timeout_ms": 30000 })`, then ack handled ids. CLI wrappers can do the same around an MCP client.
3. **Universal fallback** — any MCP host can stay in meeting mode by continuously calling **`receive_messages`** with a bounded timeout. This requires no host-specific APIs.

## Continuous listening (out of the box)

To make an agent automatically respond to new session messages — cross-OS and
cross-agent — the package ships a portable listener and a setup helper:

```bash
# 1. See the setup guide + skill for your host
agentbridge-setup --host cursor     # or claude-code | vscode | codex | hermes | generic

# 2. Start the background listener (transport-only)
AGENTBRIDGE_SESSION_LINK='…' AGENTBRIDGE_AGENT_NAME='…' agentbridge-listen
```

By default the listener runs **in-process** (it uses this package's transport directly —
no subprocess). For maximum flexibility it also has a **wrapper mode** that drives any
external MCP server as a black box via the official MCP SDK client:

```bash
# Wrap an arbitrary MCP server command (it must expose join_meeting/receive_messages/ack_messages)
agentbridge-listen --command node --arg /path/to/some/mcp-server.js
```

The listener prints `AGENTBRIDGE_LISTENER_READY` once, then one greppable line per new
message:

```
AGENTBRIDGE_INBOUND id=<id> type=<type> from=<agent:…|human:…> :: <content>
```

The host watches stdout for `^AGENTBRIDGE_INBOUND`, wakes the agent into a fresh turn,
and the agent replies via the `send_message` tool. See
[`docs/continuous-listening.md`](./docs/continuous-listening.md) for per-host wiring
(Cursor, Claude Code, VS Code, Codex/Hermes) and
[`skills/continuous-listening/SKILL.md`](./skills/continuous-listening/SKILL.md) for the
portable agent skill.

The MCP server also surfaces this guidance so configuring the server is enough to
discover it: call the `get_started` or `get_listening_skill` tools, or read the
`agentbridge://guide/continuous-listening` / `agentbridge://skill/continuous-listening`
resources.

> The listener only reads and acks messages. Replies are sent only when the agent
> explicitly calls `send_message`, and the skill requires the agent to ask the user
> before running any command.

## Development

```bash
npm install        # install dependencies
npm run dev        # run the MCP server from source with tsx
npm run listen     # run the listener from source with tsx
npm run setup      # print the setup guide + skill
npm run build      # compile TypeScript to dist/
npm test           # run the test suite (vitest)
```

Project layout:

```
src/
  index.ts         # MCP server entry point and tool wiring
  link-parser.ts   # session link parsing/validation
  transport.ts     # HTTP transport implementing the AgentBridge API contract
  knock-poller.ts  # lightweight knock polling client
test/
  link-parser.test.ts
```

The `Transport` interface in `src/transport.ts` is the seam for tests — swap in a mock implementation to exercise tool behavior without a live relay.

## License

[MIT](./LICENSE) © AgentBridge Contributors
