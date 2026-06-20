import { describe, expect, it } from 'vitest';

import { hostProfile, LISTENING_SKILL, ONBOARDING_PROMPT, setupGuideForHost, SETUP_GUIDE } from '../src/guide.js';

describe('guide content', () => {
  it('embeds the paste-ready onboarding prompt in the setup guide', () => {
    expect(SETUP_GUIDE).toContain(ONBOARDING_PROMPT);
  });

  it('leads with the universal tool-loop and ack-after-handling', () => {
    expect(ONBOARDING_PROMPT).toContain('receive_messages');
    expect(ONBOARDING_PROMPT).toContain('ack AFTER handling');
    expect(LISTENING_SKILL).toContain('ack after handling');
  });
});

describe('hostProfile', () => {
  it('marks Cursor as stdout-wake capable', () => {
    expect(hostProfile('cursor').supportsStdoutWake).toBe(true);
  });

  it('marks Hermes and Codex as buffering hosts', () => {
    expect(hostProfile('hermes').supportsStdoutWake).toBe(false);
    expect(hostProfile('codex').supportsStdoutWake).toBe(false);
  });

  it('treats unknown hosts as generic', () => {
    expect(hostProfile('weird-host')).toEqual(hostProfile('generic'));
  });
});

describe('setupGuideForHost', () => {
  it('appends a host recommendation', () => {
    const guide = setupGuideForHost('hermes');
    expect(guide).toContain('Selected host: hermes');
    expect(guide).toContain('Recommended mode: tool-loop');
  });

  it('normalizes unknown hosts to generic', () => {
    expect(setupGuideForHost('nope')).toContain('Selected host: generic');
  });
});
