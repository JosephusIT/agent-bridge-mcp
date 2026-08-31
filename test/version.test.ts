import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../src/version.js';

describe('PACKAGE_VERSION', () => {
  it('matches the version in package.json', () => {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).not.toBe('0.0.0');
  });
});
