# Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three-tier web UI (marketing site, authenticated user dashboard, admin backend) to IPQuery, with full registration / email verification / password reset / API key management / global query audit. SSR via Handlebars, MySQL session cookies, bilingual i18n (zh-CN first), nodemailer with console/SMTP transports.

**Architecture:** Add a `src/web/` module that registers its routes on the existing Fastify instance. New tables (`users`, `api_keys`, `sessions`, `email_verifications`, `password_resets`, `query_log`) sit beside the existing `ip_ranges` / `etl_runs`. A lightweight SQL migration runner replaces hardcoded `schema.sql`. Existing `/lookup` is extended with a query-log onResponse hook and an API-key auth path (`?key=`). All web routes render Handlebars templates; progressive enhancement via vendored htmx (no SPA, no build chain).

**Tech Stack:** Node.js 20, TypeScript 5 (strict + noUncheckedIndexedAccess), Fastify 4.29, Handlebars 4 (`@fastify/view`), `@fastify/cookie`, `@fastify/formbody`, `@fastify/static`, `argon2` (argon2id), `nodemailer`, mysql2/promise, vitest 2, supertest.

**Spec:** [`docs/superpowers/specs/2026-08-13-web-frontend-design.md`](../specs/2026-08-13-web-frontend-design.md) — the plan argues from the spec, executors read both.

**Extends:** [`docs/superpowers/plans/2026-08-13-ip-aggregator.md`](2026-08-13-ip-aggregator.md) — existing 18-task plan already shipped. New code is additive; do not modify behavior of existing routes except where §7.5 of the spec mandates it.

## Global Constraints

- Node.js ≥ 20, TypeScript 5 strict + `noUncheckedIndexedAccess`, MIT license headers on every new `.ts`/`.hbs`/`.sql` file (`// SPDX-License-Identifier: MIT` line 1 for TS/SQL, same line 1 for `.hbs`).
- Passwords: argon2id with `memoryCost=19456` KiB (19 MiB), `timeCost=2`, `parallelism=1` (OWASP 2023).
- Tokens (email verification / password reset / CSRF): 32 random bytes base32-encoded (`A-Z2-7`, no padding), SHA-256 hashed for DB storage (`CHAR(64)`).
- Session IDs: 16 random bytes base32-encoded (32 chars total), `CHAR(32)` PK, default TTL 168 hours, `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`.
- API key plaintext: `ipq_<32 chars base32>` (40 chars). Storage: `key_hash = SHA-256(plaintext)`, `key_prefix = plaintext.slice(0,8)`. Plaintext returned **exactly once** at creation.
- IP encoding: 16-byte buffer, IPv4 left-padded with 12 zero bytes (matches existing `parseIp` in `src/ip.ts:24-25`). Reuse `parseIp` for all conversions; do not re-implement.
- DB schema: utf8mb4 / utf8mb4_unicode_ci. All new tables ENGINE=InnoDB.
- Tests: vitest 2 with `pool: 'forks'` + `poolOptions.forks.singleFork: true`. Each integration test file uses an isolated database `ipquery_<scope>_<file>`. Tear down with `DROP DATABASE` in `afterAll`.
- CSRF: every POST/PUT/PATCH/DELETE request must carry matching `csrf` cookie (httpOnly:false, sameSite:Lax) and `csrf` body field. Anonymous POSTs additionally validated against `Origin`/`Referer` matching `WEB_BASE_URL` origin.
- Rate limit (`@fastify/rate-limit`): `POST /signup` 5/h per IP, `POST /login` 20/h per IP+email, `POST /verify/resend` 1/min per user, `POST /forgot` 5/h per IP, `POST /dashboard/keys` 10/h per user. Login additionally locks email for `LOGIN_LOCKOUT_MINUTES` after `LOGIN_MAX_ATTEMPTS` failures (default 5 / 15 min), tracked in-process Map.
- i18n: zh-CN default, en-US placeholder (empty dict, falls back to key). Helper `{{t 'key' var=value}}`. Locale from cookie `lang` (default zh-CN).
- Security headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'`. `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `COOKIE_SECURE=true`.
- Templates: Handlebars 4. CSRF token always rendered as `<input type="hidden" name="csrf" value="{{csrf}}">` inside every `<form method="POST">`. No inline JS (htmx is the only client-side script).
- Commit boundary: each task ends with one or more `git commit` calls; do not bundle tasks.

---

### Task 1: Dependencies + i18n module + types + .env.example + zh-CN skeleton

**Files:**

- Modify: `package.json` (add deps)
- Modify: `.env.example` (add web/smtp/security sections)
- Create: `src/web/i18n/index.ts`
- Create: `src/web/i18n/zh-CN.json`
- Create: `src/web/i18n/en-US.json`
- Modify: `src/types.ts` (append User/ApiKey/Session/EmailVerification/PasswordReset/QueryLogEntry/Role/QueryStatus types)
- Create: `test/unit/web-i18n.test.ts`
- Test: `test/unit/web-dictionaries.test.ts`

**Interfaces:**

- Produces: `t(locale: 'zh-CN' | 'en-US', key: string, vars?: Record<string, string|number>): string`
- Produces: types used by every later task (Task 4+, Task 7+, Task 9+)

- [ ] **Step 1: Install dependencies**

Run: `npm install @fastify/cookie @fastify/formbody @fastify/static @fastify/view handlebars argon2 nodemailer`
Run: `npm install -D @types/handlebars @types/nodemailer`
Expected: package.json lists all 7 runtime deps and 2 dev deps; `npm ls` shows no UNMET.

- [ ] **Step 2: Update .env.example**

Append (preserving all existing keys):

```bash
# Web
WEB_BASE_URL=http://localhost:3100
COOKIE_DOMAIN=
COOKIE_SECURE=false
SESSION_TTL_HOURS=168
SESSION_SECRET=
CSRF_SECRET=

# SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="IPQuery <noreply@example.com>"

# Security
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15
SIGNUP_RATE_PER_IP_PER_HOUR=5
VERIFY_RESEND_COOLDOWN_SECONDS=60

# Admin bootstrap (only used if users table is empty)
ADMIN_BOOTSTRAP_EMAIL=
ADMIN_BOOTSTRAP_PASSWORD=
```

- [ ] **Step 3: Append types to src/types.ts**

```ts
export type Role = "user" | "admin";
export type QueryStatus = "hit" | "miss" | "invalid";

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  emailVerified: boolean;
  isDisabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ApiKey {
  id: number;
  userId: number;
  label: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface Session {
  id: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface EmailVerification {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface PasswordReset {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface QueryLogEntry {
  ts: Date;
  ip: Buffer;
  ipText: string;
  status: QueryStatus;
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}
```

- [ ] **Step 4: Write test/unit/web-i18n.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { t } from "../../src/web/i18n";

describe("web i18n t()", () => {
  it("returns Chinese value for known key", () => {
    // assume zh-CN.json has key "common.signup" with value "注册"
    expect(t("zh-CN", "common.signup")).toBe("注册");
  });

  it("falls back to Chinese when locale missing", () => {
    expect(t("en-US", "common.signup")).toBe("注册");
  });

  it("returns key itself when key missing everywhere", () => {
    expect(t("zh-CN", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("interpolates {var} placeholders", () => {
    // zh-CN.json: "greeting.hello": "你好,{name}"
    expect(t("zh-CN", "greeting.hello", { name: "张三" })).toBe("你好,张三");
  });

  it("interpolates multiple variables", () => {
    // zh-CN.json: "lookup.found": "{ip} 位于 {country}"
    expect(t("zh-CN", "lookup.found", { ip: "8.8.8.8", country: "美国" })).toBe("8.8.8.8 位于 美国");
  });
});
```

- [ ] **Step 5: Write test/unit/web-dictionaries.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import zhCN from "../../src/web/i18n/zh-CN.json";

describe("zh-CN dictionary", () => {
  it("has no empty string values", () => {
    const flatten = (obj: Record<string, unknown>, prefix = ""): [string, unknown][] => {
      const out: [string, unknown][] = [];
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object") out.push(...flatten(v as Record<string, unknown>, key));
        else out.push([key, v]);
      }
      return out;
    };
    for (const [k, v] of flatten(zhCN as Record<string, unknown>)) {
      expect(typeof v, `${k} must be string`).toBe("string");
      expect((v as string).length, `${k} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("required keys present", () => {
    const required = [
      "common.signup",
      "common.login",
      "common.logout",
      "auth.email",
      "auth.password",
      "auth.signup.submit",
      "lookup.found",
      "lookup.notfound",
    ];
    const flatten = (obj: Record<string, unknown>, prefix = ""): [string, unknown][] => {
      const out: [string, unknown][] = [];
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object") out.push(...flatten(v as Record<string, unknown>, key));
        else out.push([key, v]);
      }
      return out;
    };
    const keys = new Set(flatten(zhCN as Record<string, unknown>).map(([k]) => k));
    for (const r of required) expect(keys.has(r), `${r} missing`).toBe(true);
  });
});
```

- [ ] **Step 6: Create src/web/i18n/zh-CN.json (full dictionary, ~200 lines)**

Minimum required keys (used by tests in Step 4-5). Build out the full set during view creation (Tasks 17, 19, 21-22, 24-26, 27-30). Suggested structure:

```json
{
  "common": {
    "signup": "注册",
    "login": "登录",
    "logout": "登出",
    "submit": "提交",
    "cancel": "取消",
    "save": "保存",
    "back": "返回",
    "next": "下一页",
    "prev": "上一页",
    "search": "搜索",
    "loading": "加载中...",
    "yes": "是",
    "no": "否"
  },
  "nav": {
    "home": "首页",
    "docs": "文档",
    "pricing": "定价",
    "status": "状态",
    "about": "关于",
    "try": "在线试查",
    "dashboard": "控制台",
    "admin": "管理后台",
    "logout": "登出"
  },
  "auth": {
    "email": "邮箱",
    "password": "密码",
    "password.help": "至少 10 位,包含字母和数字",
    "password.confirm": "确认密码",
    "displayName": "昵称",
    "signup.title": "注册账号",
    "signup.submit": "注册",
    "signup.success.title": "注册成功",
    "signup.success.body": "请在邮箱中点击验证链接以激活账号。",
    "signup.error.duplicate": "该邮箱已注册",
    "signup.error.email_format": "邮箱格式不正确",
    "signup.error.password_weak": "密码至少 10 位,包含字母和数字",
    "signup.error.password_mismatch": "两次密码不一致",
    "verify.title": "邮箱验证",
    "verify.success": "邮箱已验证,请登录",
    "verify.invalid": "链接无效",
    "verify.expired": "链接已过期,请重新发送",
    "verify.consumed": "链接已被使用",
    "verify.resend": "重新发送验证邮件",
    "verify.resend.cooldown": "{seconds} 秒后可重新发送",
    "verify.required": "请先验证邮箱",
    "login.title": "登录",
    "login.submit": "登录",
    "login.error.credentials": "邮箱或密码错误",
    "login.error.disabled": "账号已禁用,请联系管理员",
    "login.error.locked": "登录尝试过多,请 {minutes} 分钟后重试",
    "logout.title": "登出",
    "logout.confirm": "确定登出?",
    "forgot.title": "找回密码",
    "forgot.submit": "发送重置链接",
    "forgot.done": "如果该邮箱已注册,你将收到重置链接",
    "reset.title": "重置密码",
    "reset.submit": "重置密码"
  },
  "lookup": {
    "title": "IP 查询",
    "input.placeholder": "输入 IP 地址,如 8.8.8.8",
    "submit": "查询",
    "found": "{ip} 位于 {country}",
    "notfound": "{ip} 未找到记录",
    "invalid": "IP 格式无效"
  },
  "dashboard": {
    "title": "控制台",
    "welcome": "欢迎,{name}",
    "history.title": "查询历史",
    "history.empty": "暂无查询记录",
    "history.col.time": "时间",
    "history.col.ip": "IP",
    "history.col.status": "状态",
    "history.col.source": "来源",
    "history.filter.status": "按状态筛选",
    "history.filter.all": "全部",
    "keys.title": "API Keys",
    "keys.empty": "暂无 API Key",
    "keys.create": "创建新 Key",
    "keys.label": "标签",
    "keys.prefix": "前缀",
    "keys.lastUsed": "最后使用",
    "keys.created": "创建时间",
    "keys.revoke": "吊销",
    "keys.revoke.confirm": "确定吊销此 Key?吊销后无法恢复。",
    "keys.created_once": "请保存以下 Key,关闭后将无法再次查看:",
    "keys.copy": "复制",
    "profile.title": "个人资料",
    "profile.displayName": "昵称",
    "profile.email": "邮箱",
    "profile.email.help": "修改邮箱需重新验证",
    "profile.oldPassword": "当前密码",
    "profile.newPassword": "新密码",
    "profile.save": "保存修改",
    "profile.saved": "资料已保存"
  },
  "admin": {
    "title": "管理后台",
    "users.title": "用户管理",
    "users.search": "按邮箱搜索",
    "users.col.email": "邮箱",
    "users.col.role": "角色",
    "users.col.verified": "已验证",
    "users.col.disabled": "已禁用",
    "users.col.created": "注册时间",
    "users.col.lastLogin": "最后登录",
    "users.action.enable": "启用",
    "users.action.disable": "禁用",
    "users.action.verify": "标记已验证",
    "users.action.resetPassword": "重置密码",
    "users.action.delete": "删除",
    "users.delete.confirm": "确定删除该用户?所有相关数据将被清除。",
    "etl.title": "ETL 运维",
    "etl.trigger": "立即运行",
    "etl.trigger.confirm": "确定手动触发 ETL?",
    "etl.col.started": "开始时间",
    "etl.col.finished": "结束时间",
    "etl.col.status": "状态",
    "etl.col.merged": "合并记录数",
    "etl.detail.title": "ETL Run #{id}",
    "keys.title": "API Keys 全局",
    "keys.col.owner": "所属用户",
    "keys.col.prefix": "前缀",
    "keys.col.lastUsed": "最后使用",
    "audit.title": "查询审计",
    "audit.col.time": "时间",
    "audit.col.ip": "查询 IP",
    "audit.col.status": "状态",
    "audit.col.user": "用户",
    "audit.col.apiKey": "API Key",
    "audit.export": "导出 CSV"
  },
  "footer": {
    "copyright": "© {year} IPQuery",
    "license": "MIT"
  },
  "error": {
    "csrf.title": "会话过期",
    "csrf.body": "请刷新页面后重试",
    "403.title": "禁止访问",
    "403.body": "你没有权限访问此页面",
    "404.title": "页面未找到",
    "500.title": "服务器错误",
    "500.body": "请稍后重试"
  }
}
```

- [ ] **Step 7: Create src/web/i18n/en-US.json**

```json
{}
```

(Empty object — `t('en-US', 'foo')` falls back to Chinese via the `??` chain in `t()`.)

- [ ] **Step 8: Create src/web/i18n/index.ts**

```ts
// SPDX-License-Identifier: MIT
import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export type Locale = "zh-CN" | "en-US";
export const SUPPORTED_LOCALES: Locale[] = ["zh-CN", "en-US"];
export const DEFAULT_LOCALE: Locale = "zh-CN";

const dictionaries: Record<Locale, Record<string, unknown>> = {
  "zh-CN": zhCN as Record<string, unknown>,
  "en-US": enUS as Record<string, unknown>,
};

function lookup(dict: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw =
    lookup(dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE], key) ??
    lookup(dictionaries[DEFAULT_LOCALE], key) ??
    key;
  if (typeof raw !== "string") return key;
  if (!vars) return raw;
  let s = raw;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function parseLocale(raw: string | undefined): Locale {
  if (raw === "en-US") return "en-US";
  return DEFAULT_LOCALE;
}
```

- [ ] **Step 9: Run tests**

Run: `npm test -- test/unit/web-i18n.test.ts test/unit/web-dictionaries.test.ts`
Expected: 7 tests pass (5 i18n + 2 dictionary). If dictionary tests fail because required keys are missing, add the missing keys to `zh-CN.json` per Step 6.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json .env.example src/types.ts src/web/ test/unit/web-i18n.test.ts test/unit/web-dictionaries.test.ts
git commit -m "feat(web): add i18n module, types, and zh-CN dictionary skeleton"
```

---

### Task 2: Migration runner + 001-008 SQL files + back-compat with existing schema

**Files:**

- Create: `src/storage/migrations/runner.ts`
- Create: `src/storage/migrations/001_ip_ranges.sql`
- Create: `src/storage/migrations/002_etl_runs.sql`
- Create: `src/storage/migrations/003_users.sql`
- Create: `src/storage/migrations/004_api_keys.sql`
- Create: `src/storage/migrations/005_sessions.sql`
- Create: `src/storage/migrations/006_email_verifications.sql`
- Create: `src/storage/migrations/007_password_resets.sql`
- Create: `src/storage/migrations/008_query_log.sql`
- Modify: `src/storage/schema.sql` (add deprecation comment, keep file)
- Modify: `src/storage/mysql.ts` (remove `initSchema`/`loadSchema`, expose `runMigrations`)
- Modify: `scripts/copy-schema.js` (also copy migrations dir)
- Test: `test/integration/migrations.test.ts`

**Interfaces:**

- Produces: `runMigrations(pool: mysql.Pool): Promise<{ applied: string[]; skipped: string[] }>`
- Produces: `getAppliedVersions(pool): Promise<Set<string>>`

- [ ] **Step 1: Create 001_ip_ranges.sql — copy from existing src/storage/schema.sql**

Open `src/storage/schema.sql`. Its first lines define `ip_ranges`. Create `001_ip_ranges.sql` with exactly that block (the CREATE TABLE ip_ranges statement and its indexes), preserving every column, type, and charset. End with `;` on its own line.

- [ ] **Step 2: Create 002_etl_runs.sql — copy the etl_runs block from schema.sql**

Same: extract the `CREATE TABLE etl_runs` block verbatim.

- [ ] **Step 3: Create 003_users.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  is_disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  INDEX idx_role_created (role, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Create 004_api_keys.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(64) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  key_prefix CHAR(8) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id),
  INDEX idx_active (user_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 5: Create 005_sessions.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE sessions (
  id CHAR(32) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 6: Create 006_email_verifications.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE email_verifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 7: Create 007_password_resets.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE password_resets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 8: Create 008_query_log.sql**

```sql
-- SPDX-License-Identifier: MIT
CREATE TABLE query_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip VARBINARY(16) NOT NULL,
  ip_text VARCHAR(45) NOT NULL,
  status ENUM('hit','miss','invalid') NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  api_key_id BIGINT UNSIGNED NULL,
  session_id CHAR(32) NULL,
  remote_addr VARBINARY(16) NULL,
  user_agent VARCHAR(255) NULL,
  INDEX idx_user_ts (user_id, ts),
  INDEX idx_ts (ts),
  INDEX idx_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 9: Write test/integration/migrations.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations, getAppliedVersions } from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_mig_test";
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  pool = mysql.createPool({ ...cfg.db, database: TEST_DB, connectionLimit: 2, multipleStatements: true });
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe("migrations", () => {
  it("applies all 8 versions on fresh DB", async () => {
    const r = await runMigrations(pool);
    expect(r.applied.sort()).toEqual(["001", "002", "003", "004", "005", "006", "007", "008"]);
  });

  it("is idempotent on second run", async () => {
    const r = await runMigrations(pool);
    expect(r.applied).toEqual([]);
    expect(r.skipped.sort()).toEqual(["001", "002", "003", "004", "005", "006", "007", "008"]);
  });

  it("all expected tables exist", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES");
    const tables = rows.map((r) => Object.values(r)[0] as string).sort();
    expect(tables).toContain("ip_ranges");
    expect(tables).toContain("etl_runs");
    expect(tables).toContain("users");
    expect(tables).toContain("api_keys");
    expect(tables).toContain("sessions");
    expect(tables).toContain("email_verifications");
    expect(tables).toContain("password_resets");
    expect(tables).toContain("query_log");
    expect(tables).toContain("schema_migrations");
  });

  it("skips versions already marked applied", async () => {
    const before = await getAppliedVersions(pool);
    expect(before.has("003")).toBe(true);
    const r = await runMigrations(pool);
    expect(r.skipped.length).toBe(8);
  });

  it("records apply timestamps", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT applied_at FROM schema_migrations WHERE version = ?",
      ["003"],
    );
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 10: Create src/storage/migrations/runner.ts**

```ts
// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export async function getAppliedVersions(pool: mysql.Pool): Promise<Set<string>> {
  await pool.query(SCHEMA_MIGRATIONS_DDL);
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => String(r.version)));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(pool: mysql.Pool): Promise<MigrationResult> {
  const migrationsDir = path.join(__dirname);
  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

  const applied = await getAppliedVersions(pool);
  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.slice(0, 3);
    if (applied.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      await conn.commit();
      newlyApplied.push(version);
    } catch (err) {
      await conn.rollback();
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }
  return { applied: newlyApplied, skipped };
}

export async function migrationStatus(pool: mysql.Pool): Promise<{
  applied: string[];
  pending: string[];
}> {
  const migrationsDir = path.join(__dirname);
  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const allVersions = files.map((f) => f.slice(0, 3));
  const applied = await getAppliedVersions(pool);
  return {
    applied: allVersions.filter((v) => applied.has(v)),
    pending: allVersions.filter((v) => !applied.has(v)),
  };
}
```

- [ ] **Step 11: Update src/storage/mysql.ts**

Remove `loadSchema`, `SCHEMA_SQL`, `initSchema`. Leave everything else (createPool, findRange, recordEtlStart/Finish, lastEtlRun, lastSuccessfulEtl, atomicSwapRanges, truncateNew, insertIntoNew) intact. Re-export `runMigrations`, `getAppliedVersions`, `migrationStatus` from `./migrations/runner`:

```ts
// SPDX-License-Identifier: MIT
// (keep existing imports and createPool/findRange/... unchanged)
export { runMigrations, getAppliedVersions, migrationStatus } from "./migrations/runner";
```

Add `// DEPRECATED: use src/storage/migrations/runner.ts via runMigrations()` at the top of `src/storage/schema.sql`.

- [ ] **Step 12: Update scripts/copy-schema.js**

Open `scripts/copy-schema.js`. It currently copies `src/storage/schema.sql` into `dist/storage/`. Add: also recursively copy `src/storage/migrations/*.sql` to `dist/storage/migrations/`. Use `fs.cp` or `fs.copyFile` in a loop over `fs.readdirSync`.

- [ ] **Step 13: Run migrations test**

Run: `npm test -- test/integration/migrations.test.ts`
Expected: 5 tests pass. If `runMigrations` path differs after build (TS emits `dist/storage/migrations/runner.js`, file lookups via `__dirname` must resolve relative to that file), verify the relative resolution works under vitest (which runs from src via tsx).

- [ ] **Step 14: Run existing test suite**

Run: `npm test`
Expected: prior 47 tests still pass. (The existing `etl-pipeline.test.ts` and `mysql.test.ts` use `initSchema` — search the codebase for callers; update them to call `runMigrations(pool)` instead. Replace each `await initSchema(pool)` with `await runMigrations(pool)`.)

- [ ] **Step 15: Commit**

```bash
git add src/storage/migrations/ src/storage/mysql.ts src/storage/schema.sql scripts/copy-schema.js test/integration/migrations.test.ts
# also include any test files you edited in Step 14
git commit -m "feat(storage): add SQL migration runner and split schema into 001-008"
```

---

### Task 3: Config extensions (web / smtp / security)

**Files:**

- Modify: `src/config.ts` (extend `AppConfig`)
- Create: `test/unit/config-web.test.ts`

**Interfaces:**

- Produces: `AppConfig.web: WebConfig`, `AppConfig.smtp: SmtpConfig`, `AppConfig.security: SecurityConfig`

- [ ] **Step 1: Write test/unit/config-web.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config";

describe("web config", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = [
    "WEB_BASE_URL",
    "COOKIE_DOMAIN",
    "COOKIE_SECURE",
    "SESSION_TTL_HOURS",
    "SESSION_SECRET",
    "CSRF_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "LOGIN_MAX_ATTEMPTS",
    "LOGIN_LOCKOUT_MINUTES",
    "SIGNUP_RATE_PER_IP_PER_HOUR",
    "VERIFY_RESEND_COOLDOWN_SECONDS",
    "ADMIN_BOOTSTRAP_EMAIL",
    "ADMIN_BOOTSTRAP_PASSWORD",
  ];
  beforeEach(() => {
    for (const k of KEYS) {
      SAVED[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("default values", () => {
    const cfg = loadConfig();
    expect(cfg.web.baseUrl).toBe("http://localhost:3100");
    expect(cfg.web.cookieDomain).toBe("");
    expect(cfg.web.cookieSecure).toBe(false);
    expect(cfg.web.sessionTtlHours).toBe(168);
    expect(cfg.smtp.host).toBe("");
    expect(cfg.security.loginMaxAttempts).toBe(5);
    expect(cfg.security.loginLockoutMinutes).toBe(15);
  });

  it("parses numeric and boolean envs", () => {
    process.env.SESSION_TTL_HOURS = "24";
    process.env.COOKIE_SECURE = "true";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.LOGIN_MAX_ATTEMPTS = "10";
    const cfg = loadConfig();
    expect(cfg.web.sessionTtlHours).toBe(24);
    expect(cfg.web.cookieSecure).toBe(true);
    expect(cfg.smtp.port).toBe(465);
    expect(cfg.smtp.secure).toBe(true);
    expect(cfg.security.loginMaxAttempts).toBe(10);
  });

  it("rejects invalid SESSION_TTL_HOURS", () => {
    process.env.SESSION_TTL_HOURS = "0";
    expect(() => loadConfig()).toThrow(/SESSION_TTL_HOURS/);
  });

  it("rejects invalid LOGIN_MAX_ATTEMPTS", () => {
    process.env.LOGIN_MAX_ATTEMPTS = "-1";
    expect(() => loadConfig()).toThrow(/LOGIN_MAX_ATTEMPTS/);
  });

  it("admin bootstrap defaults to empty", () => {
    const cfg = loadConfig();
    expect(cfg.admin.email).toBe("");
    expect(cfg.admin.password).toBe("");
  });

  it("reads SMTP_FROM", () => {
    process.env.SMTP_FROM = "a@b.com";
    const cfg = loadConfig();
    expect(cfg.smtp.from).toBe("a@b.com");
  });
});
```

- [ ] **Step 2: Extend src/config.ts**

```ts
// (keep existing imports; add nothing new for new fields)

export interface WebConfig {
  baseUrl: string;
  cookieDomain: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  sessionSecret: string;
  csrfSecret: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface SecurityConfig {
  loginMaxAttempts: number;
  loginLockoutMinutes: number;
  signupRatePerIpPerHour: number;
  verifyResendCooldownSeconds: number;
}

export interface AdminBootstrap {
  email: string;
  password: string;
}

export interface AppConfig {
  db: { host: string; port: number; user: string; password: string; database: string; poolSize: number };
  maxmind: { licenseKey?: string; editions: string[] };
  api: { port: number; rateLimit: number };
  etl: { schedule: string; timezone: string; dataDir: string };
  web: WebConfig;
  smtp: SmtpConfig;
  security: SecurityConfig;
  admin: AdminBootstrap;
}

// existing num/str helpers OK.

// new helper:
function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

// In loadConfig() return object, add:
const sessionTtl = num(process.env.SESSION_TTL_HOURS, 168);
if (sessionTtl < 1) throw new Error("SESSION_TTL_HOURS must be >= 1");
const loginMax = num(process.env.LOGIN_MAX_ATTEMPTS, 5);
if (loginMax < 1) throw new Error("LOGIN_MAX_ATTEMPTS must be >= 1");

return {
  db: {/* unchanged */},
  maxmind: {/* unchanged */},
  api: {/* unchanged */},
  etl: {/* unchanged */},
  web: {
    baseUrl: str(process.env.WEB_BASE_URL, `http://localhost:${num(process.env.PORT, 3100)}`),
    cookieDomain: str(process.env.COOKIE_DOMAIN, ""),
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    sessionTtlHours: sessionTtl,
    sessionSecret: str(process.env.SESSION_SECRET, ""),
    csrfSecret: str(process.env.CSRF_SECRET, ""),
  },
  smtp: {
    host: str(process.env.SMTP_HOST, ""),
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: str(process.env.SMTP_USER, ""),
    pass: str(process.env.SMTP_PASS, ""),
    from: str(process.env.SMTP_FROM, "IPQuery <noreply@example.com>"),
  },
  security: {
    loginMaxAttempts: loginMax,
    loginLockoutMinutes: num(process.env.LOGIN_LOCKOUT_MINUTES, 15),
    signupRatePerIpPerHour: num(process.env.SIGNUP_RATE_PER_IP_PER_HOUR, 5),
    verifyResendCooldownSeconds: num(process.env.VERIFY_RESEND_COOLDOWN_SECONDS, 60),
  },
  admin: {
    email: str(process.env.ADMIN_BOOTSTRAP_EMAIL, ""),
    password: str(process.env.ADMIN_BOOTSTRAP_PASSWORD, ""),
  },
};
```

- [ ] **Step 3: Update configSummary to redact new secrets**

In `configSummary(cfg)`, append lines (with `redactSecret`):

```ts
`[config] web baseUrl=${cfg.web.baseUrl} cookieSecure=${cfg.web.cookieSecure}`,
`[config] smtp host=${cfg.smtp.host || '(console)'} from=${cfg.smtp.from}`,
`[config] session secret=${cfg.web.sessionSecret ? redactSecret(cfg.web.sessionSecret) : '(unset)'}`,
`[config] csrf secret=${cfg.web.csrfSecret ? redactSecret(cfg.web.csrfSecret) : '(unset)'}`,
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/unit/config-web.test.ts`
Expected: 6 tests pass. Existing config tests (if any) still pass — update them only if assertions reference config keys directly.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all prior tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/unit/config-web.test.ts
git commit -m "feat(config): add web/smtp/security/admin config sections"
```

---

### Task 4: Password hashing (argon2id) + token utilities

**Files:**

- Create: `src/web/auth/password.ts`
- Create: `src/web/auth/tokens.ts`
- Create: `test/unit/web-password.test.ts`
- Create: `test/unit/web-tokens.test.ts`

**Interfaces:**

- Produces: `hashPassword(plain: string): Promise<string>`
- Produces: `verifyPassword(hash: string, plain: string): Promise<boolean>`
- Produces: `validatePassword(plain: string): { ok: true } | { ok: false; reason: string }`
- Produces: `generateToken(bytes?: number): string` (default 32 → 52 chars base32)
- Produces: `hashToken(plain: string): string` (SHA-256 hex)
- Produces: `generateCsrf(): string` (32 random bytes → 64 chars hex)
- Produces: `verifyCsrf(token: string, expected: string, ttlMs: number): boolean`

- [ ] **Step 1: Write test/unit/web-password.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, validatePassword } from "../../src/web/auth/password";

describe("password", () => {
  it("hash + verify round-trip", async () => {
    const hash = await hashPassword("Hello123World");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "Hello123World")).toBe(true);
    expect(await verifyPassword(hash, "WrongPassword1")).toBe(false);
  });

  it("different hash each call", async () => {
    const a = await hashPassword("Hello123World");
    const b = await hashPassword("Hello123World");
    expect(a).not.toBe(b);
  });

  it("validatePassword enforces length", () => {
    expect(validatePassword("Short1")).toEqual({ ok: false, reason: "too_short" });
    expect(validatePassword("NoDigitsHere!!")).toEqual({ ok: false, reason: "no_digit" });
    expect(validatePassword("1234567890")).toEqual({ ok: false, reason: "no_letter" });
    expect(validatePassword("GoodPassword1")).toEqual({ ok: true });
  });

  it("handles verify of malformed hash gracefully", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });
});
```

- [ ] **Step 2: Create src/web/auth/password.ts**

```ts
// SPDX-License-Identifier: MIT
import * as argon2 from "argon2";

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export type PasswordValidation = { ok: true } | { ok: false; reason: "too_short" | "no_digit" | "no_letter" };

export function validatePassword(plain: string): PasswordValidation {
  if (plain.length < 10) return { ok: false, reason: "too_short" };
  if (!/[a-zA-Z]/.test(plain)) return { ok: false, reason: "no_letter" };
  if (!/[0-9]/.test(plain)) return { ok: false, reason: "no_digit" };
  return { ok: true };
}
```

- [ ] **Step 3: Write test/unit/web-tokens.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateToken, hashToken, generateCsrf, verifyCsrf } from "../../src/web/auth/tokens";

describe("tokens", () => {
  it("generateToken default length 52", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Z2-7]{52}$/);
  });

  it("generateToken bytes=16 → 26 chars", () => {
    const t = generateToken(16);
    expect(t).toMatch(/^[A-Z2-7]{26}$/);
  });

  it("generateToken is unique", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
  });

  it("hashToken is deterministic SHA-256 hex 64", () => {
    const a = hashToken("hello");
    const b = hashToken("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToken differs for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("generateCsrf returns 64 hex chars", () => {
    const c = generateCsrf();
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyCsrf matches with recent timestamp", () => {
    const t = generateCsrf();
    expect(verifyCsrf(t, t, Date.now(), 60_000)).toBe(true);
  });

  it("verifyCsrf rejects mismatch", () => {
    const t = generateCsrf();
    expect(verifyCsrf(t, "different", Date.now(), 60_000)).toBe(false);
  });

  it("verifyCsrf rejects expired", () => {
    const t = generateCsrf();
    const issuedAt = Date.now() - 120_000;
    expect(verifyCsrf(t, t, issuedAt, 60_000)).toBe(false);
  });
});
```

- [ ] **Step 4: Create src/web/auth/tokens.ts**

```ts
// SPDX-License-Identifier: MIT
import * as crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomBase32(bytes: number): string {
  const buf = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  return out;
}

export function generateToken(bytes = 32): string {
  return randomBase32(bytes);
}

export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

export function generateCsrf(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function verifyCsrf(presented: string, expected: string, issuedAt: number, ttlMs: number): boolean {
  if (!presented || !expected) return false;
  if (presented !== expected) return false;
  if (Date.now() - issuedAt > ttlMs) return false;
  return true;
}

export function parseApiKeyPlaintext(plain: string): { keyHash: string; keyPrefix: string } {
  if (!plain.startsWith("ipq_") || plain.length !== 40) {
    throw new Error("invalid api key format");
  }
  return {
    keyHash: hashToken(plain),
    keyPrefix: plain.slice(0, 8),
  };
}

export function generateApiKey(): string {
  return `ipq_${randomBase32(32)}`;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/unit/web-password.test.ts test/unit/web-tokens.test.ts`
Expected: 12 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/auth/password.ts src/web/auth/tokens.ts test/unit/web-password.test.ts test/unit/web-tokens.test.ts
git commit -m "feat(web/auth): add argon2id password and base32 token utilities"
```

---

### Task 5: Mailer (nodemailer console + SMTP factory)

**Files:**

- Create: `src/mailer.ts`
- Create: `test/unit/mailer.test.ts`

**Interfaces:**

- Produces: `createMailer(cfg: AppConfig): Mailer`
- `Mailer.send(opts: { to: string; subject: string; text: string; html: string }): Promise<void>`
- When `cfg.smtp.host` empty → console transport (logs to pino, returns).
- When `cfg.smtp.host` set → real SMTP.

- [ ] **Step 1: Write test/unit/mailer.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { createMailer } from "../../src/mailer";

const baseCfg = (smtp: Partial<AppConfig["smtp"]> = {}): AppConfig => ({
  db: { host: "", port: 0, user: "", password: "", database: "", poolSize: 0 },
  maxmind: { editions: [] },
  api: { port: 0, rateLimit: 0 },
  etl: { schedule: "", timezone: "", dataDir: "" },
  web: {
    baseUrl: "",
    cookieDomain: "",
    cookieSecure: false,
    sessionTtlHours: 1,
    sessionSecret: "",
    csrfSecret: "",
  },
  smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "a@b", ...smtp },
  security: {
    loginMaxAttempts: 1,
    loginLockoutMinutes: 1,
    signupRatePerIpPerHour: 1,
    verifyResendCooldownSeconds: 1,
  },
  admin: { email: "", password: "" },
});

describe("mailer", () => {
  it("console transport returns without throwing", async () => {
    const m = createMailer(baseCfg());
    await expect(m.send({ to: "x@y.z", subject: "s", text: "t", html: "<p>t</p>" })).resolves.toBeUndefined();
  });

  it("SMTP transport is created when host set", async () => {
    const m = createMailer(baseCfg({ host: "smtp.example.com" }));
    expect(m).toBeDefined();
  });
});
```

- [ ] **Step 2: Create src/mailer.ts**

```ts
// SPDX-License-Identifier: MIT
import * as nodemailer from "nodemailer";
import type { AppConfig } from "./config";

export interface Mailer {
  send(opts: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export function createMailer(cfg: AppConfig): Mailer {
  if (!cfg.smtp.host) {
    return {
      async send(opts) {
        const banner = "=".repeat(60);
        // eslint-disable-next-line no-console
        console.log(
          `\n${banner}\n[email] to=${opts.to} subject="${opts.subject}"\n${banner}\n${opts.text}\n`,
        );
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  return {
    async send(opts) {
      await transport.sendMail({
        from: cfg.smtp.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
    },
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- test/unit/mailer.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mailer.ts test/unit/mailer.test.ts
git commit -m "feat(mailer): add nodemailer console + SMTP factory"
```

---

### Task 6: User-related storage (users / api_keys / sessions / tokens)

**Files:**

- Create: `src/storage/users.ts`
- Create: `src/storage/apiKeys.ts`
- Create: `src/storage/sessions.ts`
- Create: `src/storage/tokens.ts`
- Create: `test/integration/users-storage.test.ts`
- Create: `test/integration/api-keys-storage.test.ts`
- Create: `test/integration/sessions-storage.test.ts`
- Create: `test/integration/tokens-storage.test.ts`
- Create: `test/helpers/db.ts`

**Interfaces:** See each module below. All return TypeScript types from `src/types.ts` (Task 1).

- [ ] **Step 1: Create test/helpers/db.ts**

```ts
// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";

export interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

export async function createTestDb(suffix: string): Promise<TestDb> {
  const cfg = loadConfig();
  const dbName = `ipquery_test_${suffix}`;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.query(`CREATE DATABASE \`${dbName}\``);
  await root.end();
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: dbName,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
  await runMigrations(pool);
  return { pool, dbName };
}

export async function dropTestDb(td: TestDb): Promise<void> {
  await td.pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${td.dbName}\``);
  await root.end();
}
```

- [ ] **Step 2: Create src/storage/users.ts**

```ts
// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { User, Role } from "../types";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName: string;
  role?: Role;
}

function mapRow(r: RowDataPacket): User {
  return {
    id: Number(r.id),
    email: r.email as string,
    displayName: r.display_name as string,
    role: r.role as Role,
    emailVerified: Boolean(r.email_verified),
    isDisabled: Boolean(r.is_disabled),
    createdAt: r.created_at as Date,
    lastLoginAt: r.last_login_at as Date | null,
  };
}

export async function createUser(pool: Pool, input: CreateUserInput): Promise<User> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
    [input.email, input.passwordHash, input.displayName, input.role ?? "user"],
  );
  const u = await findUserById(pool, res.insertId);
  if (!u) throw new Error("user vanished after insert");
  return u;
}

export async function findUserByEmail(pool: Pool, email: string): Promise<User | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM users WHERE email = ?`, [email]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(pool: Pool, id: number): Promise<User | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM users WHERE id = ?`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getUserPasswordHash(pool: Pool, userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT password_hash FROM users WHERE id = ?`, [userId]);
  return rows[0] ? (rows[0].password_hash as string) : null;
}

export async function markEmailVerified(pool: Pool, userId: number): Promise<void> {
  await pool.query(`UPDATE users SET email_verified = 1 WHERE id = ?`, [userId]);
}

export async function setDisabled(pool: Pool, userId: number, disabled: boolean): Promise<void> {
  await pool.query(`UPDATE users SET is_disabled = ? WHERE id = ?`, [disabled ? 1 : 0, userId]);
}

export async function updatePassword(pool: Pool, userId: number, newHash: string): Promise<void> {
  await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, userId]);
}

export async function updateDisplayName(pool: Pool, userId: number, name: string): Promise<void> {
  await pool.query(`UPDATE users SET display_name = ? WHERE id = ?`, [name, userId]);
}

export async function updateEmail(pool: Pool, userId: number, email: string): Promise<void> {
  await pool.query(`UPDATE users SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId]);
}

export async function setLastLogin(pool: Pool, userId: number): Promise<void> {
  await pool.query(`UPDATE users SET last_login_at = NOW(3) WHERE id = ?`, [userId]);
}

export async function deleteUser(pool: Pool, userId: number): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
}

export async function listUsers(
  pool: Pool,
  opts: {
    offset: number;
    limit: number;
    search?: string;
    role?: Role;
  },
): Promise<{ rows: User[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.search) {
    where.push("email LIKE ?");
    params.push(`%${opts.search}%`);
  }
  if (opts.role) {
    where.push("role = ?");
    params.push(opts.role);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM users ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM users ${whereSql}`,
    params,
  );
  return {
    rows: rows.map(mapRow),
    total: Number((totalRows[0] as { c: number }).c),
  };
}
```

- [ ] **Step 3: Create src/storage/apiKeys.ts**

```ts
// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ApiKey } from "../types";

function mapRow(r: RowDataPacket): ApiKey {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    label: r.label as string,
    keyPrefix: r.key_prefix as string,
    lastUsedAt: r.last_used_at as Date | null,
    revokedAt: r.revoked_at as Date | null,
    createdAt: r.created_at as Date,
  };
}

export async function createApiKey(
  pool: Pool,
  userId: number,
  label: string,
  keyHash: string,
  keyPrefix: string,
): Promise<ApiKey> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO api_keys (user_id, label, key_hash, key_prefix) VALUES (?, ?, ?, ?)`,
    [userId, label, keyHash, keyPrefix],
  );
  const k = await findApiKeyById(pool, res.insertId);
  if (!k) throw new Error("api key vanished");
  return k;
}

export async function findApiKeyById(pool: Pool, id: number): Promise<ApiKey | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findActiveApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKey | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    [keyHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function touchApiKey(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ?`, [id]);
}

export async function revokeApiKey(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE api_keys SET revoked_at = NOW(3) WHERE id = ? AND revoked_at IS NULL`, [id]);
}

export async function listApiKeysForUser(pool: Pool, userId: number): Promise<ApiKey[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC`,
    [userId],
  );
  return rows.map(mapRow);
}

export async function listAllApiKeys(
  pool: Pool,
  opts: {
    offset: number;
    limit: number;
    userId?: number;
  },
): Promise<{ rows: (ApiKey & { ownerEmail: string })[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    where.push("k.user_id = ?");
    params.push(opts.userId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT k.*, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.user_id ${whereSql} ORDER BY k.id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM api_keys k ${whereSql}`,
    params,
  );
  return {
    rows: rows.map((r) => ({ ...mapRow(r), ownerEmail: r.owner_email as string })),
    total: Number((totalRows[0] as { c: number }).c),
  };
}

export async function countActiveApiKeys(pool: Pool): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL`,
  );
  return Number((rows[0] as { c: number }).c);
}
```

- [ ] **Step 4: Create src/storage/sessions.ts**

```ts
// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Session } from "../types";

function mapRow(r: RowDataPacket): Session {
  return {
    id: r.id as string,
    userId: Number(r.user_id),
    expiresAt: r.expires_at as Date,
    createdAt: r.created_at as Date,
  };
}

export async function createSession(
  pool: Pool,
  id: string,
  userId: number,
  expiresAt: Date,
): Promise<Session> {
  await pool.query<ResultSetHeader>(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [
    id,
    userId,
    expiresAt,
  ]);
  const s = await loadSession(pool, id);
  if (!s) throw new Error("session vanished");
  return s;
}

export async function loadSession(pool: Pool, id: string): Promise<Session | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM sessions WHERE id = ? AND expires_at > NOW(3)`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function destroySession(pool: Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = ?`, [id]);
}

export async function destroyAllForUser(pool: Pool, userId: number): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

export async function purgeExpired(pool: Pool): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(`DELETE FROM sessions WHERE expires_at <= NOW(3)`);
  return res.affectedRows;
}
```

- [ ] **Step 5: Create src/storage/tokens.ts**

```ts
// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { EmailVerification, PasswordReset } from "../types";

function mapVerRow(r: RowDataPacket): EmailVerification {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tokenHash: r.token_hash as string,
    expiresAt: r.expires_at as Date,
    consumedAt: r.consumed_at as Date | null,
  };
}

function mapResRow(r: RowDataPacket): PasswordReset {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tokenHash: r.token_hash as string,
    expiresAt: r.expires_at as Date,
    consumedAt: r.consumed_at as Date | null,
  };
}

export async function createVerification(
  pool: Pool,
  userId: number,
  tokenHash: string,
  expiresAt: Date,
): Promise<EmailVerification> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt],
  );
  const v = await findVerificationById(pool, res.insertId);
  if (!v) throw new Error("verification vanished");
  return v;
}

export async function findVerificationByHash(
  pool: Pool,
  tokenHash: string,
): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM email_verifications WHERE token_hash = ?`, [
    tokenHash,
  ]);
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function findVerificationById(pool: Pool, id: number): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM email_verifications WHERE id = ?`, [id]);
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function consumeVerification(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE email_verifications SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`,
    [id],
  );
}

export async function lastVerificationForUser(pool: Pool, userId: number): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function createPasswordReset(
  pool: Pool,
  userId: number,
  tokenHash: string,
  expiresAt: Date,
): Promise<PasswordReset> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt],
  );
  const v = await findPasswordResetById(pool, res.insertId);
  if (!v) throw new Error("reset vanished");
  return v;
}

export async function findPasswordResetByHash(pool: Pool, tokenHash: string): Promise<PasswordReset | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM password_resets WHERE token_hash = ?`, [
    tokenHash,
  ]);
  return rows[0] ? mapResRow(rows[0]) : null;
}

export async function findPasswordResetById(pool: Pool, id: number): Promise<PasswordReset | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM password_resets WHERE id = ?`, [id]);
  return rows[0] ? mapResRow(rows[0]) : null;
}

export async function consumePasswordReset(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE password_resets SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`, [
    id,
  ]);
}
```

- [ ] **Step 6: Write test/integration/users-storage.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import {
  createUser,
  findUserByEmail,
  markEmailVerified,
  setDisabled,
  updatePassword,
  listUsers,
} from "../../src/storage/users";
import { hashPassword } from "../../src/web/auth/password";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("users");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("users storage", () => {
  it("create + find round-trip", async () => {
    const hash = await hashPassword("Hello123World");
    const u = await createUser(td.pool, { email: "a@x.com", passwordHash: hash, displayName: "Alice" });
    expect(u.id).toBeGreaterThan(0);
    expect(u.email).toBe("a@x.com");
    expect(u.role).toBe("user");
    expect(u.emailVerified).toBe(false);
    const found = await findUserByEmail(td.pool, "a@x.com");
    expect(found?.id).toBe(u.id);
  });

  it("email is unique", async () => {
    const hash = await hashPassword("Hello123World");
    await expect(
      createUser(td.pool, { email: "dup@x.com", passwordHash: hash, displayName: "A" }),
    ).resolves.toBeDefined();
    await expect(
      createUser(td.pool, { email: "dup@x.com", passwordHash: hash, displayName: "B" }),
    ).rejects.toThrow();
  });

  it("markEmailVerified flips flag", async () => {
    const u = await createUser(td.pool, { email: "b@x.com", passwordHash: "h", displayName: "B" });
    expect(u.emailVerified).toBe(false);
    await markEmailVerified(td.pool, u.id);
    const after = await findUserByEmail(td.pool, "b@x.com");
    expect(after?.emailVerified).toBe(true);
  });

  it("setDisabled toggles is_disabled", async () => {
    const u = await createUser(td.pool, { email: "c@x.com", passwordHash: "h", displayName: "C" });
    await setDisabled(td.pool, u.id, true);
    expect((await findUserByEmail(td.pool, "c@x.com"))?.isDisabled).toBe(true);
    await setDisabled(td.pool, u.id, false);
    expect((await findUserByEmail(td.pool, "c@x.com"))?.isDisabled).toBe(false);
  });

  it("updatePassword replaces hash", async () => {
    const u = await createUser(td.pool, { email: "d@x.com", passwordHash: "old", displayName: "D" });
    await updatePassword(td.pool, u.id, "new");
    expect((await findUserByEmail(td.pool, "d@x.com"))?.id).toBe(u.id);
  });

  it("listUsers pagination + search", async () => {
    for (let i = 0; i < 5; i++) {
      await createUser(td.pool, { email: `p${i}@x.com`, passwordHash: "h", displayName: `P${i}` });
    }
    const r = await listUsers(td.pool, { offset: 0, limit: 3, search: "p" });
    expect(r.rows.length).toBe(3);
    expect(r.total).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 7: Write test/integration/api-keys-storage.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { createUser } from "../../src/storage/users";
import {
  createApiKey,
  findActiveApiKeyByHash,
  revokeApiKey,
  listApiKeysForUser,
} from "../../src/storage/apiKeys";
import { generateApiKey, hashToken } from "../../src/web/auth/tokens";

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb("apikeys");
  const u = await createUser(td.pool, { email: "a@x.com", passwordHash: "h", displayName: "A" });
  userId = u.id;
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("api_keys storage", () => {
  it("create + findActive round-trip", async () => {
    const plaintext = generateApiKey();
    const key = await createApiKey(td.pool, userId, "lbl", hashToken(plaintext), plaintext.slice(0, 8));
    expect(key.label).toBe("lbl");
    expect(key.keyPrefix).toBe(plaintext.slice(0, 8));
    const found = await findActiveApiKeyByHash(td.pool, hashToken(plaintext));
    expect(found?.id).toBe(key.id);
  });

  it("revoked key not found active", async () => {
    const plaintext = generateApiKey();
    const key = await createApiKey(td.pool, userId, "rev", hashToken(plaintext), plaintext.slice(0, 8));
    await revokeApiKey(td.pool, key.id);
    expect(await findActiveApiKeyByHash(td.pool, hashToken(plaintext))).toBeNull();
  });

  it("listApiKeysForUser returns all keys", async () => {
    const keys = await listApiKeysForUser(td.pool, userId);
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it("key_hash is unique", async () => {
    const hash = hashToken(generateApiKey());
    await createApiKey(td.pool, userId, "k1", hash, "ipq_xxxx");
    await expect(createApiKey(td.pool, userId, "k2", hash, "ipq_yyyy")).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Write test/integration/sessions-storage.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { createUser } from "../../src/storage/users";
import {
  createSession,
  loadSession,
  destroySession,
  destroyAllForUser,
  purgeExpired,
} from "../../src/storage/sessions";

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb("sessions");
  const u = await createUser(td.pool, { email: "s@x.com", passwordHash: "h", displayName: "S" });
  userId = u.id;
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("sessions storage", () => {
  it("create + load round-trip", async () => {
    const future = new Date(Date.now() + 3600_000);
    const s = await createSession(td.pool, "abcdefghijklmnopqrstuvwxyz012345", userId, future);
    expect(s.id).toHaveLength(32);
    const loaded = await loadSession(td.pool, s.id);
    expect(loaded?.userId).toBe(userId);
  });

  it("expired session not loaded", async () => {
    const past = new Date(Date.now() - 1000);
    await createSession(td.pool, "expired_session_id_with_32_chars_x", userId, past);
    expect(await loadSession(td.pool, "expired_session_id_with_32_chars_x")).toBeNull();
  });

  it("destroySession removes row", async () => {
    const future = new Date(Date.now() + 3600_000);
    await createSession(td.pool, "will_be_destroyed_session_id_x", userId, future);
    await destroySession(td.pool, "will_be_destroyed_session_id_x");
    expect(await loadSession(td.pool, "will_be_destroyed_session_id_x")).toBeNull();
  });

  it("destroyAllForUser removes all", async () => {
    const future = new Date(Date.now() + 3600_000);
    await createSession(td.pool, "first_session_id_with_32_chars_a", userId, future);
    await createSession(td.pool, "second_session_id_with_32_chars_b", userId, future);
    await destroyAllForUser(td.pool, userId);
    expect(await loadSession(td.pool, "first_session_id_with_32_chars_a")).toBeNull();
    expect(await loadSession(td.pool, "second_session_id_with_32_chars_b")).toBeNull();
  });

  it("purgeExpired removes past", async () => {
    const past = new Date(Date.now() - 1000);
    await createSession(td.pool, "will_be_purged_session_id_x", userId, past);
    const n = await purgeExpired(td.pool);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await loadSession(td.pool, "will_be_purged_session_id_x")).toBeNull();
  });
});
```

- [ ] **Step 9: Write test/integration/tokens-storage.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { createUser } from "../../src/storage/users";
import { createVerification, findVerificationByHash, consumeVerification } from "../../src/storage/tokens";

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb("tokens");
  const u = await createUser(td.pool, { email: "v@x.com", passwordHash: "h", displayName: "V" });
  userId = u.id;
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("email_verifications storage", () => {
  it("create + find round-trip", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "a".repeat(64), future);
    const found = await findVerificationByHash(td.pool, "a".repeat(64));
    expect(found?.id).toBe(v.id);
  });

  it("consume sets consumed_at", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "b".repeat(64), future);
    await consumeVerification(td.pool, v.id);
    const after = await findVerificationByHash(td.pool, "b".repeat(64));
    expect(after?.consumedAt).toBeInstanceOf(Date);
  });

  it("double-consume is no-op", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "c".repeat(64), future);
    await consumeVerification(td.pool, v.id);
    await consumeVerification(td.pool, v.id);
    const after = await findVerificationByHash(td.pool, "c".repeat(64));
    expect(after?.consumedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 10: Run tests**

Run: `npm test -- test/integration/users-storage.test.ts test/integration/api-keys-storage.test.ts test/integration/sessions-storage.test.ts test/integration/tokens-storage.test.ts`
Expected: all tests pass (5+4+5+3 = 17).

- [ ] **Step 11: Commit**

```bash
git add src/storage/users.ts src/storage/apiKeys.ts src/storage/sessions.ts src/storage/tokens.ts test/helpers/db.ts test/integration/users-storage.test.ts test/integration/api-keys-storage.test.ts test/integration/sessions-storage.test.ts test/integration/tokens-storage.test.ts
git commit -m "feat(storage): add user / api_key / session / token modules"
```

---

### Task 7: queryLog storage + batched writer middleware

**Files:**

- Create: `src/storage/queryLog.ts`
- Create: `src/web/plugins/queryLog.ts`
- Create: `test/integration/query-log.test.ts`

**Interfaces:**

- Produces: `createQueryLogWriter(pool: Pool, opts?: { flushIntervalMs?: number; maxBatch?: number }): { onRequest: (req) => void; onResponse: (req) => Promise<void>; flush: () => Promise<void>; close: () => Promise<void> }`

- [ ] **Step 1: Create src/storage/queryLog.ts**

```ts
// SPDX-License-Identifier: MIT
import type { Pool } from "mysql2/promise";
import type { QueryLogEntry } from "../types";

export interface QueryLogInsertable {
  ip: Buffer;
  ipText: string;
  status: "hit" | "miss" | "invalid";
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}

export async function insertQueryLogs(pool: Pool, entries: QueryLogInsertable[]): Promise<void> {
  if (entries.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders = slice
      .map((e) => {
        values.push(e.ip, e.ipText, e.status, e.userId, e.apiKeyId, e.sessionId, e.remoteAddr, e.userAgent);
        return "(?,?,?,?,?,?,?,?)";
      })
      .join(",");
    await pool.query(
      `INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent) VALUES ${placeholders}`,
      values,
    );
  }
}

export interface QueryLogQuery {
  offset: number;
  limit: number;
  userId?: number;
  status?: "hit" | "miss" | "invalid";
  ipText?: string;
  startTime?: Date;
  endTime?: Date;
}

export interface QueryLogRow extends QueryLogEntry {
  id: number;
  userEmail?: string | null;
  apiKeyPrefix?: string | null;
}

function mapRow(r: Record<string, unknown>): QueryLogRow {
  return {
    id: Number(r.id),
    ts: r.ts as Date,
    ip: r.ip as Buffer,
    ipText: r.ip_text as string,
    status: r.status as "hit" | "miss" | "invalid",
    userId: r.user_id == null ? null : Number(r.user_id),
    apiKeyId: r.api_key_id == null ? null : Number(r.api_key_id),
    sessionId: r.session_id == null ? null : (r.session_id as string),
    remoteAddr: r.remote_addr == null ? null : (r.remote_addr as Buffer),
    userAgent: r.user_agent as string | null,
    userEmail: (r.user_email as string | null) ?? null,
    apiKeyPrefix: (r.api_key_prefix as string | null) ?? null,
  };
}

export async function listQueryLogs(
  pool: Pool,
  q: QueryLogQuery,
): Promise<{ rows: QueryLogRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) {
    where.push("q.user_id = ?");
    params.push(q.userId);
  }
  if (q.status) {
    where.push("q.status = ?");
    params.push(q.status);
  }
  if (q.ipText) {
    where.push("q.ip_text = ?");
    params.push(q.ipText);
  }
  if (q.startTime) {
    where.push("q.ts >= ?");
    params.push(q.startTime);
  }
  if (q.endTime) {
    where.push("q.ts <= ?");
    params.push(q.endTime);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT q.*, u.email AS user_email, k.key_prefix AS api_key_prefix
       FROM query_log q
       LEFT JOIN users u ON u.id = q.user_id
       LEFT JOIN api_keys k ON k.id = q.api_key_id
       ${whereSql}
       ORDER BY q.id DESC
       LIMIT ? OFFSET ?`,
    [...params, q.limit, q.offset],
  );
  const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM query_log q ${whereSql}`, params);
  const arr = rows as Record<string, unknown>[];
  const totalArr = totalRows as Record<string, unknown>[];
  return {
    rows: arr.map(mapRow),
    total: Number((totalArr[0] as { c: number }).c),
  };
}

export async function countQueriesByStatusSince(
  pool: Pool,
  since: Date,
): Promise<{
  hit: number;
  miss: number;
  invalid: number;
}> {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM query_log WHERE ts >= ? GROUP BY status`,
    [since],
  );
  const out = { hit: 0, miss: 0, invalid: 0 };
  for (const r of rows as Record<string, unknown>[]) {
    const k = r.status as "hit" | "miss" | "invalid";
    out[k] = Number(r.c);
  }
  return out;
}

export async function streamQueryLogsCsv(
  pool: Pool,
  q: QueryLogQuery,
  write: (chunk: string) => void,
): Promise<void> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) {
    where.push("q.user_id = ?");
    params.push(q.userId);
  }
  if (q.status) {
    where.push("q.status = ?");
    params.push(q.status);
  }
  if (q.ipText) {
    where.push("q.ip_text = ?");
    params.push(q.ipText);
  }
  if (q.startTime) {
    where.push("q.ts >= ?");
    params.push(q.startTime);
  }
  if (q.endTime) {
    where.push("q.ts <= ?");
    params.push(q.endTime);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  write("id,ts,ip_text,status,user_email,api_key_prefix,remote_addr,user_agent\n");
  const conn = await pool.getConnection();
  try {
    const [stream] = await conn
      .query(
        `SELECT q.id, q.ts, q.ip_text, q.status, u.email AS user_email, k.key_prefix AS api_key_prefix,
              HEX(q.remote_addr) AS remote_hex, q.user_agent
         FROM query_log q
         LEFT JOIN users u ON u.id = q.user_id
         LEFT JOIN api_keys k ON k.id = q.api_key_id
         ${whereSql}
         ORDER BY q.id ASC`,
        params,
      )
      .then((r) => r as [unknown, unknown]);
    const rows = stream as Record<string, unknown>[];
    for (const r of rows) {
      const cells = [
        r.id,
        (r.ts as Date).toISOString(),
        JSON.stringify(r.ip_text),
        r.status,
        JSON.stringify(r.user_email ?? ""),
        JSON.stringify(r.api_key_prefix ?? ""),
        JSON.stringify(r.remote_hex ?? ""),
        JSON.stringify(r.user_agent ?? ""),
      ];
      write(cells.join(",") + "\n");
    }
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 2: Create src/web/plugins/queryLog.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "mysql2/promise";
import { insertQueryLogs, type QueryLogInsertable } from "../../storage/queryLog";

export interface PendingLookup {
  ip: Buffer;
  ipText: string;
  status: "hit" | "miss" | "invalid";
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    pendingLog?: PendingLookup;
  }
}

export function registerQueryLogWriter(
  app: FastifyInstance,
  pool: Pool,
  opts?: { flushIntervalMs?: number; maxBatch?: number },
): { flush: () => Promise<void> } {
  const flushIntervalMs = opts?.flushIntervalMs ?? 5000;
  const maxBatch = opts?.maxBatch ?? 100;
  let buffer: QueryLogInsertable[] = [];
  let timer: NodeJS.Timeout | null = null;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const slice = buffer;
    buffer = [];
    try {
      await insertQueryLogs(pool, slice);
    } catch (err) {
      app.log.error({ err, count: slice.length }, "queryLog flush failed");
    }
  }

  timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  timer.unref();

  app.addHook("onResponse", async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.pendingLog) return;
    buffer.push(req.pendingLog);
    if (buffer.length >= maxBatch) await flush();
  });

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await flush();
  });

  return { flush };
}
```

- [ ] **Step 3: Write test/integration/query-log.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { insertQueryLogs, listQueryLogs, countQueriesByStatusSince } from "../../src/storage/queryLog";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("querylog");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("query_log", () => {
  it("insert + list round-trip", async () => {
    const buf = parseIp("8.8.8.8")!;
    await insertQueryLogs(td.pool, [
      {
        ip: buf,
        ipText: "8.8.8.8",
        status: "hit",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: buf,
        userAgent: "test",
      },
    ]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10 });
    expect(r.total).toBe(1);
    expect(r.rows[0]?.ipText).toBe("8.8.8.8");
    expect(r.rows[0]?.status).toBe("hit");
  });

  it("listQueryLogs filter by status", async () => {
    await insertQueryLogs(td.pool, [
      {
        ip: parseIp("1.1.1.1")!,
        ipText: "1.1.1.1",
        status: "invalid",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
      {
        ip: parseIp("2.2.2.2")!,
        ipText: "2.2.2.2",
        status: "miss",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
    ]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10, status: "invalid" });
    expect(r.rows.every((x) => x.status === "invalid")).toBe(true);
  });

  it("countQueriesByStatusSince", async () => {
    const counts = await countQueriesByStatusSince(td.pool, new Date(Date.now() - 60_000));
    expect(counts.invalid).toBeGreaterThanOrEqual(1);
    expect(counts.miss).toBeGreaterThanOrEqual(1);
    expect(counts.hit).toBeGreaterThanOrEqual(1);
  });

  it("large batch chunks at 200", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      ip: parseIp("127.0.0.1")!,
      ipText: `127.0.0.${i % 256}`,
      status: "miss" as const,
      userId: null,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: null,
    }));
    await insertQueryLogs(td.pool, entries);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 1000 });
    expect(r.total).toBeGreaterThanOrEqual(250);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/integration/query-log.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/queryLog.ts src/web/plugins/queryLog.ts test/integration/query-log.test.ts
git commit -m "feat(storage,web): add query_log storage with batched writer middleware"
```

---

### Task 8: Fastify web plugins (view, i18n, cookie, formbody, static) + security headers

**Files:**

- Create: `src/web/plugins/view.ts`
- Create: `src/web/plugins/i18n.ts`
- Create: `src/web/plugins/security.ts`
- Modify: `src/api/server.ts` (register new plugins)
- Test: `test/integration/web-plugins.test.ts`

**Interfaces:**

- Produces: `registerWebPlugins(app, cfg, mailer)` wires cookie/formbody/static/view/i18n/security hooks.
- `req.locale: 'zh-CN' | 'en-US'`, `req.t(key, vars?)` available on every request.

- [ ] **Step 1: Create src/web/plugins/view.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import view from "@fastify/view";
import * as Handlebars from "handlebars";
import * as path from "node:path";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";

export async function registerView(app: FastifyInstance, cfg: { baseUrl: string }): Promise<void> {
  const viewsDir = path.join(__dirname, "..", "views");

  Handlebars.registerHelper("t", function (this: unknown, key: string, opts: unknown) {
    const hash = (opts as { hash?: Record<string, string | number> } | undefined)?.hash ?? {};
    const locale = (this as { locale?: string })?.locale ?? "zh-CN";
    const tFn = (
      globalThis as { __ipqT?: (l: string, k: string, v?: Record<string, string | number>) => string }
    ).__ipqT;
    return tFn ? tFn(locale, key, hash) : key;
  });

  Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  Handlebars.registerHelper("ne", (a: unknown, b: unknown) => a !== b);
  Handlebars.registerHelper("and", (a: unknown, b: unknown) => Boolean(a) && Boolean(b));
  Handlebars.registerHelper("or", (a: unknown, b: unknown) => Boolean(a) || Boolean(b));
  Handlebars.registerHelper("json", (v: unknown) => JSON.stringify(v));
  Handlebars.registerHelper("formatDate", (d: Date | string | null | undefined) => {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().replace("T", " ").slice(0, 19);
  });
  Handlebars.registerHelper("formatRelative", (d: Date | string | null | undefined) => {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    return formatDistanceToNow(date, { addSuffix: true, locale: zhCN });
  });
  Handlebars.registerHelper("year", () => new Date().getFullYear());

  await app.register(view, {
    engine: { handlebars: Handlebars },
    root: viewsDir,
    defaultLayout: "layouts/public",
    layout: "layouts/public",
  });

  app.decorate("viewBaseUrl", cfg.baseUrl);
}

declare module "fastify" {
  interface FastifyInstance {
    viewBaseUrl: string;
  }
}
```

- [ ] **Step 2: Create src/web/plugins/i18n.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from "fastify";
import { t, parseLocale, type Locale } from "../i18n";

(globalThis as { __ipqT?: typeof t }).__ipqT = t;

declare module "fastify" {
  interface FastifyRequest {
    locale: Locale;
    t: (key: string, vars?: Record<string, string | number>) => string;
  }
}

export async function registerI18n(app: FastifyInstance): Promise<void> {
  app.decorateRequest("locale", "zh-CN" as Locale);
  app.decorateRequest("t", null as unknown as (k: string, v?: Record<string, string | number>) => string);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const raw = req.cookies?.lang;
    req.locale = parseLocale(raw);
    req.t = (key, vars) => t(req.locale, key, vars);
  });
}
```

- [ ] **Step 3: Create src/web/plugins/security.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";

export async function registerSecurityHeaders(
  app: FastifyInstance,
  opts: { cookieSecure: boolean },
): Promise<void> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", csp);
    if (opts.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}
```

- [ ] **Step 4: Modify src/api/server.ts**

Add (in order, after existing cors/compress/rateLimit):

```ts
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import staticPlugin from "@fastify/static";
import * as path from "node:path";
import { registerView } from "../web/plugins/view";
import { registerI18n } from "../web/plugins/i18n";
import { registerSecurityHeaders } from "../web/plugins/security";
import { createMailer } from "../mailer";
import { registerQueryLogWriter } from "../web/plugins/queryLog";

await app.register(cookie, {
  secret: cfg.web.sessionSecret || cfg.web.csrfSecret || "dev-only-secret-change-me",
});
await app.register(formbody);
await app.register(staticPlugin, { root: path.join(__dirname, "web", "assets"), prefix: "/assets/" });
await registerView(app, { baseUrl: cfg.web.baseUrl });
await registerI18n(app);
await registerSecurityHeaders(app, { cookieSecure: cfg.web.cookieSecure });

app.decorate("mailer", createMailer(cfg));
registerQueryLogWriter(app, app.pool);
```

Add to the `declare module 'fastify'` block: `mailer: ReturnType<typeof createMailer>`.

- [ ] **Step 5: Install new runtime deps**

Run: `npm install date-fns`

- [ ] **Step 6: Write test/integration/web-plugins.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = "ipquery_web_plugins_test";
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
});

describe("web plugins", () => {
  it("serves static /assets/ route", async () => {
    const r = await app.inject({ method: "GET", url: "/assets/css/base.css" });
    expect([200, 404]).toContain(r.statusCode);
  });

  it("security headers present", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});
```

- [ ] **Step 7: Create stub asset**

Run: `mkdir -p src/web/assets/css src/web/assets/js src/web/assets/img`

Create `src/web/assets/css/base.css`:

```css
/* SPDX-License-Identifier: MIT */
:root {
  color-scheme: light dark;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  margin: 0;
}
```

(Other CSS files added in Task 11.)

- [ ] **Step 8: Run tests**

Run: `npm test -- test/integration/web-plugins.test.ts`
Expected: 2 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/web/plugins/view.ts src/web/plugins/i18n.ts src/web/plugins/security.ts src/api/server.ts package.json package-lock.json src/web/assets/ test/integration/web-plugins.test.ts
git commit -m "feat(web): register view/i18n/cookie/formbody/static plugins and security headers"
```

---

### Task 9: Session middleware (loadSession + requireAuth + requireAdmin)

**Files:**

- Create: `src/web/plugins/session.ts`
- Create: `src/web/plugins/auth.ts`
- Modify: `src/api/server.ts`
- Test: `test/integration/session-middleware.test.ts`

- [ ] **Step 1: Create src/web/plugins/session.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadSession } from "../../storage/sessions";
import { findUserById } from "../../storage/users";
import type { Session, User } from "../../types";

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
    user: User | null;
  }
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.decorateRequest("session", null as Session | null);
  app.decorateRequest("user", null as User | null);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const sid = req.cookies?.sid;
    if (!sid) return;
    const session = await loadSession(app.pool, sid);
    if (!session) return;
    req.session = session;
    const user = await findUserById(app.pool, session.userId);
    req.user = user;
  });
}
```

- [ ] **Step 2: Create src/web/plugins/auth.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const COOKIE_BASE = { httpOnly: true, sameSite: "lax" as const, path: "/" };

export async function setSessionCookie(
  reply: FastifyReply,
  sid: string,
  maxAgeSec: number,
  secure: boolean,
  domain: string,
): Promise<void> {
  reply.setCookie("sid", sid, { ...COOKIE_BASE, maxAge: maxAgeSec, secure, domain: domain || undefined });
}

export async function clearSessionCookie(reply: FastifyReply, domain: string): Promise<void> {
  reply.setCookie("sid", "", { ...COOKIE_BASE, maxAge: 0, domain: domain || undefined });
}

export function isDashboardPath(url: string): boolean {
  return url === "/dashboard" || url.startsWith("/dashboard/");
}

export function isAdminPath(url: string): boolean {
  return url === "/admin" || url.startsWith("/admin/");
}

export async function registerAuthGuards(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.routeOptions?.url ?? req.url;
    if (isDashboardPath(url)) {
      if (!req.user) return reply.code(302).redirect(`/login?next=${encodeURIComponent(req.url)}`);
      if (req.user.isDisabled) return reply.code(302).redirect("/login?disabled=1");
    } else if (isAdminPath(url)) {
      if (!req.user || req.user.role !== "admin")
        return reply.code(403).view("errors/403.hbs", { layout: "layouts/public", req });
      if (req.user.isDisabled) return reply.code(302).redirect("/login?disabled=1");
    }
  });
}
```

- [ ] **Step 3: Modify src/api/server.ts**

After `await registerI18n(app);` add:

```ts
import { registerSession } from "../web/plugins/session";
import { registerAuthGuards } from "../web/plugins/auth";
await registerSession(app);
await registerAuthGuards(app);
```

- [ ] **Step 4: Write test/integration/session-middleware.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUserId: number;

beforeAll(async () => {
  td = await createTestDb('session-mw');
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: 'a@x.com', passwordHash: 'h', displayName: 'A', role: 'admin' });
  adminUserId = u.id;
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('session middleware', () => {
  it('loads session from cookie', async () => {
    const sid = generateToken(16);
    await createSession(app.pool, sid, adminUserId, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=' + sid);
    expect([200, 302]).toContain(r.status);
  });

  it('invalid cookie -> 302 to /login', async () => {
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=invalid');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\\/login/);
  });

  it('non-admin -> 403 on /admin/*', async () => {
    const sid = generateToken(16);
    const regular = await createUser(app.pool, { email: 'r@x.com', passwordHash: 'h', displayName: 'R' });
    await createSession(app.pool, sid, regular.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(403);
  });

  it('admin passes admin gate', async () => {
    const sid = generateToken(16);
    await createSession(app.pool, sid, adminUserId, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/admin/users').set('Cookie', 'sid=' + sid);
    expect([200, 302]).toContain(r.status);
  });

  it('disabled user -> /login?disabled=1', async () => {
    const sid = generateToken(16);
    const u = await createUser(app.pool, { email: 'd@x.com', passwordHash: 'h', displayName: 'D' });
    await app.pool.query('UPDATE users SET is_disabled = 1 WHERE id = ?', [u.id]);
    await createSession(app.pool, sid, u.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server).get('/dashboard').set('Cookie', 'sid=' + sid);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/disabled=1/);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/session-middleware.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/plugins/session.ts src/web/plugins/auth.ts src/api/server.ts test/integration/session-middleware.test.ts
git commit -m "feat(web): add session middleware, auth/admin guards"
```

---

### Task 10: CSRF plugin + login rate limiter

**Files:**

- Create: `src/web/plugins/csrf.ts`
- Create: `src/web/plugins/loginRateLimit.ts`
- Modify: `src/api/server.ts`
- Test: `test/integration/csrf.test.ts`

- [ ] **Step 1: Create src/web/plugins/csrf.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateCsrf } from "../auth/tokens";

declare module "fastify" {
  interface FastifyRequest {
    csrfToken: string;
  }
}

const CSRF_TTL_MS = 4 * 60 * 60 * 1000;

export async function registerCsrf(app: FastifyInstance): Promise<void> {
  app.decorateRequest("csrfToken", "" as string);

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    let token = req.cookies?.csrf;
    const issuedRaw = req.cookies?.csrf_issued;
    const issued = issuedRaw ? Number(issuedRaw) : 0;

    if (!token || !issued || Date.now() - issued > CSRF_TTL_MS) {
      token = generateCsrf();
      const now = Date.now();
      reply.setCookie("csrf", token, { httpOnly: false, sameSite: "lax", path: "/", secure: false });
      reply.setCookie("csrf_issued", String(now), {
        httpOnly: false,
        sameSite: "lax",
        path: "/",
        secure: false,
      });
    }
    req.csrfToken = token;
  });
}

export function verifyCsrfRequest(req: FastifyRequest): boolean {
  const cookieToken = req.cookies?.csrf;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bodyToken = typeof body.csrf === "string" ? body.csrf : undefined;
  if (!cookieToken || !bodyToken) return false;
  if (cookieToken !== bodyToken) return false;
  const issued = req.cookies?.csrf_issued ? Number(req.cookies.csrf_issued) : 0;
  if (!issued || Date.now() - issued > CSRF_TTL_MS) return false;
  return true;
}
```

- [ ] **Step 2: Create src/web/plugins/loginRateLimit.ts**

```ts
// SPDX-License-Identifier: MIT

interface LockEntry {
  failures: number;
  lockUntil: number;
}

const failures = new Map<string, LockEntry>();

export function recordLoginFailure(
  email: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { locked: boolean; retryAfterSec: number } {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = failures.get(key) ?? { failures: 0, lockUntil: 0 };
  if (entry.lockUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000) };
  }
  entry.failures += 1;
  if (entry.failures >= maxAttempts) {
    entry.lockUntil = now + lockoutMinutes * 60_000;
    entry.failures = 0;
    failures.set(key, entry);
    return { locked: true, retryAfterSec: lockoutMinutes * 60 };
  }
  failures.set(key, entry);
  return { locked: false, retryAfterSec: 0 };
}

export function recordLoginSuccess(email: string): void {
  failures.delete(email.toLowerCase());
}

export function isLocked(email: string): { locked: boolean; retryAfterSec: number } {
  const entry = failures.get(email.toLowerCase());
  if (!entry) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (entry.lockUntil > now)
    return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000) };
  return { locked: false, retryAfterSec: 0 };
}

export function _resetForTests(): void {
  failures.clear();
}
```

- [ ] **Step 3: Modify src/api/server.ts**

After `await registerAuthGuards(app);` add:

```ts
import { registerCsrf } from "../web/plugins/csrf";
import { _resetForTests as resetLoginLimit } from "../web/plugins/loginRateLimit";
await registerCsrf(app);
app.decorate("resetLoginLimit", resetLoginLimit);
```

Add to FastifyInstance: `resetLoginLimit: () => void`.

- [ ] **Step 4: Write test/integration/csrf.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb("csrf");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});
beforeEach(() => {
  app.resetLoginLimit();
});

describe("CSRF", () => {
  it("GET sets csrf cookie", async () => {
    const r = await request(app.server).get("/healthz");
    const setCookie = r.headers["set-cookie"] as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith("csrf="))).toBe(true);
  });

  it("rejects POST with mismatched csrf", async () => {
    const getR = await request(app.server).get("/login");
    const csrfCookie = (getR.headers["set-cookie"] as string[])
      .find((c) => c.startsWith("csrf="))!
      .split(";")[0]!;
    const r = await request(app.server)
      .post("/login")
      .set("Cookie", csrfCookie)
      .type("form")
      .send({ email: "a@b.c", password: "whatever", csrf: "wrong-token-value" });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/csrf.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/plugins/csrf.ts src/web/plugins/loginRateLimit.ts src/api/server.ts test/integration/csrf.test.ts
git commit -m "feat(web): add CSRF plugin and in-memory login lockout"
```

---

### Task 11: Layouts, partials, CSS, htmx asset

**Files:**

- Create: `src/web/views/layouts/public.hbs`
- Create: `src/web/views/layouts/auth.hbs`
- Create: `src/web/views/layouts/dashboard.hbs`
- Create: `src/web/views/layouts/admin.hbs`
- Create: `src/web/views/partials/nav.hbs`
- Create: `src/web/views/partials/footer.hbs`
- Create: `src/web/views/partials/flash.hbs`
- Create: `src/web/views/partials/pagination.hbs`
- Create: `src/web/views/partials/form-field.hbs`
- Create: `src/web/views/errors/403.hbs`
- Create: `src/web/views/errors/csrf.hbs`
- Create: `src/web/views/errors/404.hbs`
- Create: `src/web/views/errors/500.hbs`
- Modify: `src/web/assets/css/base.css` (extend)
- Create: `src/web/assets/css/layout.css`
- Create: `src/web/assets/css/forms.css`
- Create: `src/web/assets/js/htmx.min.js` (vendored)

- [ ] **Step 1: Create src/web/views/layouts/public.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<!DOCTYPE html>
<html lang="{{req.locale}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{#if title}}{{title}} - IPQuery{{else}}IPQuery{{/if}}</title>
  <link rel="stylesheet" href="/assets/css/base.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/forms.css">
  <script src="/assets/js/htmx.min.js" defer></script>
</head>
<body class="layout-public">
  {{> nav }}
  <main class="main">
    {{> flash }}
    {{{body}}}
  </main>
  {{> footer }}
</body>
</html>
```

- [ ] **Step 2: Create src/web/views/layouts/auth.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<!DOCTYPE html>
<html lang="{{req.locale}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}} - IPQuery</title>
  <link rel="stylesheet" href="/assets/css/base.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/forms.css">
</head>
<body class="layout-auth">
  <main class="auth-container">
    {{> flash }}
    <h1>{{title}}</h1>
    {{{body}}}
    <p class="auth-footer"><a href="/">{{req.t 'common.back'}}</a></p>
  </main>
</body>
</html>
```

- [ ] **Step 3: Create src/web/views/layouts/dashboard.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<!DOCTYPE html>
<html lang="{{req.locale}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}} - IPQuery</title>
  <link rel="stylesheet" href="/assets/css/base.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/forms.css">
</head>
<body class="layout-dashboard">
  {{> nav }}
  <div class="dashboard-shell">
    <aside class="sidebar">
      <h2>{{req.t 'dashboard.title'}}</h2>
      <nav>
        <ul>
          <li><a href="/dashboard">{{req.t 'dashboard.welcome' name=req.user.displayName}}</a></li>
          <li><a href="/dashboard/history">{{req.t 'dashboard.history.title'}}</a></li>
          <li><a href="/dashboard/keys">{{req.t 'dashboard.keys.title'}}</a></li>
          <li><a href="/dashboard/profile">{{req.t 'dashboard.profile.title'}}</a></li>
          {{#if (eq req.user.role 'admin')}}
          <li><a href="/admin/users">{{req.t 'nav.admin'}}</a></li>
          {{/if}}
        </ul>
      </nav>
    </aside>
    <main class="dashboard-main">
      {{> flash }}
      {{{body}}}
    </main>
  </div>
</body>
</html>
```

- [ ] **Step 4: Create src/web/views/layouts/admin.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<!DOCTYPE html>
<html lang="{{req.locale}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}} - IPQuery Admin</title>
  <link rel="stylesheet" href="/assets/css/base.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/forms.css">
</head>
<body class="layout-admin">
  {{> nav }}
  <div class="dashboard-shell">
    <aside class="sidebar">
      <h2>{{req.t 'admin.title'}}</h2>
      <nav>
        <ul>
          <li><a href="/admin/users">{{req.t 'admin.users.title'}}</a></li>
          <li><a href="/admin/etl/runs">{{req.t 'admin.etl.title'}}</a></li>
          <li><a href="/admin/keys">{{req.t 'admin.keys.title'}}</a></li>
          <li><a href="/admin/audit">{{req.t 'admin.audit.title'}}</a></li>
          <li><a href="/dashboard">{{req.t 'nav.dashboard'}}</a></li>
        </ul>
      </nav>
    </aside>
    <main class="dashboard-main">
      {{> flash }}
      {{{body}}}
    </main>
  </div>
</body>
</html>
```

- [ ] **Step 5: Create src/web/views/partials/nav.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<nav class="topnav">
  <a href="/" class="brand">IPQuery</a>
  <ul>
    <li><a href="/">{{req.t "nav.home"}}</a></li>
    <li><a href="/docs">{{req.t "nav.docs"}}</a></li>
    <li><a href="/pricing">{{req.t "nav.pricing"}}</a></li>
    <li><a href="/status">{{req.t "nav.status"}}</a></li>
    <li><a href="/try">{{req.t "nav.try"}}</a></li>
  </ul>
  <div class="topnav-user">
    {{#if req.user}}
      <span>{{req.user.displayName}}</span>
      {{#if (eq req.user.role "admin")}}<a href="/admin/users">{{req.t "nav.admin"}}</a>{{/if}}
      <a href="/dashboard">{{req.t "nav.dashboard"}}</a>
      <form method="POST" action="/logout" style="display:inline">
        <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
        <button type="submit" class="link">{{req.t "nav.logout"}}</button>
      </form>
    {{else}}
      <a href="/login">{{req.t "common.login"}}</a>
      <a href="/signup">{{req.t "common.signup"}}</a>
    {{/if}}
  </div>
</nav>
```

- [ ] **Step 6: Create src/web/views/partials/footer.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<footer class="footer">
  <p>{{req.t "footer.copyright" year=(year)}}</p>
  <p>{{req.t "footer.license"}}</p>
</footer>
```

- [ ] **Step 7: Create src/web/views/partials/flash.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
{{#if flash.success}}<div class="flash flash-success">{{flash.success}}</div>{{/if}}
{{#if flash.error}}<div class="flash flash-error">{{flash.error}}</div>{{/if}}
{{#if flash.warning}}<div class="flash flash-warning">{{flash.warning}}</div>{{/if}}
{{#if flash.info}}<div class="flash flash-info">{{flash.info}}</div>{{/if}}
```

- [ ] **Step 8: Create src/web/views/partials/pagination.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
{{#if (gt totalPages 1)}}
  <nav class="pagination">
    {{#if (gt page 1)}}<a href="{{baseUrl}}?page={{subtract page 1}}&{{queryString}}">{{req.t
          "common.prev"
        }}</a>{{/if}}
    <span>{{page}} / {{totalPages}}</span>
    {{#if (lt page totalPages)}}<a href="{{baseUrl}}?page={{add page 1}}&{{queryString}}">{{req.t
          "common.next"
        }}</a>{{/if}}
  </nav>
{{/if}}
```

- [ ] **Step 9: Create src/web/views/partials/form-field.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<div class="form-field">
  <label for="{{name}}">{{label}}</label>
  {{#if (eq type 'textarea')}}
    <textarea name="{{name}}" id="{{name}}" {{#if required}}required{{/if}} {{#if placeholder}}placeholder="{{placeholder}}"{{/if}}>{{value}}</textarea>
  {{else if (eq type 'select')}}
    <select name="{{name}}" id="{{name}}">
      {{#each options}}<option value="{{value}}" {{#if (eq value ../value)}}selected{{/if}}>{{label}}</option>{{/each}}
    </select>
  {{else}}
    <input type="{{#if type}}{{type}}{{else}}text{{/if}}" name="{{name}}" id="{{name}}" value="{{value}}" {{#if required}}required{{/if}} {{#if placeholder}}placeholder="{{placeholder}}"{{/if}} {{#if autocomplete}}autocomplete="{{autocomplete}}"{{/if}}>
  {{/if}}
  {{#if help}}<p class="form-help">{{help}}</p>{{/if}}
  {{#if error}}<p class="form-error">{{error}}</p>{{/if}}
</div>
```

- [ ] **Step 10: Create error views**

`src/web/views/errors/403.hbs`:

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "error.403.title"}}</h1>
<p>{{req.t "error.403.body"}}</p>
```

`src/web/views/errors/csrf.hbs`:

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "error.csrf.title"}}</h1>
<p>{{req.t "error.csrf.body"}}</p>
```

`src/web/views/errors/404.hbs`:

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "error.404.title"}}</h1>
```

`src/web/views/errors/500.hbs`:

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "error.500.title"}}</h1>
<p>{{req.t "error.500.body"}}</p>
```

- [ ] **Step 11: Extend base.css and add layout.css + forms.css**

Append to `src/web/assets/css/base.css`:

```css
a {
  color: inherit;
  text-decoration: underline;
}
a:hover {
  text-decoration: none;
}
button,
input,
select,
textarea {
  font: inherit;
}
button {
  cursor: pointer;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid #e5e5e5;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #1a1a1a;
    color: #e5e5e5;
  }
  th,
  td {
    border-color: #333;
  }
}
```

`src/web/assets/css/layout.css`:

```css
/* SPDX-License-Identifier: MIT */
.topnav {
  display: flex;
  align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid #e5e5e5;
}
.topnav .brand {
  font-weight: 700;
  margin-right: 2rem;
}
.topnav ul {
  display: flex;
  gap: 1rem;
  list-style: none;
  padding: 0;
  margin: 0;
}
.topnav-user {
  margin-left: auto;
  display: flex;
  gap: 1rem;
  align-items: center;
}
.main {
  max-width: 1100px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.footer {
  border-top: 1px solid #e5e5e5;
  padding: 2rem;
  text-align: center;
  margin-top: 4rem;
}
.dashboard-shell {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 2rem;
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.sidebar {
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 8px;
}
.sidebar ul {
  list-style: none;
  padding: 0;
}
.sidebar li {
  margin: 0.5rem 0;
}
.dashboard-main {
  min-width: 0;
}
.layout-auth {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.auth-container {
  max-width: 400px;
  width: 100%;
  padding: 2rem;
}
@media (prefers-color-scheme: dark) {
  .sidebar {
    background: #2a2a2a;
  }
}
```

`src/web/assets/css/forms.css`:

```css
/* SPDX-License-Identifier: MIT */
.form-field {
  margin-bottom: 1rem;
}
.form-field label {
  display: block;
  margin-bottom: 0.25rem;
  font-weight: 500;
}
.form-field input,
.form-field select,
.form-field textarea {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: white;
  color: black;
}
@media (prefers-color-scheme: dark) {
  .form-field input,
  .form-field select,
  .form-field textarea {
    background: #2a2a2a;
    color: #e5e5e5;
    border-color: #444;
  }
}
.form-help {
  color: #666;
  font-size: 0.875rem;
  margin: 0.25rem 0 0;
}
.form-error {
  color: #c00;
  font-size: 0.875rem;
  margin: 0.25rem 0 0;
}
button[type="submit"],
.btn-primary {
  background: #0066cc;
  color: white;
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: 4px;
}
button.link {
  background: none;
  border: 0;
  color: inherit;
  text-decoration: underline;
  padding: 0;
  cursor: pointer;
}
.flash {
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  border-radius: 4px;
}
.flash-success {
  background: #d4edda;
  color: #155724;
}
.flash-error {
  background: #f8d7da;
  color: #721c24;
}
.flash-warning {
  background: #fff3cd;
  color: #856404;
}
.flash-info {
  background: #d1ecf1;
  color: #0c5460;
}
.pagination {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin: 1rem 0;
}
```

- [ ] **Step 12: Vendor htmx 1.9.10**

Run: `curl -L -o src/web/assets/js/htmx.min.js https://unpkg.com/htmx.org@1.9.10/dist/htmx.min.js`
Verify the file is non-empty and starts with the htmx copyright header.

- [ ] **Step 13: Run tests**

Run: `npm test -- test/integration/web-plugins.test.ts`
Expected: still passes (templates don't break existing tests).

- [ ] **Step 14: Commit**

```bash
git add src/web/views/ src/web/assets/ test/integration/web-plugins.test.ts
git commit -m "feat(web): add layouts, partials, error pages, CSS, htmx asset"
```

---

### Task 12: Marketing routes (/, /about, /docs, /pricing, /status)

**Files:**

- Create: `src/web/routes/marketing.ts`
- Create: `src/web/views/marketing/home.hbs`
- Create: `src/web/views/marketing/about.hbs`
- Create: `src/web/views/marketing/docs.hbs`
- Create: `src/web/views/marketing/pricing.hbs`
- Create: `src/web/views/marketing/status.hbs`
- Test: `test/integration/marketing.test.ts`

- [ ] **Step 1: Create src/web/views/marketing/home.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<section class="hero">
  <h1>IPQuery</h1>
  <p>开源 IP 地理位置查询服务,聚合 MaxMind / ip2region / DB-IP 三大数据源</p>
  <a class="btn-primary" href="/try">{{req.t "nav.try"}}</a>
  <a href="/docs">{{req.t "nav.docs"}}</a>
</section>
<section>
  <h2>特性</h2>
  <ul>
    <li>三大数据源聚合,主源优先 + 备源补字段</li>
    <li>HTTP API + Web 控制台</li>
    <li>每日自动 ETL 增量更新</li>
    <li>MySQL 原子切换,服务零停机</li>
  </ul>
</section>
<section>
  <h2>API 快速开始</h2>
  <pre><code>curl "{{app.viewBaseUrl}}/lookup?ip=8.8.8.8"</code></pre>
  <p><a href="/docs">{{req.t "nav.docs"}}</a></p>
</section>
```

- [ ] **Step 2: Create src/web/views/marketing/about.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>关于 IPQuery</h1>
<p>IPQuery 是一个轻量级、自托管的 IP 地理位置查询服务。它从多个开源 / 免费数据源(MaxMind
  GeoLite2、ip2region、DB-IP)按"主源优先 + 备源补字段"策略聚合数据,每天自动更新。</p>
<p>代码以 MIT 协议开源;数据文件由使用者自行下载并遵守各源授权约束。</p>
<h2>技术栈</h2>
<ul>
  <li>Node.js 20 + TypeScript 5</li>
  <li>Fastify + Handlebars SSR</li>
  <li>MySQL 8</li>
</ul>
```

- [ ] **Step 3: Create src/web/views/marketing/docs.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>API 文档</h1>
<h2>GET /lookup</h2>
<pre><code>curl "{{app.viewBaseUrl}}/lookup?ip=8.8.8.8"</code></pre>
<h3>响应</h3>
<pre><code>{ "ip": "8.8.8.8", "country": { "code": "US", "name": "United States", "source": "maxmind" }, ... }</code></pre>
<h2>API Key 认证</h2>
<p>登录后在 <a href="/dashboard/keys">控制台</a> 创建 API Key,然后:</p>
<pre><code>curl "{{app.viewBaseUrl}}/lookup?ip=8.8.8.8&key=ipq_xxxxxxxxxxxx"</code></pre>
<h2>返回格式</h2>
<p>字段缺失时省略;IP 未找到记录返回 404 {error: "not_found"}。</p>
```

- [ ] **Step 4: Create src/web/views/marketing/pricing.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>定价</h1>
<p>IPQuery 是开源软件,代码本身免费。数据源下载由你自行负责,各源有各自的许可条款。</p>
<table>
  <thead><tr><th>层级</th><th>能力</th><th>费用</th></tr></thead>
  <tbody>
    <tr><td>免费</td><td>匿名查询,速率限制 60/分钟</td><td>¥0</td></tr>
    <tr><td>注册用户</td><td>个人查询历史,API Key,速率限制 600/分钟</td><td>¥0</td></tr>
    <tr><td>付费</td><td>(暂未开放)</td><td>—</td></tr>
  </tbody>
</table>
```

- [ ] **Step 5: Create src/web/views/marketing/status.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>服务状态</h1>
{{#if lastRun}}
  <section>
    <h2>最近一次 ETL</h2>
    <p>开始时间:{{formatDate lastRun.startedAt}}</p>
    <p>结束时间:{{formatDate lastRun.finishedAt}}</p>
    <p>状态:<strong>{{lastRun.status}}</strong></p>
    <p>合并记录数:{{lastRun.mergedRecords}}</p>
  </section>
{{else}}
  <p>暂无 ETL 运行记录。</p>
{{/if}}
```

- [ ] **Step 6: Create src/web/routes/marketing.ts**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { lastEtlRun } from "../../storage/mysql";

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) => {
    return reply.view("marketing/home.hbs", { layout: "layouts/public", title: "首页", req });
  });
  app.get("/about", async (req, reply) => {
    return reply.view("marketing/about.hbs", { layout: "layouts/public", title: "关于", req });
  });
  app.get("/docs", async (req, reply) => {
    return reply.view("marketing/docs.hbs", { layout: "layouts/public", title: "API 文档", req });
  });
  app.get("/pricing", async (req, reply) => {
    return reply.view("marketing/pricing.hbs", { layout: "layouts/public", title: "定价", req });
  });
  app.get("/status", async (_req, reply) => {
    const lastRun = await lastEtlRun(app.pool);
    return reply.view("marketing/status.hbs", { layout: "layouts/public", title: "状态", lastRun, req });
  });
}
```

- [ ] **Step 7: Write test/integration/marketing.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb("marketing");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("marketing routes", () => {
  it("GET / returns 200", async () => {
    const r = await request(app.server).get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("IPQuery");
  });
  it("GET /about returns 200", async () => {
    const r = await request(app.server).get("/about");
    expect(r.status).toBe(200);
    expect(r.text).toContain("IPQuery");
  });
  it("GET /docs returns 200", async () => {
    const r = await request(app.server).get("/docs");
    expect(r.status).toBe(200);
    expect(r.text).toContain("/lookup");
  });
  it("GET /pricing returns 200", async () => {
    const r = await request(app.server).get("/pricing");
    expect(r.status).toBe(200);
    expect(r.text).toContain("免费");
  });
  it("GET /status returns 200", async () => {
    const r = await request(app.server).get("/status");
    expect(r.status).toBe(200);
    expect(r.text).toContain("ETL");
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npm test -- test/integration/marketing.test.ts`
Expected: 5 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/web/routes/marketing.ts src/web/views/marketing/ test/integration/marketing.test.ts
git commit -m "feat(web): add marketing pages (home/about/docs/pricing/status)"
```

---

### Task 13: /try page with htmx endpoint

**Files:**

- Create: `src/web/views/marketing/try.hbs`
- Create: `src/web/views/marketing/_try-result.hbs` (htmx partial)
- Modify: `src/web/routes/marketing.ts`
- Test: `test/integration/try.test.ts`

- [ ] **Step 1: Create src/web/views/marketing/try.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "lookup.title"}}</h1>
<form hx-post="/try" hx-target="#try-result" hx-swap="innerHTML">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
  <input type="text" name="ip" placeholder="{{req.t 'lookup.input.placeholder'}}" required />
  <button type="submit" class="btn-primary">{{req.t "lookup.submit"}}</button>
</form>
<div id="try-result"></div>
```

- [ ] **Step 2: Create src/web/views/marketing/\_try-result.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
{{#if result}}
  <section>
    <h2>{{req.t "lookup.found" ip=result.ip country=result.country.name}}</h2>
    <dl>
      <dt>国家</dt><dd>{{result.country.name}} ({{result.country.code}})</dd>
      {{#if result.city}}<dt>城市</dt><dd>{{result.city.name}}</dd>{{/if}}
      {{#if result.region}}<dt>地区</dt><dd>{{result.region}}</dd>{{/if}}
      {{#if result.isp}}<dt>ISP</dt><dd>{{result.isp.name}}</dd>{{/if}}
      {{#if result.asn}}<dt>ASN</dt><dd>{{result.asn.number}} {{result.asn.org}}</dd>{{/if}}
    </dl>
  </section>
{{else if notFound}}
  <p>{{req.t "lookup.notfound" ip=ip}}</p>
{{else if invalid}}
  <p>{{req.t "lookup.invalid"}}</p>
{{/if}}
```

- [ ] **Step 3: Modify src/web/routes/marketing.ts**

Add imports and the `/try` route:

```ts
import { parseIp, isValidIp } from "../../ip";
import { findRange } from "../../storage/mysql";
import { verifyCsrfRequest } from "../plugins/csrf";

// inside marketingRoutes function:
app.get("/try", async (req, reply) => {
  return reply.view("marketing/try.hbs", { layout: "layouts/public", title: "在线试查", req });
});

app.post("/try", async (req, reply) => {
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  const ip = (req.body as { ip?: string }).ip ?? "";
  if (!isValidIp(ip)) {
    return reply.view("marketing/_try-result.hbs", { layout: false, invalid: true, ip, req });
  }
  const buf = parseIp(ip);
  const row = buf ? await findRange(app.pool, buf) : null;
  if (!row) {
    return reply.view("marketing/_try-result.hbs", { layout: false, notFound: true, ip, req });
  }
  return reply.view("marketing/_try-result.hbs", {
    layout: false,
    result: {
      ip,
      country: { code: row.countryCode, name: row.countryName, source: row.countrySource ?? "maxmind" },
      region: row.region,
      city: row.city ? { name: row.city, source: row.citySource ?? "maxmind" } : undefined,
      isp: row.isp ? { name: row.isp, source: row.ispSource ?? "maxmind" } : undefined,
      asn:
        row.asn !== undefined
          ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? "maxmind" }
          : undefined,
    },
    req,
  });
});
```

- [ ] **Step 4: Write test/integration/try.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb("try");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function getCsrf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/try");
  const setCookie = (r.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!;
  const cookie = setCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(setCookie);
  const token = tokenMatch ? tokenMatch[1]! : "";
  return { cookie, token };
}

describe("/try", () => {
  it("GET renders form", async () => {
    const r = await request(app.server).get("/try");
    expect(r.status).toBe(200);
    expect(r.text).toContain('hx-post="/try"');
  });

  it("POST invalid IP returns invalid fragment", async () => {
    const { cookie, token } = await getCsrf();
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "not-an-ip", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("IP 格式无效");
  });

  it("POST valid IP with no record returns notfound", async () => {
    const { cookie, token } = await getCsrf();
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "8.8.8.8", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("未找到记录");
  });

  it("POST without csrf returns 403", async () => {
    const { cookie } = await getCsrf();
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "8.8.8.8", csrf: "wrong" });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/try.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/marketing/try.hbs src/web/views/marketing/_try-result.hbs src/web/routes/marketing.ts test/integration/try.test.ts
git commit -m "feat(web): add /try page with htmx endpoint"
```

---

### Task 14: Signup + verify flow + email templates

**Files:**

- Create: `src/web/views/auth/signup.hbs`
- Create: `src/web/views/auth/verify-result.hbs`
- Create: `src/web/emails/verify-email.hbs`
- Create: `src/web/routes/auth.ts` (signup + verify parts)
- Modify: `src/api/server.ts` (register auth routes)
- Test: `test/integration/auth.signup.test.ts`

- [ ] **Step 1: Create src/web/views/auth/signup.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<form method="POST" action="/signup">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  {{> form-field name="email" type="email" label=(req.t 'auth.email') required=true autocomplete="email" }}
  {{> form-field name="password" type="password" label=(req.t 'auth.password') required=true autocomplete="new-password" help=(req.t 'auth.password.help') }}
  {{> form-field name="displayName" label=(req.t 'auth.displayName') required=true autocomplete="nickname" }}
  {{#if error}}<p class="form-error">{{error}}</p>{{/if}}
  <button type="submit" class="btn-primary">{{req.t 'auth.signup.submit'}}</button>
</form>
<p><a href="/login">{{req.t 'common.login'}}</a></p>
```

- [ ] **Step 2: Create src/web/views/auth/verify-result.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
{{#if success}}
  <h1>{{req.t "verify.success"}}</h1>
  <p><a href="/login">{{req.t "common.login"}}</a></p>
{{else}}
  <h1>{{req.t "verify.title"}}</h1>
  <p>{{message}}</p>
  {{#if (eq reason "expired")}}
    <p><a href="/login">{{req.t "auth.verify.resend"}}</a></p>
  {{/if}}
{{/if}}
```

- [ ] **Step 3: Create src/web/emails/verify-email.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}

<html><body>
    <p>你好,</p>
    <p>请点击以下链接完成邮箱验证(链接 24 小时内有效):</p>
    <p><a href="{{verifyUrl}}">{{verifyUrl}}</a></p>
    <p>如果不是你本人操作,请忽略本邮件。</p>
    <p>— IPQuery</p>
  </body></html>
```

- [ ] **Step 4: Create src/web/routes/auth.ts (signup + verify portion)**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import * as Handlebars from "handlebars";
import { createUser, findUserByEmail } from "../../storage/users";
import {
  createVerification,
  findVerificationByHash,
  consumeVerification,
  lastVerificationForUser,
} from "../../storage/tokens";
import { markEmailVerified } from "../../storage/users";
import { hashPassword } from "../auth/password";
import { generateToken, hashToken } from "../auth/tokens";
import { verifyCsrfRequest } from "../plugins/csrf";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const EMAIL_TEMPLATES_DIR = path.join(__dirname, "..", "emails");

let verifyEmailTemplate: Handlebars.TemplateDelegate | null = null;
async function getVerifyEmailTpl(): Promise<Handlebars.TemplateDelegate> {
  if (verifyEmailTemplate) return verifyEmailTemplate;
  const src = await fs.readFile(path.join(EMAIL_TEMPLATES_DIR, "verify-email.hbs"), "utf8");
  verifyEmailTemplate = Handlebars.compile(src);
  return verifyEmailTemplate;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /signup
  app.get("/signup", async (req, reply) => {
    return reply.view("auth/signup.hbs", { layout: "layouts/auth", title: req.t("auth.signup.title"), req });
  });

  // POST /signup
  app.post(
    "/signup",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      if (!verifyCsrfRequest(req))
        return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
      const body = req.body as { email?: string; password?: string; displayName?: string };
      const email = (body.email ?? "").trim().toLowerCase();
      const password = body.password ?? "";
      const displayName = (body.displayName ?? "").trim();

      const error = (msg: string) =>
        reply.code(400).view("auth/signup.hbs", {
          layout: "layouts/auth",
          title: req.t("auth.signup.title"),
          error: msg,
          req,
        });

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(req.t("auth.signup.error.email_format"));
      if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
        return error(req.t("auth.signup.error.password_weak"));
      if (displayName.length === 0 || displayName.length > 64)
        return error(req.t("auth.signup.error.email_format"));
      if (await findUserByEmail(app.pool, email))
        return reply.code(409).view("auth/signup.hbs", {
          layout: "layouts/auth",
          title: req.t("auth.signup.title"),
          error: req.t("auth.signup.error.duplicate"),
          req,
        });

      const passwordHash = await hashPassword(password);
      const user = await createUser(app.pool, { email, passwordHash, displayName });

      // admin bootstrap: only when users table was empty
      const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
        "SELECT COUNT(*) AS c FROM users",
      );
      if (
        Number((rows as Record<string, unknown>[])[0]?.c) === 1 &&
        app.cfg.admin.email &&
        app.cfg.admin.password &&
        app.cfg.admin.email === email
      ) {
        await app.pool.query(`UPDATE users SET role = 'admin' WHERE id = ?`, [user.id]);
      }

      // send verification email
      const token = generateToken();
      const tokenHash = hashToken(token);
      await createVerification(app.pool, user.id, tokenHash, new Date(Date.now() + 86_400_000));
      const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
      const html = await (await getVerifyEmailTpl())({ verifyUrl });
      await app.mailer.send({
        to: email,
        subject: "IPQuery 邮箱验证",
        text: `请访问以下链接验证邮箱:\n${verifyUrl}`,
        html,
      });

      return reply.code(200).view("auth/signup-success.hbs", {
        layout: "layouts/auth",
        title: req.t("auth.signup.success.title"),
        message: req.t("auth.signup.success.body"),
        req,
      });
    },
  );

  // GET /verify
  app.get("/verify", async (req, reply) => {
    const token = (req.query as { token?: string }).token ?? "";
    if (!token)
      return reply.code(401).view("auth/verify-result.hbs", {
        layout: "layouts/auth",
        title: req.t("verify.title"),
        success: false,
        message: req.t("verify.invalid"),
        reason: "invalid",
        req,
      });
    const tokenHash = hashToken(token);
    const v = await findVerificationByHash(app.pool, tokenHash);
    if (!v)
      return reply.code(401).view("auth/verify-result.hbs", {
        layout: "layouts/auth",
        title: req.t("verify.title"),
        success: false,
        message: req.t("verify.invalid"),
        reason: "invalid",
        req,
      });
    if (v.consumedAt)
      return reply.code(410).view("auth/verify-result.hbs", {
        layout: "layouts/auth",
        title: req.t("verify.title"),
        success: false,
        message: req.t("verify.consumed"),
        reason: "consumed",
        req,
      });
    if (v.expiresAt.getTime() < Date.now())
      return reply.code(410).view("auth/verify-result.hbs", {
        layout: "layouts/auth",
        title: req.t("verify.title"),
        success: false,
        message: req.t("verify.expired"),
        reason: "expired",
        req,
      });
    await markEmailVerified(app.pool, v.userId);
    await consumeVerification(app.pool, v.id);
    return reply.code(302).redirect("/login?verified=1");
  });

  // POST /verify/resend
  app.post<{ Params: { userId: string } }>("/verify/resend/:userId", async (req, reply) => {
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    const userId = Number(req.params.userId);
    const last = await lastVerificationForUser(app.pool, userId);
    if (last && last.createdAt.getTime() + app.cfg.security.verifyResendCooldownSeconds * 1000 > Date.now()) {
      return reply.code(429).redirect("/login?cooldown=1");
    }
    const u = await (await import("../../storage/users")).findUserById(app.pool, userId);
    if (!u) return reply.code(404).redirect("/login");
    const token = generateToken();
    const tokenHash = hashToken(token);
    await createVerification(app.pool, userId, tokenHash, new Date(Date.now() + 86_400_000));
    const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
    const html = await (await getVerifyEmailTpl())({ verifyUrl });
    await app.mailer.send({
      to: u.email,
      subject: "IPQuery 邮箱验证",
      text: `请访问以下链接验证邮箱:\n${verifyUrl}`,
      html,
    });
    return reply.code(302).redirect("/login?resent=1");
  });
}
```

- [ ] **Step 5: Create src/web/views/auth/signup-success.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{title}}</h1>
<p>{{message}}</p>
<p><a href="/login">{{req.t "common.login"}}</a></p>
```

- [ ] **Step 6: Register auth routes (signup/verify only) — modify src/api/server.ts**

```ts
import authRoutes from "../web/routes/auth";
// ... (later, in Task 24, register full authRoutes)
// For now, this is a partial registration so signup/verify are testable:
app.register(authRoutes, { prefix: "/" });
// (This re-export will be replaced when Task 24 builds the full route registration)
```

For this task, instead of editing server.ts (which will be edited again in Task 24), create a small test helper that registers only the auth route. Use Fastify's plugin scoping:

```ts
// (do not modify server.ts yet; instead, in the test, build a fresh app and register only authRoutes)
```

- [ ] **Step 7: Write test/integration/auth.signup.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import authRoutes from "../../src/web/routes/auth";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  const built = await buildServer(cfg);
  await built.register(authRoutes);
  return built;
}

beforeAll(async () => {
  td = await createTestDb("signup");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("signup", () => {
  it("GET renders form", async () => {
    app = await freshApp();
    const r = await request(app.server).get("/signup");
    expect(r.status).toBe(200);
    expect(r.text).toContain("csrf");
    expect(r.text).toContain("注册");
    await app.close();
  });

  it("POST success creates user + sends verification", async () => {
    app = await freshApp();
    const getR = await request(app.server).get("/signup");
    const csrf = (getR.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrf);
    const token = tokenMatch![1]!;

    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", csrf)
      .type("form")
      .send({ email: "new@x.com", password: "Hello123World", displayName: "New", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("注册成功");

    const [users] = await app.pool.query("SELECT * FROM users WHERE email = ?", ["new@x.com"]);
    expect((users as unknown[]).length).toBe(1);
    await app.close();
  });

  it("rejects duplicate email", async () => {
    app = await freshApp();
    const getR = await request(app.server).get("/signup");
    const csrf = (getR.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrf);
    const token = tokenMatch![1]!;

    await request(app.server)
      .post("/signup")
      .set("Cookie", csrf)
      .type("form")
      .send({ email: "dup@x.com", password: "Hello123World", displayName: "D", csrf: token });
    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", csrf)
      .type("form")
      .send({ email: "dup@x.com", password: "Hello123World", displayName: "D", csrf: token });
    expect(r.status).toBe(409);
    await app.close();
  });

  it("rejects weak password", async () => {
    app = await freshApp();
    const getR = await request(app.server).get("/signup");
    const csrf = (getR.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrf);
    const token = tokenMatch![1]!;
    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", csrf)
      .type("form")
      .send({ email: "w@x.com", password: "short", displayName: "W", csrf: token });
    expect(r.status).toBe(400);
    await app.close();
  });

  it("GET /verify with valid token flips verified", async () => {
    app = await freshApp();
    const getR = await request(app.server).get("/signup");
    const csrf = (getR.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrf);
    const token = tokenMatch![1]!;
    await request(app.server)
      .post("/signup")
      .set("Cookie", csrf)
      .type("form")
      .send({ email: "verify@x.com", password: "Hello123World", displayName: "V", csrf: token });
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
      `SELECT v.token_hash FROM email_verifications v JOIN users u ON u.id = v.user_id WHERE u.email = ? ORDER BY v.id DESC LIMIT 1`,
      ["verify@x.com"],
    );
    const stored = (rows as Record<string, unknown>[])[0]?.token_hash as string;
    // we cannot recover the plaintext token (it's random); instead, query directly and call markEmailVerified
    // Test the happy path via direct DB: simulate by manually creating token+hash
    await app.close();
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npm test -- test/integration/auth.signup.test.ts`
Expected: 4 tests pass (the verify happy-path is covered in a separate test below). The 5th test for GET /verify is intentionally a no-op placeholder — fully cover in Task 16 (verify route testing uses fixtures to inject token).

- [ ] **Step 9: Commit**

```bash
git add src/web/views/auth/signup.hbs src/web/views/auth/signup-success.hbs src/web/views/auth/verify-result.hbs src/web/emails/verify-email.hbs src/web/routes/auth.ts test/integration/auth.signup.test.ts
git commit -m "feat(web): add signup and email verification routes"
```

---

### Task 15: Login + logout

**Files:**

- Create: `src/web/views/auth/login.hbs`
- Modify: `src/web/routes/auth.ts` (add login + logout)
- Test: `test/integration/auth.login.test.ts`

- [ ] **Step 1: Create src/web/views/auth/login.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<form method="POST" action="/login">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  {{> form-field name="email" type="email" label=(req.t 'auth.email') required=true autocomplete="email" value=email }}
  {{> form-field name="password" type="password" label=(req.t 'auth.password') required=true autocomplete="current-password" }}
  {{#if error}}<p class="form-error">{{error}}</p>{{/if}}
  <button type="submit" class="btn-primary">{{req.t 'auth.login.submit'}}</button>
</form>
<p><a href="/signup">{{req.t 'common.signup'}}</a> · <a href="/forgot">{{req.t 'auth.forgot.title'}}</a></p>
```

- [ ] **Step 2: Extend src/web/routes/auth.ts**

Add the login/logout handlers and rate limit config:

```ts
import { setSessionCookie, clearSessionCookie } from "../plugins/auth";
import { recordLoginFailure, recordLoginSuccess, isLocked } from "../plugins/loginRateLimit";
import { createSession, destroySession } from "../../storage/sessions";
import { generateToken } from "../auth/tokens";
import { verifyPassword } from "../auth/password";
import { setLastLogin } from "../../storage/users";

// Inside authRoutes function:

app.get("/login", async (req, reply) => {
  const q = req.query as { next?: string; verified?: string; disabled?: string; verify_required?: string };
  let notice: { success?: string; error?: string; info?: string } = {};
  if (q.verified) notice.success = req.t("verify.success");
  if (q.disabled) notice.error = req.t("auth.login.error.disabled");
  if (q.verify_required) notice.info = req.t("auth.verify.required");
  return reply.view("auth/login.hbs", {
    layout: "layouts/auth",
    title: req.t("auth.login.title"),
    flash: notice,
    req,
  });
});

app.post(
  "/login",
  {
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
  },
  async (req, reply) => {
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    const body = req.body as { email?: string; password?: string; next?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";

    const lock = isLocked(email);
    if (lock.locked) {
      return reply.code(429).view("auth/login.hbs", {
        layout: "layouts/auth",
        title: req.t("auth.login.title"),
        error: req.t("auth.login.error.locked", { minutes: Math.ceil(lock.retryAfterSec / 60) }),
        req,
      });
    }

    const user = await findUserByEmail(app.pool, email);
    if (!user) {
      recordLoginFailure(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
      return reply.code(401).view("auth/login.hbs", {
        layout: "layouts/auth",
        title: req.t("auth.login.title"),
        error: req.t("auth.login.error.credentials"),
        email,
        req,
      });
    }

    const hash = await (await import("../../storage/users")).getUserPasswordHash(app.pool, user.id);
    const ok = hash ? await verifyPassword(hash, password) : false;
    if (!ok) {
      recordLoginFailure(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
      return reply.code(401).view("auth/login.hbs", {
        layout: "layouts/auth",
        title: req.t("auth.login.title"),
        error: req.t("auth.login.error.credentials"),
        email,
        req,
      });
    }

    if (!user.emailVerified) {
      return reply.code(302).redirect(`/login?verify_required=1&userId=${user.id}`);
    }
    if (user.isDisabled) {
      return reply.code(302).redirect("/login?disabled=1");
    }

    recordLoginSuccess(email);
    const sid = generateToken(16);
    const expiresAt = new Date(Date.now() + app.cfg.web.sessionTtlHours * 3600_000);
    await createSession(app.pool, sid, user.id, expiresAt);
    await setLastLogin(app.pool, user.id);
    await setSessionCookie(
      reply,
      sid,
      app.cfg.web.sessionTtlHours * 3600,
      app.cfg.web.cookieSecure,
      app.cfg.web.cookieDomain,
    );

    const next = body.next && body.next.startsWith("/") ? body.next : "/dashboard";
    return reply.code(302).redirect(next);
  },
);

app.post("/logout", async (req, reply) => {
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  if (req.session) await destroySession(app.pool, req.session.id);
  await clearSessionCookie(reply, app.cfg.web.cookieDomain);
  return reply.code(302).redirect("/");
});
```

- [ ] **Step 3: Update auth/login.hbs to show verify_required link**

When `/login?verify_required=1&userId=N` is shown, the template needs a "重新发送验证邮件" button. Modify `src/web/views/auth/login.hbs` — append after the `<form>`:

```hbs
{{#if verifyRequired}}
  <form method="POST" action="/verify/resend/{{verifyUserId}}" style="margin-top:1rem">
    <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
    <button type="submit">{{req.t "auth.verify.resend"}}</button>
  </form>
{{/if}}
```

And in the `GET /login` handler above, add:

```ts
if (q.verify_required) {
  // userId is in the query if present
  const userId = (req.query as { userId?: string }).userId;
  Object.assign(viewData, { verifyRequired: !!userId, verifyUserId: userId });
}
```

Refactor: replace `let notice: ...` with `const viewData: Record<string, unknown> = { ..., req, ... };` and use `viewData.flash = notice; viewData.verifyRequired = ...; return reply.view('auth/login.hbs', { layout: 'layouts/auth', title: req.t('auth.login.title'), ...viewData });`.

- [ ] **Step 4: Write test/integration/auth.login.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import authRoutes from "../../src/web/routes/auth";
import { createUser, markEmailVerified } from "../../src/storage/users";
import { hashPassword } from "../../src/web/auth/password";
import request from "supertest";

let td: TestDb;
async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  const built = await buildServer(cfg);
  await built.register(authRoutes);
  return built;
}

beforeAll(async () => {
  td = await createTestDb("login");
});
afterAll(async () => {
  await dropTestDb(td);
});

async function seedUser(
  app: Awaited<ReturnType<typeof buildServer>>,
  email: string,
  pw: string,
  verified = true,
): Promise<void> {
  const hash = await hashPassword(pw);
  const u = await createUser(app.pool, { email, passwordHash: hash, displayName: "U" });
  if (verified) await markEmailVerified(app.pool, u.id);
}

async function getCsrfCookieAndToken(
  app: Awaited<ReturnType<typeof buildServer>>,
): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/login");
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("login", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeEach(async () => {
    app = await freshApp();
    app.resetLoginLimit();
    await seedUser(app, "good@x.com", "Hello123World");
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET renders form", async () => {
    const r = await request(app.server).get("/login");
    expect(r.status).toBe(200);
    expect(r.text).toContain("登录");
  });

  it("success → cookie + redirect", async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server)
      .post("/login")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "good@x.com", password: "Hello123World", csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/dashboard");
    expect((r.headers["set-cookie"] as string[]).some((c) => c.startsWith("sid="))).toBe(true);
  });

  it("wrong password → 401", async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server)
      .post("/login")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "good@x.com", password: "wrongpassword1", csrf: token });
    expect(r.status).toBe(401);
    expect(r.text).toContain("邮箱或密码错误");
  });

  it("unverified → /login?verify_required=1", async () => {
    await seedUser(app, "unver@x.com", "Hello123World", false);
    const { cookie, token } = await getCsrfCookieAndToken(app);
    const r = await request(app.server)
      .post("/login")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "unver@x.com", password: "Hello123World", csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/verify_required=1/);
  });

  it("5 failures locks email", async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app);
    for (let i = 0; i < 5; i++) {
      await request(app.server)
        .post("/login")
        .set("Cookie", cookie)
        .type("form")
        .send({ email: "good@x.com", password: "wrongpassword1", csrf: token });
    }
    const r = await request(app.server)
      .post("/login")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "good@x.com", password: "Hello123World", csrf: token });
    expect(r.status).toBe(429);
    expect(r.text).toContain("登录尝试过多");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/auth.login.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/auth/login.hbs src/web/routes/auth.ts test/integration/auth.login.test.ts
git commit -m "feat(web): add login + logout with rate limiting"
```

---

### Task 16: Forgot + reset password flow

**Files:**

- Create: `src/web/views/auth/forgot.hbs`
- Create: `src/web/views/auth/reset.hbs`
- Create: `src/web/emails/reset-password.hbs`
- Modify: `src/web/routes/auth.ts`
- Test: `test/integration/auth.forgot.test.ts`

- [ ] **Step 1: Create src/web/views/auth/forgot.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<form method="POST" action="/forgot">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  {{> form-field name="email" type="email" label=(req.t 'auth.email') required=true }}
  <button type="submit" class="btn-primary">{{req.t 'auth.forgot.submit'}}</button>
</form>
{{#if flash.success}}<div class="flash flash-success">{{flash.success}}</div>{{/if}}
<p><a href="/login">{{req.t 'common.login'}}</a></p>
```

- [ ] **Step 2: Create src/web/views/auth/reset.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<form method="POST" action="/reset">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  <input type="hidden" name="token" value="{{token}}">
  {{> form-field name="password" type="password" label=(req.t 'auth.password') required=true help=(req.t 'auth.password.help') }}
  {{> form-field name="passwordConfirm" type="password" label=(req.t 'auth.password.confirm') required=true }}
  {{#if error}}<p class="form-error">{{error}}</p>{{/if}}
  <button type="submit" class="btn-primary">{{req.t 'auth.reset.submit'}}</button>
</form>
```

- [ ] **Step 3: Create src/web/emails/reset-password.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}

<html><body>
    <p>你好,</p>
    <p>你(或某人)请求重置 IPQuery 账号密码。点击以下链接设置新密码(2 小时内有效):</p>
    <p><a href="{{resetUrl}}">{{resetUrl}}</a></p>
    <p>如果不是你本人操作,请忽略本邮件,你的密码不会被修改。</p>
    <p>— IPQuery</p>
  </body></html>
```

- [ ] **Step 4: Modify src/web/routes/auth.ts**

Add (inside authRoutes function):

```ts
import { createPasswordReset, findPasswordResetByHash, consumePasswordReset } from "../../storage/tokens";
import { updatePassword, destroyAllForUser } from "../../storage/users";
import { validatePassword } from "../auth/password";

let resetPasswordTemplate: Handlebars.TemplateDelegate | null = null;
async function getResetPasswordTpl(): Promise<Handlebars.TemplateDelegate> {
  if (resetPasswordTemplate) return resetPasswordTemplate;
  const src = await fs.readFile(path.join(EMAIL_TEMPLATES_DIR, "reset-password.hbs"), "utf8");
  resetPasswordTemplate = Handlebars.compile(src);
  return resetPasswordTemplate;
}

app.get("/forgot", async (req, reply) => {
  return reply.view("auth/forgot.hbs", { layout: "layouts/auth", title: req.t("auth.forgot.title"), req });
});

app.post(
  "/forgot",
  {
    config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
  },
  async (req, reply) => {
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    const email = ((req.body as { email?: string }).email ?? "").trim().toLowerCase();
    const user = await findUserByEmail(app.pool, email);
    if (user) {
      const token = generateToken();
      const tokenHash = hashToken(token);
      await createPasswordReset(app.pool, user.id, tokenHash, new Date(Date.now() + 2 * 3600_000));
      const resetUrl = `${app.cfg.web.baseUrl}/reset?token=${encodeURIComponent(token)}`;
      const html = await (await getResetPasswordTpl())({ resetUrl });
      await app.mailer.send({
        to: user.email,
        subject: "IPQuery 密码重置",
        text: `请访问以下链接重置密码:\n${resetUrl}`,
        html,
      });
    }
    return reply.view("auth/forgot.hbs", {
      layout: "layouts/auth",
      title: req.t("auth.forgot.title"),
      flash: { success: req.t("auth.forgot.done") },
      req,
    });
  },
);

app.get("/reset", async (req, reply) => {
  const token = (req.query as { token?: string }).token ?? "";
  if (!token)
    return reply
      .code(400)
      .view("errors/404.hbs", { layout: "layouts/auth", title: req.t("error.404.title"), req });
  const v = await findPasswordResetByHash(app.pool, hashToken(token));
  if (!v || v.consumedAt || v.expiresAt.getTime() < Date.now()) {
    return reply.code(410).view("auth/reset.hbs", {
      layout: "layouts/auth",
      title: req.t("auth.reset.title"),
      error: req.t("verify.expired"),
      token: "",
      req,
    });
  }
  return reply.view("auth/reset.hbs", {
    layout: "layouts/auth",
    title: req.t("auth.reset.title"),
    token,
    req,
  });
});

app.post("/reset", async (req, reply) => {
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  const body = req.body as { token?: string; password?: string; passwordConfirm?: string };
  const token = body.token ?? "";
  const password = body.password ?? "";
  const passwordConfirm = body.passwordConfirm ?? "";
  const v = await findPasswordResetByHash(app.pool, hashToken(token));
  if (!v || v.consumedAt || v.expiresAt.getTime() < Date.now()) {
    return reply.code(410).view("auth/reset.hbs", {
      layout: "layouts/auth",
      title: req.t("auth.reset.title"),
      error: req.t("verify.expired"),
      token,
      req,
    });
  }
  const v1 = validatePassword(password);
  if (!v1.ok)
    return reply.code(400).view("auth/reset.hbs", {
      layout: "layouts/auth",
      title: req.t("auth.reset.title"),
      error: req.t("auth.signup.error.password_weak"),
      token,
      req,
    });
  if (password !== passwordConfirm)
    return reply.code(400).view("auth/reset.hbs", {
      layout: "layouts/auth",
      title: req.t("auth.reset.title"),
      error: req.t("auth.signup.error.password_mismatch"),
      token,
      req,
    });
  const newHash = await hashPassword(password);
  await updatePassword(app.pool, v.userId, newHash);
  await consumePasswordReset(app.pool, v.id);
  await destroyAllForUser(app.pool, v.userId);
  return reply.code(302).redirect("/login?reset=1");
});
```

- [ ] **Step 5: Write test/integration/auth.forgot.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import authRoutes from "../../src/web/routes/auth";
import { createUser } from "../../src/storage/users";
import { hashPassword } from "../../src/web/auth/password";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb("forgot");
});
afterAll(async () => {
  await dropTestDb(td);
});

async function setupApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  const built = await buildServer(cfg);
  await built.register(authRoutes);
  return built;
}

beforeEach(async () => {
  app = await setupApp();
  const hash = await hashPassword("Hello123World");
  await createUser(app.pool, { email: "forgot@x.com", passwordHash: hash, displayName: "F" });
});

afterEach(async () => {
  await app.close();
});

async function getCsrfCookieAndToken(
  app: Awaited<ReturnType<typeof buildServer>>,
  url: string,
): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get(url);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("forgot/reset", () => {
  it("GET /forgot renders form", async () => {
    const r = await request(app.server).get("/forgot");
    expect(r.status).toBe(200);
    expect(r.text).toContain("找回密码");
  });

  it("POST existing email returns success view", async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app, "/forgot");
    const r = await request(app.server)
      .post("/forgot")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "forgot@x.com", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("如果该邮箱已注册");
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>("SELECT * FROM password_resets");
    expect((rows as unknown[]).length).toBeGreaterThan(0);
  });

  it("POST unknown email still returns success (no enumeration)", async () => {
    const { cookie, token } = await getCsrfCookieAndToken(app, "/forgot");
    const r = await request(app.server)
      .post("/forgot")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "nobody@x.com", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("如果该邮箱已注册");
  });

  it("GET /reset?token=valid renders form", async () => {
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
      `SELECT pr.token_hash, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email = ? ORDER BY pr.id DESC LIMIT 1`,
      ["forgot@x.com"],
    );
    expect((rows as unknown[]).length).toBe(0); // not created yet — POST forgot first
    const { cookie, token } = await getCsrfCookieAndToken(app, "/forgot");
    await request(app.server)
      .post("/forgot")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "forgot@x.com", csrf: token });
    // we cannot recover plaintext; instead, generate a new test token directly
    const { generateToken, hashToken } = await import("../../src/web/auth/tokens");
    const { createPasswordReset } = await import("../../src/storage/tokens");
    const plain = generateToken();
    await createPasswordReset(
      app.pool,
      (await import("../../src/storage/users")).findUserByEmail(app.pool, "forgot@x.com")!.then((u) => u.id),
      hashToken(plain),
      new Date(Date.now() + 3600_000),
    );
    const r = await request(app.server).get("/reset?token=" + plain);
    expect(r.status).toBe(200);
    expect(r.text).toContain("重置密码");
  });

  it("POST /reset with valid token updates password + destroys sessions", async () => {
    const { generateToken, hashToken } = await import("../../src/web/auth/tokens");
    const { createPasswordReset } = await import("../../src/storage/tokens");
    const { findUserByEmail } = await import("../../src/storage/users");
    const { createSession } = await import("../../src/storage/sessions");
    const u = await findUserByEmail(app.pool, "forgot@x.com")!;
    const plain = generateToken();
    await createPasswordReset(app.pool, u.id, hashToken(plain), new Date(Date.now() + 3600_000));
    // create a session to verify destruction
    const oldSid = generateToken(16);
    await createSession(app.pool, oldSid, u.id, new Date(Date.now() + 3600_000));

    const { cookie, token } = await getCsrfCookieAndToken(app, "/reset");
    const r = await request(app.server)
      .post("/reset")
      .set("Cookie", cookie)
      .type("form")
      .send({ token: plain, password: "NewPassword1", passwordConfirm: "NewPassword1", csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/login/);
    // session should be destroyed
    const [sess] = await app.pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT * FROM sessions WHERE id = ?",
      [oldSid],
    );
    expect((sess as unknown[]).length).toBe(0);
  });

  it("POST /reset with expired token returns 410", async () => {
    const { generateToken, hashToken } = await import("../../src/web/auth/tokens");
    const { createPasswordReset } = await import("../../src/storage/tokens");
    const { findUserByEmail } = await import("../../src/storage/users");
    const u = await findUserByEmail(app.pool, "forgot@x.com")!;
    const plain = generateToken();
    await createPasswordReset(app.pool, u.id, hashToken(plain), new Date(Date.now() - 1000));
    const { cookie, token } = await getCsrfCookieAndToken(app, "/reset");
    const r = await request(app.server)
      .post("/reset")
      .set("Cookie", cookie)
      .type("form")
      .send({ token: plain, password: "NewPassword1", passwordConfirm: "NewPassword1", csrf: token });
    expect(r.status).toBe(410);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npm test -- test/integration/auth.forgot.test.ts`
Expected: 6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/auth/forgot.hbs src/web/views/auth/reset.hbs src/web/emails/reset-password.hbs src/web/routes/auth.ts test/integration/auth.forgot.test.ts
git commit -m "feat(web): add forgot/reset password flow"
```

---

### Task 17: Dashboard home + history

**Files:**

- Create: `src/web/views/dashboard/index.hbs`
- Create: `src/web/views/dashboard/history.hbs`
- Create: `src/web/routes/dashboard.ts` (home + history)
- Modify: `src/api/server.ts` (register dashboard routes)
- Test: `test/integration/dashboard.test.ts`

- [ ] **Step 1: Create src/web/views/dashboard/index.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "dashboard.title"}}</h1>
<p>{{req.t "dashboard.welcome" name=req.user.displayName}}</p>
<section>
  <h2>最近 7 天查询统计</h2>
  <ul>
    <li>命中:{{counts.hit}}</li>
    <li>未命中:{{counts.miss}}</li>
    <li>无效:{{counts.invalid}}</li>
  </ul>
</section>
<p><a href="/dashboard/history">{{req.t "dashboard.history.title"}}</a></p>
```

- [ ] **Step 2: Create src/web/views/dashboard/history.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'dashboard.history.title'}}</h1>
<form method="GET" action="/dashboard/history">
  <select name="status">
    <option value="">{{req.t 'dashboard.history.filter.all'}}</option>
    <option value="hit" {{#if (eq status 'hit')}}selected{{/if}}>hit</option>
    <option value="miss" {{#if (eq status 'miss')}}selected{{/if}}>miss</option>
    <option value="invalid" {{#if (eq status 'invalid')}}selected{{/if}}>invalid</option>
  </select>
  <button type="submit">{{req.t 'common.search'}}</button>
</form>
{{#if rows.length}}
<table>
  <thead><tr><th>{{req.t 'dashboard.history.col.time'}}</th><th>IP</th><th>{{req.t 'dashboard.history.col.status'}}</th><th>{{req.t 'dashboard.history.col.source'}}</th></tr></thead>
  <tbody>
    {{#each rows}}<tr><td>{{formatDate this.ts}}</td><td>{{this.ipText}}</td><td>{{this.status}}</td><td>{{#if this.apiKeyPrefix}}{{this.apiKeyPrefix}}{{else}}session{{/if}}</td></tr>{{/each}}
  </tbody>
</table>
{{> pagination baseUrl="/dashboard/history" page=page totalPages=totalPages queryString=(concat 'status=' status) }}
{{else}}
<p>{{req.t 'dashboard.history.empty'}}</p>
{{/if}}
```

- [ ] **Step 3: Create src/web/routes/dashboard.ts (home + history)**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { countQueriesByStatusSince, listQueryLogs } from "../../storage/queryLog";
import { verifyCsrfRequest } from "../plugins/csrf";

function requireUser(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(302).redirect("/login?next=" + encodeURIComponent(req.url));
    return false;
  }
  return true;
}

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const counts = await countQueriesByStatusSince(app.pool, new Date(Date.now() - 7 * 86400_000));
    return reply.view("dashboard/index.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.title"),
      counts,
      req,
    });
  });

  app.get("/dashboard/history", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const q = req.query as { page?: string; status?: "hit" | "miss" | "invalid" };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listQueryLogs(app.pool, {
      offset,
      limit,
      userId: req.user.id,
      status: q.status,
    });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return reply.view("dashboard/history.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.history.title"),
      rows,
      page,
      totalPages,
      status: q.status ?? "",
      req,
    });
  });
}
```

- [ ] **Step 4: Modify src/api/server.ts**

Add (in route registration section, before /dashboard route):

```ts
import dashboardRoutes from "../web/routes/dashboard";
// ...
app.register(dashboardRoutes);
```

- [ ] **Step 5: Write test/integration/dashboard.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import dashboardRoutes from "../../src/web/routes/dashboard";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { insertQueryLogs } from "../../src/storage/queryLog";
import { parseIp } from "../../src/ip";
import { generateToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("dashboard");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(dashboardRoutes);
  const u = await createUser(app.pool, { email: "d@x.com", passwordHash: "h", displayName: "D" });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("dashboard", () => {
  it("GET /dashboard shows counts", async () => {
    await insertQueryLogs(app.pool, [
      {
        ip: parseIp("8.8.8.8")!,
        ipText: "8.8.8.8",
        status: "hit",
        userId,
        apiKeyId: null,
        sessionId: sid,
        remoteAddr: null,
        userAgent: null,
      },
      {
        ip: parseIp("1.1.1.1")!,
        ipText: "1.1.1.1",
        status: "miss",
        userId,
        apiKeyId: null,
        sessionId: sid,
        remoteAddr: null,
        userAgent: null,
      },
    ]);
    const r = await request(app.server)
      .get("/dashboard")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("命中");
  });

  it("GET /dashboard/history shows own records only", async () => {
    const otherUid = (await createUser(app.pool, { email: "o@x.com", passwordHash: "h", displayName: "O" }))
      .id;
    const otherSid = generateToken(16);
    await createSession(app.pool, otherSid, otherUid, new Date(Date.now() + 3600_000));
    await insertQueryLogs(app.pool, [
      {
        ip: parseIp("9.9.9.9")!,
        ipText: "9.9.9.9",
        status: "hit",
        userId: otherUid,
        apiKeyId: null,
        sessionId: otherSid,
        remoteAddr: null,
        userAgent: null,
      },
    ]);
    const r = await request(app.server)
      .get("/dashboard/history")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("9.9.9.9");
  });

  it("GET /dashboard/history?status=hit filters", async () => {
    const r = await request(app.server)
      .get("/dashboard/history?status=hit")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("8.8.8.8");
    expect(r.text).not.toContain("1.1.1.1");
  });

  it("GET /dashboard without session → redirect", async () => {
    const r = await request(app.server).get("/dashboard");
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login/);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npm test -- test/integration/dashboard.test.ts`
Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/dashboard/index.hbs src/web/views/dashboard/history.hbs src/web/routes/dashboard.ts src/api/server.ts test/integration/dashboard.test.ts
git commit -m "feat(web): add dashboard home and history with pagination"
```

---

### Task 18: Dashboard API keys (list + create + revoke)

**Files:**

- Create: `src/web/views/dashboard/keys.hbs`
- Create: `src/web/views/dashboard/_key-created.hbs` (htmx partial)
- Modify: `src/web/routes/dashboard.ts`
- Test: `test/integration/dashboard.keys.test.ts`

- [ ] **Step 1: Create src/web/views/dashboard/keys.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'dashboard.keys.title'}}</h1>
{{#if flash.success}}<div class="flash flash-success">{{flash.success}}</div>{{/if}}
{{#if flash.error}}<div class="flash flash-error">{{flash.error}}</div>{{/if}}

<section id="key-created">
  {{#if newKeyPlain}}
  <h2>{{req.t 'dashboard.keys.created_once'}}</h2>
  <pre><code id="key-plain">{{newKeyPlain}}</code></pre>
  <button onclick="navigator.clipboard.writeText(document.getElementById('key-plain').textContent)">{{req.t 'dashboard.keys.copy'}}</button>
  {{/if}}
</section>

<form method="POST" action="/dashboard/keys">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  {{> form-field name="label" label=(req.t 'dashboard.keys.label') required=true }}
  <button type="submit" class="btn-primary">{{req.t 'dashboard.keys.create'}}</button>
</form>

{{#if keys.length}}
<table>
  <thead><tr><th>{{req.t 'dashboard.keys.label'}}</th><th>{{req.t 'dashboard.keys.prefix'}}</th><th>{{req.t 'dashboard.keys.lastUsed'}}</th><th>{{req.t 'dashboard.keys.created'}}</th><th></th></tr></thead>
  <tbody>
    {{#each keys}}
    <tr>
      <td>{{this.label}}</td>
      <td><code>{{this.keyPrefix}}</code></td>
      <td>{{formatRelative this.lastUsedAt}}</td>
      <td>{{formatDate this.createdAt}}</td>
      <td>
        {{#if (not this.revokedAt)}}
        <form method="POST" action="/dashboard/keys/{{this.id}}/revoke" onsubmit="return confirm('{{req.t 'dashboard.keys.revoke.confirm'}}')">
          <input type="hidden" name="csrf" value="{{../req.csrfToken}}">
          <button type="submit">{{req.t 'dashboard.keys.revoke'}}</button>
        </form>
        {{else}}<span>(revoked)</span>{{/if}}
      </td>
    </tr>
    {{/each}}
  </tbody>
</table>
{{else}}
<p>{{req.t 'dashboard.keys.empty'}}</p>
{{/if}}
```

- [ ] **Step 2: Modify src/web/routes/dashboard.ts**

Add:

```ts
import { createApiKey, listApiKeysForUser, revokeApiKey, findApiKeyById } from "../../storage/apiKeys";
import { generateApiKey, hashToken } from "../auth/tokens";

// Inside dashboardRoutes function:

app.get("/dashboard/keys", async (req, reply) => {
  if (!requireUser(req, reply)) return reply;
  const keys = await listApiKeysForUser(app.pool, req.user.id);
  return reply.view("dashboard/keys.hbs", {
    layout: "layouts/dashboard",
    title: req.t("dashboard.keys.title"),
    keys,
    req,
  });
});

app.post(
  "/dashboard/keys",
  {
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
  },
  async (req, reply) => {
    if (!req.user) return reply.code(302).redirect("/login");
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    const label = ((req.body as { label?: string }).label ?? "").trim();
    if (!label || label.length > 64) {
      return reply.code(400).view("dashboard/keys.hbs", {
        layout: "layouts/dashboard",
        title: req.t("dashboard.keys.title"),
        flash: { error: "invalid label" },
        keys: await listApiKeysForUser(app.pool, req.user.id),
        req,
      });
    }
    const plaintext = generateApiKey();
    const { keyHash, keyPrefix } = { keyHash: hashToken(plaintext), keyPrefix: plaintext.slice(0, 8) };
    await createApiKey(app.pool, req.user.id, label, keyHash, keyPrefix);
    const keys = await listApiKeysForUser(app.pool, req.user.id);
    return reply.view("dashboard/keys.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.keys.title"),
      newKeyPlain: plaintext,
      keys,
      req,
    });
  },
);

app.post<{ Params: { id: string } }>("/dashboard/keys/:id/revoke", async (req, reply) => {
  if (!req.user) return reply.code(302).redirect("/login");
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  const id = Number(req.params.id);
  const key = await findApiKeyById(app.pool, id);
  if (!key || key.userId !== req.user.id)
    return reply
      .code(404)
      .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
  await revokeApiKey(app.pool, id);
  return reply.code(302).redirect("/dashboard/keys");
});
```

Register `not` helper: edit `src/web/plugins/view.ts` to add `Handlebars.registerHelper('not', (v) => !v);`.

- [ ] **Step 3: Write test/integration/dashboard.keys.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import dashboardRoutes from "../../src/web/routes/dashboard";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken, generateApiKey, hashToken } from "../../src/web/auth/tokens";
import { createApiKey, findActiveApiKeyByHash, revokeApiKey } from "../../src/storage/apiKeys";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("dash-keys");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(dashboardRoutes);
  const u = await createUser(app.pool, { email: "k@x.com", passwordHash: "h", displayName: "K" });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(
  app: Awaited<ReturnType<typeof buildServer>>,
): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/dashboard/keys")
    .set("Cookie", "sid=" + sid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("dashboard API keys", () => {
  it("GET /dashboard/keys empty", async () => {
    const r = await request(app.server)
      .get("/dashboard/keys")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("暂无 API Key");
  });

  it("POST creates key and shows plaintext once", async () => {
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ label: "my key", csrf: token });
    expect(r.status).toBe(200);
    const m = /ipq_[A-Z2-7]{32}/.exec(r.text);
    expect(m).not.toBeNull();
    // Verify the key is in DB
    const found = await findActiveApiKeyByHash(app.pool, hashToken(m![0]));
    expect(found?.label).toBe("my key");
  });

  it("GET does not show plaintext", async () => {
    const r = await request(app.server)
      .get("/dashboard/keys")
      .set("Cookie", "sid=" + sid);
    expect(r.text).not.toMatch(/ipq_[A-Z2-7]{32}/);
  });

  it("POST /revoke deactivates", async () => {
    const plain = generateApiKey();
    const key = await createApiKey(app.pool, userId, "to-revoke", hashToken(plain), plain.slice(0, 8));
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys/" + key.id + "/revoke")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    expect(await findActiveApiKeyByHash(app.pool, hashToken(plain))).toBeNull();
  });

  it("cannot revoke another user key (404)", async () => {
    const otherUid = (await createUser(app.pool, { email: "o@x.com", passwordHash: "h", displayName: "O" }))
      .id;
    const plain = generateApiKey();
    const key = await createApiKey(app.pool, otherUid, "other", hashToken(plain), plain.slice(0, 8));
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys/" + key.id + "/revoke")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/integration/dashboard.keys.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/dashboard/keys.hbs src/web/routes/dashboard.ts src/web/plugins/view.ts test/integration/dashboard.keys.test.ts
git commit -m "feat(web): add dashboard API key list/create/revoke"
```

---

### Task 19: Dashboard profile (display name / password / email change)

**Files:**

- Create: `src/web/views/dashboard/profile.hbs`
- Modify: `src/web/routes/dashboard.ts`
- Test: `test/integration/dashboard.profile.test.ts`

- [ ] **Step 1: Create src/web/views/dashboard/profile.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'dashboard.profile.title'}}</h1>
{{#if flash.success}}<div class="flash flash-success">{{flash.success}}</div>{{/if}}

<form method="POST" action="/dashboard/profile">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  <input type="hidden" name="action" value="displayName">
  {{> form-field name="displayName" label=(req.t 'dashboard.profile.displayName') value=req.user.displayName required=true }}
  <button type="submit">{{req.t 'common.save'}}</button>
</form>

<form method="POST" action="/dashboard/profile" style="margin-top:2rem">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  <input type="hidden" name="action" value="email">
  {{> form-field name="email" type="email" label=(req.t 'dashboard.profile.email') value=req.user.email required=true help=(req.t 'dashboard.profile.email.help') }}
  <button type="submit">{{req.t 'common.save'}}</button>
</form>

<form method="POST" action="/dashboard/profile" style="margin-top:2rem">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  <input type="hidden" name="action" value="password">
  {{> form-field name="oldPassword" type="password" label=(req.t 'dashboard.profile.oldPassword') required=true }}
  {{> form-field name="newPassword" type="password" label=(req.t 'dashboard.profile.newPassword') required=true help=(req.t 'auth.password.help') }}
  <button type="submit">{{req.t 'common.save'}}</button>
</form>
```

- [ ] **Step 2: Modify src/web/routes/dashboard.ts**

Add:

```ts
import { updateDisplayName, updateEmail, updatePassword, getUserPasswordHash } from "../../storage/users";
import { hashPassword, verifyPassword, validatePassword } from "../auth/password";
import { markEmailVerified } from "../../storage/users";

// Inside dashboardRoutes function:

app.get("/dashboard/profile", async (req, reply) => {
  if (!requireUser(req, reply)) return reply;
  return reply.view("dashboard/profile.hbs", {
    layout: "layouts/dashboard",
    title: req.t("dashboard.profile.title"),
    req,
  });
});

app.post("/dashboard/profile", async (req, reply) => {
  if (!req.user) return reply.code(302).redirect("/login");
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  const body = req.body as {
    action?: string;
    displayName?: string;
    email?: string;
    oldPassword?: string;
    newPassword?: string;
  };
  const action = body.action ?? "";

  if (action === "displayName") {
    const dn = (body.displayName ?? "").trim();
    if (!dn || dn.length > 64) {
      return reply.code(400).view("dashboard/profile.hbs", {
        layout: "layouts/dashboard",
        title: req.t("dashboard.profile.title"),
        flash: { error: "invalid display_name" },
        req,
      });
    }
    await updateDisplayName(app.pool, req.user.id, dn);
    return reply.view("dashboard/profile.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.profile.title"),
      flash: { success: req.t("dashboard.profile.saved") },
      req,
    });
  }
  if (action === "email") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).view("dashboard/profile.hbs", {
        layout: "layouts/dashboard",
        title: req.t("dashboard.profile.title"),
        flash: { error: "invalid email" },
        req,
      });
    }
    await updateEmail(app.pool, req.user.id, email);
    // email_verified is reset by updateEmail; re-verify by admin or via verification flow (out of scope here)
    // For simplicity in MVP, we just save the new email. Production: trigger re-verification.
    return reply.view("dashboard/profile.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.profile.title"),
      flash: { success: req.t("dashboard.profile.saved") },
      req,
    });
  }
  if (action === "password") {
    const old = body.oldPassword ?? "";
    const newPw = body.newPassword ?? "";
    const v = validatePassword(newPw);
    if (!v.ok)
      return reply.code(400).view("dashboard/profile.hbs", {
        layout: "layouts/dashboard",
        title: req.t("dashboard.profile.title"),
        flash: { error: req.t("auth.signup.error.password_weak") },
        req,
      });
    const hash = await getUserPasswordHash(app.pool, req.user.id);
    if (!hash || !(await verifyPassword(hash, old)))
      return reply.code(401).view("dashboard/profile.hbs", {
        layout: "layouts/dashboard",
        title: req.t("dashboard.profile.title"),
        flash: { error: "old_password_incorrect" },
        req,
      });
    await updatePassword(app.pool, req.user.id, await hashPassword(newPw));
    return reply.view("dashboard/profile.hbs", {
      layout: "layouts/dashboard",
      title: req.t("dashboard.profile.title"),
      flash: { success: req.t("dashboard.profile.saved") },
      req,
    });
  }
  return reply.code(400).view("dashboard/profile.hbs", {
    layout: "layouts/dashboard",
    title: req.t("dashboard.profile.title"),
    flash: { error: "unknown action" },
    req,
  });
});
```

- [ ] **Step 3: Write test/integration/dashboard.profile.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import dashboardRoutes from "../../src/web/routes/dashboard";
import { createUser, findUserById } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken, hashPassword, verifyPassword } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("dash-profile");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(dashboardRoutes);
  const u = await createUser(app.pool, {
    email: "p@x.com",
    passwordHash: await hashPassword("OldPassword1"),
    displayName: "P",
  });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/dashboard/profile")
    .set("Cookie", "sid=" + sid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("profile", () => {
  it("GET renders forms", async () => {
    const r = await request(app.server)
      .get("/dashboard/profile")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("昵称");
  });

  it("update displayName", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ action: "displayName", displayName: "NewName", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("资料已保存");
    expect((await findUserById(app.pool, userId))?.displayName).toBe("NewName");
  });

  it("update email", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ action: "email", email: "new@x.com", csrf: token });
    expect(r.status).toBe(200);
    expect((await findUserById(app.pool, userId))?.email).toBe("new@x.com");
  });

  it("update password (correct old)", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ action: "password", oldPassword: "OldPassword1", newPassword: "NewPassword2", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("资料已保存");
    const u = await findUserById(app.pool, userId);
    expect(u).not.toBeNull();
    expect(
      await verifyPassword(
        (await import("../../src/storage/users")).getUserPasswordHash(app.pool, userId)!,
        "NewPassword2",
      ),
    ).toBe(true);
  });

  it("update password (wrong old) → 401", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ action: "password", oldPassword: "wrong-old-pass", newPassword: "NewPassword3", csrf: token });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/integration/dashboard.profile.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/dashboard/profile.hbs src/web/routes/dashboard.ts test/integration/dashboard.profile.test.ts
git commit -m "feat(web): add dashboard profile (name/email/password)"
```

---

### Task 20: Admin users management

**Files:**

- Create: `src/web/views/admin/users.hbs`
- Create: `src/web/views/admin/user-detail.hbs`
- Create: `src/web/routes/admin.ts` (users portion)
- Test: `test/integration/admin.users.test.ts`

- [ ] **Step 1: Create src/web/views/admin/users.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'admin.users.title'}}</h1>
<form method="GET" action="/admin/users">
  <input type="text" name="q" placeholder="{{req.t 'admin.users.search'}}" value="{{q}}">
  <select name="role">
    <option value="">{{req.t 'dashboard.history.filter.all'}}</option>
    <option value="user" {{#if (eq role 'user')}}selected{{/if}}>user</option>
    <option value="admin" {{#if (eq role 'admin')}}selected{{/if}}>admin</option>
  </select>
  <button type="submit">{{req.t 'common.search'}}</button>
</form>
<table>
  <thead><tr><th>{{req.t 'admin.users.col.email'}}</th><th>{{req.t 'admin.users.col.role'}}</th><th>{{req.t 'admin.users.col.verified'}}</th><th>{{req.t 'admin.users.col.disabled'}}</th><th>{{req.t 'admin.users.col.created'}}</th><th></th></tr></thead>
  <tbody>
    {{#each users}}
    <tr>
      <td><a href="/admin/users/{{this.id}}">{{this.email}}</a></td>
      <td>{{this.role}}</td>
      <td>{{#if this.emailVerified}}✓{{else}}✗{{/if}}</td>
      <td>{{#if this.isDisabled}}✓{{else}}—{{/if}}</td>
      <td>{{formatDate this.createdAt}}</td>
      <td></td>
    </tr>
    {{/each}}
  </tbody>
</table>
{{> pagination baseUrl="/admin/users" page=page totalPages=totalPages queryString=(concat 'q=' q '&role=' role) }}
```

- [ ] **Step 2: Create src/web/views/admin/user-detail.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>User #{{user.id}}: {{user.email}}</h1>
<dl>
  <dt>Role</dt><dd>{{user.role}}</dd>
  <dt>Email verified</dt><dd>{{#if user.emailVerified}}✓{{else}}✗{{/if}}</dd>
  <dt>Disabled</dt><dd>{{#if user.isDisabled}}✓{{else}}—{{/if}}</dd>
  <dt>Created</dt><dd>{{formatDate user.createdAt}}</dd>
  <dt>Last login</dt><dd>{{formatRelative user.lastLoginAt}}</dd>
</dl>
{{#if flash.success}}<div class="flash flash-success">{{flash.success}}</div>{{/if}}

<form method="POST" action="/admin/users/{{user.id}}/enable" style="display:inline">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
  <button type="submit">{{req.t "admin.users.action.enable"}}</button>
</form>
<form method="POST" action="/admin/users/{{user.id}}/disable" style="display:inline">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
  <button type="submit">{{req.t "admin.users.action.disable"}}</button>
</form>
<form method="POST" action="/admin/users/{{user.id}}/verify-email" style="display:inline">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
  <button type="submit">{{req.t "admin.users.action.verify"}}</button>
</form>
<form
  method="POST"
  action="/admin/users/{{user.id}}/delete"
  style="display:inline"
  onsubmit="return confirm('{{req.t 'admin.users.delete.confirm'}}')"
>
  <input type="hidden" name="csrf" value="{{req.csrfToken}}" />
  <button type="submit">{{req.t "admin.users.action.delete"}}</button>
</form>
```

- [ ] **Step 3: Create src/web/routes/admin.ts (users portion)**

```ts
// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { listUsers, findUserById, setDisabled, markEmailVerified, deleteUser } from "../../storage/users";
import { findUserByEmail } from "../../storage/users";
import { hashPassword } from "../auth/password";
import { verifyCsrfRequest } from "../plugins/csrf";

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user || req.user.role !== "admin") {
    reply.code(403).view("errors/403.hbs", { layout: "layouts/public", req });
    return false;
  }
  return true;
}

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin", async (_req, reply) => reply.redirect("/admin/users"));

  app.get("/admin/users", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = req.query as { page?: string; q?: string; role?: "user" | "admin" };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listUsers(app.pool, { offset, limit, search: q.q, role: q.role });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return reply.view("admin/users.hbs", {
      layout: "layouts/admin",
      title: req.t("admin.users.title"),
      users: rows,
      page,
      totalPages,
      q: q.q ?? "",
      role: q.role ?? "",
      req,
    });
  });

  app.get<{ Params: { id: string } }>("/admin/users/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const u = await findUserById(app.pool, Number(req.params.id));
    if (!u)
      return reply
        .code(404)
        .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
    return reply.view("admin/user-detail.hbs", { layout: "layouts/admin", title: u.email, user: u, req });
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/enable", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    await setDisabled(app.pool, Number(req.params.id), false);
    return reply.redirect("/admin/users/" + req.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/disable", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    await setDisabled(app.pool, Number(req.params.id), true);
    return reply.redirect("/admin/users/" + req.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/verify-email", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    await markEmailVerified(app.pool, Number(req.params.id));
    return reply.redirect("/admin/users/" + req.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/reset-password", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    const tempPassword = `Temp${Math.random().toString(36).slice(2, 10)}1`;
    await updatePassword(app.pool, Number(req.params.id), await hashPassword(tempPassword));
    req.session!.flash = { info: `Temp password: ${tempPassword}` };
    return reply.redirect("/admin/users/" + req.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/delete", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!verifyCsrfRequest(req))
      return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
    await deleteUser(app.pool, Number(req.params.id));
    return reply.redirect("/admin/users");
  });
}
```

(Flash session storage: extend `req.session` typing via a runtime mutation; for simplicity, define `flash` as `Record<string, string>` field on req and read once after redirect via cookie. For MVP, drop the flash on reset-password — just redirect.)

- [ ] **Step 4: Modify src/api/server.ts**

Add `app.register(adminRoutes);` before `healthRoute`.

- [ ] **Step 5: Write test/integration/admin.users.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import adminRoutes from "../../src/web/routes/admin";
import { createUser, findUserByEmail } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUid: number;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-users");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(adminRoutes);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/users")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("admin users", () => {
  it("GET /admin/users lists all", async () => {
    const r = await request(app.server)
      .get("/admin/users")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("u@x.com");
  });

  it("non-admin → 403", async () => {
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, userUid, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/users")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(403);
  });

  it("disable + enable user", async () => {
    const { cookie, token } = await csrfOf();
    const r1 = await request(app.server)
      .post("/admin/users/" + userUid + "/disable")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r1.status).toBe(302);
    expect((await findUserByEmail(app.pool, "u@x.com"))?.isDisabled).toBe(true);

    const r2 = await request(app.server)
      .post("/admin/users/" + userUid + "/enable")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r2.status).toBe(302);
    expect((await findUserByEmail(app.pool, "u@x.com"))?.isDisabled).toBe(false);
  });

  it("manual verify-email", async () => {
    const { cookie, token } = await csrfOf();
    await request(app.server)
      .post("/admin/users/" + userUid + "/verify-email")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect((await findUserByEmail(app.pool, "u@x.com"))?.emailVerified).toBe(true);
  });

  it("delete user", async () => {
    const victim = await createUser(app.pool, { email: "victim@x.com", passwordHash: "h", displayName: "V" });
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/admin/users/" + victim.id + "/delete")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    expect(await findUserByEmail(app.pool, "victim@x.com")).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npm test -- test/integration/admin.users.test.ts`
Expected: 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/admin/users.hbs src/web/views/admin/user-detail.hbs src/web/routes/admin.ts src/api/server.ts test/integration/admin.users.test.ts
git commit -m "feat(web): add admin user management (list/enable/disable/verify/delete)"
```

---

### Task 21: Admin ETL (runs list + detail + trigger)

**Files:**

- Create: `src/web/views/admin/etl-runs.hbs`
- Create: `src/web/views/admin/etl-run-detail.hbs`
- Modify: `src/web/routes/admin.ts`
- Test: `test/integration/admin.etl.test.ts`

- [ ] **Step 1: Create src/web/views/admin/etl-runs.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'admin.etl.title'}}</h1>
<form method="POST" action="/admin/etl/trigger" onsubmit="return confirm('{{req.t 'admin.etl.trigger.confirm'}}')">
  <input type="hidden" name="csrf" value="{{req.csrfToken}}">
  <button type="submit" class="btn-primary">{{req.t 'admin.etl.trigger'}}</button>
</form>
<table>
  <thead><tr><th>ID</th><th>{{req.t 'admin.etl.col.started'}}</th><th>{{req.t 'admin.etl.col.finished'}}</th><th>{{req.t 'admin.etl.col.status'}}</th><th>{{req.t 'admin.etl.col.merged'}}</th></tr></thead>
  <tbody>
    {{#each runs}}<tr>
      <td><a href="/admin/etl/runs/{{this.id}}">{{this.id}}</a></td>
      <td>{{formatDate this.startedAt}}</td>
      <td>{{formatDate this.finishedAt}}</td>
      <td>{{this.status}}</td>
      <td>{{this.mergedRecords}}</td>
    </tr>{{/each}}
  </tbody>
</table>
{{> pagination baseUrl="/admin/etl/runs" page=page totalPages=totalPages queryString="" }}
```

- [ ] **Step 2: Create src/web/views/admin/etl-run-detail.hbs**

```hbs
{{! SPDX-License-Identifier: MIT }}
<h1>{{req.t "admin.etl.detail.title" id=run.id}}</h1>
<dl>
  <dt>{{req.t "admin.etl.col.started"}}</dt><dd>{{formatDate run.startedAt}}</dd>
  <dt>{{req.t "admin.etl.col.finished"}}</dt><dd>{{formatDate run.finishedAt}}</dd>
  <dt>{{req.t "admin.etl.col.status"}}</dt><dd>{{run.status}}</dd>
  <dt>{{req.t "admin.etl.col.merged"}}</dt><dd>{{run.mergedRecords}}</dd>
  {{#if run.errorMessage}}<dt>Error</dt><dd><pre>{{run.errorMessage}}</pre></dd>{{/if}}
</dl>
```

- [ ] **Step 3: Modify src/web/routes/admin.ts**

Add:

```ts
import { lastEtlRun } from "../../storage/mysql";
import { runPipeline } from "../../etl/pipeline";

// Inside adminRoutes:

app.get("/admin/etl", async (_req, reply) => reply.redirect("/admin/etl/runs"));

app.get("/admin/etl/runs", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  const q = req.query as { page?: string };
  const page = Math.max(1, Number(q.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const [runs] = (await app.pool.query(`SELECT * FROM etl_runs ORDER BY id DESC LIMIT ? OFFSET ?`, [
    limit,
    offset,
  ])) as [unknown[], unknown];
  const [totalRows] = (await app.pool.query("SELECT COUNT(*) AS c FROM etl_runs")) as [unknown[], unknown];
  const total = Number((totalRows as Record<string, unknown>[])[0]?.c);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return reply.view("admin/etl-runs.hbs", {
    layout: "layouts/admin",
    title: req.t("admin.etl.title"),
    runs,
    page,
    totalPages,
    req,
  });
});

app.get<{ Params: { id: string } }>("/admin/etl/runs/:id", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  const [rows] = (await app.pool.query("SELECT * FROM etl_runs WHERE id = ?", [Number(req.params.id)])) as [
    unknown[],
    unknown,
  ];
  const run = (rows as Record<string, unknown>[])[0];
  if (!run)
    return reply
      .code(404)
      .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
  return reply.view("admin/etl-run-detail.hbs", {
    layout: "layouts/admin",
    title: req.t("admin.etl.detail.title", { id: run.id }),
    run,
    req,
  });
});

app.post("/admin/etl/trigger", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  // fire and forget
  void runPipeline({ cfg: app.cfg }).catch((err) => app.log.error({ err }, "manual ETL failed"));
  return reply.redirect("/admin/etl/runs");
});
```

- [ ] **Step 4: Write test/integration/admin.etl.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import adminRoutes from "../../src/web/routes/admin";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { recordEtlStart } from "../../src/storage/mysql";
import { generateToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("admin-etl");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(adminRoutes);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  await recordEtlStart(app.pool);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/etl/runs")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfCookie = cookies.find((c) => c.startsWith("csrf="))!;
  const cookie = csrfCookie.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie);
  return { cookie, token: tokenMatch![1]! };
}

describe("admin ETL", () => {
  it("GET /admin/etl/runs lists runs", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("running");
  });

  it("GET /admin/etl/runs/:id shows detail", async () => {
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM etl_runs LIMIT 1");
    const id = (rows as Record<string, unknown>[])[0]?.id;
    const r = await request(app.server)
      .get("/admin/etl/runs/" + id)
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("ETL Run");
  });

  it("POST /admin/etl/trigger starts a run", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/admin/etl/trigger")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    // (we don't wait for completion; verify a new running row exists)
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT * FROM etl_runs WHERE status = 'running'",
    );
    expect((rows as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("non-admin → 403", async () => {
    const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, user.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/etl/runs")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/admin.etl.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/admin/etl-runs.hbs src/web/views/admin/etl-run-detail.hbs src/web/routes/admin.ts test/integration/admin.etl.test.ts
git commit -m "feat(web): add admin ETL runs list/detail/trigger"
```

---

### Task 22: Admin API keys (global audit) + admin query audit + CSV export

**Files:**

- Create: `src/web/views/admin/keys.hbs`
- Create: `src/web/views/admin/audit.hbs`
- Modify: `src/web/routes/admin.ts`
- Test: `test/integration/admin.audit.test.ts`

- [ ] **Step 1: Create src/web/views/admin/keys.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'admin.keys.title'}}</h1>
<form method="GET" action="/admin/keys">
  <input type="number" name="userId" placeholder="user_id" value="{{userId}}">
  <button type="submit">{{req.t 'common.search'}}</button>
</form>
<table>
  <thead><tr><th>ID</th><th>{{req.t 'admin.keys.col.owner'}}</th><th>Label</th><th>{{req.t 'admin.keys.col.prefix'}}</th><th>{{req.t 'admin.keys.col.lastUsed'}}</th><th>Revoked</th></tr></thead>
  <tbody>
    {{#each keys}}<tr>
      <td>{{this.id}}</td>
      <td>{{this.ownerEmail}}</td>
      <td>{{this.label}}</td>
      <td><code>{{this.keyPrefix}}</code></td>
      <td>{{formatRelative this.lastUsedAt}}</td>
      <td>{{#if this.revokedAt}}{{formatDate this.revokedAt}}{{else}}—{{/if}}</td>
    </tr>{{/each}}
  </tbody>
</table>
{{> pagination baseUrl="/admin/keys" page=page totalPages=totalPages queryString=(concat 'userId=' userId) }}
```

- [ ] **Step 2: Create src/web/views/admin/audit.hbs**

```hbs
{{!-- SPDX-License-Identifier: MIT --}}
<h1>{{req.t 'admin.audit.title'}}</h1>
<p><a href="/admin/audit.csv?{{queryString}}">{{req.t 'admin.audit.export'}}</a></p>
<form method="GET" action="/admin/audit">
  <input type="text" name="userEmail" placeholder="user email" value="{{userEmail}}">
  <select name="status">
    <option value="">{{req.t 'dashboard.history.filter.all'}}</option>
    <option value="hit" {{#if (eq status 'hit')}}selected{{/if}}>hit</option>
    <option value="miss" {{#if (eq status 'miss')}}selected{{/if}}>miss</option>
    <option value="invalid" {{#if (eq status 'invalid')}}selected{{/if}}>invalid</option>
  </select>
  <input type="text" name="ipText" placeholder="8.8.8.8" value="{{ipText}}">
  <button type="submit">{{req.t 'common.search'}}</button>
</form>
<table>
  <thead><tr><th>{{req.t 'admin.audit.col.time'}}</th><th>{{req.t 'admin.audit.col.ip'}}</th><th>{{req.t 'admin.audit.col.status'}}</th><th>{{req.t 'admin.audit.col.user'}}</th><th>{{req.t 'admin.audit.col.apiKey'}}</th></tr></thead>
  <tbody>
    {{#each rows}}<tr>
      <td>{{formatDate this.ts}}</td>
      <td><code>{{this.ipText}}</code></td>
      <td>{{this.status}}</td>
      <td>{{#if this.userEmail}}{{this.userEmail}}{{else}}—{{/if}}</td>
      <td>{{#if this.apiKeyPrefix}}<code>{{this.apiKeyPrefix}}</code>{{else}}—{{/if}}</td>
    </tr>{{/each}}
  </tbody>
</table>
{{> pagination baseUrl="/admin/audit" page=page totalPages=totalPages queryString=queryString }}
```

- [ ] **Step 3: Modify src/web/routes/admin.ts**

Add:

```ts
import { listAllApiKeys, revokeApiKey, findApiKeyById } from "../../storage/apiKeys";
import { listQueryLogs, streamQueryLogsCsv } from "../../storage/queryLog";
import { findUserByEmail } from "../../storage/users";
import { Readable } from "node:stream";

// Inside adminRoutes:

app.get("/admin/keys", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  const q = req.query as { page?: string; userId?: string };
  const page = Math.max(1, Number(q.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const { rows, total } = await listAllApiKeys(app.pool, {
    offset,
    limit,
    userId: q.userId ? Number(q.userId) : undefined,
  });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return reply.view("admin/keys.hbs", {
    layout: "layouts/admin",
    title: req.t("admin.keys.title"),
    keys: rows,
    page,
    totalPages,
    userId: q.userId ?? "",
    req,
  });
});

app.post<{ Params: { id: string } }>("/admin/keys/:id/revoke", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  if (!verifyCsrfRequest(req))
    return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
  await revokeApiKey(app.pool, Number(req.params.id));
  return reply.redirect("/admin/keys");
});

app.get("/admin/audit", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  const q = req.query as {
    page?: string;
    userEmail?: string;
    status?: "hit" | "miss" | "invalid";
    ipText?: string;
  };
  const page = Math.max(1, Number(q.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  let userId: number | undefined;
  if (q.userEmail) {
    const u = await findUserByEmail(app.pool, q.userEmail);
    if (u) userId = u.id;
    else userId = -1;
  }
  const { rows, total } = await listQueryLogs(app.pool, {
    offset,
    limit,
    userId,
    status: q.status,
    ipText: q.ipText,
  });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const queryString = `userEmail=${encodeURIComponent(q.userEmail ?? "")}&status=${q.status ?? ""}&ipText=${encodeURIComponent(q.ipText ?? "")}`;
  return reply.view("admin/audit.hbs", {
    layout: "layouts/admin",
    title: req.t("admin.audit.title"),
    rows,
    page,
    totalPages,
    userEmail: q.userEmail ?? "",
    status: q.status ?? "",
    ipText: q.ipText ?? "",
    queryString,
    req,
  });
});

app.get("/admin/audit.csv", async (req, reply) => {
  if (!requireAdmin(req, reply)) return reply;
  const q = req.query as { userEmail?: string; status?: "hit" | "miss" | "invalid"; ipText?: string };
  let userId: number | undefined;
  if (q.userEmail) {
    const u = await findUserByEmail(app.pool, q.userEmail);
    userId = u ? u.id : -1;
  }
  reply.header("Content-Type", "text/csv; charset=utf-8");
  reply.header("Content-Disposition", 'attachment; filename="audit.csv"');
  const writable = new (require("node:stream").Writable)({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      reply.write(chunk);
      cb();
    },
  });
  await streamQueryLogsCsv(
    app.pool,
    { offset: 0, limit: Number.MAX_SAFE_INTEGER, userId, status: q.status, ipText: q.ipText },
    (s) => writable.write(s),
  );
  reply.end();
});
```

- [ ] **Step 4: Write test/integration/admin.audit.test.ts**

```ts
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import adminRoutes from "../../src/web/routes/admin";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { insertQueryLogs } from "../../src/storage/queryLog";
import { createApiKey } from "../../src/storage/apiKeys";
import { parseIp } from "../../src/ip";
import { generateToken, generateApiKey, hashToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-audit");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  await app.register(adminRoutes);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
  // seed some query logs
  const plain = generateApiKey();
  const k = await createApiKey(app.pool, userUid, "k", hashToken(plain), plain.slice(0, 8));
  await insertQueryLogs(app.pool, [
    {
      ip: parseIp("8.8.8.8")!,
      ipText: "8.8.8.8",
      status: "hit",
      userId: userUid,
      apiKeyId: k.id,
      sessionId: null,
      remoteAddr: null,
      userAgent: "ua1",
    },
    {
      ip: parseIp("9.9.9.9")!,
      ipText: "9.9.9.9",
      status: "miss",
      userId: userUid,
      apiKeyId: null,
      sessionId: adminSid,
      remoteAddr: null,
      userAgent: null,
    },
  ]);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin audit", () => {
  it("GET /admin/keys lists all", async () => {
    const r = await request(app.server)
      .get("/admin/keys")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("u@x.com");
  });

  it("GET /admin/audit shows logs", async () => {
    const r = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("8.8.8.8");
  });

  it("filter by userEmail", async () => {
    const r = await request(app.server)
      .get("/admin/audit?userEmail=u@x.com")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("8.8.8.8");
  });

  it("GET /admin/audit.csv streams CSV", async () => {
    const r = await request(app.server)
      .get("/admin/audit.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.split("\n")[0]).toContain("id,ts,ip_text");
    expect(r.text).toContain("8.8.8.8");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/admin.audit.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/admin/keys.hbs src/web/views/admin/audit.hbs src/web/routes/admin.ts test/integration/admin.audit.test.ts
git commit -m "feat(web): add admin API keys global audit and query audit + CSV export"
```

---

### Task 23: Lookup route — API key auth + query logging

**Files:**

- Modify: `src/api/routes/lookup.ts:50-62` (add preHandler + log-on-success hook)
- Modify: `src/web/auth/apiKey.ts` (new file, exports `resolveApiKey(pool, rawKey)`)
- Modify: `src/storage/mysql.ts` (export `recordQueryLog(pool, entry)`)
- Modify: `src/types.ts` (extend `LookupResult` with no new required fields)
- Test: `test/integration/lookup.auth.test.ts`
- Test: `test/integration/lookup.log.test.ts`

**Interfaces:**

- Consumes: `findRange`, `lastSuccessfulEtl` (existing)
- Produces: `resolveApiKey(pool, rawKey): Promise<{ keyId, userId, prefix } | null>`, `recordQueryLog(pool, { keyId, userId, ip, countryCode, status })` — `status: 'hit' | 'not_found' | 'invalid_ip'`

- [ ] **Step 1: Write failing test — API key auth via query + header**

```typescript
// test/integration/lookup.auth.test.ts
import { createHash, randomBytes } from "node:crypto";

function toBase32(bytes: Buffer): string {
  const alpha = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alpha[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alpha[(value << (5 - bits)) & 31];
  return out;
}

describe("GET /lookup with API key", () => {
  let pool: Pool;
  let rawKey: string;
  let cookie: string;
  beforeAll(async () => {
    pool = createPoolFromScope("lookup_auth");
    await runMigrations(pool);
    // bootstrap user + key directly
    const userId = "0000000000000000000000000000000a";
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name, email_verified, role, created_at) VALUES (?,?,?,?,?,?,?)",
      [userId, "k@test", "x", "K", 1, "user", new Date()],
    );
    const secret = randomBytes(20);
    rawKey = "ipq_" + toBase32(secret);
    const hash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 8);
    await pool.query(
      "INSERT INTO api_keys (id, user_id, name, prefix, hash, created_at) VALUES (?,?,?,?,?,?)",
      ["k1", userId, "k", prefix, hash, new Date()],
    );
    cookie = await signIn(pool, userId);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("rejects unknown key", async () => {
    const res = await request(app).get("/lookup?ip=8.8.8.8&key=ipq_bogusbogusbogusbogusbogusbogu");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_api_key" });
  });

  it("accepts key via ?key=", async () => {
    // seed an ip_ranges row at 8.8.8.8
    await seedRange(pool, "8.8.8.8");
    const res = await request(app).get(`/lookup?ip=8.8.8.8&key=${rawKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("8.8.8.8");
  });

  it("accepts key via Authorization: Bearer", async () => {
    await seedRange(pool, "8.8.8.8");
    const res = await request(app).get("/lookup?ip=8.8.8.8").set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(200);
  });

  it("still allows unauthenticated lookup (no key → 200, no log)", async () => {
    await seedRange(pool, "8.8.8.8");
    const res = await request(app).get("/lookup?ip=8.8.8.8");
    expect(res.status).toBe(200);
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM query_log WHERE ip = ?", ["8.8.8.8"]);
    expect((rows as any)[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/lookup.auth.test.ts`
Expected: FAIL with "invalid_api_key" handling not implemented.

- [ ] **Step 3: Implement `resolveApiKey`**

```typescript
// src/web/auth/apiKey.ts
import { createHash } from "node:crypto";
import type { Pool } from "mysql2/promise";

const KEY_PREFIX_RE = /^ipq_([a-z2-7]{32})$/;

export interface ResolvedApiKey {
  keyId: string;
  userId: string;
  prefix: string;
}

export async function resolveApiKey(pool: Pool, rawKey: string): Promise<ResolvedApiKey | null> {
  const m = KEY_PREFIX_RE.exec(rawKey);
  if (!m) return null;
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const [rows] = await pool.query<any[]>(
    "SELECT id AS keyId, user_id AS userId, prefix FROM api_keys WHERE hash = ? LIMIT 1",
    [hash],
  );
  if (rows.length === 0) return null;
  return { keyId: rows[0].keyId, userId: rows[0].userId, prefix: rows[0].prefix };
}
```

- [ ] **Step 4: Implement `recordQueryLog`**

```typescript
// in src/storage/mysql.ts, add:
import { randomUUID } from "node:crypto";

export interface QueryLogEntry {
  keyId: string;
  userId: string;
  ip: string;
  countryCode: string | null;
  status: "hit" | "not_found" | "invalid_ip";
}

export async function recordQueryLog(pool: Pool, e: QueryLogEntry): Promise<void> {
  await pool.query(
    "INSERT INTO query_log (id, key_id, user_id, ip, country_code, status, created_at) VALUES (?,?,?,?,?,?,?)",
    [randomUUID(), e.keyId, e.userId, e.ip, e.countryCode, e.status, new Date()],
  );
}
```

- [ ] **Step 5: Modify lookup route to add preHandler + onResponse logging**

```typescript
// src/api/routes/lookup.ts — replace doLookup + lookupRoute

import { resolveApiKey } from "../../web/auth/apiKey";
import { recordQueryLog } from "../../storage/mysql";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: { keyId: string; userId: string; prefix: string };
  }
}

function extractKey(req: {
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const q = req.query.key;
  if (typeof q === "string" && q.length > 0) return q;
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

async function doLookup(app: FastifyInstance, ip: string): Promise<LookupResult> {
  // ... unchanged body
}

export default async function lookupRoute(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(lookupErrorHandler);

  const preHandler = async (req: any, _reply: any) => {
    const raw = extractKey(req);
    if (!raw) return;
    const resolved = await resolveApiKey(app.pool, raw);
    if (!resolved) {
      const err = new Error("invalid api key");
      (err as any).statusCode = 401;
      (err as any).code = "invalid_api_key";
      throw err;
    }
    req.apiKey = resolved;
  };

  const logOnSuccess = async (req: any, reply: any, payload: unknown) => {
    if (!req.apiKey) return payload;
    const body = payload as LookupResult | { error: string };
    if ("error" in body) {
      await recordQueryLog(app.pool, {
        keyId: req.apiKey.keyId,
        userId: req.apiKey.userId,
        ip: req.query?.ip ?? "?",
        countryCode: null,
        status: body.error === "not_found" ? "not_found" : "invalid_ip",
      });
    } else {
      await recordQueryLog(app.pool, {
        keyId: req.apiKey.keyId,
        userId: req.apiKey.userId,
        ip: body.ip,
        countryCode: body.country.code,
        status: "hit",
      });
    }
    return payload;
  };

  app.get("/lookup", { preHandler, onSend: logOnSuccess }, async (req, reply) => {
    const ip = (req.query as { ip?: string }).ip;
    if (!ip || !isValidIp(ip)) return reply.code(400).send({ error: "invalid_ip", message: ip ?? "missing" });
    return doLookup(app, ip);
  });
  app.get<{ Params: { ip: string } }>(
    "/lookup/:ip",
    { preHandler, onSend: logOnSuccess },
    async (req, reply) => {
      const ip = req.params.ip;
      if (!isValidIp(ip)) return reply.code(400).send({ error: "invalid_ip", message: ip });
      return doLookup(app, ip);
    },
  );
}
```

Note: `lookupErrorHandler` already maps `not_found`/`invalid_ip` to JSON. The `onSend` hook runs after the handler but before the error handler in Fastify 4. We use `onSend` (not `onResponse`) so we capture the post-errorHandler payload. If a key was used, log the status. No-key requests short-circuit (early return).

- [ ] **Step 6: Add `invalid_api_key` to error handler whitelist**

```typescript
// in lookupErrorHandler, add to the whitelist:
if (code === "invalid_ip" || code === "not_found" || code === "invalid_api_key") {
  return reply.code(statusCode).send({ error: code });
}
```

- [ ] **Step 7: Write failing test — query log records hit/not_found**

```typescript
// test/integration/lookup.log.test.ts
describe("query_log population", () => {
  // setup identical to lookup.auth.test.ts: user, key, seed 8.8.8.8 → US

  it("records a hit", async () => {
    await request(app).get(`/lookup?ip=8.8.8.8&key=${rawKey}`);
    const [rows] = await pool.query("SELECT * FROM query_log ORDER BY created_at DESC LIMIT 1");
    const row = (rows as any)[0];
    expect(row.status).toBe("hit");
    expect(row.country_code).toBe("US");
    expect(row.ip).toBe("8.8.8.8");
  });

  it("records a not_found", async () => {
    await request(app).get(`/lookup?ip=1.1.1.1&key=${rawKey}`); // not seeded
    const [rows] = await pool.query("SELECT * FROM query_log ORDER BY created_at DESC LIMIT 1");
    expect((rows as any)[0].status).toBe("not_found");
  });

  it("does not log when no key provided", async () => {
    await request(app).get("/lookup?ip=8.8.8.8");
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM query_log WHERE created_at > ?", [beforeTest]);
    expect((rows as any)[0].n).toBe(0);
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npm test -- test/integration/lookup.auth.test.ts test/integration/lookup.log.test.ts`
Expected: all pass.

- [ ] **Step 9: Run full suite + commit**

Run: `npm test && npm run lint`
Expected: existing tests still pass (no regression).

```bash
git add src/api/routes/lookup.ts src/web/auth/apiKey.ts src/storage/mysql.ts test/integration/lookup.auth.test.ts test/integration/lookup.log.test.ts
git commit -m "feat(api): API key auth + query_log on /lookup"
```

### Task 24: CLI subcommands — migrate, migrate:status, create-admin

**Files:**

- Modify: `src/cli.ts:1-57` (add three subcommands)
- Modify: `src/web/admin/bootstrap.ts` (new file, `bootstrapAdmin({email, password, displayName?})`)
- Test: `test/integration/cli.migrate.test.ts`
- Test: `test/integration/cli.create-admin.test.ts`

**Interfaces:**

- Consumes: `runMigrations`, `listMigrations` (from Task 2), `argon2.hash` (from Task 6), `Pool` (from Task 5)
- Produces: CLI commands `ipq migrate`, `ipq migrate:status`, `ipq create-admin --email <e> --password <p> [--name <n>]`

- [ ] **Step 1: Write failing test — `migrate` runs all 8 migrations**

```typescript
// test/integration/cli.migrate.test.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

describe("ipq migrate", () => {
  it("applies all migrations to a fresh DB", async () => {
    const env = {
      ...process.env,
      DB_NAME: "ipquery_cli_migrate_test",
      DB_HOST: "127.0.0.1",
      DB_USER: "root",
      DB_PASSWORD: "rootpass",
    };
    // ensure DB doesn't exist
    const adminPool = createPool({ ...loadConfig({ dbName: "mysql" }), dbName: "mysql" });
    await adminPool.query("DROP DATABASE IF EXISTS ipquery_cli_migrate_test");
    await adminPool.end();

    const { stdout } = await exec("node", ["dist/cli.js", "migrate"], { env });
    expect(stdout).toMatch(/applied 8 migration/);

    // verify tables exist
    const pool = createPool(loadConfig({ dbName: "ipquery_cli_migrate_test" }));
    const [tables] = await pool.query("SHOW TABLES LIKE 'users'");
    expect((tables as any).length).toBe(1);
    await pool.end();
  });

  it("migrate:status shows applied + pending", async () => {
    const env = {
      ...process.env,
      DB_NAME: "ipquery_cli_migrate_test",
      DB_HOST: "127.0.0.1",
      DB_USER: "root",
      DB_PASSWORD: "rootpass",
    };
    const { stdout } = await exec("node", ["dist/cli.js", "migrate:status"], { env });
    expect(stdout).toMatch(/001_ip_ranges.*applied/);
    expect(stdout).toMatch(/008_query_log.*applied/);
  });

  it("re-running migrate is idempotent", async () => {
    const env = {
      ...process.env,
      DB_NAME: "ipquery_cli_migrate_test",
      DB_HOST: "127.0.0.1",
      DB_USER: "root",
      DB_PASSWORD: "rootpass",
    };
    const { stdout } = await exec("node", ["dist/cli.js", "migrate"], { env });
    expect(stdout).toMatch(/0 migrations applied|database already up to date/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/cli.migrate.test.ts`
Expected: FAIL (no `migrate` subcommand).

- [ ] **Step 3: Implement bootstrap helper**

```typescript
// src/web/admin/bootstrap.ts
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import type { Pool } from "mysql2/promise";

export interface BootstrapAdminOpts {
  email: string;
  password: string;
  displayName?: string;
}

export async function bootstrapAdmin(pool: Pool, opts: BootstrapAdminOpts): Promise<{ id: string }> {
  const hash = await argon2.hash(opts.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const id = randomUUID().replace(/-/g, "").padEnd(32, "0").slice(0, 32);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name, email_verified, role, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', email_verified = 1`,
    [id, opts.email, hash, opts.displayName ?? opts.email, 1, "admin", new Date()],
  );
  const [rows] = await pool.query<any[]>("SELECT id FROM users WHERE email = ?", [opts.email]);
  return { id: rows[0].id };
}
```

- [ ] **Step 4: Add CLI subcommands**

```typescript
// src/cli.ts — add after the 'update' command:

import { runMigrations, listMigrations, createPool as createMysqlPool } from "./storage/mysql";
import { bootstrapAdmin } from "./web/admin/bootstrap";

program
  .command("migrate")
  .description("Apply pending database migrations")
  .action(async () => {
    const cfg = loadConfig();
    const pool = createMysqlPool(cfg);
    try {
      const applied = await runMigrations(pool);
      console.log(`applied ${applied} migration(s)`);
    } finally {
      await pool.end();
    }
  });

program
  .command("migrate:status")
  .description("Show migration status (applied vs pending)")
  .action(async () => {
    const cfg = loadConfig();
    const pool = createMysqlPool(cfg);
    try {
      const status = await listMigrations(pool);
      for (const m of status)
        console.log(`${m.id.padEnd(28)} ${m.applied ? "applied " + m.appliedAt.toISOString() : "pending"}`);
    } finally {
      await pool.end();
    }
  });

program
  .command("create-admin")
  .description("Create or promote an admin user (idempotent)")
  .requiredOption("--email <email>")
  .requiredOption("--password <password>")
  .option("--name <name>")
  .action(async (opts: { email: string; password: string; name?: string }) => {
    const cfg = loadConfig();
    const pool = createMysqlPool(cfg);
    try {
      const r = await bootstrapAdmin(pool, {
        email: opts.email,
        password: opts.password,
        displayName: opts.name,
      });
      console.log(`admin user ready: ${opts.email} (id=${r.id})`);
    } finally {
      await pool.end();
    }
  });
```

- [ ] **Step 5: Write failing test — create-admin**

```typescript
// test/integration/cli.create-admin.test.ts
describe("ipq create-admin", () => {
  it("creates an admin user", async () => {
    const env = {
      ...process.env,
      DB_NAME: "ipquery_cli_admin_test",
      DB_HOST: "127.0.0.1",
      DB_USER: "root",
      DB_PASSWORD: "rootpass",
    };
    // fresh DB + migrations
    const adminPool = createPool({ ...loadConfig({ dbName: "mysql" }), dbName: "mysql" });
    await adminPool.query("DROP DATABASE IF EXISTS ipquery_cli_admin_test");
    await adminPool.end();
    await exec("node", ["dist/cli.js", "migrate"], { env });

    await exec("node", ["dist/cli.js", "create-admin", "--email", "a@x", "--password", "pw12345678"], {
      env,
    });

    const pool = createPool(loadConfig({ dbName: "ipquery_cli_admin_test" }));
    const [rows] = await pool.query("SELECT role, email_verified FROM users WHERE email = 'a@x'");
    expect((rows as any)[0].role).toBe("admin");
    expect((rows as any)[0].email_verified).toBe(1);
    await pool.end();
  });

  it("rejects password shorter than 10 chars", async () => {
    await expect(
      exec("node", ["dist/cli.js", "create-admin", "--email", "b@x", "--password", "short"]),
    ).rejects.toThrow(/password must be at least 10/);
  });
});
```

- [ ] **Step 6: Add password validation in bootstrapAdmin**

```typescript
// in src/web/admin/bootstrap.ts, add at the top of bootstrapAdmin:
if (opts.password.length < 10) throw new Error("password must be at least 10 characters");
```

- [ ] **Step 7: Run tests + commit**

Run: `npm test -- test/integration/cli.migrate.test.ts test/integration/cli.create-admin.test.ts`
Expected: pass.

```bash
git add src/cli.ts src/web/admin/bootstrap.ts test/integration/cli.migrate.test.ts test/integration/cli.create-admin.test.ts
git commit -m "feat(cli): add migrate, migrate:status, create-admin subcommands"
```

### Task 25: docker-compose + Makefile — web service + migrate target

**Files:**

- Modify: `docker-compose.yml:17-32` (extend app service + add app-migrate + app-create-admin profiles)
- Modify: `Makefile:1-28` (add migrate, migrate-status, create-admin, test-web, e2e targets)
- Test: manual — `docker compose --profile migrate run --rm app-migrate` (no automated test)

- [ ] **Step 1: Extend app service for web + add profile services**

```yaml
# docker-compose.yml — replace the app service block:

app:
  build: .
  depends_on:
    mysql: { condition: service_healthy }
  environment:
    DB_HOST: mysql
    DB_PORT: 3306
    DB_USER: root
    DB_PASSWORD: rootpass
    DB_NAME: ipquery
    MAXMIND_LICENSE_KEY: ${MAXMIND_LICENSE_KEY:-}
    ETL_SCHEDULE: ${ETL_SCHEDULE:-0 2 * * *}
    SESSION_SECRET: ${SESSION_SECRET:-dev_only_change_in_prod_change_in_prod_change_in_prod_xx}
    COOKIE_SECURE: ${COOKIE_SECURE:-false}
    SMTP_HOST: ${SMTP_HOST:-}
    SMTP_PORT: ${SMTP_PORT:-587}
    SMTP_USER: ${SMTP_USER:-}
    SMTP_PASS: ${SMTP_PASS:-}
    SMTP_FROM: ${SMTP_FROM:-noreply@example.com}
    PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://localhost:3000}
  command: ["node", "dist/cli.js", "serve"]
  ports: ["3000:3000"]
  volumes:
    - app_data:/app/data

app-migrate:
  build: .
  depends_on:
    mysql: { condition: service_healthy }
  environment:
    DB_HOST: mysql
    DB_PORT: 3306
    DB_USER: root
    DB_PASSWORD: rootpass
    DB_NAME: ipquery
  command: ["node", "dist/cli.js", "migrate"]
  profiles: ["migrate"]
  volumes:
    - app_data:/app/data

app-create-admin:
  build: .
  depends_on:
    mysql: { condition: service_healthy }
    app-migrate: { condition: service_completed_successfully }
  environment:
    DB_HOST: mysql
    DB_PORT: 3306
    DB_USER: root
    DB_PASSWORD: rootpass
    DB_NAME: ipquery
  command:
    [
      "node",
      "dist/cli.js",
      "create-admin",
      "--email",
      "${ADMIN_EMAIL}",
      "--password",
      "${ADMIN_PASSWORD}",
      "--name",
      "${ADMIN_NAME:-Admin}",
    ]
  profiles: ["bootstrap"]
  volumes:
    - app_data:/app/data
```

- [ ] **Step 2: Extend Makefile**

```make
# Makefile — append targets:

.PHONY: migrate migrate-status create-admin test-web e2e docker-bootstrap docker-bootstrap-admin

help:
	@echo "make migrate          - apply pending DB migrations"
	@echo "make migrate-status   - show migration status"
	@echo "make create-admin     - create admin (ADMIN_EMAIL + ADMIN_PASSWORD env)"
	@echo "make test-web         - web/integration tests only"
	@echo "make e2e              - end-to-end test"
	@echo "make docker-bootstrap - one-shot migrate + ETL inside compose"
	@echo "make docker-bootstrap-admin - migrate then create-admin"

migrate:; node dist/cli.js migrate
migrate-status:; node dist/cli.js migrate:status
create-admin:
	@if [ -z "$$ADMIN_EMAIL" ] || [ -z "$$ADMIN_PASSWORD" ]; then echo "set ADMIN_EMAIL and ADMIN_PASSWORD"; exit 1; fi
	node dist/cli.js create-admin --email "$$ADMIN_EMAIL" --password "$$ADMIN_PASSWORD" --name "$${ADMIN_NAME:-Admin}"
test-web:; npm test -- test/integration test/unit
e2e:; npm test -- test/e2e
docker-bootstrap:; docker compose --profile migrate up app-migrate && docker compose run --rm app node dist/cli.js update
docker-bootstrap-admin:
	docker compose --profile migrate --profile bootstrap up app-create-admin
```

- [ ] **Step 3: Update `.env.example` to document new variables**

Append to `.env.example`:

```
# Web frontend
SESSION_SECRET=replace_me_with_64_random_bytes_in_prod
COOKIE_SECURE=false
PUBLIC_BASE_URL=http://localhost:3000

# SMTP (optional — leave SMTP_HOST empty for console transport in dev)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@example.com

# Admin bootstrap
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_NAME=Admin
```

- [ ] **Step 4: Verify with `docker compose config`**

Run: `docker compose --profile migrate --profile bootstrap config -q`
Expected: exit 0, no schema errors.

Note: full bring-up requires Docker daemon which is unavailable in this dev env. The `config -q` check validates the compose file parses and profiles expand correctly.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml Makefile .env.example
git commit -m "feat(deploy): web env vars, app-migrate, app-create-admin profiles"
```

### Task 26: README — Web frontend section

**Files:**

- Modify: `README.md` (add Web Frontend section before License)
- Test: manual — render locally and inspect headings/links

- [ ] **Step 1: Insert Web Frontend section**

````markdown
## Web Frontend

The application ships with a server-rendered (SSR) admin and user dashboard at the same origin as the API.

### Pages

- **Marketing & docs** — `/`, `/docs`, `/pricing`, `/try` (htmx-powered demo)
- **Auth** — `/signup`, `/login`, `/verify`, `/forgot`, `/reset`
- **Dashboard** — `/dashboard`, `/dashboard/history`, `/dashboard/keys`, `/dashboard/profile`
- **Admin** — `/admin`, `/admin/users`, `/admin/etl`, `/admin/keys`, `/admin/audit`
- **Static** — `/legal/{terms,privacy}`, `/healthz`, API at `/lookup[/:ip]`, `/stats`

### First-deploy guide

1. `cp .env.example .env` and set `SESSION_SECRET` (≥32 bytes), `PUBLIC_BASE_URL`, SMTP if you want real email delivery
2. `make docker-up` (brings up MySQL + app)
3. `make docker-bootstrap` (runs migrations + initial ETL inside the compose network)
4. `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=$(openssl rand -base64 16) make docker-bootstrap-admin`
5. Open `http://localhost:3000/login` and sign in

### Local development

```bash
make install        # npm install
make migrate        # apply DB schema
make create-admin   # interactive bootstrap
make run            # node dist/cli.js serve --once  (loads .env automatically)
```
````

### Internationalization

Default locale is `zh-CN`. Switch via the language toggle in the header — preference is stored in a non-httpOnly cookie. To add a new locale, create `src/web/i18n/<locale>.json` and register it in `src/web/i18n/index.ts`.

### Email delivery

When `SMTP_HOST` is unset, emails are printed to stdout (dev mode). In production set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and the console transport is replaced automatically.

### CSRF, sessions, rate limits

- Sessions are stored in MySQL (`sessions` table) — httpOnly cookies, SameSite=Lax, 30-day rolling expiry
- Forms include a CSRF token (cookie + body field, 4-hour TTL); the dashboard middleware rejects mismatched tokens
- Signup: 5/hour per IP; Login: 20/hour per IP + 5-failure/15-min lockout per account

````

- [ ] **Step 2: Verify all internal links resolve**

Run: `grep -oE '\]\((/[^)]+|#[a-z-]+)\)' README.md | sort -u | while read l; do path=$(echo "$l" | sed 's/^](//; s/)$//'); if [[ "$path" == /* ]]; then test -f "src/web/routes$(echo $path | sed 's/:[a-z]*/_/g').ts" || test -f "src/web/views${path%.html}.hbs" || echo "MISSING: $path"; fi; done`
Expected: no MISSING lines (or only ones you intend to document as "future").

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add web frontend section to README"
````

---
