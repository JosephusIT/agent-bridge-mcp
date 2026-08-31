/**
 * `agentbridge-setup --doctor` — load the local config, run the live
 * diagnostics against the relay, and print a short human checklist.
 */

import { loadSessionFromEnv, loadTimingConfig } from './config.js';
import { makeConnectAndAwaitApproval } from './connect.js';
import { buildDiagnoseDeps, runDiagnostics, type DiagnosticsReport } from './diagnose.js';
import { CURSOR_SECRETS_ENV_REL, SECRETS_ENV_REL } from './env-file.js';
import { HttpTransport } from './transport.js';

export const DOCTOR_FINAL_STEP = 'reload Cursor, then tell the agent to join the meeting';

export const DOCTOR_NOT_CONFIGURED_HINT = [
  `Set AGENTBRIDGE_SESSION_LINK in ${SECRETS_ENV_REL} (or ${CURSOR_SECRETS_ENV_REL}), or export it in your environment.`,
  'Or run: npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --onboard --host cursor --session-link \'<your session link>\'',
  'Session links come from the AgentBridge dashboard (session owner): create a session, copy the invite link.',
];

/** Render the diagnostics report as a short checklist ending with the reload step. */
export function formatDoctorReport(report: DiagnosticsReport): string {
  const lines: string[] = ['AgentBridge doctor', ''];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? '[ok]' : '[fail]'} ${check.name}: ${check.detail}`);
  }
  lines.push('');
  lines.push(report.summary);
  if (!report.ok) {
    lines.push('');
    for (const step of report.nextSteps) lines.push(`  - ${step}`);
  }
  lines.push('');
  lines.push(`All set? Then: ${DOCTOR_FINAL_STEP}.`);
  return lines.join('\n');
}

/** Default live diagnostics: real config, real transport, real relay. */
async function runLiveDiagnostics(host: string): Promise<DiagnosticsReport> {
  const session = loadSessionFromEnv();
  const timing = loadTimingConfig();
  const transport = new HttpTransport();
  const connect = makeConnectAndAwaitApproval(session, transport, {
    connectTimeoutMs: timing.connectTimeoutMs,
    approvalPollIntervalMs: timing.approvalPollIntervalMs,
  });
  return runDiagnostics(buildDiagnoseDeps(session, transport, connect), { host });
}

export interface DoctorIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Run the doctor flow and return the process exit code.
 * `diagnose` is injectable for tests; config errors (missing/invalid session
 * link) are reported with fix steps instead of a stack trace.
 */
export async function runDoctor(
  host: string,
  io: DoctorIo = { log: console.log, error: console.error },
  diagnose: (host: string) => Promise<DiagnosticsReport> = runLiveDiagnostics
): Promise<number> {
  let report: DiagnosticsReport;
  try {
    report = await diagnose(host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.error(`AgentBridge doctor: NOT_CONFIGURED — ${message}`);
    for (const hint of DOCTOR_NOT_CONFIGURED_HINT) io.error(`  - ${hint}`);
    io.error(`  - Then: ${DOCTOR_FINAL_STEP}.`);
    return 1;
  }
  io.log(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}
