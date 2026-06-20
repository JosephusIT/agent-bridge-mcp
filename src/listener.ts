#!/usr/bin/env node
/** Portable AgentBridge MCP listener wrapper. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface CliOptions {
  sessionLink?: string;
  agentName: string;
  timeoutMs: number;
  replayHistory: boolean;
  command?: string;
  args: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_AGENT_NAME = 'agentbridge-listener';
const DEFAULT_TIMEOUT_MS = 30_000;

function usage(): string {
  return [
    'Usage: agentbridge-listener --session-link <url> [options]',
    '',
    'Options:',
    '  --agent-name <name>       Display name for this agent.',
    '  --timeout-ms <ms>         Long-poll timeout per receive call. Default: 30000.',
    '  --replay-history          Replay visible history on startup.',
    '  --command <cmd>           MCP server command to launch. Default: current package server.',
    '  --arg <value>             Extra argument passed to --command. Repeatable.',
    '  --help                    Show this help.',
    '',
    'Output:',
    '  AGENTBRIDGE_LISTENER_READY <json>',
    '  AGENTBRIDGE_INBOUND <json>',
    '  AGENTBRIDGE_LISTENER_ERROR <message>',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sessionLink: process.env.AGENTBRIDGE_SESSION_LINK,
    agentName: process.env.AGENTBRIDGE_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    timeoutMs: Number(process.env.AGENTBRIDGE_RECEIVE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    replayHistory: false,
    args: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--session-link':
        options.sessionLink = argv[++i];
        break;
      case '--agent-name':
        options.agentName = argv[++i] ?? options.agentName;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(argv[++i] ?? options.timeoutMs);
        break;
      case '--replay-history':
        options.replayHistory = true;
        break;
      case '--command':
        options.command = argv[++i];
        break;
      case '--arg':
        options.args.push(argv[++i] ?? '');
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sessionLink) throw new Error('Missing --session-link or AGENTBRIDGE_SESSION_LINK.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error('--timeout-ms must be a non-negative number.');
  }
  return options;
}

function defaultServerCommand(options: CliOptions): { command: string; args: string[] } {
  if (options.command) return { command: options.command, args: options.args };
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./index.js', import.meta.url))],
  };
}

class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => this.handleLine(line));
    proc.on('exit', (code, signal) => {
      const err = new Error(`MCP server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentbridge-listener', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  async tool(name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return parseToolResult(result);
  }

  private notify(method: string, params?: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }
}

function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result)) return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = defaultServerCommand(options);
  const child = spawn(server.command, server.args, {
    env: {
      ...process.env,
      AGENTBRIDGE_SESSION_LINK: options.sessionLink,
      AGENTBRIDGE_AGENT_NAME: options.agentName,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  const client = new McpClient(child);

  const shutdown = () => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.initialize();
  const status = await client.tool('join_meeting', {
    replay_history: options.replayHistory,
    start_polling: false,
  });
  console.log(`AGENTBRIDGE_LISTENER_READY ${JSON.stringify(status)}`);

  while (true) {
    const received = await client.tool('receive_messages', { timeout_ms: options.timeoutMs }, options.timeoutMs + 15_000);
    const messages = received && typeof received === 'object' && 'messages' in received
      ? (received as { messages?: Array<{ id?: string }> }).messages ?? []
      : [];
    const ids: string[] = [];
    for (const message of messages) {
      if (message.id) ids.push(message.id);
      console.log(`AGENTBRIDGE_INBOUND ${JSON.stringify(message)}`);
    }
    if (ids.length > 0) {
      await client.tool('ack_messages', { message_ids: ids });
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`AGENTBRIDGE_LISTENER_ERROR ${message}`);
  process.exit(1);
});
