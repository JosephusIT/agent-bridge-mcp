#!/usr/bin/env node
/** @junctum/agent-bridge-mcp — MCP stdio server entry point. */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAgentBridgeServer, loadServerState } from './server.js';

const state = loadServerState();
if (state.configError) {
  // Soft start: stay up so the host shows a live server with guidance instead
  // of a dead one. get_setup_status / get_started explain how to finish setup.
  console.error(
    `[agentbridge-mcp-server] ${state.configError} Starting unconfigured — call the get_setup_status tool for fix instructions.`
  );
}

const server = createAgentBridgeServer(state);

const main = async (): Promise<void> => {
  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
  const mode = state.session ? 'configured' : 'unconfigured';
  console.error(`[agentbridge-mcp-server] Running on stdio (${mode}).`);
};

try {
  await main();
} catch (err) {
  console.error('[agentbridge-mcp-server] Fatal:', err);
  process.exit(1);
}
