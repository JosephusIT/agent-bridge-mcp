---
name: agentbridge-continuous-listening
description: Join an AgentBridge session and keep the agent responsive by running the portable listener and waking on inbound messages.
---

# AgentBridge Continuous Listening

Use this skill when the user wants this agent to join an AgentBridge session and automatically respond to new messages.

## Preconditions

- The AgentBridge MCP server is configured with `AGENTBRIDGE_SESSION_LINK`.
- The package binary `agentbridge-listener` is available, or the repo has been built from source with `npm install && npm run build`.
- The host can run a long-running command and notify or re-prompt the agent when stdout matches a pattern.

## Setup

1. Tell the user that continuous listening needs a long-running local command.
2. If your host requires approval before running commands, ask for approval to run:

```bash
agentbridge-listener --session-link "$AGENTBRIDGE_SESSION_LINK" --agent-name "$AGENTBRIDGE_AGENT_NAME"
```

3. Start the command in the background or in a supervised terminal.
4. Configure the host to wake this agent when stdout matches:

```text
^AGENTBRIDGE_INBOUND |^AGENTBRIDGE_LISTENER_ERROR
```

5. Confirm that the listener printed `AGENTBRIDGE_LISTENER_READY`.

## Handling A Wake-Up

When the host wakes you because the listener printed `AGENTBRIDGE_INBOUND`:

1. Read the latest listener output.
2. Parse the JSON after `AGENTBRIDGE_INBOUND `.
3. Decide whether the message needs a response from this agent.
4. If a response is useful, call the AgentBridge MCP `send_message` tool with:

```json
{
  "type": "text",
  "content": "your response"
}
```

5. Briefly tell the local user what arrived and what you did.

## Host Notes

- Cursor: run the listener as a background shell command and set an output notification for the regex above.
- VS Code: run it as a task, terminal process, or extension-managed child process; route matching output into a fresh agent turn.
- Claude Code, Codex, Hermes, and other CLI agents: run the listener beside the agent process and have the wrapper create a new prompt when `AGENTBRIDGE_INBOUND` appears.

## Safety

- Do not start long-running commands silently if your host normally asks users for command approval.
- Do not expose session tokens in logs beyond the local command environment.
- The listener acks messages after printing them. If your workflow requires durable handling, persist the inbound JSON before asking the model to act.
- Do not run multiple blocking listeners against the same MCP server process; start one listener process per agent identity.
