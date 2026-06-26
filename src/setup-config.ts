import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { HostProfile, HostConfigSnippet } from './guide.js';

export interface InstallOptions {
  host: string;
  profile: HostProfile;
  snippet: HostConfigSnippet;
  configPathOverride?: string;
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
}

export interface InstallResult {
  path: string;
  backupPath?: string;
  created: boolean;
}

function resolveHome(pathWithTilde: string, homeDir: string): string {
  if (!pathWithTilde.startsWith('~/')) return pathWithTilde;
  return resolve(homeDir, pathWithTilde.slice(2));
}

export function resolveTargetPath(
  profile: HostProfile,
  opts: { override?: string; cwd?: string; homeDir?: string } = {}
): string {
  if (opts.override) return resolve(opts.override);
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? process.env.HOME ?? cwd;
  const target = profile.projectConfigPath ?? profile.configPath;
  const resolved = resolveHome(target, home);
  if (target.startsWith('.')) return resolve(cwd, target);
  return resolved;
}

function jsonConfigPayload(snippet: HostConfigSnippet): Record<string, unknown> {
  return {
    mcpServers: {
      agentbridge: {
        command: snippet.command,
        args: snippet.args,
        env: snippet.env,
      },
    },
  };
}

export function mergeJsonConfig(existingText: string | null, snippet: HostConfigSnippet): string {
  const parsed = existingText ? (JSON.parse(existingText) as Record<string, unknown>) : {};
  const root = parsed && typeof parsed === 'object' ? parsed : {};
  const mcpServers =
    root.mcpServers && typeof root.mcpServers === 'object' ? (root.mcpServers as Record<string, unknown>) : {};
  mcpServers.agentbridge = {
    command: snippet.command,
    args: snippet.args,
    env: snippet.env,
  };
  root.mcpServers = mcpServers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function tomlValue(value: string): string {
  const escaped = value.replaceAll(/\\/g, String.raw`\\`).replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

export function renderTomlAgentbridgeBlock(snippet: HostConfigSnippet): string {
  const argList = snippet.args.map(tomlValue).join(', ');
  const envLines = Object.entries(snippet.env)
    .map(([key, value]) => `${key} = ${tomlValue(value)}`)
    .join('\n');

  return [
    '[mcp_servers.agentbridge]',
    `command = ${tomlValue(snippet.command)}`,
    `args = [${argList}]`,
    '',
    '[mcp_servers.agentbridge.env]',
    envLines,
    '',
  ].join('\n');
}

/**
 * Idempotent TOML merge for [mcp_servers.agentbridge] (+ env subtable).
 * We intentionally scope replacement to the agentbridge table and keep the rest
 * of the file intact.
 */
export function mergeTomlConfig(existingText: string | null, snippet: HostConfigSnippet): string {
  const current = existingText ?? '';
  const block = renderTomlAgentbridgeBlock(snippet);
  const tableRe = /^\[mcp_servers\.agentbridge\][\s\S]*?(?=^\[|$)/m;
  if (tableRe.test(current)) {
    return current.replace(tableRe, block).replace(/\n{3,}/g, '\n\n');
  }
  const trimmed = current.trimEnd();
  if (!trimmed) return block;
  return `${trimmed}\n\n${block}`;
}

export function installHostConfig(opts: InstallOptions): InstallResult {
  const targetPath = resolveTargetPath(opts.profile, {
    override: opts.configPathOverride,
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });
  mkdirSync(dirname(targetPath), { recursive: true });

  const exists = existsSync(targetPath);
  const existing = exists ? readFileSync(targetPath, 'utf8') : null;
  const updated =
    opts.profile.configFormat === 'toml' ? mergeTomlConfig(existing, opts.snippet) : mergeJsonConfig(existing, opts.snippet);

  let backupPath: string | undefined;
  if (exists) {
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    backupPath = `${targetPath}.bak.${stamp}`;
    writeFileSync(backupPath, existing ?? '', 'utf8');
  }
  writeFileSync(targetPath, updated, 'utf8');
  return { path: targetPath, backupPath, created: !exists };
}
