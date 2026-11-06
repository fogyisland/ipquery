# IPQuery

IP geolocation aggregator over **MaxMind GeoLite2**, **ip2region**, and **DB-IP**. Code under MIT; data files downloaded at runtime and **never redistributed** by this repository.

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for design and [`docs/superpowers/plans/`](docs/superpowers/plans/) for the implementation plan.

## Quick start

```bash
# 1. Get a free MaxMind license key
#    https://www.maxmind.com/en/geolite2/signup
# 2. Configure
cp .env.example .env
# Edit .env, set MAXMIND_LICENSE_KEY

# 3. Run
make install build run    # local node + uses local MySQL
```

The first run downloads data sources and populates the database (~10 min). Subsequent runs take the daily cron.

## Endpoints

- `GET /lookup?ip=8.8.8.8` — geolocation lookup
- `GET /healthz` — liveness probe
- `GET /stats` — last ETL run summary

## MCP server

AI tools (Claude Code, Cursor, Claude Desktop) can connect to IPQuery directly via MCP: `npm run build && npm run mcp`. See [`docs/mcp.md`](docs/mcp.md) for setup and the 7 read-only tools.

## Data sources & licenses

| Source                                                  | License                                 | Notes                                          |
| ------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| [MaxMind GeoLite2](https://www.maxmind.com/en/geolite2) | GeoLite2 EULA (free, no redistribution) | User registers and sets `MAXMIND_LICENSE_KEY`. |
| [ip2region](https://github.com/lionsoul2014/ip2region)  | Apache-2.0                              | Attribution preserved in NOTICE.               |
| [DB-IP](https://db-ip.com/db/download/ip-to-city)       | CC-BY 4.0                               | Attribution required in derivative UI.         |

This repository contains **no data files**. You are responsible for downloading and complying with each source's license.

## Architecture

ETL pipeline → MySQL → Fastify. See [`docs/superpowers/specs/2026-08-13-ip-aggregator-design.md`](docs/superpowers/specs/2026-08-13-ip-aggregator-design.md) for the full design.

## Development

```bash
make test-unit    # fast
make test-int     # requires a reachable MySQL (DB_* env vars)
make lint
```

## Limitations

- MaxMind parser uses a sparse-probe MVP. Full tree-walking iterator is post-MVP work.
- ip2region parser reads the JSON-export form, not the binary .xdb. Future work.
- Single-process, single-host. No horizontal scaling.
- IPv6 support is functional but coverage is uneven across sources.

## Web Frontend

The application ships with a server-rendered admin console and user dashboard at the same origin as the API. Pages are rendered with Handlebars + Fastify; interactive fragments use htmx.

The UI follows a tool-style layout: a persistent left sidebar groups links by audience (public / user / admin) and every layout — `layouts/app`, `layouts/admin`, `layouts/dashboard`, `layouts/public` — shares the same sidebar partial (`partials/sidebar.hbs`) and the same design tokens (`/assets/style.css`). Legacy marketing chrome was removed: `/pricing` no longer exists; `/` and `/docs` use the tool shell instead of the old landing page.

### Pages

- **Marketing & docs** — `/`, `/about`, `/docs`, `/status`, `/try` (htmx-powered demo)
- **Auth** — `/signup`, `/login`, `/verify`, `/forgot`, `/reset`, `/setup` (first-run wizard, unauthenticated entry point)
- **Dashboard** — `/dashboard`, `/dashboard/history`, `/dashboard/keys`, `/dashboard/profile`
- **Admin** — `/admin` (overview with ETL/DB/widgets/sparklines), `/admin/users`, `/admin/etl/runs`, `/admin/keys`, `/admin/audit` (query log), `/admin/audit-log` (admin action log), `/admin/queries` (stats + top users + hourly), `/admin/settings` (DB pool + secrets + ETL restart)
- **API** — `/lookup[/:ip]`, `/healthz`, `/stats`

### First-deploy guide

The web app and API share one Fastify process. You need a reachable MySQL — install it natively or via your distro's package manager. The steps below assume MySQL is already listening on the host.

1. `cp .env.example .env` and set `SESSION_SECRET` (long random string), `WEB_BASE_URL` (defaults to `http://localhost:3100`), `DB_*` for your MySQL, and `MAXMIND_LICENSE_KEY`. Configure `SMTP_*` if you want real email delivery; otherwise verification/reset emails print to stdout. The deploy target is **native Node + MySQL on the host** — no Docker required.
2. `make install` then `make build` (compile TypeScript + copy schema into `dist/`).
3. Bootstrap the admin and the database. Fresh installs must be initialized before `/login` works; choose one of:
   - **Web wizard (default).** Run `make run` and open `http://localhost:3100/setup` in a browser. The wizard runs migrations, probes the DB connection, lets you set the site name, bootstrap the admin account, and optionally load seed data — a 6-step linear flow. Once `settings.initialized_at` is set, `/setup` returns 404 and every non-allowlisted route stops redirecting to it.
   - **CLI `init` (headless).** For scripted deploys (Ansible, Terraform, CI): `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=$(openssl rand -base64 16) make init` runs migrations + bootstraps the admin. Add `ADMIN_SEED=true` to also load the seed dataset. The command exits with an error if the system is already initialized; pass `--reinit` to re-run without wiping data.
4. `make run` to start the server (or use your process manager of choice with `node dist/cli.js serve`).
5. Open `http://localhost:3100/login` (or your `WEB_BASE_URL`) and sign in.

### Local development

```bash
make install        # npm install
make build          # tsc + copy schema
make migrate        # apply DB schema
make create-admin   # interactive bootstrap (or set ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME)
make run            # node dist/cli.js serve --once  (loads .env automatically)
make test-web       # unit + integration tests
make e2e            # end-to-end tests
```

### Internationalization

Default locale is `zh-CN`. `en-US` is also bundled; switch via the language toggle in the header — the preference is stored in a non-httpOnly `lang` cookie. To add a new locale, create `src/web/i18n/<locale>.json` and register it in `src/web/i18n/index.ts` (extend `SUPPORTED_LOCALES` and `DEFAULT_LOCALE` and add the dictionary to the `dictionaries` map).

### Email delivery

When `SMTP_HOST` is unset, emails are printed to stdout (dev mode). In production set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (and `SMTP_SECURE` if your relay requires TLS) and the console transport is replaced automatically.

### CSRF, sessions, rate limits

- Sessions live in the MySQL `sessions` table — httpOnly cookies, `SameSite=Lax`, **7-day** rolling expiry (configurable via `SESSION_TTL_HOURS`, default 168).
- Forms include a CSRF token (`csrf` cookie + `csrf` body field, 4-hour TTL); the dashboard middleware rejects mismatched or expired tokens with HTTP 403.
- `POST /signup` — 5 requests per hour per IP (`SIGNUP_RATE_PER_IP_PER_HOUR`).
- `POST /login` — 20 requests per hour per IP (Fastify built-in rate limit) plus a per-account lockout: 5 consecutive failures (`LOGIN_MAX_ATTEMPTS`) triggers a 15-minute lockout (`LOGIN_LOCKOUT_MINUTES`).
- `POST /forgot` — 5 requests per hour per IP.

### Operator notes

- `make migrate-status` reports which migrations from `db/migrations/` are applied or pending.
- `node dist/cli.js migrate` / `migrate:status` / `create-admin` are the same commands the Makefile targets wrap; call them directly when scripting.

## License

MIT for code in this repository.
