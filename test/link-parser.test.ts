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
});