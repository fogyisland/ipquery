# 宝塔面板部署指南

面向已经在用宝塔面板（BT Panel）的服务器。**不需要 Docker**，跑的是原生 Node.js。

> 通用部署流程见 [`README.md`](README.md)，本文件只讲宝塔特有的部分。

---

## 一、前置检查

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| Node 版本 | **≥ 20** | 宝塔 → 软件商店 → Node.js 版本管理器 |
| MySQL | 5.7 或 8.0 | 宝塔 → 数据库 |
| 字符集 | `utf8mb4` | 建库时指定，见下 |

`engines` 要求 Node ≥ 20。宝塔默认装的可能是 16 或 18，**必须换**，否则服务起不来。

---

## 二、准备数据库

宝塔 → 数据库 → 添加数据库：

- 数据库名：`ipquery`
- 用户名：`ipquery`
- 密码：**自己设一个强的**
- 访问权限：**本地服务器**（不要开放公网）
- 字符集：`utf8mb4`

> 宝塔建库时字符集要选 `utf8mb4`。迁移 001 建的表就是 `utf8mb4`，选错会导致排序规则冲突。

---

## 三、上传发布包

把 `up/` 目录里的**内容**上传到服务器，例如 `/www/wwwroot/ipquery/`。

```bash
# 本地打包
cd up && tar czf ipquery-up.tar.gz .
# 上传到服务器后
mkdir -p /www/wwwroot/ipquery
tar xzf ipquery-up.tar.gz -C /www/wwwroot/ipquery
```

上传后目录应该长这样：

```
/www/wwwroot/ipquery/
├── dist/                 ← 编译好的应用
├── package.json
├── package-lock.json
├── .env.example
├── install.sh
├── dist.manifest.json
└── ...
```

**`node_modules/` 不需要上传** —— 装依赖那一步会在服务器上做（argon2 带平台相关的二进制文件，必须在目标机上编译）。

---

## 四、安装

SSH 上去执行：

```bash
cd /www/wwwroot/ipquery
bash install.sh
```

脚本做四件事：装依赖（`npm ci --omit=dev`）、建 `data/raw/`、生成 `.env`、跑迁移。

装完之后可以再跑一次校验，确认上传的副本是完整的：

```bash
npm run build
# [verify-dist] release bundle is intact
```

（发布包里**不需要编译** —— `dist/` 已随包发布，`build` 只是校验副本完整性。）

**第 3 步需要你填数据库凭据**，脚本不会替你猜：

```bash
nano /www/wwwroot/ipquery/.env
```

至少改这几项：

```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ipquery
DB_PASSWORD=你设的密码
DB_NAME=ipquery

SESSION_SECRET=48字节随机
CSRF_SECRET=另48字节随机
WEB_BASE_URL=https://你的域名
PORT=5001
COOKIE_SECURE=true
```

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

两个密钥**必须不同**。缺任一服务直接拒启（fail-fast，不静默降级）——
只要系统已经初始化过（`/init` 走完），少一个密钥服务就起不来，报
`refusing to start in production: missing required env vars`。

> `NODE_ENV` 不设就是生产（项目里没有任何地方会设它）。设成 `development`
> 会跳过密钥检查，**只在本地开发时用**，服务器上不要设。

改完再跑一次迁移（第一次 `install.sh` 因为占位密码会停在这一步）：

```bash
cd /www/wwwroot/ipquery
node dist/cli.js migrate
node dist/cli.js migrate:status    # 每行都该是 applied
```

---

## 五、加载真实数据

**这一步是必须的。** 迁移不会自动灌入任何示例数据——刚建好的库是空的，`/lookup` 查什么都返回「未找到」。

```bash
cd /www/wwwroot/ipquery
node dist/cli.js update
```

后台下载并导入 DB-IP 免费库（city-lite / country-lite / asn-lite，约 8.3M 段），耗时约 **5–21 分钟**。

```bash
# 看进度
node dist/cli.js status
```

> **不要在生产环境执行 `node dist/cli.js seed:demo`。** 那会写入 50 条手工编造的示例地址
> （Google DNS、Cloudflare 等），让一个空的库看起来像有数据。生产数据只来自 `update`。

---

## 六、在宝塔里跑起来

### 方式 A：宝塔 Node 项目管理器（推荐）

宝塔 → 软件商店 → Node.js 版本管理器 → 添加 Node 项目：

| 字段 | 填什么 |
| --- | --- |
| 项目目录 | `/www/wwwroot/ipquery` |
| Node 版本 | 20 或更高 |
| 启动选项 | **自定义命令** |
| 启动命令 | `node dist/cli.js serve` |
| 端口 | `5001`（必须和 `.env` 里的 `PORT` 一致） |
| 运行用户 | `www` |

> **「启动选项」一定要选「自定义命令」**，然后填 `node dist/cli.js serve`。
> 如果填 `npm start`，跑的是 `node dist/cli.js`——那是 CLI 菜单，不是 Web 服务，站点起不来。

> **运行用户用 `www`**（宝塔默认）。`data/raw/` 需要这个用户有写权限，否则 ETL 下载会失败：
> ```bash
> chown -R www:www /www/wwwroot/ipquery/data
> ```

### 方式 B：宝塔 Supervisor

软件商店 → Supervisor 管理器 → 添加进程：

```ini
[program:ipquery]
command=/www/server/nodejs/v20.x/bin/node /www/wwwroot/ipquery/dist/cli.js serve
directory=/www/wwwroot/ipquery
user=www
autostart=true
autorestart=true
stdout_logfile=/www/wwwlogs/ipquery.log
stderr_logfile=/www/wwwlogs/ipquery.err.log
```

`directory=` 那一行别漏——`DATA_DIR` 是相对路径，漏了它 ETL 数据会落到别处。

### 方式 C：宝塔反向代理

宝塔 → 网站 → 添加站点 → 反向代理 → 目标 URL 填 `http://127.0.0.1:5001`。

这样宝塔负责域名和 HTTPS，Node 只管业务。

### ⚠️ 反向代理下的限流（重要）

**当前代码没有开启 `trustProxy`。** Fastify 默认 `trustProxy: false`，此时 `req.ip`
拿到的是**连接的对端地址**——也就是宝塔反代进程的地址（`127.0.0.1`），不是真实访客。

后果：限流按 IP 计数，而所有访客共享同一个 `127.0.0.1`，于是**一个访客就能把
所有人的额度用光**（60 次/分钟是全体共享的）。

三种处理方式，按推荐顺序：

**方案 1（推荐）：让宝塔直连 Node，不走反代。**

在宝塔的 Node 项目管理器里直接绑域名，或用 Nginx `proxy_pass` 但**在宝塔的
「防火墙」里限制 5001 端口只允许本机访问**，同时把限流改为按其他维度。

**方案 2：开启 `trustProxy`。**

需要在 `src/api/server.ts` 的 `Fastify({...})` 里加 `trustProxy: true`，然后重新
构建发布包。这会**信任 `X-Forwarded-For`**——只有在你能保证只有宝塔能访问到
Node 端口时才能这么做，否则外部可以伪造该头绕过限流。

> 这项改动我还没做。它需要你的确认（见本文档末尾），因为它同时影响安全性。

**方案 3：把限流改成不依赖 IP。**

比如按 API Key 计数（已登录的调用方），未登录的公开接口才按 IP。

**在方案 2 或 3 落地之前，如果用反代部署，请把 `RATE_LIMIT` 调高**（比如
`RATE_LIMIT=600`），避免正常的多个访客互相踩踏。

---

## 七、初始化管理员

```bash
cd /www/wwwroot/ipquery
node dist/cli.js init --email admin@example.com --password '<强口令>'
```

或者用 Web 向导（先访问 `http://服务器IP:5001/init`），走完 6 步。

> 向导第 5 步是「种子数据」三选一：**生产选「跳过」或「真实数据」**。选「示例数据」会写入 50 条 demo 地址。

初始化完成后 `/init` 返回 404——这是设计行为，不是坏了。

---

## 八、验证

```bash
cd /www/wwwroot/ipquery

curl -s localhost:5001/healthz
# {"status":"ok"}

curl -s "localhost:5001/lookup?ip=8.8.8.8"
# 应该有 country/city —— 没有就是数据没加载回去跑 update

node dist/cli.js migrate:status
# 每行都该是 applied
```

三条都过，基本部署完成。

---

## 九、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 站点 502 | Node 没起来 | 看 Supervisor/项目日志；先 `node dist/cli.js serve` 手动跑看报错 |
| 启动报 `engines` 不满足 | Node 版本太低 | 换到 20+ |
| 启动报缺 argon2 | 编译工具链没装 | `apt-get install -y python3 make g++` |
| `/lookup` 全是「未找到」 | 没加载真实数据 | `node dist/cli.js update` |
| 页面样式全丢 | 限流返回了 429 的 JSON，被当成 CSS | 已修为只限公共 API；确认没有旧版本残留 |
| ETL 下载失败 | `data/raw` 不可写 | `chown -R www:www data` |
| 限流对所有人一起触发 | 反代下 `req.ip` 拿到的是反代地址，所有人共享一个 IP | 见「反向代理下的限流」 |

---

## 十、别忘了

- [ ] `.env` 权限收紧：`chmod 600 .env`，**且不在版本库里**
- [ ] 数据库账号非 root，仅授权本库
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 独立随机值，不复用
- [ ] `COOKIE_SECURE=true`，`WEB_BASE_URL` 是真实 HTTPS 域名
- [ ] systemd / Supervisor 托管，不靠前台终端
- [ ] 反代转发 `X-Forwarded-For`
- [ ] `DATA_DIR` 指向容量足够的磁盘（DB-IP 原始 CSV 约 100+ MB）
- [ ] `/init` 已返回 404
