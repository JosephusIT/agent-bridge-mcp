#!/usr/bin/env node
/** @agentbridge/mcp-server — MCP stdio server entry point. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { parseSessionLink } from './link-parser.js';
import type { AgentBridgeSession, ConnectResult, Transport } from './transport.js';
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

const EmptySchema = z.object({}).passthrough();

const SESSION_LINK = process.env.AGENTBRIDGE_SESSION_LINK;
if (!SESSION_LINK) {
  console.error('[agentbridge-mcp-server] AGENTBRIDGE_SESSION_LINK is not set.');
  process.exit(1);
}

let parsedLink: ReturnType<typeof parseSessionLink>;
try {
  parsedLink = parseSessionLink(SESSION_LINK);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[agentbridge-mcp-server] Invalid session link: ${message}`);
  process.exit(1);
}

const session: AgentBridgeSession = {
  baseUrl: parsedLink.baseUrl,
  apiBaseUrl: parsedLink.apiBaseUrl,
  slug: parsedLink.slug,
  sessionId: parsedLink.slug,
  agentName: process.env.AGENTBRIDGE_AGENT_NAME ?? 'agentbridge-agent',
  token: parsedLink.token,
};

const transport: Transport = new HttpTransport();

const server = new Server(
  { name: '@agentbridge/mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function connectAndAwaitApproval(capabilities: string[]): Promise<ConnectResult> {
  const initial = await transport.connect(session, { capabilities });
  if (initial.status === 'active') return initial;
  if (initial.status !== 'pending' || !initial.knock_id) return initial;

  const timeoutMs = getNumberEnv('AGENTBRIDGE_CONNECT_TIMEOUT_MS', 300_000);
  const intervalMs = getNumberEnv('AGENTBRIDGE_POLL_INTERVAL_MS', 3_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const knock = await transport.getKnock(session, initial.knock_id);
    const status = typeof knock.status === 'string' ? knock.status : 'pending';
    if (status === 'approved') {
      if (knock.agent || knock.session || knock.backfill) {
        return { status: 'active', ...knock };
      }
      return transport.connect(session, { capabilities });
    }
    if (status === 'denied') {
      throw new Error('JOIN_DENIED: Session owner denied this agent. Ask the owner to approve a new knock or generate a pre-auth link.');
    }
    if (status === 'expired') {
      throw new Error('JOIN_EXPIRED: Approval knock expired. Run connect again or request a pre-auth link.');
    }
  }

  throw new Error('JOIN_TIMEOUT: Timed out waiting for session owner approval. Try again or ask the owner to approve the knock.');
}

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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'connect': {
        const { capabilities } = ConnectSchema.parse(args ?? {});
        return toolText(await connectAndAwaitApproval(capabilities));
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
