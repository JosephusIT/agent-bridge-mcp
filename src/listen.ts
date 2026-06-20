#!/usr/bin/env node
/**
 * agentbridge-listen — portable continuous-listening loop for any host.
 *
 * Two modes, same output contract:
 *  - In-process (default): uses this package's transport + meeting inbox directly.
 *    Lightweight, no subprocess.
 *  - Wrapper (`--command <cmd> [--arg <a> ...]`): spawns an external MCP server and
 *    drives it through the official @modelcontextprotocol/sdk client. Treats the
 *    server as a black box, so it works with any MCP server that exposes the
 *    join_meeting / receive_messages / ack_messages tools.
 *
 * Either way it connects, joins meeting mode, and long-polls for inbound messages,
 * printing each on a single line with a stable, greppable sentinel prefix so a host
 * (Cursor output notifications, a CI watcher, a CLI wrapper, etc.) can wake an agent
 * into a fresh turn.
 *
 * It is transport-only: it never executes arbitrary commands beyond the optional
 * `--command` MCP server the operator explicitly passes. The host/agent decides how
 * to react to each sentinel line (and must ask the user before running anything).
 */

import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { DEFAULT_AGENT_NAME, loadSessionFromEnv, loadTimingConfig, type TimingConfig } from './config.js';
import { makeConnectAndAwaitApproval } from './connect.js';
import { createMeetingInboxOptions, MeetingInbox } from './meeting-inbox.js';
import type { Message } from './transport.js';
import { HttpTransport } from './transport.js';

export const READY_SENTINEL = 'AGENTBRIDGE_LISTENER_READY';
export const INBOUND_SENTINEL = 'AGENTBRIDGE_INBOUND';
export const ERROR_SENTINEL = 'AGENTBRIDGE_LISTENER_ERROR';

export interface ListenFlags {
  json: boolean;
  once: boolean;
  replay: boolean;
  /** When set, run in wrapper mode against this external MCP server command. */
  command?: string;
  /** Extra args passed to the wrapper `--command`. */
  args: string[];
}

export function parseArgs(argv: string[]): ListenFlags {
  const flags: ListenFlags = { json: false, once: false, replay: false, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        flags.json = true;
        break;
      case '--once':
        flags.once = true;
        break;
      case '--replay':
        flags.replay = true;
        break;
      case '--command':
        flags.command = argv[++i];
        break;
      case '--arg':
        flags.args.push(argv[++i] ?? '');
        break;
      default:
        // Ignore unknown flags to stay forgiving for host wrappers.
        break;
    }
  }
  return flags;
}

function senderLabel(message: Message): string {
  if (message.from_user_id) return `human:${message.from_user_id}`;
  if (message.from_agent_id) return `agent:${message.from_agent_id}`;
  return 'unknown';
}

/** Render one inbound message as a single stable, greppable sentinel line. */
export function formatInbound(message: Message, json: boolean): string {
  if (json) {
    return `${INBOUND_SENTINEL} ${JSON.stringify({
      id: message.id,
      type: message.type,
      from: senderLabel(message),
      to_agent_id: message.to_agent_id ?? null,
      content: message.content,
      created_at: message.created_at,
    })}`;
  }
  const oneLine = String(message.content ?? '').replace(/\s+/g, ' ').trim();
  return `${INBOUND_SENTINEL} id=${message.id} type=${message.type} from=${senderLabel(message)} :: ${oneLine}`;
}

/**
 * A message source the listener loop can drain, regardless of mode.
 * `join` seeds the cursor and `receive` long-polls for new messages.
 */
interface MessageSource {
  readonly agentName: string;
  join(replayHistory: boolean): Promise<void>;
  receive(timeoutMs: number): Promise<Message[]>;
  ack(ids: string[]): Promise<void>;
  close(): Promise<void>;
}

/** In-process source: uses the package transport + meeting inbox directly. */
function createInProcessSource(): MessageSource {
  const session = loadSessionFromEnv();
  const timing = loadTimingConfig();
  const transport = new HttpTransport();
  const connectFn = makeConnectAndAwaitApproval(session, transport, {
    connectTimeoutMs: timing.connectTimeoutMs,
    approvalPollIntervalMs: timing.approvalPollIntervalMs,
  });
  const inbox = new MeetingInbox(
    session,
    transport,
    connectFn,
    createMeetingInboxOptions({
      pollIntervalMs: timing.messagePollIntervalMs,
      inboxMaxMessages: timing.inboxMaxMessages,
      defaultReceiveTimeoutMs: timing.defaultReceiveTimeoutMs,
    })
  );

  return {
    agentName: session.agentName,
    async join(replayHistory: boolean) {
      await inbox.join({ replayHistory, startPolling: true });
    },
    async receive(timeoutMs: number) {
      const result = await inbox.receive({ timeoutMs });
      return result.messages ?? [];
    },
    async ack(ids: string[]) {
      inbox.ack({ messageIds: ids });
    },
    async close() {
      inbox.leave();
      transport.close();
    },
  };
}

/** Wrapper source: drive an external MCP server via the official SDK client. */
function createWrapperSource(command: string, args: string[]): MessageSource {
  const agentName = process.env.AGENTBRIDGE_AGENT_NAME ?? DEFAULT_AGENT_NAME;
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: 'agentbridge-listener', version: '0.1.0' }, { capabilities: {} });

  const callJson = async (name: string, toolArgs: Record<string, unknown>): Promise<unknown> => {
    const res = (await client.callTool({ name, arguments: toolArgs })) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === 'text')?.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  return {
    agentName,
    async join(replayHistory: boolean) {
      await client.connect(transport);
      // start_polling:false — receive_messages drives polling in wrapper mode.
      await callJson('join_meeting', { replay_history: replayHistory, start_polling: false });
    },
    async receive(timeoutMs: number) {
      const result = (await callJson('receive_messages', { timeout_ms: timeoutMs })) as
        | { messages?: Message[] }
        | undefined;
      return result?.messages ?? [];
    },
    async ack(ids: string[]) {
      await callJson('ack_messages', { message_ids: ids });
    },
    async close() {
      await client.close();
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logError(message: string): void {
  console.error(`${ERROR_SENTINEL} ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the source and join meeting mode; exit with a sentinel on failure. */
async function startSource(flags: ListenFlags): Promise<MessageSource> {
  let source: MessageSource;
  try {
    source = flags.command
      ? createWrapperSource(flags.command, flags.args)
      : createInProcessSource();
  } catch (err) {
    logError(errorMessage(err));
    process.exit(1);
  }

  try {
    await source.join(flags.replay);
  } catch (err) {
    logError(errorMessage(err));
    process.exit(1);
  }
  return source;
}

/** Print and ack a batch of inbound messages; ack failures are non-fatal. */
async function emitAndAck(source: MessageSource, messages: Message[], json: boolean): Promise<void> {
  for (const message of messages) {
    console.log(formatInbound(message, json));
  }
  try {
    await source.ack(messages.map((m) => m.id));
  } catch (err) {
    logError(`ack failed: ${errorMessage(err)}`);
  }
}

/** Run one receive/emit/ack cycle. A transient receive error must not stop the loop. */
async function drainOnce(source: MessageSource, flags: ListenFlags, timing: TimingConfig): Promise<void> {
  let messages: Message[];
  try {
    messages = await source.receive(timing.defaultReceiveTimeoutMs);
  } catch (err) {
    logError(errorMessage(err));
    await sleep(timing.messagePollIntervalMs);
    return;
  }
  if (messages.length > 0) {
    await emitAndAck(source, messages, flags.json);
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(argv.slice(2));
  const timing = loadTimingConfig();
  const source = await startSource(flags);
  console.log(`${READY_SENTINEL} agent=${source.agentName} mode=${flags.command ? 'wrapper' : 'in-process'}`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void source.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  do {
    await drainOnce(source, flags, timing);
  } while (!flags.once && !stopping);

  shutdown();
}

/** Only run the listener loop when invoked as a CLI (not when imported by tests). */
function isMainModule(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
