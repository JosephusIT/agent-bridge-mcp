/**
 * Single source of truth for the package version: read from package.json at
 * runtime so the MCP server and CLIs always advertise the published version.
 * Works from both `src/` (tests) and `dist/` (published build) because both
 * live one directory below the package root.
 */

import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the sentinel below; version display must never crash startup.
  }
  return '0.0.0';
}

export const PACKAGE_VERSION: string = readPackageVersion();
