#!/usr/bin/env node
/**
 * agentbridge-worker — autonomous background worker mode.
 *
 * This is an explicit opt-in mode for users who want unattended replies.
 * It long-polls AgentBridge messages, invokes a host headless CLI, sends the
 * generated reply, then acks each handled message.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadSessionFromEnv, loadTimingConfig } from './config.js';
import { makeConnectAndAwaitApproval } from './connect.js';
import { createMeetingInboxOptions, MeetingInbox } from './meeting-inbox.js';
import type { Message } from './transport.js';
import { HttpTransport } from './transport.js';

const execFileAsync = promisify(execFile);

export type WorkerHost = 'cursor' | 'claude-code' | 'codex';

export interface WorkerFlags {
  host: WorkerHost;
  once: boolean;
  replay: boolean;
  timeoutMs?: number;
  dryRun: boolean;
}

export function parseWorkerArgs(args: string[]): WorkerFlags {
  const host = getFlagValue(args, '--host');
  if (!host || !isWorkerHost(host)) {
    throw new Error('Missing or unsupported --host. Allowed: cursor|claude-code|codex');
  }
  const timeoutRaw = getFlagValue(args, '--timeout-ms');
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  return {
    host,
    once: args.includes('--once'),
    replay: args.includes('--replay'),
    timeoutMs: Number.isFinite(timeoutMs) && (timeoutMs ?? 0) > 0 ? timeoutMs : undefined,
    dryRun: args.includes('--dry-run'),
  };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

function isWorkerHost(host: string): host is WorkerHost {
  return host === 'cursor' || host === 'claude-code' || host === 'codex';
}

export interface HeadlessCommand {
  command: string;
  args: string[];
}

function compactMessageContent(content: string): string {
  return String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function workerPrompt(message: Message): string {
  return [
    'You are replying inside an AgentBridge session.',
    'Return only the reply text; keep it concise and actionable.',
    `Incoming message type: ${message.type}`,
    `Incoming from agent: ${message.from_agent_id ?? 'unknown'}`,
    `Incoming from user: ${message.from_user_id ?? 'unknown'}`,
    `Incoming content: ${compactMessageContent(message.content)}`,
  ].join('\n');
}

export function buildHeadlessCommand(host: WorkerHost, prompt: string): HeadlessCommand {
  switch (host) {
    case 'claude-code':
      return { command: 'claude', args: ['-p', prompt] };
    case 'codex':
      return { command: 'codex', args: ['exec', prompt] };
    case 'cursor':
      return { command: 'cursor-agent', args: ['-p', prompt] };
  }
}

async function runHeadlessCommand(host: WorkerHost, prompt: string): Promise<string> {
  const cmd = buildHeadlessCommand(host, prompt);
  console.error(`[agentbridge-worker] running: ${cmd.command} ${cmd.args.map((a) => JSON.stringify(a)).join(' ')}`);
  const { stdout, stderr } = await execFileAsync(cmd.command, cmd.args, {
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const out = stdout?.trim();
  if (out) return out;
  const err = stderr?.trim();
  if (err) return err;
  return '(no output)';
}

async function main(): Promise<void> {
  const flags = parseWorkerArgs(argv.slice(2));
  const timing = loadTimingConfig();
  const session = loadSessionFromEnv();
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

  await inbox.join({ replayHistory: flags.replay, startPolling: false });
  console.error(`[agentbridge-worker] ready host=${flags.host} agent=${session.agentName}`);

  let stop = false;
  const shutdown = () => {
    if (stop) return;
    stop = true;
    inbox.leave();
    transport.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  do {
    const receive = await inbox.receive({ timeoutMs: flags.timeoutMs ?? timing.defaultReceiveTimeoutMs });
    if (receive.messages.length === 0) continue;

    for (const message of receive.messages) {
      const reply = flags.dryRun
        ? `[dry-run ${flags.host}] ${compactMessageContent(message.content)}`
        : await runHeadlessCommand(flags.host, workerPrompt(message));
      await transport.sendMessage(session, {
        type: 'text',
        content: reply,
        to_agent_id: message.from_agent_id ?? null,
      });
      inbox.ack({ messageIds: [message.id] });
    }
  } while (!flags.once && !stop);

  shutdown();
}

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
