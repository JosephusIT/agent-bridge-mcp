#!/usr/bin/env node
/**
 * agentbridge-listen — portable continuous-listening loop for any host.
 *
 * Connects to the AgentBridge session, joins meeting mode, and long-polls for
 * inbound messages. Each new message is printed to stdout on a single line with
 * a stable, greppable sentinel prefix so a host (Cursor output notifications,
 * a CI watcher, a CLI wrapper, etc.) can wake an agent into a fresh turn.
 *
 * It is transport-only: it never executes arbitrary commands. The host/agent
 * decides how to react to each sentinel line (and is responsible for asking the
 * user before running anything).
 */

import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadSessionFromEnv, loadTimingConfig } from './config.js';
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
}

export function parseArgs(argv: string[]): ListenFlags {
  return {
    json: argv.includes('--json'),
    once: argv.includes('--once'),
    replay: argv.includes('--replay'),
  };
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

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  let session;
  try {
    session = loadSessionFromEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_SENTINEL} ${message}`);
    process.exit(1);
  }

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

  await inbox.join({ replayHistory: flags.replay, startPolling: true });
  console.log(`${READY_SENTINEL} agent=${session.agentName} session=${session.slug}`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    inbox.leave();
    transport.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  do {
    let result;
    try {
      result = await inbox.receive({ timeoutMs: timing.defaultReceiveTimeoutMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${ERROR_SENTINEL} ${message}`);
      await new Promise((resolve) => setTimeout(resolve, timing.messagePollIntervalMs));
      continue;
    }

    const messages = result.messages ?? [];
    if (messages.length > 0) {
      for (const message of messages) {
        console.log(formatInbound(message, flags.json));
      }
      inbox.ack({ messageIds: messages.map((m) => m.id) });
    }
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
  void main();
}
