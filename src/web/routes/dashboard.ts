// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { countQueriesByStatusSince, listQueryLogs } from '../../storage/queryLog';

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // /dashboard/* is already gated by the auth guard in src/web/plugins/auth.ts:
  // unauthenticated requests are redirected to /login?next=... before this
  // handler runs, so req.user is guaranteed non-null here.
  app.get('/dashboard', async (req, reply) => {
    const counts = await countQueriesByStatusSince(app.pool, new Date(Date.now() - 7 * 86400_000));
    return reply.view('dashboard/index.hbs', { layout: 'layouts/dashboard', title: req.t('dashboard.title'), counts, req });
  });

  app.get('/dashboard/history', async (req, reply) => {
    const q = req.query as { page?: string; status?: 'hit' | 'miss' | 'invalid' };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listQueryLogs(app.pool, {
      offset, limit, userId: req.user!.id, status: q.status,
    });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.status) queryParts.push(`status=${encodeURIComponent(q.status)}`);
    const queryString = queryParts.join('&');
    return reply.view('dashboard/history.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.history.title'),
      rows, page, totalPages, status: q.status ?? '', queryString, req,
    });
  });
}
