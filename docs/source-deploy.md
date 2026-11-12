# 源码部署（方式 B）

面向想把**整个 git 仓库**拷到服务器、在服务器上编译运行的场景。

> 另一种方式是**发布包部署**（只拷 `up/`，不需要编译）—— 见
> [`up/README.md`](../up/README.md) 和 [`up/BAOTA.md`](../up/BAOTA.md)。
> 两种方式跑起来是同一个应用，区别只在服务器上有没有 TypeScript 工具链。

---

## 一、两种方式的取舍

| | 发布包（`up/`） | 源码（整个仓库） |
| --- | --- | --- |
| 服务器上要编译吗 | 不要 | 要（tsc + Node 工具链） |
| 装多少依赖 | 18 个运行时依赖 | 18 个运行时 + 15 个开发依赖（含 vitest / playwright） |
| 磁盘占用 | ~60 MB | ~500 MB（playwright 还会下载浏览器） |
| 上传体积 | 小 | 整个仓库（含 `test/` `docs/` `fixtures/`） |
| 改一行代码重新部署 | 重新编译 + 重新上传 `up/` | 改完 `npm run build` 即可 |
| 版本可追溯 | 靠 `dist.manifest.json` 的 SHA-256 | 靠 git commit |

**什么时候选源码部署：**

- 你要在服务器上直接改代码（不推荐——生产环境不该改代码）
- 你要走 CI/CD，在服务器上拉 git 仓库然后编译
- 服务器不能访问 npm 源，但你能把 `node_modules` 一起打包带过去

**什么时候选发布包部署：** 其余所有情况。少装 400 MB 依赖，少一个编译失败点。

---

## 二、打包与上传

### 2.1 用 git archive（推荐）

只包含**被 git 跟踪的文件**，不带你本地的 `.env`、`data/`、`node_modules/`：

```bash
cd /path/to/IPQuery
git archive --format=tar.gz -o ipquery-src.tar.gz HEAD
```

`git archive` 的三个好处：

- 文件集就是那个 commit 的样子，服务器上跑的和仓库里的一模一样
- 不会误带 `.env`（它在 `.gitignore` 里，也从没被提交过）
- 不带 `.git/` 目录，服务器上不会有人误操作 push

### 2.2 用 rsync / scp

如果你要边改边传：

```bash
rsync -avz --exclude node_modules --exclude .git --exclude data \
      --exclude .env --exclude dist --exclude up/dist \
      ./ ubuntu@SERVER:/www/ipquery/
```

> `--exclude up/dist` 是为了避免把 1.6 MB 的编译产物同步过去 —— 服务器上
> 自己会编译，覆盖掉它。

### 2.3 服务器上解开

```bash
ssh ubuntu@10-35-124-114
mkdir -p /www/ipquery
tar xzf /tmp/ipquery-src.tar.gz -C /www/ipquery
cd /www/ipquery
ls -la   # 应该看到 package.json / tsconfig.json / src / scripts
```

---

## 三、装依赖

```bash
cd /www/ipquery
npm install
```

**这一步会装上开发依赖**，因为源码部署要用 `tsc` 编译。`npm install` 之后
`node_modules/` 会有 500 MB 左右。

### 3.1 argon2 需要原生编译

`argon2` 是唯一带原生二进制的依赖。它需要编译工具链：

```bash
sudo apt-get install -y python3 make g++
```

编译失败是最常见的部署事故。先装工具链，再 `npm install`。

### 3.2 playwright 会不会下载浏览器？

**不会。** `playwright` 这个包只下载驱动，不下载浏览器二进制；浏览器要
`npx playwright install chromium` 单独装。源码部署**不需要**浏览器，跳过这步。

> 如果 `npm install` 还是开始下载浏览器，那是全局 npm 配置里设了
> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0`。检查：
> ```bash
> npm config get playwright_skip_browser_download
> ```

### 3.3 国内网络装 npm 慢

```bash
npm install --registry=https://registry.npmmirror.com
```

`package-lock.json` 里的 `resolved` 字段写的是官方源，`--registry` 会覆盖它，
但**版本号不变**——装出来的还是锁定的那些版本。

---

## 四、编译

```bash
npm run build
```

这一步依次做三件事（见 `scripts/build.js`）：

1. `npx tsc -p tsconfig.json` —— TypeScript 编译到 `dist/`
2. `node scripts/copy-schema.js` —— 复制 SQL 迁移、Handlebars 视图、静态资源、i18n
3. `node scripts/sync-up-dist.js` + `write-release-manifest.js` —— 同步 `up/`

第 3 步在服务器上是**无意义的**（服务器不需要 `up/`），但它**不会出错**，
只是白写一份文件。

> **想跳过第 3 步**：直接跑前两步，等价于 `npm run build`：
> ```bash
> rm -rf dist && npx tsc -p tsconfig.json && node scripts/copy-schema.js
> ```
> 如果你不想让服务器上出现 `up/` 目录，用这个。

### 4.1 编译成功的标志

```bash
ls dist/cli.js
ls dist/storage/migrations/ | tail -3    # 应看到 025_remove_seed_data.sql
ls dist/web/views/                       # Handlebars 视图
```

三个都在，`dist/` 才算完整。少任何一个，`node dist/cli.js serve` 会在启动时崩。

### 4.2 编译报错怎么办

`tsc` 是严格模式（`strict: true` + `noUncheckedIndexedAccess: true`），
类型错误会直接中断编译。**服务器上不要改代码** —— 回本地改完重新打包。

---

## 五、配置

**最省事的做法：不用手工建 `.env`。** 起服务，打开 `/init`，第 1 步会生成
`.env`（端口、访问地址 + 两把随机密钥），第 2 步填数据库连接。
详见 [`docs/setup.md`](setup.md) 的第 5 节。

如果你要走无头初始化（`ipq db` 命令、Ansible、CI），先手工准备好：

至少要改这些（**留默认值会起不来或起错**）：

```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ipquery
DB_PASSWORD=你设的密码
DB_NAME=ipquery

SESSION_SECRET=48字节随机
CSRF_SECRET=另48字节随机

WEB_BASE_URL=https://你的域名
PORT=3880
COOKIE_SECURE=true
```

生成两个**不同**的密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

> `SESSION_SECRET` 或 `CSRF_SECRET` 为空 / 缺失，服务**直接拒启**（fail-fast），
> 不会静默降级成不安全的默认值。这是有意的。
>
> 精确时机：**系统已初始化**（`/init` 走完）时缺密钥 → 拒启，报
> `refusing to start in production: missing required env vars: ...`。
> **系统未初始化**时允许用占位值启动，好让首次运行向导能打开 ——
> 向导不采集密钥，此时若拒启，`/init` 就永远打不开，安装无法完成。
>
> 环境判定：`NODE_ENV` 不设、或不是 `development`/`test`，一律按生产对待。
> 所以**服务器上不要设 `NODE_ENV=development`** —— 那会跳过密钥检查。
> `.env.example` 里默认是 `NODE_ENV=production`。

### 5.1 `DATA_DIR` 是相对路径 —— 部署时最容易踩的坑

`.env` 里 `DATA_DIR=./data` 是**相对于进程工作目录**解析的，不是相对于
`package.json`。所以：

- 在 `/www/ipquery` 下跑 `node dist/cli.js serve` → 数据落在 `/www/ipquery/data`
- 用 Supervisor 但**漏了 `directory=`** → 数据落在 Supervisor 的默认目录（`/` 或 `/var/www`）
  → ETL 下载失败，或者跑完之后数据莫名其妙不见

两种解法，任选一种：

**A. 用绝对路径（推荐）**

```ini
DATA_DIR=/www/ipquery/data
```

**B. 保证工作目录正确**

```ini
[program:ipquery]
command=/www/server/nodejs/v24.22.1/bin/node /www/ipquery/dist/cli.js serve
directory=/www/ipquery
```

`directory=` 那一行别漏。

### 5.2 其他值得看一眼的变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RATE_LIMIT` | 60 | 每分钟每 IP 的公共 API 请求上限。反代后面要调高（见 `up/BAOTA.md`） |
| `NODE_ENV` | production | 决定是否强制密钥检查。**不要在服务器上设成 `development`** |
| `ETL_SCHEDULE` | `0 2 * * *` | 每天 02:00 跑一次增量更新（UTC） |
| `MAXMIND_LICENSE_KEY` | 空 | 不填就只用 DB-IP 库 |
| `COOKIE_SECURE` | false | 走 HTTPS 必须设 true |

---

## 六、初始化与加载数据

```bash
# 1. 迁移（25 个版本）
node dist/cli.js migrate
node dist/cli.js migrate:status    # 每行都该是 applied

# 2. 加载真实 IP 数据（DB-IP，约 5-21 分钟）
node dist/cli.js update
node dist/cli.js status

# 3. 建管理员
node dist/cli.js init --email admin@example.com --password '<强口令>'
```

### 6.1 不要跑 `seed:demo`

```bash
node dist/cli.js seed:demo   # ← 生产环境不要跑这个
```

它会写入 50 条手工编造的示例地址（Google DNS、Cloudflare 等），让一个空的
库看起来像有数据。生产数据只来自 `update`。

### 6.2 迁移 025 会清掉旧库里的 demo 行

如果你之前部署过老版本，库里可能已经有 `country_source='seed'` 的行。
迁移 025 会把它们删掉 —— 这是有意的：生产库不该带示例数据。

---

## 七、跑起来

### 7.1 前台试跑

```bash
cd /www/ipquery
node dist/cli.js serve
```

看到服务监听 3880 后，另开一个终端验证：

```bash
curl -s localhost:3880/healthz
# {"status":"ok"}

curl -s "localhost:3880/lookup?ip=8.8.8.8"
# 有 country/city 才算数据到位
```

### 7.2 用 systemd 托管（Ubuntu 推荐）

`/etc/systemd/system/ipquery.service`：

```ini
[Unit]
Description=IPQuery
After=network.target mysql.service

[Service]
Type=simple
User=www
WorkingDirectory=/www/ipquery
ExecStart=/usr/bin/node /www/ipquery/dist/cli.js serve
Environment=NODE_ENV=production
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ipquery
sudo systemctl status ipquery
sudo journalctl -u ipquery -f
```

> `WorkingDirectory=` 是 `DATA_DIR` 相对路径能正确解析的前提。漏了它，
> ETL 数据会落到别处。

### 7.3 用宝塔 Supervisor

```ini
[program:ipquery]
command=/www/server/nodejs/v24.22.1/bin/node /www/ipquery/dist/cli.js serve
directory=/www/ipquery
user=www
autostart=true
autorestart=true
stdout_logfile=/www/wwwlogs/ipquery.log
stderr_logfile=/www/wwwlogs/ipquery.err.log
```

> **启动命令要写全 `node dist/cli.js serve`**。写 `npm start` 跑的是
> `node dist/cli.js` —— 那是 CLI 菜单，不是 Web 服务，站点起不来。

---

## 八、上线核对清单

- [ ] `.env` 权限 `600`，**不在版本库里**
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 各自独立随机值
- [ ] `DATA_DIR` 指向容量足够的磁盘（DB-IP 原始 CSV 约 100 MB）
- [ ] `node dist/cli.js migrate:status` 每行都是 applied
- [ ] `curl localhost:3880/healthz` 返回 `{"status":"ok"}`
- [ ] `curl "localhost:3880/lookup?ip=8.8.8.8"` 有结果
- [ ] `/init` 返回 404（初始化向导已关闭）
- [ ] 进程被 systemd / Supervisor 托管，不是前台终端
- [ ] 数据库账号非 root，仅授权本库
- [ ] 反代转发了 `X-Forwarded-For`，且 `RATE_LIMIT` 已按并发量调高

---

## 九、升级到新版本

源码部署的升级流程：

```bash
# 本地
git pull
npm run build          # 顺便同步 up/，本地保持一致
npm run test           # 388 个单元测试
git push

# 服务器
cd /www/ipquery
git pull                # 如果服务器上装了 .git
npm ci --omit=dev      # 只更新运行时依赖
npm run build
node dist/cli.js migrate
sudo systemctl restart ipquery
```

> **服务器上要不要留 `.git`？** 留了就能 `git pull` 升级，方便；不留就用
> `git archive` 重新打包上传。两种都行，前者更省事。

---

## 十、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm error Missing script: "build"` | 这是**发布包**，不是源码包 | 重新上传整个仓库，或改用发布包部署 |
| `npm run build` 报类型错误 | 严格模式编译失败 | 回本地改完重新打包，别在服务器上改代码 |
| `npm install` 报 argon2 编译失败 | 缺原生工具链 | `apt-get install -y python3 make g++` |
| `npm install` 卡住 / 很慢 | 网络问题 | `--registry=https://registry.npmmirror.com` |
| `serve` 起来但 `/lookup` 全是未找到 | 没加载数据 | `node dist/cli.js update` |
| `serve` 起来但 404 找不到路由 | `dist/` 不完整 | 重跑 `npm run build`，核对 `dist/web/views/` |
| ETL 报找不到文件 / 数据不见了 | `DATA_DIR` 相对路径解析错 | 设绝对路径或修 Supervisor 的 `directory=` |
| 服务起不来，报缺 secret | `SESSION_SECRET`/`CSRF_SECRET` 没设 | 填上（这是 fail-fast，不是 bug） |
| 站点 502 | Node 没起来 | 看 `journalctl -u ipquery` 或 Supervisor 日志 |

---

**相关文档：** [`up/README.md`](../up/README.md)（发布包部署）·
[`up/BAOTA.md`](../up/BAOTA.md)（宝塔面板）· [`docs/setup.md`](setup.md)（初始化）
