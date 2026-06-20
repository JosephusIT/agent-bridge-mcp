import { describe, expect, it } from 'vitest';

import { formatInbound, INBOUND_SENTINEL, parseArgs } from '../src/listen.js';
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
  it('defaults all flags to false', () => {
    expect(parseArgs([])).toEqual({ json: false, once: false, replay: false });
  });

  it('parses flags in any order', () => {
    expect(parseArgs(['--once', '--json', '--replay'])).toEqual({ json: true, once: true, replay: true });
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
