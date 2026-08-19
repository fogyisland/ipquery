# Admin Tool-Style Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the IPQuery web frontend as a tool-style site (left sidebar + data tables) with new admin Dashboard overview, operation log, query volume stats, system settings panel, and enhanced data-table filtering/sorting/CSV export.

**Architecture:** Same Fastify SSR stack. New `admin_audit_log` table + `src/web/plugins/auditLog.ts` middleware captures admin POSTs asynchronously. `src/web/admin/queryString.ts` parses filter/sort querystrings. CSS adds design tokens + new utility classes; no new deps. SVG sparklines inline (zero chart dep). htmx 30s refresh on Dashboard only.

**Tech Stack:** Fastify 4, Handlebars, htmx, MySQL 8, vitest, supertest, mysql2, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-admin-tool-redesign.md`

## Global Constraints

- Node ≥ 20.0.0 (already enforced).
- `npx tsc --noEmit` clean after every task.
- `npm test` green: 180/180 baseline → ~195/195 after plan.
- Zero new dependencies.
- All files end with LF newline.
- i18n: every new user-visible string added to both `zh-CN.json` and `en-US.json` (English placeholder OK).
- Existing functionality preserved; only enhance / extend.
- Tailwind, React, Vue, Chart.js, uPlot: NOT introduced.
- Reuse existing helpers: `csvForRows`, `redactSecret`, `loadConfig`, `configSummary`, `requireAdmin`, `verifyCsrfRequest`.
- Operations log writes are async + non-blocking; DB write failure logs to pino but does NOT fail the response.

---

## File map (locked in by spec §11; tasks reference these)

**New files:**
- `src/storage/migrations/010_admin_audit_log.sql`
- `src/storage/auditLog.ts` — `recordAuditLog(pool, entry)` + `listAuditLog(pool, opts)`
- `src/web/plugins/auditLog.ts` — `registerAuditLog(app)` + `req.auditAction` decorator
- `src/web/admin/queryString.ts` — `parseListQuery(rawQs, whitelist): { filters, sort, page, limit, ids }`
- `src/web/admin/overview.ts` — `getOverview(pool): Promise<Overview>`
- `src/web/admin/queries.ts` — `getQueryStats(pool, opts): Promise<QueryStats>`
- `src/web/admin/csv.ts` — `csvForRows(rows, columns): string` + `withBom(s)`
- `src/web/views/partials/sidebar.hbs` (replaces nav.hbs)
- `src/web/views/layouts/app.hbs` (new minimal layout)
- `src/web/views/admin/dashboard.hbs`
- `src/web/views/admin/queries.hbs`
- `src/web/views/admin/audit-log.hbs`
- `src/web/views/admin/settings.hbs`
- `src/web/views/admin/users-list.hbs` (replaces user-list.hbs)
- `src/web/views/home.hbs` (replaces marketing/home.hbs)
- `src/web/views/docs.hbs` (replaces marketing/docs.hbs)
- `src/web/views/partials/sparkline.hbs`
- `src/web/views/partials/filter-bar.hbs`
- `src/web/views/partials/pill.hbs`
- `test/integration/admin.dashboard.test.ts`
- `test/integration/admin.users.enhanced.test.ts`
- `test/integration/admin.etl.enhanced.test.ts`
- `test/integration/admin.keys.enhanced.test.ts`
- `test/integration/admin.auditlog.test.ts`
- `test/integration/admin.queries.test.ts`
- `test/integration/admin.settings.test.ts`
- `test/integration/auditLog.plugin.test.ts`
- `test/integration/queryString.test.ts`
- `test/integration/home.test.ts`
- `test/integration/docs.test.ts`

**Modified files:**
- `src/web/routes/admin.ts` — add dashboard/queries/audit-log/settings routes; bulk handler; CSV handlers; per-handler `req.auditAction`
- `src/web/routes/marketing.ts` — drop `/pricing`; rewrite `/` → home; rewrite `/docs`
- `src/web/views/admin/user-detail.hbs` — add back-link to new users-list
- `src/web/views/admin/etl-runs.hbs` — filter bar + CSV link
- `src/web/views/admin/keys.hbs` — filter bar + CSV link
- `src/web/views/admin/audit.hbs` — filter bar
- `src/web/assets/style.css` — design tokens + components
- `src/api/server.ts` — register auditLog plugin
- `src/storage/migrations/runner.ts` — already discovers `010_*.sql` automatically (verify in Task 1)
- `src/web/i18n/zh-CN.json`, `src/web/i18n/en-US.json` — new keys
- `README.md` — update Web Frontend section

**Deleted files:**
- `src/web/views/marketing/home.hbs` → moved to `src/web/views/home.hbs`
- `src/web/views/marketing/docs.hbs` → moved to `src/web/views/docs.hbs`
- `src/web/views/marketing/pricing.hbs` → DELETED
- `src/web/views/partials/nav.hbs` → replaced by `partials/sidebar.hbs`

---

## Task ordering

Tasks 1–3 are foundation (migration + plugins + parser), safe to do first.
Tasks 4–11 are admin pages; order minimizes cross-task dependencies.
Task 12 instruments admin POSTs into audit log (needs admin.ts from earlier tasks).
Task 13 frontend redesign.
Task 14 dashboard sidebar unification.
Task 15 final tests + README + commit.

---

### Task 1: Migration 010 — `admin_audit_log` table + storage helper

**Files:**
- Create: `src/storage/migrations/010_admin_audit_log.sql`
- Create: `src/storage/auditLog.ts`
- Test: `test/integration/auditlog-storage.test.ts`

**Interfaces:**
- Consumes: existing `mysql2/promise` Pool, `RowDataPacket`, `ResultSetHeader`
- Produces: `recordAuditLog(pool, entry): Promise<void>` and `listAuditLog(pool, opts): Promise<{ rows: AuditLogEntry[]; total: number }>`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/auditlog-storage.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { recordAuditLog, listAuditLog } from '../../src/storage/auditLog';

let td: TestDb;

beforeAll(async () => { td = await createTestDb('auditlog'); });
afterAll(async () => { await dropTestDb(td); });

describe('admin_audit_log storage', () => {
  it('records and lists entries', async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: 'admin@x' },
      action: 'user.delete',
      targetType: 'user', targetId: 42,
      metadata: { ip: '8.8.8.8' },
      ip: '1.1.1.1', userAgent: 'curl/8', statusCode: 302,
    });
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: 'admin@x' },
      action: 'user.reset_password',
      metadata: null, ip: '1.1.1.1', userAgent: 'curl/8', statusCode: 200,
    });
    const { rows, total } = await listAuditLog(td.pool, { offset: 0, limit: 10 });
    expect(total).toBe(2);
    expect(rows[0].action).toBe('user.reset_password');  // newest first
    expect(rows[1].action).toBe('user.delete');
    expect(rows[1].target_type).toBe('user');
    expect(rows[1].target_id).toBe(42);
  });

  it('filters by action', async () => {
    const { rows, total } = await listAuditLog(td.pool, { offset: 0, limit: 10, action: 'user.delete' });
    expect(total).toBe(1);
    expect(rows[0].action).toBe('user.delete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/auditlog-storage.test.ts`
Expected: FAIL — `auditLog.ts` module not found.

- [ ] **Step 3: Write migration SQL**

```sql
-- src/storage/migrations/010_admin_audit_log.sql
-- SPDX-License-Identifier: MIT
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  actor_email VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NULL,
  target_id BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  status_code SMALLINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_actor_created (actor_user_id, created_at),
  INDEX idx_target (target_type, target_id),
  INDEX idx_action_created (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Write storage helper**

```ts
// src/storage/auditLog.ts
// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface AuditLogEntry {
  id: number;
  actor_user_id: number;
  actor_email: string;
  action: string;
  target_type: string | null;
  target_id: number | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  status_code: number | null;
  created_at: Date;
}

export interface AuditLogInput {
  actor: { id: number; email: string } | null;
  action: string;
  targetType?: string;
  targetId?: number | string;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  statusCode?: number;
}

export async function recordAuditLog(pool: Pool, input: AuditLogInput): Promise<void> {
  const actor = input.actor ?? { id: 0, email: '(system)' };
  await pool.query<ResultSetHeader>(
    `INSERT INTO admin_audit_log
       (actor_user_id, actor_email, action, target_type, target_id, metadata, ip, user_agent, status_code)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      actor.id, actor.email, input.action,
      input.targetType ?? null,
      input.targetId == null ? null : Number(input.targetId),
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ip ?? null, input.userAgent ?? null, input.statusCode ?? null,
    ],
  );
}

export async function listAuditLog(pool: Pool, opts: {
  offset: number; limit: number;
  actorUserId?: number; action?: string; targetType?: string;
  since?: Date; until?: Date;
}): Promise<{ rows: AuditLogEntry[]; total: number }> {
  const where: string[] = []; const params: unknown[] = [];
  if (opts.actorUserId !== undefined) { where.push('actor_user_id = ?'); params.push(opts.actorUserId); }
  if (opts.action) { where.push('action = ?'); params.push(opts.action); }
  if (opts.targetType) { where.push('target_type = ?'); params.push(opts.targetType); }
  if (opts.since) { where.push('created_at >= ?'); params.push(opts.since); }
  if (opts.until) { where.push('created_at <= ?'); params.push(opts.until); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM admin_audit_log ${whereSql}`, params,
  );
  const total = Number((totalRows[0] as { c: number }).c);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM admin_audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: Number(r.id), actor_user_id: Number(r.actor_user_id), actor_email: r.actor_email as string,
      action: r.action as string, target_type: (r.target_type ?? null) as string | null,
      target_id: r.target_id == null ? null : Number(r.target_id),
      metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
      ip: (r.ip ?? null) as string | null, user_agent: (r.user_agent ?? null) as string | null,
      status_code: r.status_code == null ? null : Number(r.status_code),
      created_at: r.created_at as Date,
    })),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/integration/auditlog-storage.test.ts`
Expected: PASS (2 tests). `createTestDb` runs `runMigrations`, which auto-discovers `010_*.sql`.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/010_admin_audit_log.sql src/storage/auditLog.ts test/integration/auditlog-storage.test.ts
git commit -m "feat(storage): admin_audit_log migration + storage helper"
```

---

### Task 2: Audit log Fastify plugin

**Files:**
- Create: `src/web/plugins/auditLog.ts`
- Modify: `src/api/server.ts:1-83` (register plugin, expose helper)
- Test: `test/integration/auditlog-plugin.test.ts`

**Interfaces:**
- Consumes: `recordAuditLog` from Task 1; `app.pool`, `app.log`
- Produces: `registerAuditLog(app): void`; decorates `req.auditAction`; installs `onResponse` hook that auto-writes when `req.auditAction` is set + response < 400.

- [ ] **Step 1: Write failing test**

```ts
// test/integration/auditlog-plugin.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let td: TestDb; let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb('auditlog-plugin');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('auditLog plugin', () => {
  it('writes an audit entry when handler sets req.auditAction', async () => {
    app.get('/_test/audit', async (req, reply) => {
      req.auditAction = { action: 'test.ping', targetType: 'x', targetId: 1 };
      return reply.send({ ok: true });
    });
    await app.ready();
    await request(app.server).get('/_test/audit');
    // Allow async hook to flush (best-effort)
    await new Promise((r) => setTimeout(r, 50));
    const [rows] = await td.pool.query('SELECT * FROM admin_audit_log');
    const found = (rows as { action: string }[]).find((r) => r.action === 'test.ping');
    expect(found).toBeDefined();
  });

  it('does NOT write when response >= 400', async () => {
    app.get('/_test/audit-err', async (req, reply) => {
      req.auditAction = { action: 'test.should-not-log' };
      return reply.code(500).send({ err: true });
    });
    await app.ready();
    await request(app.server).get('/_test/audit-err');
    await new Promise((r) => setTimeout(r, 50));
    const [rows] = await td.pool.query("SELECT * FROM admin_audit_log WHERE action = 'test.should-not-log'");
    expect((rows as unknown[]).length).toBe(0);
  });

  it('does NOT write when req.auditAction not set', async () => {
    const before = await td.pool.query('SELECT COUNT(*) AS c FROM admin_audit_log');
    const beforeN = Number((before[0] as { c: number }[])[0].c);
    app.get('/_test/no-audit', async (_req, reply) => reply.send({ ok: true }));
    await app.ready();
    await request(app.server).get('/_test/no-audit');
    await new Promise((r) => setTimeout(r, 50));
    const after = await td.pool.query('SELECT COUNT(*) AS c FROM admin_audit_log');
    const afterN = Number((after[0] as { c: number }[])[0].c);
    expect(afterN).toBe(beforeN);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/auditlog-plugin.test.ts`
Expected: FAIL — `src/web/plugins/auditLog.ts` not found.

- [ ] **Step 3: Write plugin**

```ts
// src/web/plugins/auditLog.ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAuditLog } from '../../storage/auditLog';

declare module 'fastify' {
  interface FastifyRequest {
    auditAction?: {
      action: string;
      targetType?: string;
      targetId?: number | string;
      metadata?: Record<string, unknown>;
    };
  }
}

export function registerAuditLog(app: FastifyInstance): void {
  app.decorateRequest('auditAction', null as FastifyRequest['auditAction']);

  app.addHook('onResponse', async (req, reply) => {
    const audit = req.auditAction;
    if (!audit) return;
    if (reply.statusCode >= 400) return;
    const user = (req as FastifyRequest & { user?: { id: number; email: string } | null }).user ?? null;
    try {
      await recordAuditLog(app.pool, {
        actor: user ? { id: user.id, email: user.email } : null,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        metadata: audit.metadata ?? null,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        statusCode: reply.statusCode,
      });
    } catch (err) {
      app.log.error({ err }, 'audit log write failed');
    }
  });
}
```

- [ ] **Step 4: Wire into server.ts**

In `src/api/server.ts`, add the import + call after the other plugin registrations (after line 70, before `extraRoutes`):

```ts
import { registerAuditLog } from '../web/plugins/auditLog';
// ...inside buildServer, after adminRoute register:
registerAuditLog(app);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/integration/auditlog-plugin.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/web/plugins/auditLog.ts src/api/server.ts test/integration/auditlog-plugin.test.ts
git commit -m "feat(audit): auditLog plugin (req.auditAction + onResponse hook)"
```

---

### Task 3: Query string filter/sort parser

**Files:**
- Create: `src/web/admin/queryString.ts`
- Test: `test/integration/queryString.test.ts`

**Interfaces:**
- Produces: `parseListQuery(qs, fields): { filters: Record<string, string>; sort: { col: string; dir: 'asc'|'desc' } | null; page: number; limit: number; ids: number[] }`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/queryString.test.ts
import { describe, it, expect } from 'vitest';
import { parseListQuery } from '../../src/web/admin/queryString';

describe('parseListQuery', () => {
  it('parses filters, sort, page, limit, ids', () => {
    const r = parseListQuery(
      'role=admin&disabled=0&since=2026-01-01&sort=-created_at&page=2&limit=50&ids=1,2,3',
      { filters: ['role', 'disabled', 'since'], sort: ['created_at', 'id'] },
    );
    expect(r.filters.role).toBe('admin');
    expect(r.filters.disabled).toBe('0');
    expect(r.filters.since).toBe('2026-01-01');
    expect(r.sort).toEqual({ col: 'created_at', dir: 'desc' });
    expect(r.page).toBe(2);
    expect(r.limit).toBe(50);
    expect(r.ids).toEqual([1, 2, 3]);
  });

  it('rejects unknown filter and sort columns', () => {
    const r = parseListQuery('evil=1&sort=password', { filters: ['role'], sort: ['id'] });
    expect(r.filters.evil).toBeUndefined();
    expect(r.sort).toBeNull();
  });

  it('clamps limit to max 200, defaults page=1 limit=25', () => {
    const r = parseListQuery('limit=99999&page=-5', { filters: [], sort: ['id'] });
    expect(r.limit).toBe(200);
    expect(r.page).toBe(1);
  });

  it('omits empty filters from result', () => {
    const r = parseListQuery('role=admin&disabled=', { filters: ['role', 'disabled'] });
    expect(r.filters.role).toBe('admin');
    expect('disabled' in r.filters).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/queryString.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write parser**

```ts
// src/web/admin/queryString.ts
// SPDX-License-Identifier: MIT
export interface ListQueryFields {
  filters: readonly string[];
  sort: readonly string[];
}

export interface ParsedListQuery {
  filters: Record<string, string>;
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  page: number;
  limit: number;
  ids: number[];
}

const MAX_LIMIT = 200;

export function parseListQuery(rawQs: string, fields: ListQueryFields): ParsedListQuery {
  const params = new URLSearchParams(rawQs);
  const filters: Record<string, string> = {};
  for (const f of fields.filters) {
    const v = params.get(f);
    if (v != null && v !== '') filters[f] = v;
  }

  let sort: ParsedListQuery['sort'] = null;
  const s = params.get('sort');
  if (s) {
    const desc = s.startsWith('-');
    const col = desc ? s.slice(1) : s;
    if (fields.sort.includes(col)) sort = { col, dir: desc ? 'desc' : 'asc' };
  }

  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || 25));

  const idsParam = params.get('ids');
  const ids = idsParam
    ? idsParam.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  return { filters, sort, page, limit, ids };
}

export function appendQueryString(existing: string, key: string, value: string): string {
  const sep = existing ? '&' : '';
  return `${existing}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/integration/queryString.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/admin/queryString.ts test/integration/queryString.test.ts
git commit -m "feat(admin): query string filter/sort parser"
```

---

### Task 4: Sidebar partial + design tokens + base components

**Files:**
- Create: `src/web/views/partials/sidebar.hbs`
- Modify: `src/web/assets/style.css` (add design tokens + components)
- Create: `src/web/views/partials/sparkline.hbs`
- Create: `src/web/views/partials/filter-bar.hbs`
- Create: `src/web/views/partials/pill.hbs`
- Create: `src/web/views/layouts/app.hbs`
- Test: `test/integration/sidebar.test.ts` (renders for admin/dashboard/marketing)

**Interfaces:**
- Consumes: `req.t`, `req.user`, `req.session` (already in scope from Task 9)
- Produces: a reusable sidebar partial; `layouts/app.hbs` mirrors `layouts/admin.hbs` shape but for non-admin pages

- [ ] **Step 1: Write failing test**

```ts
// test/integration/sidebar.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let td: TestDb; let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb('sidebar');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('sidebar layout', () => {
  it('renders on /', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/\/try/);
  });
  it('renders on /login', async () => {
    const r = await request(app.server).get('/login');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="sidebar"/);
  });
  it('admin sidebar links appear once authenticated', async () => {
    // Use existing helper pattern from admin.users.test.ts to log in as admin
    // Then GET /admin and assert sidebar contains /admin/queries
  });
});
```

- [ ] **Step 2: Write sidebar partial**

```hbs
{{!-- src/web/views/partials/sidebar.hbs --}}
<aside class="sidebar">
  <a class="sidebar-brand" href="/">IPQuery</a>
  <nav class="sidebar-nav">
    <div class="sidebar-group">
      <div class="sidebar-group-label">{{req.t 'sidebar.group.public'}}</div>
      <a href="/" class="sidebar-link">{{req.t 'nav.home'}}</a>
      <a href="/try" class="sidebar-link">{{req.t 'nav.try'}}</a>
      <a href="/docs" class="sidebar-link">{{req.t 'nav.docs'}}</a>
      <a href="/status" class="sidebar-link">{{req.t 'nav.status'}}</a>
      <a href="/about" class="sidebar-link">{{req.t 'nav.about'}}</a>
    </div>
    {{#if req.session.userId}}
    <div class="sidebar-group">
      <div class="sidebar-group-label">{{req.t 'sidebar.group.user'}}</div>
      <a href="/dashboard" class="sidebar-link">{{req.t 'nav.dashboard'}}</a>
      <a href="/dashboard/history" class="sidebar-link">{{req.t 'nav.history'}}</a>
      <a href="/dashboard/keys" class="sidebar-link">{{req.t 'nav.apiKeys'}}</a>
      <a href="/dashboard/profile" class="sidebar-link">{{req.t 'nav.profile'}}</a>
    </div>
    {{/if}}
    {{#if (eq req.session.role 'admin')}}
    <div class="sidebar-group">
      <div class="sidebar-group-label">{{req.t 'sidebar.group.admin'}}</div>
      <a href="/admin" class="sidebar-link">{{req.t 'nav.admin.dashboard'}}</a>
      <a href="/admin/users" class="sidebar-link">{{req.t 'nav.admin.users'}}</a>
      <a href="/admin/etl/runs" class="sidebar-link">{{req.t 'nav.admin.etl'}}</a>
      <a href="/admin/queries" class="sidebar-link">{{req.t 'nav.admin.queries'}}</a>
      <a href="/admin/keys" class="sidebar-link">{{req.t 'nav.admin.keys'}}</a>
      <a href="/admin/audit" class="sidebar-link">{{req.t 'nav.admin.audit'}}</a>
      <a href="/admin/audit-log" class="sidebar-link">{{req.t 'nav.admin.auditLog'}}</a>
      <a href="/admin/settings" class="sidebar-link">{{req.t 'nav.admin.settings'}}</a>
    </div>
    {{/if}}
  </nav>
  <div class="sidebar-footer">
    {{#if req.session.userId}}
      <span class="sidebar-user">{{req.session.email}}</span>
      <form method="POST" action="/logout" class="sidebar-logout-form">
        <input type="hidden" name="csrf" value="{{@root.csrfToken}}">
        <button type="submit" class="sidebar-link sidebar-logout">{{req.t 'nav.logout'}}</button>
      </form>
    {{else}}
      <a href="/login" class="sidebar-link">{{req.t 'nav.login'}}</a>
      <a href="/signup" class="sidebar-link">{{req.t 'nav.signup'}}</a>
    {{/if}}
  </div>
</aside>
```

- [ ] **Step 3: Write new layout `layouts/app.hbs`**

```hbs
{{!-- src/web/views/layouts/app.hbs --}}
<!doctype html>
<html lang="{{req.locale}}">
<head>
  <meta charset="utf-8">
  <title>{{title}} · IPQuery</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body class="layout-app">
  <div class="app-shell">
    {{> sidebar}}
    <main class="app-main">
      <header class="app-header">
        <h1 class="app-title">{{title}}</h1>
      </header>
      <div class="app-content">
        {{{body}}}
      </div>
    </main>
  </div>
  <script src="/assets/htmx.min.js" defer></script>
</body>
</html>
```

- [ ] **Step 4: Write small partials**

```hbs
{{!-- src/web/views/partials/sparkline.hbs --}}
{{!-- expects: data (number[]), max (number), width=80, height=24 --}}
<svg class="sparkline" viewBox="0 0 {{width}} {{height}}" width="{{width}}" height="{{height}}" preserveAspectRatio="none">
  {{#if (gt max 0)}}
    {{#each data}}
      {{!-- Render polyline client-side via small inline JS, OR precompute path --}}
    {{/each}}
  {{else}}
    <line x1="0" y1="{{div height 2}}" x2="{{width}}" y2="{{div height 2}}" stroke="#e5e7eb"/>
  {{/if}}
</svg>
<script>(function(d,m,w,h){var v=d.map(function(x,i){return [i*(w/(d.length-1||1)),h-(x/m)*h*(0.85)+h*0.075];});var p=v.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' ');var svg=document.currentScript.parentNode;var path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',p);path.setAttribute('fill','none');path.setAttribute('stroke','#2563eb');path.setAttribute('stroke-width','1.5');svg.appendChild(path);})({{{json data}}},{{max}},{{width}},{{height}});</script>
```

```hbs
{{!-- src/web/views/partials/pill.hbs --}}
{{!-- expects: kind ('success'|'warning'|'danger'|'info'), text --}}
<span class="pill pill-{{kind}}">{{text}}</span>
```

```hbs
{{!-- src/web/views/partials/filter-bar.hbs --}}
{{!-- expects: action (URL), filters (array of {name,label,options:[{value,label}]}), hidden (object), csvUrl (optional) --}}
<form method="GET" action="{{action}}" class="filter-bar">
  {{#each filters}}
    <label class="filter-label">{{label}}
      <select name="{{name}}" class="filter-select">
        <option value="">{{{../req.t 'common.any'}}}</option>
        {{#each options}}<option value="{{value}}" {{#if (eq value (lookup ../values ../name))}}selected{{/if}}>{{label}}</option>{{/each}}
      </select>
    </label>
  {{/each}}
  <button type="submit" class="button">{{req.t 'common.filter'}}</button>
  {{#if csvUrl}}<a class="button button-secondary" href="{{csvUrl}}">{{req.t 'common.exportCsv'}}</a>{{/if}}
</form>
```

NOTE: Handlebars helpers (`eq`, `lookup`, `gt`, `div`, `json`) are already registered per Task 8 / 11 — verify each exists; add to `src/web/plugins/view.ts` if missing.

- [ ] **Step 5: Add design tokens + component CSS to `style.css`**

Append to `src/web/assets/style.css`:

```css
:root {
  --color-bg: #f7f8fa;
  --color-surface: #ffffff;
  --color-border: #e5e7eb;
  --color-text: #111827;
  --color-text-muted: #6b7280;
  --color-accent: #2563eb;
  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-danger: #dc2626;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 8px rgba(0,0,0,0.08);
  --sidebar-w: 220px;
  --header-h: 56px;
}

.layout-app, .layout-admin {
  font-family: var(--font-sans);
  color: var(--color-text);
  background: var(--color-bg);
}
.app-shell, .admin-shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }
.app-main, .admin-main { display: flex; flex-direction: column; min-width: 0; }
.app-header, .admin-header { height: var(--header-h); display: flex; align-items: center; padding: 0 24px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); }
.app-title, .admin-title { font-size: 16px; font-weight: 600; margin: 0; }
.app-content, .admin-content { padding: 24px; max-width: 1400px; width: 100%; box-sizing: border-box; }

.sidebar { background: #0f172a; color: #e5e7eb; padding: 16px 12px; display: flex; flex-direction: column; }
.sidebar-brand { color: #fff; font-weight: 700; font-size: 18px; text-decoration: none; padding: 8px 12px; margin-bottom: 12px; }
.sidebar-nav { flex: 1; }
.sidebar-group { margin-bottom: 16px; }
.sidebar-group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; padding: 4px 12px; }
.sidebar-link { display: block; padding: 6px 12px; color: #cbd5e1; text-decoration: none; border-radius: var(--radius-sm); font-size: 14px; }
.sidebar-link:hover { background: #1e293b; color: #fff; }
.sidebar-footer { border-top: 1px solid #1e293b; padding-top: 12px; }
.sidebar-user { display: block; padding: 4px 12px; color: #94a3b8; font-size: 12px; word-break: break-all; }
.sidebar-logout-form { display: inline; }
.sidebar-logout { background: none; border: none; cursor: pointer; text-align: left; width: 100%; font: inherit; }

.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 16px; box-shadow: var(--shadow-sm); }
.card-title { font-size: 13px; color: var(--color-text-muted); margin: 0 0 8px; font-weight: 500; }
.card-value { font-size: 28px; font-weight: 700; color: var(--color-text); margin: 0; font-variant-numeric: tabular-nums; }
.card-sub { font-size: 12px; color: var(--color-text-muted); margin-top: 4px; }

.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 1.5; }
.pill-success { background: #dcfce7; color: #166534; }
.pill-warning { background: #fef3c7; color: #92400e; }
.pill-danger { background: #fee2e2; color: #991b1b; }
.pill-info { background: #dbeafe; color: #1e40af; }
.pill-muted { background: #f3f4f6; color: #4b5563; }

.filter-bar { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
.filter-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--color-text-muted); }
.filter-select, .filter-input { padding: 6px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: inherit; background: var(--color-surface); min-width: 120px; }

.button { display: inline-block; padding: 6px 14px; background: var(--color-accent); color: #fff; border: none; border-radius: var(--radius-sm); cursor: pointer; font: inherit; text-decoration: none; }
.button:hover { background: #1d4ed8; }
.button-secondary { background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); }
.button-secondary:hover { background: #f3f4f6; }
.button-danger { background: var(--color-danger); }
.button-danger:hover { background: #b91c1c; }
.button-small { padding: 4px 10px; font-size: 12px; }

.sparkline { display: inline-block; vertical-align: middle; }

.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--color-border); }
.table th { background: #f9fafb; font-weight: 600; color: var(--color-text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
.table tbody tr:hover { background: #f9fafb; }
.table .table-num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.table .table-actions { white-space: nowrap; }

.dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
.dashboard-row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
@media (max-width: 900px) { .dashboard-row { grid-template-columns: 1fr; } }

.activity-feed { font-size: 13px; }
.activity-row { padding: 6px 0; border-bottom: 1px solid var(--color-border); display: flex; gap: 12px; align-items: baseline; }
.activity-time { color: var(--color-text-muted); font-family: var(--font-mono); font-size: 12px; min-width: 80px; }
```

- [ ] **Step 6: Run test to verify sidebar renders**

Run: `npm test -- test/integration/sidebar.test.ts`
Expected: PASS (2-3 tests). The third test (admin sidebar after auth) requires the test login helper from existing admin.users.test.ts — adapt from there.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/partials/sidebar.hbs src/web/views/layouts/app.hbs src/web/views/partials/sparkline.hbs src/web/views/partials/filter-bar.hbs src/web/views/partials/pill.hbs src/web/assets/style.css test/integration/sidebar.test.ts
git commit -m "feat(ui): sidebar layout + design tokens + base components"
```

---

### Task 5: Dashboard overview page — `/admin`

**Files:**
- Create: `src/web/admin/overview.ts`
- Create: `src/web/views/admin/dashboard.hbs`
- Modify: `src/web/routes/admin.ts` (replace `/admin` route)
- Modify: `src/web/i18n/zh-CN.json` + `en-US.json`
- Test: `test/integration/admin.dashboard.test.ts`

**Interfaces:**
- Consumes: `Pool`, `recordAuditLog`'s siblings; `listEtlRuns` if it exists, else inline SQL
- Produces: `getOverview(pool): Promise<Overview>`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/admin.dashboard.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { recordAuditLog } from '../../src/storage/auditLog';
// log in as admin helper from existing test

let td: TestDb; let app: Awaited<ReturnType<typeof buildServer>>; let cookies: string[];

beforeAll(async () => {
  td = await createTestDb('admin-dashboard');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  // seed: 1 admin user, 1 etl_run, 1 audit_log entry
  // ... (follow admin.users.test.ts pattern for admin login)
  cookies = await loginAsAdmin(app, 'admin@x', 'pw12345678');
  await recordAuditLog(td.pool, { actor: { id: 1, email: 'admin@x' }, action: 'test.action', metadata: null, ip: '1.1.1.1', userAgent: 't', statusCode: 200 });
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('admin dashboard', () => {
  it('returns 200 with cards, sparklines, recent activity', async () => {
    const r = await request(app.server).get('/admin').set('Cookie', cookies.join('; '));
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="card-value"/);
    expect(r.text).toMatch(/<svg class="sparkline"/);
    expect(r.text).toMatch(/class="activity-feed"/);
  });

  it('auto-refresh markup uses hx-trigger every 30s', async () => {
    const r = await request(app.server).get('/admin').set('Cookie', cookies.join('; '));
    expect(r.text).toMatch(/hx-trigger="every 30s"/);
  });
});
```

- [ ] **Step 2: Write overview aggregator**

```ts
// src/web/admin/overview.ts
// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { listAuditLog, type AuditLogEntry } from '../../storage/auditLog';

export interface Overview {
  generatedAt: Date;
  etl: {
    lastRun: { id: number; startedAt: Date; finishedAt: Date | null; status: string; mergedRecords: number } | null;
    lastSuccessAt: Date | null;
    runsToday: number;
  };
  db: {
    ipRanges: number;
    queryLogTotal: number;
    users: { total: number; verified: number; disabled: number };
    apiKeys: { total: number; active: number };
  };
  queries24h: { total: number; hitRate: number; trend: number[] };
  recentActivity: AuditLogEntry[];
}

export async function getOverview(pool: Pool): Promise<Overview> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [etlRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, started_at, finished_at, status, merged_records FROM etl_runs ORDER BY id DESC LIMIT 1`,
  );
  const etlRow = etlRows[0];
  const lastRun = etlRow ? {
    id: Number(etlRow.id),
    startedAt: etlRow.started_at as Date,
    finishedAt: (etlRow.finished_at ?? null) as Date | null,
    status: etlRow.status as string,
    mergedRecords: Number(etlRow.merged_records),
  } : null;

  const [successRows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(finished_at) AS last FROM etl_runs WHERE status = 'success' AND finished_at IS NOT NULL`,
  );
  const lastSuccessAt = (successRows[0]?.last ?? null) as Date | null;

  const [runsTodayRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM etl_runs WHERE started_at >= CURDATE()`,
  );
  const runsToday = Number((runsTodayRows[0] as { c: number }).c);

  const [counts] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ip_ranges) AS ip_ranges,
      (SELECT COUNT(*) FROM query_log) AS query_log_total,
      (SELECT COUNT(*) FROM users) AS users_total,
      (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS users_verified,
      (SELECT COUNT(*) FROM users WHERE is_disabled = 1) AS users_disabled,
      (SELECT COUNT(*) FROM api_keys) AS keys_total,
      (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS keys_active
  `);
  const c = counts[0] as { ip_ranges: number; query_log_total: number; users_total: number; users_verified: number; users_disabled: number; keys_total: number; keys_active: number };

  const [q24] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            SUM(status='hit') AS hits
     FROM query_log WHERE created_at >= ?`,
    [since],
  );
  const q24Row = q24[0] as { total: number; hits: number | null };
  const total = Number(q24Row.total);
  const hits = Number(q24Row.hits ?? 0);
  const hitRate = total > 0 ? hits / total : 0;

  const [trendRows] = await pool.query<RowDataPacket[]>(
    `SELECT HOUR(created_at) AS h, COUNT(*) AS n
     FROM query_log WHERE created_at >= ?
     GROUP BY HOUR(created_at) ORDER BY h`,
    [since],
  );
  const trend = new Array(24).fill(0);
  for (const r of trendRows) trend[Number(r.h)] = Number(r.n);

  const { rows: recentActivity } = await listAuditLog(pool, { offset: 0, limit: 20 });

  return {
    generatedAt: new Date(),
    etl: { lastRun, lastSuccessAt, runsToday },
    db: {
      ipRanges: Number(c.ip_ranges),
      queryLogTotal: Number(c.query_log_total),
      users: { total: Number(c.users_total), verified: Number(c.users_verified), disabled: Number(c.users_disabled) },
      apiKeys: { total: Number(c.keys_total), active: Number(c.keys_active) },
    },
    queries24h: { total, hitRate, trend },
    recentActivity,
  };
}
```

- [ ] **Step 3: Write dashboard template**

```hbs
{{!-- src/web/views/admin/dashboard.hbs --}}
<section hx-get="/admin" hx-trigger="every 30s" hx-swap="outerHTML" hx-select="section">
<h2>{{req.t 'admin.dashboard.title'}}</h2>

<div class="dashboard-grid">
  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.etlStatus'}}</p>
    <p class="card-value">
      {{#if overview.etl.lastRun}}
        {{> pill kind=(ternary (eq overview.etl.lastRun.status 'success') 'success' (ternary (eq overview.etl.lastRun.status 'failed') 'danger' 'muted')) text=overview.etl.lastRun.status}}
      {{else}}
        {{> pill kind='muted' text='never'}}
      {{/if}}
    </p>
    <p class="card-sub">{{overview.etl.runsToday}} {{req.t 'admin.dashboard.runsToday'}}</p>
  </div>

  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.ipRanges'}}</p>
    <p class="card-value">{{overview.db.ipRanges}}</p>
  </div>

  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.users'}}</p>
    <p class="card-value">{{overview.db.users.total}}</p>
    <p class="card-sub">{{overview.db.users.verified}} {{req.t 'admin.dashboard.verified'}}</p>
  </div>

  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.apiKeys'}}</p>
    <p class="card-value">{{overview.db.apiKeys.active}}</p>
    <p class="card-sub">/ {{overview.db.apiKeys.total}}</p>
  </div>

  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.queries24h'}}</p>
    <p class="card-value">{{overview.queries24h.total}}</p>
    <p class="card-sub">{{req.t 'admin.dashboard.hitRate'}} {{percent overview.queries24h.hitRate 0}}</p>
    {{> sparkline data=overview.queries24h.trend max=(max overview.queries24h.trend 1)}}
  </div>

  <div class="card">
    <p class="card-title">{{req.t 'admin.dashboard.lastSuccess'}}</p>
    <p class="card-value" style="font-size:16px">{{#if overview.etl.lastSuccessAt}}{{formatRelative overview.etl.lastSuccessAt}}{{else}}{{req.t 'admin.dashboard.never'}}{{/if}}</p>
  </div>
</div>

<div class="card">
  <h3 class="card-title">{{req.t 'admin.dashboard.recentActivity'}}</h3>
  <div class="activity-feed">
    {{#each overview.recentActivity}}
    <div class="activity-row">
      <span class="activity-time">{{formatRelative this.created_at}}</span>
      <span class="pill pill-info">{{this.action}}</span>
      <span>{{this.actor_email}}</span>
      {{#if this.target_type}}<span>→ {{this.target_type}}#{{this.target_id}}</span>{{/if}}
    </div>
    {{else}}
    <p class="card-sub">{{req.t 'admin.dashboard.noActivity'}}</p>
    {{/each}}
  </div>
</div>
</section>
```

- [ ] **Step 4: Register route in `admin.ts`**

Replace the existing `app.get('/admin', ...)` redirect with:

```ts
app.get('/admin', { preHandler: app.requireAdmin }, async (req, reply) => {
  const overview = await getOverview(app.pool);
  return reply.view('admin/dashboard.hbs', {
    layout: 'layouts/admin', title: req.t('admin.dashboard.title'),
    overview, csrfToken: getCsrfPair(req).token, req,
  });
});
```

Verify `getCsrfPair` is exported from `src/web/plugins/csrf.ts` or wherever Task 10 placed it. If not exposed, derive from `req.csrfToken`.

- [ ] **Step 5: Register Handlebars helpers if missing**

Check `src/web/plugins/view.ts` for `ternary`, `percent`, `max`, `formatRelative`. Add:

```ts
hb.registerHelper('ternary', (cond: unknown, a: unknown, b: unknown) => (cond ? a : b));
hb.registerHelper('percent', (n: number, digits = 0) => `${(Number(n) * 100).toFixed(digits)}%`);
hb.registerHelper('max', (...args: number[]) => {
  args.pop(); return args.reduce((m, v) => Math.max(m, Number(v)), 0);
});
hb.registerHelper('formatRelative', (d: Date | string) => {
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s/60)}m ago`;
  if (s < 86400) return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
});
```

- [ ] **Step 6: Add i18n keys**

In both `zh-CN.json` and `en-US.json` add (English as empty strings is acceptable per Global Constraints):

```json
"admin": {
  "dashboard": {
    "title": "总览",
    "etlStatus": "ETL 状态",
    "runsToday": "今日运行次数",
    "ipRanges": "IP 段数",
    "users": "用户",
    "verified": "已验证",
    "apiKeys": "API Keys",
    "queries24h": "24h 查询",
    "hitRate": "命中率",
    "lastSuccess": "上次成功",
    "never": "从未",
    "recentActivity": "近期活动",
    "noActivity": "暂无活动"
  }
}
```

Plus add `sidebar.group.public/user/admin` keys.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- test/integration/admin.dashboard.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Run full suite to check for regressions**

Run: `npm test`
Expected: PASS (180 baseline + this task's tests).

- [ ] **Step 9: Commit**

```bash
git add src/web/admin/overview.ts src/web/views/admin/dashboard.hbs src/web/routes/admin.ts src/web/plugins/view.ts src/web/i18n/zh-CN.json src/web/i18n/en-US.json test/integration/admin.dashboard.test.ts
git commit -m "feat(admin): dashboard overview with ETL/DB/widgets/sparklines"
```

---

### Task 6: `/admin/users` enhanced (filter/sort/CSV/bulk)

**Files:**
- Create: `src/web/views/admin/users-list.hbs` (replaces `user-list.hbs`)
- Modify: `src/web/routes/admin.ts` (rewrite `/admin/users` GET, add POST bulk + CSV)
- Modify: `src/web/i18n/zh-CN.json` + `en-US.json`
- Test: `test/integration/admin.users.enhanced.test.ts`

**Interfaces:**
- Consumes: `parseListQuery` from Task 3; `csvForRows` from `src/web/admin/csv.ts` (create in this task)
- Produces: enhanced `/admin/users` page; `POST /admin/users/bulk`; `GET /admin/users.csv`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/admin.users.enhanced.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';

let td: TestDb; let app: Awaited<ReturnType<typeof buildServer>>; let cookies: string[];

beforeAll(async () => {
  td = await createTestDb('admin-users-enhanced');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await createUser(td.pool, { email: 'a@x', passwordHash: 'h', displayName: 'A', role: 'admin' });
  await createUser(td.pool, { email: 'u1@x', passwordHash: 'h', displayName: 'U1' });
  await createUser(td.pool, { email: 'u2@x', passwordHash: 'h', displayName: 'U2' });
  cookies = await loginAsAdmin(app, 'a@x', 'pw12345678');
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('admin users enhanced', () => {
  it('filters by role=admin', async () => {
    const r = await request(app.server).get('/admin/users?role=admin').set('Cookie', cookies.join('; '));
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/a@x/);
    expect(r.text).not.toMatch(/u1@x/);
  });

  it('sorts by id desc with sort=-id', async () => {
    const r = await request(app.server).get('/admin/users?sort=-id').set('Cookie', cookies.join('; '));
    expect(r.status).toBe(200);
    // First data row should be u2 (largest id)
    expect(r.text.indexOf('u2@x')).toBeLessThan(r.text.indexOf('u1@x'));
  });

  it('exports CSV with proper BOM', async () => {
    const r = await request(app.server).get('/admin/users.csv').set('Cookie', cookies.join('; '));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.charCodeAt(0)).toBe(0xFEFF); // BOM
    expect(r.text).toMatch(/email/);
  });

  it('handles bulk disable', async () => {
    const r = await request(app.server)
      .post('/admin/users/bulk')
      .set('Cookie', cookies.join('; '))
      .type('form')
      .send({ csrf: getCsrf(cookies), action: 'disable', ids: '2,3' });
    expect(r.status).toBe(302);
    const [rows] = await td.pool.query('SELECT email, is_disabled FROM users WHERE id IN (2,3)');
    const all = (rows as { is_disabled: number }[]).every((r) => r.is_disabled === 1);
    expect(all).toBe(true);
  });
});
```

- [ ] **Step 2: Create `src/web/admin/csv.ts`**

```ts
// src/web/admin/csv.ts
// SPDX-License-Identifier: MIT
export type CsvColumn<T> = { header: string; get: (row: T) => string | number | null | undefined };

export function csvForRows<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const escape = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = columns.map((c) => escape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => escape(c.get(r))).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

export function withBom(s: string): string {
  return '﻿' + s;
}
```

- [ ] **Step 3: Rewrite `/admin/users` GET handler**

In `src/web/routes/admin.ts`, replace the existing GET with:

```ts
app.get('/admin/users', { preHandler: app.requireAdmin }, async (req, reply) => {
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
    filters: q.filters, sort: q.sort, req, csrfToken: getCsrfPair(req).token,
  });
});
```

- [ ] **Step 4: Add CSV + bulk handlers**

```ts
app.get('/admin/users.csv', { preHandler: app.requireAdmin }, async (req, reply) => {
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

app.post('/admin/users/bulk', { preHandler: app.requireAdmin }, async (req, reply) => {
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
```

- [ ] **Step 5: Write `users-list.hbs`**

```hbs
{{!-- src/web/views/admin/users-list.hbs --}}
<h2>{{req.t 'admin.users.title'}}</h2>

{{> filter-bar action='/admin/users' filters=(array
  (hash name='role' label=(req.t 'admin.users.role') options=(array (hash value='admin' label='admin') (hash value='user' label='user')))
  (hash name='disabled' label=(req.t 'admin.users.disabled') options=(array (hash value='0' label='active') (hash value='1' label='disabled')))
  (hash name='verified' label=(req.t 'admin.users.verified') options=(array (hash value='0' label='no') (hash value='1' label='yes')))
) values=filters csvUrl='/admin/users.csv'}}

<form method="POST" action="/admin/users/bulk" id="bulk-form">
  <input type="hidden" name="csrf" value="{{csrfToken}}">
  <input type="hidden" name="action" id="bulk-action" value="">
  <input type="hidden" name="ids" id="bulk-ids" value="">

  <table class="table">
    <thead>
      <tr><th></th><th><a href="?sort={{ternary (eq sort.col 'id') (ternary (eq sort.dir 'asc') '-id' 'id') (ternary (eq sort.dir 'asc') 'id' '-id')}}">{{req.t 'admin.users.id'}}</a></th><th><a href="?sort={{ternary (eq sort.col 'email') (ternary (eq sort.dir 'asc') '-email' 'email') (ternary (eq sort.dir 'asc') 'email' '-email')}}">{{req.t 'admin.users.email'}}</a></th><th>{{req.t 'admin.users.role'}}</th><th>{{req.t 'admin.users.status'}}</th><th>{{req.t 'admin.users.created'}}</th><th>{{req.t 'common.actions'}}</th></tr>
    </thead>
    <tbody>
      {{#each users}}
      <tr>
        <td><input type="checkbox" class="row-check" value="{{this.id}}"></td>
        <td class="table-num">{{this.id}}</td>
        <td><a href="/admin/users/{{this.id}}">{{this.email}}</a></td>
        <td>{{> pill kind=(ternary (eq this.role 'admin') 'info' 'muted') text=this.role}}</td>
        <td>
          {{#if this.is_disabled}}{{> pill kind='danger' text='disabled'}}{{else}}{{#if this.email_verified}}{{> pill kind='success' text='verified'}}{{else}}{{> pill kind='warning' text='unverified'}}{{/if}}{{/if}}
        </td>
        <td class="table-num">{{formatRelative this.created_at}}</td>
        <td class="table-actions"><a class="button button-small" href="/admin/users/{{this.id}}">{{req.t 'common.view'}}</a></td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="bulk-bar">
    <button type="button" class="button button-secondary" onclick="document.getElementById('bulk-action').value='enable';document.getElementById('bulk-form').submit()">{{req.t 'admin.users.bulk.enable'}}</button>
    <button type="button" class="button button-secondary" onclick="document.getElementById('bulk-action').value='disable';document.getElementById('bulk-form').submit()">{{req.t 'admin.users.bulk.disable'}}</button>
    <button type="button" class="button button-secondary" onclick="document.getElementById('bulk-action').value='verify';document.getElementById('bulk-form').submit()">{{req.t 'admin.users.bulk.verify'}}</button>
    <noscript>{{req.t 'common.enableJs'}}</noscript>
  </div>
</form>

<script>
// collect selected row ids into hidden #bulk-ids field on submit
document.querySelectorAll('#bulk-form').forEach(f => f.addEventListener('submit', () => {
  const ids = [...document.querySelectorAll('.row-check:checked')].map(c => c.value).join(',');
  document.getElementById('bulk-ids').value = ids;
}));
</script>
```

NOTE: The bulk-bar `onclick=` would normally violate CSP. The Task 4 design said no inline handlers. Use a small `assets/bulk.js` instead:

```js
// src/web/assets/bulk.js
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('bulk-form');
  if (!form) return;
  form.querySelectorAll('[data-bulk-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.bulkAction;
      const ids = [...document.querySelectorAll('.row-check:checked')].map((c) => c.value).join(',');
      if (!ids) { alert('Select rows first'); return; }
      document.getElementById('bulk-action').value = action;
      document.getElementById('bulk-ids').value = ids;
      form.submit();
    });
  });
});
```

Then buttons: `<button type="button" class="button button-secondary" data-bulk-action="enable">`. Include `<script src="/assets/bulk.js" defer></script>` in the template.

- [ ] **Step 6: Add i18n keys** for filter labels + bulk actions.

- [ ] **Step 7: Run test**

Run: `npm test -- test/integration/admin.users.enhanced.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/web/admin/csv.ts src/web/views/admin/users-list.hbs src/web/assets/bulk.js src/web/routes/admin.ts src/web/i18n/zh-CN.json src/web/i18n/en-US.json test/integration/admin.users.enhanced.test.ts
git commit -m "feat(admin): users list filter/sort/CSV/bulk actions"
```

---

### Task 7: `/admin/etl/runs` enhanced (filter/CSV)

**Files:**
- Modify: `src/web/views/admin/etl-runs.hbs`
- Modify: `src/web/routes/admin.ts` (add CSV route; existing GET add filter/sort)
- Test: `test/integration/admin.etl.enhanced.test.ts`

**Interfaces:**
- Consumes: `parseListQuery`, `csvForRows`, `withBom`

- [ ] **Step 1: Failing test**

```ts
// test/integration/admin.etl.enhanced.test.ts (4 tests: filter status, sort, CSV export, empty state)
```

- [ ] **Step 2: Update GET `/admin/etl/runs`**

Mirror the pattern from Task 6 step 3, using etl_runs columns (status, started_at, id) and `merged_records`. Use `parseListQuery`.

- [ ] **Step 3: Add `GET /admin/etl/runs.csv`**

Mirror Task 6 step 4.

- [ ] **Step 4: Update `etl-runs.hbs`**

Add filter-bar at top and CSV link.

- [ ] **Step 5: i18n keys**

- [ ] **Step 6: Run + commit**

```bash
git commit -m "feat(admin): etl runs filter/sort/CSV"
```

---

### Task 8: `/admin/keys` enhanced (filter/CSV)

Mirror Tasks 6 and 7, applied to api_keys. Columns: id, user_email (join), label, key_prefix, created_at, revoked_at.

```bash
git commit -m "feat(admin): api keys audit filter/sort/CSV"
```

---

### Task 9: `/admin/audit` enhanced (filter, verify CSV already exists)

**Files:**
- Modify: `src/web/views/admin/audit.hbs` (add filter-bar)
- Modify: `src/web/routes/admin.ts` (parseListQuery on existing GET)
- Test: `test/integration/admin.audit.enhanced.test.ts`

If the existing CSV export works, just add filter/sort to the GET handler. Test confirms filter returns subset.

```bash
git commit -m "feat(admin): query audit filter/sort"
```

---

### Task 10: `/admin/audit-log` page (read operation log)

**Files:**
- Create: `src/web/views/admin/audit-log.hbs`
- Modify: `src/web/routes/admin.ts` (add `GET /admin/audit-log` + `GET /admin/audit-log.csv`)
- Test: `test/integration/admin.auditlog.test.ts`

- [ ] **Step 1: Failing test**

```ts
// 3 tests: list seeded entries; filter by action; CSV export
```

- [ ] **Step 2: Implement GET**

```ts
app.get('/admin/audit-log', { preHandler: app.requireAdmin }, async (req, reply) => {
  const q = parseListQuery(req.url.split('?')[1] ?? '', {
    filters: ['action', 'actor', 'target_type', 'since', 'until'],
    sort: ['id', 'created_at'],
  });
  const opts: Parameters<typeof listAuditLog>[1] = { offset: (q.page-1)*q.limit, limit: q.limit };
  if (q.filters.action) opts.action = q.filters.action;
  if (q.filters.target_type) opts.targetType = q.filters.target_type;
  if (q.filters.since) opts.since = new Date(q.filters.since);
  if (q.filters.until) opts.until = new Date(q.filters.until);
  if (q.filters.actor) {
    const u = await findUserByEmail(app.pool, q.filters.actor);
    opts.actorUserId = u ? u.id : -1;
  }
  const { rows, total } = await listAuditLog(app.pool, opts);
  // ... render
});
```

- [ ] **Step 3: Add CSV variant**

- [ ] **Step 4: Template**

```hbs
{{!-- src/web/views/admin/audit-log.hbs --}}
<h2>{{req.t 'admin.auditLog.title'}}</h2>
{{> filter-bar action='/admin/audit-log' filters=(array
  (hash name='action' label=(req.t 'admin.auditLog.action') options=(array
    (hash value='user.delete' label='user.delete')
    (hash value='user.reset_password' label='user.reset_password')
    (hash value='user.bulk.disable' label='user.bulk.disable')
    (hash value='etl.trigger' label='etl.trigger')
    (hash value='key.revoke' label='key.revoke')))
  (hash name='target_type' label=(req.t 'admin.auditLog.target') options=(array (hash value='user' label='user') (hash value='api_key' label='api_key') (hash value='etl_run' label='etl_run')))
) values=filters csvUrl='/admin/audit-log.csv'}}

<table class="table">
  <thead><tr><th>{{req.t 'admin.auditLog.time'}}</th><th>{{req.t 'admin.auditLog.actor'}}</th><th>{{req.t 'admin.auditLog.action'}}</th><th>{{req.t 'admin.auditLog.target'}}</th><th>{{req.t 'admin.auditLog.ip'}}</th></tr></thead>
  <tbody>
    {{#each rows}}
    <tr>
      <td class="table-num">{{formatRelative this.created_at}}</td>
      <td>{{this.actor_email}}</td>
      <td>{{> pill kind='info' text=this.action}}</td>
      <td>{{#if this.target_type}}{{this.target_type}}#{{this.target_id}}{{else}}—{{/if}}</td>
      <td class="table-num">{{this.ip}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>
```

- [ ] **Step 5: i18n keys**

- [ ] **Step 6: Run + commit**

```bash
git commit -m "feat(admin): audit-log page with filter/CSV"
```

---

### Task 11: `/admin/queries` page

**Files:**
- Create: `src/web/admin/queries.ts` (`getQueryStats`)
- Create: `src/web/views/admin/queries.hbs`
- Modify: `src/web/routes/admin.ts`
- Test: `test/integration/admin.queries.test.ts`

- [ ] **Step 1: Failing test**

```ts
// 2 tests: seed query_log rows then GET /admin/queries; CSV export
```

- [ ] **Step 2: Implement `getQueryStats`** (per spec §6.3)

- [ ] **Step 3: Implement route + template**

Renders: total / hit-rate pill / top 10 IPs / top 10 users / 24h sparkline.

- [ ] **Step 4: i18n**

- [ ] **Step 5: Run + commit**

```bash
git commit -m "feat(admin): query volume stats page"
```

---

### Task 12: `/admin/settings` page

**Files:**
- Create: `src/web/views/admin/settings.hbs`
- Modify: `src/web/routes/admin.ts` (add `GET /admin/settings`)
- Test: `test/integration/admin.settings.test.ts`

- [ ] **Step 1: Failing test**

```ts
// 2 tests: page renders without secrets; POST /admin/settings/etl-restart works
```

- [ ] **Step 2: Implement GET**

```ts
app.get('/admin/settings', { preHandler: app.requireAdmin }, async (req, reply) => {
  const cfg = app.cfg;
  const display = {
    db: { host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, user: cfg.db.user, poolSize: cfg.db.poolSize },
    api: { port: cfg.api.port, rateLimit: cfg.api.rateLimit },
    etl: { schedule: cfg.etl.schedule, timezone: cfg.etl.timezone, dataDir: cfg.etl.dataDir },
    web: {
      baseUrl: cfg.web.baseUrl, cookieDomain: cfg.web.cookieDomain, cookieSecure: cfg.web.cookieSecure,
      sessionTtlHours: cfg.web.sessionTtlHours,
      sessionSecret: redactSecret(cfg.web.sessionSecret || '(unset)'),
      csrfSecret: redactSecret(cfg.web.csrfSecret || '(unset)'),
    },
    smtp: { host: cfg.smtp.host || '(console)', port: cfg.smtp.port, from: cfg.smtp.from },
    security: { ...cfg.security },
  };
  const [poolRows] = await app.pool.query<RowDataPacket[]>('SHOW STATUS WHERE Variable_name IN ("Threads_connected", "Max_used_connections")');
  const pool = Object.fromEntries((poolRows as { Variable_name: string; Value: string }[]).map((r) => [r.Variable_name, r.Value]));
  return reply.view('admin/settings.hbs', {
    layout: 'layouts/admin', title: req.t('admin.settings.title'),
    config: display, pool, req, csrfToken: getCsrfPair(req).token,
  });
});
```

- [ ] **Step 3: Template** — show config in `<dl>` with redacted secrets as `••••1234`.

- [ ] **Step 4: i18n keys**

- [ ] **Step 5: Run + commit**

```bash
git commit -m "feat(admin): settings panel with redacted config + DB pool status"
```

---

### Task 13: Instrument all admin POSTs with `req.auditAction`

**Files:**
- Modify: `src/web/routes/admin.ts`
- Modify: `src/web/routes/dashboard.ts` (the keys revoke action)
- Test: existing tests verify behaviour unchanged; new test in `test/integration/auditlog.plugin.test.ts` extension

For every existing admin POST handler in `src/web/routes/admin.ts`:

| Handler | `req.auditAction` |
|---|---|
| `POST /admin/users/:id/verify-email` | `{ action: 'user.verify_email', targetType: 'user', targetId: <id> }` |
| `POST /admin/users/:id/reset-password` | `{ action: 'user.reset_password', targetType: 'user', targetId: <id> }` |
| `POST /admin/users/:id/delete` | `{ action: 'user.delete', targetType: 'user', targetId: <id> }` |
| `POST /admin/etl/trigger` | `{ action: 'etl.trigger', targetType: 'etl_run' }` |
| `POST /admin/keys/:id/revoke` | `{ action: 'key.revoke', targetType: 'api_key', targetId: <id> }` |

Each gets a one-line `req.auditAction = { ... }` added before the existing logic.

- [ ] **Step 1: Write failing test**

```ts
// test/integration/auditlog-instrumentation.test.ts
// Login as admin, POST /admin/users/X/verify-email, then GET /admin/audit-log and assert a row exists.
```

- [ ] **Step 2: Add `req.auditAction` lines** to each handler in `admin.ts` (and `dashboard.ts` if any).

- [ ] **Step 3: Run test + full suite**

Run: `npm test`
Expected: PASS (baseline + this task).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(audit): instrument all admin POST handlers"
```

---

### Task 14: Frontend redesign — `/`, `/docs`, drop `/pricing`

**Files:**
- Modify: `src/web/routes/marketing.ts`
- Create: `src/web/views/home.hbs` (replace `marketing/home.hbs`)
- Create: `src/web/views/docs.hbs` (replace `marketing/docs.hbs`)
- Delete: `src/web/views/marketing/home.hbs`, `marketing/docs.hbs`, `marketing/pricing.hbs`
- Modify: `src/web/i18n/*.json`
- Test: `test/integration/home.test.ts`, `test/integration/docs.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/integration/home.test.ts
// GET / returns 200 with sidebar + query form + status card

// test/integration/docs.test.ts
// GET /docs returns 200 with API reference table (4 endpoints)
```

- [ ] **Step 2: Rewrite `/` handler in `marketing.ts`**

```ts
app.get('/', async (req, reply) => {
  const [ipCountRows] = await app.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM ip_ranges');
  const [q24Rows] = await app.pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM query_log WHERE created_at >= ?`,
    [new Date(Date.now() - 86400_000)],
  );
  const ipCount = Number((ipCountRows[0] as { c: number }).c);
  const q24 = Number((q24Rows[0] as { c: number }).c);
  return reply.view('home.hbs', {
    layout: 'layouts/app', title: req.t('home.title'),
    ipCount, q24, csrfToken: getCsrfPair(req).token, req,
  });
});
```

- [ ] **Step 3: Write `home.hbs`** (per spec §7.4)

- [ ] **Step 4: Rewrite `/docs` handler** to render a small static page listing 4 endpoints with curl examples.

- [ ] **Step 5: Remove `/pricing` route** from `marketing.ts` and delete `marketing/pricing.hbs`.

- [ ] **Step 6: Update `partials/nav.hbs`** references — switch to `partials/sidebar.hbs` everywhere (already done in Task 4 for `/` and `/login`; double-check other pages like `/try`, `/about`, `/status`).

- [ ] **Step 7: i18n**

- [ ] **Step 8: Run + commit**

```bash
git commit -m "feat(web): tool-style home + docs, drop /pricing"
```

---

### Task 15: Dashboard pages get sidebar; final integration tests + README

**Files:**
- Modify: `src/web/views/layouts/admin.hbs` (use sidebar partial)
- Modify: `src/web/views/layouts/public.hbs` (use sidebar partial)
- Modify: `README.md` (Web Frontend section: new pages, new features)
- Run full test suite + lint

- [ ] **Step 1: Update `layouts/admin.hbs`** to include `{{> sidebar}}` instead of the old `{{> nav}}`.

- [ ] **Step 2: Update `layouts/public.hbs`** similarly.

- [ ] **Step 3: Add README sections**

Append to the existing "Web Frontend" section:
- New admin modules list
- New tool-style note
- Updated deploy guide if any URLs changed

- [ ] **Step 4: Run full test + lint**

```bash
npx tsc --noEmit && npm test
```

Expected: PASS (195/195 approx, 0 lint errors).

- [ ] **Step 5: Commit**

```bash
git commit -m "docs+ui: dashboard pages use sidebar; README updated for redesign"
```

---

## Done criteria

- All 15 task commits land on `main`
- 195/195 (approx) tests pass
- `npx tsc --noEmit` clean
- `npm run build` produces working `dist/`
- `npm run serve:4001` boots, dashboard `/admin` shows live numbers
- No new npm dependencies