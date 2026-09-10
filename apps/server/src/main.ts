import { loadConfig, ConfigError, hasCloudAI } from './config';
import { hasEnvFile, loadDotEnv } from './dotenv';
import { initEnv } from './tools/init-env';
import { buildServer } from './app';

/**
 * Process entry point: `npm run start` (or `node dist/main.mjs` in a release).
 *
 * Deployment is a single Node service — no Docker for the operator, none for the user (docs/08 §8).
 */
async function main(): Promise<void> {
  // A machine that was never configured configures itself: without a stable identity every restart
  // would invalidate sessions and every push subscription. The file is written only when the
  // operator has provided nothing at all (no JWT_SECRET in the environment and no .env where the
  // loader looks), so an existing configuration is never touched.
  if (process.env.NODE_ENV !== 'test' && !process.env.JWT_SECRET && !hasEnvFile()) {
    try {
      const created = initEnv(process.cwd());
      if (created.created) {
        process.stdout.write(`LifeMentor server: wrote ${created.path} with a stable JWT secret and VAPID key pair.\n`);
      }
    } catch (error) {
      process.stderr.write(`LifeMentor server: could not write .env (${error instanceof Error ? error.message : String(error)}) — continuing with a throwaway identity\n`);
    }
  }
  // Operator-side .env (cwd) — shell environment always takes priority.
  loadDotEnv();
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
  if (config.push.vapidPublicGenerated) {
    app.log.warn('VAPID key pair was generated for this run only — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY so push subscriptions survive a restart (npm run vapid:keys)');
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
