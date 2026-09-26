import { buildApp } from './app';
import { loadConfig } from './config';
import { createContext, ensureSetupToken } from './context';

async function main() {
  const config = loadConfig();
  const ctx = await createContext(config, { role: 'api' });
  const app = await buildApp(ctx);

  const setupToken = await ensureSetupToken(ctx);
  if (setupToken) {
    ctx.log.warn(
      `\n\n  First-run setup: open ${config.publicUrl}/setup\n  Setup token: ${setupToken}\n  (also available via: docker compose exec app node dist/cli.js setup-token)\n`,
    );
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    ctx.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.close().catch(() => {});
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
