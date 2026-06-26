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

import { hostMcpSnippet, hostProfile, LISTENING_SKILL, setupGuideForHost, supportedHosts } from './guide.js';
import { installHostConfig, resolveTargetPath } from './setup-config.js';

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
  const wantsWriteSkill = argv.includes('--write-skill') || argv.includes('--write');
  const wantsPrintConfig = argv.includes('--print-config');
  const wantsInstall = argv.includes('--install');
  const configPathOverride = getFlagValue(argv, '--config-path');
  const sessionLink = getFlagValue(argv, '--session-link') || '<your session link>';
  const agentName = getFlagValue(argv, '--agent-name') || '<your agent name>';

  const profile = hostProfile(host);
  const snippet = hostMcpSnippet(sessionLink, agentName);

  if (wantsWriteSkill) {
    const rawTarget = getFlagValue(argv, '--write-skill') || getFlagValue(argv, '--write') || profile.skillDefaultPath;
    const target = rawTarget.startsWith('~/') ? resolve(process.env.HOME ?? process.cwd(), rawTarget.slice(2)) : rawTarget;
    mkdirSync(dirname(target) === '' ? '.' : dirname(target), { recursive: true });
    writeFileSync(target, LISTENING_SKILL, 'utf8');
    console.log(`Wrote listening skill to ${target}`);
    if (!wantsPrintConfig && !wantsInstall && !skillOnly) return;
  }

  if (skillOnly) {
    console.log(LISTENING_SKILL);
    return;
  }

  if (wantsPrintConfig || wantsInstall) {
    const targetPath = resolveTargetPath(profile, { override: configPathOverride });
    console.log(`# Host: ${profile.label}`);
    console.log(`# Config format: ${profile.configFormat}`);
    console.log(`# Target path: ${targetPath}`);
    console.log(`# Install hint: ${profile.installHint}`);
    console.log(`# Skill location: ${profile.skillPathHint}`);
    console.log('');
    if (profile.configFormat === 'json') {
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              agentbridge: {
                command: snippet.command,
                args: snippet.args,
                env: snippet.env,
              },
            },
          },
          null,
          2
        )
      );
    } else {
      console.log('[mcp_servers.agentbridge]');
      console.log(`command = "${snippet.command}"`);
      console.log(`args = [${snippet.args.map((arg) => `"${arg}"`).join(', ')}]`);
      console.log('');
      console.log('[mcp_servers.agentbridge.env]');
      Object.entries(snippet.env).forEach(([key, value]) => {
        console.log(`${key} = "${value}"`);
      });
    }
    if (wantsInstall) {
      const result = installHostConfig({
        host,
        profile,
        snippet,
        configPathOverride,
      });
      console.log('\n---\n');
      console.log(`Installed MCP config at ${result.path}`);
      if (result.backupPath) console.log(`Backup written to ${result.backupPath}`);
      if (result.created) console.log('Created new config file.');
      else console.log('Updated existing config file.');
    }
    return;
  }

  console.log(setupGuideForHost(host));
  console.log('\nSupported hosts:\n');
  supportedHosts().forEach((name) => {
    const p = hostProfile(name);
    console.log(`- ${name}: ${p.configPath} (${p.configFormat})`);
  });
  console.log('\n---\n');
  console.log(LISTENING_SKILL);
}

main();
