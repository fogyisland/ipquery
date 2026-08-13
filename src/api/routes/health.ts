// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';

export default async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
}