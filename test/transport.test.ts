import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBridgeSession } from '../src/transport.js';
import { AgentBridgeApiError, HttpTransport, relayUnreachableError } from '../src/transport.js';

function makeSession(overrides: Partial<AgentBridgeSession> = {}): AgentBridgeSession {
  return {
    baseUrl: 'https://relay.example',
    apiBaseUrl: 'https://relay.example/api',
    slug: 'demo',
    sessionId: 'demo',
    agentName: 'tester',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relayUnreachableError', () => {
  it('extracts the host and preserves the cause', () => {
    const cause = new TypeError('fetch failed');
    const err = relayUnreachableError('https://relay.example/api/sessions/demo', cause);
    expect(err).toBeInstanceOf(AgentBridgeApiError);
    expect(err.code).toBe('RELAY_UNREACHABLE');
    expect(err.message).toBe(
      'RELAY_UNREACHABLE: could not reach relay.example — check the session link host and relay status'
    );
    expect(err.cause).toBe(cause);
  });

  it('falls back to the raw URL when it cannot be parsed', () => {
    const err = relayUnreachableError('not a url', new Error('boom'));
    expect(err.message).toContain('could not reach not a url');
  });
});

describe('HttpTransport network failures', () => {
  it('wraps fetch failures as RELAY_UNREACHABLE with the relay host', async () => {
    const cause = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    const transport = new HttpTransport();
    const promise = transport.listAgents(makeSession());
    await expect(promise).rejects.toThrow(/RELAY_UNREACHABLE: could not reach relay\.example/);
    await expect(promise).rejects.toMatchObject({ code: 'RELAY_UNREACHABLE', cause });
  });
});

describe('HttpTransport API errors', () => {
  it('throws AgentBridgeApiError with code and status on unretriable 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 'FORBIDDEN', message: 'no access' }, 403))
    );

    const transport = new HttpTransport();
    const promise = transport.getSessionInfo(makeSession());
    await expect(promise).rejects.toThrow('FORBIDDEN: no access');
    await expect(promise).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('unwraps FastAPI { detail: { code, message } } envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, 404)
      )
    );

    const transport = new HttpTransport();
    const promise = transport.getSessionInfo(makeSession());
    await expect(promise).rejects.toThrow('SESSION_NOT_FOUND: Session not found');
    await expect(promise).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
  });

  it('falls back to HTTP_<status> and detail on 403 without a code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'forbidden for this agent' }, 403)));

    const transport = new HttpTransport();
    const promise = transport.getMessages(makeSession());
    await expect(promise).rejects.toThrow('HTTP_403: forbidden for this agent');
    await expect(promise).rejects.toMatchObject({ status: 403 });
  });
});

describe('HttpTransport token capture', () => {
  it('captures the token returned by connect and sends it on later requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'active', access_token: 'agt_new_token' }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport();
    const session = makeSession();
    const result = await transport.connect(session, { capabilities: ['test'] });

    expect(result.status).toBe('active');
    expect(session.token).toBe('agt_new_token');

    await transport.listAgents(session);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer agt_new_token');
  });

  it('does not overwrite the session token when connect returns none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'pending', knock_id: 'k1' })));

    const transport = new HttpTransport();
    const session = makeSession({ token: 'agt_original' });
    await transport.connect(session);
    expect(session.token).toBe('agt_original');
  });

  it('preserves linkToken when connect replaces token with a JWT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: 'active', access_token: 'jwt_access' }))
    );

    const transport = new HttpTransport();
    const session = makeSession({ token: 'agt_link', linkToken: 'agt_link' });
    await transport.connect(session);
    expect(session.token).toBe('jwt_access');
    expect(session.linkToken).toBe('agt_link');
  });
});

describe('HttpTransport 401 re-auth', () => {
  it('reconnects with the original agt_ link and retries the request once', async () => {
    const fetchMock = vi
      .fn()
      // listAgents → 401
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_TOKEN', message: 'expired' }, 401))
      // reauth connect → active + new JWT
      .mockResolvedValueOnce(jsonResponse({ status: 'active', access_token: 'jwt_refreshed' }))
      // retried listAgents → ok
      .mockResolvedValueOnce(jsonResponse([{ id: 'a1', name: 'tester', status: 'active' }]));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport();
    const session = makeSession({ token: 'jwt_stale', linkToken: 'agt_link' });
    const agents = await transport.listAgents(session);

    expect(agents).toEqual([{ id: 'a1', name: 'tester', status: 'active' }]);
    expect(session.token).toBe('jwt_refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Reconnect used the original link token.
    const [, connectInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((connectInit.headers as Record<string, string>).Authorization).toBe('Bearer agt_link');
    // Retry used the refreshed JWT.
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer jwt_refreshed');
  });

  it('surfaces REAUTH_FAILED when reconnect does not return active', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_TOKEN', message: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ status: 'pending', knock_id: 'k9' }));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport();
    const session = makeSession({ token: 'jwt_stale', linkToken: 'agt_link' });
    await expect(transport.listAgents(session)).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
  });

  it('surfaces REAUTH_FAILED when reconnect itself returns 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_TOKEN', message: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 'LINK_INVALID', message: 'revoked' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport();
    const session = makeSession({ token: 'jwt_stale', linkToken: 'agt_link' });
    await expect(transport.getMessages(session)).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
  });
});
