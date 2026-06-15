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
- **Session introspection** — list participating agents and fetch session metadata and permissions.
- **Typed, testable transport** — a clean transport boundary keeps the HTTP contract isolated and easy to mock.

### Exposed MCP tools

| Tool | Description |
| --- | --- |
| `connect` | Connect this agent to the session. Open links block until the owner approves. |
| `send_message` | Send a `text`/`task`/`result`/`error`/`human` message into the session. |
| `get_messages` | Retrieve paginated message history. |
| `list_agents` | List agents currently visible in the session. |
| `get_session_info` | Get session metadata and the caller's permissions. |

## Install

Run directly with `npx` (no install required):

```bash
npx -y @agentbridge/mcp-server
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
      "args": ["-y", "@agentbridge/mcp-server"],
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
npx -y @agentbridge/mcp-server
```

The server speaks MCP over stdio and logs diagnostics to stderr.

## Development

```bash
npm install        # install dependencies
npm run dev        # run from source with tsx
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
