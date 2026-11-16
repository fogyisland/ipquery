# 多源 GitHub ETL 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 metowolf/iplist、runishiwo/ChinaIPlist、sapics/ip-location-db 共四份纯文本文件接入现有 ETL，只在四份新源之间做「大段覆盖小段、保留大段」去重，再以 `countryCode`/`countrySource` 两列累计进同一张 `ip_ranges`。

**Architecture:** 沿用现有 download → parse → insert → swap 骨架与 `preserveManualRows` + `atomicSwapRanges` 顺序。下载层新增可辨识联合规格与 fixed 源的临时文件原子替换；新源独立解析为 `SourceRecord`，经统一去重物化后由 parse/insert 两个阶段复用同一份结果；DB-IP 三份精细行仍先写，新源最后只补 `COALESCE` 留空列。去重统计落新 side table `etl_run_dedupe`。

**Tech Stack:** Node ≥20、TypeScript 严格类型（CommonJS）、Vitest、mysql2、Fastify + Handlebars、commander；无新 NPM 依赖。

**Spec:** `docs/superpowers/specs/2026-11-15-multi-source-etl-design.md`

## Global Constraints

- 不引入新第三方库；不改 `package.json` 依赖；Node ≥20、TypeScript 严格类型、禁 `any`（用 `unknown` 或具体 Interface/Type）。
- `Source` 只增 3 个值：`metowolf-cn`、`runishiwo-cn`、`sapics-user`；`EtlRunDownloadSource` 与 `DownloadKind` 各增 4 个文件级值：`metowolf-cn`、`runishiwo-cn`、`runishiwo-v6`、`sapics-user`。
- 四份 fixed 文件固定名：`china-ipv4.txt`、`china-v4.txt`、`china-v6.txt`、`sapics-user-country.csv`，全部落在 `${dataDir}/raw/`。
- `country_code CHAR(2)`、`country_source VARCHAR(16)`；所有新标签 ≤16 字符。
- `FixedSpec.kind` 必须是显式字面量联合，不得用 `string`；`DEFAULT_SPECS` 保持 `ReadonlyArray<DbipSpec>`，`EXTRA_SPECS` 保持 `ReadonlyArray<FixedSpec>`。
- 四份 GitHub 文件每轮无条件刷新；刷新失败复用上一轮完整且通过校验的缓存，run-detail 记恰好一条 `status: \"failed\"`，正文写明「刷新失败、复用旧缓存」，绝不写 `skipped`；无完整缓存则整轮失败、不交换。`status` ENUM 不新增值。
- fixed 源绝不直写正式目标文件；`downloadToFile` 失败会 `unlink(destPath)`，必须走临时文件 + 校验 + 原子替换。
- DB-IP monthly 沿用有效缓存记 `skipped`；`validateGzFile` 与 DB-IP 月度 URL 回溯行为不变。
- 去重只吃三个新源，绝不读 `ip_ranges_new` 里的 DB-IP 行；相同区间合并时国家码冲突按 `sapics-user > runishiwo-cn > metowolf-cn`；部分重叠保留两段；相接段不合并。
- 去重输入上限 `1_000_000` 条；超限整轮失败而不是 OOM。
- 计数恒等式：`Σ emittedByFile === emitted === Σ etl_run_parses.rowsEmitted(四份新源) === Σ etl_run_inserts.rowsAttempted(四份新源)`。
- `dbipRecords` 字段只含三份 DB-IP 的 `rowsAttempted` 之和；`mergedRecords` 与 `PipelineResult.merged` 含全部 `SOURCE_FILES`。不新增 `etl_runs` 列，不改 `/stats` 与 MCP `EtlStatusResult` 响应结构，不做 API 层 source 映射。
- 迁移号 027；MySQL 5.7 兼容、`INFORMATION_SCHEMA.COLUMNS` 判定的幂等 DDL，每条 DDL 尽量合并（本机约 0.9s/条）。
- `findRange`（两步 LIMIT-100 + 最小 `range_size` 优先）、`preserveManualRows` 在 `atomicSwapRanges` 之前、锁与失败标记逻辑一律不动。
- HBS 注释必须写 `{{!--`；`{{#each}}` 内用 `@root.req.t`；`req.t` 的参数化文案在 route 里预解析，不传 hash args。
- 下载层文本探针在 `src/etl/download.ts` 内联实现，只复用 Task 3 提前 export 的 `parseCsvLine` 与 `src/ip.ts` 的 `parseIp`；不 import Task 4 的解析器，也不回改下载层。
- sapics 国家码用 `src/country-names.ts` 的 `countryNamesFor(code)` 做完整 ISO 3166-1 白名单；`parseIp` 拒绝 IPv4-mapped IPv6；`src/ip.ts` 只导出 `isValidIp`/`parseIp`/`bufferToString`/`compareBuffers`，不得引用未导出的 `parseV4`/`parseV6`。
- `DEDUPE_CONFLICT_PRIORITY` 的键是 `Source` 的 3 个新值，`emittedByFile` 的键是 `EtlRunDownloadSource` 的 4 个文件值；`runishiwo-v6` 通过 `source === \"runishiwo-cn\"` 参与优先级。
- 所有集成测试不得触网：四份 fixed 文件要么在 fixture 中提供，要么通过 `download` stub 短路。
- 发布包本计划只检查、不改写；`npm run check:release` 只校验 `up/dist/` 与 manifest 一致，不等于源码已编译进 `up/dist/`。
- 本会话在 `main`，每个任务的 Commit 步骤只是交付单元边界：只有用户明确要求提交时才执行，且须先 `git switch -c <feature-branch>`。不推送。

## Review Focus

1. 空文件、NUL、U+FFFD、以 `<` 开头的 HTML 错误页、只有注释无合法行、最后一行无换行 → 一律判为不可用源，不得进入 parse 或 swap。由 Task 3 `validateTextFile rejects empty, NUL, replacement char, HTML, comment-only and accepts a last line without newline` 钉住。
2. fixed 主 URL 与备用镜像全失败，且分别存在/不存在完整旧缓存；原子替换中途失败 → 有旧缓存时正式文件逐字节不变、临时文件清零并留 `failed`，无旧缓存时整轮失败且不交换。由 Task 3 `fixed refresh keeps the previous cache intact and cleans every temp file`、`replaceWithValidatedTemp renames back when the second rename throws`，以及 Task 8 `pipeline reuses a valid old cache after a failed refresh` 与 `pipeline fails without a valid old cache` 钉住。
3. sapics 非法 `country_code`（空值、`ZZ`、超长）、引号字段、v4/v6 混排、IPv4-mapped IPv6，以及 v4 `0.0.0.0/0` 与 v6 `::/0` 在 BINARY(16) 中字节重叠 → 非法行跳过并计数，跨族段不互相吞掉。由 Task 4 `sapics parser skips invalid country codes and IPv4-mapped IPv6` 与 Task 5 `dedupe keeps v4 and v6 families separate` 钉住。
4. CIDR 非法前缀、纯 IP、v4 `/0`/`/32`、v6 `/0`/`/128`、完全包含、完全相同、部分重叠、国家码冲突、输入超上限 → 边界可解析、规则可复现、超限抛错。由 Task 4 `CIDR parser covers prefix boundaries and rejects bad prefixes` 与 Task 5 `dedupe applies containment, exact-duplicate, partial-overlap and limit rules` 钉住。
5. DB-IP 零行、新源单文件零行但组 `emitted > 0`、`fillCols` 不覆盖既有 city/region/lat/lon/asn、`findRange` 仍选最细段、`/stats` 与 MCP 口径、`emptySources` 分组、`insertRowsTotal` 与实际写入一致 → 任一不符都算回归。由 Task 6 `github group zero-row warning`、`github group emitted zero fails the run`、`insertRowsTotal equals actual inserted rows`，以及 Task 8 `fillCols never overwrites existing fine-grained columns`、`findRange still picks the smallest covering range after deduped big ranges`、`stats and MCP keep the DB-IP-only dbip counter` 钉住。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/types.ts` | `Source` 公开联合扩展 3 值 |
| `src/storage/mysql.ts` | `EtlRunDownloadSource` 扩展 4 值；`EtlRunDedupeRow`、`insertEtlRunDedupe`、`getEtlRunDedupe` |
| `src/storage/migrations/027_multi_source_etl.sql` | 三张 `etl_run_*` 表 ENUM 幂等扩容 + `etl_run_dedupe` 建表 |
| `src/etl/download.ts` | `DownloadSpec` 可辨识联合、`EXTRA_SPECS`/`ALL_SPECS`、`validateTextFile`、fixed URL 回退与原子替换、`DownloadFailure`/`DownloadAttempt` 扩展、`parseDownloadKinds` |
| `src/etl/sources/types.ts` | 共用 `ParseStats`/`ParseStreamResult<T>`/`newStats`、`SourceRecord`、`AddressFamily` |
| `src/etl/sources/dbip.ts` | Task 3 提前 export `parseCsvLine`；Task 4 re-export 共用类型；三个 `*WithStats` 签名不变 |
| `src/etl/sources/cidr.ts` | `parseCidrLine` + metowolf/runishiwo-v4/runishiwo-v6 三个 `*WithStats` 入口 |
| `src/etl/sources/sapicsCountry.ts` | `user-country.csv` 逐行 CSV 解析与国家码 ISO 白名单校验 |
| `src/etl/sources/dedupe.ts` | 「大段覆盖小段」唯一实现，`DedupeResult` 与统计 |
| `src/etl/sources/prepare.ts` | 四份新源「统一解析 → 去重 → 物化」一次，产出 parse/insert 共用的 `GithubPrepared` |
| `src/etl/pipeline.ts` | `SOURCE_FILES`、`runDownloadStage` 消费 `failures`、分组 parse/insert、硬校验、零行保护、统计口径、进度总量 |
| `src/cli.ts` | `ipq download` 描述、`--only` 七个 kind、改用 `parseDownloadKinds` |
| `src/web/routes/admin.ts` | `buildRunDetailCtx` 纳入 `getEtlRunDedupe` |
| `src/web/views/admin/etl-run-detail.hbs` | 去重汇总段，保持 4 张 stage card 与区外进度条 |
| `src/web/views/marketing/docs.hbs` | 响应示例后补 `source` 扩展说明 |
| `src/web/i18n/zh-CN.json`、`en-US.json` | `docs.sourceNote` 与 `admin.etl.runDetail.dedupe*` |
| `test/unit/types.test.ts`、`test/unit/download.test.ts`、`test/unit/cli-download-kinds.test.ts`、`test/unit/cidr-source.test.ts`、`test/unit/sapics-country.test.ts`、`test/unit/dedupe.test.ts`、`test/unit/dbip-stream-stats.test.ts`、`test/unit/hbs-views.test.ts`、`test/unit/mcp-tools.test.ts` | 单元测试与回归 |
| `test/integration/etl-dedupe-storage.test.ts`、`test/integration/migrations.test.ts`、`test/integration/migrations.legacy.test.ts`、`test/integration/etl-pipeline.test.ts`、`test/integration/etl-guards.test.ts`、`test/integration/find-range.test.ts`、`test/integration/stats-route.test.ts`、`test/integration/docs.test.ts`、`test/integration/etl-run-detail-route.test.ts` | 集成测试与回归 |

---

### Task 1: 类型、迁移 027 与去重统计存储

**Files:**
- Modify: `src/types.ts:2`
- Modify: `src/storage/mysql.ts:686`、`src/storage/mysql.ts:938` 附近
- Create: `src/storage/migrations/027_multi_source_etl.sql`
- Test: `test/unit/types.test.ts`、`test/integration/etl-dedupe-storage.test.ts`、`test/integration/migrations.test.ts`、`test/integration/migrations.legacy.test.ts`

**Interfaces:**
- Consumes: 迁移 019 的 `etl_run_downloads`/`parses`/`inserts` 三张表、迁移 020 的动态 SQL 幂等手法、`019` 定义的 `status ENUM('success','failed','missing','skipped')`。
- Produces: `Source` 9 值联合；`EtlRunDownloadSource = \"dbip-city\" | \"dbip-country\" | \"dbip-asn\" | \"metowolf-cn\" | \"runishiwo-cn\" | \"runishiwo-v6\" | \"sapics-user\"`；`interface EtlRunDedupeRow { runId: number; inputRows: number; contained: number; exactDuplicates: number; partialOverlaps: number; emitted: number; durationMs: number | null; startedAt: Date; finishedAt: Date | null }`；`insertEtlRunDedupe(pool: mysql.Pool, row: EtlRunDedupeRow): Promise<void>`；`getEtlRunDedupe(pool: mysql.Pool, runId: number): Promise<EtlRunDedupeRow | null>`；`etl_run_dedupe` 表列 `id`、`run_id`、`input_rows`、`contained`、`exact_duplicates`、`partial_overlaps`、`emitted`、`duration_ms`、`started_at`、`finished_at`、`idx_run` 与 `fk_etl_dd_run`。

- [ ] **Step 1: 写失败测试**

`test/unit/types.test.ts` 把 `Source is a union of three string literals` 改为 `Source covers the nine ingestion labels`：
```ts
const sources: Source[] = ["maxmind", "ip2region", "dbip", "dbip-country", "dbip-asn", "ipinfo", "metowolf-cn", "runishiwo-cn", "sapics-user"];
expect(sources).toHaveLength(9);
```
新建 `test/integration/etl-dedupe-storage.test.ts`：用 `createTestDb(\"etl-dedupe-storage\")` 建库 → `runMigrations(pool)` → 断言 `SHOW TABLES` 含 `etl_run_dedupe`、三张 side table 的 `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` 都含完整 7 值 ENUM；`recordEtlStart(pool)` 后对 7 个 `EtlRunDownloadSource` 逐个 `insertEtlRunDownload`（`status: \"success\"`）不报错；`insertEtlRunDedupe(pool, { runId, inputRows: 10, contained: 2, exactDuplicates: 1, partialOverlaps: 1, emitted: 6, durationMs: 12, startedAt: new Date(), finishedAt: new Date() })` 后 `getEtlRunDedupe(pool, runId)` 往返相等，未知 `runId` 返回 `null`。

`test/integration/migrations.test.ts` 把 `r.applied.sort()` 与 `r.skipped.sort()` 两个版本数组都补成 26 项（`001`–`008`、`010`–`027`，无 `009`），把 `expect(r.skipped.length).toBe(24)` 改为 `toBe(26)`，表清单加入 `etl_run_dedupe` 与 `mcp_tokens`。`test/integration/migrations.legacy.test.ts` 的版本数组同样补成 26 项，表清单加入 `etl_run_dedupe` 与 `mcp_tokens`，并把「11 expected tables」注释改为「13 expected tables」。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/types.test.ts test/integration/etl-dedupe-storage.test.ts test/integration/migrations.test.ts test/integration/migrations.legacy.test.ts`
Expected: FAIL（`Source` 不含新标签、`etl_run_dedupe` 不存在、版本数组停在 `025`）。

- [ ] **Step 3: 实现类型、迁移与存储 helper**

`src/types.ts` 扩展 `Source`。`src/storage/mysql.ts` 扩展 `EtlRunDownloadSource`，在 `getEtlRunSwap` 附近新增 `EtlRunDedupeRow`、`insertEtlRunDedupe`（参数化 `INSERT`，列与上表一一对应）、`getEtlRunDedupe`（`WHERE run_id = ? LIMIT 1`，无行返回 `null`）。`027_multi_source_etl.sql` 对三张表各写一段：
```sql
SET @sql := IF(EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_downloads'
       AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'
       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),
  'SELECT 1',
  'ALTER TABLE etl_run_downloads MODIFY COLUMN source ENUM(''dbip-city'',''dbip-country'',''dbip-asn'',''metowolf-cn'',''runishiwo-cn'',''runishiwo-v6'',''sapics-user'') NOT NULL');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
```
对 `etl_run_parses`、`etl_run_inserts` 复制同形状（只换表名），末尾追加：
```sql
CREATE TABLE IF NOT EXISTS etl_run_dedupe (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  input_rows BIGINT UNSIGNED NOT NULL,
  contained BIGINT UNSIGNED NOT NULL,
  exact_duplicates BIGINT UNSIGNED NOT NULL,
  partial_overlaps BIGINT UNSIGNED NOT NULL,
  emitted BIGINT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  INDEX idx_run (run_id),
  CONSTRAINT fk_etl_dd_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/types.test.ts test/integration/etl-dedupe-storage.test.ts test/integration/migrations.test.ts test/integration/migrations.legacy.test.ts`
Expected: PASS（含第二次 `runMigrations` 幂等断言，`r.applied` 为空）。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/storage/mysql.ts src/storage/migrations/027_multi_source_etl.sql test/unit/types.test.ts test/integration/etl-dedupe-storage.test.ts test/integration/migrations.test.ts test/integration/migrations.legacy.test.ts
git commit -m "feat(etl): add multi-source labels and dedupe run table"
```

---

### Task 2: 可辨识下载规格与七种 `--only` kind

**Files:**
- Modify: `src/etl/download.ts:20-60`
- Modify: `src/cli.ts:1`、`src/cli.ts` 的 `download` command
- Test: `test/unit/download.test.ts`、`test/unit/cli-download-kinds.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `EtlRunDownloadSource`。
- Produces: `DbipKind = \"city\" | \"country\" | \"asn\"`；`FixedKind = \"metowolf-cn\" | \"runishiwo-cn\" | \"runishiwo-v6\" | \"sapics-user\"`；`DownloadKind = DbipKind | FixedKind`；`interface SpecBase { destName: string; etlSource: EtlRunDownloadSource }`；`DbipSpec extends SpecBase { mode: \"monthly\"; kind: DbipKind; urlStem: string; validate: \"gzip\" }`；`FixedSpec extends SpecBase { mode: \"fixed\"; kind: FixedKind; urls: readonly string[]; format: \"cidr\" | \"country-csv\"; validate: \"text\" }`；`DownloadSpec = DbipSpec | FixedSpec`；`DEFAULT_SPECS: ReadonlyArray<DbipSpec>`、`EXTRA_SPECS: ReadonlyArray<FixedSpec>`、`ALL_SPECS: ReadonlyArray<DownloadSpec>`；`parseDownloadKinds(input: string | undefined): DownloadSpec[]`；`DownloadResult` 增加 `etlSource: EtlRunDownloadSource` 且 `month: string | null`；`DownloadFailure = { kind: DownloadKind; destName: string; etlSource: EtlRunDownloadSource; url: string; urls: readonly string[]; attemptCount: number; message: string }`；`DownloadAttempt.spec` 为 `DownloadSpec`，`month: string | null`。本任务不修改 `src/etl/pipeline.ts`；`runDownloadStage` 消费 `a.spec.etlSource` 的改动归 Task 6。

- [ ] **Step 1: 写失败测试**

在 `test/unit/download.test.ts` 保留并扩展 `DEFAULT_SPECS` 两个既有断言（`dbip.csv.gz → city`、三份 `urlStem` 顺序不变），新增 `it(\"EXTRA_SPECS pins the four fixed sources\", ...)`，逐项断言完整契约：
```ts
expect(EXTRA_SPECS.map((s) => [s.kind, s.destName, s.etlSource, s.format])).toEqual([
  ["metowolf-cn", "china-ipv4.txt", "metowolf-cn", "cidr"],
  ["runishiwo-cn", "china-v4.txt", "runishiwo-cn", "cidr"],
  ["runishiwo-v6", "china-v6.txt", "runishiwo-v6", "cidr"],
  ["sapics-user", "sapics-user-country.csv", "sapics-user", "country-csv"],
]);
expect(EXTRA_SPECS.map((s) => s.urls)).toEqual([
  ["https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt",
   "https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/special/china.txt"],
  ["https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v4.txt",
   "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v4.txt"],
  ["https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v6.txt",
   "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v6.txt"],
  ["https://github.com/sapics/ip-location-db/releases/download/latest/user-country.csv",
   "https://cdn.jsdelivr.net/gh/sapics/ip-location-db@latest/user-country.csv"],
]);
```
新建 `test/unit/cli-download-kinds.test.ts`：`parseDownloadKinds(undefined)` 返回 7 个 spec 且顺序为 `ALL_SPECS`；`parseDownloadKinds(\"city,sapics-user\")` 返回 `[DEFAULT_SPECS[0], EXTRA_SPECS[3]]`；`parseDownloadKinds(\"city,bogus\")` 抛 `Error` 且消息含 `bogus` 与七个合法 kind。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/download.test.ts test/unit/cli-download-kinds.test.ts`
Expected: FAIL（`EXTRA_SPECS`、`parseDownloadKinds` 未导出）。

- [ ] **Step 3: 实现规格与 CLI 选择**

`src/etl/download.ts`：把 `DownloadSpec` 换成上述可辨识联合，给 `DEFAULT_SPECS` 三份补齐 `mode: \"monthly\"`、`validate: \"gzip\"`、`etlSource`（`dbip-city`/`dbip-country`/`dbip-asn`），新增 `EXTRA_SPECS` 与 `ALL_SPECS`，扩展 `DownloadResult`/`DownloadFailure`/`DownloadAttempt`，新增 `parseDownloadKinds`（按 `kind` 在 `ALL_SPECS` 里查表，空串过滤，未知值汇总抛错）。`src/cli.ts`：删掉 `SPEC_BY_KIND`，`download` 的 `.description` 改为 `Fetch DB-IP monthly CSV.gz files and the four GitHub text sources into data/raw/ for the ETL pipeline`，`--only` 帮助文本列出 `city,country,asn,metowolf-cn,runishiwo-cn,runishiwo-v6,sapics-user`，action 用 `parseDownloadKinds(opts.only)`，捕获其 `Error` 后打印并以 `process.exit(2)` 退出；`downloadAll(specs, outDir)` 与 `failures.length > 0` 退出 1 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/download.test.ts test/unit/cli-download-kinds.test.ts && npx tsc --noEmit`
Expected: PASS 且 `tsc` 零错误（`DEFAULT_SPECS.map((s) => s.urlStem)` 仍能通过收窄）。

- [ ] **Step 5: Commit**

```bash
git add src/etl/download.ts src/cli.ts test/unit/download.test.ts test/unit/cli-download-kinds.test.ts
git commit -m "feat(etl): define discriminated download specs and seven CLI kinds"
```

---

### Task 3: 纯文本校验与 fixed 源刷新

**Files:**
- Modify: `src/etl/download.ts:121`、`src/etl/download.ts:290-511`
- Modify: `src/etl/sources/dbip.ts:45`（仅把 `parseCsvLine` 改为 `export`，不移动类型定义）
- Test: `test/unit/download.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `FixedSpec`、`EXTRA_SPECS`、`DownloadFailure`；现有 `downloadToFile(url, destPath, onProgress?, getImpl?)` 与 `validateGzFile`；`src/ip.ts` 的 `parseIp`。
- Produces: `validateTextFile(filePath: string, format: \"cidr\" | \"country-csv\"): Promise<string | null>`；`fetchFixedOneWithAttempts(spec: FixedSpec, outDir: string, onProgress?: DownloadProgressFn, getImpl?: typeof https.get): Promise<DownloadResult>`；`fetchOne(spec: DbipSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn): Promise<DownloadResult>` 保持兼容；`fetchOneWithAttempts(spec: DownloadSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn, getImpl?: typeof https.get): Promise<DownloadResult>` 按 `spec.mode` 分派；`replaceWithValidatedTemp(destPath: string, tmpPath: string, backupPath: string, renameImpl?: typeof fs.rename, rmImpl?: typeof fs.rm): Promise<void>`；`downloadAll(specs, outDir, now?, onProgress?, getImpl?: typeof https.get)` 返回 `{ results, failures, attempts }`。

- [ ] **Step 1: 写失败测试**

`test/unit/download.test.ts` 新增 `describe(\"validateTextFile\")` 与 `it(\"validateTextFile rejects empty, NUL, replacement char, HTML, comment-only and accepts a last line without newline\", ...)`：对空文件、`Buffer.from(\"1.2.3.0/24\\u0000\\n\")`、`Buffer.from(\"\\uFFFD\\n\")`、`Buffer.from(\"<!doctype html>\\n\")`、`\"# only a comment\\n\"` 分别断言返回非空问题说明；对 `\"1.2.3.0/24\\n4.5.6.0/24\"`（无尾换行）与 `\"1.2.3.0,1.2.3.255,CN\\n2001:db8::,2001:db8::ffff,CN\"` 分别断言 `null`；`country-csv` 探针拒绝 `\"not-an-ip,not-an-ip,CN\\n\"`。

新增 `describe(\"fixed URL refresh\")`，复用文件内已有 `stubGet`/`redirectGet` 形状，加一个按 URL 分发响应的 `urlStub(handlers)`，并写四条具名断言：`it(\"primary 500 falls back to the jsDelivr mirror\", ...)`、`it(\"fixed refresh keeps the previous cache intact and cleans every temp file\", ...)`、`it(\"mirror HTML error page leaves the previous cache intact\", ...)`、`it(\"replaceWithValidatedTemp renames back when the second rename throws\", ...)`。第 2 条还断言 `failures[0].urls` 为两个 URL、`attemptCount === 2`、`etlSource === \"runishiwo-v6\"`、`attempts` 中 fixed 失败行 `status === \"failed\"` 而非 `\"missing\"`、`errorMessage` 含两个 URL 与「刷新失败、复用旧缓存」；第 1 条断言 `results[0].month === null`、`results[0].url` 是镜像、`retryCount` 为 1。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/download.test.ts`
Expected: FAIL（`validateTextFile` / `fetchFixedOneWithAttempts` / `replaceWithValidatedTemp` 未导出）。

- [ ] **Step 3: 实现校验、刷新与原子替换**

`src/etl/sources/dbip.ts` 把 `parseCsvLine` 改为 `export`，供本任务与 Task 4 共用；本任务不改动该文件的类型定义。`validateTextFile` 用 `readline` 流式逐行读（不整文件入内存），拒绝空文件、NUL、U+FFFD、首行以 `<` 开头；CIDR 探针按 `/` 切分后用 `parseIp` 校验地址并按地址族检查前缀 `0..32`/`0..128`，country-csv 探针用 `parseCsvLine` 拆三列、`parseIp` 校验两端且要求两字母 `cc`；至少一行通过才返回 `null`。探针只做结构检查，不 import Task 4 的 `cidr.ts`/`sapicsCountry.ts`，也不回改下载层；`parseIp` 返回 `null` 的 IPv4-mapped IPv6 直接判为不可用行。
`fetchFixedOneWithAttempts` 逐个尝试 `spec.urls`，临时名 `${destName}.part-${process.pid}-${Date.now()}-${index}`、备份名 `${destName}.bak-${process.pid}-${Date.now()}-${index}`，`downloadToFile(url, tmpPath, onProgress, getImpl)` 成功后 `validateTextFile(tmpPath, spec.format)`，通过才 `replaceWithValidatedTemp`（旧文件 `rename` 到 backup → 临时文件 `rename` 到正式名 → `rm` backup；任一步失败删临时文件、还原 backup 并把错误并入下个 URL 的尝试）；全部 URL 失败时正式文件保持原样、临时与备份清零，抛带全部 URL 的汇总错误。
`fetchOneWithAttempts` 按 `mode` 分派；`downloadAll` 透传 `getImpl`，日志对 `month === null` 输出 `fixed`，attempt 汇总消息用 `a.url` 而非 `a.month`，monthly 全 404 仍折叠为 `missing`，fixed 全失败保留 `failures` 与 `failed` attempt 供 stage 落库；把模块级 `downloadAttempts` 的注释改为「每次 `downloadAll` 调用末尾由 `takeDownloadAttempts()` 排空」。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/download.test.ts`
Expected: PASS，且 `validateGzFile`、Content-Length 完整性、https 重定向三组既有用例保持 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/etl/download.ts src/etl/sources/dbip.ts test/unit/download.test.ts
git commit -m "feat(etl): refresh fixed text sources through a validated atomic swap"
```

---

### Task 4: CIDR 与 sapics 纯文本解析器

**Files:**
- Create: `src/etl/sources/types.ts`、`src/etl/sources/cidr.ts`、`src/etl/sources/sapicsCountry.ts`
- Modify: `src/etl/sources/dbip.ts:45-129`
- Test: `test/unit/cidr-source.test.ts`、`test/unit/sapics-country.test.ts`、`test/unit/dbip-stream-stats.test.ts`（回归）、`test/unit/download.test.ts`（回归）

**Interfaces:**
- Consumes: `src/ip.ts` 的 `parseIp`/`compareBuffers`；`src/country-names.ts` 的 `countryNamesFor(code)`；`src/types.ts` 的 `NormalizedRecord`/`Source`；Task 1 的 `EtlRunDownloadSource`；Task 3 已 export 的 `dbip.ts` `parseCsvLine`。
- Produces: `type AddressFamily = \"v4\" | \"v6\"`；`interface SourceRecord extends NormalizedRecord { etlSource: EtlRunDownloadSource; family: AddressFamily }`；`interface ParseSkipCounters { shortLine; headerRow; unparseableIp; missingCol; nonNumericAsn; other: number }`；`interface ParseStats { rowsEmitted: number; skipped: ParseSkipCounters; gunzipErrors: number }`；`interface ParseStreamResult<T extends NormalizedRecord = NormalizedRecord> { records: AsyncIterable<T>; stats: ParseStats }`；`newStats(): ParseStats`；`interface CidrRange { startIp: Buffer; endIp: Buffer; countryCode: string; family: AddressFamily }`；`parseCidrLine(line: string): CidrRange | null`；`parseMetowolfCidrStreamWithStats(p: string): ParseStreamResult<SourceRecord>`；`parseRunishiwoV4CidrStreamWithStats(p: string): ParseStreamResult<SourceRecord>`；`parseRunishiwoV6CidrStreamWithStats(p: string): ParseStreamResult<SourceRecord>`；`parseSapicsCountryCsvLine(line: string): CidrRange | null`；`parseSapicsCountryStreamWithStats(p: string): ParseStreamResult<SourceRecord>`。国家码用 `countryNamesFor(cc)` 做完整 ISO 3166-1 白名单：空值、`ZZ`、`CHN` 都返回 `null` 并计入 `missingCol`；不使用不存在的 `listCountryCodes()`，也不引用未导出的 `parseV4`/`parseV6`。

- [ ] **Step 1: 写失败测试**

`test/unit/cidr-source.test.ts` 的 `it(\"CIDR parser covers prefix boundaries and rejects bad prefixes\", ...)`：
```ts
expect(parseCidrLine("1.2.3.4/24")).toMatchObject({ countryCode: "CN", family: "v4" });
expect(parseCidrLine("1.2.3.4")).toMatchObject({ family: "v4" });
expect(parseCidrLine("2001:db8::1")).toMatchObject({ family: "v6" });
```
并覆盖 `0.0.0.0/0`、`1.2.3.4/32`、`::/0`、`2001:db8::/128` 的 `startIp`/`endIp` 精确 Buffer；`\"1.2.3.4/33\"`、`\"2001:db8::/129\"`、`\"garbage/24\"` 返回 `null`；`\"# comment\"`、`\"// comment\"`、空行不计入任何跳过桶。三个 `*WithStats` 入口在小临时 fixture 上断言 `stats.rowsEmitted`、`stats.gunzipErrors === 0`、非法行计入 `unparseableIp`、`start > end` 计入 `other`。
`test/unit/sapics-country.test.ts` 的 `it(\"sapics parser skips invalid country codes and IPv4-mapped IPv6\", ...)`：引号字段 `\"1.2.3.0\",\"1.2.3.255\",\"CN\"` 正常；空 `cc`、`ZZ`、`CHN` 计入 `missingCol`；`::ffff:1.2.3.4` 计入 `other`；v4 与 v6 混排时 `family` 分别正确且 `etlSource === \"sapics-user\"`、`source === \"sapics-user\"`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/cidr-source.test.ts test/unit/sapics-country.test.ts`
Expected: FAIL（三个新模块不存在）。

- [ ] **Step 3: 实现共用类型与三个解析入口**

`src/etl/sources/types.ts` 定义上表全部类型与 `newStats()`。`src/etl/sources/dbip.ts` 保留 Task 3 的 `parseCsvLine` export，删掉本地 `ParseSkipCounters`/`ParseStats`/`ParseStreamResult`/`newStats` 定义并 `export { ... } from \"./types\"`，三个 `*WithStats` 返回类型仍为 `ParseStreamResult`。
`src/etl/sources/cidr.ts`：掩码用 `BigInt` 在 16 字节上算（`family` 由输入是否含 `:` 决定；含 `:` 且含 `.` 的 IPv4-mapped 形式返回 `null`），共用内部 `parseCidrStreamWithStats(p, source, etlSource, defaultFamily)`，三个入口是薄封装，`source` 分别为 `metowolf-cn`/`runishiwo-cn`/`runishiwo-cn`，`countryCode` 恒 `\"CN\"`。
`src/etl/sources/sapicsCountry.ts`：`parseCsvLine` 拆三列，`startIp`/`endIp` 用 `parseIp`，`cc` 转大写后交给 `countryNamesFor(cc)`，返回 `null` 则计入 `missingCol`；v4/v6 由原始字符串判定；`readline` 逐行异步生成器不 gunzip，`gunzipErrors` 恒 0。本任务不修改 `src/etl/download.ts`，Task 3 的 `validateTextFile` 保持内联探针；下载层与解析层只共用 `parseCsvLine`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/cidr-source.test.ts test/unit/sapics-country.test.ts test/unit/dbip-stream-stats.test.ts test/unit/download.test.ts`
Expected: 四组全 PASS（DB-IP `*WithStats` 的 records 与 skip counters 不变，下载层文本校验回归通过）。

- [ ] **Step 5: Commit**

```bash
git add src/etl/sources/types.ts src/etl/sources/dbip.ts src/etl/sources/cidr.ts src/etl/sources/sapicsCountry.ts test/unit/cidr-source.test.ts test/unit/sapics-country.test.ts
git commit -m "feat(etl): parse CIDR and sapics country text sources"
```

---

### Task 5: 「大段覆盖小段」去重

**Files:**
- Create: `src/etl/sources/dedupe.ts`
- Test: `test/unit/dedupe.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `SourceRecord`、`AddressFamily`；`src/ip.ts` 的 `compareBuffers`；`src/types.ts` 的 `Source`。
- Produces: `DEDUPE_MAX_INPUT_ROWS = 1_000_000`；`interface DedupeStats { input: number; contained: number; exactDuplicates: number; partialOverlaps: number; emitted: number; emittedByFile: Partial<Record<EtlRunDownloadSource, number>> }`；`interface DedupeResult { records: SourceRecord[]; stats: DedupeStats }`；`dedupeSourceRecords(inputs: AsyncIterable<SourceRecord>): Promise<DedupeResult>`；`DEDUPE_CONFLICT_PRIORITY: Readonly<Record<\"sapics-user\" | \"runishiwo-cn\" | \"metowolf-cn\", number>>`（`sapics-user: 3`、`runishiwo-cn: 2`、`metowolf-cn: 1`）。优先级键是 `Source`，不是 `EtlRunDownloadSource`；`runishiwo-v6` 的记录因 `source === \"runishiwo-cn\"` 自动取优先级 2。`emittedByFile` 的键是 `EtlRunDownloadSource`。

- [ ] **Step 1: 写失败测试**

`test/unit/dedupe.test.ts` 用 `v4(start, end, etlSource, source)` / `v6(...)` 辅助函数构造 `SourceRecord[]`，在 `it(\"dedupe applies containment, exact-duplicate, partial-overlap and limit rules\", ...)` 与 `it(\"dedupe keeps v4 and v6 families separate\", ...)` 中断言：
```ts
// 完全包含：/16 保留，内部 /24 丢弃，contained=1
// 完全相同：合并为一条，exactDuplicates=1，冲突时 countryCode/source/etlSource 取 sapics-user
// 部分重叠：两段都输出，partialOverlaps=1
// 相接同国家码：不合并，emitted=2
// 跨族：v4 0.0.0.0/0 与 v6 ::/0 都输出，family 分组独立
// 空输入：input=0, emitted=0, emittedByFile={}
// 上限：1_000_001 条抛含 DEDUPE_MAX_INPUT_ROWS 的 Error
```
每个用例都断言 `Σ Object.values(emittedByFile) === stats.emitted === stats.input - stats.contained - stats.exactDuplicates`，且 `records[i].etlSource` 与 `emittedByFile` 的键一致；冲突替换用例额外断言优先级按 `record.source` 取值、`runishiwo-v6` 不另设键。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/dedupe.test.ts`
Expected: FAIL（`dedupeSourceRecords` 未定义）。

- [ ] **Step 3: 实现线性扫描去重**

算法（按族分开，各跑一遍）：按 `startIp` 字典序升序、`endIp` 降序排序（用 `compareBuffers`）；维护 `active: SourceRecord[]` 只保留 `end >= candidate.start` 的已输出段。对每个 candidate：若存在 `k` 满足 `compareBuffers(k.startIp, candidate.startIp) <= 0 && compareBuffers(k.endIp, candidate.endIp) >= 0` 且两者端点完全相同 → `exactDuplicates++`，按 `DEDUPE_CONFLICT_PRIORITY[record.source]` 决定保留哪个 `countryCode`/`source`/`etlSource`（替换已输出记录，不新增）；若仅被完全包含 → `contained++`，丢弃；若 `k.endIp >= candidate.startIp && k.endIp < candidate.endIp` → `partialOverlaps++`，输出 candidate（两段都留）；否则输出 candidate。输出后加入 `active` 并剪掉 `end < candidate.start` 的项。`emittedByFile` 按最终 `records[i].etlSource` 计数；冲突替换时先把旧记录的 `etlSource` 计数减一，再给胜出记录的 `etlSource` 加一。输入超过 `DEDUPE_MAX_INPUT_ROWS` 抛带业务上下文的 `Error`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/dedupe.test.ts`
Expected: PASS（含恒等式、优先级键与上限断言）。

- [ ] **Step 5: Commit**

```bash
git add src/etl/sources/dedupe.ts test/unit/dedupe.test.ts
git commit -m "feat(etl): dedupe new sources by containment, keeping the larger range"
```

---

### Task 6: Pipeline 编排与统计口径

**Files:**
- Create: `src/etl/sources/prepare.ts`
- Modify: `src/etl/pipeline.ts:38-76`（`StreamFile`/`DBIP_FILES`）、`src/etl/pipeline.ts:340-410`（`runParseStage`/`runInsertStage`）、`src/etl/pipeline.ts:610-859`（`runPipeline`）
- Test: `test/integration/etl-pipeline.test.ts`、`test/integration/etl-guards.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `insertEtlRunDedupe`；Task 2 的 `ALL_SPECS`、`DownloadSpec`、`parseDownloadKinds`；Task 4 的 `ParseStreamResult<SourceRecord>` 与四个解析入口；Task 5 的 `DedupeResult`。
- Produces: `interface StreamFile { source: Source; etlSource: EtlRunDownloadSource; filename: string; validate: \"gzip\" | \"text\"; textFormat?: \"cidr\" | \"country-csv\"; parse: (p: string) => ParseStreamResult; fillCols: ReadonlySet<keyof IpRangeRow>; dedupeGroup?: \"github-list\" }`；`interface GithubStreamFile extends Omit<StreamFile, \"parse\"> { parse: (p: string) => ParseStreamResult<SourceRecord> }`；`isGithubStreamFile(f: StreamFile): f is GithubStreamFile`；`SOURCE_FILES: ReadonlyArray<StreamFile>`（3 份 DB-IP + 4 份新源，新源 `fillCols` 只有 `countryCode`/`countrySource`）；`interface GithubPrepared { byFile: Map<EtlRunDownloadSource, ParseStats>; dedupe: DedupeResult }`；`prepareGithubSources(files: ReadonlyArray<GithubStreamFile>, rawDir: string): Promise<GithubPrepared>`；`runDownloadStage(pool, runId, rawDir, now, sink?, specs?: ReadonlyArray<DownloadSpec>): Promise<EtlRunDownloadRow[]>`；`runParseStage(pool, runId, rawDir, files, sink?, github?: GithubPrepared): Promise<EtlRunParseRow[]>`；`runInsertStage(pool, runId, rawDir, files, sink?, github?: GithubPrepared): Promise<EtlRunInsertRow[]>`。

- [ ] **Step 1: 写失败测试**

`test/integration/etl-pipeline.test.ts` 的 `beforeAll` 追加四份 fixed fixture：`china-ipv4.txt`（`1.0.0.0/8` + `1.2.3.0/24`）、`china-v4.txt`（`1.0.0.0/8`）、`china-v6.txt`（`2001:db8::/32`）、`sapics-user-country.csv`（`2.0.0.0,2.0.0.255,CN` + `2001:db8::,2001:db8::ffff,CN`），并注入 `download` stub 使集成测试永不触网。新增断言：
```ts
// 交换后 1.2.3.4 命中 DB-IP 的 9.9.9.x 之外的细段，
// 1.0.1.1 命中 metowolf/runishiwo 的 /8 且 countrySource 属于三个新标签
// getEtlRunDedupe(pool, runId) 的 emitted > 0 且满足计数恒等式
// etl_run_parses/inserts 四份新源的求和等于 dedupe.emitted
// lastEtlRun(pool).dbipRecords 只等于三份 DB-IP 的 rowsAttempted 之和
// result.merged === last.mergedRecords === 全部 insertRows 的 rowsAttempted 之和
```
把 `test/integration/etl-pipeline.test.ts:112` 的 `runIdOverride: undefined` 改为 `runId: undefined`；`src/etl/pipeline.ts:554-575` 的真实字段是 `runId?: number`，没有 `runIdOverride`。
`test/integration/etl-guards.test.ts` 的 `writeFixtures()` 追加同样四份 fixed 文本，并把文件内全部 `runPipeline({ cfg })` 改为 `runPipeline({ cfg, download: noDownload })`（`noDownload` 已在该文件定义），保证 fixed 每轮强制刷新不触网。新增 `it(\"github group zero-row warning\", ...)`、`it(\"github group emitted zero fails the run\", ...)`、`it(\"insertRowsTotal equals actual inserted rows\", ...)` 三条。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/etl-pipeline.test.ts test/integration/etl-guards.test.ts`
Expected: FAIL（四份 fixed fixture 未被消费、`etl_run_dedupe` 无行、`merged` 仍是 DB-IP 三份之和）。

- [ ] **Step 3: 实现编排**

`src/etl/sources/prepare.ts`：依次消费四份 `files` 的 `records` → 汇入一个 `SourceRecord[]` → `dedupeSourceRecords` → 按 `etlSource` 回填每份 `ParseStats`（`rowsEmitted` 取 `emittedByFile`，`skipped` 取原始解析统计，`gunzipErrors = 0`），返回 `GithubPrepared`；去重结果是物化的 `records` 数组，parse 与 insert 两阶段复用同一份，不写中间文件。
`src/etl/pipeline.ts`：`SOURCE_FILES` 由 `DBIP_FILES` 扩成 7 份并由 `filename` 反查 `ALL_SPECS`；`runDownloadStage` 用 `a.spec.etlSource` 替换三元链，按 `destName` 分两组：monthly 原样落 `attempts`（全 404 仍是 `missing`），不消费 `failures`；fixed 若 `attempts` 有 `success` 则落一条 `success`（`retryCount` 为前序失败 URL 数），否则把同 `destName` 的 `failures` 汇总成恰好一条 `failed`，`errorMessage` 含全部 URL 与「刷新失败、复用旧缓存」，忽略同 `destName` 的失败 attempt 明细，避免重复。缓存判定只把有效 gzip 缓存列入 `reusable` 记 `skipped`，四份 fixed 每轮都加入 `specs = dbipNeedDownloadSpecs + EXTRA_SPECS`；下载后硬校验遍历 `SOURCE_FILES` 按 `validate` 分派 `validateGzFile`/`validateTextFile`，最终缺失或校验不过整轮失败。`runParseStage`/`runInsertStage` 对 `dedupeGroup === \"github-list\"` 跳过原循环改用 `github`（insert 遍历 `github.dedupe.records` 按 1000 批写，`toIpRangeRow(rec, rec.source, fillCols)` 保持原签名，DB-IP 仍传 `f.source`），按 `rec.etlSource` 分桶写四行 `etl_run_inserts`；`emptySources` 分组（DB-IP 任一 0 失败、github 单文件 0 告警、`dedupe.emitted === 0` 失败）；`sink.onParseTotal` 累加去重后的 `rowsEmitted`；局部变量改名 `dbipCityRecords`/`dbipCountryRecords`/`dbipAsnRecords`，`recordEtlFinish` 的 `dbipRecords` 只含三份 DB-IP、`mergedRecords` 含全部 `insertRows`，`PipelineResult.merged` 返回后者。`preserveManualRows`/`atomicSwapRanges`/锁/失败标记不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/etl-pipeline.test.ts test/integration/etl-guards.test.ts && npx tsc --noEmit`
Expected: PASS 且 `tsc` 零错误（含 `runId` 修正）。

- [ ] **Step 5: Commit**

```bash
git add src/etl/pipeline.ts src/etl/sources/prepare.ts test/integration/etl-pipeline.test.ts test/integration/etl-guards.test.ts
git commit -m "feat(etl): ingest deduped GitHub ranges and widen the merged counter"
```

---

### Task 7: 后台 run-detail 与公开文档

**Files:**
- Modify: `src/web/routes/admin.ts:592`（`buildRunDetailCtx`）、`src/web/views/admin/etl-run-detail.hbs:173`、`src/web/views/marketing/docs.hbs:102`
- Modify: `src/web/i18n/zh-CN.json`、`src/web/i18n/en-US.json`
- Test: `test/integration/etl-run-detail-route.test.ts`、`test/integration/docs.test.ts`、`test/unit/hbs-views.test.ts`（回归）

**Interfaces:**
- Consumes: Task 1 的 `getEtlRunDedupe`；`buildRunDetailCtx` 既有 `Promise.all` 与返回上下文；`etl-run-detail.hbs` 的 4 张 `etl-stage-card-title`、三张 per-file 表与区外 `#etl-progress-bars`。
- Produces: `buildRunDetailCtx` 返回上下文新增 `dedupe: EtlRunDedupeRow | null` 与 `dedupeSummaryText: string | null`（route 里用 `req.t` 预解析参数化文案）；i18n 键 `admin.etl.runDetail.dedupeTitle`、`admin.etl.runDetail.dedupeBody`、`docs.sourceNote`（中英各一份）。

- [ ] **Step 1: 写失败测试**

`test/integration/etl-run-detail-route.test.ts` 的 `src/storage/mysql` import 列表补 `insertEtlRunDedupe`；`beforeAll` 追加 `insertEtlRunDedupe(app.pool, { runId: finishedRunId, inputRows: 20, contained: 5, exactDuplicates: 2, partialOverlaps: 1, emitted: 12, durationMs: 3, startedAt: new Date(), finishedAt: new Date() })`，并把 `it(\"renders full run detail with stage cards + per-file tables\", ...)` 扩展断言 `r.text` 含 `去重`、`20`、`12`，同时保持 `expect(cardMatches.length).toBe(4)`、`dbip-city`、`dbip-country`、`etl-skip-details`、`8300020` 既有断言不变。
`test/integration/docs.test.ts` 新增 `it(\"GET /docs explains that source is an open label\", ...)`：英文 cookie 断言 `r.text` 含 `metowolf-cn`、`runishiwo-cn`、`sapics-user` 与 `source`；中文 cookie 断言含「实际入库来源」与三个标签。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/etl-run-detail-route.test.ts test/integration/docs.test.ts`
Expected: FAIL（页面无去重组、文档无 `source` 说明）。

- [ ] **Step 3: 实现后台与文档**

`src/web/routes/admin.ts`：`Promise.all` 加 `getEtlRunDedupe(app.pool, id)`，返回上下文加 `dedupe` 与 `dedupeSummaryText`（用 `req.t(\"admin.etl.runDetail.dedupeBody\", { input: ..., contained: ..., emitted: ... })` 在服务端填好参数）。`src/web/views/admin/etl-run-detail.hbs`：在 inserts 表之后、`{{!-- Error banners --}}` 之前插入 `{{#if dedupe}}` 汇总段，标题 `dedupeTitle`、正文 `dedupeSummaryText`，并列出 `partialOverlaps`/`exactDuplicates`；必须留在 `<section class=\"etl-stage-live\">` 内，不新增 `etl-stage-card-title`，不动 `</section>` 之后的进度条与脚本。`src/web/views/marketing/docs.hbs:102` 的 `docs.responseBody` 之后追加一段 `<p>{{req.t \"docs.sourceNote\"}}</p>`，示例里四处 `\"maxmind\"` 保持原样。两个 i18n 文件补 `docs.sourceNote`（中文说明 `source` 返回实际入库标签、可能取 `metowolf-cn`/`runishiwo-cn`/`sapics-user`，英文同义）与 `admin.etl.runDetail.dedupeTitle`/`dedupeBody`（含 `{input}`、`{contained}`、`{emitted}` 占位）。所有新增 HBS 注释用 `{{!--`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/integration/etl-run-detail-route.test.ts test/integration/docs.test.ts test/unit/hbs-views.test.ts`
Expected: PASS（66 视图编译检查通过，4 张 stage card 不变）。

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/admin.ts src/web/views/admin/etl-run-detail.hbs src/web/views/marketing/docs.hbs src/web/i18n/zh-CN.json src/web/i18n/en-US.json test/integration/etl-run-detail-route.test.ts test/integration/docs.test.ts
git commit -m "feat(admin): surface dedupe totals and document open source labels"
```

---

### Task 8: 回归测试补齐与全量验证

**Files:**
- Modify: `test/integration/find-range.test.ts`、`test/integration/etl-pipeline.test.ts`、`test/integration/stats-route.test.ts`、`test/unit/mcp-tools.test.ts`
- Verify: `up/dist/`、`src/cli.ts`、`src/mcp/tools.ts`、`src/api/routes/stats.ts`

**Interfaces:**
- Consumes: Task 1–7 全部产出；`insertIntoNewUpsert(pool, rows, fillCols)` 的 `COALESCE` 语义；`findRange` 的最小 `range_size` 优先；`/stats` 的 `sources.dbip.records` 与 `mergedRecords`；`src/mcp/tools.ts` 的 `EtlStatusResult.sources`。
- Produces: 无新生产接口；交付一份全绿验证记录与 `up/dist/` 是否需要同步的结论，本计划不执行同步。

- [x] **Step 1: 写失败测试**

`test/integration/find-range.test.ts` 新增 `it(\"fillCols never overwrites existing fine-grained columns\", ...)`：先用完整 `fillCols` 插入一条带 `city`/`latitude`/`asn`/`countrySource: \"dbip\"` 的段，再用 `new Set([\"countryCode\", \"countrySource\"])` 对同一 `(startIp, endIp)` 插入 `countryCode: \"CN\"`、`countrySource: \"metowolf-cn\"`，`atomicSwapRanges` 后断言 `city`、`latitude`、`asn` 未变且 `countryCode`/`countrySource` 仍是 DB-IP 的值；另新增 `it(\"findRange still picks the smallest covering range after deduped big ranges\", ...)`，断言大段与细段共存时 `findRange` 仍返回最小 `range_size` 段。
`test/integration/etl-pipeline.test.ts` 新增两条：`it(\"pipeline reuses a valid old cache after a failed refresh\", ...)`（`download` stub 不写文件、返回一条 `failed` 行，旧 fixed fixture 保持），断言 run 成功、`etl_run_downloads` 有 `failed` 无对应 `skipped`、parse/insert 计数一致；`it(\"pipeline fails without a valid old cache\", ...)`（先删 `china-v6.txt`），断言 `runPipeline` 抛错、run 记 `failed` 且 `ip_ranges` 未被交换。
`test/integration/stats-route.test.ts` 与 `test/unit/mcp-tools.test.ts` 各新增 `it(\"stats and MCP keep the DB-IP-only dbip counter\", ...)`：前者把 `recordEtlFinish` 改为 `{ mergedRecords: 42, dbipRecords: 30 }`，断言 `res.body.lastRun.mergedRecords === 42` 且 `res.body.lastRun.sources.dbip.records === 30`；后者把 mock 改为 `merged_records: 8940000`、`dbip_records: 8000000`，断言 `res.lastRun.mergedRecords === 8940000` 且 `res.lastRun.sources.dbip.records === 8000000`。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/integration/find-range.test.ts test/integration/etl-pipeline.test.ts test/integration/stats-route.test.ts test/unit/mcp-tools.test.ts`
Expected: FAIL（新用例因缺失 `failed` 记录、旧缓存路径或 DB-IP-only 口径断言未接线而失败）。

- [x] **Step 3: 补齐回归实现**

修正 Task 6/7 中任何未满足断言的最小实现（优先修编排与记录写入，不重构无关代码）；核实 `src/mcp/tools.ts` 与 `src/api/routes/stats.ts` 仍只读 `last.dbipRecords`/`last.mergedRecords`、不新增响应字段；核实 `src/cli.ts` 的七个 kind 与 `ALL_SPECS` 顺序一致。发布包本任务只检查、不改写：若后续确需同步，顺序是 `npm run build` → `npm run sync:release` → `npm run check:release`，其中 `check:release` 只校验 `up/dist/` 与 manifest 一致，不证明 `src/` 已编译进 `dist/`；本计划不执行这三条发布命令。

- [x] **Step 4: 运行全量验证确认通过**

Run: `npm run test:unit && npm run test:integration && npm run lint && npm run check:release`
Expected: 四条命令全部 exit 0；`test:unit`/`test:integration` 无 FAIL；`lint` 的 `tsc --noEmit` 与 `eslint .` 零错误；`check:release` 无 drift，但仅作为 manifest 一致性检查，不作为源码同步证据。再做一次真实网络手工冒烟：`npm run dev -- download --only metowolf-cn,runishiwo-cn,runishiwo-v6,sapics-user`，确认四份文件落到 `data/raw/` 且 `validateTextFile` 通过；该冒烟不进 CI、不写测试断言。

- [x] **Step 5: Commit**

```bash
git add test/integration/find-range.test.ts test/integration/etl-pipeline.test.ts test/integration/stats-route.test.ts test/unit/mcp-tools.test.ts src/etl/pipeline.ts src/web/routes/admin.ts
git commit -m "test(etl): pin column preservation and failed-refresh fallback paths"
```
