/**
 * Entry point. Wires config -> feed -> orchestrator -> server and starts the loop.
 *
 * `npm run dev` (tsx watch) lands here. With zero env config it runs the sim
 * feed + rule watcher + bots on port 8787 — fully self-contained.
 */

import 'dotenv/config'; // load services/feed/.env (ANTHROPIC_API_KEY, FEE_RECIPIENT, …) BEFORE config reads env
import { config, describeConfig } from './config';
import { createFeed } from './feed/index';
import { Orchestrator } from './orchestrator';

async function main(): Promise<void> {
  console.log(`[golazo/feed] booting — ${describeConfig(config)}`);

  // Pick a feed (real ESPN if a game is live, else the simulator).
  const { feed, reason } = await createFeed(config);
  console.log(`[golazo/feed] feed=${feed.kind} (${reason})`);

  const game = feed.state();
  console.log(`[golazo/feed] match: ${game.home.name} vs ${game.away.name} [${game.status}]`);

  const orchestrator = new Orchestrator(config, feed);
  await orchestrator.start();

  console.log(`[golazo/feed] listening on :${config.port}`);
  console.log(`[golazo/feed]   ws://localhost:${config.port}        (app connects here)`);
  console.log(`[golazo/feed]   http://localhost:${config.port}/health`);
  console.log(`[golazo/feed]   http://localhost:${config.port}/state`);
  console.log(`[golazo/feed]   http://localhost:${config.port}/rpc   (Solana JSON-RPC proxy)`);

  // Graceful shutdown so timers/sockets are released on Ctrl-C / SIGTERM.
  const shutdown = (sig: string) => {
    console.log(`\n[golazo/feed] ${sig} — shutting down…`);
    orchestrator
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[golazo/feed] fatal:', err);
  process.exit(1);
});
