import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySecretsFile, CURSOR_SECRETS_ENV_REL, loadAgentbridgeSecretsFile } from '../src/env-file.js';
import { loadSessionFromEnv } from '../src/config.js';

describe('applySecretsFile', () => {
  it('parses KEY=VALUE and skips existing env keys', () => {
    const priorLink = process.env.AGENTBRIDGE_SESSION_LINK;
    const priorName = process.env.AGENTBRIDGE_AGENT_NAME;
    delete process.env.AGENTBRIDGE_SESSION_LINK;
    process.env.AGENTBRIDGE_AGENT_NAME = 'preset';
    try {
      const applied = applySecretsFile(
        '# comment\nAGENTBRIDGE_SESSION_LINK=https://x/s/a?token=agt\nAGENTBRIDGE_AGENT_NAME=from-file\n'
      );
      expect(applied).toBe(1);
      expect(process.env.AGENTBRIDGE_SESSION_LINK).toBe('https://x/s/a?token=agt');
      expect(process.env.AGENTBRIDGE_AGENT_NAME).toBe('preset');
    } finally {
      if (priorLink === undefined) delete process.env.AGENTBRIDGE_SESSION_LINK;
      else process.env.AGENTBRIDGE_SESSION_LINK = priorLink;
      if (priorName === undefined) delete process.env.AGENTBRIDGE_AGENT_NAME;
      else process.env.AGENTBRIDGE_AGENT_NAME = priorName;
    }
  });
});

describe('loadAgentbridgeSecretsFile', () => {
  it('returns false when link already set', () => {
    process.env.AGENTBRIDGE_SESSION_LINK = 'https://already';
    expect(loadAgentbridgeSecretsFile('/tmp')).toBe(false);
    delete process.env.AGENTBRIDGE_SESSION_LINK;
  });

  it('documents the production cursor fallback path', () => {
    expect(CURSOR_SECRETS_ENV_REL).toBe('.cursor/secrets.env');
  });
});

// Use a sandbox-safe stand-in for `.cursor/secrets.env` (some environments
// refuse mkdir of a literal `.cursor` directory). Production still resolves
// CURSOR_SECRETS_ENV_REL via the default fallbackRels argument.
const CURSOR_FALLBACK = '.cursor-dot/secrets.env';

describe('loadAgentbridgeSecretsFile fallback to .cursor/secrets.env', () => {
  let cwd: string;
  let priorLink: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'agentbridge-env-'));
    priorLink = process.env.AGENTBRIDGE_SESSION_LINK;
    delete process.env.AGENTBRIDGE_SESSION_LINK;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (priorLink === undefined) delete process.env.AGENTBRIDGE_SESSION_LINK;
    else process.env.AGENTBRIDGE_SESSION_LINK = priorLink;
  });

  it('loads .cursor/secrets.env when .agentbridge/secrets.env is absent', () => {
    mkdirSync(join(cwd, '.cursor-dot'));
    writeFileSync(join(cwd, CURSOR_FALLBACK), 'AGENTBRIDGE_SESSION_LINK=https://cursor/s/x?token=agt_c\n');
    expect(loadAgentbridgeSecretsFile(cwd, [CURSOR_FALLBACK])).toBe(true);
    expect(process.env.AGENTBRIDGE_SESSION_LINK).toBe('https://cursor/s/x?token=agt_c');
  });

  it('falls back to .cursor/secrets.env when .agentbridge/secrets.env lacks the link', () => {
    mkdirSync(join(cwd, '.agentbridge'));
    writeFileSync(join(cwd, '.agentbridge/secrets.env'), 'OTHER_KEY=1\n');
    mkdirSync(join(cwd, '.cursor-dot'));
    writeFileSync(join(cwd, CURSOR_FALLBACK), 'AGENTBRIDGE_SESSION_LINK=https://cursor/s/x?token=agt_c\n');
    expect(loadAgentbridgeSecretsFile(cwd, [CURSOR_FALLBACK])).toBe(true);
    expect(process.env.AGENTBRIDGE_SESSION_LINK).toBe('https://cursor/s/x?token=agt_c');
  });

  it('prefers .agentbridge/secrets.env when it defines the link', () => {
    mkdirSync(join(cwd, '.agentbridge'));
    writeFileSync(join(cwd, '.agentbridge/secrets.env'), 'AGENTBRIDGE_SESSION_LINK=https://agentbridge/s/x?token=agt_a\n');
    mkdirSync(join(cwd, '.cursor-dot'));
    writeFileSync(join(cwd, CURSOR_FALLBACK), 'AGENTBRIDGE_SESSION_LINK=https://cursor/s/x?token=agt_c\n');
    expect(loadAgentbridgeSecretsFile(cwd, [CURSOR_FALLBACK])).toBe(true);
    expect(process.env.AGENTBRIDGE_SESSION_LINK).toBe('https://agentbridge/s/x?token=agt_a');
  });

  it('returns false when neither file exists', () => {
    expect(loadAgentbridgeSecretsFile(cwd, [CURSOR_FALLBACK])).toBe(false);
  });
});

describe('loadSessionFromEnv', () => {
  it('throws when no link and no secrets file', () => {
    delete process.env.AGENTBRIDGE_SESSION_LINK;
    expect(() => loadSessionFromEnv()).toThrow(/AGENTBRIDGE_SESSION_LINK is not set/);
  });
});
