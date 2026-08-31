import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitAndAck, formatInbound, INBOUND_SENTINEL, parseArgs } from '../src/listen.js';
import type { Message } from '../src/transport.js';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    type: 'text',
    content: 'hello world',
    created_at: '2026-01-01T00:00:00.000Z',
    from_agent_id: 'agent-2',
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults all flags to false with no wrapper command', () => {
    expect(parseArgs([])).toEqual({ json: false, once: false, replay: false, args: [] });
  });

  it('parses boolean flags in any order', () => {
    expect(parseArgs(['--once', '--json', '--replay'])).toMatchObject({ json: true, once: true, replay: true });
  });

  it('parses wrapper mode --command and repeated --arg', () => {
    const flags = parseArgs(['--command', 'node', '--arg', 'server.js', '--arg', '--flag', '--json']);
    expect(flags.command).toBe('node');
    expect(flags.args).toEqual(['server.js', '--flag']);
    expect(flags.json).toBe(true);
  });

  it('leaves command undefined in in-process mode', () => {
    expect(parseArgs(['--replay']).command).toBeUndefined();
  });
});

describe('formatInbound', () => {
  it('emits a single greppable sentinel line in text mode', () => {
    const line = formatInbound(message({ content: 'multi\n  line  text' }), false);
    expect(line.startsWith(`${INBOUND_SENTINEL} `)).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).toContain('id=m1');
    expect(line).toContain('type=text');
    expect(line).toContain('from=agent:agent-2');
    expect(line).toContain(':: multi line text');
  });

  it('labels human senders', () => {
    const line = formatInbound(message({ from_agent_id: null, from_user_id: 'user-9' }), false);
    expect(line).toContain('from=human:user-9');
  });

  it('emits valid JSON after the sentinel in json mode', () => {
    const line = formatInbound(message({ content: 'hi' }), true);
    expect(line.startsWith(`${INBOUND_SENTINEL} `)).toBe(true);
    const payload = JSON.parse(line.slice(INBOUND_SENTINEL.length + 1));
    expect(payload).toMatchObject({ id: 'm1', type: 'text', from: 'agent:agent-2', content: 'hi' });
  });
});

describe('emitAndAck', () => {
  beforeEach(() => {
    process.env.AGENTBRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'ab-listen-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks only messages that were successfully printed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ack = vi.fn(async () => undefined);
    const messages = [message({ id: 'a' }), message({ id: 'b' })];

    await emitAndAck({ ack }, messages, false);

    expect(log).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledWith(['a', 'b']);
  });

  it('does not ack remaining messages when emit throws mid-batch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (String(line).includes('id=b')) throw new Error('stdout broken');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ack = vi.fn(async () => undefined);

    await emitAndAck({ ack }, [message({ id: 'a' }), message({ id: 'b' }), message({ id: 'c' })], false);

    expect(log).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(['a']);
  });
});
