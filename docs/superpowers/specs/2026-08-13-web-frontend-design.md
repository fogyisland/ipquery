# IPQuery Web 前端 — 设计文档

**日期**：2026-08-13
**状态**：待用户审阅
**作者**：Brainstorming 会话
**基础**：[`2026-08-13-ip-aggregator-design.md`](2026-08-13-ip-aggregator-design.md)

---

## 1. 目标与摘要

在已有的 IPQuery API 之上,补充三个用户层级的 Web 界面:

1. **商业访问网站(公开)** — 营销首页、文档、定价(文案)、在线试查、状态页
2. **登录用户面板** — 个人查询历史、API key 管理、个人资料
3. **管理员后台** — 用户管理、ETL 运维、API key 全局审计、全局查询审计

新增完整的注册 / 登录 / 邮箱验证 / 找回密码流程。SSR 渲染(Handlebars 模板),双语 i18n(中文优先),MySQL session cookie,无前端构建链、无 SPA。

---

## 2. 范围与非目标

### 2.1 范围内

- 三个层级的页面与路由(SSR + htmx 渐进增强)
- 邮箱 + 密码注册、登录、登出
- 邮箱验证(签名 token 链接)
- 找回密码(签名 token 链接)
- 登录态限流、暴力破解锁定
- CSRF 保护(per-session token + 表单隐藏域)
- MySQL 持久化的 session 表
- 个人查询历史(分页、状态筛选、来源筛选)
- 用户 API key 创建 / 列表 / 吊销(key 明文仅显示一次)
- 管理员:用户管理(列表、启用/禁用、手动验证邮箱、重置密码)、ETL 触发与状态、API key 全局审计、全局查询审计(筛选 + CSV 导出)
- 双语 i18n(zh-CN 默认,en-US 占位)
- 数据库迁移机制(取代硬编码 schema.sql)
- CLI 新增 `migrate` 与 `create-admin` 子命令

### 2.2 非目标(本次不做)

- 第三方登录(微信 / GitHub / Google)
- 双因素认证(2FA / TOTP)
- 付费层接入(支付、订阅、配额)
- 实时通知(WebSocket / SSE)
- 多租户隔离(所有用户共享一份 IP 数据)
- 用户自助注销(后台删除即可)
- 找回用户名(只找回密码)
- 邮箱改绑(管理员后台改)
- 国际化日期 / 数字格式(只用 ISO 8601 + 数字原样)
- 富文本编辑器(全部纯文本 / Markdown 视图)

---

## 3. 需求摘要

| 维度 | 决策 |
|---|---|
| 页面渲染 | SSR(Fastify + Handlebars) |
| 渐进增强 | htmx(无 SPA) |
| 前端语言 | TypeScript + Handlebars 模板 + 原生 CSS |
| 认证 | 邮箱 + 密码 + MySQL session cookie |
| 密码哈希 | argon2id(`argon2` npm 包) |
| Token 哈希 | SHA-256(`crypto` 内置) |
| Cookie | `httpOnly`,`SameSite=Lax`,生产 `Secure` |
| CSRF | per-session token + 隐藏域 + Origin/Referer 校验 |
| 限流 | 登录 5 次/15 分钟锁;注册 5 次/IP/小时 |
| 邮件 | nodemailer,开发 console transport,生产 SMTP |
| 数据库 | MySQL 5.7 / 8.0 兼容 |
| 迁移 | 自研轻量迁移器(顺序执行 `migrations/*.sql`) |
| 国际化 | 自研 i18n,zh-CN 优先 + en-US 占位 |
| 安全头部 | CSP, X-Content-Type-Options, X-Frame-Options, HSTS(prod) |

---

## 4. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│   ├─ Public(匿名)                                           │
│   └─ Authenticated(session cookie)                          │
└────────────────────────────────────────────────────────────┘
                          │ HTTPS (prod) / HTTP (dev)
                          ▼
┌────────────────────────────────────────────────────────────┐
│  Fastify                                                    │
│  ├─ cors / compress / rate-limit                            │
│  ├─ @fastify/cookie    (session cookie)                     │
│  ├─ @fastify/formbody  (POST 表单)                          │
│  ├─ @fastify/static    (/assets)                            │
│  └─ @fastify/view      (Handlebars 模板)                    │
│                                                              │
│  onRequest hooks:                                            │
│    ├─ loadSession     → 解析 cookie → 挂 req.user           │
│    ├─ requireAuth     → /dashboard/* 门禁                   │
│    └─ requireAdmin    → /admin/* 门禁                       │
│                                                              │
│  onResponse hook:                                            │
│    └─ queryLog        → 异步写 query_log(去抖批量)          │
│                                                              │
│  Routes:                                                     │
│    ├─ GET  /            marketingRoute                       │
│    ├─ GET  /try         marketingRoute                       │
│    ├─ POST /signup      authRoute                            │
│    ├─ GET  /verify      authRoute                            │
│    ├─ POST /login       authRoute                            │
│    ├─ POST /logout      authRoute                            │
│    ├─ GET/POST /forgot  authRoute                            │
│    ├─ GET/POST /reset   authRoute                            │
│    ├─ GET  /dashboard           dashboardRoute (auth)        │
│    ├─ GET  /dashboard/history   dashboardRoute (auth)        │
│    ├─ GET  /dashboard/keys      dashboardRoute (auth)        │
│    ├─ POST /dashboard/keys      dashboardRoute (auth)        │
│    ├─ POST /dashboard/keys/:id/revoke dashboardRoute (auth)  │
│    ├─ GET  /dashboard/profile   dashboardRoute (auth)        │
│    ├─ POST /dashboard/profile   dashboardRoute (auth)        │
│    ├─ GET  /admin/users        adminRoute (admin)            │
│    ├─ POST /admin/users/:id/*  adminRoute (admin)            │
│    ├─ POST /admin/etl/trigger  adminRoute (admin)            │
│    ├─ GET  /admin/etl/runs     adminRoute (admin)            │
│    ├─ GET  /admin/keys         adminRoute (admin)            │
│    ├─ GET  /admin/audit        adminRoute (admin)            │
│    ├─ GET  /admin/audit.csv    adminRoute (admin)            │
│    ├─ GET  /lookup[?ip=...]   lookupRoute(现有,加 queryLog) │
│    ├─ GET  /healthz          healthRoute(现有)               │
│    └─ GET  /stats            statsRoute(现有)                │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│  MySQL                                                      │
│  ├─ ip_ranges          (现有)                               │
│  ├─ etl_runs           (现有)                               │
│  ├─ users              (新增)                               │
│  ├─ api_keys           (新增)                               │
│  ├─ sessions           (新增)                               │
│  ├─ email_verifications(新增)                               │
│  ├─ password_resets    (新增)                               │
│  ├─ query_log          (新增)                               │
│  └─ schema_migrations  (新增,迁移器记录)                    │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│  nodemailer                                                 │
│   ├─ dev:  console transport(打印链接到 stdout)             │
│   └─ prod: SMTP                                              │
└────────────────────────────────────────────────────────────┘
```

### 仓库结构(新增部分)

```
ipquery/
├── src/
│   ├── web/                                  # 新增
│   │   ├── index.ts                          # registerWebRoutes(app)
│   │   ├── plugins/
│   │   │   ├── view.ts                       # @fastify/view 配置
│   │   │   ├── i18n.ts                       # 注入 t() 到 reply
│   │   │   ├── session.ts                    # loadSession + destroySession
│   │   │   ├── auth.ts                       # requireAuth + requireAdmin
│   │   │   ├── form.ts                       # CSRF token 注入 + 校验
│   │   │   └── queryLog.ts                   # 异步批量写 query_log
│   │   ├── auth/
│   │   │   ├── password.ts                   # argon2id 封装
│   │   │   ├── tokens.ts                     # generateToken / hashToken
│   │   │   ├── session.ts                    # createSession / loadSession
│   │   │   └── csrf.ts                       # generateCsrf / verifyCsrf
│   │   ├── routes/
│   │   │   ├── marketing.ts                  # / /try /docs /pricing /status /about
│   │   │   ├── auth.ts                       # /signup /login /logout /verify /forgot /reset
│   │   │   ├── dashboard.ts                  # /dashboard /history /keys /profile
│   │   │   └── admin.ts                      # /admin/users /etl /keys /audit
│   │   ├── i18n/
│   │   │   ├── index.ts                      # t(locale, key, vars)
│   │   │   ├── zh-CN.json
│   │   │   └── en-US.json
│   │   ├── views/                            # Handlebars 模板
│   │   │   ├── layouts/
│   │   │   │   ├── public.hbs                # 公开页布局
│   │   │   │   ├── auth.hbs                  # 登录/注册/重置布局
│   │   │   │   ├── dashboard.hbs             # 用户面板布局
│   │   │   │   └── admin.hbs                 # 管理员布局
│   │   │   ├── partials/
│   │   │   │   ├── nav.hbs
│   │   │   │   ├── footer.hbs
│   │   │   │   ├── flash.hbs                 # 一次性提示
│   │   │   │   ├── pagination.hbs
│   │   │   │   └── form-field.hbs            # label + input + error
│   │   │   ├── marketing/
│   │   │   │   ├── home.hbs
│   │   │   │   ├── about.hbs
│   │   │   │   ├── docs.hbs
│   │   │   │   ├── pricing.hbs
│   │   │   │   ├── status.hbs
│   │   │   │   └── try.hbs                   # 在线试查 + htmx
│   │   │   ├── auth/
│   │   │   │   ├── signup.hbs
│   │   │   │   ├── login.hbs
│   │   │   │   ├── verify-result.hbs
│   │   │   │   ├── forgot.hbs
│   │   │   │   └── reset.hbs
│   │   │   ├── dashboard/
│   │   │   │   ├── index.hbs
│   │   │   │   ├── history.hbs
│   │   │   │   ├── keys.hbs
│   │   │   │   └── profile.hbs
│   │   │   └── admin/
│   │   │       ├── users.hbs
│   │   │       ├── user-detail.hbs
│   │   │       ├── etl-runs.hbs
│   │   │       ├── etl-run-detail.hbs
│   │   │       ├── keys.hbs
│   │   │       └── audit.hbs
│   │   ├── emails/
│   │   │   ├── verify-email.hbs
│   │   │   └── reset-password.hbs
│   │   └── assets/
│   │       ├── css/
│   │       │   ├── base.css
│   │       │   ├── layout.css
│   │       │   └── forms.css
│   │       ├── js/
│   │       │   └── htmx.min.js               # vendored
│   │       └── img/                           # logo, favicon
│   ├── storage/
│   │   ├── migrations/                       # 新增,取代硬编码 schema
│   │   │   ├── 001_ip_ranges.sql             # 从现有 schema.sql 拆出
│   │   │   ├── 002_etl_runs.sql
│   │   │   ├── 003_users.sql
│   │   │   ├── 004_api_keys.sql
│   │   │   ├── 005_sessions.sql
│   │   │   ├── 006_email_verifications.sql
│   │   │   ├── 007_password_resets.sql
│   │   │   ├── 008_query_log.sql
│   │   │   └── runner.ts                     # applyMigrations(pool)
│   │   ├── users.ts                          # 新增:CRUD + 业务函数
│   │   ├── apiKeys.ts                        # 新增:CRUD + 校验
│   │   ├── sessions.ts                       # 新增
│   │   ├── tokens.ts                         # 新增(verification / reset)
│   │   ├── queryLog.ts                       # 新增:批量 insert
│   │   └── mysql.ts                          # 现有,加 runMigrations / getMigrationVersion
│   ├── mailer.ts                             # 新增:nodemailer transport 工厂
│   ├── config.ts                             # 扩展:web / smtp / security 子对象
│   ├── types.ts                              # 扩展:User / ApiKey / Session / QueryLog
│   └── cli.ts                                # 新增 migrate / create-admin
├── test/
│   ├── unit/                                 # +i18n / password / tokens / csrf
│   ├── integration/                          # +auth.* / dashboard.* / admin.*
│   └── e2e/
│       └── web-journey.test.ts               # 新增
└── docker-compose.yml                        # 扩展:app-migrate profile
```

---

## 5. 数据模型

### 5.1 迁移机制

`migrations/runner.ts`:

```ts
// schema_migrations 表:
CREATE TABLE schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

执行流程:
1. 读 `schema_migrations` 已应用版本集合
2. 读 `migrations/*.sql` 文件名(字典序)
3. 跳过已应用的,依次在单事务内执行未应用的
4. 成功后写入 `schema_migrations`
5. 失败 → 抛错,事务回滚,启动中止

向后兼容:旧部署首次启动时,若 `ip_ranges` 表已存在则视为 `001`、`002` 已应用(从 `INFORMATION_SCHEMA.TABLES` 探测)。

### 5.2 `users`

```sql
CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,         -- argon2id
  display_name VARCHAR(64) NOT NULL,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  is_disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

索引:`email` 唯一键已自带;`(role, created_at)` 用于后台分页。

### 5.3 `api_keys`

```sql
CREATE TABLE api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(64) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,           -- SHA-256(明文)
  key_prefix CHAR(8) NOT NULL,                 -- 明文前 8 字符(展示用)
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id),
  INDEX idx_active (user_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

明文格式:`ipq_<32 字符 base32>`(40 字符总长)。`key_prefix = 明文前 8 字符 = "ipq_xxxx"`。存储时**只保存 hash 与 prefix**,明文仅创建时一次性返回给用户。

### 5.4 `sessions`

```sql
CREATE TABLE sessions (
  id CHAR(32) NOT NULL PRIMARY KEY,            -- 16 字节随机 base32
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

默认 `expires_at = now + SESSION_TTL_HOURS`。后台 cron 每小时清理过期(由 ETL 后的 hook 顺带执行,无需独立调度)。

### 5.5 `email_verifications`

```sql
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

Token = 32 字节随机 base32;过期 24 小时;消费后置 `consumed_at` 不删除(防重放)。

### 5.6 `password_resets`

```sql
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

Token = 32 字节随机 base32;过期 2 小时;消费后失效。

### 5.7 `query_log`

```sql
CREATE TABLE query_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip VARBINARY(16) NOT NULL,                  -- 与 ip_ranges 同样编码
  ip_text VARCHAR(45) NOT NULL,                -- 原始输入(便于审计)
  status ENUM('hit','miss','invalid') NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  api_key_id BIGINT UNSIGNED NULL,
  session_id CHAR(32) NULL,
  remote_addr VARBINARY(16) NULL,              -- 实际 TCP 来源
  user_agent VARCHAR(255) NULL,
  INDEX idx_user_ts (user_id, ts),
  INDEX idx_ts (ts),
  INDEX idx_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

批量写入:`queryLog` 插件每 5s flush 一次或满 100 条立即 flush,避免单条 INSERT 阻塞请求。

### 5.8 TypeScript 类型

```ts
export type Role = 'user' | 'admin';
export type QueryStatus = 'hit' | 'miss' | 'invalid';

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

---

## 6. 认证 & 会话流程

### 6.1 注册

```
浏览器                          Fastify                         MySQL                Mailer
  │                                │                              │                    │
  │ GET /signup                    │                              │                    │
  │ ──────────────────────────────>│                              │                    │
  │ 200 signup.hbs (含 csrf)       │                              │                    │
  │ <────────────────────────────────│                              │                    │
  │                                │                              │                    │
  │ POST /signup                   │                              │                    │
  │  {email, password, csrf}       │                              │                    │
  │ ──────────────────────────────>│                              │                    │
  │                                │ 校验 → INSERT users          │                    │
  │                                │  (email_verified=0)          │                    │
  │                                │ ───────────────────────────> │                    │
  │                                │ INSERT email_verifications   │                    │
  │                                │ ───────────────────────────> │                    │
  │                                │ generate verifyToken         │                    │
  │                                │ sendMail(verify-email.hbs)   │                    │
  │                                │ ──────────────────────────────────────────────>  │
  │ 200 signup-success.hbs          │                              │                    │
  │   "请在邮箱中点击验证链接"       │                              │                    │
  │ <────────────────────────────────│                              │                    │
```

**校验规则**:
- 邮箱:`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`,转小写
- 密码:≥ 10 字符,包含字母 + 数字
- 重复邮箱:`email` 唯一键冲突 → 409 → 提示"该邮箱已注册,是否登录 / 找回密码"
- 注册频率:同 IP 5 次/小时,超出 429

**首次注册即升 admin**:若 `ADMIN_BOOTSTRAP_EMAIL` 非空且与提交邮箱相等,且 `users` 表当前为空 → `role='admin'`。

### 6.2 邮箱验证

```
浏览器                          Fastify                         MySQL
  │                                │                              │
  │ GET /verify?token=...          │                              │
  │ ──────────────────────────────>│                              │
  │                                │ hashToken(token)             │
  │                                │ SELECT email_verifications   │
  │                                │ ───────────────────────────> │
  │                                │ 检查:                        │
  │                                │  - 未消费                    │
  │                                │  - 未过期                    │
  │                                │ 全部通过 →                   │
  │                                │ UPDATE users SET email_verified=1
  │                                │ ───────────────────────────> │
  │                                │ UPDATE email_verifications SET consumed_at=NOW()
  │                                │ ───────────────────────────> │
  │ 302 → /login?verified=1        │                              │
  │ <────────────────────────────────│                              │
```

**失败映射**:
| 场景 | HTTP | 视图 |
|---|---|---|
| Token 不存在 | 401 | `verify-result.hbs` "链接无效" |
| Token 已消费 | 410 | `verify-result.hbs` "链接已使用,请重新登录" |
| Token 过期 | 410 | `verify-result.hbs` "链接已过期,请重新发送" |
| 成功 | 302 → `/login?verified=1` | flash "邮箱已验证,请登录" |

**重新发送**:登录页"未验证"提示 + 按钮 → POST `/verify/resend` → 60s 冷却 + 邮件。

### 6.3 登录

```
浏览器                          Fastify                         MySQL
  │                                │                              │
  │ POST /login                    │                              │
  │  {email, password, csrf}       │                              │
  │ ──────────────────────────────>│                              │
  │                                │ SELECT users WHERE email=?   │
  │                                │ ───────────────────────────> │
  │                                │ verifyPassword(hash, pw)     │
  │                                │ 检查:email_verified / is_disabled
  │                                │                              │
  │                                │ INSERT sessions              │
  │                                │ ───────────────────────────> │
  │                                │ Set-Cookie: sid=<id>;        │
  │                                │   HttpOnly; SameSite=Lax;    │
  │                                │   Max-Age=TTL;               │
  │                                │   Secure(prod)               │
  │                                │ UPDATE users SET last_login_at=NOW()
  │ 302 → /dashboard               │                              │
  │ <────────────────────────────────│                              │
```

**失败映射**:
| 场景 | HTTP | 处理 |
|---|---|---|
| 邮箱不存在 | 401 | 通用提示"邮箱或密码错误"(防枚举) |
| 密码错误 | 401 | 同上 + 计数失败 + 锁定判断 |
| 未验证邮箱 | 302 → `/login?verify_required=1` | flash "请先验证邮箱";登录页显示"重发验证邮件"按钮 → POST `/verify/resend` |
| 账号被禁用 | 302 → `/login?disabled=1` | flash "账号已禁用,请联系管理员" |

**限流**:同邮箱 5 次失败/15 分钟 → 锁定,期间返回 `LOGIN_LOCKOUT_MINUTES` 提示,实际继续尝试也计失败。锁定状态存在内存 `Map<email, lockUntil>`,进程重启清空(可接受;生产建议后续落 Redis)。

### 6.4 找回密码

```
/forgot(GET) → 表单
/forgot(POST) → 不论邮箱是否存在,均:
   - 存在 → INSERT password_resets, sendMail(reset-password.hbs)
   - 不存在 → no-op
   返回 200 "如果邮箱已注册,你将收到重置链接"

/reset?token=...(GET) → 校验 token,渲染密码输入表单
/reset(POST) {token, password} → 校验 + 重置 + 标记 consumed + 吊销所有 session
```

**安全**:
- 邮件**总是显示"如果邮箱已注册"**,无论是否存在
- Token 2 小时过期,一次性消费
- 重置成功后**吊销该用户所有 session**,强制重新登录

### 6.5 登出

```
POST /logout → 校验 csrf → DELETE sessions WHERE id=? → 清 cookie → 302 → /
```

### 6.6 Session 加载与门禁

```ts
// loadSession hook
app.addHook('onRequest', async (req) => {
  const sid = req.cookies.sid;
  if (!sid) return;
  const session = await loadSession(app.pool, sid);
  if (!session) return;
  req.session = session;
  req.user = await loadUser(app.pool, session.userId);
});

// requireAuth hook(只挂在 /dashboard/*)
app.addHook('onRequest', async (req, reply) => {
  if (req.routeOptions.url?.startsWith('/dashboard')) {
    if (!req.user) return reply.code(302).redirect('/login?next=' + encodeURIComponent(req.url));
  }
});

// requireAdmin hook(只挂在 /admin/*)
app.addHook('onRequest', async (req, reply) => {
  if (req.routeOptions.url?.startsWith('/admin')) {
    if (!req.user || req.user.role !== 'admin') return reply.code(403).view('errors/403.hbs');
    if (req.user.isDisabled) return reply.code(403).redirect('/login?disabled=1');
  }
});
```

### 6.7 API Key 认证(独立路径,不与 session 共用)

```
GET /lookup?ip=...&key=ipq_xxxxx
  1. 提取 key 参数(或 Authorization: Bearer)
  2. SHA-256(key) → SELECT api_keys WHERE key_hash=? AND revoked_at IS NULL
  3. 命中 → req.apiKey = row, req.user = loadUser(row.user_id)
  4. UPDATE api_keys SET last_used_at=NOW()
  5. 继续现有 /lookup 逻辑
  6. query_log 多记录 api_key_id
```

**配额**:本次不做,留接口(`api_keys.rate_limit_per_minute` 字段预留)。

### 6.8 CSRF

```ts
// form plugin:生成与校验
app.addHook('onRequest', async (req, reply) => {
  if (!req.session) return;
  if (!req.session.csrf) req.session.csrf = generateCsrf();
  reply.setCookie('csrf', req.session.csrf, { httpOnly: false, sameSite: 'Lax' });
});

// 校验中间件:仅对 POST/PUT/PATCH/DELETE,且 Content-Type=form
async function verifyCsrf(req, reply) {
  const cookie = req.cookies.csrf;
  const body = req.body?.csrf;
  if (!cookie || !body || cookie !== body) {
    return reply.code(403).view('errors/csrf.hbs');
  }
}
```

匿名用户(无 session)的 POST 表单仍需防护:用 Origin/Referer 头校验同源。

### 6.9 速率限制(扩展现有 `@fastify/rate-limit`)

| 路径 | 限制 | Key |
|---|---|---|
| `POST /signup` | 5 / hour | remote IP |
| `POST /login` | 20 / hour | remote IP + email |
| `POST /verify/resend` | 1 / minute | user_id |
| `POST /forgot` | 5 / hour | remote IP |
| `GET /try` (htmx 查询) | 30 / minute | remote IP |
| `GET /lookup` (匿名) | 60 / minute | remote IP(已有) |
| `GET /lookup` (认证) | 600 / minute | user_id |
| `POST /dashboard/keys` | 10 / hour | user_id |

---

## 7. 路由清单

### 7.1 公开(匿名)

| Method | Path | 视图 | 说明 |
|---|---|---|---|
| GET | `/` | `marketing/home.hbs` | 首页:产品介绍 + CTA |
| GET | `/about` | `marketing/about.hbs` | 关于 |
| GET | `/docs` | `marketing/docs.hbs` | API 文档 |
| GET | `/pricing` | `marketing/pricing.hbs` | 定价文案(无支付) |
| GET | `/status` | `marketing/status.hbs` | 服务状态(读 etl_runs) |
| GET | `/try` | `marketing/try.hbs` | 在线试查 + htmx |
| POST | `/try` (htmx) | 片段 | 试查响应片段 |

### 7.2 认证流程

| Method | Path | 视图 | 说明 |
|---|---|---|---|
| GET | `/signup` | `auth/signup.hbs` | 注册表单 |
| POST | `/signup` | 重定向 | 注册逻辑 |
| GET | `/login` | `auth/login.hbs` | 登录表单 |
| POST | `/login` | 重定向 | 登录逻辑 |
| POST | `/logout` | 重定向 `/` | 登出 |
| GET | `/verify` | `auth/verify-result.hbs` | 处理 token |
| POST | `/verify/resend` | 重定向 | 重发验证邮件 |
| GET | `/forgot` | `auth/forgot.hbs` | 找回密码表单 |
| POST | `/forgot` | 重定向 | 找回密码请求 |
| GET | `/reset` | `auth/reset.hbs` | 重置密码表单(带 token) |
| POST | `/reset` | 重定向 | 重置密码提交 |

### 7.3 用户面板(`/dashboard/*`,需登录)

| Method | Path | 视图 | 说明 |
|---|---|---|---|
| GET | `/dashboard` | `dashboard/index.hbs` | 概览(近 7 天查询统计) |
| GET | `/dashboard/history` | `dashboard/history.hbs` | 查询历史(分页 + 筛选) |
| GET | `/dashboard/keys` | `dashboard/keys.hbs` | API key 列表 |
| POST | `/dashboard/keys` | 重定向 + flash | 创建新 key,flash 一次显示明文 |
| POST | `/dashboard/keys/:id/revoke` | 重定向 | 吊销 key |
| GET | `/dashboard/profile` | `dashboard/profile.hbs` | 个人资料 |
| POST | `/dashboard/profile` | 重定向 | 修改 display_name / 密码 / 邮箱(后者重新验证) |

### 7.4 管理员后台(`/admin/*`,需 admin)

| Method | Path | 视图 | 说明 |
|---|---|---|---|
| GET | `/admin` | 重定向 `/admin/users` | 入口 |
| GET | `/admin/users` | `admin/users.hbs` | 用户列表(分页 + 搜索 + 筛选) |
| GET | `/admin/users/:id` | `admin/user-detail.hbs` | 用户详情 |
| POST | `/admin/users/:id/enable` | 重定向 | 启用 |
| POST | `/admin/users/:id/disable` | 重定向 | 禁用 |
| POST | `/admin/users/:id/verify-email` | 重定向 | 手动标记邮箱已验证 |
| POST | `/admin/users/:id/reset-password` | 重定向 | 强制重置密码(生成新临时密码) |
| POST | `/admin/users/:id/delete` | 重定向 | 删除用户(级联) |
| GET | `/admin/etl` | 重定向 `/admin/etl/runs` | ETL 入口 |
| GET | `/admin/etl/runs` | `admin/etl-runs.hbs` | ETL 历史 |
| GET | `/admin/etl/runs/:id` | `admin/etl-run-detail.hbs` | 单次 run 详情 |
| POST | `/admin/etl/trigger` | 重定向 | 手动触发 ETL(异步) |
| GET | `/admin/keys` | `admin/keys.hbs` | 全局 API key 列表 |
| GET | `/admin/audit` | `admin/audit.hbs` | 全局查询审计(分页 + 多维筛选) |
| GET | `/admin/audit.csv` | 流式 CSV | 审计导出 |

### 7.5 现有 API(扩展)

| Method | Path | 变更 |
|---|---|---|
| GET | `/lookup` | 加 queryLog hook |
| GET | `/lookup/:ip` | 加 queryLog hook + 支持 `?key=` |
| GET | `/healthz` | 不变 |
| GET | `/stats` | 不变 |

### 7.6 中间件挂载顺序

```ts
await app.register(cors);
await app.register(compress);
await app.register(rateLimit, { ... });
await app.register(cookie, { secret: cfg.web.cookieSecret });
await app.register(formbody);
await app.register(static, { root: 'src/web/assets' });
await app.register(view, { engine: { handlebars }, layout: 'layouts/public.hbs', ... });

app.addHook('onRequest', loadSession);
app.addHook('onRequest', requireAuth);    // 仅 /dashboard/*
app.addHook('onRequest', requireAdmin);   // 仅 /admin/*
app.addHook('onResponse', queryLog);      // /lookup* 异步写日志

app.register(marketingRoutes);
app.register(authRoutes);
app.register(dashboardRoutes);
app.register(adminRoutes);
app.register(healthRoute);
app.register(lookupRoute);                // 现有
app.register(statsRoute);                 // 现有
```

---

## 8. 前端结构

### 8.1 布局(4 个)

| 文件 | 用途 | 关键 slot |
|---|---|---|
| `layouts/public.hbs` | 公开页(首页/文档/定价/状态/关于) | header / footer |
| `layouts/auth.hbs` | 注册 / 登录 / 重置(简洁居中卡片) | 仅 flash |
| `layouts/dashboard.hbs` | 用户面板 | sidebar(我的 / 历史 / keys / 资料) + main |
| `layouts/admin.hbs` | 管理员后台 | sidebar(用户 / ETL / keys / 审计) + main |

每个布局都有:
- `<head>` 注入 CSP / X-Content-Type-Options / X-Frame-Options
- 引入 `assets/css/base.css`
- 注入当前语言 `<html lang="...">`
- 注入 flash 提示 `{{> flash}}`

### 8.2 局部组件(5 个)

| 文件 | 用途 |
|---|---|
| `partials/nav.hbs` | 顶部导航(根据 `req.user` 切换显示登录/用户名下拉) |
| `partials/footer.hbs` | 版权 + 链接 + 语言切换(zh-CN / en-US) |
| `partials/flash.hbs` | flash 提示(成功/警告/错误,自动消失) |
| `partials/pagination.hbs` | 分页器(上一页 / 页码 / 下一页) |
| `partials/form-field.hbs` | label + input + error 消息(支持 text/password/email/csrf 等) |

### 8.3 i18n

`src/web/i18n/index.ts`:

```ts
import zhCN from './zh-CN.json';

export type Locale = 'zh-CN' | 'en-US';
const dictionaries: Record<Locale, Record<string, string>> = { 'zh-CN': zhCN, 'en-US': {} };

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[locale] ?? dictionaries['zh-CN'];
  let s = dict[key] ?? dictionaries['zh-CN'][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
```

`zh-CN.json` 包含全部 key(开发期必填);`en-US.json` 空对象,所有英文显示回退到 key 名(占位)。本期不强制完整英文化。

**视图助手**(Handlebars helper):

```ts
app.view('t', (key, opts) => t(req.cookies.lang ?? 'zh-CN', key, opts.hash));
app.view('eq', (a, b) => a === b);
app.view('formatDate', (d: Date) => d?.toISOString().replace('T', ' ').slice(0, 19) ?? '');
app.view('formatRelative', (d: Date) => relativeTime(d, new Date()));
app.view('json', (v) => JSON.stringify(v));
```

### 8.4 htmx 用法

仅两处使用:

1. **`/try` 试查**:输入 IP → `hx-post="/try" hx-target="#result"` → 返回单条结果片段(无需整页刷新)
2. **`/dashboard/keys` 创建**:提交后 `hx-post` 返回新 key 明文片段,自动 `hx-on::after-request` 复制到剪贴板

`<script src="/assets/js/htmx.min.js" defer>` 引入,禁止内联脚本(CSP `script-src 'self'`)。

### 8.5 样式

- 纯 CSS,无 Tailwind / 无 PostCSS / 无构建
- `base.css`:reset + 颜色变量 + 暗色模式(`@media (prefers-color-scheme: dark)`)
- `layout.css`:grid + flex 布局
- `forms.css`:表单控件统一样式
- 字体:系统字体栈(`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`),中文额外 `PingFang SC, Microsoft YaHei`

### 8.6 安全头部

```ts
app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",     // Handlebars style attr
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (cfg.web.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});
```

---

## 9. 测试策略

### 9.1 单元测试(`test/unit/`)

| 文件 | 覆盖 |
|---|---|
| `web-i18n.test.ts` | `t()` 字典查找、回退链、变量插值 `{name}`、缺键返回 key |
| `web-password.test.ts` | `hashPassword` / `verifyPassword` round-trip;wrong pw → false;argon2 参数 |
| `web-tokens.test.ts` | `generateToken` 长度/字符集;`hashToken` SHA-256 确定性;不可逆 |
| `web-session.test.ts` | `createSession` 写库 + cookie 格式;`loadSession` 过期剔除;`destroySession` |
| `web-csrf.test.ts` | token 生成/校验;无 token → 拒绝;跨 session → 拒绝 |
| `web-dictionaries.test.ts` | `zh-CN.json` 结构合法(无空值、无 undefined) |

### 9.2 集成测试(`test/integration/`)

每个文件用独立数据库 `ipquery_web_int_<file>`,`singleFork: true` 串行。

| 文件 | 覆盖 |
|---|---|
| `auth.signup.test.ts` | GET 200 表单;POST 校验失败;POST 成功 → 写 users(未验证)+ email_verifications;重复邮箱 → 409;限流触发 |
| `auth.verify.test.ts` | token 有效 → email_verified=1;过期 → 410;已消费 → 410;错误 → 401;重发冷却 |
| `auth.login.test.ts` | 正确凭据 → cookie;错误密码 → 401;未验证 → 403;被禁用 → 403;5 次失败 → 锁定 |
| `auth.forgot.test.ts` | POST 不论邮箱是否存在均 200;邮件队列收到 reset 链接;GET /reset 渲染;POST 校验密码强度;成功后 token consumed + 所有 session 失效 |
| `auth.logout.test.ts` | POST 清 cookie + 删 session;二次 logout 无副作用 |
| `dashboard.test.ts` | 未登录 → /dashboard 重定向 /login;登录后看到自己历史;看不到他人 |
| `dashboard.keys.test.ts` | 创建 key → 仅明文一次;列表显示 prefix;revoke 后立刻 401;删除复用 revoke |
| `dashboard.profile.test.ts` | 改 display_name;改密码需旧密码;改邮箱触发重新验证 |
| `admin.users.test.ts` | 非 admin → 403;admin 看列表(分页 + 搜索);启用/禁用;手动验证;重置密码 |
| `admin.etl.test.ts` | 触发 ETL → runs 新增 status='running';完成后 success;失败 status='failed' + error_message |
| `admin.keys.test.ts` | 全局 API key 列表;按 user 过滤;revoke;统计 |
| `admin.audit.test.ts` | 多维筛选;CSV 导出(流式响应,内容正确) |
| `query-log.test.ts` | 匿名 lookup → user_id=null;认证 → user_id + session_id;API key → api_key_id;invalid → status='invalid' |
| `migrations.test.ts` | 从空库应用全套迁移;幂等(再次执行无变化);模拟"已有 001/002"升级 |

### 9.3 E2E(`test/e2e/web-journey.test.ts`)

完整用户旅程:
1. GET `/` → 200,导航 + CTA
2. `/try` 输入 8.8.8.8 → 看到结果(htmx 片段)
3. `/signup` 提交 → inbox 收到验证链接
4. 提取 token → GET `/verify?token=...` → 重定向 `/login?verified=1`
5. POST `/login` → 拿到 cookie
6. GET `/dashboard` → 空历史
7. GET `/lookup?ip=8.8.8.8`(带 cookie) → 200
8. GET `/dashboard/history` → 看到刚才那条
9. POST `/dashboard/keys` → 明文仅一次显示
10. 用 key curl `/lookup?key=...&ip=1.1.1.1` → 200 + dashboard 显示 api key 来源
11. POST `/logout` → cookie 失效 → /dashboard 重定向

### 9.4 测试基础设施

```ts
// test/helpers/db.ts
export async function createTestDb(prefix: string): Promise<{ pool: Pool; dbName: string }>;
export async function dropTestDb(pool: Pool, dbName: string): Promise<void>;
export async function seedVerifiedUser(pool: Pool, overrides?: Partial<User>): Promise<User>;
export async function seedAdmin(pool: Pool, overrides?: Partial<User>): Promise<User>;
export async function loginAs(app: FastifyInstance, user: User): Promise<string>; // returns cookie

// test/helpers/email.ts
export class MockMailer {
  public inbox: Array<{ to: string; subject: string; text: string; html: string }> = [];
  async sendMail(opts) { this.inbox.push(opts); }
}
export function installMockMailer(app: FastifyInstance): MockMailer;

// test/helpers/csrf.ts
export function extractCsrf(html: string): string;
```

`vitest.config.ts`:

```ts
test: {
  pool: 'forks',
  poolOptions: { forks: { singleFork: true } }, // MySQL 共享,串行
  testTimeout: 30_000,
  hookTimeout: 30_000,
}
```

### 9.5 不测什么

- 视图 HTML 像素级(只断言关键文本存在)
- i18n 翻译完整性(en-US.json 留空不强制)
- 邮件正文渲染细节(只断言 subject + 链接)
- argon2id 性能基准
- htmx 行为细节(浏览器侧,集成测试只验证响应片段存在)

### 9.6 覆盖率目标(非门禁)

| 层级 | 行覆盖目标 |
|---|---|
| `src/web/auth/*` | ≥ 90% |
| `src/web/plugins/*` | ≥ 80% |
| `src/web/routes/auth/*` | ≥ 85% |
| `src/web/routes/dashboard/*` | ≥ 75% |
| `src/web/routes/admin/*` | ≥ 75% |
| `src/web/routes/marketing.ts` | ≥ 50% |

---

## 10. 部署 / 配置变更

### 10.1 新增环境变量

```bash
# Web
WEB_BASE_URL=http://localhost:3100
COOKIE_DOMAIN=
COOKIE_SECURE=false
SESSION_TTL_HOURS=168
SESSION_SECRET=                   # 32+ 字节,空则启动时生成并 warn
CSRF_SECRET=                      # 32+ 字节,同上

# SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="IPQuery <noreply@example.com>"

# 安全
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15
SIGNUP_RATE_PER_IP_PER_HOUR=5
VERIFY_RESEND_COOLDOWN_SECONDS=60

# 管理员引导
ADMIN_BOOTSTRAP_EMAIL=
ADMIN_BOOTSTRAP_PASSWORD=

# 已存在
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=ipquery
PORT=3100
MAXMIND_LICENSE_KEY=
```

### 10.2 `src/config.ts` 扩展

新增 `WebConfig` / `SmtpConfig` / `SecurityConfig` 子对象。`SMTP_HOST` 缺省 → console transport(开发友好)。校验:`SESSION_TTL_HOURS ≥ 1`,`LOGIN_MAX_ATTEMPTS ≥ 1`,cron 同既有。

### 10.3 数据库迁移

新建 `src/storage/migrations/`:

```
001_ip_ranges.sql
002_etl_runs.sql
003_users.sql
004_api_keys.sql
005_sessions.sql
006_email_verifications.sql
007_password_resets.sql
008_query_log.sql
```

`initSchema(pool)` 改为 `runMigrations(pool)`(记录到 `schema_migrations`)。向后兼容:旧部署若已存在 `ip_ranges` 表,视为 001/002 已应用。

### 10.4 CLI 新增

```
ipquery migrate              # 应用未执行迁移
ipquery migrate:status       # 列出已应用 / 待执行
ipquery create-admin --email admin@example.com --password '...'   # 种子 admin(跳过验证)
ipquery serve                # 现有,新增 --bind / --port
```

### 10.5 Docker / docker-compose

`Dockerfile` 不变(`npm ci --omit=dev` + `npm install --no-save typescript` + `npm prune` 已 OK)。

`docker-compose.yml`:

```yaml
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_PASSWORD}
    volumes: [mysql-data:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    build: .
    depends_on: { mysql: { condition: service_healthy } }
    environment:
      DB_HOST: mysql
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: ${DB_NAME:-ipquery}
      WEB_BASE_URL: ${WEB_BASE_URL:-http://localhost:3100}
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_FROM: ${SMTP_FROM:-noreply@example.com}
      ADMIN_BOOTSTRAP_EMAIL: ${ADMIN_BOOTSTRAP_EMAIL:-}
      ADMIN_BOOTSTRAP_PASSWORD: ${ADMIN_BOOTSTRAP_PASSWORD:-}
    ports: ["3100:3100"]
    command: ["node", "dist/cli.js", "serve"]

  app-migrate:
    build: .
    depends_on: { mysql: { condition: service_healthy } }
    environment: { ... 同 app ... }
    command: ["node", "dist/cli.js", "migrate"]
    profiles: ["migrate"]
```

日常:`docker compose up -d mysql app`。升级:`docker compose --profile migrate run --rm app-migrate && docker compose up -d app`。

### 10.6 Makefile 新增

```makefile
migrate:
	docker compose --profile migrate run --rm app-migrate

migrate-status:
	docker compose --profile migrate run --rm app-migrate migrate:status

create-admin:
	docker compose exec app node dist/cli.js create-admin --email $(EMAIL) --password $(PASS)

test-web:
	npm test -- test/integration/auth.* test/integration/dashboard.* test/integration/admin.* test/e2e/web-journey.test.ts

e2e:
	docker compose up -d mysql
	npm test -- test/e2e/web-journey.test.ts
```

`test-unit` / `test-int` / `lint` 不变。

### 10.7 首次部署清单(写入 README)

1. `cp .env.example .env`,填 `DB_PASSWORD` / `MAXMIND_LICENSE_KEY` / `SMTP_*` / `WEB_BASE_URL` / `COOKIE_SECURE=true` / `SESSION_SECRET` / `CSRF_SECRET`
2. `docker compose up -d mysql`
3. `make migrate`(建表)
4. `make update`(首次 ETL,可选前置)
5. `make create-admin EMAIL=you@example.com PASS='...'`
6. `docker compose up -d app`
7. 浏览器访问 `WEB_BASE_URL`,admin 登录 → 用户管理 → 确认 `email_verified=1`

### 10.8 安全默认值

- `COOKIE_SECURE=true` 在生产强制 HTTPS(否则 Set-Cookie 被浏览器拒收 → 用户无法登录)
- `SESSION_SECRET` / `CSRF_SECRET` 首次启动若空,从 `crypto.randomBytes(32)` 生成并 `.warn` 提示写入 `.env`
- 限流默认开启,关闭需显式 `LOGIN_MAX_ATTEMPTS=0`(用于自动化测试)
- 邮件模板统一在 `src/web/emails/`,不暴露密码到邮件正文

---

## 11. 授权与合规

新增内容继承 `2026-08-13-ip-aggregator-design.md §11`:

| 项 | 处理 |
|---|---|
| 用户密码 | 不写日志、不进 URL、邮件中不出现 |
| 用户邮箱 | 仅管理员后台可见;不在查询日志中记录 |
| 查询审计日志 | 仅管理员可读;CSV 导出受 admin 门禁保护 |
| Session / Token | 全部哈希存储,DB 泄露不可逆 |
| Argon2id 参数 | memoryCost=19MiB,timeCost=2,parallelism=1(OWASP 2023 推荐) |
| Cookie | httpOnly + SameSite=Lax + 生产 Secure |
| CSP | 严格限制脚本/样式/图片/表单来源,禁止 inline script |
| 数据删除 | 管理员删除用户 → 级联清理 api_keys / sessions / email_verifications / password_resets / query_log |

README 新增:
- 隐私声明:哪些数据被记录、保留多久、谁可访问
- 管理员责任清单:不要泄露审计 CSV、定期清理过期 session

---

## 12. 未来扩展(不在本次范围)

- 第三方登录(OAuth / OIDC)
- 双因素认证(TOTP / WebAuthn)
- 付费层 + 配额(Redis 限流 + Stripe / 微信支付)
- 多租户隔离(每用户独立数据子集)
- WebSocket 实时通知(ETL 完成 / 新查询告警)
- 用户自助注销 + 数据导出(GDPR Article 15 / 17)
- 找回用户名
- 国际化日期 / 数字 + 完整英文翻译
- 后台可视化图表(Chart.js / ECharts)
- Session 锁定状态持久化(Redis / MySQL)
- 全文搜索(用户 / 查询日志)
- Webhook(ETL 完成 → 推送到 Slack / 飞书)
