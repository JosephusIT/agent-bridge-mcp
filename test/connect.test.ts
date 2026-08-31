import { describe, expect, it, vi } from 'vitest';

import { makeConnectAndAwaitApproval } from '../src/connect.js';
import type { AgentBridgeSession, ConnectResult, Transport } from '../src/transport.js';

function session(): AgentBridgeSession {
  return {
    baseUrl: 'https://example.test',
    apiBaseUrl: 'https://example.test/api/v1',
    slug: 'demo',
    sessionId: 'demo',  // deprecated alias
    agentName: 'bot',
  };
}

function transport(handlers: Partial<Transport>): Transport {
  return {
    connect: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
    listAgents: vi.fn(),
    getSessionInfo: vi.fn(),
    getKnock: vi.fn(),
    onKnock: vi.fn(),
    close: vi.fn(),
    ...handlers,
  } as Transport;
}

describe('makeConnectAndAwaitApproval', () => {
  it('returns immediately when connect is already active', async () => {
    const active: ConnectResult = { status: 'active', access_token: 'tok' };
    const t = transport({ connect: vi.fn().mockResolvedValue(active) });
    const connect = makeConnectAndAwaitApproval(session(), t, {
      connectTimeoutMs: 1000,
      approvalPollIntervalMs: 10,
      sleep: async () => undefined,
    });
    await expect(connect([])).resolves.toEqual(active);
    expect(t.getKnock).not.toHaveBeenCalled();
  });

  it('polls until the knock is approved then reconnects', async () => {
    const pending: ConnectResult = { status: 'pending', knock_id: 'k1' };
    const approved: ConnectResult = { status: 'active', access_token: 'tok' };
    const t = transport({
      connect: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(approved),
      getKnock: vi.fn().mockResolvedValue({ status: 'approved' }),
    });
    const connect = makeConnectAndAwaitApproval(session(), t, {
      connectTimeoutMs: 1000,
      approvalPollIntervalMs: 1,
      sleep: async () => undefined,
    });
    await expect(connect(['chat'])).resolves.toEqual(approved);
    expect(t.getKnock).toHaveBeenCalledWith(expect.anything(), 'k1');
  });

  it('throws JOIN_DENIED when the knock is denied', async () => {
    const t = transport({
      connect: vi.fn().mockResolvedValue({ status: 'pending', knock_id: 'k1' }),
      getKnock: vi.fn().mockResolvedValue({ status: 'denied' }),
    });
    const connect = makeConnectAndAwaitApproval(session(), t, {
      connectTimeoutMs: 1000,
      approvalPollIntervalMs: 1,
      sleep: async () => undefined,
    });
    await expect(connect([])).rejects.toThrow(/JOIN_DENIED/);
  });

  it('throws on unexpected non-pending statuses instead of succeeding', async () => {
    const t = transport({
      connect: vi.fn().mockResolvedValue({ status: 'paused' } as ConnectResult),
    });
    const connect = makeConnectAndAwaitApproval(session(), t, {
      connectTimeoutMs: 1000,
      approvalPollIntervalMs: 1,
      sleep: async () => undefined,
    });
    await expect(connect([])).rejects.toThrow(/JOIN_UNEXPECTED_STATUS/);
  });

  it('throws when pending without knock_id', async () => {
    const t = transport({
      connect: vi.fn().mockResolvedValue({ status: 'pending' }),
    });
    const connect = makeConnectAndAwaitApproval(session(), t, {
      connectTimeoutMs: 1000,
      approvalPollIntervalMs: 1,
      sleep: async () => undefined,
    });
    await expect(connect([])).rejects.toThrow(/JOIN_UNEXPECTED_STATUS/);
  });
});
