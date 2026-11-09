# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

2026-08-19 → 2026-11-09 的累积变更。尚未打 tag 发布。

### Added

- **MCP 服务**: stdio 传输的 Model Context Protocol 服务器（`npm run mcp`），7 个只读工具
  （`ipquery_lookup`、`ipquery_queue_stats`、`ipquery_etl_status`、`ipquery_queue_top`、
  `ipquery_queries_recent`、`ipquery_queries_daily`），供 AI 工具接入。查询日志默认脱敏，
  需显式传 `includePrivate: true` 才显示邮箱与 API Key 前缀。见 `docs/mcp.md`
- **自定义 Provider**: 通用 HTTP Provider（`GenericHttpProvider`）+ 工厂分发 + 管理界面，
  含 SSRF 防护（拦截 localhost／内网／link-local 地址）。见 migration 021
- **ETL 实时进度**: ETL 运行期间在管理界面渲染进度条（migration 022 + `/progress` JSON 端点）
- **ETL 可观测性**: 运行详情页按阶段分组（下载／解析／入库／swap），逐文件耗时与行数统计，
  见 migration 019
- **Provider 健康度**: 调用计数器、熔断健康窗口聚合（1h／24h／7d）、429 后自动禁用与
  冷却后自动恢复，见 migration 020
- **回灌预览**: `POST /admin/ingest/backfill/preview` 先干跑展示共识结果，
  管理员确认后才真正写入 `ip_ranges`
- **随机 IP 生成器**: 一次性生成与连续运行（默认 60s 一次）两种模式，可从保留地址池取址
- **管理控制台改版**: `/admin` 与 `/dashboard` 重设计为网络运维控制台；
  `/admin/settings` 改为 4 个哈希路由标签页（通用／安全／集成／系统）
- **CI**: GitHub Actions 工作流（Node 20），ESLint + Prettier 接入 `npm run lint`
- **每 IP 探测审计**: `random_probe_log` 记录每次 Provider 扇出的完整响应，
  管理界面可按批次回看，见 migration 018

### Changed

- `/admin/unknown-ips` 更名为 `/admin/ingest`（旧路径保留重定向）；`/admin/providers`
  成为 Provider 管理的统一入口
- 管理界面内联脚本外提为独立文件，以符合 CSP
- 移除 Docker 部署（改用 Makefile + 原生 Node）
- 测试脚本拆分：`test:unit` / `test:integration` / `test:e2e`

### Fixed

- **CSRF 绑定**: CSRF 校验改为 HMAC 绑定（`csrf_bind` httpOnly Cookie），
  防止跨站请求伪造绕过
- **密钥泄漏**: `/admin/settings` 曾在 `data-secret` 属性中输出原始密钥，
  现改为服务端 `redactSecret()` 脱敏后再渲染
- **Cookie 密钥**: 缺失 session/csrf 密钥时启动即失败（不再静默降级到默认值）
- **CSP 兼容性**: `onsubmit` 确认对话框改为 CSP 安全的 `data-confirm`
- **ETL 进度脚本**: 修复 `etl-progress.js` 中未闭合的三元表达式（导致构建失败）
- **ETL 数据一致性**: 修复 `INSERT … ON DUPLICATE KEY` 的 `affectedRows` 语义误用，
  以及 migration 020 的 schema 漂移（改用 INFORMATION_SCHEMA 守卫，兼容 MySQL 5.7）
- **回灌并发**: 三个 Provider 扇出入口（回灌预览／回灌确认／随机 IP 生成）此前互不感知，
  可并发冲击 Provider 免费额度。现由共享互斥锁串行化，并加路由级限流
- **Admin 页面 htmx 缺失**: `layouts/admin.hbs` 未引入 `htmx.min.js`，导致管理端全部
  `hx-get` 轮询失效——ETL 进度条不刷新、运行详情不自动更新、`/admin` 与 `/admin/queries`
  的 30 秒自动刷新静默失效。现已在 admin layout 引入 htmx
- **ETL 进度条被覆盖**: 进度条容器原在 `hx-swap="outerHTML"` 的 section 内，
  5 秒一次的 `/live` 局部刷新会把整个 section 连同进度条一并替换掉。现移至 section 之外
- **回灌提示**: 预览 cookie 失效／过期时，此前会渲染成全零的“成功”摘要，现显示明确提示
- **随机探测表增长**: `random_probe_log` 此前只写不删，现按可配置的保留窗口
  （默认 30 天，`random_probe_retention_days` 设置项，0 表示永久保留）定期清理
- **迁移断言过期**: 三个集成测试硬编码了迁移版本清单与数量，migration 021／022 落地后未同步，
  导致 `migrations.test.ts`、`migrations.legacy.test.ts`、`cli.migrate.test.ts` 失败，现已同步
- **首页断言过期**: `home.test.ts` 仍断言改版前的 `m-ipgrid` class，而字节网格组件已重命名为
  `m-bits`，现同步断言
- **审计写入失败被静默吞掉**: Provider 扇出路径上的 7 处 fire-and-forget 写入
  （`provider_error_log`、`random_probe_log`、`provider_call_counter`、ETL 阶段失败标记、
  连接池关闭）捕获异常后直接丢弃。控制流本身是对的（审计写入失败不该中断正常运行的批次），
  但静默有实际代价：`provider_error_log` 是熔断器唯一的输入，写丢失则熔断器永远看不到失败、
  也就永不熔断；`random_probe_log` 是各 Provider 响应的唯一记录，丢行与“Provider 从未被调用”
  无法区分；ETL 阶段失败标记写丢失则该运行在管理界面永远显示为 `running`。
  现全部改为记录告警（附 IP／Provider 与底层错误），行为不变——写入依旧非致命，批次依旧完成
- **种子 IP 完全查不到**: migration 012 把种子地址写成 `UNHEX('08080808')`（4 字节左对齐），
  而 `start_ip`／`end_ip` 是 `BINARY(16)`，所有运行时路径（`parseIp()`、DB-IP 与 MaxMind
  解析器、`findRange()` 的查询参数）统一用 16 字节右对齐形式存储。MySQL 按补零后的值比较，
  左对齐形式排在右对齐形式之下，任何查询都匹配不上——50 条种子数据全部是死的，
  8.8.8.8 明明在种子数据里，`/lookup` 仍返回“未找到”。
  已就地修正 migration 012（全新安装），并新增 migration 023 修复已执行过旧版 012 的库

### Security

- 集成测试辅助函数统一为三 Cookie CSRF 协议（`csrf` + `csrf_issued` + `csrf_bind`），
  16 个测试文件同步适配
- MCP 工具输出中的邮箱与 API Key 前缀默认脱敏

## [0.1.0] - 2026-08-19

### Added

- **Core API**: `GET /lookup`, `GET /lookup/:ip`, `GET /stats`, `GET /healthz`
- **Data sources**: MaxMind GeoLite2 (City + ASN), ip2region (free), DB-IP (city)
- **ETL pipeline**: scheduled daily refresh with progress tracking and admin trigger
- **User auth**: email + password, verification, password reset, sessions in MySQL
- **API Keys**: per-user tokens with rate-limit uplift; revocable
- **Admin console**: users, ETL runs, API keys, query log, audit log, query stats, settings
- **Web console**: dashboard, history, keys, profile (i18n: zh-CN, en-US)
- **CSRF, rate limits, session lockouts**: see README "CSRF, sessions, rate limits"

### Notes

- This is the first tagged release. Pre-commit history is not backfilled.
- Data files are not bundled; the user must register a MaxMind license key.

[0.1.0]: https://example.com/ipquery/releases/tag/v0.1.0
