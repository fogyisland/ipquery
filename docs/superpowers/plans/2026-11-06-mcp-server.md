# IPQuery MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 IPQuery 提供 stdio MCP server，AI 工具一行配置即可查询 IP 归属地、查看统计与 unknown-IP 回填队列（7 个只读工具）。

**Architecture:** 独立入口 `dist/mcp/server.js`（CJS），通过 `@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport` 与 AI 客户端通信；直连 MySQL（复用 `loadConfig()` + `mysql2` 连接池），复用现有存储层函数；不依赖 Fastify 服务运行。

**Tech Stack:** TypeScript (CJS)、`@modelcontextprotocol/sdk@^1.32.2`（CJS 入口）、`mysql2`、vitest。

**Spec:** `docs/superpowers/specs/2026-11-06-mcp-server-design.md`

## Global Constraints

- 唯一新增依赖：`@modelcontextprotocol/sdk`（^1.32.2，import 其 CJS 入口）；**不引入 zod**，输入 schema 用 SDK 原生 JSON Schema + 手写边界校验
- 沿用现有 CJS 管线（`package.json` `type: "commonjs"`，tsc 直出 `dist/`），不引入 ESM 子构建
- `.env` 解析：MCP server 启动时将 dotenv 指向脚本自身目录定位项目根 `.env`（`dist/mcp/` → `dist/../../.env`），任意 cwd 启动均可
- `ipquery_lookup` 与 HTTP API 行为一致：未命中保留 `insertOrIncrement` 写副作用；MCP 查询**不写 query_log**
- `ipquery_queries_recent` 输出默认脱敏：`userEmail` 打码为 `a***@d***.com` 格式、`apiKeyPrefix` 只留前 4 字符、`remoteAddr` 保留；参数 `includePrivate`（默认 false）返回原文
- 函数 ≤50 行、文件 ≤300 行、严格类型（禁滥用 `any`）、无静默失败（catch 必须记 stderr 或抛带上下文错误）
- 诊断日志走 stderr（stdio 通道被 MCP 协议占用）
- 遵循项目 Prettier/ESLint 现有配置；提交信息符合仓库现有 conventional commits 风格

## Review Focus

1. **任意 cwd 启动时 `.env` 加载失败** → server 应 fail-fast 报明确错误而非静默用默认值连错库。Task 2 测试钉住。
2. **无效 IP / 边界输入**（空串、`999.1.1.1`、超长字符串、`limit` 超 100）→ 返回结构化错误文本而非 throw 给 MCP 层。Task 3/4 测试钉住。
3. **敏感字段泄漏**：`includePrivate` 缺省时 `userEmail`/`apiKeyPrefix` 必须已脱敏。Task 5 测试钉住。
4. **stdio 通道污染**：任何 `console.log` 落到 stdout 会破坏 MCP 协议帧。Task 6 步骤钉住（验证 server 握手后 stdout 无杂音）。
5. **DB 不可用**：启动时连接失败应 stderr 明确报错并以非零码退出；运行中查询失败返回带上下文 message。Task 2/4 测试钉住。

---

### Task 1: 安装 SDK 依赖 + npm script

**Files:**
- Modify: `package.json`（dependencies + scripts）
- Modify: `package-lock.json`（npm install 自动）

**Interfaces:**
- Produces: `npm run mcp` script（指向 `dist/mcp/server.js`，Task 6 消费）；`@modelcontextprotocol/sdk@^1.32.2` 依赖（Task 2-6 import）

- [ ] **Step 1: 安装依赖**

```bash
npm install @modelcontextprotocol/sdk@^1.32.2
```

- [ ] **Step 2: 加 npm script**

在 `package.json` scripts 中加入（保持字母序邻近位置）：

```json
"mcp": "node dist/mcp/server.js"
```

- [ ] **Step 3: 验证 CJS 入口可加载**

```bash
node -e "const { Server } = require('@modelcontextprotocol/sdk/server/index.js'); const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'); console.log('CJS entry OK', typeof Server, typeof StdioServerTransport)"
```

Expected: `CJS entry OK function function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(mcp): add @modelcontextprotocol/sdk dependency + mcp script"
```

---

### Task 2: `.env` 解析工具 + MCP server 入口骨架

**Files:**
- Create: `src/mcp/env.ts`
- Create: `src/mcp/server.ts`
- Test: `test/unit/mcp-env.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from `src/config.ts`（现有签名不变）
- Produces:
  - `resolveProjectRoot(): string` — 返回项目根绝对路径（基于 `__dirname`：`dist/mcp/` 编译后上溯两级；源码运行时用 `process.cwd()` 回退）。编译产物路径 = `path.resolve(__dirname, "..", "..")`；测试从 src 运行时 `__dirname` 是 `src/mcp/`，同样上溯两级到项目根，两种场景一致，无需分支。
  - `startMcpServer(opts: { log: (msg: string) => void }): Promise<{ pool: Pool; server: Server }>` — 创建连接池、注册工具（Task 3-5 的 `buildToolRegistrations`）、绑定 StdioServerTransport、注册 SIGINT/SIGTERM 优雅退出（`pool.end()`）。`log` 注入以便测试捕获 stderr 行为。

- [ ] **Step 1: 写失败测试 `test/unit/mcp-env.test.ts`**

```typescript
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolveProjectRoot } from "../../src/mcp/env";

describe("resolveProjectRoot", () => {
  it("returns a directory that contains package.json", () => {
    const root = resolveProjectRoot();
    expect(require("node:fs").existsSync(require("node:path").join(root, "package.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/mcp-env.test.ts`
Expected: FAIL（`Cannot find module '../../src/mcp/env'`）

- [ ] **Step 3: 实现 `src/mcp/env.ts`**

```typescript
// SPDX-License-Identifier: MIT
import path from "node:path";

/**
 * 项目根目录。编译产物位于 dist/mcp/，源码位于 src/mcp/ —— 两者相对项目根
 * 都恰好两级，因此统一 __dirname 上溯两级即可，无需区分编译/源码场景。
 */
export function resolveProjectRoot(): string {
  return path.resolve(__dirname, "..", "..");
}
```

并在 `src/mcp/server.ts` 顶部（任何其它 import 之前）加载项目根 `.env`：

```typescript
// SPDX-License-Identifier: MIT
// MCP stdio server 入口。stdio 通道被 MCP 协议占用，所有诊断输出走 stderr。
import { config as dotenvConfig } from "dotenv";
import { resolveProjectRoot } from "./env";

dotenvConfig({ path: `${resolveProjectRoot()}/.env`, quiet: true });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/mcp-env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/env.ts src/mcp/server.ts test/unit/mcp-env.test.ts
git commit -m "feat(mcp): env resolution + server entry skeleton with project-root .env loading"
```

---

### Task 3: lookup 工具核心（复用 doLookup 路径）

**Files:**
- Create: `src/mcp/tools.ts`（本任务先建文件放 lookup 工具；Task 4/5 继续追加）
- Test: `test/unit/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `parseIp`, `isValidIp` from `src/ip.ts`；`findRange`, `lastSuccessfulEtl` from `src/storage/mysql.ts`；`insertOrIncrement` from `src/storage/unknownIpQueue.ts`；`LookupResult` from `src/types.ts`
- Produces:
  - `interface McpPool { pool: Pool; log: (msg: string) => void }` — 最小依赖注入结构（`doLookup` 取 `app.pool`/`app.log` 的等价物）
  - `async function mcpLookup(deps: McpPool, ip: string): Promise<LookupResult>` — 与 `src/api/routes/lookup.ts` 的 `doLookup` 逻辑一致：无效 IP 抛 `{ code: "invalid_ip" }`；未命中先 `insertOrIncrement`（失败仅 log，不掩盖 404）再抛 `{ code: "not_found", ip }`；命中返回 `LookupResult`。**不写 query_log。**
  - `function lookupToolDef(): ToolDef` — 返回 `{ name: "ipquery_lookup", description, inputSchema }`（JSON Schema：`{ type: "object", properties: { ip: { type: "string" } }, required: ["ip"] }`）
  - LookupResult → MCP 文本输出格式化函数 `formatLookupResult(r: LookupResult): string`

注：`doLookup` 当前是 `lookup.ts` 内部函数。为不复制业务逻辑，把其实现抽为 `src/lookup-core.ts` 导出 `export async function doLookupCore(pool: Pool, log: Logger, ip: string): Promise<LookupResult>`，HTTP 路由改为调用它（`lookup.ts` 的 `doLookup` 变为单行转发）。**这是本计划唯一的现有代码改动**，行为零变化。

- [ ] **Step 1: 抽取 `src/lookup-core.ts`**

从 `src/api/routes/lookup.ts:16-60` 将 `doLookup` 函数体迁至 `src/lookup-core.ts`，签名 `doLookupCore(pool: Pool, log: { warn: (obj: unknown, msg: string) => void }, ip: string): Promise<LookupResult>`；`lookup.ts` 内保留 `async function doLookup(app, ip) { return doLookupCore(app.pool, app.log, ip); }`。迁移后运行现有 lookup 测试确认零破坏。

Run: `npx vitest run test/unit/lookup-error-handler.test.ts test/integration/lookup-route.test.ts`
Expected: PASS

- [ ] **Step 2: 写失败测试（lookup 工具）**

`test/unit/mcp-tools.test.ts`：

```typescript
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { mcpLookup, lookupToolDef } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

describe("mcpLookup", () => {
  it("rejects invalid ip without touching the pool", async () => {
    const pool = { query: vi.fn() };
    await expect(mcpLookup({ pool: pool as never, log: noopLog }, "999.1.1.1"))
      .rejects.toMatchObject({ code: "invalid_ip" });
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("invalid_ip schema marks ip required", () => {
    const def = lookupToolDef();
    expect(def.name).toBe("ipquery_lookup");
    expect((def.inputSchema as { required?: string[] }).required).toContain("ip");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: FAIL（`mcpLookup` 未定义）

- [ ] **Step 4: 实现 `src/mcp/tools.ts`（lookup 部分）**

实现 `McpPool` 接口、`mcpLookup`（内部调 `doLookupCore`）、`lookupToolDef`、`formatLookupResult`。JSON Schema 钉住 `ip` 必填。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lookup-core.ts src/api/routes/lookup.ts src/mcp/tools.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): extract doLookupCore + ipquery_lookup tool"
```

---

### Task 4: 统计与队列工具（4 个）

**Files:**
- Modify: `src/mcp/tools.ts`（追加 4 个工具 + 一个共享 clamp 辅助）
- Test: `test/unit/mcp-tools.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `lastEtlRun` from `src/storage/mysql.ts`；`queueStats`, `topByQueryCount` from `src/storage/unknownIpQueue.ts`（签名见存储层：`queueStats(pool) → { pending, processed, totalQueries }`；`topByQueryCount(pool, limit) → { pending: UnknownIpRow[], recentlyProcessed: UnknownIpRow[] }`）；Task 3 的 `McpPool`
- Produces:
  - `function clampInt(v: unknown, min: number, max: number, fallback: number): number` — 非整数/NaN/超界一律 clamp 到界内，非法回退 fallback
  - `etlStatusToolDef()` / `queueStatsToolDef()` / `queueTopToolDef()` / 与各自 handler——命名统一为 `mcpEtlStatus(deps)`, `mcpQueueStats(deps)`, `mcpQueueTop(deps, limit)`
  - 日期序列化约定：所有 `Date` 字段 → `.toISOString()`，`null` 保持 `null`（参照 `src/api/routes/stats.ts` 既有做法）

- [ ] **Step 1: 写失败测试**

追加到 `test/unit/mcp-tools.test.ts`：

```typescript
describe("clampInt", () => {
  it("clamps out-of-range and non-numeric values", () => {
    expect(clampInt("500", 1, 100, 20)).toBe(100);
    expect(clampInt(0, 1, 100, 20)).toBe(1);
    expect(clampInt("abc", 1, 100, 20)).toBe(20);
    expect(clampInt(undefined, 1, 100, 20)).toBe(20);
  });
});

describe("mcpQueueStats", () => {
  it("returns the queueStats triple", async () => {
    const pool = { query: vi.fn().mockResolvedValue([[{ pending: 3, processed: 9, total_queries: 12 }], []]) };
    expect(await mcpQueueStats({ pool: pool as never, log: noopLog })).toEqual({ pending: 3, processed: 9, totalQueries: 12 });
  });
});
```

（`mcpEtlStatus` 测试：mock `pool.query` 返回一行 etl_runs 记录，断言输出含 `status` 与 ISO 日期字符串。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: FAIL（`clampInt`/`mcpQueueStats` 未定义）

- [ ] **Step 3: 实现四个工具 handler + defs + clampInt**

`mcpEtlStatus(deps)`：`lastEtlRun` → `{ lastRun: {...ISO 日期...}, queue: await mcpQueueStats(deps) }`；无 run 时 `{ lastRun: null }`。每个 handler 包 try/catch，DB 失败时 `deps.log.error` + 抛带上下文 `Error("queue stats failed: ...")`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): etl/queue stats tools + clampInt helper"
```

---

### Task 5: 查询日志工具 + 脱敏

**Files:**
- Modify: `src/mcp/tools.ts`（追加 2 个工具 + 脱敏函数）
- Test: `test/unit/mcp-tools.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `listQueryLogs`, `countQueriesByDay`, `QueryLogRow` from `src/storage/queryLog.ts`（`listQueryLogs(pool, q: QueryLogQuery) → { rows, total }`）；Task 4 的 `clampInt`、`McpPool`
- Produces:
  - `function maskEmail(email: string | null): string | null` — `a***@d***.com` 格式：首字符 + `***@` + 域名首字符 + `***` + TLD（如 `peng@example.com` → `p***@e***.com`）；null/空 → null
  - `function maskPrefix(p: string | null): string | null` — 前 4 字符 + `***`；null/空 → null
  - `function sanitizeQueryRow(row: QueryLogRow, includePrivate: boolean): Record<string, unknown>` — `includePrivate=false` 时应用上述两个 mask，`userAgent`/`remoteAddr(ipText)`/`ts`/`ipText`/`status` 原样
  - `mcpQueriesRecent(deps, { limit, status, includePrivate })` / `queriesRecentToolDef()`
  - `mcpQueriesDaily(deps, { days })` / `queriesDailyToolDef()`

- [ ] **Step 1: 写失败测试**

```typescript
describe("masking", () => {
  it("masks email and api-key prefix", () => {
    expect(maskEmail("peng@example.com")).toBe("p***@e***.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskPrefix("abcd1234")).toBe("abcd***");
    expect(maskPrefix(null)).toBeNull();
  });
  it("sanitizeQueryRow redacts by default and reveals with includePrivate", () => {
    const row = { userEmail: "peng@example.com", apiKeyPrefix: "abcd1234", ipText: "1.2.3.4", status: "hit" } as never;
    const redacted = sanitizeQueryRow(row, false) as Record<string, string>;
    expect(redacted.userEmail).toBe("p***@e***.com");
    expect(redacted.apiKeyPrefix).toBe("abcd***");
    const raw = sanitizeQueryRow(row, true) as Record<string, string>;
    expect(raw.userEmail).toBe("peng@example.com");
    expect(raw.apiKeyPrefix).toBe("abcd1234");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: FAIL（mask 函数未定义）

- [ ] **Step 3: 实现两个工具 + 脱敏函数**

`mcpQueriesRecent`：`limit` clamp 1-50 默认 10；`status` 仅接受 `"hit" | "miss" | "invalid"`（JSON Schema enum），运行时再校验；`includePrivate` 默认 false。`mcpQueriesDaily`：`days` clamp 1-90 默认 30。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/mcp-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): query-log tools with default redaction"
```

---

### Task 6: server 注册 + 端到端握手验证

**Files:**
- Modify: `src/mcp/server.ts`（完成入口）
- Create: `docs/mcp.md`（接入文档）
- Test: `test/unit/mcp-server.test.ts`

**Interfaces:**
- Consumes: Task 2 `startMcpServer` 骨架；Task 3-5 全部 `*ToolDef()` + handler
- Produces:
  - `buildToolRegistrations(deps: McpPool): Array<{ def: ToolDef; handler: (args: unknown) => Promise<string> }>` — 7 个工具的统一注册表，供 `server.setRequestHandler(CallToolRequestSchema, ...)` 消费；handler 返回 JSON 字符串（`JSON.stringify(result, null, 2)`），工具内部错误被 catch 后转 `isError: true` 的文本消息（不炸进程）
  - 端到端验证方式：`npm run build && npm run mcp` 后向 stdin 写一行 JSON-RPC `initialize` 请求，断言 stdout 返回含 `serverInfo` 的响应（Task 6 Step 3 手动验证 + `docs/mcp.md` 记录）

- [ ] **Step 1: 写失败测试（注册表完整性 + 错误不炸进程）**

```typescript
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { buildToolRegistrations } from "../../src/mcp/server-tools";
import { TOOL_NAMES } from "../../src/mcp/tool-names";

describe("buildToolRegistrations", () => {
  it("registers exactly the 7 read-only tools", () => {
    const deps = { pool: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;
    const tools = buildToolRegistrations(deps);
    expect(tools.map((t) => t.def.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(7);
  });
  it("handler errors become isError text, not throws", async () => {
    const deps = { pool: { query: vi.fn().mockRejectedValue(new Error("boom")) }, log: { warn: vi.fn(), error: vi.fn() } } as never;
    const tools = buildToolRegistrations(deps);
    const etl = tools.find((t) => t.def.name === "ipquery_etl_status")!;
    const res = JSON.parse(await etl.handler({}));
    expect(res.isErrorHint).toBe(true);
    expect(res.message).toContain("etl status failed");
  });
});
```

（实现文件按 ≤300 行约束拆分：`src/mcp/tool-names.ts` 常量、`src/mcp/server-tools.ts` 注册表构建、`src/mcp/server.ts` 入口只做 transport + 优雅退出。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/mcp-server.test.ts`
Expected: FAIL（模块未定义）

- [ ] **Step 3: 实现 tool-names.ts / server-tools.ts / 完成 server.ts**

`server.ts` 结构：`dotenv`（Task 2 已加）→ `loadConfig()` → `mysql.createPool(...)` → `buildToolRegistrations` → `new Server(serverInfo, { capabilities: { tools: {} } })` → `ListToolsRequestSchema` handler 返回 defs → `CallToolRequestSchema` handler 按 name 分发、`JSON.stringify` 输出 → `StdioServerTransport` → SIGINT/SIGTERM `pool.end()` + `process.exit(0)`。启动失败（DB 连不上）：`console.error` 明确错误 + `process.exit(1)`。

- [ ] **Step 4: 运行确认通过 + 全量单测回归**

Run: `npx vitest run test/unit/mcp-server.test.ts && npm run test:unit`
Expected: PASS（全量单元测试含既有 99 个）

- [ ] **Step 5: 构建 + 真实握手验证（Review Focus #4 钉住）**

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' | node dist/mcp/server.js
```

Expected: stdout 输出单个 JSON-RPC 响应（含 `serverInfo.name`），**无其它 stdout 杂音**；随后进程因 stdin EOF 退出（exit 0）。DB 不可用时 stderr 有明确错误且 exit 1。

- [ ] **Step 6: 写接入文档 `docs/mcp.md`**

内容：Claude Code（`claude mcp add ipquery -- node E:\ToolDevelop\IPQuery\dist\mcp\server.js`）、Cursor / Claude Desktop JSON 配置、7 个工具一览表、`includePrivate` 脱敏说明、构建要求（先 `npm run build`）。

- [ ] **Step 7: Commit**

```bash
git add src/mcp/ test/unit/mcp-server.test.ts docs/mcp.md
git commit -m "feat(mcp): stdio server with 7 read-only tools + integration docs"
```

---

### Task 7: 全量验证收尾

**Files:**
- 无新文件（验证 + 文档小补）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 绿灯的全量验证记录；README 工具链说明一行

- [ ] **Step 1: 类型检查 + lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 2: 全量单元测试**

Run: `npm run test:unit`
Expected: PASS（既有 99 + 新增）

- [ ] **Step 3: 集成测试补跑（需要本地 MySQL；若内存紧张可由用户稍后手动跑）**

Run: `npm run test:integration`
Expected: PASS（Task 3 改动了 `lookup.ts`，须确认 lookup 相关集成测试零破坏）

- [ ] **Step 4: Prettier 格式确认**

Run: `npm run format:check`
Expected: PASS（新文件均符合项目格式）

- [ ] **Step 5: README 补 MCP 一节（3-5 行：构建 + `npm run mcp` + 指向 docs/mcp.md）并 Commit**

```bash
git add README.md docs/mcp.md
git commit -m "docs: MCP server usage in README"
```
