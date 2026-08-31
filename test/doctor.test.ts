import { describe, expect, it, vi } from 'vitest';

import type { DiagnosticsReport } from '../src/diagnose.js';
import { DOCTOR_FINAL_STEP, formatDoctorReport, runDoctor } from '../src/doctor.js';

function makeReport(ok: boolean): DiagnosticsReport {
  return {
    ok,
    agentName: 'tester',
    agentId: ok ? 'a1' : null,
    recommendedMode: 'tool-loop',
    checks: [
      { name: 'connect', ok, detail: ok ? 'connected as tester (a1)' : 'RELAY_UNREACHABLE: could not reach x' },
      { name: 'session', ok: true, detail: 'session "demo" (join_mode=token)' },
    ],
    summary: ok ? 'Connected and reachable.' : 'One or more checks failed.',
    nextSteps: ['Run the tool-loop.'],
  };
}

function makeIo() {
  return { log: vi.fn(), error: vi.fn() };
}

describe('formatDoctorReport', () => {
  it('renders a checklist ending with the reload-Cursor step', () => {
    const output = formatDoctorReport(makeReport(true));
    expect(output).toContain('[ok] connect: connected as tester (a1)');
    expect(output).toContain('[ok] session:');
    expect(output.trimEnd().endsWith(`${DOCTOR_FINAL_STEP}.`)).toBe(true);
  });

  it('marks failing checks and includes next steps', () => {
    const output = formatDoctorReport(makeReport(false));
    expect(output).toContain('[fail] connect: RELAY_UNREACHABLE');
    expect(output).toContain('- Run the tool-loop.');
  });
});

describe('runDoctor', () => {
  it('returns 0 and prints the checklist when all checks pass', async () => {
    const io = makeIo();
    const code = await runDoctor('cursor', io, async () => makeReport(true));
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledTimes(1);
    expect(io.log.mock.calls[0]?.[0]).toContain(DOCTOR_FINAL_STEP);
    expect(io.error).not.toHaveBeenCalled();
  });

  it('returns 1 when a check fails', async () => {
    const io = makeIo();
    const code = await runDoctor('cursor', io, async () => makeReport(false));
    expect(code).toBe(1);
    expect(io.log.mock.calls[0]?.[0]).toContain('[fail]');
  });

  it('returns 1 with fix hints when config loading throws', async () => {
    const io = makeIo();
    const code = await runDoctor('cursor', io, async () => {
      throw new Error('AGENTBRIDGE_SESSION_LINK is not set.');
    });
    expect(code).toBe(1);
    const output = io.error.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('NOT_CONFIGURED');
    expect(output).toContain('.agentbridge/secrets.env');
    expect(output).toContain(DOCTOR_FINAL_STEP);
  });
});
