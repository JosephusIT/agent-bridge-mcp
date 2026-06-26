import { describe, expect, it, vi } from 'vitest';

import { buildHeadlessCommand, decideDispatch, handleMessage, parseWorkerArgs, startupWarnings, workerPrompt } from '../src/worker.js';
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
      args: ['--ask-for-approval', 'never', '--sandbox', 'danger-full-access', 'exec', 'x'],
    });
    expect(buildHeadlessCommand('codex', 'x', 'read-only')).toEqual({
      command: 'codex',
      args: ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'exec', 'x'],
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
    const prompt = workerPrompt(
      { ...baseMessage, content: secret, from_user_id: 'u1' },
      '/tmp/ab/message.txt',
      { selfName: 'bot', conditional: true }
    );
    expect(prompt).toContain('/tmp/ab/message.txt');
    expect(prompt).toContain('Incoming from user: u1');
    expect(prompt).toContain('Incoming from agent: agent-x');
    expect(prompt).toContain('NO_REPLY');
    expect(prompt).not.toContain(secret);
  });
});

describe('handleMessage', () => {
  const flags = { host: 'codex', mode: 'existing', once: true, replay: false, dryRun: false } as const;

  it('sends the generated reply and acks on success', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockResolvedValue('the reply');

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner, {
      conditional: false,
      selfName: 'bot',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ type: 'text', content: 'the reply' });
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('sends an error-shaped message and still acks when the runner throws', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockRejectedValue(new Error('cli boom on stderr'));

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner, {
      conditional: false,
      selfName: 'bot',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][1];
    expect(sent.type).toBe('error');
    expect(sent.content).toContain('could not generate a reply');
    expect(sent.content).not.toContain('cli boom on stderr');
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('uses a dry-run reply without invoking the runner', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn();

    await handleMessage(baseMessage, { ...flags, dryRun: true }, session, { sendMessage, ack }, runner, {
      conditional: false,
      selfName: 'bot',
    });

    expect(runner).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1].content).toContain('[dry-run codex]');
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('suppresses broadcast replies when runner returns NO_REPLY', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockResolvedValue('NO_REPLY');

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner, {
      conditional: true,
      selfName: 'bot',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });

  it('suppresses empty replies on the unconditional (directed) path and still acks', async () => {
    const sendMessage = vi.fn<[AgentBridgeSession, SendMessageInput], Promise<Message>>().mockResolvedValue(baseMessage);
    const ack = vi.fn();
    const runner = vi.fn().mockResolvedValue('   ');

    await handleMessage(baseMessage, flags, session, { sendMessage, ack }, runner, {
      conditional: false,
      selfName: 'bot',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ messageIds: ['m1'] });
  });
});

describe('startupWarnings', () => {
  const base = { once: true, replay: false, dryRun: false } as const;

  it('warns that --read-only is a no-op on cursor', () => {
    const warnings = startupWarnings({ ...base, host: 'cursor', mode: 'read-only' });
    expect(warnings.some((w) => w.includes('cursor has no strict read-only sandbox'))).toBe(true);
  });

  it('emits the autonomous-execution security warning for non-read-only live runs', () => {
    const warnings = startupWarnings({ ...base, host: 'codex', mode: 'existing' });
    expect(warnings.some((w) => w.includes('SECURITY WARNING'))).toBe(true);
  });

  it('stays quiet for read-only on a sandboxed host and for dry-run', () => {
    expect(startupWarnings({ ...base, host: 'claude-code', mode: 'read-only' })).toEqual([]);
    expect(startupWarnings({ ...base, host: 'codex', mode: 'existing', dryRun: true })).toEqual([]);
  });
});

describe('decideDispatch', () => {
  it('skips error/result traffic and self-echoes', () => {
    expect(decideDispatch({ ...baseMessage, type: 'error' }, 'me')).toEqual({ shouldHandle: false, conditional: false });
    expect(decideDispatch({ ...baseMessage, type: 'result' }, 'me')).toEqual({ shouldHandle: false, conditional: false });
    expect(decideDispatch({ ...baseMessage, from_agent_id: 'me' }, 'me')).toEqual({ shouldHandle: false, conditional: false });
  });

  it('handles directed messages unconditionally', () => {
    expect(decideDispatch({ ...baseMessage, to_agent_id: 'me' }, 'me')).toEqual({ shouldHandle: true, conditional: false });
  });

  it('handles broadcasts conditionally', () => {
    expect(decideDispatch({ ...baseMessage, to_agent_id: null }, 'me')).toEqual({ shouldHandle: true, conditional: true });
  });
});
