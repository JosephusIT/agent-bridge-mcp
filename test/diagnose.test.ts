import { describe, expect, it } from 'vitest';

import { runDiagnostics, summarizeDiagnostics, type DiagnoseDeps } from '../src/diagnose.js';
import { AgentBridgeApiError, type AgentBridgeSession } from '../src/transport.js';

const session: AgentBridgeSession = {
  baseUrl: 'https://relay.example.com',
  apiBaseUrl: 'https://relay.example.com/api',
  slug: 'demo',
  sessionId: 'demo',
  agentName: 'tester',
};

function deps(overrides: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    session,
    connect: async () => ({ status: 'active', agent: { id: 'a1', name: 'tester', status: 'active' } }),
    listAgents: async () => [{ id: 'a1', name: 'tester', status: 'active' }],
    getSessionInfo: async () => ({ slug: 'demo', name: 'Demo', join_mode: 'token' }),
    ...overrides,
  };
}

describe('summarizeDiagnostics', () => {
  const okChecks = [
    { name: 'connect', ok: true, detail: 'connected' },
    { name: 'session', ok: true, detail: 'open' },
    { name: 'agents', ok: true, detail: '1 agent(s) visible' },
  ];

  it('recommends tool-loop for hosts without stdout wake', () => {
    const result = summarizeDiagnostics(okChecks, 'hermes');
    expect(result.ok).toBe(true);
    expect(result.recommendedMode).toBe('tool-loop');
    expect(result.nextSteps.some((s) => s.toLowerCase().includes('hermes'))).toBe(true);
  });

  it('offers the listener accelerator for stdout-wake hosts', () => {
    const result = summarizeDiagnostics(okChecks, 'cursor');
    expect(result.recommendedMode).toBe('tool-loop+listener');
    expect(result.nextSteps.some((s) => s.includes('agentbridge-listen'))).toBe(true);
  });

  it('falls back to generic for unknown hosts', () => {
    expect(summarizeDiagnostics(okChecks, 'something-else').recommendedMode).toBe('tool-loop');
  });

  it('reports not-ok when any check fails', () => {
    const failing = [...okChecks.slice(1), { name: 'connect', ok: false, detail: 'boom' }];
    expect(summarizeDiagnostics(failing, 'cursor').ok).toBe(false);
  });
});

describe('runDiagnostics', () => {
  it('passes all checks against a healthy relay', async () => {
    const report = await runDiagnostics(deps(), { host: 'cursor' });
    expect(report.ok).toBe(true);
    expect(report.agentId).toBe('a1');
    expect(report.checks.map((c) => c.name)).toEqual(['connect', 'session', 'agents']);
    expect(report.recommendedMode).toBe('tool-loop+listener');
  });

  it('captures a connect failure without throwing', async () => {
    const report = await runDiagnostics(
      deps({
        connect: async () => {
          throw new Error('relay down');
        },
      }),
      { host: 'hermes' }
    );
    expect(report.ok).toBe(false);
    const connectCheck = report.checks.find((c) => c.name === 'connect');
    expect(connectCheck?.ok).toBe(false);
    expect(connectCheck?.detail).toContain('relay down');
  });

  it('flags a closed session', async () => {
    const report = await runDiagnostics(
      deps({
        getSessionInfo: async () => ({ slug: 'demo', join_mode: 'token', closed_at: '2026-01-01T00:00:00Z' }),
      })
    );
    expect(report.checks.find((c) => c.name === 'session')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('defaults to generic host when none provided', async () => {
    const report = await runDiagnostics(deps());
    expect(report.recommendedMode).toBe('tool-loop');
  });

  it('treats an auth failure as actionable and skips dependent checks', async () => {
    let agentsCalled = false;
    const report = await runDiagnostics(
      deps({
        connect: async () => {
          throw new AgentBridgeApiError('HTTP_403', 'token already bound', 403);
        },
        listAgents: async () => {
          agentsCalled = true;
          return [];
        },
      }),
      { host: 'hermes' }
    );
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(['connect']);
    expect(agentsCalled).toBe(false);
    expect(report.checks[0].detail).toContain('fresh AgentBridge link/token');
    expect(report.nextSteps[0]).toContain('Authentication failed');
  });
});
