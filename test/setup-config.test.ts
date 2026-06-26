import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hostMcpSnippet, hostProfile } from '../src/guide.js';
import { installHostConfig, mergeJsonConfig, mergeTomlConfig } from '../src/setup-config.js';

describe('mergeJsonConfig', () => {
  it('creates a valid JSON config with agentbridge server', () => {
    const text = mergeJsonConfig(null, hostMcpSnippet('https://x/s/demo?token=agt', 'bot'));
    const parsed = JSON.parse(text) as { mcpServers: Record<string, { command: string }> };
    expect(parsed.mcpServers.agentbridge.command).toBe('npx');
  });

  it('preserves unrelated mcp servers while replacing agentbridge', () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: 'node', args: ['x.js'] },
        agentbridge: { command: 'old' },
      },
    });
    const text = mergeJsonConfig(existing, hostMcpSnippet('https://new', 'new-agent'));
    const parsed = JSON.parse(text) as { mcpServers: Record<string, { command: string; env?: Record<string, string> }> };
    expect(parsed.mcpServers.other.command).toBe('node');
    expect(parsed.mcpServers.agentbridge.command).toBe('npx');
    expect(parsed.mcpServers.agentbridge.env?.AGENTBRIDGE_AGENT_NAME).toBe('new-agent');
  });
});

describe('mergeTomlConfig', () => {
  it('appends the agentbridge table when missing', () => {
    const merged = mergeTomlConfig('[other]\nname = "x"\n', hostMcpSnippet('https://x', 'bot'));
    expect(merged).toContain('[mcp_servers.agentbridge]');
    expect(merged).toContain('AGENTBRIDGE_AGENT_NAME = "bot"');
  });

  it('replaces existing agentbridge table idempotently', () => {
    const existing = `[mcp_servers.agentbridge]
command = "old"
args = ["x"]

[mcp_servers.agentbridge.env]
AGENTBRIDGE_SESSION_LINK = "old"
`;
    const merged = mergeTomlConfig(existing, hostMcpSnippet('https://new', 'bot'));
    expect(merged.match(/\[mcp_servers\.agentbridge\]/g) ?? []).toHaveLength(1);
    expect(merged).toContain('AGENTBRIDGE_SESSION_LINK = "https://new"');
  });
});

describe('installHostConfig', () => {
  it('writes config and creates backup on update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-setup-'));
    try {
      const target = join(dir, 'mcp.json');
      writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'node' } } }), 'utf8');
      const profile = hostProfile('cursor');
      const first = installHostConfig({
        host: 'cursor',
        profile,
        snippet: hostMcpSnippet('https://x', 'a'),
        configPathOverride: target,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(first.path).toBe(target);
      expect(first.backupPath).toBeDefined();
      const stored = JSON.parse(readFileSync(target, 'utf8')) as {
        mcpServers: Record<string, { command: string }>;
      };
      expect(stored.mcpServers.agentbridge.command).toBe('npx');
      expect(stored.mcpServers.other.command).toBe('node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
