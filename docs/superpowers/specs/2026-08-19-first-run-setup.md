# First-Run Setup Wizard — Spec

**Date:** 2026-08-19
**Plan:** `docs/superpowers/plans/2026-08-19-first-run-setup.md`
**Status:** Approved for execution

## 1. Motivation

A fresh deployment currently requires the operator to:

1. Edit `.env` for DB credentials, `SESSION_SECRET`, `MAXMIND_LICENSE_KEY`, etc.
2. Run `make migrate`.
3. Run `make create-admin` with `ADMIN_EMAIL` and `ADMIN_PASSWORD` env vars.
4. Run `make run` to start the server.
5. Manually trigger an ETL pass (or wait for the cron) before any IP lookup returns data.

For a first deploy, this is friction. The spec is for a web-based first-run wizard that takes a fresh instance from empty to **ready in one browser session**, without requiring the operator to leave the UI or to know the env-var names in advance.

## 2. Goals

- A single browser session walks the operator through DB validation, site config, admin creation, and seed data load.
- The wizard is partially self-serve: it documents and validates the DB configuration but does not attempt to swap the live DB connection at runtime (would require restart, easy to get wrong).
- The seed dataset gives the operator a working dashboard on day one, even before MaxMind ETL has run.
- A non-interactive CLI equivalent (`make init`) exists for automation / Docker / scripted deploys.

## 3. Non-Goals

- Replacing the existing `make create-admin` / `make migrate` flow. They remain available for advanced operators.
- Hot-reload of the database connection without restart.
- Migration of existing live installs. The wizard only appears on a fresh DB (no admin user exists).
- Adding npm dependencies.

## 4. UX

The wizard is a 5-step linear flow at `/setup`:

| Step | URL | Purpose |
|---|---|---|
| 1 | `/setup` | Welcome + current state (DB reachable? migrations applied? admin exists?) |
| 2 | `/setup/database` | Read-only view of DB config from `.env`; "Test connection" button |
| 3 | `/setup/site` | Site name + tagline |
| 4 | `/setup/admin` | Email + password + display name |
| 5 | `/setup/seed` | Pick seed dataset (`yes` / `no`) |
| 6 | `/setup/complete` | Success; marks `initialized_at`; redirects to `/login` |

A progress indicator at the top of every step. Each page renders the same layout (`layouts/setup.hbs`) — centered card, no sidebar.

Post-init: `/setup*` returns 404.

## 5. Architecture

### 5.1 Init detection

New `settings` table (k/v):

```sql
CREATE TABLE settings (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`isInitialized(pool)` returns true iff a row with `k='initialized_at'` exists. This is the single init flag.

### 5.2 Guard

`setupGuard` plugin in `src/web/plugins/setupGuard.ts`:

- On boot, set `app.requireSetup = !(await isInitialized(app.pool))`.
- `onRequest` hook:
  - If `app.requireSetup` and the route is not in the allowlist (`/setup`, `/setup/*`, `/assets/*`, `/healthz`, `/api/*` health routes), reply 302 to `/setup`.
  - If `!app.requireSetup` and the route starts with `/setup`, reply 404.
- After `POST /setup/complete` succeeds, refresh `app.requireSetup = false` so the guard flips immediately.

### 5.3 Routes

`src/web/routes/setup.ts` registers 10 handlers. Each POST validates with zod, uses `req.csrfToken`, and sets a flash message on success/error.

### 5.4 Seed data

New migration `012_seed_ip_ranges.sql` with ~50 rows. Idempotent (`INSERT IGNORE` keyed on (start_ip, end_ip)). Each row has `country_source='seed'`, `city_source='seed'`, `isp_source='seed'`.

Coverage:

- Public DNS: Google (8.8.8.8, 8.8.4.4), Cloudflare (1.1.1.1, 1.0.0.1), Quad9 (9.9.9.9, 149.112.112.112), 国内 DNS (114.114.114.114, 114.114.115.115, 223.5.5.5, 223.6.6.6, 180.76.76.76, 119.29.29.29, 119.28.28.28, 101.226.4.6, 218.30.118.6)
- Cloudflare nodes (sample 6)
- Apple (17.0.0.0/8 sample 2)
- Microsoft (13.107.0.0/16 sample 2)
- RFC reserved: 192.168.0.0/24, 10.0.0.0/24, 127.0.0.0/24, 172.16.0.0/24

Total ~50 rows.

### 5.5 CLI

`src/cli.ts` gains `init` subcommand:

```
node dist/cli.js init \
  --email admin@example.com \
  --password "..." \
  --name "Admin" \
  --seed
```

Mirrors the wizard: runs migrations, calls `bootstrapAdmin`, marks `initialized_at`, optionally loads seed (already idempotent via migration).

### 5.6 i18n

Symmetric `setup.*` keys under both `zh-CN` and `en-US`. Subset:

- `setup.title`, `setup.welcome.*` (title, body, cta)
- `setup.steps.*` (1..6 labels)
- `setup.database.*` (title, fields, test, success, failure)
- `setup.site.*` (title, fields, success)
- `setup.admin.*` (title, fields, success, errors)
- `setup.seed.*` (title, options, success, skipped)
- `setup.complete.*` (title, body, cta)
- `setup.errors.*` (csrf, db_unreachable, password_weak, email_invalid, etc.)

## 6. Constraints

- All TS / HBS / SQL files end with LF newline.
- New migrations follow `NNN_*.sql` regex in `src/storage/migrations/runner.ts`.
- No new npm dependencies.
- 223/223 baseline tests pass; new tests land alongside.

## 7. Risks

- **DB step is read-only.** Users will try to change DB credentials in the form and be surprised when nothing happens. Mitigation: the form clearly labels "These values are loaded from `.env`. To change them, edit `.env` and restart the server, then return to this page."
- **Seed data is a snapshot.** It will diverge from real MaxMind data. The dashboard surfaces `country_source='seed'` rows alongside ETL rows so operators can tell what's what. The seed is also reset to `country_source='seed'` so a subsequent ETL run can replace it cleanly.
- **Post-init guard refresh.** If `app.requireSetup` is cached at boot and never updated, the lock-out fails. The plugin must refresh the flag on every redirect to `/setup/complete` POST.
- **Z-index of `setup.html` pages.** CSP currently blocks inline scripts. The wizard must use external scripts and form submits only — same constraint as the rest of the admin app.

## 8. Out of Scope (Future)

- Multi-admin creation in the wizard.
- SMTP configuration from the wizard (intentionally: SMTP requires restart too, and most fresh runs print to stdout).
- MaxMind license key entry from the wizard (the ETL runs on schedule; if no key is set, the pipeline simply skips MaxMind).
- Logo / favicon upload.
