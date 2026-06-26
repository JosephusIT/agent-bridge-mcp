import { describe, expect, it } from 'vitest';

import { applySecretsFile, loadAgentbridgeSecretsFile } from '../src/env-file.js';
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
});

describe('loadSessionFromEnv', () => {
  it('throws when no link and no secrets file', () => {
    delete process.env.AGENTBRIDGE_SESSION_LINK;
    expect(() => loadSessionFromEnv()).toThrow(/AGENTBRIDGE_SESSION_LINK is not set/);
  });
});
