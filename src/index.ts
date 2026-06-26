#!/usr/bin/env node
/** @junctum/agent-bridge-mcp — MCP stdio server entry point. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadSessionFromEnv, loadTimingConfig } from './config.js';
import { makeConnectAndAwaitApproval } from './connect.js';
import { buildDiagnoseDeps, runDiagnostics } from './diagnose.js';
import { LISTENING_SKILL, SETUP_GUIDE } from './guide.js';
import { createMeetingInboxOptions, MeetingInbox } from './meeting-inbox.js';
import type { AgentBridgeSession, Transport } from './transport.js';
import { HttpTransport } from './transport.js';

const ConnectSchema = z.object({
  capabilities: z.array(z.string()).optional().default([]),
});

const SendMessageSchema = z.object({
  type: z.enum(['text', 'task', 'result', 'error', 'human']).optional().default('text'),
  content: z.string().min(1, 'content is required'),
  to_agent_id: z.string().nullable().optional().default(null),
  metadata: z.record(z.unknown()).optional().default({}),
});

const GetMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional().default(100),
  before: z.string().optional(),
  include_direct: z.boolean().optional().default(true),
});

const JoinMeetingSchema = z.object({
  capabilities: z.array(z.string()).optional().default([]),
  replay_history: z.boolean().optional().default(false),
  start_polling: z.boolean().optional().default(true),
});

const ReceiveMessagesSchema = z.object({
  timeout_ms: z.coerce.number().int().min(0).max(3_600_000).optional(),
});

const AckMessagesSchema = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
});

const PollOnceSchema = z.object({
  seed_only: z.boolean().optional().default(false),
});

const DiagnoseSchema = z.object({
  host: z.string().optional(),
});

const EmptySchema = z.object({}).passthrough();

let session: AgentBridgeSession;
try {
  session = loadSessionFromEnv();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[agentbridge-mcp-server] ${message}`);
  process.exit(1);
}

const timing = loadTimingConfig();
const transport: Transport = new HttpTransport();

const server = new Server(
  { name: '@junctum/agent-bridge-mcp', version: '0.1.0' },
  { capabilities: { tools: {}, logging: {}, resources: {} } }
);

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const connectAndAwaitApproval = makeConnectAndAwaitApproval(session, transport, {
  connectTimeoutMs: timing.connectTimeoutMs,
  approvalPollIntervalMs: timing.approvalPollIntervalMs,
});

const meetingInbox = new MeetingInbox(
  session,
  transport,
  connectAndAwaitApproval,
  createMeetingInboxOptions({
    pollIntervalMs: timing.messagePollIntervalMs,
    inboxMaxMessages: timing.inboxMaxMessages,
    defaultReceiveTimeoutMs: timing.defaultReceiveTimeoutMs,
    notify: async (event) => {
      await server.sendLoggingMessage({
        level: 'info',
        logger: 'agentbridge.inbox',
        data: {
          event: 'agentbridge.messages.available',
          queued_count: event.count,
          latest_message_id: event.latestId,
          session: event.session,
        },
      });
    },
  })
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'connect',
      description: 'Connect this MCP agent to the AgentBridge session. Open links wait for owner approval.',
      inputSchema: {
        type: 'object',
        properties: { capabilities: { type: 'array', items: { type: 'string' } } },
        required: [],
      },
    },
    {
      name: 'join_meeting',
      description: 'Join meeting mode, seed the receive cursor, and optionally start background inbox polling.',
      inputSchema: {
        type: 'object',
        properties: {
          capabilities: { type: 'array', items: { type: 'string' } },
          replay_history: { type: 'boolean', default: false },
          start_polling: { type: 'boolean', default: true },
        },
        required: [],
      },
    },
    {
      name: 'leave_meeting',
      description: 'Stop background inbox polling and return currently pending inbox messages.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_meeting_status',
      description: 'Report connection, polling, cursor, queued message count, last poll time, and last error.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'receive_messages',
      description: 'Long-poll for new inbound meeting messages, returning queued messages or an empty timeout result.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout_ms: { type: 'number', minimum: 0, maximum: 3600000 },
        },
        required: [],
      },
    },
    {
      name: 'get_inbox',
      description: 'Read queued, unacked inbound meeting messages without blocking.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'ack_messages',
      description: 'Mark queued inbox messages handled by id.',
      inputSchema: {
        type: 'object',
        properties: {
          message_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['message_ids'],
      },
    },
    {
      name: 'poll_once',
      description: 'Fetch message history once and update the local inbox for hosts that manage their own loops.',
      inputSchema: {
        type: 'object',
        properties: {
          seed_only: { type: 'boolean', default: false },
        },
        required: [],
      },
    },
    {
      name: 'send_message',
      description: 'Send a text/task/result/error/human message into the AgentBridge session.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'task', 'result', 'error', 'human'], default: 'text' },
          content: { type: 'string' },
          to_agent_id: { type: ['string', 'null'] },
          metadata: { type: 'object' },
        },
        required: ['content'],
      },
    },
    {
      name: 'get_messages',
      description: 'Retrieve paginated message history for the AgentBridge session.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 100, maximum: 500 },
          before: { type: 'string' },
          include_direct: { type: 'boolean', default: true },
        },
        required: [],
      },
    },
    { name: 'list_agents', description: 'List agents visible in the current session.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'get_session_info', description: 'Get session metadata and caller permissions.', inputSchema: { type: 'object', properties: {}, required: [] } },
    {
      name: 'get_started',
      description: 'Return the continuous-listening setup guide: how to make this agent auto-respond to new session messages, with host wake-up wiring (Cursor, Claude Code, VS Code, Codex, etc.).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_listening_skill',
      description: 'Return the portable agent skill for AgentBridge continuous listening (listen -> reply -> ack), including the rule to ask the user before running any command.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'diagnose_continuous_listening',
      description: 'Self-test continuous listening: verify connect/session/agents and report the recommended listening mode (universal tool-loop vs. optional stdout-wake listener) for your host. Pass `host` (cursor|claude-code|vscode|codex|hermes|generic) for tailored guidance.',
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' } },
        required: [],
      },
    },
  ],
}));

const RESOURCES = [
  {
    uri: 'agentbridge://guide/continuous-listening',
    name: 'AgentBridge continuous-listening setup guide',
    description: 'How to set up out-of-the-box continuous listening across hosts.',
    mimeType: 'text/markdown',
    text: SETUP_GUIDE,
  },
  {
    uri: 'agentbridge://skill/continuous-listening',
    name: 'AgentBridge continuous-listening skill',
    description: 'Portable agent skill: listen, wake, reply; ask before running commands.',
    mimeType: 'text/markdown',
    text: LISTENING_SKILL,
  },
];

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
}));

server.setRequestHandler(ReadResourceRequestSchema, (request) => {
  const match = RESOURCES.find((resource) => resource.uri === request.params.uri);
  if (!match) {
    throw new Error(`UNKNOWN_RESOURCE: ${request.params.uri}`);
  }
  return { contents: [{ uri: match.uri, mimeType: match.mimeType, text: match.text }] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'connect': {
        const { capabilities } = ConnectSchema.parse(args ?? {});
        return toolText(await meetingInbox.connect(capabilities));
      }
      case 'join_meeting': {
        const input = JoinMeetingSchema.parse(args ?? {});
        return toolText(await meetingInbox.join({
          capabilities: input.capabilities,
          replayHistory: input.replay_history,
          startPolling: input.start_polling,
        }));
      }
      case 'leave_meeting':
        EmptySchema.parse(args ?? {});
        return toolText(meetingInbox.leave());
      case 'get_meeting_status':
        EmptySchema.parse(args ?? {});
        return toolText(meetingInbox.status());
      case 'receive_messages': {
        const input = ReceiveMessagesSchema.parse(args ?? {});
        return toolText(await meetingInbox.receive({ timeoutMs: input.timeout_ms }));
      }
      case 'get_inbox':
        EmptySchema.parse(args ?? {});
        return toolText(meetingInbox.getInbox());
      case 'ack_messages': {
        const input = AckMessagesSchema.parse(args ?? {});
        return toolText(meetingInbox.ack({ messageIds: input.message_ids }));
      }
      case 'poll_once': {
        const input = PollOnceSchema.parse(args ?? {});
        return toolText(await meetingInbox.pollOnce({ seedOnly: input.seed_only }));
      }
      case 'send_message':
        return toolText(await transport.sendMessage(session, SendMessageSchema.parse(args ?? {})));
      case 'get_messages':
        return toolText(await transport.getMessages(session, GetMessagesSchema.parse(args ?? {})));
      case 'list_agents':
        EmptySchema.parse(args ?? {});
        return toolText(await transport.listAgents(session));
      case 'get_session_info':
        EmptySchema.parse(args ?? {});
        return toolText(await transport.getSessionInfo(session));
      case 'get_started':
        EmptySchema.parse(args ?? {});
        return { content: [{ type: 'text' as const, text: SETUP_GUIDE }] };
      case 'get_listening_skill':
        EmptySchema.parse(args ?? {});
        return { content: [{ type: 'text' as const, text: LISTENING_SKILL }] };
      case 'diagnose_continuous_listening': {
        const input = DiagnoseSchema.parse(args ?? {});
        const deps = buildDiagnoseDeps(session, transport, (caps) => meetingInbox.connect(caps));
        return toolText(await runDiagnostics(deps, { host: input.host }));
      }
      default:
        return { content: [{ type: 'text' as const, text: `UNKNOWN_TOOL: Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return toolError(err);
  }
});

const main = async (): Promise<void> => {
  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
  console.error('[agentbridge-mcp-server] Running on stdio.');
};

try {
  await main();
} catch (err) {
  console.error('[agentbridge-mcp-server] Fatal:', err);
  process.exit(1);
}
