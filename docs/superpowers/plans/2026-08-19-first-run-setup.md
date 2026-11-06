# First-Run Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-based first-run setup wizard so a fresh deployment can configure site name, validate database connection, create the first admin, and optionally load a ~50-IP seed dataset — without editing `.env` or running CLI commands beyond `make install` and `make run`.

**Architecture:**

- New `settings` table (k/v) with `initialized_at` as the sole init flag.
- New `setupGuard` plugin redirects all non-`/setup/*` to `/setup` until `initialized_at` is set; locks out `/setup/*` after init.
- Linear 5-step wizard at `/setup`, `/setup/database`, `/setup/site`, `/setup/admin`, `/setup/seed`, `/setup/complete`.
- DB step is read-only: tests the configured connection (loaded from `.env`) and shows what to change if the test fails. The wizard does not mutate DB credentials at runtime.
- Seed data lives in a new migration `012_seed_ip_ranges.sql`, identifiable via `country_source='seed'`, `city_source='seed'`.
- CLI `init` command (`make init`) provides a non-interactive equivalent for automation.

**Tech Stack:** Fastify 4 + Handlebars 4 + htmx + MySQL 8 + mysql2 + bcrypt/argon2 + zod. Same as Phase B.

**Spec:** `docs/superpowers/specs/2026-08-19-first-run-setup.md`

## Global Constraints

- All TS files must end with LF newline (spec §10).
- i18n keys must be symmetric in `src/web/i18n/zh-CN.json` and `src/web/i18n/en-US.json` (same path, both locales).
- Handlebars 4.x: avoid `{{req.t 'key'}}` inside `{{#each}}` — use `@root.req.t` (per Phase B Task 6 finding).
- Auth/CSRF rules: `app.requireAdmin` and `getCsrfPair(req)` do not exist — use `req.csrfToken` and `onRequest` hooks (per Phase B brief pitfalls).
- Migrations auto-discover `NNN_*.sql` files via `src/storage/migrations/runner.ts` regex `^\d{3}_.+\.sql$` — new migrations must follow that pattern.
- No new npm dependencies.
- Tests: 223/223 baseline must hold; new tests land alongside new code.

---

## Task 1: Settings table + storage helper

**Files:**

- Create: `src/storage/migrations/011_settings.sql`
- Create: `src/storage/settings.ts`
- Test: `test/integration/settings.test.ts`

**Interfaces:**

- Produces `getSetting(pool, key)`, `setSetting(pool, key, value)`, `isInitialized(pool)`, `markInitialized(pool)`.

**Steps:**

- [ ] Write migration: `CREATE TABLE settings (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
- [ ] Write `src/storage/settings.ts` with the four helpers above. `isInitialized` returns true if `initialized_at` row exists, false otherwise.
- [ ] Write integration test: insert/get cycle, isInitialized flips on markInitialized, idempotent.
- [ ] Run `npx tsc --noEmit && npx vitest run test/integration/settings.test.ts` — expect green.
- [ ] Commit: `feat(storage): settings k/v table + isInitialized helper`

## Task 2: Seed IP ranges migration

**Files:**

- Create: `src/storage/migrations/012_seed_ip_ranges.sql`
- Test: `test/integration/seed-data.test.ts`

**Steps:**

- [ ] Write migration with ~50 rows. Use the `ip_ranges` schema (see `001_ip_ranges.sql`). Set `country_source='seed'`, `city_source='seed'`, `isp_source='seed'`. Cover: public DNS (8.8.8.8, 8.8.4.4, 1.1.1.1, 1.0.0.1, 9.9.9.9, 149.112.112.112, 114.114.114.114, 114.114.115.115, 223.5.5.5, 223.6.6.6, 180.76.76.76, 119.29.29.29, 119.28.28.28, 101.226.4.6, 218.30.118.6), Cloudflare nodes (6-7 entries), Apple (17.0.0.0/8 sample), Microsoft (13.107.0.0/16 sample), RFC reserved (192.168.0.0/24, 10.0.0.0/24, 127.0.0.0/24, 172.16.0.0/24). Use `BINARY(16)` packed form via `UNHEX()` for IPv4.
- [ ] Seed must be idempotent: `INSERT IGNORE` keyed on (start_ip, end_ip) — or use a unique key. Actually, the schema already has `id AUTO_INCREMENT`, so use `INSERT IGNORE` with a unique index on (start_ip, end_ip). Add the unique index in the migration.
- [ ] Write test: `runMigrations` includes 012, after apply `SELECT COUNT(*) FROM ip_ranges WHERE country_source='seed'` returns ~50.
- [ ] Run tests — green.
- [ ] Commit: `feat(seed): ~50 hand-curated IP ranges for first-run demo`

## Task 3: CLI `init` command (non-interactive)

**Files:**

- Modify: `src/cli.ts` (add `init` subcommand)
- Modify: `Makefile` (add `init` target)
- Test: `test/integration/cli-init.test.ts`

**Interfaces:**

- `init` flags: `--email <email>`, `--password <password>`, `--name <name>`, `--admin`, `--seed`, `--reinit` (skip already-initialized check).
- Discovers MySQL via `loadConfig()`, runs migrations, creates admin (via existing `bootstrapAdmin`), loads seed (controlled by flag), marks initialized.

**Steps:**

- [ ] Write `init` command in `src/cli.ts`. Don't run migrations for `--seed` if already applied (the migration handles it).
- [ ] Write test: invoke `init` against test DB, assert `isInitialized(pool)` true, admin user exists, seed rows present.
- [ ] Update `Makefile` `init` target.
- [ ] Run tests — green.
- [ ] Commit: `feat(cli): init command for non-interactive first-run bootstrap`

## Task 4: Setup guard plugin

**Files:**

- Create: `src/web/plugins/setupGuard.ts`
- Modify: `src/api/server.ts` (register the plugin)
- Test: `test/integration/setup-guard.test.ts`

**Interfaces:**

- `app.requireSetup` — boolean flag, true if not initialized.
- Hook: `onRequest` — if `app.requireSetup` and `req.routeOptions.url` not in {`/setup`, `/setup/*`, `/assets/*`, `/healthz`}, redirect 302 to `/setup`.
- After init: `/setup*` returns 404.

**Steps:**

- [ ] Write the plugin. Use `app.pool` to check `isInitialized` once at boot, cache in `app.requireSetup`. Re-check on every request to `/setup/complete` POST so the lock-out happens immediately.
- [ ] Allow `/healthz` through so external probes still work.
- [ ] Write test: before init, `/` returns 302 to `/setup`; after init, `/setup` returns 404; `/login` works after init.
- [ ] Run tests — green.
- [ ] Commit: `feat(web): setupGuard plugin redirects to /setup when uninitialized`

## Task 5: Setup routes

**Files:**

- Create: `src/web/routes/setup.ts`
- Modify: `src/api/server.ts` (register setup routes after setupGuard)
- Test: `test/integration/setup-routes.test.ts`

**Routes:**

- `GET /setup` — landing page (welcome + start button)
- `GET /setup/database` — show current DB config from env, form with "Test connection" button
- `POST /setup/database` — runs `pool.getConnection()` probe
- `GET /setup/site` — site name + tagline form
- `POST /setup/site` — saves to settings table
- `GET /setup/admin` — admin email/password/name form
- `POST /setup/admin` — calls `bootstrapAdmin(pool, ...)`
- `GET /setup/seed` — pick seed (yes/no)
- `POST /setup/seed` — runs migrations (idempotent) then loads seed
- `GET /setup/complete` — success page
- `POST /setup/complete` — calls `markInitialized(pool)`, redirects to `/login`

**Steps:**

- [ ] Write all 10 handlers. Validate with zod. Reuse `req.csrfToken`. Set flash messages via the existing flash mechanism.
- [ ] Write test: walk through all 5 steps, assert final state via `isInitialized` + admin count + seed count.
- [ ] Run tests — green.
- [ ] Commit: `feat(web): setup wizard routes (5-step linear flow)`

## Task 6: Setup views

**Files:**

- Create: `src/web/views/setup/{index,database,site,admin,seed,complete}.hbs`
- Create: `src/web/views/layouts/setup.hbs`
- Modify: `src/web/views/partials/sidebar.hbs` — hide nav in setup mode (optional, via `req.inSetup` flag)
- Localization: modify `src/web/i18n/{zh-CN,en-US}.json`

**Steps:**

- [ ] Layout `setup.hbs` extends `app` but skips the sidebar (full-width centered card).
- [ ] Each view has: progress indicator (1/5, 2/5, etc.), form, error display, next/back/finish buttons.
- [ ] Add `setup.*` i18n keys symmetrically: title, steps, labels, buttons, errors, success.
- [ ] Verify with `npx tsc --noEmit && npm test`.
- [ ] Commit: `feat(web): setup wizard views + i18n for zh-CN/en-US`

## Task 7: Integration tests — full wizard E2E

**Files:**

- Create: `test/integration/setup-wizard.test.ts`

**Steps:**

- [ ] Test happy path: GET /setup → 5 POSTs → redirect to /login → login as created admin → can access /admin.
- [ ] Test guard: fresh DB → /login returns 302 to /setup. After init → /setup returns 404.
- [ ] Test seed skip: POST /setup/seed with `load=false` → no seed rows; with `load=true` → 50 rows.
- [ ] Test DB step failure: with bad DB env, GET /setup/database shows error message.
- [ ] Run full suite — 223 + new tests, all green.
- [ ] Commit: `test(web): full setup wizard E2E + guard behaviors`

## Task 8: Final whole-branch review

**Steps:**

- [ ] Dispatch final code reviewer (most capable model).
- [ ] Apply any fixes via ONE fix dispatch + scoped re-review.
- [ ] Adjudicate residuals.
- [ ] Update progress.md ledger.

## Task 9: README first-deploy guide update

**Files:**

- Modify: `README.md`

**Steps:**

- [ ] Replace the "First-deploy guide" 6-step env+CLI flow with a 3-step wizard flow: `make install &amp;&amp; make build &amp;&amp; make run` → open `/setup` → wizard.
- [ ] Keep a "Non-interactive bootstrap" subsection describing `make init` with `--email` / `--password` / `--seed` flags.
- [ ] Verify tsc + tests still green.
- [ ] Commit: `docs(readme): first-deploy guide uses setup wizard`

---
