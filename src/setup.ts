#!/usr/bin/env node
/**
 * agentbridge-setup — prints continuous-listening setup guidance and the
 * portable agent skill, and can write the skill to a file for your host.
 *
 *   agentbridge-setup [--host <cursor|claude-code|vscode|codex|hermes|generic>]
 *                     [--skill] [--write [path]]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { LISTENING_SKILL, setupGuideForHost } from './guide.js';

function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

function main(): void {
  const argv = process.argv.slice(2);
  const host = getFlagValue(argv, '--host') || 'generic';
  const skillOnly = argv.includes('--skill');
  const wantsWrite = argv.includes('--write');

  if (wantsWrite) {
    const target = getFlagValue(argv, '--write') || 'AGENTBRIDGE_LISTENING_SKILL.md';
    mkdirSync(dirname(target) === '' ? '.' : dirname(target), { recursive: true });
    writeFileSync(target, LISTENING_SKILL, 'utf8');
    console.log(`Wrote listening skill to ${target}`);
    return;
  }

  if (skillOnly) {
    console.log(LISTENING_SKILL);
    return;
  }

  console.log(setupGuideForHost(host));
  console.log('\n---\n');
  console.log(LISTENING_SKILL);
}

main();
