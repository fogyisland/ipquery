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
- **初始化向导重设计**: `/setup` 6 步向导重做为「开机自检日志 + 配置工作表」——
  左侧 320px 暗色 rail（纵向编号步骤 + `[ok]`/`[>]` 标记 + 6 格进度条），
  右侧亮色工作表（下划线输入、38rem 行宽）；新增 `src/web/assets/css/setup.css`
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
- **种子数据遮蔽真实 ETL 数据**: `findRange()` 取覆盖区间中 `range_size` 最小者，而
  `range_size = 0` 表示“单地址”——种子行全是单地址，因此排在所有真实 ETL 段之前，
  一旦 ETL 数据也覆盖同一地址，其更精细的字段（城市、ISP、坐标）会被种子的粗略值盖掉。
  现改为按来源优先：真实数据恒胜过种子数据，同类之间仍取最小区间；无真实数据时种子行兜底
- **range_size 精度丢失**: `range_size` 是 `BIGINT UNSIGNED`，mysql2 以 JavaScript number
  返回，超过 2^53 即丢精度——IPv6 catchall 行存的恰是 2^64-1，取回来却变成 2^64。
  现改为在 SELECT 中 `CAST(range_size AS CHAR)`，保留精确十进制再由 `BigInt()` 解析
- **关停时连接池先于插件关闭**: Fastify 的 `onClose` 钩子按注册的**逆序**执行，而关池的钩子
  注册在 `buildServer()` 末尾 → 它**最先**执行。于是 session 清理器的最后一次 sweep 和
  query-log 写入器的最后一批 flush 都撞上已关闭的池：前者每次关停都记一条
  `Pool is closed.` 错误日志，后者的 flush 捕获异常后只记日志，**缓冲里未落盘的查询日志被静默丢弃**。
  现把关池钩子移到连接池创建之后（插件注册之前），逆序下它最后执行，各插件的收尾 flush 都能拿到打开的池。
  新增 `shutdown-order.test.ts` 固化该顺序
- **migration 022/020 的 DDL 次数**: 每条 `ALTER TABLE` 都是一次隐式提交 + 落盘，在慢磁盘上约 1 秒/条。
  022 的 6 条 ALTER 合成 1 条（9477ms → 1757ms），020 的 2 条合成 1 条（5198ms → 3230ms），
  全新库建 schema 的成本因此下降约 10 秒。幂等性保持不变（仍按 INFORMATION_SCHEMA 逐列判断缺失，
  只补缺的那几列）——MySQL 5.7 不支持 `ADD COLUMN IF NOT EXISTS`
- **API 限流文档缺失**: `/docs` 新增 Rate limits 一节（匿名／API Key／管理后台三档），
  公布的数字取自服务端配置而非硬编码，不会与实际设置漂移；同时说明路由级限流
  （登录、重发验证邮件等）是**替换**而非叠加全局限额
- **管理轮询挤占公共限流额度**: `/admin`、ETL `/live` 与 `/progress`、`/admin/queries`
  每秒轮询一次，与公共 API 共享 60/分钟的全局限流——轮询本身就能把额度吃光，
  之后整个 IP 的所有管理页面全部 429。现给轮询路由独立的 120/分钟额度
- **静态资源与页面挤占公共 API 限流额度**: 全局限流按来源 IP 统计**每一个**请求，
  HTML 页面和静态资源也算在内。setup 页要拉 4 个样式表，匿名访客还没拿到页面
  就先花掉了五分之一额度。更糟的是失败形态：429 响应体是 JSON，浏览器于是报
  “Refused to apply style … MIME type 'application/json' is not a supported
  stylesheet MIME type”——样式表**静默不生效**，页面裸奔。
  现只对公共 API（`/healthz`、`/lookup`、`/stats`）限流，页面与静态资源不再计入额度；
  管理路由仍走各自的路由级限额
- **错误页裸奔**: `layouts/public` 渲染 `{{> sidebar}}` 时既没有 `.dashboard-shell`
  网格容器，也没有引入 `admin.css`（`.sidebar`／`.sidebar-link` 等类已迁往该文件）。
  于是全部错误页——41 处调用点的 CSRF 过期页、403、404——导航塌缩成一列裸文字。
  现补齐网格容器与样式表，与 `layouts/dashboard` 结构一致。
  同时把 `errors/{403,404,500}.hbs` 改用向导的 `boot-*` 语汇（标题／正文／主按钮），
  并让 `.btn-primary` 脱离 `body.layout-setup` 前缀成为全局规则——`setup.css` 只被
  setup 与 public 两个布局加载，admin／dashboard／app／marketing 都不受影响
- **`{{--` 注释起始符写错导致整页 500**: Handlebars 的注释是 `{{!--`，少写一个 `!`
  会被当作块起始符，注释正文随后被当成模板表达式解析。报错信息指向注释中间某个
  无关的词（`Expecting 'ID', got 'INVALID'`），真正的位置在三行之前——排查成本极高。
  新增 `test/unit/hbs-views.test.ts`，对 66 个视图逐个编译并检查注释格式
- **验证邮件重发的冷却键错位**: 重发冷却原按**目标** userId 记，挡住了对同一用户的重复发送，
  却挡不住枚举攻击——脚本遍历 userId 1..N 可给每个已注册用户发一封邮件而毫无阻拦。
  现改为按**请求者**（IP）冷却，并加 10/小时 的路由级限流；未知或畸形 userId 返回 404
- **API Key last_used_at 每请求写库**: 仪表盘对"3 秒前用过"和"30 秒前用过"无感知差异，
  但每次请求写一行是纯开销（一次 DB 往返 + 行锁）。现每 key 至多 60 秒落一次盘，
  写失败时清掉节流标记以便下个请求重试
- **错误响应泄漏数据库内部信息**: 全局错误处理器曾把底层错误消息原样返回给客户端
  （表名、SQL 片段等）；`isValidIp`／`parseIp` 对超长输入未设上限；400 响应回显原始输入。
  现统一由全局 handler 输出通用错误文案，输入长度上限 45 字符，400 不再回显
- **MCP maskEmail 子域泄漏**: 邮箱脱敏按**第一个**点截断域名，
  `a@mail.example.com` 输出 `a***@m***.example.com`——本应隐藏的注册域整段暴露。
  现只保留 TLD：`a***@m***.com`
- **MCP 连接池时区漂移**: stdio 服务器自建 `mysql.createPool`，未带共享工厂的 `timezone: "Z"`，
  所有 ISO 时间戳随进程时区偏移。现复用 `createPool(cfg)`
- **查询按天统计的时区错位**: `countQueriesByDay` 以**本地**零点定窗口、却按 UTC ISO 日期分桶，
  每天的总量随服务器时区偏移错位（管理端概览与 `ipquery_queries_daily` 同时受影响）。
  现窗口与分桶全 UTC，SQL 侧 `DATE(CONVERT_TZ(ts, ... '+00:00'))`
- **MCP not_found 误报为工具失败**: 查询未命中是正确的空答案，却置了 MCP 协议级 `isError`，
  客户端会把"未知 IP"当成工具故障。现降级为正常响应
- **两个集成测试滞后于已提交行为**: `lookup.auth` 未清 last_used_at 的进程内写节流表
  （60 秒节流把断言的写入吞掉）；`seed-data` 的 helper 仍按 migration 023 修复**前**的
  字节序（右填充）断言。均已对齐
- **`{{req.t}}` 在 `{{#each}}` 内抛 "Missing helper: req.t"**: `req.t` 是 req 上的**属性查找**，
  不是注册的 Handlebars helper，循环内上下文是迭代项，因此取不到。`/dashboard/keys`
  对任何有过期密钥的用户直接 500（`{{else}}` 分支则静默渲染成空字符串）。
  现统一改用 `{{../req.t}}` / `{{@root.req.t}}`
- **审计日志写入 NaN**: `admin_audit_log.target_id` 是 BIGINT 列，但 6 处调用点审计的是
  可读名字（Provider 名、IP 文本），`Number("ip-api")` 为 NaN，mysql2 发出字面量 `NaN`，
  MySQL 报 `ER_BAD_FIELD_ERROR`，这 6 条审计记录全部丢失。现非数字 target 存 NULL，
  可读值移入 `metadata.target`
- **ETL 触发测试滞后于并发守卫**: `admin.etl.test.ts` 仍期望 trigger 新建运行行，
  但 `01e7efd` 加的守卫会在存在 `running` 行时拒绝（正是该测试 `beforeAll` 造出的状态）。
  现先收尾种子行，并补一条断言拒绝路径的用例

### Security

- **`.env` 停止纳入版本控制**: `.env` 自 `b8a2e51`（2026-08-28）起被跟踪，
  且带着明文数据库口令；`.gitignore` 里的 `.env` 规则对**已跟踪文件无效**，因此从未生效。
  现已 `git rm --cached .env`，仓库只保留 `.env.example`，本地 `.env` 不再进入版本库。
  历史中仍留有明文口令，数据库凭据需要轮换

  历史扫描结果（仅统计位置与取值形态，不含明文）：
  - `b8a2e51` 的 `.env` —— 真实的数据库口令，**需要轮换**
  - `251be37` 的 `.env.example` 与 `a10a873`/`b238292` 文档里的 `DB_PASSWORD` —— 占位值 `rootpass`，无害
  - `056e342`/`e2670f2` 文档里的 `SESSION_SECRET`/`CSRF_SECRET` —— 占位内容
    （中文注释与 `replace_me_with_64_random_bytes_in_prod` 之类的说明文字），并非真实密钥；
    代码也从未把密钥默认值写死（`src/config.ts` 读不到即启动失败）
  - `.env` 中的 `MAXMIND_LICENSE_KEY` 在历史里为空值，不是泄漏
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
