# 多源 ETL：GitHub CIDR/国家区间源接入设计（2026-11-15）

## 意图与非目标

用户要求「增加数据源：metowolf/iplist、runishiwo/ChinaIPlist、sapics/ip-location-db，所有的数据通过去重再累计」，并明确「所谓的去重是覆盖大段覆盖小段 保留大段」。三个源与现有 DB-IP 月度库一起，累计进同一张 `ip_ranges` 表；新增源的段先按包含关系去重（被大段完全覆盖的小段丢弃、相同区间合并、保留大段），再入库。

背景：现有 ETL 只下载 DB-IP 三份按月发布的 `.csv.gz`（city/country/asn-lite），parse → 1000 行一批 `INSERT ... ON DUPLICATE KEY UPDATE col = COALESCE(col, VALUES(col))` 进 `ip_ranges_new` → `preserveManualRows` → RENAME 原子交换。第三方 API 回补是另一条路径（未知 IP → `unknown_ip_queue` → 多 provider 投票 → `/32`、`/128` 手工行），不在本次改动内。

- **目标**：三个 GitHub 源共四份文件每轮 ETL 可独立下载、解析、去重、累计入库；DB-IP 的行与查询行为不被破坏；失败时拒绝交换；后台 run-detail 能看到新源。
- **非目标**：改动 `findRange`（仍是「最小覆盖段优先」）；改动第三方 provider 回补；接入 MaxMind / ip2region；把 metowolf 253 个国家文件全量拉取；引入新第三方依赖；新增 `etl_runs` 列或改动 `/stats`、MCP `EtlStatusResult` 的响应结构。
- **反目标（会让功能即使跑通也算失败）**：把「大段覆盖小段」应用到 DB-IP 的 894 万条精细行——那会删掉城市/经纬度/ASN，且与 `findRange` 的最小段优先相反；或者把半截文件、空文件、HTML 错误页、解析不出行的文件当成有效源交换到线上表。四份 GitHub 文件每轮都要刷新；刷新失败时只允许降级复用**上一轮完整且通过校验**的缓存，且必须在 run-detail 留下 `status: "failed"`、正文写明「刷新失败、复用旧缓存」的可见记录，不能用 `status: "skipped"` 掩盖这次失败。

## 已核实的源事实

| 源 | 固定 URL | 格式 | 规模 |
|---|---|---|---|
| metowolf/iplist | `https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt`（备用 `cdn.jsdelivr.net/gh/metowolf/iplist@master/data/special/china.txt`） | IPv4 CIDR 逐行，无注释、无 IPv6 | 5567 行，每小时更新 |
| runishiwo/ChinaIPlist | `https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v4.txt` + `cn_v6.txt`（备用 jsDelivr `@main/...`） | `#` 注释头 + CIDR 逐行；全部 CN；v4/v6 分文件，不用合并的 `cnip.txt` | 约 7550 + 2593 行，每日聚合 |
| sapics/ip-location-db | `https://github.com/sapics/ip-location-db/releases/download/latest/user-country.csv`（备用 `cdn.jsdelivr.net/gh/sapics/ip-location-db@latest/user-country.csv`） | 纯文本 CSV `start_ip,end_ip,country_code`，IPv4/IPv6 混排 | 约 25.22 MB，PDDL、每日 |

三者都是**纯文本**，不是 gzip。sapics 只取 `user-country`；`origin-asn.csv`（36.92 MB）与 DB-IP asn-lite 已有列冲突，`server-country`/`iptoasn-country`/`dbip-*`/`geolite2-*` 不取。Release 无校验和资产。

## 方案（用户已选 A）

- **A（选定）沿用现有骨架，去重只在新源之间做**：新增固定 URL 下载规格、纯文本校验、三个解析入口；新源归一化后统一扫描去重，只以 `countryCode`/`countrySource` 两列累计入库，DB-IP 三份文件与交换流程不动。
- **B（未选）全表全局去重**：连 DB-IP 一起扫描、只留大段。会清空全部精细行、反转查询取舍，用户已否。
- **C（未选）metowolf 拉全 253 个 `data/country/*.txt`**：世界覆盖更全，但每轮 253 次下载且与 DB-IP 大面积重复。用户已否。

选择 A 的代价：新源的大段与 DB-IP 的细段会同时存在于表中；查询时 `findRange` 的「最小段优先」让 DB-IP 细段胜出，大段只填补 DB-IP 未覆盖的地址。这是刻意保留的行为，不是待修的 bug。

## 关键约束

1. `Source` 联合类型与 `etl_run_downloads/parses/inserts.source` 的 ENUM 都必须扩容；后者从迁移 019 的 `ENUM('dbip-city','dbip-country','dbip-asn')` 增加 4 个标签（下一个迁移号 027，三张表各一条语句，用 `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` 判断是否已含全部新值，缺才 `ALTER TABLE ... MODIFY COLUMN`，沿用迁移 020 的动态 SQL 幂等手法）。标签须 ≤16 字符，四个新值都满足。
2. 三种标签各有用途，不能混用，也不能靠字符串推断：

   | 文件 | `Source`（写入 `country_source`、出现在公开 API） | `EtlRunDownloadSource`（side tables ENUM） | `DownloadKind`（CLI `--only`） |
   |---|---|---|---|
   | `dbip.csv.gz` | `dbip` | `dbip-city` | `city` |
   | `dbip-country.csv.gz` | `dbip-country` | `dbip-country` | `country` |
   | `dbip-asn.csv.gz` | `dbip-asn` | `dbip-asn` | `asn` |
   | `china-ipv4.txt`（metowolf） | `metowolf-cn` | `metowolf-cn` | `metowolf-cn` |
   | `china-v4.txt`（runishiwo） | `runishiwo-cn` | `runishiwo-cn` | `runishiwo-cn` |
   | `china-v6.txt`（runishiwo） | `runishiwo-cn` | `runishiwo-v6` | `runishiwo-v6` |
   | `sapics-user-country.csv` | `sapics-user` | `sapics-user` | `sapics-user` |

   `Source` 只增 3 个值（runishiwo 的 v4/v6 共用一个入库来源标签）；`EtlRunDownloadSource` 与 `DownloadKind` 各增 4 个文件级值。`DbipSpec` 也带 `etlSource`，让 `DownloadAttempt.spec.etlSource` 覆盖全部七个标签，`runDownloadStage` 可删掉现有的 `kind === "city" ? ...` 三元链。
3. `country_code CHAR(2)`、`*_source VARCHAR(16)`：sapics 的 `country_code` 必须校验为两字母 ISO 码，空值/`ZZ`/超长一律跳过并计数。
4. IPv4 在本库是「前 12 字节为 0、后 4 字节为地址」的 BINARY(16)，IPv6 是完整 16 字节；两者在同一张 BINARY(16) 表中按字典序排列时，IPv4 段全部排在 IPv6 段之前，去重扫描可分区处理但不能混比较。
5. `range_size BIGINT UNSIGNED` 上限 2^64−1，IPv6 大段会被 clamp；去重只在 16 字节 Buffer 上比较，不依赖 `range_size`。
6. 现有 `downloadToFile` 可复用（https→文件流、单次 https 重定向、Content-Length 校验、120s 超时、64KB 进度粒度），但 `fetchOne*` 把 URL 写死成 DB-IP 月度地址、`validateGzFile` 只认 gzip、解析器 `streamGzippedCsv` 只认 gzip——这三处要分别扩，不能改坏 DB-IP 路径。
7. `downloadToFile` 在 Content-Length 不符时会 `unlink(destPath)`（`src/etl/download.ts:268`）。因此 fixed 源**绝不能直写正式目标文件**，否则一次刷新失败就会删掉上一轮完整缓存，降级复用无从谈起。
8. 不引入新 NPM 包；Node ≥20、TypeScript 严格类型、Vitest。全部面向用户的文字为中文，代码注释可用英文（与现有文件一致）。

## 设计

### 1. 下载层（`src/etl/download.ts`）

`DownloadSpec` 改为可辨识联合，`kind` 必须是显式字面量联合——若写成 `string`，`src/cli.ts` 的 `Record<DownloadSpec["kind"], DownloadSpec>` 会退化成 `Record<string, ...>`，`--only` 校验与类型收窄一起失效：

```ts
export type DbipKind = "city" | "country" | "asn";
export type FixedKind =
  | "metowolf-cn"
  | "runishiwo-cn"
  | "runishiwo-v6"
  | "sapics-user";
export type DownloadKind = DbipKind | FixedKind;

interface SpecBase {
  destName: string;
  etlSource: EtlRunDownloadSource;
}
export interface DbipSpec extends SpecBase {
  mode: "monthly";
  kind: DbipKind;
  urlStem: string;
  validate: "gzip";
}
export interface FixedSpec extends SpecBase {
  mode: "fixed";
  kind: FixedKind;
  urls: readonly string[];          // 主 URL + 备用镜像，顺序即优先级
  format: "cidr" | "country-csv";   // 决定 validateTextFile 用哪个探针
  validate: "text";
}
export type DownloadSpec = DbipSpec | FixedSpec;
```

- `DEFAULT_SPECS` 保持三份 DB-IP（仅补 `mode`/`validate`/`etlSource` 字段）；新增 `EXTRA_SPECS` 四份固定文件：`china-ipv4.txt`、`china-v4.txt`、`china-v6.txt`、`sapics-user-country.csv`。所有新文件都落在同一个 `${dataDir}/raw/`，文件名不冲突。
- `fetchOneWithAttempts` 按 mode 分派：monthly 走现有 6 个月回溯、直写 `destName`，行为不变；fixed 逐个尝试 `urls`，成功时 `month = null`、`source_url` 为实际命中的 URL。`fetchOne` 保持 DB-IP 兼容签名。
- **fixed 刷新的临时文件与原子替换**：每次 URL 尝试写到同目录下的 `${destName}.part-${process.pid}-${Date.now()}-${index}`；`downloadToFile` 返回后先 `validateTextFile(tmpPath, spec.format)`，通过才做三步替换：旧文件存在则 `fs.rename(destPath, backupPath)` → `fs.rename(tmpPath, destPath)` → `fs.rm(backupPath, { force: true })`。任一步失败则删除 `tmpPath`、把 `backupPath` 还原成 `destPath`，继续尝试下一个 URL。全程不依赖 Windows/Linux 对 `rename` 覆盖已存在目标的行为差异。全部 URL 失败时正式文件保持上一轮原样，临时文件全部清理。
- `validateTextFile(filePath, format): Promise<string | null>`：流式逐行读取（不把 25MB 读进内存），拒绝空文件、NUL 字节、UTF-8 解码替换字符 U+FFFD、以 `<` 开头的 HTML/XML 错误页；并要求至少一行通过对应格式探针（`cidr` 探针要求合法 CIDR/纯 IP，`country-csv` 探针要求 `start,end,cc` 三列且 IP 可解析）。最后一行允许无换行。返回问题说明，形状与 `validateGzFile` 一致。`validateGzFile` 不变；缓存复用判定按 `spec.validate` 分派。
- `DownloadFailure` 扩充为 `{ kind, destName, etlSource, url, urls, attemptCount, message }`，携带全部尝试过的 URL 与汇总错误；`DownloadResult` 增加 `etlSource`，`kind` 类型改用 `DownloadKind`。`downloadAll` 的日志对 `month === null` 输出 `fixed`，attempt 汇总消息用 `a.url` 而非 `a.month`（现值会拼出 `null:...`）。fixed 源全部 URL 失败时**不折叠成 `status: "missing"`**（那是「月度候选全 404」的语义），保留 `failures` 汇总供 stage 层落一行 `failed`。
- **缓存与失败语义（两类源分开）**：
  - DB-IP monthly：沿用现有行为。磁盘上存在且 `validateGzFile` 通过的列入 `reusable`，本轮不下载，run-detail 记 `status: "skipped"`；缺失或损坏才下载。
  - 四份 GitHub fixed：**每轮无条件刷新**，不写 `skipped`。刷新成功落一条 `success`（`source_url` 为命中 URL，`retryCount` 记前序失败 URL 数，`errorMessage` 摘要镜像回退过程）；刷新失败落**恰好一条** `status: "failed"`，`errorMessage` 列出全部失败 URL 与原因并明确写「刷新失败、复用旧缓存」，不冒充本轮成功。
  - `runDownloadStage` 消费 `downloadAll` 的 `failures`：对 monthly 沿用现有 attempts 落库（只把 `source` 换成 `spec.etlSource`），不重复消费 `failures`；对 fixed 按 `destName` 归并，每个 spec 只落上述一条结果行。`status` 不新增 ENUM 值。
  - 下载后硬校验遍历 `SOURCE_FILES`，按 `validate` 分派：刷新失败但旧缓存完整且通过校验 → 允许本轮复用并继续（失败已留痕）；任何文件最终缺失或校验不过 → 整轮失败、不交换。`ipq download` CLI 仍按 `failures.length > 0` 退出 1。
- `SPEC_BY_KIND` 由 `[...DEFAULT_SPECS, ...EXTRA_SPECS]` 构建，`--only` 默认值同步扩到七个 kind。

### 2. 解析层（`src/etl/sources/`）

抽出共用的 `ParseStats`/`ParseStreamResult`（从 `dbip.ts` 导出或移到 `src/etl/sources/types.ts`），新解析器返回同一形状，让 parse/insert 两个阶段无需分支。

- `cidr.ts`：`parseCidrLine(line)` → `{startIp, endIp, countryCode}`，支持 `#`/`//` 注释、空行、纯 IP（按 `/32`、`/128` 处理）、IPv4 `/0..32`、IPv6 `/0..128`；掩码用 BigInt 按 16 字节计算，非法前缀/非 CIDR 行计入 `unparseableIp`，`start > end` 计 `other`。metowolf 与 runishiwo 的 `countryCode` 一律 `CN`。导出两个 `*WithStats` 入口，内部是 `readline` 逐行异步生成器（不 gunzip）。
- `sapicsCountry.ts`：逐行 CSV（把 `dbip.ts` 的 `parseCsvLine` export 后复用），`start,end,cc`；`cc` 两字母校验；按 16 字节 Buffer 的字典序把每行分派到 v4/v6 两个区间集合；`parseIp` 不接受 IPv4-mapped IPv6，遇到就跳过计数。
- 三个源的解析跳过计数都写进 `etl_run_parses`，`gunzipErrors` 对纯文本恒为 0。

### 3. 去重层（新增 `src/etl/sources/dedupe.ts`）

这是「大段覆盖小段」的唯一实现点，**只吃三个新源**，绝不读 `ip_ranges_new` 里的 DB-IP 行。

- 所有新源记录（无论来自哪个文件）汇入统一的 `RangeSet`，按地址族（v4/v6）分开，每条 `{startIp, endIp, countryCode, source, etlSource}`。
- 每族按 `startIp` 升序、`endIp` **降序**排序（大段先到）。单次线性扫描，维护当前活跃大段：
  - `start >= active.start && end <= active.end` → 小段被覆盖，丢弃（计数 `contained`）。
  - 相同 `(start,end)` → 合并；若国家码冲突按 `sapics-user > runishiwo-cn > metowolf-cn` 的确定性优先级保留大段的信息（计数 `exactDuplicates`）。
  - 部分重叠（小段跨出大段尾部）→ **保留两段**，不裁剪、不合并；记录 `partialOverlaps` 但不静默丢数据。
  - 相接且国家码相同的相邻段 → 不合并（用户只要求包含去重；合并会改变 `findRange` 的最小段语义）。
- 输入规模上限约 100 万条（实际远小于此），内存放得下；排序前对每族做防御性上限检查，超限则整轮失败而不是 OOM。
- 输出是物化后的记录序列 + 统计 `{input, contained, exactDuplicates, partialOverlaps, emitted, emittedByFile}`；`emittedByFile` 按 `etlSource` 分组，供 parse/insert 两个阶段的每行记录保持同一口径。
- **计数恒等式（必须成立并由集成测试断言）**：`Σ emittedByFile === emitted === Σ etl_run_parses.rowsEmitted(四份新源) === Σ etl_run_inserts.rowsAttempted(四份新源)`。`sink.onParseTotal` 累加去重后的 `rowsEmitted`，进度条总量因此等于实际写入行数，不会停在 99%。
- 去重统计落库：新增 `etl_run_dedupe` 表（迁移 027），列为 `id`、`run_id`、`input_rows`、`contained`、`exact_duplicates`、`partial_overlaps`、`emitted`、`duration_ms`、`started_at`、`finished_at`，带 `idx_run` 与到 `etl_runs` 的外键。后台 run-detail 显示一行汇总，不新增 UI 页面。

### 4. Pipeline 编排（`src/etl/pipeline.ts`）

- `DBIP_FILES` 改名/扩成 `SOURCE_FILES`：前三份不变，新增四份 `StreamFile`，`fillCols` 只有 `{countryCode, countrySource}`；每份带 `dedupeGroup: "github-list"` 标记。
- 下载判定循环覆盖所有文件，按 `spec.validate` 分派校验：DB-IP 有效缓存进 `reusable` 并记 `skipped`；四份 fixed specs 每轮都加入传给 `downloadAll` 的 `specs`（`dbipNeedDownloadSpecs + EXTRA_SPECS`），由下载层负责临时文件与原子替换。`specs` 由 `StreamFile.filename` 反查 `DEFAULT_SPECS + EXTRA_SPECS`，不再硬编码三份。下载后硬校验同样覆盖所有文件（刷新失败但旧缓存完整 → 复用并留痕；任何源最终缺文件或校验不过 → 整轮失败、不交换）。
- parse 阶段：DB-IP 三份照旧各自走；四份新源走「统一解析 → 去重 → 物化」一次，写四行 `etl_run_parses`，每行的 `rowsEmitted` 取 `emittedByFile.get(f.etlSource)`，`rowsSkipped*` 记该文件原始解析跳过数，`gunzipErrors = 0`；`etl_run_dedupe` 记汇总。
- **零行保护按组区分**：DB-IP 三份 `rowsEmitted === 0` 仍整轮失败（现有 `emptySources` 检查不变）；新源单份为 0 只告警（合法情形：该文件全部小段被别的文件大段覆盖）；但 `etl_run_dedupe.emitted === 0` 整轮失败。`present.length === 0` 与 `insertedRows === 0` 两道现有保护不动。
- insert 阶段：DB-IP 三份照旧按优先级先写；新源去重结果最后写，`fillCols` 只含两列，靠 `COALESCE` 语义**只填补** DB-IP 留空的 `country_code`/`country_source`，不覆盖任何 city/region/lat/lon/asn。与已有 `(start,end)` 完全相同的段只补缺列，不产生新行。
- **统计口径**：`dbipRecords` 字段仍只含三份 DB-IP 的 `rowsAttempted` 之和，`mergedRecords` 改为 `SOURCE_FILES` 全部（含去重后的新源）的 `rowsAttempted` 之和；`PipelineResult.merged` 返回后者。局部变量改名 `dbipCityRecords`/`dbipCountryRecords`/`dbipAsnRecords`，避免与字段 `dbipRecords` 混淆。不新增 `etl_runs` 列，不改 `/stats` 与 MCP `EtlStatusResult` 的响应结构——`sources.dbip.records` 继续只报 DB-IP 规模，`mergedRecords` 数值变大但语义仍是「本轮全部写入行数」。
- `runPipeline` 的 `download` 测试 seam 签名里 `ReadonlyArray<DownloadSpec>` 自动兼容联合类型；现有按字段名构造 stub 的测试需检查并补齐新字段。
- `preserveManualRows` 与 `atomicSwapRanges` 顺序、锁、失败标记逻辑一律不动。

### 5. CLI / 后台 / 类型 / 对外契约

- `src/types.ts` 的 `Source` 增加 `metowolf-cn`、`runishiwo-cn`、`sapics-user`；`src/storage/mysql.ts` 的 `EtlRunDownloadSource` 增加四个文件级标签。
- **公开契约按枚举扩展处理，不做 API 层映射**：`lookup-core.ts` 与 `marketing.ts` 的 `row.countrySource ?? "maxmind"` 原样透出新标签，因此 `/lookup`、`/try`、`_try-result.hbs` 会直接显示 `metowolf-cn` 等实际入库来源。`src/web/views/marketing/docs.hbs` 的示例可继续用 `"maxmind"`，但必须补一句说明 `source` 返回实际入库标签、可能取 `metowolf-cn`、`runishiwo-cn`、`sapics-user` 等值，不能让文档承诺一个封闭枚举。相关测试断言相应更新。
- `ipq download`：描述改为「DB-IP + GitHub 源」，`--only` 支持七个 kind，`--out` 行为不变。
- 后台 run-detail 的 downloads/parses/inserts 表格目前用 `<code>{{this.source}}</code>` 原样渲染，无需标签映射；若 `admin.ts` 存在硬编码颜色/状态列表，补上新标签与去重汇总行；不新增页面、不改动商业画布样式。
- 迁移 027：三张 `etl_run_*` 表的 `source` ENUM 幂等扩容 + `etl_run_dedupe` 建表（`CREATE TABLE IF NOT EXISTS`）；MySQL 5.7 兼容、每条 DDL 尽量合并（本机每条 DDL 约 0.9s）。`ip_ranges_new LIKE ip_ranges` 不受影响（ENUM 只在 side tables）。

### 6. 验证

- 单元测试：CIDR 解析（v4/v6 边界 `/0`、`/32`、`/128`，非法前缀、注释行、纯 IP）；sapics CSV（引号、非法 cc、v4/v6 混排）；去重（包含、完全相同、部分重叠、跨族不相干、国家码冲突、空输入、上限与 `emittedByFile` 恒等式）；`validateTextFile`（空文件、NUL、HTML 错误页、无尾换行、只有注释无合法行）；fixed URL 下载（主 URL 失败→镜像成功、全部失败后旧缓存完好且临时文件清零、attempt 与 `DownloadFailure` 字段）；`insertIntoNewUpsert` 的 `fillCols` 不覆盖既有列（扩展已有测试）；`DownloadSpec["kind"]` 的字面量收窄（类型层由 `lint` 保证）。
- 集成测试：用小样本文件跑完整 pipeline（注入 download stub），断言 `ip_ranges_new` 中新源只补 `country_code`、DB-IP 行仍在、去重计数落库、交换后 `findRange` 对覆盖地址返回最细段；断言 `/stats` 的 `sources.dbip.records` 只含三份 DB-IP 而 `mergedRecords` 含全部源；再跑一次「刷新失败但旧缓存完整」路径，断言 run-detail 有 `failed` 行、无 `skipped` 掩盖、parse/insert 计数一致；最后跑「刷新失败且无旧缓存」路径，断言整轮失败且 `ip_ranges` 未被交换。
- `npm run test:unit`、`npm run test:integration`、`npm run lint`（`tsc --noEmit` + eslint）全绿；真实网络下载只做一次手工冒烟，不进 CI；检查 `up/dist/` 这个已提交的 release bundle 是否需要同步。

## 我已定下的调用（请一并审阅）

builder-check 提出三处会改变实现结果的分歧，按「只有一个合理答案、不值得再打断你」处理如下：

1. **缓存与失败语义**：DB-IP 沿用有效缓存记 `skipped`；四份 GitHub 文件每轮强制刷新，临时文件 + 原子替换保证失败不毁旧缓存；刷新失败留一条 `failed` 且正文写明「复用旧缓存」，无完整缓存则整轮失败、不交换。不新增 `status` ENUM 值。
2. **统计口径**：`dbipRecords` 只含三份 DB-IP，`mergedRecords` 扩到全部源；不动 `etl_runs` schema，不动 `/stats` 与 MCP 响应结构。理由是 `sources.dbip.records` 是公开的 DB-IP 规模指标，混入 GitHub 行数会让监控误报。
3. **Source 公开契约**：不做 API 层映射，把新标签视为 `LookupResult.country.source` 的枚举扩展，`/lookup` 与 `/try` 原样透出，`docs.hbs` 补说明。理由是映射会掩盖真实入库来源，而 `country_source` 列本身就是给调用方看的溯源字段。

另外两处实现缺口一并定死：`FixedSpec.kind` 必须是显式字面量联合（否则 `SPEC_BY_KIND` 失去收窄）；fixed 源不得直写正式目标文件（`downloadToFile` 失败时会 `unlink`，会删掉可复用的旧缓存）。

## 留给 builder 的调用

- 去重结果在 parse/insert 两次之间的物化方式（临时纯文本文件 vs 内存快照复用），只要满足上面的计数恒等式并由集成测试证明一致即可。
- 新源标签在后台 run-detail 的中文显示名与颜色（当前模板原样渲染 `<code>`，可以不加映射）。
- sapics `country_code` 是否查完整 ISO 3166-1 白名单（最低要求是两字母形态校验）。
- 单元测试文件的具体拆分与命名。

## 风险与边界

- GitHub raw 在国内网络时通时断：主 URL + jsDelivr 备用必须都记录失败原因；四份文件任一刷新失败且没有完整旧缓存即整轮失败。有旧缓存时允许复用，但 run-detail 必须是 `failed` 而非 `skipped`，绝不把旧数据记成「本轮下载成功」。
- sapics `latest` Release 每天可能换内容，无校验和；只做结构校验（非空、可解码、至少一行三列合法记录），内容正确性由解析跳过计数暴露。
- 新源大段与 DB-IP 细段共存，`findRange` 的 `LIMIT 100` 仍够用（一个地址上最多多出 1–2 个粗段）。
- `country_source` 最长 16 字符，所有新标签已核过长度；ISO 码超长会触发 MySQL 严格模式报错，必须在解析器里挡掉。
- 迁移 027 修改 ENUM 涉及三张表的 DDL，本机约 3 秒；`ip_ranges_new LIKE ip_ranges` 不受影响（ENUM 只在 side tables）。
