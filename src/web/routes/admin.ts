// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { listUsers, findUserById, setDisabled, markEmailVerified, deleteUser, updatePassword, findUserByEmail } from '../../storage/users';
import { hashPassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';
import { runPipeline } from '../../etl/pipeline';
import { listAllApiKeys, revokeApiKey } from '../../storage/apiKeys';
import { listQueryLogs, streamQueryLogsCsv } from '../../storage/queryLog';

// /admin/* is already gated by the auth guard in src/web/plugins/auth.ts:
// non-admins are 403-redirected before this handler runs, so req.user is
// guaranteed to be an admin here.
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin', async (_req, reply) => reply.code(302).redirect('/admin/users'));

  app.get('/admin/users', async (req, reply) => {
    const q = req.query as { page?: string; q?: string; role?: 'user' | 'admin' };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listUsers(app.pool, { offset, limit, search: q.q, role: q.role });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.q) queryParts.push(`q=${encodeURIComponent(q.q)}`);
    if (q.role) queryParts.push(`role=${encodeURIComponent(q.role)}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/users.hbs', {
      layout: 'layouts/admin', title: req.t('admin.users.title'),
      users: rows, page, totalPages, q: q.q ?? '', role: q.role ?? '', queryString, req,
    });
  });

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const u = await findUserById(app.pool, Number(req.params.id));
    if (!u) return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    return reply.view('admin/user-detail.hbs', { layout: 'layouts/admin', title: u.email, user: u, req });
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/enable', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await setDisabled(app.pool, Number(req.params.id), false);
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/disable', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await setDisabled(app.pool, Number(req.params.id), true);
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/verify-email', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await markEmailVerified(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-password', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const tempPassword = `Temp${Math.random().toString(36).slice(2, 10)}1`;
    await updatePassword(app.pool, Number(req.params.id), await hashPassword(tempPassword));
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/delete', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await deleteUser(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users');
  });

  app.get('/admin/etl', async (_req, reply) => reply.redirect('/admin/etl/runs'));

  app.get('/admin/etl/runs', async (req, reply) => {
    const q = req.query as { page?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const [runs] = await app.pool.query<RowDataPacket[]>(
      `SELECT * FROM etl_runs ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset],
    );
    const [totalRows] = await app.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM etl_runs`);
    const total = Number(totalRows[0]?.c ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return reply.view('admin/etl-runs.hbs', {
      layout: 'layouts/admin', title: req.t('admin.etl.title'),
      runs, page, totalPages, req,
    });
  });

  app.get<{ Params: { id: string } }>('/admin/etl/runs/:id', async (req, reply) => {
    const [rows] = await app.pool.query<RowDataPacket[]>('SELECT * FROM etl_runs WHERE id = ?', [Number(req.params.id)]);
    const run = rows[0];
    if (!run) return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    return reply.view('admin/etl-run-detail.hbs', { layout: 'layouts/admin', title: req.t('admin.etl.detail.title', { id: run.id }), run, req });
  });

  app.post('/admin/etl/trigger', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    void runPipeline({ cfg: app.cfg }).catch((err) => app.log.error({ err }, 'manual ETL failed'));
    return reply.redirect('/admin/etl/runs');
  });

  app.get('/admin/keys', async (req, reply) => {
    const q = req.query as { page?: string; userId?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listAllApiKeys(app.pool, { offset, limit, userId: q.userId ? Number(q.userId) : undefined });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.userId) queryParts.push(`userId=${encodeURIComponent(q.userId)}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/keys.hbs', {
      layout: 'layouts/admin', title: req.t('admin.keys.title'),
      keys: rows, page, totalPages, userId: q.userId ?? '', queryString, req,
    });
  });

  app.post<{ Params: { id: string } }>('/admin/keys/:id/revoke', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await revokeApiKey(app.pool, Number(req.params.id));
    return reply.redirect('/admin/keys');
  });

  app.get('/admin/audit', async (req, reply) => {
    const q = req.query as { page?: string; userEmail?: string; status?: 'hit' | 'miss' | 'invalid'; ipText?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    let userId: number | undefined;
    if (q.userEmail) {
      const u = await findUserByEmail(app.pool, q.userEmail);
      // Sentinel -1 (no user has this id) forces zero rows when the email
      // doesn't resolve — listQueryLogs filters on user_id !== undefined.
      userId = u ? u.id : -1;
    }
    const { rows, total } = await listQueryLogs(app.pool, { offset, limit, userId, status: q.status, ipText: q.ipText });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.userEmail) queryParts.push(`userEmail=${encodeURIComponent(q.userEmail)}`);
    if (q.status) queryParts.push(`status=${encodeURIComponent(q.status)}`);
    if (q.ipText) queryParts.push(`ipText=${encodeURIComponent(q.ipText)}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/audit.hbs', {
      layout: 'layouts/admin', title: req.t('admin.audit.title'),
      rows, page, totalPages, userEmail: q.userEmail ?? '', status: q.status ?? '', ipText: q.ipText ?? '', queryString, req,
    });
  });

  app.get('/admin/audit.csv', async (req, reply) => {
    const q = req.query as { userEmail?: string; status?: 'hit' | 'miss' | 'invalid'; ipText?: string };
    let userId: number | undefined;
    if (q.userEmail) {
      const u = await findUserByEmail(app.pool, q.userEmail);
      userId = u ? u.id : -1;
    }
    const chunks: string[] = [];
    await streamQueryLogsCsv(
      app.pool,
      { offset: 0, limit: 1_000_000, userId, status: q.status, ipText: q.ipText },
      (s) => chunks.push(s),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="audit.csv"');
    return reply.send(chunks.join(''));
  });
}
