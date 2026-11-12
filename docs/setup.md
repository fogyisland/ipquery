# 初始化部署指南

从一台干净的机器到「能登录、能查询」的 IPQuery 实例。两条路径：

- **A. Web 向导（推荐）** —— 浏览器里走 7 步，适合第一次部署、想看到界面的人。
- **B. CLI 无头初始化** —— 一条命令，适合 Ansible / Terraform / CI。

两种方式效果一致：跑完迁移、建管理员、标记已初始化。`/init` 一旦标记完成即返回 404，
之后所有改动都走管理后台。

---

## 0. 前置条件

| 项目         | 要求                         | 说明                                            |
| ------------ | ---------------------------- | ----------------------------------------------- |
| Node.js      | **>= 20**（CI 用 20）        | `node -v` 确认                                  |
| MySQL        | **5.7 / 8.0+**，需 `utf8mb4` | 迁移里含 `utf8mb4_unicode_ci` 与 JSON 列        |
| 操作系统     | Windows / Linux / macOS      | 构建与启动不依赖 Docker                         |
| MaxMind 许可 | 可选                         | 仅影响 MaxMind 数据源；DB-IP / ip2region 不需要 |
| 数据库磁盘   | **>= 20 GB**                 | 全量 ETL 后 `ip_ranges` 约 3 GB（815 万行）+ 临时表 + 索引 |
| `DATA_DIR`   | **>= 1 GB**                  | DB-IP 原始 CSV.gz 共约 93 MB |

MySQL 5.7 用户注意：迁移脚本不使用 `ADD COLUMN IF NOT EXISTS`，而是逐列查
`INFORMATION_SCHEMA` 判断是否缺失，因此 5.7 可以正常执行。全新库建表约需 40 秒
（每条 DDL 约 0.9 秒，慢盘上更久），属正常现象。

---

## 1. 准备数据库

新建一个空库即可 —— 表结构由迁移脚本创建，**不需要手工导入任何 schema**。

```sql
CREATE DATABASE ipquery DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- 生产环境不要用 root，单独建账号并只授权本库
CREATE USER 'ipquery'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON ipquery.* TO 'ipquery'@'localhost';
FLUSH PRIVILEGES;
```

如果用 root，确认 `DB_PASSWORD` 与 `.env` 一致。数据库口令、`SESSION_SECRET`、
`CSRF_SECRET` **只写进本机 `.env`**，任何提交进版本库的文件都不允许出现真实凭据。

---

## 2. 配置 `.env`

仓库只提供 `.env.example`；`.env` 由服务在**首次启动时自动生成**，且已被
`.gitignore` 忽略。

**不用手工建这个文件。** 解压后直接起服务：

```bash
node dist/cli.js serve
```

进程启动的第一件事就是检查 `.env`：

- **没有 `.env`** → 从 `.env.example` 生成一份，写入端口、访问地址和两把
  随机密钥，然后**用这份文件里的值来配置自己**（生成发生在读取配置之前，
  所以这一次启动就生效，不需要重启）。
- **已经有 `.env`** → 原样保留，一个字节都不改。你的配置永远优先。

生成的 `.env` 是模板的完整拷贝：注释、全部键名都在，是一个人能读、之后
能改的文件。数据库连接留空 —— 那是第 3 步表单里填的东西。

> **为什么不手工 `cp .env.example .env`？** 复制出来的 `.env` 里
> `SESSION_SECRET` 是空的。空密钥比没有密钥更糟：文件存在，所以"有没有
> `.env`"的检查通过了，而每个会话 Cookie 都被空字符串签名。

打开 `/init` 后，第 1 步可以改端口和访问地址；数据库连接在第 3 步的表单里
填，同样会写进这个文件。

如果你想先手工准备好 `.env`（比如跑无头初始化、或者用 `ipq db` 命令），
那么按下面来：

```ini
# --- 必填 ---
DB_HOST=localhost
DB_PORT=3306
DB_USER=ipquery
DB_PASSWORD=<第 3 步设置的强口令>
DB_NAME=ipquery

SESSION_SECRET=<64 位随机串>
CSRF_SECRET=<另一条 64 位随机串>

WEB_BASE_URL=http://localhost:3880
PORT=3880

# --- 可选 ---
MAXMIND_LICENSE_KEY=     # 留空即跳过 MaxMind，DB-IP 数据源不受影响
SMTP_HOST=               # 留空时验证/重置邮件打印到 stdout
```

生成两把密钥（任选其一）：

```bash
# Linux / macOS / Git Bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# PowerShell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

> **`SESSION_SECRET` / `CSRF_SECRET` 的强制时机**：
>
> - **系统已初始化**（`settings.initialized_at` 有值）时缺任意一项，`buildServer()`
>   直接抛 `refusing to start in <env>: missing required env vars: ...`，
>   不会静默降级到内置默认值。已初始化的系统正是开始签发真实登录 Cookie 的地方，
>   用仓库里写死的 `"dev-only-secret-change-me"` 签名等于把会话密钥公开。
> - **系统尚未初始化**时允许用占位值启动，让首次运行向导能跑起来 ——
>   向导不采集密钥（它管的是数据库、站点、种子模式和��员账号），
>   此时若拒绝启动，`/init` 就永远打不开，安装无法完成。
> - 环境判定：`NODE_ENV` 未设或不是 `development`/`test` 时，一律按生产对待。
>   （项目里没有任何地方会设置 `NODE_ENV`，所以"未设"就是生产的默认状态。）
>
> 开发/测试环境（`NODE_ENV=development` 或 `test`）完全跳过这个检查。

生产环境额外设置：

```ini
COOKIE_SECURE=true                       # 走 HTTPS 时必须打开
WEB_BASE_URL=https://ipquery.example.com # 与实际上访问的域名一致，否则重定向出错
```

---

## 3. 安装与构建

```bash
npm install       # 或 make install
npm run build     # 或 make build：tsc -> dist/ 并复制 schema
```

`build` 只编译 TypeScript 并原样复制 `.hbs`。**模板语法错误不会在构建阶段暴露**，
要等某个路由渲染它时才 500 —— 所以改过 `.hbs` 之后务必跑
`npm run test:unit -- test/unit/hbs-views.test.ts`（逐个编译 66 个视图）。

---

## 4. 启动服务

Web 向导路径下，此时系统**尚未初始化**，必须先起服务：

```bash
node dist/cli.js serve      # 前台运行，Ctrl+C 停止
# 或 make run               # 等价，但会先跑一次 ETL 再服务
```

启动后进程监听 `PORT`（示例为 3880），日志里会出现 `[api] listening on :3880`。

### 数据库连不上也能起（仅向导模式）

**服务不要求数据库可用。** 首次安装时 `.env` 里往往还没有正确的库口令，
而向导（`/init`）正是用来设置它的 —— 如果服务因为连不上库就退出，
向导永远打不开，安装就卡死了。

所以数据库不可达时，服务**照常启动**，进入「仅向导模式」：

| 路径         | 行为                                                        |
| ------------ | ----------------------------------------------------------- |
| `/init*`     | 正常服务，向导可用                                          |
| `/assets/*`  | 正常服务（向导要样式表）                                    |
| `/healthz`   | **503**，body 标明 `degraded`（让负载均衡摘掉这个节点）      |
| `/lookup` 等 | **503**，纯文本说明「请先在 `/init` 配置数据库」             |
| 其它页面     | **302** 跳回 `/init`                                       |

日志里会有一行：

```
[api] the database could not be reached — running in setup-only mode.
```

在向导第 3 步填入正确的连接信息并保存后，**服务立即切换到正常模式**，
无需重启：向导会验证连接、写入 `.env`、重建连接池并跑完迁移。

连上库的这一刻，**每日 ETL 定时任务也会同时启动** —— 它跟服务是同一个
进程，所以不能在「还没有数据库」的时候排程（那会对着一个连不上的池子
反复报错），只能在数据库可用之后启动。第 3 步保存成功的那一刻正是
「数据库可用」的那一刻，所以定时任务就挂在那里。

> 只在**连不上**时降级。迁移脚本自身的 SQL 出错（比如重复列名）仍然会
> 让启动失败 —— 那是坏了的 schema，不是够不着的数据库，不能拿降级掩盖。

---

## 5. 路径 A：Web 向导（7 步）

浏览器打开 `http://localhost:3880/init`。未初始化时，除 `/init*`、`/healthz`、
`/lookup`、`/stats`、`/assets/*` 之外的所有地址都会被 302 重定向回 `/init`。

| 步骤       | 地址              | 做什么                                                         | 注意                                                          |
| ---------- | ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 环境     | `/init/env`      | 生成 `.env`：端口、访问地址 + 两把随机密钥                       | **不需要手工建 `.env`**；密钥由系统生成，不显示在页面上      |
| 2 数据库   | `/init/database` | 填写 host/port/user/password/db，保存即测试 + 建表 + 生效      | 口令**不显示**在页面上；保存后写入 `.env`（本地文件，不进版本库） |
| 3 站点     | `/init/site`     | 站点名称（1–128 字符，必填）+ 副标题（≤256）                   | 存进 `settings` 表，之后可在 `/admin/settings` 改             |
| 4 管理员   | `/init/admin`    | 邮箱 + 密码 + 昵称                                             | 密码 **≥10 位且同时含字母和数字**；昵称 1–64 字符             |
| 5 种子数据 | `/init/seed`     | 三选一：示例数据 / 真实数据（ETL）/ 跳过                       | 见下方说明                                                    |
| 6 完成     | `/init/complete` | 核对汇总，点「完成」                                           | 触发 `markInitialized()`，`/init` 立即锁死                     |

### 第 1 步：改端口和访问地址

`.env` 在**服务启动的时候**就已经生成好了（见第 2 节）。第 1 步做的是
**改**它：端口和访问地址可以填表单改，密钥不用管。

> **端口改了要重启。** 第 1 步写入的 `PORT` 对**当前进程**不生效，因为
> `dotenv` 在模块加载时就读完了。页面会明确提示「重启后生效」。
> 端口和启动时一致的话不用管这一步 —— 直接进第 3 步。

密钥**不会显示在页面上**，也不写进 URL —— 它们在启动时由服务端生成后直接
落盘。一个显示在 HTML 里的密钥会留在浏览器缓存、"查看源代码" 和中间代理的
日志里。页面上只告诉你"已设置"，不给值。

`.env` 只保存在这台机器上，不进版本库，权限收紧到 `600`。

### 第 3 步怎么工作

顺序是有讲究的：

1. **先测试再落盘** —— 连不上的口令不会被写进 `.env`。一个连不上的
   `.env` 比没有 `.env` 更糟：下次启动会死在它上面，而没有退路。
2. **重建连接池** —— 服务立刻指向新库，不用重启。
3. **跑迁移** —— 新库还没有表，第 4–6 步都要读表。
4. **写 `.env`** —— 数据库口令不能存在数据库里（数据库正是坏掉的那部分），
   也不能进版本库。`.env` 是失败启动和成功启动都能读到的地方。
   已有的 `DB_*` 行会被**就地替换**，不会追加出第二行同名的键。

第 3 步和第 4 步的顺序是**故意的**：连接成功不等于迁移能成功（账号可能没有
建表权限，库里也可能有冲突的旧结构）。如果先把 `.env` 写成新库，下次启动会
再迁一次、再失败一次，**而且直接把服务打挂** —— 运维回来看到的是一个死进程，
还得手工去改 `.env` 才能恢复。先迁移、后写盘，`.env` 里只可能躺着一个**已经
验证过能用的**数据库连接。

> 同一条规则也适用于 `ipq db` 命令（见 §6.0）：先迁表，再写 `.env`。

口令和其它密钥一样属于机密：`.env` 权限收紧到 `600`，且**不要**提交。

> 权限这件事有个容易忽略的细节：`writeFileSync` 的 `mode` 参数**只在新建文件时**
> 生效。而实际情况往往相反 —— 运维先把 `.env.example` 复制成 `.env`，复制会保留
> 源文件的 `644`。所以向导和 `db` 命令在写完之后会**显式 chmod 600**，不管文件是
> 新建的还是覆盖的。在 Linux/macOS 上可以直接确认：
>
> ```bash
> ls -l .env        # 期望: -rw-------  1 root root ... .env
> ```
>
> Windows 上 NTFS 的访问控制不由 POSIX 权限位决定，`chmod` 基本是个空操作 ——
> 真正的边界是 **ACL 和文件所在卷的加密状态**，不是权限位。

### 第 5 步的三种选择

- **示例数据（50 条）** —— 瞬时完成。手工精选的公共 DNS、知名云厂商与 RFC 保留段，
  用来先把页面点通、验证查询链路。**仅供开发与演示**，生产环境不要选。
- **真实数据（DB-IP，推荐）** —— 后台下载并导入 DB-IP 免费库
  （city-lite / country-lite / asn-lite，实测约 **815 万条** IP 段）。页面会显示进度并
  每 3 秒自动刷新，实测耗时约 **21 分钟**（见第 8 节），期间**可以关掉浏览器**，
  回来仍能看到进度。
  同一时刻只允许一个 ETL 运行，重复提交不会起第二个。
- **跳过** —— 保持空表，交给每日定时任务（`ETL_SCHEDULE`，默认每天 02:00 UTC）。

> **生产环境请选「跳过」或「真实数据」。** 示例数据是 50 条手工编造的地址，
> 它们**不会**被迁移自动灌入——曾经会，那导致一个跳过了种子步骤的数据库看起来
> 「有数据」，实际只有 50 条 demo 地址。现在示例数据只有在你明确选择时才会写入，
> 想在开发机上加载可以用 `node dist/cli.js seed:demo`。
>
> 后续跑 `node dist/cli.js update` 刷新真实库时，手工写入的行（unknown-IP 回填
> 生成的 `multi-provider` 记录）会被**保留**——ETL 只重建它自己那部分。

### 第 7 步之后

点「完成」后会被重定向到 `/login`。用第 5 步的管理员账号登录，进入 `/admin`。
此时 `/init` 返回 404 —— 这是设计行为，不是坏了。

### 常见卡点

| 现象                               | 原因                                   | 处理                                                     |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| 打开任何页面都跳 `/init`          | 尚未初始化                             | 正常，先走完向导                                         |
| `/init` 返回 404                  | **已初始化过**                         | 用管理员登录；要重跑向导需重置 `settings.initialized_at` |
| 启动日志说「仅向导模式」          | 数据库连不上                           | 正常，服务已起来；去 `/init` 第 3 步填连接信息           |
| 页面返回 503「仅向导模式」        | 数据库还连不上                         | 同上；`/healthz` 也返回 503，这是有意的                 |
| 第 3 步提示连接失败                | 口令不对 / MySQL 没起 / 库不存在       | 看提示里的具体原因（拒绝连接 / 凭据被拒 / 库不存在）    |
| 第 5 步报密码强度不足              | 少于 10 位 / 缺字母 / 缺数字           | 换一个更强的密码                                         |
| 提交表单报「会话已过期」           | CSRF 令牌过期（4 小时）                | 刷新页面重新提交                                         |
| 页面样式全丢、控制台报 MIME 类型错 | 撞上了限流，429 的 JSON 体被当成 CSS   | 已修为只限公共 API；旧版本升级到最新即可                 |

---

## 6. 路径 B：CLI 无头初始化

适合脚本化部署。需要一个能连上数据库的 `.env`（同第 3 步）。

### 6.0 先把数据库配好（可选）

如果 `.env` 里的数据库连接还没有配好，可以用 `db` 命令配 —— 它和向导第 3 步
做的是同一件事：

```bash
node dist/cli.js db \
  --host 127.0.0.1 \
  --port 3306 \
  --user ipquery \
  --name ipquery \
  --save
```

行为：

- **先测后写。** 连不上就报错退出，**`.env` 一个字节都不会动** —— 一份连不上的
  `.env` 比没有 `.env` 更糟，因为下次启动会直接死在它上面。
- **先迁表，后落盘。** 连接能通不代表建表能成功。迁移跑完之后才写 `.env`，
  所以 `.env` 里只可能是一个**已经验证过能用的**连接；迁移失败时 `.env` 原样不动，
  下次启动不会死在上面。
- 不带 `--save` 就只测不写，可以先拿它确认连接参数对不对。
- `--save` 会把连接写进 `.env`（就地替换 `DB_*` 那几行，其余内容保留），并
  **当场跑一遍迁移**，所以之后不必再手动 `migrate`。
- **口令不要写在命令行上** —— 命令行会进 shell 历史，也会出现在 `ps` 输出里。
  用环境变量传：

  ```bash
  export DB_PASSWORD='你的口令'
  node dist/cli.js db --host 127.0.0.1 --user ipquery --name ipquery --save
  ```

  `.env` 里已经有口令、只是想换个主机或库名时，口令可以不传，会沿用原来的。

### 6.1 建管理员

```bash
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD="$(openssl rand -base64 16)"   # 会自动满足强度规则
export ADMIN_NAME=Admin
export ADMIN_SEED=true                                # 可选：同时加载 50 条种子数据

make init
```

等价于：

```bash
node dist/cli.js init \
  --email admin@example.com \
  --password '<强口令>' \
  --name Admin \
  --seed
```

`init` 依次执行：跑迁移 → 创建（或提升）管理员 → 标记已初始化。

行为要点：

- **已初始化时默认拒绝执行**，只打印 `already initialized; pass --reinit to re-run`。
- `--reinit` 可以重跑，但**不清空数据**；且 `--email` 必须与已有管理员一致，
  否则报错并提示正确的邮箱（用于轮换管理员口令）。
- `--seed` 加载 50 条示例段（`node dist/cli.js seed:demo` 是同一份数据的独立命令）。
  **仅供开发**：生产环境不要加这个参数，改用 `node dist/cli.js update` 导入真实
  DB-IP 数据。想导入真实 DB-IP 数据，初始化后再手动跑 `node dist/cli.js update`。
- 口令强度不达标会直接报错，不会创建弱口令账号。

跑完后同样用 `node dist/cli.js serve` 启动，登录 `/login`。

---

## 7. 首次登录后的收尾

1. **确认数据** —— 访问 `http://localhost:3880/lookup?ip=8.8.8.8`，应返回国家/地区/城市。
   若返回未找到，说明第 6 步选了「跳过」，等定时任务或手动 `node dist/cli.js update`。
2. **改站点设置** —— `/admin/settings` 里 4 个标签页：通用、安全、集成、系统。
3. **配邮件**（可选）—— 在 `.env` 设置 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
   `SMTP_PASS` / `SMTP_FROM`，否则注册验证与找回密码的邮件只打印到 stdout。
4. **确认 ETL 计划** —— `ETL_SCHEDULE` 默认 `0 2 * * *`（`ETL_TIMEZONE=UTC`）。
5. **检查迁移状态** —— `node dist/cli.js migrate:status`，确认全部 `applied`。

---

## 8. ETL 全量导入的实测开销

以下数字来自 2026-11 在 Windows 11 / MySQL 8 的一次完整 ETL（run 3），用于估算
云端资源与耗时。数据源为 DB-IP 2026-11 免费库。

| 阶段           | 耗时      | 说明                                          |
| -------------- | --------- | --------------------------------------------- |
| 下载           | ~7 s      | 93 MB（city 82 MB + asn 7 MB + country 4.5 MB）|
| 解析 city      | 66 s      | 777 万行                                      |
| 解析 country   | 5 s       | 73 万行                                       |
| 解析 asn       | 3 s       | 49 万行                                       |
| **插入 city**  | **992 s** | 777 万行 —— **耗时大头**                     |
| 插入 country   | 97 s      | 73 万行                                       |
| 插入 asn       | 78 s      | 49 万行                                       |
| swap           | 0.2 s     | 原子 RENAME                                   |
| **合计**       | **~21 分钟** |                                        |

导入后的数据规模：

| 指标                   | 实测值            |
| ---------------------- | ----------------- |
| `ip_ranges` 行数       | 8,152,112         |
| `ip_ranges` 表 + 索引  | 约 3.0 GB         |
| 含 city 的行           | 7,777,727         |
| 含经纬度的行           | 7,777,815         |
| 含 ASN 的行            | 485,291           |

**要点**

- **内存**：插入阶段按 1000 行一批流式写入，内存占用平稳；但一次 ETL 会同时持有
  解析与插入两个阶段的缓冲。1 GB 内存的机器在插入 city 阶段可能被 OOM kill ——
  被 kill 后磁盘上会留下半截的 `.gz`，**旧的 ETL 会在下次运行时解析它并报
  `unexpected end of file`**。现在的 ETL 会检测并重新下载损坏的文件（见第 9 节），
  但跑之前仍建议给到 2 GB 以上。
- **耗时**：全量约 21 分钟，期间 `ip_ranges` 保持旧数据（swap 是原子的），查询不受影响。
- **定时任务**：`ETL_SCHEDULE` 默认每天 02:00 UTC 跑**全量**，即每天重下 93 MB
  并重导 815 万行。资源紧张时可改用 `ETL_CRON` 拉长周期，或改走增量策略。

---

## 9. 源文件完整性校验

ETL 会复用 `DATA_DIR/raw/` 下的 DB-IP 原始文件。**"文件存在"不等于"文件完整"** ——
一次被中断的下载会留下半截的 `.gz`，而旧版本会直接拿去解析并失败。

现在的行为：

1. **下载时**：`downloadToFile` 比对实际落盘字节数与 `Content-Length`，不一致就
   **删除半成品**再报错，不会让脏文件留在盘上。
2. **复用时**：对每个缓存文件做 gzip 校验（magic bytes + trailer ISIZE，流式解压，
   87 MB 文件约 4 秒、内存不涨）。损坏的文件会被**删除并重新下载**。
3. **缺失或损坏时不静默跳过**：任一源文件在下载阶段后仍不可用，或解析出 0 行，
   该次 ETL **直接失败**并保留旧数据，绝不把残缺的数据 swap 上线。

手工检查缓存文件：

```bash
gzip -t data/raw/*.csv.gz && echo "all intact"
```

---

## 10. 生产部署清单

- [ ] `COOKIE_SECURE=true`，`WEB_BASE_URL` 为真实 HTTPS 域名
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 为各自独立的随机值（不要复用）
- [ ] 数据库账号非 root，仅授权本库
- [ ] `.env` 权限收紧（Linux：`chmod 600 .env`），**不进入版本库**
      —— 向导和 `db` 命令在写完 `.env` 后会自动 chmod，但手工编辑过的 `.env`
      不会被自动收紧，仍需手工确认（`ls -l .env`）
- [ ] 用 systemd / pm2 / NSSM 托管 `node dist/cli.js serve`，不要靠前台终端
- [ ] 反代（Nginx / Caddy）转发 `X-Forwarded-For`，否则限流把所有人算成一个 IP
- [ ] `DATA_DIR` 指向容量足够的磁盘（DB-IP 原始 CSV.gz 约 93 MB）
- [ ] 数据库数据盘 >= 20 GB（全量导入后 `ip_ranges` 约 3.0 GB / 815 万行）
- [ ] 内存 >= 2 GB（全量 ETL 峰值在插入 city 阶段，1 GB 机器可能被 OOM kill）
- [ ] 首次部署后手动跑一次 `node dist/cli.js update` 并等它完成（约 21 分钟），
      确认 `node dist/cli.js status` 显示 `status: "success"` 且 `dbipRecords` 非 0

---

## 附：命令速查

| 命令                        | 作用                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `make install`              | `npm install`                                                                   |
| `make build`                | `tsc` + 复制 schema 到 `dist/`                                                  |
| `make init`                 | 无头初始化（读 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` / `ADMIN_SEED`） |
| `make migrate`              | 只跑迁移                                                                        |
| `make migrate-status`       | 列出已应用 / 待应用的迁移                                                       |
| `make create-admin`         | 只创建 / 提升管理员                                                             |
| `make run`                  | 跑一次 ETL 后启动服务                                                           |
| `node dist/cli.js serve`    | 直接启动服务（不先跑 ETL）                                                      |
| `node dist/cli.js db`       | 配置数据库连接：先测后写进 `.env`，`--save` 才落盘（见 §6.0）                  |
| `node dist/cli.js update`   | 手动跑一次 ETL                                                                  |
| `node dist/cli.js download` | 只下载 DB-IP 原始数据到 `data/raw/`                                             |
| `node dist/cli.js status`   | 查看最近一次 ETL 运行结果                                                       |
