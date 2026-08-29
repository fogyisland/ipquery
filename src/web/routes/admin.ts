// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { findUserById, setDisabled, markEmailVerified, deleteUser, updatePassword, findUserByEmail } from '../../storage/users';
import { hashPassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';
import { runPipeline } from '../../etl/pipeline';
import { topByQueryCount, queueStats } from '../../storage/unknownIpQueue';
import { runBackfill, buildDefaultProviders } from '../../etl/unknownIpBackfill';
import { runRandomGeneration } from '../../etl/randomIpGenerator';
import { listProviderConfigs, updateProviderConfig, buildProvidersFromConfig } from '../../storage/ingestProviders';
import { listAllApiKeys, revokeApiKey } from '../../storage/apiKeys';
import { listQueryLogs, streamQueryLogsCsv } from '../../storage/queryLog';
import { listAuditLog } from '../../storage/auditLog';
import { getOverview } from '../admin/overview';
import { getQueryStats } from '../admin/queries';
import { parseListQuery } from '../admin/queryString';
import { csvForRows, withBom } from '../admin/csv';
import { lastEtlRun } from '../../storage/mysql';
import type { EtlRun } from '../../types';

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
    req.auditAction = { action: 'user.verify_email', targetType: 'user', targetId: Number(req.params.id) };
    await markEmailVerified(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-password', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    req.auditAction = { action: 'user.reset_password', targetType: 'user', targetId: Number(req.params.id) };
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
    req.auditAction = { action: 'user.delete', targetType: 'user', targetId: Number(req.params.id) };
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
    req.auditAction = { action: 'etl.trigger', targetType: 'etl_run' };
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
    req.auditAction = { action: 'key.revoke', targetType: 'api_key', targetId: Number(req.params.id) };
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

  app.get('/admin/settings', async (req, reply) => {
    const cfg = app.cfg;
    // Secrets (db.password, web.sessionSecret, web.csrfSecret, smtp.pass,
    // maxmind.licenseKey) are passed RAW to the template so the eye-icon
    // reveal can swap them client-side from the data-secret attribute.
    // Security model: this page is gated by the admin auth guard; only an
    // authenticated admin session reaches this handler, and the page is
    // served over the same HTTPS-else-cookieSecure-locked connection that
    // already protects the rest of the admin console. If you're worried
    // about DOM-level exposure (e.g. a logged-in admin walks away from an
    // unlocked machine) the data-secret attribute still masks the value
    // until the admin explicitly clicks the eye — it's not plaintext
    // innerText by default. The previous version of this code used
    // redactSecret() which kept secrets out of the DOM entirely but
    // didn't allow reveal at all; the trade-off was discussed and the
    // reveal UX was preferred.
    const display = {
      db: {
        host: cfg.db.host,
        port: cfg.db.port,
        database: cfg.db.database,
        user: cfg.db.user,
        poolSize: cfg.db.poolSize,
        password: cfg.db.password || '',
      },
      api: { port: cfg.api.port, rateLimit: cfg.api.rateLimit },
      etl: { schedule: cfg.etl.schedule, timezone: cfg.etl.timezone, dataDir: cfg.etl.dataDir },
      web: {
        baseUrl: cfg.web.baseUrl,
        cookieDomain: cfg.web.cookieDomain,
        cookieSecure: cfg.web.cookieSecure,
        sessionTtlHours: cfg.web.sessionTtlHours,
        sessionSecret: cfg.web.sessionSecret || '',
        csrfSecret: cfg.web.csrfSecret || '',
      },
      smtp: {
        host: cfg.smtp.host || '(console)',
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        user: cfg.smtp.user,
        pass: cfg.smtp.pass || '',
        from: cfg.smtp.from,
      },
      security: { ...cfg.security },
      maxmind: {
        licenseKey: cfg.maxmind.licenseKey || '',
        editions: cfg.maxmind.editions,
      },
    };
    let pool: Record<string, string> = {};
    let etlLastRun: EtlRun | null = null;
    try {
      const [poolRows] = await app.pool.query<RowDataPacket[]>(
        'SHOW STATUS WHERE Variable_name IN (?, ?)',
        ['Threads_connected', 'Max_used_connections'],
      );
      pool = Object.fromEntries(
        (poolRows as unknown as { Variable_name: string; Value: string }[])
          .map((r) => [r.Variable_name, r.Value]),
      );
    } catch (err) {
      // Pool status is informational; do not fail the page render.
      app.log.warn({ err }, 'failed to read DB pool status');
    }
    try {
      etlLastRun = await lastEtlRun(app.pool);
    } catch (err) {
      // ETL run history is informational; never fail the page on it.
      app.log.warn({ err }, 'failed to read last ETL run');
    }
    // Pre-resolve the ETL status pill text + kind so the template doesn't
    // need to call req.t with hash arguments. See project memory note
    // about {{req.t key a=b}} never passing hash args through.
    let etlStatusKind: 'success' | 'danger' | 'warning' | 'muted' = 'muted';
    let etlStatusText = req.t('admin.settings.etl.lastRunNever');
    if (etlLastRun) {
      if (etlLastRun.status === 'success') {
        etlStatusKind = 'success';
        etlStatusText = req.t('admin.settings.etl.lastRunOk', { merged: etlLastRun.mergedRecords ?? 0 });
      } else if (etlLastRun.status === 'failed') {
        etlStatusKind = 'danger';
        etlStatusText = req.t('admin.settings.etl.lastRunFailed');
      } else {
        // 'running' or any future state — pending is the closest analog.
        etlStatusKind = 'warning';
        etlStatusText = req.t('admin.settings.etl.lastRunRunning');
      }
    }
    return reply.view('admin/settings.hbs', {
      layout: 'layouts/admin',
      title: req.t('admin.settings.title'),
      config: display,
      pool,
      etlLastRun,
      etlStatusKind,
      etlStatusText,
      req,
      csrfToken: req.csrfToken,
    });
  });

  app.post('/admin/settings/etl-restart', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    req.auditAction = { action: 'etl.restart', targetType: 'etl_run' };
    void runPipeline({ cfg: app.cfg }).catch((err) => app.log.error({ err }, 'manual ETL restart failed'));
    // Redirect back to the Integrations tab so the admin sees the
    // refreshed "last run" pill after the redirect.
    return reply.redirect('/admin/settings#integrations');
  });

  // ─── Unknown IP backfill ────────────────────────────────────────────────
  // /admin/unknown-ips shows the queue (pending + recently-processed). The
  // POST handler drains a batch via external IP geo providers + majority
  // vote, then redirects back with a summary flash. Provider keys are read
  // from env at request time so admin can rotate them without a restart.
  app.get('/admin/unknown-ips', async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50) || 50, 200);
    const [data, stats, providers] = await Promise.all([
      topByQueryCount(app.pool, limit),
      queueStats(app.pool),
      listProviderConfigs(app.pool),
    ]);
    const { readRandomGenState } = await import('../../web/plugins/randomIpGeneratorRunner');
    const randomGenState = await readRandomGenState(app.pool);
    // Consume short-lived flash cookies set by POST handlers. Both
    // backfill and random-gen POST routes set JSON cookies on the
    // redirect; we decode them once here and clear them so the banner
    // doesn't reappear on subsequent refreshes. Invalid JSON is
    // treated as no flash (cookie set by older builds before schema
    // changes, or tampered).
    const flash: Record<string, unknown> = {};
    const backfillCookie = req.cookies['backfill_summary'];
    if (backfillCookie) {
      try { flash.backfillSummary = JSON.parse(backfillCookie); } catch { /* ignore */ }
      reply.clearCookie('backfill_summary', { path: '/admin/unknown-ips' });
    }
    const generateCookie = req.cookies['generate_summary'];
    if (generateCookie) {
      try { flash.generateSummary = JSON.parse(generateCookie); } catch { /* ignore */ }
      reply.clearCookie('generate_summary', { path: '/admin/unknown-ips' });
    }
    return reply.view('admin/unknown-ips.hbs', {
      layout: 'layouts/admin',
      title: req.t('admin.unknownIps.title'),
      pending: data.pending,
      recentlyProcessed: data.recentlyProcessed,
      stats,
      providers,
      flash,
      randomGenState,
      limit,
      csrfToken: req.csrfToken,
      req,
    });
  });

  // Toggle provider on/off and rotate api_key from the admin UI. POST
  // accepts `name`, optional `enabled` ("on"/"off"), optional `apiKey`.
  // Only enabled / api_key are editable from here; the catalog (display
  // name + free quota) is code-managed.
  app.post<{ Params: { name: string } }>('/admin/unknown-ips/providers/:name', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const name = req.params.name;
    const body = req.body as { enabled?: string; apiKey?: string };
    req.auditAction = {
      action: 'unknown_ips.provider.update',
      targetType: 'ingest_provider',
      targetId: name,
      metadata: { enabled: body.enabled, hasKey: Boolean(body.apiKey && body.apiKey.length > 0) },
    };
    await updateProviderConfig(app.pool, name, {
      enabled: body.enabled === 'on',
      apiKey: body.apiKey === undefined ? undefined : (body.apiKey.trim() === '' ? null : body.apiKey.trim()),
    });
    return reply.redirect('/admin/unknown-ips');
  });

  app.get('/admin/unknown-ips/backfill/confirm', async (req, reply) => {
    return reply.view('admin/unknown-ips-backfill-confirm.hbs', {
      layout: 'layouts/admin',
      title: req.t('admin.unknownIps.backfill.confirm.title'),
      req,
    });
  });

  app.post('/admin/unknown-ips/backfill', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    req.auditAction = { action: 'unknown_ips.backfill', targetType: 'unknown_ip_queue' };

    // Build providers from the admin-managed DB config so toggling a
    // provider or rotating its key takes effect on the very next run.
    // buildDefaultProviders() is still available as the env-driven
    // fallback for non-admin callers (CLI / cron).
    const configs = await listProviderConfigs(app.pool);
    const providers = buildProvidersFromConfig(configs);
    const summary = await runBackfill(app.pool, providers, {
      batchLimit: Number((req.body as { batchLimit?: number }).batchLimit ?? 100) || 100,
      logger: { log: () => {}, warn: (msg) => app.log.warn({ msg }, 'backfill'), error: (msg) => app.log.error({ msg }, 'backfill') },
    });
    // Redirect back with summary in flash cookie. Cookie is HTTP-only and
    // max-age=30s — admin refreshes the page and sees the banner once.
    reply.setCookie('backfill_summary', JSON.stringify(summary), {
      path: '/admin/unknown-ips',
      maxAge: 30,
      httpOnly: true,
      sameSite: 'lax',
    });
    return reply.redirect('/admin/unknown-ips');
  });

  // "Generate 10 random IPs and ingest them". Used to validate the
  // ingest pipeline end-to-end without waiting for real /lookup misses
  // to trickle in. Auto-disables providers that return HTTP 429 during
  // the run so we don't keep hammering a throttled provider. Target:
  // 10 IPs in 10 minutes (per-IP fan-out ~8s serial = ~80s for 10).
  app.post('/admin/unknown-ips/generate', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    req.auditAction = { action: 'unknown_ips.generate', targetType: 'unknown_ip_queue' };

    const body = req.body as { count?: number };
    const count = Math.min(Math.max(Number(body.count) || 10, 1), 50);
    const configs = await listProviderConfigs(app.pool);
    const providers = buildProvidersFromConfig(configs);
    const summary = await runRandomGeneration(app.pool, providers, {
      count,
      logger: { log: () => {}, warn: (msg) => app.log.warn({ msg }, 'random-gen'), error: (msg) => app.log.error({ msg }, 'random-gen') },
    });
    reply.setCookie('generate_summary', JSON.stringify(summary), {
      path: '/admin/unknown-ips',
      maxAge: 60,
      httpOnly: true,
      sameSite: 'lax',
    });
    return reply.redirect('/admin/unknown-ips');
  });

  // Continuous runner toggle + manual kick. The runner is a separate
  // setInterval-based plugin (see registerRandomGenRunner) that fires
  // every 60s when the persisted `random_gen_enabled` setting is '1'.
  // POST accepts `enabled=on|off` to flip the setting (and start/stop
  // the timer immediately) and `kick=1` to run an out-of-band tick.
  app.post('/admin/unknown-ips/generate/continuous', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    req.auditAction = { action: 'unknown_ips.generate.continuous', targetType: 'settings' };
    const body = req.body as { enabled?: string; kick?: string };
    const { setSetting } = await import('../../storage/settings');
    if (body.kick === '1') {
      // Manual kick — fire-and-forget but wait briefly so the next
      // GET sees the updated lastSummary. tickNow already logs and
      // persists on its own; we just await so the redirect lands
      // after the write.
      await app.randomGenRunner.tickNow();
    } else if (body.enabled === 'on' || body.enabled === 'off') {
      await setSetting(app.pool, 'random_gen_enabled', body.enabled === 'on' ? '1' : '0');
      await app.randomGenRunner.syncFromSettings();
    }
    return reply.redirect('/admin/unknown-ips');
  });
}
