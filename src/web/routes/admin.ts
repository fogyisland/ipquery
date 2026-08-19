// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { findUserById, setDisabled, markEmailVerified, deleteUser, updatePassword, findUserByEmail } from '../../storage/users';
import { hashPassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';
import { runPipeline } from '../../etl/pipeline';
import { listAllApiKeys, revokeApiKey } from '../../storage/apiKeys';
import { listQueryLogs, streamQueryLogsCsv } from '../../storage/queryLog';
import { getOverview } from '../admin/overview';
import { parseListQuery } from '../admin/queryString';
import { csvForRows, withBom } from '../admin/csv';

// /admin/* is already gated by the auth guard in src/web/plugins/auth.ts:
// non-admins are 403-redirected before this handler runs, so req.user is
// guaranteed to be an admin here.
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin', async (req, reply) => {
    const overview = await getOverview(app.pool);
    return reply.view('admin/dashboard.hbs', {
      layout: 'layouts/admin', title: req.t('admin.dashboard.title'),
      overview, csrfToken: req.csrfToken, req,
    });
  });

  app.get('/admin/users', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['role', 'disabled', 'verified', 'search'],
      sort: ['id', 'created_at', 'email'],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.role) { where.push('role = ?'); params.push(q.filters.role); }
    if (q.filters.disabled) { where.push('is_disabled = ?'); params.push(Number(q.filters.disabled)); }
    if (q.filters.verified) { where.push('email_verified = ?'); params.push(Number(q.filters.verified)); }
    if (q.filters.search) { where.push('email LIKE ?'); params.push(`%${q.filters.search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q.sort ? `ORDER BY ${q.sort.col} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY id DESC';
    const offset = (q.page - 1) * q.limit;

    const [rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT * FROM users ${whereSql} ${orderBy} LIMIT ? OFFSET ?`, [...params, q.limit, offset],
    );
    const [totalRows] = await app.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM users ${whereSql}`, params,
    );
    const total = Number((totalRows[0] as { c: number }).c);

    return reply.view('admin/users-list.hbs', {
      layout: 'layouts/admin', title: req.t('admin.users.title'),
      users: rows, page: q.page, totalPages: Math.max(1, Math.ceil(total / q.limit)),
      filters: q.filters, sort: q.sort, req, csrfToken: req.csrfToken,
    });
  });

  app.get('/admin/users.csv', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['role', 'disabled', 'verified', 'search'], sort: ['id', 'created_at'],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.role) { where.push('role = ?'); params.push(q.filters.role); }
    if (q.filters.disabled) { where.push('is_disabled = ?'); params.push(Number(q.filters.disabled)); }
    if (q.filters.search) { where.push('email LIKE ?'); params.push(`%${q.filters.search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q.sort ? `ORDER BY ${q.sort.col} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY id DESC';
    const [rows] = await app.pool.query<RowDataPacket[]>(`SELECT * FROM users ${whereSql} ${orderBy}`, params);
    const csv = withBom(csvForRows(rows as RowDataPacket[], [
      { header: 'id', get: (r) => r.id },
      { header: 'email', get: (r) => r.email },
      { header: 'role', get: (r) => r.role },
      { header: 'email_verified', get: (r) => r.email_verified },
      { header: 'is_disabled', get: (r) => r.is_disabled },
      { header: 'created_at', get: (r) => (r.created_at as Date).toISOString() },
    ]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="users.csv"');
    return csv;
  });

  app.post('/admin/users/bulk', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const body = req.body as { action?: string; ids?: string };
    const ids = (body.ids ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0).slice(0, 100);
    if (ids.length === 0) return reply.redirect('/admin/users');
    req.auditAction = { action: `user.bulk.${body.action}`, targetType: 'user', metadata: { ids, count: ids.length } };
    if (body.action === 'disable') {
      await app.pool.query('UPDATE users SET is_disabled = 1 WHERE id IN (?)', [ids]);
    } else if (body.action === 'enable') {
      await app.pool.query('UPDATE users SET is_disabled = 0 WHERE id IN (?)', [ids]);
    } else if (body.action === 'verify') {
      await app.pool.query('UPDATE users SET email_verified = 1 WHERE id IN (?)', [ids]);
    } else {
      return reply.code(400).send({ error: 'unknown action' });
    }
    return reply.redirect('/admin/users');
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
    const id = Number(req.params.id);
    const tempPassword = `Temp${Math.random().toString(36).slice(2, 10)}1`;
    await updatePassword(app.pool, id, await hashPassword(tempPassword));
    // Render the user-detail page with tempPassword in context so the admin
    // can copy it. The field is only set on this single render and is gone
    // on the next GET (req.t resolves to undefined since it's not in context).
    const u = await findUserById(app.pool, id);
    if (!u) return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    return reply.view('admin/user-detail.hbs', {
      layout: 'layouts/admin', title: u.email, user: u, tempPassword, req,
    });
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/delete', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await deleteUser(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users');
  });

  app.get<{ Params: { id: string } }>('/admin/users/:id/delete/confirm', async (req, reply) => {
    const u = await findUserById(app.pool, Number(req.params.id));
    if (!u) return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    return reply.view('admin/user-delete-confirm.hbs', {
      layout: 'layouts/admin', title: req.t('admin.users.delete.confirm.title'), user: u, req,
    });
  });

  app.get('/admin/etl', async (_req, reply) => reply.redirect('/admin/etl/runs'));

  app.get('/admin/etl/runs', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['status', 'since', 'until'],
      sort: ['id', 'started_at'],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.status) { where.push('status = ?'); params.push(q.filters.status); }
    if (q.filters.since) { where.push('started_at >= ?'); params.push(new Date(q.filters.since)); }
    if (q.filters.until) { where.push('started_at <= ?'); params.push(new Date(q.filters.until)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q.sort ? `ORDER BY ${q.sort.col} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY id DESC';
    const offset = (q.page - 1) * q.limit;
    const [rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT * FROM etl_runs ${whereSql} ${orderBy} LIMIT ? OFFSET ?`, [...params, q.limit, offset],
    );
    const [totalRows] = await app.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM etl_runs ${whereSql}`, params,
    );
    const total = Number((totalRows[0] as { c: number }).c);
    return reply.view('admin/etl-runs.hbs', {
      layout: 'layouts/admin', title: req.t('admin.etl.title'),
      runs: rows, page: q.page, totalPages: Math.max(1, Math.ceil(total / q.limit)),
      filters: q.filters, sort: q.sort, req, csrfToken: req.csrfToken,
    });
  });

  app.get('/admin/etl/runs.csv', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['status', 'since', 'until'], sort: ['id', 'started_at'],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.status) { where.push('status = ?'); params.push(q.filters.status); }
    if (q.filters.since) { where.push('started_at >= ?'); params.push(new Date(q.filters.since)); }
    if (q.filters.until) { where.push('started_at <= ?'); params.push(new Date(q.filters.until)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q.sort ? `ORDER BY ${q.sort.col} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY id DESC';
    const [rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT * FROM etl_runs ${whereSql} ${orderBy}`, params,
    );
    const csv = withBom(csvForRows(rows as RowDataPacket[], [
      { header: 'id', get: (r) => r.id },
      { header: 'started_at', get: (r) => (r.started_at as Date).toISOString() },
      { header: 'finished_at', get: (r) => r.finished_at ? (r.finished_at as Date).toISOString() : '' },
      { header: 'status', get: (r) => r.status },
      { header: 'maxmind_records', get: (r) => r.maxmind_records ?? '' },
      { header: 'ip2region_records', get: (r) => r.ip2region_records ?? '' },
      { header: 'dbip_records', get: (r) => r.dbip_records ?? '' },
      { header: 'merged_records', get: (r) => r.merged_records ?? '' },
      { header: 'error_message', get: (r) => r.error_message ?? '' },
    ]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="etl-runs.csv"');
    return csv;
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

  app.get('/admin/etl/trigger/confirm', async (req, reply) => {
    return reply.view('admin/etl-trigger-confirm.hbs', {
      layout: 'layouts/admin', title: req.t('admin.etl.trigger.confirm.title'), req,
    });
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
