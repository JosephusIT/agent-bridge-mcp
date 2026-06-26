import { describe, expect, it } from 'vitest';

import { buildHeadlessCommand, parseWorkerArgs, workerPrompt } from '../src/worker.js';
import type { Message } from '../src/transport.js';

const baseMessage: Message = {
  id: 'm1',
  type: 'text',
  content: 'hello world',
  created_at: '2026-01-01T00:00:00Z',
  from_agent_id: 'agent-x',
};

describe('parseWorkerArgs', () => {
  it('parses valid host and flags', () => {
    const flags = parseWorkerArgs(['--host', 'codex', '--once', '--dry-run', '--timeout-ms', '90000']);
    expect(flags).toMatchObject({
      host: 'codex',
      once: true,
      dryRun: true,
      timeoutMs: 90000,
    });
  });

  it('rejects unsupported hosts', () => {
    expect(() => parseWorkerArgs(['--host', 'vscode'])).toThrow(/unsupported/);
  });
});

describe('buildHeadlessCommand', () => {
  it('builds claude-code command', () => {
    expect(buildHeadlessCommand('claude-code', 'x')).toEqual({ command: 'claude', args: ['-p', 'x'] });
  });

  it('builds codex command', () => {
    expect(buildHeadlessCommand('codex', 'x')).toEqual({ command: 'codex', args: ['exec', 'x'] });
  });

  it('builds cursor command', () => {
    expect(buildHeadlessCommand('cursor', 'x')).toEqual({ command: 'cursor-agent', args: ['-p', 'x'] });
  });
});

describe('workerPrompt', () => {
  it('contains compacted message content and metadata', () => {
    const prompt = workerPrompt({ ...baseMessage, content: 'hi\n there', from_user_id: 'u1' });
    expect(prompt).toContain('Incoming content: hi there');
    expect(prompt).toContain('Incoming from user: u1');
    expect(prompt).toContain('Incoming from agent: agent-x');
  });
});
