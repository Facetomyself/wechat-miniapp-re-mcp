#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WxmpApp } from './app.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  console.error('[wxmp] starting wechat-miniapp-re-mcp v0.1.0');
  console.error('[wxmp] mode=stdio target-attach=lazy');
  const app = new WxmpApp();
  const server = createServer(app);
  let stopping = false;
  const shutdown = async (signal: string, code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`[wxmp] ${signal}: shutting down`);
    await app.shutdown().catch((error) => console.error('[wxmp] shutdown failed', error));
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('uncaughtException', (error) => void shutdown(`uncaughtException:${error.message}`, 1));
  process.on('unhandledRejection', (error) => void shutdown(`unhandledRejection:${String(error)}`, 1));
  await server.connect(new StdioServerTransport());
  console.error('[wxmp] ready');
}

main().catch((error) => {
  console.error('[wxmp] fatal', error);
  process.exit(1);
});
