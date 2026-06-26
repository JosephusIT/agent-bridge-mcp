#!/usr/bin/env node
/**
 * agentbridge-setup — prints continuous-listening setup guidance and the
 * portable agent skill, and can print/install host-specific MCP config.
 *
 *   agentbridge-setup [--host <cursor|claude-code|claude-desktop|codex|vscode-copilot|generic>]
 *                     [--skill] [--write-skill [path]]
 *                     [--print-config] [--install] [--config-path <path>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { HostConfigSnippet, HostProfile } from './guide.js';
import { hostMcpSnippet, hostProfile, LISTENING_SKILL, setupGuideForHost, supportedHosts } from './guide.js';
import { installHostConfig, mergeJsonConfig, renderTomlAgentbridgeBlock, resolveTargetPath } from './setup-config.js';

function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

function writeSkill(argv: string[], profile: HostProfile): void {
  const rawTarget = getFlagValue(argv, '--write-skill') || getFlagValue(argv, '--write') || profile.skillDefaultPath;
  const target = rawTarget.startsWith('~/') ? resolve(process.env.HOME ?? process.cwd(), rawTarget.slice(2)) : rawTarget;
  mkdirSync(dirname(target) === '' ? '.' : dirname(target), { recursive: true });
  writeFileSync(target, LISTENING_SKILL, 'utf8');
  console.log(`Wrote listening skill to ${target}`);
}

function printConfig(profile: HostProfile, snippet: HostConfigSnippet, configPathOverride?: string): void {
  const targetPath = resolveTargetPath(profile, { override: configPathOverride });
  console.log(`# Host: ${profile.label}`);
  console.log(`# Config format: ${profile.configFormat}`);
  console.log(`# Target path: ${targetPath}`);
  console.log(`# Install hint: ${profile.installHint}`);
  console.log(`# Skill location: ${profile.skillPathHint}`);
  console.log('');
  const rendered = profile.configFormat === 'json' ? mergeJsonConfig(null, snippet) : renderTomlAgentbridgeBlock(snippet);
  console.log(rendered.trimEnd());
}

function installConfig(host: string, profile: HostProfile, snippet: HostConfigSnippet, configPathOverride?: string): void {
  const result = installHostConfig({ host, profile, snippet, configPathOverride });
  console.log('\n---\n');
  console.log(`Installed MCP config at ${result.path}`);
  if (result.backupPath) console.log(`Backup written to ${result.backupPath}`);
  console.log(result.created ? 'Created new config file.' : 'Updated existing config file.');
}

function printDefaultGuide(host: string): void {
  console.log(setupGuideForHost(host));
  console.log('\nSupported hosts:\n');
  supportedHosts().forEach((name) => {
    const p = hostProfile(name);
    console.log(`- ${name}: ${p.configPath} (${p.configFormat})`);
  });
  console.log('\n---\n');
  console.log(LISTENING_SKILL);
}

function main(): void {
  const argv = process.argv.slice(2);
  const host = getFlagValue(argv, '--host') || 'generic';
  const skillOnly = argv.includes('--skill');
  const wantsWriteSkill = argv.includes('--write-skill') || argv.includes('--write');
  const wantsPrintConfig = argv.includes('--print-config');
  const wantsInstall = argv.includes('--install');
  const configPathOverride = getFlagValue(argv, '--config-path');
  const sessionLink = getFlagValue(argv, '--session-link') || '<your session link>';
  const agentName = getFlagValue(argv, '--agent-name') || '<your agent name>';

  const profile = hostProfile(host);
  const snippet = hostMcpSnippet(sessionLink, agentName);

  if (wantsWriteSkill) {
    writeSkill(argv, profile);
    if (!wantsPrintConfig && !wantsInstall && !skillOnly) return;
  }

  if (skillOnly) {
    console.log(LISTENING_SKILL);
    return;
  }

  if (wantsPrintConfig || wantsInstall) {
    printConfig(profile, snippet, configPathOverride);
    if (wantsInstall) installConfig(host, profile, snippet, configPathOverride);
    return;
  }

  printDefaultGuide(host);
}

main();
