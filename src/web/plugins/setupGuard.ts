// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { isInitialized } from '../../storage/settings';

declare module 'fastify' {
  interface FastifyInstance {
    requireSetup: boolean;
  }
}

const SETUP_PATH = '/setup';
const SETUP_COMPLETE_PATH = '/setup/complete';
const HEALTHZ_PATH = '/healthz';
const ASSETS_PREFIX = '/assets/';

function isAllowedUrl(url: string): boolean {
  if (url === SETUP_PATH) return true;
  if (url.startsWith(`${SETUP_PATH}/`)) return true;
  if (url === HEALTHZ_PATH) return true;
  if (url.startsWith(ASSETS_PREFIX)) return true;
  return false;
}

function isSetupCompletePath(url: string, method: string): boolean {
  return url === SETUP_COMPLETE_PATH && method === 'POST';
}

export async function registerSetupGuard(app: FastifyInstance): Promise<void> {
  const initialized = await isInitialized(app.pool);
  app.decorate('requireSetup', !initialized);

  app.addHook('onRequest', async (req, reply) => {
    const url = (req.routeOptions?.url ?? req.url) as string;
    const pathOnly = url.split('?')[0]!;

    if (app.requireSetup) {
      if (isAllowedUrl(pathOnly)) return;
      return reply.code(302).header('Location', '/setup').send();
    }

    if (pathOnly === SETUP_PATH || pathOnly.startsWith(`${SETUP_PATH}/`)) {
      return reply.code(404).send('Not Found');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!isSetupCompletePath(req.url.split('?')[0]!, req.method)) return;
    if (reply.statusCode >= 300) return;
    const fresh = await isInitialized(app.pool);
    app.requireSetup = !fresh;
  });
}
