# IP 地理位置聚合查询服务 — 设计文档

**日期**：2026-08-13
**状态**：待用户审阅
**作者**：Brainstorming 会话

---

## 1. 目标与摘要

构建一个轻量级、自托管的 IP 地理位置查询服务。它从多个开源 / 免费数据源（MaxMind GeoLite2、ip2region、DB-IP）按"主源优先 + 备源补字段"策略聚合数据，每天自动更新，通过 HTTP REST API 对外提供查询能力。

代码以 MIT 协议开源；数据文件由使用者自行下载并遵守各源授权约束。

---

## 2. 范围与非目标

### 2.1 范围内
- 离线 ETL 任务，合并 3 个数据源到单一 MySQL 表
- HTTP REST API 提供单个 IP 查询
- 每天自动 ETL（内置 cron 调度）
- 配置文件 `.env` 管理密钥和数据库连接
- Docker Compose 一键部署（MySQL + 服务）
- 完整的单元 / 集成 / 端到端测试

### 2.2 非目标（本次不做）
- 批量查询接口
- 多语言 SDK（Python / Go / Java 等）
- 商业级 SLA 与多区域容灾
- 内置 HTTPS 终止（由反向代理负责）
- 多实例水平扩展
- 实时 BGP 流同步
- IPv6 地理位置精度优化（仅支持基础查询）
- 用户认证 / API Key（个人项目默认开放）

---

## 3. 需求摘要

| 维度 | 决策 |
|---|---|
| 使用场景 | 小型自用 / 个人项目 |
| 数据源 | MaxMind GeoLite2、ip2region、DB-IP |
| 查询粒度 | 国家 + 城市 + ISP/ASN + 经纬度（全集） |
| 授权策略 | 开源代码，运行时下载数据 |
| 数据更新 | 每天自动（cron，02:00） |
| 实现语言 | Node.js + TypeScript |
| 接口形式 | HTTP REST API |
| 聚合策略 | 主源优先 + 备源补字段（默认：maxmind > ip2region > dbip） |
| 数据库 | MySQL 8 |

---

## 4. 架构总览

```
┌──────────────────────────────────────────────────┐
│  ETL Pipeline (每日02:00 cron / 手动 ipq update) │
│                                                   │
│  MaxMind .mmdb ─┐                                 │
│  ip2region .xdb ─┼─ 解析 → 主源合并 → MySQL       │
│  DB-IP .csv.gz ─┘                                 │
└──────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────┐
│  MySQL                                              │
│  ├─ ip_ranges (start_ip, end_ip, country,           │
│  │   city, isp, asn, lat, lon, source_*)            │
│  └─ etl_runs (运行日志)                              │
└──────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────┐
│  HTTP API (Fastify)                                  │
│  ├─ GET /lookup?ip=...                             │
│  ├─ GET /healthz                                   │
│  └─ GET /stats                                     │
└──────────────────────────────────────────────────┘
```

### 仓库结构

```
ipquery/
├── src/
│   ├── cli.ts              # 命令行入口（update/serve/status）
│   ├── config.ts           # 环境变量 / 配置加载
│   ├── types.ts            # IpRecord / LookupResult 等
│   ├── etl/
│   │   ├── pipeline.ts     # ETL 协调
│   │   ├── downloader.ts   # HTTP 下载 + 重试
│   │   ├── merger.ts       # 主源合并逻辑
│   │   └── sources/
│   │       ├── maxmind.ts
│   │       ├── ip2region.ts
│   │       └── dbip.ts
│   ├── storage/
│   │   ├── mysql.ts        # 连接池 + 查询封装
│   │   └── schema.sql      # 表结构
│   └── api/
│       ├── server.ts       # Fastify 启动
│       └── routes/
│           ├── lookup.ts
│           ├── health.ts
│           └── stats.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── fixtures/
│   ├── maxmind-sample.mmdb
│   ├── ip2region-sample.xdb
│   └── dbip-sample.csv.gz
├── docker-compose.yml      # MySQL + 服务
├── .env.example
├── README.md
└── package.json
```

---

## 5. 数据模型

### 5.1 `ip_ranges` 表

存储聚合后的最终记录。每条记录对应一个 IP 区间（IPv4 用 `BINARY(16)` 前 12 字节补 0 存储，IPv6 用原生 16 字节）。

```sql
CREATE TABLE ip_ranges (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  start_ip BINARY(16) NOT NULL,
  end_ip   BINARY(16) NOT NULL,
  country_code CHAR(2) NULL,
  country_name VARCHAR(64) NULL,
  region      VARCHAR(64) NULL,
  city        VARCHAR(128) NULL,
  postal_code VARCHAR(32) NULL,
  latitude    DECIMAL(9,6) NULL,
  longitude   DECIMAL(9,6) NULL,
  timezone    VARCHAR(64) NULL,
  isp         VARCHAR(128) NULL,
  asn         INT UNSIGNED NULL,
  asn_org     VARCHAR(128) NULL,
  -- 来源追溯：每个字段来自哪个源
  country_source VARCHAR(16) NULL,
  city_source    VARCHAR(16) NULL,
  isp_source     VARCHAR(16) NULL,
  asn_source     VARCHAR(16) NULL,
  geo_source     VARCHAR(16) NULL,
  INDEX idx_start_end (start_ip, end_ip)
);
```

### 5.2 `etl_runs` 表

记录 ETL 运行历史，便于运维和故障追踪。

```sql
CREATE TABLE etl_runs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  started_at  DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  status ENUM('running','success','failed') NOT NULL,
  maxmind_records INT UNSIGNED NULL,
  ip2region_records INT UNSIGNED NULL,
  dbip_records INT UNSIGNED NULL,
  merged_records INT UNSIGNED NULL,
  error_message TEXT NULL,
  maxmind_built_at DATETIME NULL,
  ip2region_built_at DATETIME NULL,
  dbip_built_at DATETIME NULL
);
```

### 5.3 TypeScript 类型

```ts
export type Source = 'maxmind' | 'ip2region' | 'dbip';

export interface NormalizedRecord {
  startIp: Buffer;     // 16 字节
  endIp: Buffer;
  countryCode?: string;
  countryName?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  asn?: number;
  asnOrg?: string;
  source: Source;
}

export interface LookupResult {
  ip: string;
  country: { code?: string; name?: string; source: Source };
  region?: string;
  city?: { name?: string; source: Source };
  postalCode?: string;
  location?: { lat: number; lon: number; source: Source };
  timezone?: string;
  isp?: { name?: string; source: Source };
  asn?: { number: number; org?: string; source: Source };
  etag: string; // 数据版本，如 '2026-08-12T02:00:00Z'
}
```

---

## 6. ETL 流程

每天 02:00（或手动 `ipq update`）执行，5 步：

### Step 1 — 下载
- **MaxMind**：通过官方 API 下载 `GeoLite2-City` 和 `GeoLite2-ASN`，需 `MAXMIND_LICENSE_KEY`
- **ip2region**：从 GitHub release 下载 `ip2region.xdb`
- **DB-IP**：从 `https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.csv.gz` 下载免费城市版
- 下载带 3 次重试 + 指数退避（5s / 15s / 45s）
- 下载到 `data/raw/` 临时目录
- 每个源独立下载，**单源失败不阻塞其他源**

### Step 2 — 解析到 `NormalizedRecord[]`
- **MaxMind**：用 `maxmind` 库打开 .mmdb，遍历内部 IPv4/IPv6 树，提取所有 CIDR 块并归一化
- **ip2region**：用官方 xdb 解析器，按段读索引，遍历所有 v4 + v6 段
- **DB-IP**：流式解析 .csv.gz，每行 `start_ip,end_ip,country,region,city,lat,lon`

### Step 3 — 主源合并（`merger.ts`）
- 配置主源优先级（默认：`maxmind > ip2region > dbip`）
- 合并规则：
  ```
  对每个字段（country, city, isp, asn, geo）：
    1. 取主源字段，若非空 → 使用，记录 *_source = 主源
    2. 否则取第一个非空的备源字段，记录 *_source = 备源
  ```
- 输出统一的 `NormalizedRecord[]`
- **不同源覆盖不同 CIDR 时共存为多条记录**（不强制去重）

### Step 4 — 写入 MySQL（原子切换）
- 新数据写入临时表 `ip_ranges_new`
- 完成后单事务：`RENAME TABLE ip_ranges TO ip_ranges_old, ip_ranges_new TO ip_ranges, ip_ranges_old TO ip_ranges_new`（再清空为下次用）
- 失败时保留旧表不切换，记录错误

### Step 5 — 记录 `etl_runs`
- 写入运行日志：开始/结束时间、各源记录数、合并后记录数、错误信息、各源数据 `built_at`

### 并发模型
- 3 个源解析阶段并行（`Promise.all`）
- 写入阶段串行（数据库连接池单连接，避免锁竞争）

---

## 7. HTTP API

**框架**：Fastify。**端口**：默认 `3000`（`PORT` 环境变量覆盖）。

### `GET /lookup`
查询单个 IP 的地理位置。

请求：
```
GET /lookup?ip=8.8.8.8
GET /lookup/8.8.8.8   # 路径风格也支持
```

响应 200：
```json
{
  "ip": "8.8.8.8",
  "country": { "code": "US", "name": "United States", "source": "maxmind" },
  "region": "California",
  "city": { "name": "Mountain View", "source": "maxmind" },
  "postalCode": "94043",
  "location": { "lat": 37.4056, "lon": -122.0775, "source": "maxmind" },
  "timezone": "America/Los_Angeles",
  "isp": { "name": "Google LLC", "source": "maxmind" },
  "asn": { "number": 15169, "org": "GOOGLE", "source": "maxmind" },
  "etag": "2026-08-12T02:00:00Z"
}
```

### `GET /healthz`
存活探针，不查 DB，返回 `200 {"status":"ok"}`。

### `GET /stats`
返回 ETL 状态和记录数：
```json
{
  "lastRun": {
    "startedAt": "2026-08-13T02:00:00Z",
    "finishedAt": "2026-08-13T02:04:23Z",
    "status": "success",
    "mergedRecords": 4123456,
    "sources": {
      "maxmind": { "records": 3200000, "builtAt": "2026-08-12" },
      "ip2region": { "records": 850000, "builtAt": "2026-08-10" },
      "dbip": { "records": 4100000, "builtAt": "2026-08-11" }
    }
  }
}
```

### 中间件
- 请求日志：pino（Fastify 内置）
- CORS：默认允许所有
- Rate limit：默认 60 req/min/IP（`RATE_LIMIT` 调整）
- 响应压缩：gzip

### 性能
- MySQL 查询：单条 SQL `WHERE start_ip <= INET6_ATON(?) AND end_ip >= INET6_ATON(?) LIMIT 1`
- 连接池大小：默认 10（`DB_POOL_SIZE`）
- 启动时预热一次查询

---

## 8. 错误处理

### ETL 阶段

| 失败点 | 行为 | 阻塞? |
|---|---|---|
| 数据源下载失败 | 重试 3 次后标记该源失败 | 不阻塞 |
| 数据源解析失败 | 跳过该源，记录错误 | 不阻塞 |
| 合并阶段失败 | 整个 ETL 失败 | 阻塞 |
| MySQL 写入失败 | 不切换 `RENAME`，旧表保持 | 阻塞 |
| `MAXMIND_LICENSE_KEY` 未配置 | 仅 MaxMind 源跳过 | 不阻塞 |

### API 阶段

| 错误 | HTTP 状态 | 响应体 |
|---|---|---|
| IP 格式无效 | 400 | `{ error: 'invalid_ip', message }` |
| IP 合法但无记录（内网/保留段）| 404 | `{ error: 'not_found', ip }` |
| 数据库连接失败 | 503 | `{ error: 'service_unavailable' }` |
| Rate limit 超限 | 429 | `{ error: 'rate_limited', retryAfter }` |
| 进程 panic | 500 | `{ error: 'internal_error' }` |

**关键原则**：
- 不暴露数据库错误细节、堆栈、连接字符串
- 失败可观测：ETL 失败 → 写 `etl_runs.status='failed'`，可被 `/stats` 看到
- 降级：单源失败不阻塞整体 ETL

### 日志
- 启动横幅：版本、配置摘要（不打印密钥）、监听端口
- 请求日志：`{ time, ip, status, latency, etag }`
- ETL 日志：每个阶段开始/结束 + 关键计数
- 错误日志：完整堆栈 + 上下文

---

## 9. 测试策略

**框架**：Vitest（TypeScript 原生、快、和 Fastify 生态契合）。

### 单元测试（`test/unit/`）
- `ip-parse.test.ts`：IPv4/IPv6 解析、转 `Buffer(16)`、边界值
- `merger.test.ts`：主源优先、备源补字段、字段标记、空值处理
- `downloader.test.ts`：网络失败 + 重试退避
- `config.test.ts`：环境变量校验、默认值、密钥脱敏

### 集成测试（`test/integration/`）
- `etl-pipeline.test.ts`：fixture 数据（每源几百行）→ 完整 ETL → 断言行数和字段
- `mysql.test.ts`：临时数据库、`RENAME` 原子性
- `api.test.ts`：supertest 启动 Fastify，覆盖所有状态码

### 端到端测试（`test/e2e/`）
- 一次性脚本：fixture ETL → 启动服务 → curl 真实查询 → 关闭
- 验证 IPv4 + IPv6 都返回正确国家

### Fixture 数据
`fixtures/` 提供小型样本：
- `maxmind-sample.mmdb`：从官方测试数据裁剪
- `ip2region-sample.xdb`：工具生成的小段
- `dbip-sample.csv.gz`：手工构造的几行

不依赖网络和外部账号，**所有 fixture 提交到仓库**。

### 覆盖率目标
- 核心路径（merger / parse / IP 转换） ≥ 90%
- 整体 ≥ 70%

---

## 10. 部署与运维

### 安装

**方式 A：源码**
```bash
git clone <repo>
cd ipquery
npm install
cp .env.example .env   # 填入 MAXMIND_LICENSE_KEY 等
npm run build
node dist/cli.js update # 首次 ETL
node dist/cli.js serve  # 启动 API
```

**方式 B：docker-compose（推荐）**
仓库自带 `docker-compose.yml`，一键拉起 MySQL + 服务：
```yaml
services:
  mysql:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: rootpass
      MYSQL_DATABASE: ipquery
    volumes: [mysql_data:/var/lib/mysql]
    ports: ["3306:3306"]
  ipquery:
    build: .
    depends_on: [mysql]
    environment:
      DB_HOST: mysql
      MAXMIND_LICENSE_KEY: ${MAXMIND_LICENSE_KEY}
    command: ["node", "dist/cli.js", "serve"]
    ports: ["3000:3000"]
volumes:
  mysql_data:
```

### 环境变量（`.env.example`）

```bash
# MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=rootpass
DB_NAME=ipquery
DB_POOL_SIZE=10

# 数据源
MAXMIND_LICENSE_KEY=__your_maxmind_license_key__
MAXMIND_EDITIONS=GeoLite2-City,GeoLite2-ASN

# API
PORT=3000
RATE_LIMIT=60

# ETL 调度
ETL_SCHEDULE=0 2 * * *
```

### 调度
- 进程启动时按 `ETL_SCHEDULE`（cron）触发 `update`
- 同一时刻已有 ETL 运行时跳过，避免重叠
- `ipq update --once` 单次跑后退出（手动 / CI 用）

### 数据持久化
- MySQL 数据：docker-compose 已卷挂载
- 下载的原始数据：`./data/raw/`（`.gitignore` 已排除）
- ETL 临时表：自动管理

### 健康检查
- 容器化时配 `HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/healthz`
- 日志走 stdout，便于 Docker / k8s 收集

---

## 11. 授权与合规

| 项 | 处理 |
|---|---|
| 代码许可 | MIT |
| 数据文件分发 | **不能随仓库分发**（MaxMind EULA 约束） |
| MaxMind GeoLite2 | 用户需注册账号并同意 EULA，通过 `MAXMIND_LICENSE_KEY` 下载 |
| DB-IP | CC-BY 4.0，UI 和 README 需注明来源 |
| ip2region | Apache-2.0，需保留许可声明 |

README 必须包含：
- 各数据源注册 / 下载步骤
- 各数据源授权摘要
- 重申明：本仓库不包含任何数据文件

---

## 12. 未来扩展（不在本次范围）

- 批量查询接口
- 多种语言 SDK
- 缓存层（Redis）加速热点 IP
- IPv6 精度优化
- 多实例部署 + 负载均衡
- HTTPS 终止支持
- 商业级 SLA、监控、告警
- 实时 BGP 流同步