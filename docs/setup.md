# 初始化部署指南

从一台干净的机器到「能登录、能查询」的 IPQuery 实例。两条路径：

- **A. Web 向导（推荐）** —— 浏览器里走 6 步，适合第一次部署、想看到界面的人。
- **B. CLI 无头初始化** —— 一条命令，适合 Ansible / Terraform / CI。

两种方式效果一致：跑完迁移、建管理员、标记已初始化。`/setup` 一旦标记完成即返回 404，
之后所有改动都走管理后台。

---

## 0. 前置条件

| 项目         | 要求                         | 说明                                            |
| ------------ | ---------------------------- | ----------------------------------------------- |
| Node.js      | **>= 20**（CI 用 20）        | `node -v` 确认                                  |
| MySQL        | **5.7 / 8.0+**，需 `utf8mb4` | 迁移里含 `utf8mb4_unicode_ci` 与 JSON 列        |
| 操作系统     | Windows / Linux / macOS      | 构建与启动不依赖 Docker                         |
| MaxMind 许可 | 可选                         | 仅影响 MaxMind 数据源；DB-IP / ip2region 不需要 |

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

仓库只提供 `.env.example`；`.env` 由你自己在本地生成，且已被 `.gitignore` 忽略。

```bash
cp .env.example .env
```

然后至少修改下面几项（其余留默认即可）：

```ini
# --- 必填 ---
DB_HOST=localhost
DB_PORT=3306
DB_USER=ipquery
DB_PASSWORD=<第 1 步设置的强口令>
DB_NAME=ipquery

SESSION_SECRET=<64 位随机串>
CSRF_SECRET=<另一条 64 位随机串>

WEB_BASE_URL=http://localhost:5001
PORT=5001

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

> **`SESSION_SECRET` / `CSRF_SECRET` 的强制时机**：`NODE_ENV=production` 时缺任意一项，
> `buildServer()` 直接抛 `refusing to start in production: missing required env vars`，
> 不会静默降级到内置默认值。开发/测试环境（`NODE_ENV` 未设或为 `development`/`test`）
> 会回落到占位值，以便首次运行向导能跑起来 —— **但生产环境务必设成两把独立的随机串**。

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

启动后进程监听 `PORT`（示例为 5001），日志里会出现 `[api] listening on :5001`。

---

## 5. 路径 A：Web 向导（6 步）

浏览器打开 `http://localhost:5001/setup`。未初始化时，除 `/setup*`、`/healthz`、
`/lookup`、`/stats`、`/assets/*` 之外的所有地址都会被 302 重定向回 `/setup`。

| 步骤       | 地址              | 做什么                                                                       | 注意                                                            |
| ---------- | ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1 欢迎     | `/setup`          | 说明页，点「开始」                                                           | 无需表单                                                        |
| 2 数据库   | `/setup/database` | 显示从 `.env` 读到的 host/port/user/db（**不显示口令**），点「测试连接」探测 | 失败即 `.env` 或 MySQL 未启动；改 `.env` 需**重启服务**再回本页 |
| 3 站点     | `/setup/site`     | 站点名称（1–128 字符，必填）+ 副标题（≤256）                                 | 存进 `settings` 表，之后可在 `/admin/settings` 改               |
| 4 管理员   | `/setup/admin`    | 邮箱 + 密码 + 昵称                                                           | 密码 **≥10 位且同时含字母和数字**；昵称 1–64 字符               |
| 5 种子数据 | `/setup/seed`     | 三选一：示例数据 / 真实数据（ETL）/ 跳过                                     | 见下方说明                                                      |
| 6 完成     | `/setup/complete` | 核对汇总，点「完成」                                                         | 触发 `markInitialized()`，`/setup` 立即锁死                     |

### 第 5 步的三种选择

- **示例数据（50 条）** —— 瞬时完成。手工精选的公共 DNS、知名云厂商与 RFC 保留段，
  用来先把页面点通、验证查询链路。
- **真实数据（DB-IP，推荐）** —— 后台下载并导入 DB-IP 免费库
  （city-lite / country-lite / asn-lite，约 8.3M 条 IP 段）。页面会显示进度并每 3 秒
  自动刷新，耗时约 5–15 分钟，期间**可以关掉浏览器**，回来仍能看到进度。
  同一时刻只允许一个 ETL 运行，重复提交不会起第二个。
- **跳过** —— 保持空表，交给每日定时任务（`ETL_SCHEDULE`，默认每天 02:00 UTC）。

### 第 6 步之后

点「完成」后会被重定向到 `/login`。用第 4 步的管理员账号登录，进入 `/admin`。
此时 `/setup` 返回 404 —— 这是设计行为，不是坏了。

### 常见卡点

| 现象                               | 原因                                   | 处理                                                     |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| 打开任何页面都跳 `/setup`          | 尚未初始化                             | 正常，先走完向导                                         |
| `/setup` 返回 404                  | **已初始化过**                         | 用管理员登录；要重跑向导需重置 `settings.initialized_at` |
| 第 2 步提示连接失败                | `.env` 的 `DB_*` 不对，或 MySQL 未启动 | 修 `.env` → **重启服务** → 刷新本页                      |
| 第 4 步报密码强度不足              | 少于 10 位 / 缺字母 / 缺数字           | 换一个更强的密码                                         |
| 提交表单报「会话已过期」           | CSRF 令牌过期（4 小时）                | 刷新页面重新提交                                         |
| 页面样式全丢、控制台报 MIME 类型错 | 撞上了限流，429 的 JSON 体被当成 CSS   | 已修为只限公共 API；旧版本升级到最新即可                 |

---

## 6. 路径 B：CLI 无头初始化

适合脚本化部署。需要一个能连上数据库的 `.env`（同第 2 步）。

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
- `--seed` 加载的是 migration 012 里的 50 条示例段，和 Web 向导的「示例数据」相同。
  想导入真实 DB-IP 数据，初始化后再手动跑 `node dist/cli.js update`。
- 口令强度不达标会直接报错，不会创建弱口令账号。

跑完后同样用 `node dist/cli.js serve` 启动，登录 `/login`。

---

## 7. 首次登录后的收尾

1. **确认数据** —— 访问 `http://localhost:5001/lookup?ip=8.8.8.8`，应返回国家/地区/城市。
   若返回未找到，说明第 5 步选了「跳过」，等定时任务或手动 `node dist/cli.js update`。
2. **改站点设置** —— `/admin/settings` 里 4 个标签页：通用、安全、集成、系统。
3. **配邮件**（可选）—— 在 `.env` 设置 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
   `SMTP_PASS` / `SMTP_FROM`，否则注册验证与找回密码的邮件只打印到 stdout。
4. **确认 ETL 计划** —— `ETL_SCHEDULE` 默认 `0 2 * * *`（`ETL_TIMEZONE=UTC`）。
5. **检查迁移状态** —— `node dist/cli.js migrate:status`，确认全部 `applied`。

---

## 8. 生产部署清单

- [ ] `COOKIE_SECURE=true`，`WEB_BASE_URL` 为真实 HTTPS 域名
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 为各自独立的随机值（不要复用）
- [ ] 数据库账号非 root，仅授权本库
- [ ] `.env` 权限收紧（Linux：`chmod 600 .env`），**不进入版本库**
- [ ] 用 systemd / pm2 / NSSM 托管 `node dist/cli.js serve`，不要靠前台终端
- [ ] 反代（Nginx / Caddy）转发 `X-Forwarded-For`，否则限流把所有人算成一个 IP
- [ ] `DATA_DIR` 指向容量足够的磁盘（DB-IP 原始 CSV 约 100+ MB，导入后表更大）

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
| `node dist/cli.js update`   | 手动跑一次 ETL                                                                  |
| `node dist/cli.js download` | 只下载 DB-IP 原始数据到 `data/raw/`                                             |
| `node dist/cli.js status`   | 查看最近一次 ETL 运行结果                                                       |
