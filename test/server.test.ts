import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildSetupStatus, createAgentBridgeServer, type ServerState } from '../src/server.js';
import type {
  Agent,
  AgentBridgeSession,
  ConnectInput,
  ConnectResult,
  GetMessagesInput,
  KnockEvent,
  Message,
  SendMessageInput,
  SessionInfo,
  Transport,
} from '../src/transport.js';
import { PACKAGE_VERSION } from '../src/version.js';

const UNCONFIGURED: ServerState = {
  session: null,
  configError: 'AGENTBRIDGE_SESSION_LINK is not set.',
};

function makeSession(): AgentBridgeSession {
  return {
    baseUrl: 'https://relay.example',
    apiBaseUrl: 'https://relay.example/api',
    slug: 'demo',
    sessionId: 'demo',
    agentName: 'tester',
    token: 'agt_token',
  };
}

class FakeTransport implements Transport {
  sent: SendMessageInput[] = [];

  async connect(_session: AgentBridgeSession, _input?: ConnectInput): Promise<ConnectResult> {
    return { status: 'active', agent: { id: 'a1', name: 'tester', status: 'active' } };
  }

  async sendMessage(_session: AgentBridgeSession, input: SendMessageInput): Promise<Message> {
    this.sent.push(input);
    return {
      id: 'm1',
      type: input.type,
      content: input.content,
      created_at: '2026-08-30T00:00:00.000Z',
    };
  }

  async getMessages(_session: AgentBridgeSession, _input?: GetMessagesInput): Promise<Message[]> {
    return [];
  }

  async listAgents(_session: AgentBridgeSession): Promise<Agent[]> {
    return [{ id: 'a1', name: 'tester', status: 'active' }];
  }

  async getSessionInfo(_session: AgentBridgeSession): Promise<SessionInfo> {
    return { slug: 'demo', join_mode: 'token' };
  }

  async getKnock(): Promise<Record<string, unknown>> {
    return { status: 'approved' };
  }

  onKnock(_fn: (event: KnockEvent) => void): void {
    // request/response fake; no knock events
  }

  close(): void {
    // nothing to release
  }
}

interface TextToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function startClient(state: ServerState, transport?: Transport): Promise<Client> {
  const server = createAgentBridgeServer(state, {
    transport: transport ?? new FakeTransport(),
    timing: {
      connectTimeoutMs: 1_000,
      approvalPollIntervalMs: 10,
      messagePollIntervalMs: 10,
      inboxMaxMessages: 50,
      defaultReceiveTimeoutMs: 50,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: TextToolResult): string {
  return result.content[0]?.text ?? '';
}

describe('soft start (unconfigured server)', () => {
  it('advertises the package version from package.json', async () => {
    const client = await startClient(UNCONFIGURED);
    expect(client.getServerVersion()?.version).toBe(PACKAGE_VERSION);
    await client.close();
  });

  it('still lists all tools including get_setup_status and get_started', async () => {
    const client = await startClient(UNCONFIGURED);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_setup_status');
    expect(names).toContain('get_started');
    expect(names).toContain('send_message');
    await client.close();
  });

  it('serves the guide resources', async () => {
    const client = await startClient(UNCONFIGURED);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('agentbridge://guide/continuous-listening');
    const read = await client.readResource({ uri: 'agentbridge://guide/continuous-listening' });
    expect(String(read.contents[0]?.text)).toContain('AgentBridge');
    await client.close();
  });

  it('get_setup_status reports the problem and fix steps', async () => {
    const client = await startClient(UNCONFIGURED);
    const result = (await client.callTool({ name: 'get_setup_status', arguments: {} })) as TextToolResult;
    expect(result.isError).toBeFalsy();
    const status = JSON.parse(firstText(result));
    expect(status.configured).toBe(false);
    expect(status.problem).toContain('AGENTBRIDGE_SESSION_LINK');
    expect(status.fix_steps.join('\n')).toContain('.agentbridge/secrets.env');
    expect(status.fix_steps.join('\n')).toContain('agentbridge-setup --onboard');
    await client.close();
  });

  it('get_started returns the setup guide without a session', async () => {
    const client = await startClient(UNCONFIGURED);
    const result = (await client.callTool({ name: 'get_started', arguments: {} })) as TextToolResult;
    expect(result.isError).toBeFalsy();
    expect(firstText(result).length).toBeGreaterThan(100);
    await client.close();
  });

  it.each(['connect', 'send_message', 'join_meeting', 'list_agents'])(
    'session tool %s returns a NOT_CONFIGURED isError result instead of crashing',
    async (tool) => {
      const client = await startClient(UNCONFIGURED);
      const args = tool === 'send_message' ? { content: 'hi' } : {};
      const result = (await client.callTool({ name: tool, arguments: args })) as TextToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/^NOT_CONFIGURED: /);
      expect(firstText(result)).toContain('get_setup_status');
      await client.close();
    }
  );

  it('unknown tools still report UNKNOWN_TOOL', async () => {
    const client = await startClient(UNCONFIGURED);
    const result = (await client.callTool({ name: 'bogus_tool', arguments: {} })) as TextToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('UNKNOWN_TOOL');
    await client.close();
  });
});

describe('configured server', () => {
  it('get_setup_status reports configured with session details', async () => {
    const state: ServerState = { session: makeSession(), configError: null };
    const client = await startClient(state);
    const result = (await client.callTool({ name: 'get_setup_status', arguments: {} })) as TextToolResult;
    const status = JSON.parse(firstText(result));
    expect(status.configured).toBe(true);
    expect(status.session).toMatchObject({ relay: 'https://relay.example', slug: 'demo', has_token: true });
    expect(status.next_steps.length).toBeGreaterThan(0);
    await client.close();
  });

  it('session tools work through the injected transport', async () => {
    const transport = new FakeTransport();
    const state: ServerState = { session: makeSession(), configError: null };
    const client = await startClient(state, transport);

    const connect = (await client.callTool({ name: 'connect', arguments: {} })) as TextToolResult;
    expect(connect.isError).toBeFalsy();
    expect(JSON.parse(firstText(connect)).status).toBe('active');

    const send = (await client.callTool({
      name: 'send_message',
      arguments: { content: 'hello' },
    })) as TextToolResult;
    expect(send.isError).toBeFalsy();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.content).toBe('hello');
    await client.close();
  });
});

describe('buildSetupStatus', () => {
  it('uses a default problem message when configError is empty', () => {
    const status = buildSetupStatus({ session: null, configError: null });
    expect(status.configured).toBe(false);
    expect(status.problem).toContain('AGENTBRIDGE_SESSION_LINK');
  });
});
