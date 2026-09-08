import { loadConfig, ConfigError, hasCloudAI } from './config';
import { buildServer } from './app';

/**
 * Process entry point: `npm run start` (or `node dist/main.mjs` in a release).
 *
 * Deployment is a single Node service — no Docker for the operator, none for the user (docs/08 §8).
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nLifeMentor server: ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, shutdown } = await buildServer(config);

  if (config.jwtSecretGenerated) {
    app.log.warn('JWT_SECRET was generated for this run only — set JWT_SECRET so sessions survive a restart');
  }
  if (!hasCloudAI(config)) {
    app.log.warn('No OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY — the AI gateway serves the local heuristic provider');
  }

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ env: config.env, address }, 'LifeMentor server ready');

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('unhandledRejection', (reason) => { app.log.error({ err: reason }, 'unhandled rejection'); });
  process.on('uncaughtException', (error) => { app.log.fatal({ err: error }, 'uncaught exception'); void stop('uncaughtException'); });
}

main().catch((error) => {
  process.stderr.write(`LifeMentor server failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
