import { describe, expect, it, vi } from 'vitest';

import { createMeetingInboxOptions, MeetingInbox } from '../src/meeting-inbox.js';
import type {
  Agent,
  AgentBridgeSession,
  ConnectInput,
  ConnectResult,
  Message,
  SendMessageInput,
  SessionInfo,
  Transport,
} from '../src/transport.js';

const session: AgentBridgeSession = {
  baseUrl: 'https://agentbridge.example.com',
  apiBaseUrl: 'https://agentbridge.example.com/api/v1',
  slug: 'team-room',
  sessionId: 'team-room',
  agentName: 'local-agent',
  token: 'agt_test',
};

const localAgent: Agent = {
  id: 'agent-local',
  name: 'local-agent',
  status: 'active',
};

function message(id: string, createdAt: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    type: 'text',
    content: `message ${id}`,
    created_at: createdAt,
    from_agent_id: 'agent-remote',
    to_agent_id: null,
    metadata: {},
    ...overrides,
  };
}

class FakeTransport implements Transport {
  messages: Message[] = [];
  getMessagesError: Error | null = null;

  async connect(_session: AgentBridgeSession, _input?: ConnectInput): Promise<ConnectResult> {
    return { status: 'active', agent: localAgent };
  }

  async sendMessage(_session: AgentBridgeSession, input: SendMessageInput): Promise<Message> {
    const sent = message(`sent-${this.messages.length}`, new Date().toISOString(), {
      content: input.content,
      type: input.type,
      to_agent_id: input.to_agent_id,
      metadata: input.metadata,
      from_agent_id: localAgent.id,
    });
    this.messages.push(sent);
    return sent;
  }

  async getMessages(): Promise<Message[]> {
    if (this.getMessagesError) throw this.getMessagesError;
    return [...this.messages];
  }

  async listAgents(): Promise<Agent[]> {
    return [localAgent];
  }

  async getSessionInfo(): Promise<SessionInfo> {
    return { slug: session.slug, join_mode: 'token' };
  }

  async getKnock(): Promise<Record<string, unknown>> {
    return { status: 'approved' };
  }

  onKnock(): void {}

  close(): void {}
}

function createInbox(transport: FakeTransport, overrides: Parameters<typeof createMeetingInboxOptions>[0] = {}) {
  let now = Date.parse('2026-06-20T12:00:00.000Z');
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });

  const inbox = new MeetingInbox(
    session,
    transport,
    async () => transport.connect(session),
    createMeetingInboxOptions({
      pollIntervalMs: 10,
      inboxMaxMessages: 50,
      defaultReceiveTimeoutMs: 50,
      now: () => now,
      sleep,
      ...overrides,
    })
  );

  return { inbox, sleep, advance: (ms: number) => (now += ms) };
}

describe('MeetingInbox', () => {
  it('seeds without replaying old messages by default', async () => {
    const transport = new FakeTransport();
    transport.messages = [message('old-1', '2026-06-20T12:00:00.000Z')];
    const { inbox } = createInbox(transport);

    await inbox.join({ startPolling: false });

    expect(inbox.getInbox().messages).toEqual([]);
    transport.messages.push(message('new-1', '2026-06-20T12:00:01.000Z'));

    const result = await inbox.pollOnce();

    expect(result.messages.map((item) => item.id)).toEqual(['new-1']);
  });

  it('blocking receive returns when a new message arrives', async () => {
    const transport = new FakeTransport();
    transport.messages = [message('old-1', '2026-06-20T12:00:00.000Z')];
    const { inbox, sleep } = createInbox(transport, {
      sleep: async (ms: number) => {
        transport.messages.push(message('new-1', '2026-06-20T12:00:01.000Z'));
        await Promise.resolve(ms);
      },
    });

    await inbox.join({ startPolling: false });
    const result = await inbox.receive({ timeoutMs: 50 });

    expect(sleep).toBeDefined();
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((item) => item.id)).toEqual(['new-1']);
  });

  it('receive timeout returns an empty result', async () => {
    const transport = new FakeTransport();
    const { inbox } = createInbox(transport);

    await inbox.join({ startPolling: false });
    const result = await inbox.receive({ timeoutMs: 0 });

    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it('filters own messages and messages directed to other agents', async () => {
    const transport = new FakeTransport();
    const { inbox } = createInbox(transport);
    await inbox.join({ startPolling: false });

    transport.messages = [
      message('own', '2026-06-20T12:00:01.000Z', { from_agent_id: localAgent.id }),
      message('other-directed', '2026-06-20T12:00:02.000Z', { to_agent_id: 'agent-someone-else' }),
      message('broadcast', '2026-06-20T12:00:03.000Z'),
      message('direct-local', '2026-06-20T12:00:04.000Z', { to_agent_id: localAgent.id }),
    ];

    const result = await inbox.pollOnce();

    expect(result.messages.map((item) => item.id)).toEqual(['broadcast', 'direct-local']);
  });

  it('ack removes handled messages from the inbox', async () => {
    const transport = new FakeTransport();
    const { inbox } = createInbox(transport);
    await inbox.join({ startPolling: false });
    transport.messages = [
      message('new-1', '2026-06-20T12:00:01.000Z'),
      message('new-2', '2026-06-20T12:00:02.000Z'),
    ];

    await inbox.pollOnce();
    const result = inbox.ack({ messageIds: ['new-1'] });

    expect(result.messages.map((item) => item.id)).toEqual(['new-2']);
  });

  it('tracks polling errors without crashing', async () => {
    const transport = new FakeTransport();
    const { inbox } = createInbox(transport);
    await inbox.join({ startPolling: false });

    transport.getMessagesError = new Error('network unavailable');
    const result = await inbox.pollOnce();

    expect(result.messages).toEqual([]);
    expect(inbox.status().lastError).toContain('network unavailable');
  });

  it('rejects concurrent blocking receives predictably', async () => {
    const transport = new FakeTransport();
    let now = Date.parse('2026-06-20T12:00:00.000Z');
    let releaseSleep: (() => void) | undefined;
    const inbox = new MeetingInbox(
      session,
      transport,
      async () => transport.connect(session),
      createMeetingInboxOptions({
        pollIntervalMs: 10,
        inboxMaxMessages: 50,
        defaultReceiveTimeoutMs: 50,
        now: () => now,
        sleep: (ms: number) =>
          new Promise<void>((resolve) => {
            releaseSleep = () => {
              now += ms;
              resolve();
            };
          }),
      })
    );
    await inbox.join({ startPolling: false });

    const firstReceive = inbox.receive({ timeoutMs: 10 });
    await vi.waitFor(() => expect(inbox.status().receiveInProgress).toBe(true));

    await expect(inbox.receive({ timeoutMs: 10 })).rejects.toThrow(/RECEIVE_IN_PROGRESS/);

    releaseSleep?.();
    await firstReceive;
  });
});
