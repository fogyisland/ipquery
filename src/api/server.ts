// SPDX-License-Identifier: MIT
import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '../config';
import { createPool } from '../storage/mysql';
import healthRoute from './routes/health';
import lookupRoute from './routes/lookup';
import statsRoute from './routes/stats';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: AppConfig;
    pool: ReturnType<typeof createPool>;
  }
}

export async function buildServer(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, { origin: true });
  await app.register(compress);
  await app.register(rateLimit, { max: cfg.api.rateLimit, timeWindow: '1 minute' });

  app.decorate('cfg', cfg);
  app.decorate('pool', createPool(cfg));

  await app.register(healthRoute);
  await app.register(lookupRoute);
  await app.register(statsRoute);

  await app.ready();

  return app;
}