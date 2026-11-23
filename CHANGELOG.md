# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

2026-08-19 → 2026-11-09 的累积变更。尚未打 tag 发布。

### Added

- **五个零覆盖模块补上单元测试（63 个用例）**: 导入图分析找出 30 个「测试从未直接
  引用」的 `src/` 文件，其中多数是插件与路由，由 `buildServer()` + `inject()` 间接
  覆盖；真正**一条断言都没有**的是这五个。它们各自管着一件出错时没人会立刻发现的事：
  1. **`src/web/admin/csv.ts`（13 个用例）**: 控制台导出 CSV 的转义。导出里每一个
     字节都可能是别人写的——用户自选的邮箱、抓来的城市名。带逗号的值会悄悄挪动后面
     所有列，带换行的值会悄悄变成两行，而导出是「点一下下载」，没人会去看原始字节。
     用例里带了一个小型 RFC 4180 解析器：字符串比较分不出 `a,b` 和 `"a,b"`，
     解析器能分清
  2. **`src/storage/rateLimit.ts`（13 个用例）**: 每数据源的令牌桶。外部 IP 地理 API
     的免费额度是硬的（ip-api 每分钟 45 次），一次失控的补数能把自己锁到第二天。
     用例钉住三件事：突发额度发完就**必须等**（早一毫秒都不行）、补充速率与时间成正比、
     补充不会超过容量上限。这里有个反直觉的点：**桶是满着起步的**，所以不先花掉令牌
     就永远观察不到补充
  3. **`src/web/errors/render.ts`（16 个用例）**: 错误页与 CSRF 页。CSRF 页承诺
     「可以重试」，并给出一个真正有用的按钮——三种状态三个去处（已登录→回原页面、
     匿名→/login、未初始化→/init）。此前它对所有人都指向 /init，等于告诉一个
     标签页过期了的登录用户「你的部署没了」
  4. **`src/web/plugins/loginRateLimit.ts`（12 个用例）**: 登录暴力破解锁定。
     计数必须**按账号**而不是全局（全局锁定就是拒绝服务而不是防御），
     锁定必须会过期（否则几次输错就把自己锁在门外）
  5. **`src/web/plugins/rangeCountRefresher.ts`（9 个用例）**: 缓存的
     `ip_ranges` 行数。策略才是要钉住的东西：**只在陈旧时重算**——每次都重算
     等于把那个要几秒的 `COUNT(*)` 又放回页面路径上，而缓存存在的意义正是避免它
  - RED 校验都做过并已还原：去掉 CSV 的引号加倍 → 转义用例报
    `expected '…,"say "h…' to contain '"say ""hi"""'`；让 `recordLoginSuccess`
    不再小写化邮箱 → 混合大小写的清除用例报 `expected true to be false`。
    **第二次 RED 一开始没咬合**——用例只用了全小写邮箱，看不出键不一致。
    补上混合大小写那一例之后才咬住：失败计数器用小写键存，
    清除时若不先小写化，一次成功登录会把旧计数留在原地，
    账号离一次没犯过的锁定只差一个错字
- **CI 补上数据库与浏览器两套测试（此前 CI 从未跑过它们）**: `.github/workflows/ci.yml`
  只有一个 `unit` job，跑 `npm run test:unit`。**集成测试和浏览器测试从来没在 CI 里
  执行过**——本地 1685 个用例，CI 每次都在跑到 821 个的时候崩在那 15 个需要数据库的
  文件上。也就是说上面那批浏览器测试进了仓库却不在 CI 里跑，等于没有守护；
  集成测试里那批元数据锁回归用例同样如此。
  新增 `database` job（`unit` job 补数据库的事见「Fixed」一节）：
  1. **MySQL 5.7 服务容器**——与生产同版本。新版本会让某条查询在这里过、在那里不过，
     而这套测试要考的元数据锁行为本身就是版本相关的
  2. **`MYSQL_ROOT_HOST: "%"`**——root 默认只许本机登录，而套件是从 runner 的
     网络栈连进来的
  3. **`NODE_ENV=test`**——关掉生产环境缺 `SESSION_SECRET` 的快速失败。
     初始化向导正是这些用例要测的东西，没有它向导根本到不了
  4. **`npx playwright install --with-deps chromium`**——npm 包不保证 runner 上
     就有浏览器二进制
- **覆盖率下限（`vitest.config.ts`）**: 之前覆盖率是「测了、报了个数、没人管」。
  现在 `coverage.thresholds` 把单元切片的数字钉成下限：statements 42 / branches 74 /
  functions 55 / lines 42。门槛按单元切片标定，因为那是 CI 把关的那一套
  （110 秒跑完，是最划算的一道闸）；全量套件是 87.72%，自然越线。
  注意门槛描述的是**单元切片**：比它小的切片（比如只跑 `test/integration`）会踩线，
  这是预期行为，不是回归。
  RED 校验：把 statements 门槛临时抬到 99 → 跑测试报
  `ERROR: Coverage for statements (0.76%) does not meet global threshold (99%)`
- **浏览器级测试铺开到营销页、仪表盘与地图**: 此前 e2e 套件只碰过 62 条路由里的
  6 条，全是 `/admin*`。营销页、仪表盘和世界地图**没有任何一个测试点过东西**——
  单元测试读脚本源码，集成测试查 HTML 里有没有那段标记，**两边都不执行页面上的
  一行 JavaScript**。于是「下拉框打不开」「标签页切不动」「地图画不出来」这三类
  故障全都过得去测试、却在浏览器里是坏的。现在起真实 chromium：
  1. **共用一套启动逻辑**（`test/helpers/e2e.ts`）。此前四个文件各抄了一份
     六十行的启动代码，而且已经漂移——有的先 DROP 固定库名（于是排在残留锁后面），
     有的忘了标记数据库已初始化（于是被初始化向导拦下每一次请求）。新 helper
     走 `createTestDb`，库名唯一，清理不需要排在任何残留锁后面；
     `startE2e` 还会拒绝不带 `ipquery_test_` 前缀的库名，配置写错也不会指到真数据上
  2. **账号菜单**（8 个用例）：`<details>` 菜单初始关闭、点开、再点收起、显示昵称、
     四个动作齐备、点进控制台、经带 CSRF 的 POST 注销后回到未登录态；
     匿名访客看到的是登录／注册链接
  3. **营销页交互**（7 个用例）：`/try` 的示例芯片填的是**各自**的地址（不是写死的
     同一个）并聚焦输入框；`/docs` 的代码块标签切换面板、写 `aria-selected`、可以切回去；
     脚本以 JavaScript 类型送达且页面无 `pageerror`
  4. **仪表盘与世界地图**（9 个用例）：hero 区显示最后一次查询的 IP 与状态、
     页面返回 200（这正是元数据锁那次故障的回归点）、侧栏显示会话里的邮箱；
     地图是内联 SVG，标记的 `cx`/`cy` 与等距圆柱投影算出来的位置一致、
     `aria-label` 里带着被查的 IP、查不到时给的是「未找到」提示而不是空画框
  - RED 校验都做过并已还原：把 `<details>` 换成 `<div>` → 三个开合用例失败；
    把档案链接指向不存在的路径 → 动作用例失败；
    把投影写死成 `(10,10)` → 标记用例报 `expected 10 to be close to 115.84`
- **IP 地图展示**: `/try` 的查询结果附带一张世界地图，标出该 IP 的位置。
  坐标字段其实早就在库里（`ip_ranges.latitude` / `longitude`）也早就在
  `LookupResult.location` 里，只是**从来没有被渲染过**——查得到经纬度，却看不到
  自己在哪。地图完全由服务端渲染成内联 SVG：
  1. **不引入地图库**。项目没有 Leaflet / Mapbox / MapLibre，也不打算为了
     一张图加一个几百 KB 的依赖。Natural Earth 110m 陆地轮廓被一次性投影成
     静态常量（`src/web/maps/land-path.ts`），运行时零依赖
  2. **不接外部瓦片服务**。瓦片服务器会拿到访客的 IP 地址，而这一页的全部
     意义就是「查一个 IP」——把访客的 IP 交给第三方是本末倒置，也需要放宽 CSP
  3. **不用内联脚本**。CSP 是 `script-src 'self'`，客户端地图库无论如何都要
     外链一个 .js；服务端出图让页面保持零脚本
  4. **等距圆柱投影**：经纬两个轴都是线性的，标记位置可以用纯算术算出来，
     不需要投影库反解。墨卡托投影的 y 项非线性，且在两极发散
  5. **伪多边形被剔除**：Natural Earth 数据里有两个跨日期变更线的退化环
     （宽 360 度、高不到 1 度），投影后是两条横贯地图的假线。它们的
     长宽比是 490 与 363，而下一个最狭长的真实环是 16——阈值就落在
     这个断层里（见生成脚本 `MAX_ASPECT_RATIO`）
  6. 坐标同时以可读文本给出（`35.68°N`、`139.65°E`），并带数据来源标签
- **国家/地区名称**: 新增 ISO 3166-1 alpha-2 国家/地区名表（`src/country-names.ts`，
  249 项，中英文各一套），并接入查询核心、Web 试查页与用户仪表盘。
  修掉一个此前一直存在但没人注意的问题：`ip_ranges.country_name` **全表为 NULL**——
  DB-IP 的免费 CSV 只有国家代码没有国名（city-lite 的列是
  `start,end,continent,country,region,city,lat,lon`），而唯一带国名列的 MaxMind
  从未进过 ETL 流水线（它需要一份本项目没有的 license key）。于是香港的地址
  只能回答 `HK`，标题还写着「国家」——把一个地区说成了国家。
  1. **API 不再返回 `"name": null`**。`GET /lookup` 与 MCP 的 `ipquery_lookup`
     现在对 HK 返回 `"name": "Hong Kong"`
  2. **界面按语言显示**。中文访客看到「香港」，英文访客看到「Hong Kong」，
     代码 `HK` 一并保留
  3. **香港、澳门、台湾各有自己的代码**（HK / MO / TW），按自己的名字显示，
     不并入中国
  4. **标签改为「国家/地区」**（英文 `Country/Region`），出现在试查页、首页示例、
     仪表盘最近查询与后台的探测／回填明细里
  5. 未知代码（如 ETL 用的 `ZZ`）仍回落为代码本身——给不认识的代码编一个名字，
     比承认不知道更糟
- **MCP 服务**: stdio 传输的 Model Context Protocol 服务器（`npm run mcp`），7 个只读工具
  （`ipquery_lookup`、`ipquery_stats`、`ipquery_queue_stats`、`ipquery_etl_status`、
  `ipquery_queue_top`、`ipquery_queries_recent`、`ipquery_queries_daily`），
  供 AI 工具接入。查询日志默认脱敏，需显式传 `includePrivate: true` 才显示邮箱与
  API Key 前缀。见 `docs/mcp.md`
  - **端到端测试**：此前只测了工具的 handler，**协议层完全没测**——而协议层正是
    AI 客户端唯一看得见的那一层。现新增 `test/integration/mcp-e2e.test.ts`：起真实的
    子进程，用 SDK 自带的 Client 走完整 MCP 协议，验证握手与 server 版本、
    tools/list 的工具清单与 schema、tools/call 的结果形状、**未命中不算错误而无效 IP
    算错误**这条语义差异、未知工具名会列出可用工具，以及 stdout 保持干净
    （stdout 归 JSON-RPC 所有，一行 console.log 就能让客户端解析失败）
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
  右侧亮色工作表（下划线输入、38rem 行宽）；新增 `src/web/assets/css/setup.css`。
  向导字体（Plus Jakarta Sans / JetBrains Mono）来自 Google Fonts，CSP 头对 `/setup*`
  路由单独放行 `fonts.googleapis.com`/`fonts.gstatic.com`（meta 标签只能收紧、
  不能放宽 header 里已有的策略，例外必须写在响应头上），其余界面保持纯同源
- **全新安装自举**: 空库（一张表都没有）时 `buildServer()` 直接崩——`setupGuard` 的
  `isInitialized` 与若干插件的 `getSetting` 读不存在的 `settings` 表即抛 `ER_NO_SUCH_TABLE`，
  操作员永远到不了能建表的向导。现 `getSetting`/`isInitialized` 把 1146 分别按
  null／未初始化处理（其余数据库错误照旧上抛：断连不能伪装成默认配置），
  且 `buildServer()` 在向导守卫之前跑一次幂等 `runMigrations`，首个请求即落在可用安装上。
  新增 `test/integration/setup-fresh-boot.test.ts` 固化该路径
- **CI**: GitHub Actions 工作流（Node 20），ESLint + Prettier 接入 `npm run lint`
- **每 IP 探测审计**: `random_probe_log` 记录每次 Provider 扇出的完整响应，
  管理界面可按批次回看，见 migration 018
- **Provider 分钟级调用计数**: `provider_call_counter_minute` 按 UTC 分钟分桶，
  让熔断窗口真正以分钟计（见 migration 024 与下方「Provider 熔断窗口粒度」）。
  滚动发布时新代码可能先于迁移上线：分钟表缺失时写入降级为告警、读取自动回退
  日表，熔断仍按日表生效（已由测试固化，不会因「读到的 0」而静默失效）
- **IP 段导入导出补齐后台任务的其余部分**: 导入与导出已改为后台任务（见
  「Fixed」一节的前一条），这里记的是随之补上的三件事：
  1. **进度可看**: 新增 `GET /admin/ranges/imports/:id/progress`。整库导入要跑几小时，
     页面此前只在加载那一刻显示一次进度，操作员只好反复刷新。页面现在每 2 秒
     轮询这个端点，进度条在页面上自己走；任务结束后端点答 204，脚本随即停止轮询
     ——一个已经结束的任务没有进度可报，一直问下去只是白问数据库。端点带
     独立的限流（120 次/分钟），一个标签页绰绰有余
  2. **没人回来的上传会被清掉**: 上传途中关掉标签页、笔记本睡过去、传输断在半路，
     都会留下一个永远不会被导入的上传——里面是磁盘上最多两个 GB 的文件。
     新增 `purgeAbandonedUploads`（`src/storage/rangeUpload.ts`）与
     `src/web/plugins/uploadSweeper.ts`：上传开始满 48 小时仍是 `uploading` 状态的，
     连行带文件一并清掉（`ready` 的不动——它还在等着被导入）。清理按 6 小时一轮，
     服务降级（没有数据库）时跳过，失败只记日志不外泄
  3. **文件大小上限写在页面上**: 代码里表单上限是 512 MB、分片上传上限是 3 GB，
     而提示语里写的是「16 MB」，三者对不上，且都没出现在页面上——操作员只能靠
     失败才知道自己的文件多大。现在两个上限都印在表单旁，超限时提示语也带上
     真实数字

- **MCP 工具扩到 13 个**: 此前 7 个只读工具只覆盖了「查一个 IP」和「看最近的
  队列／查询日志」，一个运维真正会问的问题——**「昨晚那次 ETL 跑成功了吗？
  这个实例一共跑过多少回？」**——在 MCP 里没有答案，因为管理界面的数据在
  HTTP 那一侧。现补齐 6 个：
  1. **`ipquery_etl_sources`**：逐源 ETL 贡献（各源产出／跳过／入库／重复行数 +
     下载结果）。此前 `ipquery_etl_status` 的 `sources` 里只有 DB-IP 一个非空
     计数器——run 行本身只带这一个合并计数器，其余文件按文件记在 stage 表里，
     没有任何工具能读到。「国内网段是哪来的、出了多少行」问的就是那三张表
  2. **`ipquery_etl_history`**：ETL 运行历史（最新在前），失败的那次带
     `errorMessage`。`ipquery_etl_status` 只看最近一次 run
  3. **`ipquery_provider_health`**：回填扇出所用 provider 的健康度（调用量、
     429 与其它错误的占比）+ 熔断阈值。健康数字不和阈值一起看是没有意义的：
     50% 失败在 100% 阈值下依然算健康
  4. **`ipquery_audit_log`**：管理操作审计日志（谁、做了什么、对谁、从哪来），
     带操作者邮箱——所以属于 ops 数据，`lookup` 范围的 token 读不到
  5. **`ipquery_range_jobs`**：网段导入／导出任务状态（进度、行数、体积、失败
     原因）。整库导入要跑几个小时、整库导出要写两个多 G，两者都是脱离请求
     后台跑的，状态写在 `range_imports` / `range_exports` 两张表里，重启之后还在
  6. **`ipquery_lookup_batch`**：一次查多个地址（最多 100 个）。`ipquery_lookup`
     一次一个，HTTP 下三个地址还能忍，MCP 下每个调用都是一次往返——批量对账
     客户流量来源、检查一批可疑地址，都不该一个一个来。单个地址格式错误或
     未收录**不会让整批失败**：坏的那个被标记，其余照常返回
  - **权限范围**：批量查询与单条查询是同一件事，不暴露任何运维数据，因此同属
    `lookup` 范围；其余 5 个属 `ops`
  - **加一个工具要改三处**，漏一处是静默漏洞而不是报错：`tool-names.ts` 的
    `TOOL_NAMES`、`auth.ts` 的 scope 列表、`server-tools.ts` 的注册表
  - **文档里的工具总数由测试守着**：`test/unit/mcp-docs-tool-count.test.ts`
    把五份文档里的数字与 `TOOL_NAMES.length` 对齐——手写的数字会让构建失败，
    而不是把文档悄悄写错
- **死数据源清理**: ip2region 与 MaxMind 的解析器此前躺在仓库里，**没有任何
  下载规格喂它们、没有任何流水线步骤读它们**，但它们养着一整套对外声明：
  首页、营销页 meta、README、NOTICE、后台设置页、启动横幅、`.env.example`
  都在说「聚合 MaxMind、ip2region 与 DB-IP，一个查询，三个来源」。查线上
  `ip_ranges.country_source` 得到的只有 `dbip` 与 `dbip-country`——**没有一行
  来自 MaxMind，没有一行来自 ip2region**。声明是一张欠条，而没有任何东西会
  因为它变成假而失败。现在：
  1. 解析器与两个 fixture 文件删除
  2. **数据源清单改为从流水线自己的文件表派生**（`src/etl/sources/labels.ts`），
     把源加进流水线而不加进标签表，测试会失败
  3. 首页的「N 个数据源」改为派生值：**4**（DB-IP / metowolf / runishiwo /
     sapics）——流水线取 7 个文件，来自 4 个地方。说「七个数据源」读起来像
     七个独立提供方
  4. `IpinfoProvider` 一并删除：migration 031 已把 ipinfo.io 从扇出里退役，
     类还导出着，但永远不会被实例化
  5. 守卫测试防止回潮：营销页、README/NOTICE/docs、后台设置页、config 与
     两份 `.env.example` 各有一道

- **右上角账号菜单**: 首页右上角的「控制台」入口改成**用户名**——显示昵称
  （没有昵称则退回邮箱）加首字母头像，点开是一份下拉菜单：个人中心、档案、
  更改密码、注销。此前那是一个指向 `/dashboard` 的裸链接，用户想改昵称或
  改密码只能先进控制台再自己找入口，而控制台里根本没有改密码的地方。
  1. **用 `<details>` 而不是 JS 下拉**: CSP 是 `script-src 'self'`，内联脚本
     一律被拦；`<details>/<summary>` 是纯 HTML，键盘与屏幕阅读器都默认可用，
     零脚本也能开合
  2. **菜单项分三个目的地**: 「档案」与「更改密码」指向新增的
     `/dashboard/profile/details` 与 `/dashboard/profile/password` 两页，
     `/dashboard/profile` 降级为账号概览页。一个菜单里三个入口若都指向同一个
     长表单，那这个菜单的每一项看起来都像点错了
  3. **改完密码踢掉其它设备**: 与「忘记密码／重置密码」的姿态一致——保留
     当前会话（用户正在自己的浏览器里操作，把它踢掉是敌意行为），其余设备
     全部失效
  4. **注销走 POST + CSRF**: 菜单里的注销是一个带 `csrf` 隐藏字段的表单，
     不是 `GET /logout` 链接——登出是状态变更，GET 会被预取器、爬虫和
     浏览器预加载悄悄触发
  5. **不谎称自己是 ARIA 菜单**: 菜单一开始带 `role="menu"` 与
     `role="menuitem"`——而 ARIA 的 menu 部件要求作者用方向键在条目间
     移动焦点。这份模板没有任何按键处理器（CSP 是 `script-src 'self'`，
     也没有对应的控制器），于是屏幕阅读器用户被告知「这是一个菜单」、
     按下方向键、什么也没发生——承诺的交互并不存在。现去掉这两个 role：
     一个 `<details>` 里的链接列表不需要 role，而且保留了浏览器原生的
     Tab 导航——键盘用户对一份链接列表期待的本来也就是它

- **HTTP API 批量查询**: 新增 `POST /lookup/batch`，一次最多查 100 个地址。
  MCP 早已有 `ipquery_lookup_batch`，但 HTTP 侧一直没有等价物——一个拿日志
  文件、CDN 源站列表或滥用报告做对账的调用方，只能一个地址一次往返。
  1. **用 POST 而不是 GET**：一百个地址塞不进 URL，而 URL 会一路落在访问日志
     和代理日志里；请求体不会
  2. **批量整体不失败**：一个畸形地址不吞掉其余九十九个答案，它被标记出来，
     其余照常返回。对账场景里，一行坏数据不该赔上整个文件
  3. **顺序即请求顺序**：调用方要能把答案和自己的行对上行
  4. **超限报错而非截断**：截断后的答案看起来像全部答案，照着它对账会安静地
     漏掉被丢掉的那部分
  5. 与 MCP 工具**共用同一份核心逻辑**（`src/lookup-core.ts` 的
     `doLookupBatchCore`），两边的顺序、标记、计数完全一致。同一份答案有两个
     实现，客户端就会拿到关于同一个地址的两个说法
  6. 批量查询在查询日志里**每个地址一行**——查询日志的职责是「哪些地址被查过」，
     一百个地址记一行会把流量少算一百倍
  7. 新端点已加入公开 API 的限流名单（`PUBLIC_API_PATHS`）：限流名单是精确
     匹配集合，新公开端点若不登记就是**不限流**的，而这个一次能问出 100 个
     地址，不限流恰恰是最不该的结果

### Changed

- **后台界面深度优化**: 后台控制台从「能用」向「好用」推进一批改动。
  改动集中在三处：
  1. **侧栏重新分组**: 原来 10 个入口平铺在一个列表里，现按「概览 / 数据 / 流量 /
     治理」分成 4 组，每组带一个内联 SVG 图标（16px、`currentColor`、无 emoji）。
     激活态由圆点改为左侧 2px 竖条（rail），子页面（如 `/admin/users/1`）现在
     会让所属入口保持高亮——此前用的是精确匹配，进二级页就灭了。
     `/admin/audit` 与 `/admin/audit-log` 前缀相同，两者同时亮起，现改为精确匹配
  2. **表头排序可用**: 表头的排序链接此前**会丢掉当前筛选参数**（筛完再点表头，
     筛选被清空）。现由路由层用 `buildSortColumns`（`src/web/admin/sortColumns.ts`）
     预计算链接，链接形如 `?role=admin&page=1&sort=-id`。排序方向以箭头指示，
     当前列在 `<th>` 上带 `aria-sort="ascending|descending"`，未排序列显示淡色 `↑↓`
  3. **查询日志页补上统计**: `/admin/queries` 现在有三张状态卡（命中／未命中／
     无效）与一条按比例分段的结果分布条。分布条是纯 CSS 的 flex 分段，
     无图表库、无 canvas、无脚本；计数经 helper 归零保护，负数与 NaN 不会
     产出负宽度
- **反向代理下的限流（`TRUST_PROXY`）**: 限流按 `req.ip` 计数，而 `req.ip` 默认是
  连接的对端地址 —— 走反代时那是 `127.0.0.1`，**所有访客挤进同一个桶**，一个访客
  就能把所有人的额度用光（60 次/分钟是全体共享的）。新增 `TRUST_PROXY` 环境变量
  （默认 `false`），打开后 `req.ip` 取自 `X-Forwarded-For`，每个访客各自计数。
  前提是 Node 端口只有反代能访问 —— 那个头是访客可以自己构造的，能直连就能
  伪造它、挑一个自己的限流桶。反代那边必须**覆盖**转发
  （`proxy_set_header X-Forwarded-For $remote_addr;`）而不是追加
  （`$proxy_add_x_forwarded_for`）：追加会把访客伪造的头留在最左边，而 `trustProxy`
  读的正是最左边那一项。开关状态显示在 `/admin/settings` 顶部指标条上
- **ETL 守卫测试不再依赖网络**: `etl-guards.test.ts` 只写了 city 一个 fixture，
  而 ETL 现在会按份判断缓存、缺失即重下——于是这个测试会真的去下载约 93 MB 的
  DB-IP 数据并插入约 120 万行，撑爆 90s 超时，还留下「运行中」的 ETL 行连累
  同文件其余用例。现补齐 country／asn fixture 并用 `runPipeline` 的下载缝
  替换下载阶段，测试不再碰网络
- `/admin/unknown-ips` 更名为 `/admin/ingest`（旧路径保留重定向）；`/admin/providers`
  成为 Provider 管理的统一入口
- 管理界面内联脚本外提为独立文件，以符合 CSP
- 移除 Docker 部署（改用 Makefile + 原生 Node）
- 测试脚本拆分：`test:unit` / `test:integration` / `test:e2e`
- **部署文档补实测数据**: `docs/setup.md` 新增「ETL 全量导入的实测开销」与
  「源文件完整性校验」两节，并按实测值更新部署清单（`ip_ranges` 约 3.0 GB / 815 万行、
  全量 ETL 约 21 分钟、原始 CSV.gz 约 93 MB、数据盘 >= 20 GB、内存 >= 2 GB）

### Fixed

- **控制台把「刚刚创建的用户」显示成「大约 8 小时后」**: CI 修好之后，`database` job
  只剩一个用例红着：`public vs authed chrome > writes relative timestamps in the
  reader's language`。它指向的是一个真的、用户看得见的缺陷。
  根因是**驱动和服务器各说各话**：
  - MySQL 用 `DEFAULT CURRENT_TIMESTAMP` / `NOW()` 打的时间戳，用的是**服务器自己
    那口钟**（本机 `@@global.time_zone` = `SYSTEM` = 中国标准时间，+08:00）
  - 连接池写的是 `timezone: "Z"`，也就是**按 UTC 解读**驱动发回来的字面量
  - 两者一叠加：**每一个由 MySQL 写入的时间戳，读出来都往未来偏 8 小时**
  - 于是刚建好的用户在控制台上是「大约 8 小时后」，query_log 的「最近 24 小时」
    实际是 32 小时，后台的日期筛选也跟着偏 8 小时
  - `timezone` 是**纯客户端**设置：它只告诉驱动「怎么解读字面量」「怎么把 Date
    参数序列化出去」，**从不发 `SET time_zone`**——服务器那口钟仍然是 SYSTEM
  修法是让**读的那一侧跟上服务器**：池子改成 `timezone: "local"`（服务器用哪口钟，
  进程就跑在哪台机器上，两边一致），三处 `UTC_TIMESTAMP(3)` 的比较改成 `NOW(3)`，
  `formatDate` 按本机壁钟渲染。改完之后**控制台上的数字一个都没变**，
  变的是相对时间和那个 24 小时窗口
  - `sessions.expires_at` 这类**应用自己写的**时间戳也一起归位：驱动现在按服务器
    那口钟序列化 `Date` 参数，于是迁移 `036_server_clock_timestamps.sql` 把已有的
    15 个应用写入列整体前移「服务器与 UTC 的偏移」。偏移取自
    `@@global.time_zone`（不是 session，所以与连接落在哪个时区无关），
    在 UTC 机器上是 0，什么都不改
  - ETL 的五个阶段表（`etl_run_downloads` / `parses` / `inserts` / `swaps` /
    `dedupe`）也在名单里：流水线**读回自己写的 `started_at` 去和 `NOW(3)` 比**，
    跨两口钟算出来的阶段耗时是错的
  - 导出 CSV 的时间戳一并改口径：以前用 `toISOString()`，等于把壁钟谎称成 UTC；
    现在按 `formatDbTimestamp()` 打印**壁钟数字 + 真实偏移**
    （`2026-11-24T01:16:05.193+08:00`），和页面上的时间对得上
  - 新增 `test/integration/timestamps.test.ts`（6 个用例）与
    `test/unit/db-timestamp.test.ts`（8 个用例）：断言不点名任何偏移，
    在 UTC 机器和 +08 机器上都成立
- **日桶的日期标签偏一天**（`countQueriesByDay`）: 改口径这件事本身带出了两个
  只在「时区不是 0」的机器上才看得见的洞
  - **`DATE` 列读回来会变成本地零点**: 驱动把 `DATE '2026-11-23'` 解析成一个
    **本地午夜**的 `Date`，于是 `.toISOString().slice(0,10)` 把它印成
    `2026-11-22`——**标签整整差一天**。后果是仪表盘七天柱状图的**最后一根永远是空的**，
    今天的查询被记到昨天头上，而 `queries_daily` 这个 MCP 工具同样
    修法是**日标签在 SQL 里就算好、以文本返回**（`DATE_FORMAT(..., '%Y-%m-%d')`），
    驱动根本没机会碰它
  - **七天窗口用错了日历**: `provider_call_counter.day_utc` 存的是 **UTC 日期**
    （写入方是 `UTC_DATE()`），而七天窗口的下界却拿 `CURDATE()`（**服务器本地日期**）
    去比。两者每二十四小时里有八小时不是同一天：这段时间里窗口**短了一天**
    （够不到该够的那天），或者**宽了一天**（多算了一天）。
    改成 `UTC_DATE()`，和列自己的口径对齐
  - 两个用例都用**显式设置会话时区**的方式让「本地日 ≠ UTC 日」必然成立
    （`SET time_zone`），所以在任何时区的机器上都真的能咬住这个 bug，
    而不是「本地日恰好等于 UTC 日时恒绿」
  - MySQL 5.7 只接受**整点、且在 -12:00..+13:00 之间**的偏移量：
    `+14:00`、`-13:00`、`+13:59` 一律报 `Unknown or incorrect time zone`
- **`sidebar` 用例把「坏行为」写进了断言**: 那条用例断言英文页面出现
  `in about 8 hours`——那是 date-fns 描述**未来**时间的说法，而一个刚创建的用户
  本该是**过去**（`less than a minute ago`）。也就是说这条用例在 +08 机器上恒真、
  在正确的 UTC 机器上恒假：它把当时那个 bug 的样子固化成了期望。
  断言改成「必须是过去式、且不得出现未来式」，两种机器上都成立，
  而且**现在真的能抓住偏移**
- **迁移版本号撞车，两个文件共用 `035`**: runner 的账本以**文件名的数字前缀**为键
  （`schema_migrations.version` 是主键），而 `035_fix_single_address_ranges.sql`
  已经占了 `035`。新迁移再叫 `035` 就有两种结局：
  - 全新库上：账本插入报 `Duplicate entry '035' for key 'PRIMARY'`，
    **报错信息既不点名文件，也不说这是版本号冲突**
  - 已经跑过 `035` 的库上：**更糟**——runner 看到账本里有 `035`，把**两个文件一起
    跳过**，第二个迁移**永远不会执行**，而且没有任何提示
  现在 runner 在碰数据库**之前**就检查前缀是否重复，冲突时抛出点名版本和两个
  文件的错误（错误不带驱动 `code`，所以启动路径不会把它误判成「数据库连不上」
  而降级成向导）；新迁移改号 `036`。新增 `test/unit/migration-version-collision.test.ts`
  （4 个用例）钉住「先拒绝、再碰库」

- **CI 从来没有绿过一次**: 查了 `gh run list` 的全部 51 条记录——
  **50 条 failure，0 条 success**，从 2026-11-10 工作流第一次跑就是这样。
  根因不在测试本身，在 workflow 里：`unit` job 没有数据库服务，而
  `test/unit/` 里有 **15 个文件**是要连真库的（它们各自建一个临时库来测存储层：
  IP 段导入/导出/替换/去重、schema 报告与漂移、provider 计数器、审计写入）。
  这些文件在 `beforeAll` 里 `createConnection`，连不上就是
  `ECONNREFUSED 127.0.0.1:3306`——**整个文件在 setup 阶段就挂了**，
  0 个用例失败、15 个文件失败，看日志像是环境问题而不是代码问题。
  实际影响：本地 1685 个用例里，CI 一直只跑到 821 个（而且是在挂掉之前），
  浏览器测试、集成测试、元数据锁回归用例**一次都没在 CI 里执行过**。
  修法：`unit` job 加上 MySQL 5.7 服务容器与 `DB_*` 环境变量。
  （顺带一提：`test/unit` 这个目录名并不等于「不需要数据库」——
  这 15 个文件是存储层的单元测试，只是恰好需要库。）
- **CI 的覆盖率产物从来没被生成过**: `.github/workflows/ci.yml` 里有一个
  `Upload coverage` 步骤，指向 `coverage/` 目录；但上面的 `Unit tests` 步骤跑的是
  `npm run test:unit`——**不带 `--coverage`**，于是 `coverage/` 根本不存在，
  上传步骤什么也没传（`upload-artifact` 对空目录只警告不报错，所以 CI 一直是绿的，
  产物一直是空的）。现在这一步改跑 `npm run test:coverage`，
  `coverage/` 里真的有东西了
- **读路径被元数据锁堵死，整站挂起**: 2026-11-23 那天 `/lookup`、`/dashboard`、
  `/stats` 全部卡住。根因不在数据库慢，而是一条 SQL 把 `ip_ranges` 拖进了语句里：
  `getLastUserQuery` 原本用 `LEFT JOIN ip_ranges` 把「最后一次查询」和它的国家/ASN
  一次查出来。`LEFT JOIN` 让语句需要 `ip_ranges` 的元数据锁；一旦有 `RENAME TABLE`
  挂起（ETL 换表），**所有**后到的请求——包括只需要读锁的普通 SELECT——都排在它后面。
  而 MySQL 的 `lock_wait_timeout` 默认是 **31,536,000 秒（一年）**，所以它们会一直等下去。
  拆成两次查询：行（IP、状态、时间）从 `query_log` 直接读，地理信息再单独查、
  单独失败。这样国家名只是「装饰」，装饰没了页面还在。
  - **读也有超时**: 池里每条连接在建连时就 `SET SESSION lock_wait_timeout = 10`。
    之前只有换表那侧设了 30 s，读的一侧完全没有上限——于是一个锁可以把整站
    拖死一年。选 `lock_wait_timeout` 而不是 `innodb_lock_wait_timeout`，因为
    前者管元数据锁，后者管行锁
  - **可选读另有更短的界**: `getLastUserQuery` 的地理信息走 `findRange` 的
    `metadataLockWaitSeconds` 参数，只等 2 s。装饰不值得让页面等十秒
  - **失败是可重试的 503**: 元数据锁超时现在被识别出来，标成
    `statusCode=503` + `code=service_unavailable`。对外只回
    `{"error":"service_unavailable"}`，**不泄露内部原因**（表名、锁、ETL 一概不出现在
    响应体里）；内部原因仍然进日志。503 语义正确：服务没坏，是依赖暂时不可用
  - **实测对比**（对着真实的生产锁，同一份代码两个实例）:
    `/dashboard` 从 **500 / 10.02 s** 变成 **200 / 0.06 s**；`/lookup` 仍是
    **503 / 10.0 s**，但从「挂死」变成了「有界的、语义正确的失败」
- **迁移清单有两份，其中一份是死代码且已经漂移**: `src/storage/migrations/runner.ts`
  同时内联了一份 `MIGRATION_SQL`（约 2,000 行 SQL，逐条抄自 `.sql` 文件）和一份
  `MIGRATION_FILES` 文件名清单。但 `loadMigrationManifest()` 在导入时就会
  `MIGRATION_SQL.clear()` 再用磁盘上的文件重填——**内联那份从模块被 import 的那一
  刻起就是死的**。它注释里声称的用途（"只发布 `dist/` 的发布包仍能知道 SQL"）
  也不可能成立：目录读不到时产出的是**空**清单，不是内联那份。
  代价不是零——**它已经漂移了**：内联 map 有 33 条，磁盘上有 34 个 `.sql`，
  最新的 `035_fix_single_address_ranges.sql` 登记了文件名却从没进过内联 map。
  没人发现，因为没人读它。现删除这两份内联副本，磁盘上的 `.sql` 文件是唯一
  事实来源（`scripts/copy-schema.js` 会把它们复制进 `dist/storage/migrations/`，
  runner 从 `__dirname` 读）。
- **schema 报告的竞态**: `listMigrationEntries()` 原本是**同步**的，直接读模块
  变量；`getSchemaReport()` 是 async 却同步调用它。于是模块加载时那次
  `readdir` 尚未落定的窗口内，报告会说「没有任何迁移」——对一个落后三十步的
  数据库来说，这句话读起来就是「你已是最新」。现 `listMigrationEntries()` 改为
  `async` 并 `await manifestReady`；`getSchemaReport` 先 await 清单再推导
  结构参考，两者读的是同一份已落定的清单。
- **e2e 套件从未真正跑通过**: `test/e2e/full-flow.test.ts` 的 `beforeAll` 直接调
  `runPipeline({ cfg })`，走的是**真实下载阶段**——拉真正的 DB-IP city-lite
  文件（81.7 MB / 7,777,815 行）。于是这个测试需要 65 s 下载 + 73 s 解析 +
  约 5 分钟插入，`beforeAll` 钩子撑爆 180 s 超时，整份文件被判为失败。
  更糟的是，**它自己写的那份一行 fixture 从来没被用过**——下载阶段会把它
  覆盖成真文件。这个「端到端测试」实际上是一次穿着测试外衣的生产 ETL：
  又慢、又依赖网络、又依赖机器能连上 GitHub。
  现改用 `runPipeline` 的 `download` 注入点，测试自己写出全部 7 个源文件
  （gzip 的那几个是真 gzip，并写 `.month` sidecar 让下载阶段按「已是最新」
  记录），**被测的仍然是完整的真实流水线**：下载 → 解析 → 插入 → 换表 →
  对外提供查询，只有字节来自本地磁盘。
  - 同一个 hook 现在 **5 秒**跑完，e2e 套件 4 个文件 18 个测试全绿
    （铺开浏览器测试后是 7 个文件 42 个测试）
  - RED 校验：把 8.8.8.8 从三份 DB-IP fixture 里去掉后，`/lookup` 返回
    404（`{"error":"not_found"}`），断言失败——测试确实在检验它声称的东西
  - 修的是**测试**，不是产品：流水线本身没有毛病
- **集成套件里的保留测试同样在跑一次生产 ETL**: `test/integration/seed-and-preserve.test.ts`
  的 `runOffline()` 只注入了 `downloadFixed` 那个注入点——它只覆盖四个 GitHub
  托管的固定源。**三份 DB-IP 月度文件走的是普通下载阶段**，于是「with no network」
  这句注释是假的：测试真的去下载了 81.7 MB 的 city 文件，解析 7,777,815 行，
  再插入约五分钟——**远超 180 s 的钩子超时**。
  后果不止一个测试失败：超时的钩子**把 ETL 运行锁留在了持有状态**，于是紧接着
  的三个测试拿到 `EtlRunLockedError: an ETL run is already in progress`——
  一次超时伪装成六个独立失败。
  现改用同一个 `download` 注入点（`test/e2e/full-flow.test.ts` 用的就是它）：
  测试自己写出**全部七个**源文件（三份 DB-IP 是真 gzip + `.month` sidecar，
  四个 GitHub 源是文本 fixture），流水线因此完全离线。
  - 关键是**注入点替换的是整个下载阶段**，包括真实阶段内部的固定源刷新。
    只写三份 DB-IP 文件会让四个 GitHub 文件缺失，流水线会拒绝换表并报
    `source files unavailable after download` —— 这是集成套件跑出来的，
    单跑该文件当时反而是绿的（目录里还留着上一轮的产物）。
    七个文件必须由**同一个**注入点写出
  - 同一份文件现在 **3 秒**跑完，14 个测试全绿（此前：180 s 超时 + 5 个连锁失败）
  - RED 校验：把 country fixture 的国家从 GB 改成 FR，5 个断言失败；漏写
    `china-ipv4.txt`，5 个断言报「source files unavailable」——注入点确实在
    喂数据，不是摆设
  - 修的是**测试**，不是产品
- **`init-fresh-boot` 的清理会把「连接已死」报成「测试失败」**: 该文件的
  `afterAll` 直接 `rootConn.query(DROP DATABASE)`，而这条语句不在任何 try 里。
  于是连接在空转期间断掉时，抛出的是 `ECONNRESET`——**报错指向 DROP，
  真正的问题却是上一条 `SET SESSION lock_wait_timeout`**（连接早就死了，
  这条语句是第一个碰到它的地方）。上一次全量覆盖率运行里，1598 个断言全过，
  唯一的失败就是这一个清理步骤。
  现把整个清理（设置超时 + DROP）放进同一个 try，并给 DROP 一个 5 秒的
  元数据锁上界：清理拿不到锁就快速失败并留下一个惰性的孤儿库，而不是
  把整轮测试挂在 MySQL 的一年默认超时上。
- **DB-IP 月度文件下载一次后永不更新**: 决定「复用缓存」的唯一依据是
  `validateGzFile()`（gzip 完整），而这个条件**永远成立**——所以首次下载成功后，
  库就冻结在那个月份，之后每次运行都记 `skipped` 并报成功。线上证据：run 3 下载了
  city（85,713,797 字节）后，run 4 三个文件全 `skipped` 却 `success`。现在每个
  DB-IP 文件旁边有 `<文件名>.month` 记录它属于哪个月，并与 DB-IP **实际发布的最新
  月份**（HEAD 探测，因为当月文件要到月中才出现）比较；不一致才重下。实测：首轮
  下载 81.7 MB 后写入 `2026-11`，第二轮三个文件全部 `reused`，不再重复拉 82 MB。
- **DB-IP 下载是「整请求 120 秒」硬上限**: city-lite 有 82 MB，实测链路 1.29 MB/s
  理论就要 66 秒，余量不够——2026-11-16 那次 run 5 就是死在这，还在磁盘上留下一个
  2 MB 的截断 `dbip.csv.gz`。现在改为**空闲超时**（连续 120 秒无数据才断），慢但
  在动的传输不再被打断；实测 81.7 MB 用了 451 秒正常完成。
- **月度文件写入不是原子的**: 旧代码直接往正式路径流式写，超时即留下半截文件。
  现在走「临时文件 → 校验 gzip → 原子替换」，失败保留旧缓存（固定源早就是这个做法）。
  本机那个截断文件也已在验证后删除，下次 ETL 会重新下载。
- **回填队列被 IPv6 全量段永久堵死**: `nextBatch()` 用 `q.ip < end_ip` 判断「已被
  `ip_ranges` 覆盖」。DB-IP 的 IPv6 数据里有一行 `::` – `1fff:…:f`，按字节比较它
  **包含全部 IPv4 地址**，于是每个排队中的 IPv4 都被判为「已覆盖」，回填批次永远
  为空——`/lookup` 未命中的 IP 只进不出。线上实测：向 `unknown_ip_queue` 写入
  `8.8.8.8` / `203.0.113.200` / `45.33.32.156`，`nextBatch` 返回 0 条。现在比较
  改用**包含端点**的 `end_ip >= q.ip`（与 `findRange()` 一致），并只允许 IPv6 段
  覆盖 IPv6 候选。
- **回填写入的 /32 多占了一个地址**: `writeConsensusRange()` 写的是
  `end_ip = start_ip + 1`，而全表（DB-IP 段、示例数据、`.ipq` 导入）用的都是**包含
  端点**，`findRange()` 也按 `end_ip >= target` 判断。结果回填出 `203.0.113.7` 的
  答案后，**没人查过的 `203.0.113.8` 也返回同一个国家**；`range_size` 同时被写成
  `1`（其余单地址行都是 `0`）。现在写 `end_ip = start_ip`、`range_size = 0`，
  并用 migration 035 修正旧版本已写入的行。
- **调度表单一保存就把 3 分钟改成 30 秒**: 间隔下拉框写死 30/60/300/900/1800 秒，
  而迁移 030 的默认值是 **180 秒**。没有任何选项命中，浏览器于是提交第一个选项
  （30 秒）——打开页面直接点保存就把入库频率翻了三倍，页面上还看不出发生过什么。
  选项改为由 `RANDOM_GEN_INTERVAL_PRESETS` 渲染，并把「库里存的值」追加进列表
  以保证它始终可被选中；标签改由 `intervalLabel` helper 按秒/分计算，不再为每个
  取值维护一条 i18n 键。
- **「每批数量」保存 50 实际只跑 20**: `saveRandomGenConfig` 允许到 100，
  `loadRandomGenConfig` 只认 20。表单显示 50（因为页面读的是**存储值**），
  runner 实际处理 20——同一次运行有两套事实。现在两侧共用同一组
  `clampIntervalSec` / `clampBatchSize`，表单的 `max` 也渲染自代码常量。
- **迁移清单可能被读到旧值**: `loadMigrationManifest()` 是异步的，任何在它完成前
  发起的读取看到的是硬编码的回退清单——也就是「写这段代码时的文件列表」，不是
  「这次发布真正带上的文件」。后果很具体：新增的 migration 会被 `migrate` 跳过，
  被 `migrate:status` 报成 `applied`。现在所有异步入口都先 await 该 Promise。
- **页面上直接印出 i18n 键名**: `t()` 找不到键时返回键本身，于是这些页面把
  `verify.success`、`dashboard.keys.revoke.confirm.title`、`dashboard.mcp.revoke`、
  `admin.users.resetPassword.tempNotice` 当成文案显示。已补齐中英两本字典
  （`auth.verify.*`、`dashboard.keys.revoke.confirm.*`、`dashboard.mcp.revokeLabel`、
  `admin.users.resetPasswordResult.*`），并新增 `test/unit/i18n-view-keys.test.ts`：
  视图与路由里**字面引用**的每个键都必须在默认语言里存在。
- **API 不再说「这些数据来自 MaxMind」**: 上一条把营销页上的假声明清干净了，
  但 **JSON 接口里那句假话还在**——而且它出现在**唯一一个本该说实话的字段**上。
  `country.source` / `city.source` / `isp.source` / `asn.source` / `location.source`
  的作用就是「说明数据来自哪里」，而查不到来源的行一律回落到 `"maxmind"`。
  流水线从来没有抓取过 MaxMind，所以这些回落是纯粹的假声明。线上实际影响：
  **198,157 行** `country_source` 为空（连 `country_code` 也是空的）、
  **8,152,112 行** `isp_source` 为空。
  1. `Source` 类型去掉 `"maxmind"` 与 `"ipinfo"`（两者都不是流水线能产生的值），
     改为加上 `"unknown"`——**「不知道」是「哪里来的」这个问题的一个真实答案**
  2. 归一化放在**读的那一端**：`normalizeSource()` 把任何不认识的来源列
     归一为 `"unknown"`。此前 `findRange()` 用的是 `as Source` 的无检查类型断言，
     一行写着 `"maxmind"` 的历史数据会原样穿过断言——那个断言让类型成了谎言
  3. 试查页（`/try`）与 API 用同一套归一化；实测一条手工插入的无来源行，
     接口回答 `"source": "unknown"`，不再是 `"maxmind"`
  4. **但本项目自己写的三个标签不能被归一化掉**：`multi-provider`（未知 IP
     回填）、`import`（网段导入）、`seed`（演示数据）。它们不是流水线写的，
     却是「这一行是谁写的」的唯一记录——归一化成 `"unknown"` 等于把来源记录
     抹掉。其中 `multi-provider` 与 `import` 还正是 ETL 换表时要带过去的行，
     没有它们那条 SQL 就无从下手。`seed` 则相反：演示行本来就该被一次刷新
     替换掉，所以它**不在** `MANUAL_SOURCE_TAGS` 里，但读回来时仍要如实
     报出 `"seed"`
- **Provider 分钟级计数器的测试有时会自己失败**: `provider_call_counter_minute`
  的分钟桶来自**数据库自己的时钟**（`UTC_TIMESTAMP()`），逐次调用各算一次——
  所以一串调用跨过分钟边界就会被拆成两行，这是分钟表的正确行为。测试却断言
  「四行变一行」，于是在整点附近必挂一次（同一份代码连续两次跑，一次过一次挂）。
  生产代码的窗口查询本来就是**跨行求和**的，测试现在也照它那样求和。

- **后台筛选栏从来就没渲染对过**: `/admin/users`、`/admin/keys`、`/admin/audit-log`
  三个页面的筛选栏，每个 `<select>` 的 `name` 都是 `hash`（helper 的名字），
  标签是空的，选项列表也是空的——**这三页的筛选功能自上线起就没有生效过**，
  而且页面照常渲染，没有任何报错。根因是三个 Handlebars helper 的老毛病：
  1. **`hash` helper 返回的是 Handlebars 的 options 对象**，而不是调用方写的
     hash 参数。options 对象顶层就有 `name` 属性，值是 helper 自己的名字
     （"hash"），真正的参数埋在 `.hash` 里。于是 `{{name}}` 渲染成 "hash"，
     `{{label}}` 渲染成空。现改为 `(options) => options.hash ?? {}`
  2. **`array` helper 的参数切片判据错了**：它靠 `"fn" in last` 识别 Handlebars
     的 options 对象并切掉，但 `fn` 只有 block helper 的 options 才有——普通
     helper 的 options 只有 `hash`/`data`/`loc`。于是 options 对象没被切掉，
     混进了数组，当成一个多余的筛选项。判据改为识别 `hash`+`data`+`loc`
  3. **`max` helper 收到数组参数时返回 NaN**：`Number([3,0,0])` 是 NaN 而不是 3，
     于是每个与它的比较都是 false。这正是 `/admin/queries` 的 24 小时
     sparkline **一直是一条死线**的原因。现改为展开数组，并忽略非有限值
  新增 `test/unit/filter-bar.test.ts`（5 项）固化这三处：用**真实的** view
  plugin 渲染真实的 `filter-bar` partial，断言 select 的 name 是 `role` 而
  不是 `hash`、标签非空、选项齐全。测试在旧实现下会失败（已实测：4/5 失败）
- **结果面板的深色块留白**: `/try` 结果右侧的「用 curl 复现」只有一行命令，
  却因为网格默认拉伸而跟左侧数据区等高，于是一大块深色墨水悬在那里。
  现改为按自身高度排列（`align-self: start`）
- **种子数据导入完成后又回到种子页**: 操作员看着 15 分钟的 DB-IP 导入跑完，
  页面回到那三个选项（导入／演示／跳过），看起来像「什么都没发生」，
  于是又点了一次导入。三个缺陷叠在一起：
  1. **导入成功的运行没有前进路径**。GET 处理器只在「有运行在飞」时渲染进度面板，
     导入一结束页面就变回三选项表单。现导入成功后直接 302 跳到 `/init/complete?flash=success`，
     并写入 `seed.loaded=true`；成功面板另带 3 秒 `meta refresh`，
     已经打开的旧页面自己就走完这一步
  2. **`etl.setup.inProgress` 设置与运行行状态重复**。两个信号由**不同的代码路径**写入
     （向导起的后台任务 vs. ETL 流水线），可能各说各话；服务器在两者之间重启，
     设置就永远停在 `true`，把操作员困在一个几小时前就已结束的运行进度面板上。
     现该标志彻底删除，`etl_runs.status` 是唯一真相——信号写在干活的地方，就不会漂移
  3. **失败的运行永远停在 `running`**。下载阶段抛错、或进程被杀时，
     流水线来不及标记失败，运行行一直是 `running`：操作员看着一个永远转不完的进度圈，
     既不能重试也看不到原因。现后台任务的 catch 分支把该行补记为 `failed` 并写入错误信息，
     种子页随即给出重试入口
- **向导第 2 步进不去**: 「环境配置」这一步点「生成并继续」后页面原样返回，没有前进路径。
  三个缺陷叠加：
  1. 处理器在 `.env` 里的端口与进程启动端口不同时**重新渲染本页**，于是向导死在这一步，
     唯一的出路是把启动端口填回去——刚填的设置就此丢失。现改为 302 跳转到下一步，
     重启提示以 `flash=restart` 形式随行（提示是 notice 不是 error，向导可以走完再重启一次）
  2. 提示语里的端口取错了对象：句子写的是「当前进程仍在监听启动时的端口」，
     插进去的却是**表单里填的**端口。现分别传 `{port}`（.env 里将生效的端口）
     与 `{bootPort}`（进程实际监听的端口）
  3. `partials/form-field.hbs` 里裸写的 `{{#if error}}` 会被 Handlebars 解析到**父级上下文**
     ——partial 自身上下文没有 `error` 时就回落到父级，于是页面级错误在**每个字段下方**
     重复一遍。现改用带作用域的 `{{#if fieldError}}`
- **向导第 2 步的端口字段**: Node 进程监听的端口在反向代理后面是内部细节，操作员根本不该填；
  而把它做成表单字段，恰恰引出了实际发生的错误——填入**对外**端口 443（那是 nginx 的端口，
  不是 Node 的），两个端口从此互相打架。现移除该字段，端口一律取自运行中的配置；
  旧书签／残留标签页若仍提交 `port`，一律忽略
- **`WEB_BASE_URL` 停留在回环占位符**: 启动时生成的 `.env` 写的是
  `WEB_BASE_URL=http://localhost:3880`——启动那一刻服务端还没收到任何请求，
  无从知道自己的域名，那是个**猜测**而非选择。但它此前优先于操作员在向导里确认的地址，
  于是向导显示了自己的值、操作员点了「生成并继续」，文件里留下的仍是占位符。
  这个地址会进验证邮件、重置密码邮件和密钥页展示的 API 地址——留成回环地址，
  等于把这三处的链接都发给了外面打不开的人。现把回环占位符（`localhost`／`127.0.0.1`／
  `[::1]`，带不带端口与路径都算）视为「尚未选定」，由操作员的值取代；
  任何**非**占位符的既有值（真实域名、内网 IP）一律不动

- **Provider 熔断窗口粒度**: 熔断窗口按分钟配置（默认 10 分钟），但调用计数器
  `provider_call_counter` 按 UTC **天**分桶，于是 10 分钟窗口实际读到 24 小时历史——
  一次下午的抖动会让 Provider 停用一整天，而已经恢复的 Provider 要等到下一个
  UTC 零点才重新启用。现新增按分钟分桶的 `provider_call_counter_minute`
  （migration 024），`touchProviderCalled` 双写两张表，窗口小于一天时读分钟表、
  更大时仍读天表；分钟表缺失时自动回退到天表，不影响熔断本身
- **回灌预览污染审计日志**: 干跑（`dryRun=true`）同样会往 `random_probe_log`
  写入 `merged` 记录，于是「最近探测」列表里会出现根本没写入 `ip_ranges` 的 IP，
  与真实运行无法区分。干跑现在不再写任何探测记录，预览结果只在 `previewRows` 中
- **ETL 失败运行残留阶段行**: `markStageFailed` 只清理了下载与 swap 行，解析／入库行
  的 `finished_at` 留空，在管理界面上读起来像「这个阶段还在跑」，与真实运行无法区分。
  现一并关闭这些行并补齐 `duration_ms`
- **下载重定向未校验协议**: 重定向目标来自服务端响应，此前原样跟随，可能被指向
  `http://`（降级为明文）或内网地址。现只跟随 `https://`，其余一律拒绝
- **失效的 `perIpTimeoutMs` 选项**: 回灌与随机 IP 生成的该选项从未接到任何地方
  （5 个 Provider 各自硬编码 `AbortSignal.timeout(5_000)`），传值毫无效果，属误导性
  API。现移除该选项及其整条透传链
- **失效的 `maxTriesPerIp` 选项**: `pickRandomIpsNotInRanges` 收下该参数却硬编码
  重试 10 次，现改为真正按传入值重试
- **ETL 跨源合并的死代码**: `src/etl/merger.ts` 的 `mergeByPriority` 无任何调用方
  （实际合并由入库阶段的按列 `COALESCE` upsert 完成），连同其单元测试一并移除；
  相关注释同步更正
- **统计口径失真**: `maxmind` 与 `ip2region` 的解析器存在但从未接入 ETL 流水线，
  统计接口却用 `?? 0` 把「未运行」报成「运行了但 0 条」。现未运行的源返回 `null`，
  与实测的 `0` 区分开
- **失效的测试断言**: 六处断言与实现早已不一致，代码行为是对的、断言是旧的：
  `etl-run-detail-route.test.ts`、`admin.dashboard.test.ts`、`admin.etl.test.ts`、
  `admin.users.test.ts`、`session-middleware.test.ts` 期望非管理员拿到 403，
  而 `auth.ts` 出于防目录枚举的考虑刻意返回 404（见 commit `a2626e6`）；
  `init-routes.test.ts` 断言 `init-progress-status--*`，而视图渲染的仍是
  `setup-progress-status--*`（`/setup` → `/init` 改名时只改了断言没改类名）；
  `mysql.test.ts` 与 `cli.migrate.test.ts` 的表清单／迁移计数停在 migration 024 之前。
  现按实际行为修正断言
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
- **ETL 静默降级为残缺数据**: 下载阶段按「文件是否存在」决定是否复用，且只要有任一文件
  存在就完全跳过下载。被中断的下载会在磁盘上留下半截的 `.gz`，被当作有效缓存直接解析，
  报 `unexpected end of file`；更糟的是缺文件的那些源会被解析阶段静默跳过，整轮 ETL
  仍报告 `success`，并把残缺数据 swap 上线覆盖完整数据。现改为逐份判断：校验 gzip
  完整性（magic + trailer ISIZE），损坏的文件删除并重下，缺失／损坏／解析出 0 行
  一律判失败并保留旧数据；下载时也比对 `Content-Length`，半成品不落盘
- **ETL 进度条跨文件回退**: 插入进度计数原在每个文件循环内清零，切换到下一个源时
  进度条掉回 0%，现改为跨文件累计
- **ETL 多余一遍解压**: swap 之后为统计行数会把三个 CSV 全部重新解析一遍（第三遍
  gunzip），且任一瞬态 IO 错误都会把已经上线的运行标记为 `failed`。现改用插入阶段
  的行数统计，并移除了这次重解析
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
  并新增 `src/web/assets/css/errors.css`（原先错误视图借用 `setup.css`，
  导致 public 布局多拉一个 1000 行的向导样式表）——错误页必须能在坏代理／DNS 劫持下
  正常渲染，不得发起任何第三方请求。28 处内联的 `.view("errors/…")` 调用统一收敛到
  `src/web/errors/render.ts` 的 `sendErrorPage`/`sendCsrfPage` 助手
- **管理路径 403 泄漏路由图**: 未登录或非管理员访问 `/admin*` 时返回 403，
  等于向任何注册用户确认 `/admin`、`/admin/users`、`/admin/settings` 真实存在——
  一份免费的管理台目录。现改为返回 404（与不存在路由外观一致），
  管理台的存在性不再通过状态码外泄
- **全站移动端横向溢出**: 42 组页面×视口探针扫出两类溢出，根源都是 CSS 盒模型与网格
  的自动最小宽度：(1) 代码库处处用 `width: 100%` 加水平内边距，默认 `content-box`
  下内边距叠加在 100% 之外，桌面端被父容器静默裁剪、移动端全出血行则出横向滚动条——
  现在 `base.css` 顶部对 `*, *::before, *::after` 统一 `box-sizing: border-box`；
  (2) 网格列写 `1fr` 时自动最小宽度取最长不可断子元素（侧栏 CTA 标签、文档 TOC），
  列宽被顶到视口之外——`.dashboard-shell` 移动列与 `.m-docs-layout` 改为
  `minmax(0, 1fr)`。修复后全站探针 0 问题页
- **表格在窄视口撑破布局**: 9 个视图（管理端 7 个 + 仪表盘 2 个）把
  `<table class="table">` 直接铺进页面，表格的自动布局宽度不可压缩（/admin/users
  在 390px 视口下最小 587px）。直接给表格 `display: block` 是显然的修法也是错的修法：
  表格盒一旦消失，`background` 按行组而非整宽绘制。现统一包一层
  `.table-scroll`（`overflow-x: auto`，触摸滚动）在窄视口横向滚动、宽视口无感
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
- **改资料后页面显示的还是旧值**: `req.user` 是请求到达时的账号行快照，处理函数
  存了新昵称再渲染，却没重读——于是页面弹「资料已保存」，输入框里却是**刚被
  替换掉的那个旧昵称**。读起来就是保存失败。现保存后重新查库并回填
  `req.user`；`req.session.email` 一并刷新，因为侧栏页脚、后台顶栏、后台
  问候语渲染的都是会话里那份拷贝，不刷新的话，改了邮箱的页面旁边的框里
  还写着旧地址
- **ETL 的 swap 会永久挂起**: `atomicSwapRanges()` 用 `RENAME TABLE` 换表，
  而 `RENAME` 需要 `ip_ranges` 上的**独占元数据锁（MDL）**。MySQL 的
  `lock_wait_timeout` 默认是 31,536,000 秒——**一年**。任何一个还在读的
  长查询（`SELECT COUNT(*)`、带 `JOIN` 的日志查询）都会让 swap 排队一年，
  表现是「ETL 一直卡在 swap 阶段」；反过来，swap 排队期间所有新读者也全部
  堵在 MDL 后面，整站查询一起变慢。现 swap 前 `SET SESSION lock_wait_timeout = 30`，
  等不到锁就**快速失败**并把运行标记为失败，而不是占着锁不放
- **被放弃的 ETL 运行会一直占着运行锁**: 进程被杀、机器重启之后，`etl_runs`
  里的 `running` 行不会自己收尾，于是**下一次** ETL 也被守卫挡住——「这个实例
  再也跑不了 ETL」。现 `closeStaleEtlRuns()` 把超过 120 分钟仍停在 `running`
  的运行标记为失败并释放锁，取锁时也先回收一遍
- **首页标题说三个数据源，旁边的数字写四个**: 标题「一个查询,三个数据源」是
  手写文案，而下方那颗统计徽章的数字是 `etlUpstreamCount()` 从流水线算出来的
  ——两者已经漂移。流水线抓的是七个文件、来自**四个**上游（DB-IP 占三个文件），
  于是同一屏上标题说三、徽章说四，两个数字都不可信。现把标题改成四个，并补
  一道测试把标题里的数字与 `etlUpstreamCount()` 对齐——再加一个上游时，是测试
  挂掉，而不是页面上悄悄多出一个说法

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
- **网段导入导出写审计日志**: `/admin/ranges` 是后台唯一能整库摧毁数据的入口
  ——`replace` 模式的导入会跑 `atomicSwapRanges`，把整个 `ip_ranges` 表换成上传
  文件的内容。但这个文件里的 7 条路由**一条审计记录都没写**（`admin.ts` 有 30 处），
  于是「谁替换了库、什么时候、用什么文件」这个问题，答案是：**没有任何记录**。
  MCP 的 `ipquery_audit_log` 与后台的 `/admin/audit-log` 读的是同一张表，因此
  两者都对本产品最破坏性的操作是瞎的。现补上三处记录：
  1. `ranges.export` —— 附带国家过滤条件，因为导出单个国家和导出整个库是两回事
  2. `ranges.import` —— 附带 `mode`（`merge` 还是 `replace`）与声明行数
  3. 记录写在**任务落库之后**：导出没能启动就不该出现在轨迹里；被确认次数
     拦下的导入同理——什么也没发生，就没什么可记的

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
