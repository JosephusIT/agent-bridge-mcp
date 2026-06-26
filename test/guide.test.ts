import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  hostProfile,
  LISTENING_SKILL,
  ONBOARDING_PROMPT,
  setupGuideForHost,
  SETUP_GUIDE,
  supportedHosts,
} from '../src/guide.js';

describe('guide content', () => {
  it('embeds the paste-ready onboarding prompt in the setup guide', () => {
    expect(SETUP_GUIDE).toContain(ONBOARDING_PROMPT);
  });

  it('leads with the universal tool-loop and ack-after-handling', () => {
    expect(ONBOARDING_PROMPT).toContain('receive_messages');
    expect(ONBOARDING_PROMPT).toContain('ack AFTER handling');
    expect(LISTENING_SKILL).toContain('ack after handling');
  });

  it('keeps AGENTS.md onboarding prompt in sync', () => {
    const agents = readFileSync(resolve(process.cwd(), 'AGENTS.md'), 'utf8');
    const promptBlock = ['```text', ONBOARDING_PROMPT, '```'].join('\n');
    expect(agents).toContain(promptBlock);
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

  it('aliases vscode to the vscode-copilot profile', () => {
    expect(hostProfile('vscode')).toEqual(hostProfile('vscode-copilot'));
    expect(hostProfile('vscode').label).toBe('GitHub Copilot / VS Code');
  });
});

describe('supportedHosts', () => {
  it('advertises hermes as a canonical host', () => {
    expect(supportedHosts()).toContain('hermes');
  });

  it('does not advertise a standalone vscode host', () => {
    expect(supportedHosts()).not.toContain('vscode');
    expect(supportedHosts()).toContain('vscode-copilot');
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
