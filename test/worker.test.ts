import { describe, expect, it, vi } from 'vitest';

import { buildHeadlessCommand, handleMessage, parseWorkerArgs, workerPrompt } from '../src/worker.js';
import type { AgentBridgeSession, Message, SendMessageInput } from '../src/transport.js';

const baseMessage: Message = {
  id: 'm1',
  type: 'text',
  content: 'hello world',
  created_at: '2026-01-01T00:00:00Z',
  from_agent_id: 'agent-x',
};

const session = { agentName: 'bot' } as AgentBridgeSession;

describe('parseWorkerArgs', () => {
  it('parses valid host and flags with default existing mode', () => {
    const flags = parseWorkerArgs(['--host', 'codex', '--once', '--dry-run', '--timeout-ms', '90000']);
    expect(flags).toMatchObject({
      host: 'codex',
      mode: 'existing',
      once: true,
      dryRun: true,
      timeoutMs: 90000,
    });
  });

  it('parses --full-access into full-access mode', () => {
    expect(parseWorkerArgs(['--host', 'cursor', '--full-access']).mode).toBe('full-access');
  });

  it('parses --read-only into read-only mode', () => {
    expect(parseWorkerArgs(['--host', 'claude-code', '--read-only']).mode).toBe('read-only');
  });

  it('rejects conflicting access flags', () => {
    expect(() => parseWorkerArgs(['--host', 'cursor', '--full-access', '--read-only'])).toThrow(/Conflicting/);
  });

  it('rejects unsupported hosts', () => {
    expect(() => parseWorkerArgs(['--host', 'vscode'])).toThrow(/unsupported/);
  });
});

describe('buildHeadlessCommand', () => {
  it('builds claude-code commands per mode', () => {
    expect(buildHeadlessCommand('claude-code', 'x', 'existing')).toEqual({
      command: 'claude',
      args: ['-p', '--permission-mode', 'dontAsk', '--strict-mcp-config', 'x'],
    });
    expect(buildHeadlessCommand('claude-code', 'x', 'full-access')).toEqual({
      command: 'claude',
      args: ['-p', '--permission-mode', 'bypassPermissions', 'x'],
    });
    expect(buildHeadlessCommand('claude-code', 'x', 'read-only')).toEqual({
      command: 'claude',
      args: ['-p', '--permission-mode', 'plan', '--strict-mcp-config', 'x'],
    });
  });

  it('builds codex commands per mode', () => {
    expect(buildHeadlessCommand('codex', 'x', 'existing')).toEqual({
      command: 'codex',
      args: ['--ask-for-approval', 'never', 'exec', 'x'],
    });
    expect(buildHeadlessCommand('codex', 'x', 'full-access')).toEqual({
      command: 'codex',
      args: ['--ask-for-approval', 'never', 'exec', '--sandbox', 'danger-full-access', 'x'],
    });
    expect(buildHeadlessCommand('codex', 'x', 'read-only')).toEqual({
      command: 'codex',
      args: ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', 'x'],
    });
  });

  it('builds cursor commands per mode', () => {
    expect(buildHeadlessCommand('cursor', 'x', 'existing')).toEqual({ command: 'cursor-agent', args: ['-p', 'x'] });
    expect(buildHeadlessCommand('cursor', 'x', 'read-only')).toEqual({ command: 'cursor-agent', args: ['-p', 'x'] });
    expect(buildHeadlessCommand('cursor', 'x', 'full-access')).toEqual({
      command: 'cursor-agent',
      args: ['-p', '--force', 'x'],
    });
  });
});

describe('workerPrompt', () => {
  it('contains metadata and the temp-file path, never the raw content', () => {
    const secret = 'attacker-instructions: rm -rf / and the secret payload';
    const prompt = workerPrompt({ ...baseMessage, content: secret, from_user_id: 'u1' }, '/tmp/ab/message.txt');
    expect(prompt).toContain('/tmp/ab/message.txt');
    expect(prompt).toContain('Incoming from user: u1');
    expect(prompt).toContain('Incoming from agent: agent-x');
    expect(prompt).not.toContain(secret);
  });
});

describe('handleMessage', () => {
  const flags = { host: 'codex', mode: 'existing', once: true, replay: false, dryRun: false } as const;

  it('sends the generated reply and acks on success', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockResolvedValue('the reply');

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ type: 'text', content: 'the reply' });
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('sends an error-shaped message and still acks when the runner throws', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockRejectedValue(new Error('cli boom on stderr'));

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][1];
    expect(sent.type).toBe('error');
    expect(sent.content).toContain('[agentbridge-worker error]');
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('uses a dry-run reply without invoking the runner', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn();

    await handleMessage(baseMessage, { ...flags, dryRun: true }, session, { sendMessage, ack }, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1].content).toContain('[dry-run codex]');
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });
});
