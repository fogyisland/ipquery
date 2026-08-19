// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { findUserById, setDisabled, markEmailVerified, deleteUser, updatePassword, findUserByEmail } from '../../storage/users';
import { hashPassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';
import { runPipeline } from '../../etl/pipeline';
import { listAllApiKeys, revokeApiKey } from '../../storage/apiKeys';
import { listQueryLogs, streamQueryLogsCsv } from '../../storage/queryLog';
import { listAuditLog } from '../../storage/auditLog';
import { getOverview } from '../admin/overview';
import { getQueryStats } from '../admin/queries';
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
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['revoked', 'userId'],
      sort: ['id', 'created_at', 'revoked_at'],
    });
    const userId = q.filters.userId ? Number(q.filters.userId) : undefined;
    const limit = q.limit;
    const offset = (q.page - 1) * limit;
    const { rows, total } = await listAllApiKeys(app.pool, { offset, limit, userId });
    // The brief's columns are id, user_email, label, key_prefix, created_at, revoked_at.
    // For the HTML view we apply the revoked filter client-side because listAllApiKeys
    // doesn't expose a `revoked` predicate; we re-run a fresh JOIN query that does.
    let filtered: typeof rows = rows;
    if (q.filters.revoked) {
      const want = q.filters.revoked === 'yes' ? 1 : 0;
      filtered = rows.filter((k) => (k.revokedAt ? 1 : 0) === want);
    }
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.filters.revoked) queryParts.push(`revoked=${encodeURIComponent(q.filters.revoked)}`);
    if (q.filters.userId) queryParts.push(`userId=${encodeURIComponent(q.filters.userId)}`);
    if (q.sort) queryParts.push(`sort=${q.sort.dir === 'desc' ? '-' : ''}${q.sort.col}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/keys.hbs', {
      layout: 'layouts/admin', title: req.t('admin.keys.title'),
      keys: filtered, page: q.page, totalPages, userId: q.filters.userId ?? '', queryString,
      filters: q.filters, sort: q.sort, req, csrfToken: req.csrfToken,
    });
  });

  app.get('/admin/keys.csv', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['revoked', 'userId'],
      sort: ['id', 'created_at', 'revoked_at'],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.revoked === 'yes') { where.push('k.revoked_at IS NOT NULL'); }
    else if (q.filters.revoked === 'no') { where.push('k.revoked_at IS NULL'); }
    if (q.filters.userId) { where.push('k.user_id = ?'); params.push(Number(q.filters.userId)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q.sort ? `ORDER BY k.${q.sort.col} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY k.id DESC';
    const [rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT k.*, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.user_id ${whereSql} ${orderBy}`,
      params,
    );
    const csv = withBom(csvForRows(rows as RowDataPacket[], [
      { header: 'id', get: (r) => r.id },
      { header: 'user_email', get: (r) => r.owner_email },
      { header: 'label', get: (r) => r.label },
      { header: 'key_prefix', get: (r) => r.key_prefix },
      { header: 'created_at', get: (r) => (r.created_at as Date).toISOString() },
      { header: 'revoked_at', get: (r) => r.revoked_at ? (r.revoked_at as Date).toISOString() : '' },
    ]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="api-keys.csv"');
    return csv;
  });

  app.post<{ Params: { id: string } }>('/admin/keys/:id/revoke', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await revokeApiKey(app.pool, Number(req.params.id));
    return reply.redirect('/admin/keys');
  });

  app.get('/admin/audit', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['userEmail', 'status', 'ipText'],
      sort: ['id', 'ts'],
    });
    let userId: number | undefined;
    if (q.filters.userEmail) {
      const u = await findUserByEmail(app.pool, q.filters.userEmail);
      // Sentinel -1 (no user has this id) forces zero rows when the email
      // doesn't resolve — listQueryLogs filters on user_id !== undefined.
      userId = u ? u.id : -1;
    }
    const status = q.filters.status as 'hit' | 'miss' | 'invalid' | undefined;
    const limit = q.limit;
    const offset = (q.page - 1) * limit;
    const sort = q.sort ? { col: q.sort.col as 'id' | 'ts', dir: q.sort.dir } : undefined;
    const { rows, total } = await listQueryLogs(app.pool, {
      offset, limit, userId, status, ipText: q.filters.ipText, sort,
    });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    // Build a queryString that preserves filter+sort state for pagination
    // links, mirroring the Task 8 keys.hbs pattern.
    const queryParts: string[] = [];
    if (q.filters.userEmail) queryParts.push(`userEmail=${encodeURIComponent(q.filters.userEmail)}`);
    if (q.filters.status) queryParts.push(`status=${encodeURIComponent(q.filters.status)}`);
    if (q.filters.ipText) queryParts.push(`ipText=${encodeURIComponent(q.filters.ipText)}`);
    if (q.sort) queryParts.push(`sort=${q.sort.dir === 'desc' ? '-' : ''}${q.sort.col}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/audit.hbs', {
      layout: 'layouts/admin', title: req.t('admin.audit.title'),
      rows, page: q.page, totalPages, queryString,
      filters: q.filters, sort: q.sort, req, csrfToken: req.csrfToken,
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

  app.get('/admin/audit-log', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['action', 'actor', 'target_type', 'since', 'until'],
      sort: ['id', 'created_at'],
    });
    const opts: Parameters<typeof listAuditLog>[1] = {
      offset: (q.page - 1) * q.limit, limit: q.limit,
    };
    if (q.filters.action) opts.action = q.filters.action;
    if (q.filters.target_type) opts.targetType = q.filters.target_type;
    if (q.filters.since) opts.since = new Date(q.filters.since);
    if (q.filters.until) opts.until = new Date(q.filters.until);
    if (q.filters.actor) {
      const u = await findUserByEmail(app.pool, q.filters.actor);
      // Sentinel -1 (no user has this id) forces zero rows when the email
      // doesn't resolve — listAuditLog filters on actor_user_id !== undefined.
      opts.actorUserId = u ? u.id : -1;
    }
    if (q.sort) opts.sort = { col: q.sort.col as 'id' | 'created_at', dir: q.sort.dir };
    const { rows, total } = await listAuditLog(app.pool, opts);
    const totalPages = Math.max(1, Math.ceil(total / q.limit));
    // Build a queryString that preserves filter+sort state for pagination
    // links, mirroring the Task 8/9 pattern.
    const queryParts: string[] = [];
    if (q.filters.action) queryParts.push(`action=${encodeURIComponent(q.filters.action)}`);
    if (q.filters.actor) queryParts.push(`actor=${encodeURIComponent(q.filters.actor)}`);
    if (q.filters.target_type) queryParts.push(`target_type=${encodeURIComponent(q.filters.target_type)}`);
    if (q.filters.since) queryParts.push(`since=${encodeURIComponent(q.filters.since)}`);
    if (q.filters.until) queryParts.push(`until=${encodeURIComponent(q.filters.until)}`);
    if (q.sort) queryParts.push(`sort=${q.sort.dir === 'desc' ? '-' : ''}${q.sort.col}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/audit-log.hbs', {
      layout: 'layouts/admin', title: req.t('admin.auditLog.title'),
      rows, page: q.page, totalPages, queryString,
      filters: q.filters, sort: q.sort, req, csrfToken: req.csrfToken,
    });
  });

  app.get('/admin/audit-log.csv', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['action', 'actor', 'target_type', 'since', 'until'],
      sort: ['id', 'created_at'],
    });
    const opts: Parameters<typeof listAuditLog>[1] = {
      offset: 0, limit: 1_000_000,
    };
    if (q.filters.action) opts.action = q.filters.action;
    if (q.filters.target_type) opts.targetType = q.filters.target_type;
    if (q.filters.since) opts.since = new Date(q.filters.since);
    if (q.filters.until) opts.until = new Date(q.filters.until);
    if (q.filters.actor) {
      const u = await findUserByEmail(app.pool, q.filters.actor);
      opts.actorUserId = u ? u.id : -1;
    }
    if (q.sort) opts.sort = { col: q.sort.col as 'id' | 'created_at', dir: q.sort.dir };
    const { rows } = await listAuditLog(app.pool, opts);
    const csv = withBom(csvForRows(rows as unknown as RowDataPacket[], [
      { header: 'id', get: (r) => r.id },
      { header: 'created_at', get: (r) => (r.created_at as Date).toISOString() },
      { header: 'actor_email', get: (r) => r.actor_email },
      { header: 'action', get: (r) => r.action },
      { header: 'target_type', get: (r) => r.target_type ?? '' },
      { header: 'target_id', get: (r) => r.target_id ?? '' },
      { header: 'ip', get: (r) => r.ip ?? '' },
    ]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
    return csv;
  });

  app.get('/admin/queries', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['since', 'until'], sort: [],
    });
    const opts: Parameters<typeof getQueryStats>[1] = {};
    if (q.filters.since) opts.since = new Date(q.filters.since);
    if (q.filters.until) opts.until = new Date(q.filters.until);
    const stats = await getQueryStats(app.pool, opts);
    const hitRate = stats.total > 0 ? stats.byStatus.hit / stats.total : 0;
    const queryParts: string[] = [];
    if (q.filters.since) queryParts.push(`since=${encodeURIComponent(q.filters.since)}`);
    if (q.filters.until) queryParts.push(`until=${encodeURIComponent(q.filters.until)}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/queries.hbs', {
      layout: 'layouts/admin', title: req.t('admin.queries.title'),
      stats, hitRate, filters: q.filters, queryString, req, csrfToken: req.csrfToken,
    });
  });

  app.get('/admin/queries.csv', async (req, reply) => {
    const q = parseListQuery(req.url.split('?')[1] ?? '', {
      filters: ['since', 'until'], sort: [],
    });
    const where: string[] = []; const params: unknown[] = [];
    if (q.filters.since) { where.push('q.ts >= ?'); params.push(new Date(q.filters.since)); }
    if (q.filters.until) { where.push('q.ts <= ?'); params.push(new Date(q.filters.until)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT q.ts, q.ip_text, q.status, u.email AS user_email
         FROM query_log q
         LEFT JOIN users u ON u.id = q.user_id
         ${whereSql}
         ORDER BY q.ts DESC`,
      params,
    );
    const csv = withBom(csvForRows(rows as RowDataPacket[], [
      { header: 'ts', get: (r) => (r.ts as Date).toISOString() },
      { header: 'ip_text', get: (r) => r.ip_text },
      { header: 'status', get: (r) => r.status },
      { header: 'user_email', get: (r) => r.user_email ?? '' },
    ]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="queries.csv"');
    return csv;
  });
}
