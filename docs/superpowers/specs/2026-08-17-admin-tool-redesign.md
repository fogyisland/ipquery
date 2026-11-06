# IPQuery 后台工具站化重构 — 设计文档

**日期**：2026-08-17
**状态**：待用户审阅
**作者**：Brainstorming 会话(继承 2026-08-13-web-frontend-design.md)
**基础**：[`2026-08-13-web-frontend-design.md`](2026-08-13-web-frontend-design.md)

---

## 1. 目标与摘要

将已有的 web 前端从"营销 + 简单后台"重构为"左固定侧边栏 + 主区数据表"的工具型风格,主要新增四个能力:

1. **Dashboard 总览页** — `/admin` 首屏聚合系统状态(ETL / DB / 查询量 / 用户数 / 近期活动)
2. **操作日志** — 全部 admin POST 行为留痕,可筛选 + 导出 CSV
3. **数据表增强** — 用户 / keys / audit / etl-runs 列表加排序、多状态筛选、时间范围、批量操作、CSV 导出
4. **系统设置面板** — `/admin/settings` 显示当前生效配置(脱敏) + DB 池状态 + ETL 调度操作

前台(`/`、`/docs`、`/pricing`)同步简化:`/` 改成"工具首页"(查询框 + 实时状态),`/pricing` 删除,`/docs` 改成 API 参考 + 集成示例。

---

## 2. 范围与非目标

### 2.1 范围内

#### 后台

- `/admin`(总览):5 个数字卡片 + 2 个趋势图(SVG sparkline,无图表库)+ 近期活动流(20 条)
- `/admin/users`(增强):按邮箱 / 角色 / 启用状态 / 注册时间筛选,按 id / 注册时间排序,勾选批量启停 / 删除,CSV 导出
- `/admin/etl/runs`(增强):按状态 / 时间范围筛选,CSV 导出
- `/admin/keys`(增强):按用户 / 状态 / 创建时间筛选,CSV 导出
- `/admin/audit`(增强):按用户邮箱 / IP / 状态 / 时间范围筛选,已有 CSV,本任务确认
- `/admin/audit-log`(新):操作日志,按操作人 / 类型 / 时间 / 目标 ID 筛选,CSV 导出
- `/admin/settings`(新):只读配置显示 + DB pool 状态 + ETL 调度操作按钮
- `/admin/queries`(新):查询量统计 — 总览 / Top 10 查询 IP / Top 10 用户 / 24h 时间序列

#### 前台

- `/`(改):hero 查询框 + "API 状态"卡片 + "最近 24h 查询"数字 + `/try` 链接
- `/docs`(改):API 参考(从源码注释渲染)+ 集成示例(fetch / curl / Python / Node)
- `/pricing`(删):路由删除,前端侧边栏移除入口
- `/try`、`/about`、`/status`:保留,无大改

#### 全局

- 统一侧边栏布局(所有页面用 `layouts/app.hbs` + 部分 `layouts/admin.hbs`)
- 侧边栏分组折叠:运营 / 用户 / API
- 设计系统常量(`assets/style.css` 增量更新,不重写)

### 2.2 非目标(本次不做)

- 实时推送(WebSocket / SSE)— 用 30 秒 htmx 自动刷新代替
- 复杂图表库(Chart.js / uPlot)— 手写 SVG sparkline
- 多租户隔离 / RBAC(只 admin 一种角色)
- 系统设置面板的"在线编辑 .env"(只读)
- 操作日志的"回滚"功能(只留痕,不 undo)
- 用户自助注册流程改动(沿用 Task 14 已实现的 `/signup`)
- 国际化切换 UI(已有 cookie + 服务端,只补文案)
- 移动端响应式(后台工具站,目标屏宽 ≥ 1280px)

---

## 3. 需求摘要

| 维度         | 决策                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 后台布局     | 左固定 220px 侧边栏 + 顶部 56px header + 主区                                                                          |
| 前台布局     | 同上(统一)                                                                                                             |
| 样式         | 现有 `assets/style.css` 增量,不加新依赖                                                                                |
| 图表         | 手写 SVG sparkline,零依赖                                                                                              |
| 数据表交互   | htmx(沿用)+ query string + 服务端重渲染                                                                                |
| 自动刷新     | htmx `hx-trigger="every 30s"`(仅 Dashboard 总览)                                                                       |
| 操作日志存储 | 新表 `admin_audit_log`(BIGINT id / actor_user_id / action / target_type / target_id / metadata JSON / ip / created_at) |
| 操作日志写入 | `src/web/plugins/auditLog.ts` — `onResponse` hook 读 `req.auditAction`,自动写库,失败不影响响应                         |
| CSV 导出     | 已有 helper `csvForRows`(`admin/audit` 复用),其他列表各自实现                                                          |
| 配置脱敏     | 复用 `redactSecret()`(`src/config.ts:128`)                                                                             |
| 数据表筛选   | query string(`?role=admin&disabled=1&since=2026-01-01&sort=-created_at`)+ 服务端解析                                   |
| 批量操作     | form POST 选中 id(逗号分隔)→ 后端循环处理                                                                              |
| 测试         | vitest + supertest,沿用现有模式                                                                                        |

---

## 4. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                          │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Fastify(沿用 Task 23 的 buildServer)                              │
│  ├─ 已注册插件:cors / cookie / formbody / static / view            │
│  ├─ 已注册插件:view / i18n / security / session / csrf            │
│  ├─ 已注册插件:queryLog writer(批量写 query_log)                   │
│  └─ NEW: src/web/plugins/auditLog.ts                              │
│       └─ onResponse → INSERT admin_audit_log(异步)                │
│                                                                  │
│  路由(全部在 src/web/routes/admin.ts / dashboard.ts):              │
│  ├─ GET   /admin                       → admin/dashboard.hbs       │
│  ├─ GET   /admin/users                 → admin/users-list.hbs      │
│  ├─ POST  /admin/users/bulk            → 批量操作                  │
│  ├─ GET   /admin/etl/runs              → admin/etl-runs.hbs(增强)  │
│  ├─ GET   /admin/keys                  → admin/keys.hbs(增强)      │
│  ├─ GET   /admin/audit                 → admin/audit.hbs(增强)     │
│  ├─ GET   /admin/audit-log             → admin/audit-log.hbs(NEW)  │
│  ├─ GET   /admin/queries               → admin/queries.hbs(NEW)    │
│  ├─ GET   /admin/settings              → admin/settings.hbs(NEW)   │
│  └─ GET   /admin/users.csv / etl.csv / keys.csv / audit.csv /     │
│           audit-log.csv / queries.csv(导出)                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  MySQL(沿用)                                                      │
│  ├─ NEW 010_admin_audit_log.sql                                    │
│  │     admin_audit_log(id, actor_user_id, action, target_type,    │
│  │                      target_id, metadata, ip, user_agent,      │
│  │                      created_at)                                │
│  └─ 已有 001..008(不动)                                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. 数据库变更

### 5.1 新增迁移 `010_admin_audit_log.sql`

```sql
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  actor_email VARCHAR(255) NOT NULL,                  -- 冗余存储,删人后日志仍有显示
  action VARCHAR(64) NOT NULL,                        -- e.g. 'user.delete', 'user.reset_password', 'etl.trigger', 'key.revoke'
  target_type VARCHAR(32) NULL,                       -- 'user' / 'api_key' / 'etl_run' / NULL
  target_id BIGINT UNSIGNED NULL,
  metadata JSON NULL,                                  -- 额外上下文,e.g. {"reason":"bulk_disable"}
  ip VARCHAR(45) NULL,                               -- IPv6 max 45 chars
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_actor_created (actor_user_id, created_at),
  INDEX idx_target (target_type, target_id),
  INDEX idx_action_created (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

无外键(`actor_user_id` 不引用 `users.id`)— 删人后日志不消失。

### 5.2 已有表改动

无 schema 变更。`users`、`api_keys`、`query_log` 表结构不变,本任务只读 / 写增量数据。

---

## 6. 后端模块设计

### 6.1 操作日志插件 `src/web/plugins/auditLog.ts`

```ts
declare module "fastify" {
  interface FastifyRequest {
    auditAction?: {
      action: string; // 'user.delete'
      targetType?: string; // 'user'
      targetId?: number | string;
      metadata?: Record<string, unknown>;
    };
  }
}

// 路由 handler 内:
//   req.auditAction = { action: 'user.delete', targetType: 'user', targetId: 42 };
// 不调用,直接赋值即可。

// 插件注册:
//   await registerAuditLog(app);
//   app.addHook('onResponse', async (req, reply) => {
//     if (!req.auditAction || reply.statusCode >= 400) return;
//     await recordAuditLog(app.pool, { ...req, user: req.user, audit: req.auditAction, statusCode: reply.statusCode });
//   });

export function recordAuditLog(
  pool,
  opts: {
    actor: { id: number; email: string } | null;
    audit: NonNullable<FastifyRequest["auditAction"]>;
    ip: string;
    userAgent: string;
    statusCode: number;
  },
): Promise<void>;
```

写入策略:**异步不阻塞响应**(不 await)。失败只 pino.error,不影响主响应。

### 6.2 Dashboard 总览数据聚合

新建 `src/web/admin/overview.ts`:

```ts
export interface Overview {
  generatedAt: Date;
  etl: {
    lastRun: {
      id: number;
      startedAt: Date;
      finishedAt: Date | null;
      status: string;
      mergedRecords: number;
    } | null;
    lastSuccessAt: Date | null;
    runsToday: number;
  };
  db: {
    ipRanges: number; // SELECT COUNT(*) FROM ip_ranges
    queryLogTotal: number; // SELECT COUNT(*) FROM query_log
    users: { total: number; verified: number; disabled: number };
    apiKeys: { total: number; active: number };
  };
  queries24h: {
    total: number;
    hitRate: number; // hit / total
    trend: number[]; // last 24 hours bucketed, sparkline data
  };
  recentActivity: AdminAuditLogEntry[]; // 20 条 admin_audit_log
}

export function getOverview(pool: Pool): Promise<Overview>;
```

聚合 SQL 全部用索引覆盖或 `COUNT(*)`(InnoDB 统计,精确即可)。

### 6.3 查询量统计 `src/web/admin/queries.ts`

```ts
export interface QueryStats {
  range: { since: Date; until: Date };
  total: number;
  byStatus: { hit: number; miss: number; invalid: number };
  topIps: Array<{ ip_text: string; n: number }>; // 10
  topUsers: Array<{ user_email: string; n: number }>; // 10
  hourly: number[]; // sparkline bucketed
}

export function getQueryStats(
  pool: Pool,
  opts: {
    since?: Date;
    until?: Date;
  },
): Promise<QueryStats>;
```

### 6.4 CSV 导出 helper

已有 `csvForRows` 在 `src/web/admin/csv.ts`(沿用 Task 22)— 所有 admin 列表页统一调用。

### 6.5 数据表筛选 / 排序 query string 协议

```
?role=admin|user                # 单值
&disabled=0|1                    # 单值
&verified=0|1                    # 单值
&since=2026-01-01                # ISO date,created_at >=
&until=2026-12-31                # ISO date,created_at <=
&search=foo                      # LIKE %foo%
&sort=-created_at|+id            # 前缀表示 - 降序
&page=2&limit=50                   # 分页
&ids=1,2,3                        # 批量操作
```

解析器:`src/web/admin/queryString.ts`(新)— 接受 raw querystring + 字段白名单,返回 `{ filters, sort, page, limit, ids }`。

---

## 7. 前端设计系统

### 7.1 布局:左固定侧边栏 + 主区

```
┌──────────────────────────────────────────────────────────────────┐
│ ◀ IPQuery                                       [en] [user ▾]   │  ← header (56px)
├────────────┬─────────────────────────────────────────────────────┤
│            │                                                     │
│ 220px      │                                                     │
│ sidebar    │              main content                            │
│            │              (max-width 1400px, padding 24px)        │
│ 运营       │                                                     │
│  · 总览    │                                                     │
│  · ETL     │                                                     │
│  · 查询量  │                                                     │
│  · 操作日志│                                                     │
│            │                                                     │
│ 用户       │                                                     │
│  · 用户列表│                                                     │
│            │                                                     │
│ 系统       │                                                     │
│  · API keys│                                                     │
│  · 查询审计│                                                     │
│  · 设置    │                                                     │
│            │                                                     │
│ ─────────  │                                                     │
│ ← 后退前台 │                                                     │
└────────────┴─────────────────────────────────────────────────────┘
```

### 7.2 设计 token(增量,不动现有 CSS 大块)

```css
:root {
  --color-bg: #f7f8fa; /* 主背景,工具站感 */
  --color-surface: #ffffff;
  --color-border: #e5e7eb;
  --color-text: #111827;
  --color-text-muted: #6b7280;
  --color-accent: #2562d; /* 主色,工具蓝 */
  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-danger: #dc2626;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.08);
}
```

### 7.3 组件(增量,复用现有)

- `.card` — 数字卡片、设置卡片
- `.table` — 高密度数据表(已有,小调整)
- `.pill` — 状态标签(`hit` / `miss` / `invalid` / `admin` / `user`)
- `.sparkline` — SVG 折线,固定 80×24 px
- `.filter-bar` — 横向筛选条(checkbox / select / date input)
- `.button-secondary` / `.button-danger` — 次要 / 危险按钮

### 7.4 前台首页 `/`(工具首页)

```
┌──────────────────────────────────────────────────────────────────┐
│ [header]                                                        │
├────────────┬─────────────────────────────────────────────────────┤
│ sidebar    │                                                     │
│            │  快速查询                                            │
│            │  ┌──────────────────────────────────────────────┐    │
│            │  │ 8.8.8.8                       [ 查询 ]    │    │
│            │  └──────────────────────────────────────────────┘    │
│            │                                                     │
│            │  ┌──────────────┐  ┌──────────────┐                  │
│            │  │ API 状态      │  │ 24h 查询     │                  │
│            │  │ ✓ 正常       │  │ 1,234       │                  │
│            │  │ 5 IP 段已索引 │  │ 命中 87%     │                  │
│            │  └──────────────┘  └──────────────┘                  │
│            │                                                     │
│            │  集成示例                                            │
│            │  curl "http://localhost:4001/lookup?ip=8.8.8.8..."  │
│            │                                                     │
└────────────┴─────────────────────────────────────────────────────┘
```

### 7.5 `/docs` 改造

- 顶部:Tab 切换"API 参考 / 集成示例"
- API 参考:服务端从源码注释渲染(`src/web/routes/docs.ts` 读 `src/api/routes/*.ts` 的 JSDoc)— 或简化为手写 4 个 endpoint 的描述(降低风险,取后者)
- 集成示例:4 个 curl / fetch / Python / Node 代码块

---

## 8. 路由清单

### 8.1 后台(全在 `src/web/routes/admin.ts` 或新文件)

| Method | Path                   | Page                      | New / Modified    |
| ------ | ---------------------- | ------------------------- | ----------------- |
| GET    | `/admin`               | `admin/dashboard.hbs`     | **NEW**           |
| GET    | `/admin/users`         | `admin/users-list.hbs`    | **MOD**(增强筛选) |
| POST   | `/admin/users/bulk`    | redirect → `/admin/users` | **NEW**           |
| GET    | `/admin/users.csv`     | CSV                       | **NEW**           |
| GET    | `/admin/etl/runs`      | `admin/etl-runs.hbs`      | **MOD**(增强筛选) |
| GET    | `/admin/etl/runs.csv`  | CSV                       | **NEW**           |
| GET    | `/admin/keys`          | `admin/keys.hbs`          | **MOD**(增强筛选) |
| GET    | `/admin/keys.csv`      | CSV                       | **NEW**           |
| GET    | `/admin/audit`         | `admin/audit.hbs`         | **MOD**(增强筛选) |
| GET    | `/admin/audit.csv`     | CSV                       | 已有,验证仍工作   |
| GET    | `/admin/audit-log`     | `admin/audit-log.hbs`     | **NEW**           |
| GET    | `/admin/audit-log.csv` | CSV                       | **NEW**           |
| GET    | `/admin/queries`       | `admin/queries.hbs`       | **NEW**           |
| GET    | `/admin/queries.csv`   | CSV                       | **NEW**           |
| GET    | `/admin/settings`      | `admin/settings.hbs`      | **NEW**           |

### 8.2 前台

| Method  | Path           | Page       | New / Modified    |
| ------- | -------------- | ---------- | ----------------- |
| GET     | `/`            | `home.hbs` | **MOD**(工具首页) |
| GET     | `/docs`        | `docs.hbs` | **MOD**(API 参考) |
| ~~GET~~ | ~~`/pricing`~~ | —          | **DELETE**        |

### 8.3 前台侧边栏

`partials/sidebar.hbs`(替换现有 `partials/nav.hbs`):

- 公共:`/`(首页) · `/docs` · `/try` · `/status` · `/about`
- 登录用户:`/dashboard` · `/dashboard/history` · `/dashboard/keys` · `/dashboard/profile`
- 管理员:同后台侧边栏

---

## 9. 测试策略

每 task 至少 1 个集成测试(vitest + supertest),沿用现有模式:

- `test/integration/admin.dashboard.test.ts` — 总览页 200,含 5 个数字卡片、sparkline SVG、20 条活动
- `test/integration/admin.users.enhanced.test.ts` — 筛选 / 排序 / 分页 / CSV / 批量操作
- `test/integration/admin.auditlog.test.ts` — 操作日志写入 + 筛选 + CSV
- `test/integration/admin.queries.test.ts` — 查询量聚合 + Top IP / User
- `test/integration/admin.settings.test.ts` — 配置显示脱敏
- `test/integration/auditLog.test.ts` — 插件单元:handler 写 `req.auditAction` 后,DB 有记录
- `test/integration/home.test.ts` — 工具首页含查询框 + 状态卡片
- `test/integration/docs.test.ts` — `/docs` 含 API 参考

全文:180 + 15 = 195 测试左右。

---

## 10. 全局约束

| 约束       | 值                                              |
| ---------- | ----------------------------------------------- |
| Node 版本  | ≥ 20.0.0(已有)                                  |
| 测试通过   | 180/180 → 195/195                               |
| TypeScript | strict,`tsc --noEmit` 干净                      |
| 新依赖     | **0**(SVG sparkline / htmx 复用)                |
| 行尾       | LF(仓库已统一)                                  |
| 文件结尾   | 必须有 newline                                  |
| i18n       | 沿用 zh-CN / en-US,新文案两边都加(空字符串也行) |
| 现有功能   | 不破坏,只是增强                                 |
| ESLint     | 仓库未配,不引入                                 |

---

## 11. 任务分解(高层,详见 plan 文件)

```
Task  1: 010_admin_audit_log migration + storage helper
Task  2: src/web/plugins/auditLog.ts (plugin + onResponse hook)
Task  3: src/web/admin/queryString.ts (filter/sort parser)
Task  4: 新 partials/sidebar.hbs + assets/style.css 增量(token + components)
Task  5: src/web/routes/admin.ts — /admin 总览 + dashboard.hbs
Task  6: /admin/users 增强(筛选/排序/CSV/批量)
Task  7: /admin/etl/runs 增强(筛选/CSV)
Task  8: /admin/keys 增强(筛选/CSV)
Task  9: /admin/audit-log(新)— 读 + 写均在此 task
Task 10: /admin/queries(新)— 查询量聚合
Task 11: /admin/settings(新)
Task 12: 把所有 admin POST handler 接入 req.auditAction
Task 13: 前台 / + /docs 改造 + /pricing 删除
Task 14: 侧边栏布局统一 — dashboard 也用侧边栏
Task 15: 全量集成测试 + README 更新
```

---

## 12. 风险与对策

| 风险                       | 对策                                                       |
| -------------------------- | ---------------------------------------------------------- |
| 操作日志写入失败影响响应   | 异步不 await,pino.error,主响应已发                         |
| 聚合查询慢(Dashboard)      | 走 InnoDB 统计,数据量小(< 1M 行时 < 100ms)                 |
| SVG sparkline 数值越界     | 内部 normalize 到 [0, max],max 0 时退化为空                |
| CSV Excel 编码乱码         | 输出 `﻿` BOM 头                                            |
| 批量操作超时               | 默认批量上限 100,超出 422                                  |
| 现有 admin 页面外观大改    | 改 design token + 组件 class,模板渐近迁移,不一次性重写所有 |
| 操作日志的 `metadata` JSON | 已有 query_log 类似实践;MySQL JSON 类型                    |

---

## 13. 审阅清单

- [ ] 范围与非目标确认(尤其"不做"清单)
- [ ] 路由变更清单(8.1 + 8.2)无遗漏
- [ ] 数据库变更(5.1)字段对齐
- [ ] 设计 token(7.2)与现有 CSS 不冲突
- [ ] 测试覆盖(9)足够

— END —
