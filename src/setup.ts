#!/usr/bin/env node
/**
 * agentbridge-setup — prints continuous-listening setup guidance and the
 * portable agent skill, and can print/install host-specific MCP config.
 *
 *   agentbridge-setup [--host <cursor|claude-code|...>]
 *                     [--onboard] [--session-link <url>] [--agent-name <name>]
 *                     [--skill] [--write-skill [path]]
 *                     [--print-config] [--install] [--config-path <path>]
 *                     [--doctor]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  AGENTBRIDGE_GITIGNORE,
  AGENTBRIDGE_GITIGNORE_REL,
  SECRETS_ENV_EXAMPLE,
  SECRETS_ENV_EXAMPLE_REL,
  SECRETS_ENV_REL,
} from './env-file.js';
import type { HostConfigSnippet, HostProfile } from './guide.js';
import {
  hostMcpSnippetForProfile,
  hostProfile,
  listeningSkillForHost,
  ONBOARDING_PROMPT,
  setupGuideForHost,
  supportedHosts,
} from './guide.js';
import { runDoctor } from './doctor.js';
import { installHostConfig, mergeJsonConfig, renderTomlAgentbridgeBlock, resolveTargetPath } from './setup-config.js';

function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

function isRealSessionLink(link: string): boolean {
  const trimmed = link.trim();
  return trimmed.length > 0 && trimmed !== '<your session link>' && trimmed.startsWith('http');
}

function writeSkill(argv: string[], host: string, profile: HostProfile): void {
  const rawTarget = getFlagValue(argv, '--write-skill') || getFlagValue(argv, '--write') || profile.skillDefaultPath;
  const target = rawTarget.startsWith('~/') ? resolve(homedir(), rawTarget.slice(2)) : rawTarget;
  mkdirSync(dirname(target) === '' ? '.' : dirname(target), { recursive: true });
  writeFileSync(target, listeningSkillForHost(host), 'utf8');
  console.log(`Wrote listening skill to ${target}`);
}

function writeAgentbridgeSecrets(sessionLink: string, agentName: string, cwd = process.cwd()): string[] {
  const written: string[] = [];
  const dir = resolve(cwd, '.agentbridge');
  mkdirSync(dir, { recursive: true });

  const gitignorePath = resolve(cwd, AGENTBRIDGE_GITIGNORE_REL);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, AGENTBRIDGE_GITIGNORE, 'utf8');
    written.push(AGENTBRIDGE_GITIGNORE_REL);
  }

  const examplePath = resolve(cwd, SECRETS_ENV_EXAMPLE_REL);
  writeFileSync(examplePath, SECRETS_ENV_EXAMPLE, 'utf8');
  written.push(SECRETS_ENV_EXAMPLE_REL);

  const secretsPath = resolve(cwd, SECRETS_ENV_REL);
  if (isRealSessionLink(sessionLink)) {
    const body = `# AgentBridge session credentials (gitignored)\nAGENTBRIDGE_SESSION_LINK=${sessionLink}\nAGENTBRIDGE_AGENT_NAME=${agentName}\n`;
    writeFileSync(secretsPath, body, 'utf8');
    written.push(SECRETS_ENV_REL);
  }

  return written;
}

function printConfig(profile: HostProfile, snippet: HostConfigSnippet, configPathOverride?: string): void {
  const targetPath = resolveTargetPath(profile, { override: configPathOverride });
  console.log(`# Host: ${profile.label}`);
  console.log(`# Config format: ${profile.configFormat}`);
  console.log(`# Target path: ${targetPath}`);
  console.log(`# Install hint: ${profile.installHint}`);
  console.log(`# Skill location: ${profile.skillPathHint}`);
  if (profile.usesSecretsEnvFile) {
    console.log(`# Secrets file: ${SECRETS_ENV_REL} (loaded via envFile in MCP config)`);
  }
  console.log('');
  const rendered = profile.configFormat === 'json' ? mergeJsonConfig(null, snippet) : renderTomlAgentbridgeBlock(snippet);
  console.log(rendered.trimEnd());
}

function installConfig(
  host: string,
  profile: HostProfile,
  snippet: HostConfigSnippet,
  configPathOverride?: string,
  sessionLink?: string
): void {
  const writesProjectConfig = configPathOverride ? !isAbsolute(configPathOverride) : Boolean(profile.projectConfigPath);
  const link = sessionLink ?? snippet.env?.AGENTBRIDGE_SESSION_LINK ?? '';
  if (writesProjectConfig && isRealSessionLink(link) && !profile.usesSecretsEnvFile) {
    console.warn(
      'Warning: writing AGENTBRIDGE_SESSION_LINK into a project config file. Treat this as sensitive and avoid committing it.'
    );
  }
  const result = installHostConfig({ host, profile, snippet, configPathOverride });
  console.log('\n---\n');
  console.log(`Installed MCP config at ${result.path}`);
  if (result.backupPath) console.log(`Backup written to ${result.backupPath}`);
  console.log(result.created ? 'Created new config file.' : 'Updated existing config file.');
}

function printOnboardSummary(host: string, profile: HostProfile, sessionLink: string, agentName: string, paths: string[]): void {
  console.log('\n========================================');
  console.log(`AgentBridge onboarded for ${profile.label}`);
  console.log('========================================\n');
  console.log('Created/updated:');
  for (const p of paths) console.log(`  • ${p}`);
  console.log('');
  if (!isRealSessionLink(sessionLink)) {
    console.log('Next steps:');
    console.log(`  1. Copy ${SECRETS_ENV_EXAMPLE_REL} → ${SECRETS_ENV_REL}`);
    console.log('  2. Paste your session link from the AgentBridge UI');
  } else {
    console.log(`Session: configured for agent "${agentName}"`);
    console.log('');
    console.log('Next steps:');
  }
  if (host === 'cursor') {
    console.log('  1. Reload Cursor (Cmd+Shift+P → Developer: Reload Window)');
    console.log('  2. Tell your agent: "Join the AgentBridge session and keep listening"');
    console.log('');
    console.log('The agent will use chat-wake: agentbridge-listen + AGENTBRIDGE_INBOUND → reply via send_message.');
  } else {
    console.log('  1. Reload your MCP host');
    console.log('  2. Call connect → join_meeting, or use agentbridge-listen if your host supports stdout wake');
  }
  console.log('');
}

function onboard(
  host: string,
  profile: HostProfile,
  snippet: HostConfigSnippet,
  argv: string[],
  configPathOverride?: string,
  sessionLink?: string,
  agentName?: string
): void {
  const link = sessionLink ?? '<your session link>';
  const name = agentName ?? 'agentbridge-agent';
  const written = writeAgentbridgeSecrets(link, name);
  installConfig(host, profile, snippet, configPathOverride, link);
  writeSkill(argv, host, profile);
  const configPath = resolveTargetPath(profile, { override: configPathOverride });
  written.push(configPath);
  written.push(profile.skillDefaultPath);
  printOnboardSummary(host, profile, link, name, written);
}

function printDefaultGuide(host: string): void {
  console.log(setupGuideForHost(host));
  console.log('\nSupported hosts:\n');
  supportedHosts().forEach((name) => {
    const p = hostProfile(name);
    console.log(`- ${name}: ${p.configPath} (${p.configFormat})`);
  });
  console.log('\n---\n');
  console.log('Quick onboard (recommended):\n');
  console.log(
    '  npx -y -p @junctum/agent-bridge-mcp agentbridge-setup --onboard --host cursor \\\n' +
      "    --session-link '<your session link>' --agent-name '<your agent name>'\n"
  );
  console.log('\n---\n');
  console.log(ONBOARDING_PROMPT);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const host = getFlagValue(argv, '--host') || 'generic';

  if (argv.includes('--doctor')) {
    process.exitCode = await runDoctor(host);
    return;
  }

  const skillOnly = argv.includes('--skill');
  const wantsWriteSkill = argv.includes('--write-skill') || argv.includes('--write');
  const wantsPrintConfig = argv.includes('--print-config');
  const wantsInstall = argv.includes('--install');
  const wantsOnboard = argv.includes('--onboard');
  const configPathOverride = getFlagValue(argv, '--config-path');
  const sessionLink = getFlagValue(argv, '--session-link') || '<your session link>';
  const agentName = getFlagValue(argv, '--agent-name') || '<your agent name>';

  const profile = hostProfile(host);
  const genericProfile = hostProfile('generic');
  if (host.toLowerCase() !== 'generic' && profile === genericProfile) {
    console.warn(`Warning: unknown --host "${host}", falling back to generic profile.`);
  }
  const snippet = hostMcpSnippetForProfile(profile, sessionLink, agentName);

  if (wantsOnboard) {
    onboard(host, profile, snippet, argv, configPathOverride, sessionLink, agentName);
    return;
  }

  if (wantsWriteSkill) {
    writeSkill(argv, host, profile);
    if (!wantsPrintConfig && !wantsInstall && !skillOnly) return;
  }

  if (skillOnly) {
    console.log(listeningSkillForHost(host));
    return;
  }

  if (wantsPrintConfig || wantsInstall) {
    printConfig(profile, snippet, configPathOverride);
    if (wantsInstall) installConfig(host, profile, snippet, configPathOverride, sessionLink);
    return;
  }

  printDefaultGuide(host);
}

await main();
