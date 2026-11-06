# IPQuery MCP Server 设计

日期：2026-11-06
状态：已批准（对话确认）

## 意图与动机

IPQuery 的能力目前通过 HTTP API（`/lookup`、`/stats`）和管理后台（`/admin/*`）暴露。
本设计将其能力以 **MCP (Model Context Protocol) server** 形式暴露，让 AI 工具
（Claude Code、Cursor、Claude Desktop 等）能像连接其他系统一样连接 IPQuery：
查询 IP 归属地、查看库规模与查询统计、检查 unknown-IP 回填队列。

## 目标

- AI 工具通过 stdio 一行配置即可接入 IPQuery
- 第一版提供 7 个只读工具，覆盖查询、统计、队列三类核心能力
- 复用现有存储层函数，与 admin 后台同源逻辑，不复制业务代码
- 不依赖 dev server 是否在运行

## 非目标

- 不做远程 HTTP/SSE 传输（第一版仅 stdio）
- 不做 MCP resources / prompts，只做 tools
- 不提供写操作工具（触发 ETL、清队列、执行回填）——后续按需追加，届时加确认参数
- 不改动现有 Fastify HTTP 服务

## 约束

- 唯一新增依赖：`@modelcontextprotocol/sdk`（官方 SDK，import 其 CJS 入口）
- **不引入 zod**：输入校验用 SDK 原生 JSON Schema（tool 的 `inputSchema` 字段）+ 手写边界校验（`isValidIp`、clamp），避免第二个新依赖
- **沿用现有 CJS 管线**：项目 `package.json` 为 `type: "commonjs"`，`tsc` 直出 `dist/`；
  `dist/mcp/server.js` 为 CJS，不引入 ESM 子构建
- Node 20+，Windows / Linux / macOS 均可运行（纯 Node，无平台调用）
- `.env` 解析：`loadConfig()` 现按 `process.cwd()` 找 `.env`。MCP server 启动时
  将 dotenv 指向**脚本自身所在目录**的 `.env`（`dist/../../.env` → 项目根），
  保证 AI 客户端以任意 cwd 启动子进程也能加载配置
- 函数 ≤50 行、文件 ≤300 行、严格类型、无静默失败（项目 CLAUDE.md 规范）

## 架构

```
AI 工具 (Claude Code / Cursor / Desktop)
  └─ stdio ──> dist/mcp/server.js  (MCP server 子进程)
                 ├─ @modelcontextprotocol/sdk (Server + StdioServerTransport)
                 ├─ loadConfig() 读 .env ──> mysql2 连接池（复用 src/config.ts）
                 └─ 工具 handlers ──> 复用 src/ip.ts、src/storage/*、lookup 核心路径
```

- 入口：`npm run mcp`（新增 script，指向 `dist/mcp/server.js`）
- 连接池生命周期：server 启动时创建，进程退出时 `pool.end()`
- 复用 `/lookup` 的查询核心：把 `lookup.ts` 中 `doLookup` 使用的存储调用
  抽出为可独立调用的函数（若已是独立函数则直接 import，不重复实现）

## 工具清单（7 个，全部只读）

| 工具 | 输入 | 输出 | 底层 |
|---|---|---|---|
| `ipquery_lookup` | `ip: string` | country/city/asn/isp 等归属地字段；未命中返回 structured unknown 标记 | lookup 核心路径 + `isValidIp` |

**`ipquery_lookup` 行为与 HTTP API 完全一致**（用户已拍板）：未命中保留
`insertOrIncrement` 写副作用（miss 进入 unknown_ip_queue → 后续回填）。
MCP 查询不写 query_log（无认证主体，HTTP 路由也只记录已认证调用者）。

其余 6 个工具为纯只读。`ipquery_queries_recent` 输出**默认脱敏**（用户已拍板）：
`userEmail` → `a***@d***.com` 格式打码、`apiKeyPrefix` 只留前 4 字符、
`remoteAddr` 保留；工具参数 `includePrivate?: boolean`（默认 false）请求原文，
供本机排障时显式开启。
| `ipquery_stats` | 无 | 库规模摘要：最近 ETL run 状态、各源记录数 | `lastEtlRun` |
| `ipquery_etl_status` | 无 | 最近 ETL run 详情 + 队列概要 | `lastEtlRun` + `queueStats` |
| `ipquery_queue_stats` | 无 | pending / processed / totalQueries | `queueStats` |
| `ipquery_queue_top` | `limit?: number` (1-100, 默认 20) | 查询次数最高的未知 IP 列表 | `topByQueryCount` |
| `ipquery_queries_recent` | `limit?: number`, `status?: string` | 最近查询日志条目 | `listQueryLogs` |
| `ipquery_queries_daily` | `days?: number` (1-90, 默认 30) | 按天查询量数组 | `countQueriesByDay` |

输入 schema 用 SDK 原生 JSON Schema 定义（tool 注册的 `inputSchema` 字段）；
所有数值参数有上下界，运行时再做边界校验（clamp + `isValidIp`）。

## 错误处理

- 无效 IP → `isValidIp` 拦截，返回结构化错误文本（不是 throw 给 MCP 层）
- DB 连接失败 → 启动时 fail-fast 明确报错；运行中查询失败 → 捕获并返回带上下文的 message
- 不吞异常：所有 catch 必须记录到 stderr（stdio 通道被 MCP 协议占用，日志走 stderr）

## 实现结构

```
src/mcp/server.ts   — 入口：创建 Server、注册工具、stdio transport、优雅退出（≤120 行）
src/mcp/tools.ts    — 工具定义 + handler（zod schema + 调存储层）（≤300 行）
```

测试：

```
test/unit/mcp-tools.test.ts — schema 边界校验 + handler（mock pool / 传入无效 IP 等）
```

## 配置接入（交付时写入 README 或 docs/）

```json
{
  "mcpServers": {
    "ipquery": {
      "command": "node",
      "args": ["E:\\ToolDevelop\\IPQuery\\dist\\mcp\\server.js"]
    }
  }
}
```

## 遗留给 builder 的决定

- `doLookup` 依赖注入方式（Fastify app vs 直接传 pool）——按最小改动原则选择；
  现实现取 `app.pool` 与 `app.log`，MCP 侧可传 `{ pool, log }` 最小结构或抽公共函数
- `listQueryLogs` 的 status 过滤参数映射（沿用其现有 `QueryLogQuery` 结构）
- 日志输出：stdio 通道被 MCP 协议占用，所有诊断日志走 stderr

## 后续路线（不在本设计内）

- 写操作工具 + 确认参数
- HTTP streamable transport（远程接入）
- CHANGELOG、backfill 锁、per-route 限流等 fresh-angle 队列剩余项
