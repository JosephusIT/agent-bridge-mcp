import { describe, it, expect } from 'vitest';
import { parseSessionLink } from '../src/link-parser.js';

describe('link-parser', () => {
  it('parses pre-auth /s/{slug} link', () => {
    const result = parseSessionLink(
      'https://agentbridge.example.com/s/infra-collab-jun14?token=agt_123&team=acme'
    );
    expect(result.baseUrl).toBe('https://agentbridge.example.com');
    expect(result.apiBaseUrl).toBe('https://agentbridge.example.com/api/v1');
    expect(result.sessionId).toBe('infra-collab-jun14');
    expect(result.token).toBe('agt_123');
    expect(result.params.team).toBe('acme');
  });

  it('parses open /s/{slug} link without token', () => {
    const result = parseSessionLink(
      'https://agentbridge.example.com/s/dev-agent-jun14'
    );
    expect(result.baseUrl).toBe('https://agentbridge.example.com');
    expect(result.sessionId).toBe('dev-agent-jun14');
    expect(result.token).toBeUndefined();
  });

  it('throws on missing session segment', () => {
    expect(() => parseSessionLink('agentbridge://api.example.com/')).toThrow(
      /missing \/s\/{slug}/i
    );
  });

  it('throws on malformed URL', () => {
    expect(() => parseSessionLink('not-a-url')).toThrow();
  });

  it('allows http://localhost for local relays', () => {
    const result = parseSessionLink('http://localhost:8000/s/dev-session?token=agt_local');
    expect(result.baseUrl).toBe('http://localhost:8000');
    expect(result.apiBaseUrl).toBe('http://localhost:8000/api/v1');
    expect(result.slug).toBe('dev-session');
    expect(result.token).toBe('agt_local');
  });

  it('allows http://127.0.0.1', () => {
    const result = parseSessionLink('http://127.0.0.1:8000/s/local');
    expect(result.baseUrl).toBe('http://127.0.0.1:8000');
  });

  it('rejects http:// for non-localhost hosts', () => {
    expect(() => parseSessionLink('http://relay.example.com/s/demo')).toThrow(/localhost/i);
  });
});
