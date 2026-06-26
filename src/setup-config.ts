import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  const home = opts.homeDir ?? homedir();
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

export function mergeJsonConfig(existingText: string | null, snippet: HostConfigSnippet, sourcePath = 'config'): string {
  let parsed: Record<string, unknown> = {};
  if (existingText) {
    try {
      parsed = JSON.parse(existingText) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse existing JSON config at ${sourcePath}: ${detail}`);
    }
  }
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
  const escaped = value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
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

function isAgentbridgeTableName(name: string): boolean {
  return name === 'mcp_servers.agentbridge' || name.startsWith('mcp_servers.agentbridge.');
}

/**
 * Remove every line that belongs to the `[mcp_servers.agentbridge]` table or any
 * of its child tables (`[mcp_servers.agentbridge.*]`, e.g. the `env` subtable).
 *
 * A naive regex like `/^\[mcp_servers\.agentbridge\][\s\S]*?(?=^\[|$)/m` stops at
 * the first child header (`[mcp_servers.agentbridge.env]`), so a repeated install
 * leaves a stale `env` subtable behind and produces a duplicate (invalid) TOML.
 * Walking line-by-line lets us skip the whole agentbridge subtree and stop only
 * when we reach a header that is NOT a child of `mcp_servers.agentbridge`.
 */
function stripAgentbridgeTables(text: string): string {
  const headerRe = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const header = headerRe.exec(line);
    if (header) {
      const tableName = header[1].trim();
      if (isAgentbridgeTableName(tableName)) {
        skipping = true;
        continue;
      }
      skipping = false;
      kept.push(line);
      continue;
    }
    if (skipping) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Idempotent TOML merge for [mcp_servers.agentbridge] (+ env subtable).
 * We strip the entire existing agentbridge subtree and append a freshly rendered
 * block, keeping the rest of the file intact. This is safe to run repeatedly.
 */
export function mergeTomlConfig(existingText: string | null, snippet: HostConfigSnippet): string {
  const current = existingText ?? '';
  const block = renderTomlAgentbridgeBlock(snippet);
  const stripped = stripAgentbridgeTables(current)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  if (!stripped) return block;
  return `${stripped}\n\n${block}`;
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
    opts.profile.configFormat === 'toml'
      ? mergeTomlConfig(existing, opts.snippet)
      : mergeJsonConfig(existing, opts.snippet, targetPath);

  let backupPath: string | undefined;
  if (exists) {
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    backupPath = `${targetPath}.bak.${stamp}`;
    writeFileSync(backupPath, existing ?? '', 'utf8');
  }
  writeFileSync(targetPath, updated, 'utf8');
  return { path: targetPath, backupPath, created: !exists };
}
