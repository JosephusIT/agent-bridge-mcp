import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getNumberEnv, loadSessionFromEnv, loadTimingConfig } from '../src/config.js';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.AGENTBRIDGE_SESSION_LINK;
  delete process.env.AGENTBRIDGE_AGENT_NAME;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('getNumberEnv', () => {
  it('returns the fallback when unset or invalid', () => {
    delete process.env.SOME_NUM;
    expect(getNumberEnv('SOME_NUM', 42)).toBe(42);
    process.env.SOME_NUM = 'nope';
    expect(getNumberEnv('SOME_NUM', 42)).toBe(42);
    process.env.SOME_NUM = '-5';
    expect(getNumberEnv('SOME_NUM', 42)).toBe(42);
  });

  it('parses positive numbers', () => {
    process.env.SOME_NUM = '1234';
    expect(getNumberEnv('SOME_NUM', 42)).toBe(1234);
  });
});

describe('loadSessionFromEnv', () => {
  it('throws a clear error when the link is missing', () => {
    expect(() => loadSessionFromEnv()).toThrow(/AGENTBRIDGE_SESSION_LINK is not set/);
  });

  it('throws on an invalid link', () => {
    process.env.AGENTBRIDGE_SESSION_LINK = 'http://insecure/s/foo';
    expect(() => loadSessionFromEnv()).toThrow(/Invalid session link/);
  });

  it('builds a session from a valid link', () => {
    process.env.AGENTBRIDGE_SESSION_LINK = 'https://relay.example.com/s/team-room?token=agt_abc';
    process.env.AGENTBRIDGE_AGENT_NAME = 'tester';
    const session = loadSessionFromEnv();
    expect(session.slug).toBe('team-room');
    expect(session.apiBaseUrl).toBe('https://relay.example.com/api/v1');
    expect(session.agentName).toBe('tester');
    expect(session.token).toBe('agt_abc');
  });
});

describe('loadTimingConfig', () => {
  it('provides sane defaults', () => {
    const timing = loadTimingConfig();
    expect(timing.connectTimeoutMs).toBeGreaterThan(0);
    expect(timing.messagePollIntervalMs).toBeGreaterThan(0);
    expect(timing.defaultReceiveTimeoutMs).toBeGreaterThan(0);
  });
});
