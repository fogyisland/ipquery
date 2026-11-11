# 发布文件清单（MANIFEST）

`up/` 目录里**每一个文件**的来源、用途和是否必须。

`install.sh` 会自动装配下面这些；手工部署时照这张表搬即可。

## 一、发布目录结构

```
/opt/ipquery/                ← 安装根目录（路径自选）
├── dist/                    ← 应用本体（编译产物）
│   ├── cli.js               ←   入口：serve / migrate / init / update
│   ├── mcp/server.js        ←   MCP 服务器（可选，npm run mcp）
│   ├── storage/
│   │   ├── schema.sql       ←   基础表结构
│   │   └── migrations/*.sql ←   001–024，按序执行
│   └── web/
│       ├── views/**/*.hbs   ←   页面模板（@fastify/view 需要）
│       ├── assets/**/*      ←   静态资源（@fastify/static 需要）
│       ├── i18n/*.json      ←   中英文案（req.t() 需要）
│       └── routes/ plugins/ admin/ auth/ errors/  ← 编译后的路由与插件模块
├── dist.manifest.json       ← 每个文件的 SHA-256，用于校验部署副本
├── node_modules/            ← 生产依赖（npm ci --omit=dev 生成）
├── package.json             ← 仅运行期依赖与命令
├── package-lock.json        ← 锁定版本，保证可复现
├── .env.example             ← 环境变量模板
├── .env                     ← ← 真值。只在本机，chmod 600，不进版本库
├── data/                    ← ETL 原始 CSV 下载目录（DATA_DIR，默认 ./data）
│   └── raw/
├── install.sh               ← 装依赖 + 建目录 + 生成 .env + 迁移
├── init-runbook.md          ← 首次启动操作单
├── MANIFEST.md              ← 本文件
├── seed-ip-ranges.sql       ← 种子数据母本（人工审阅版）
├── logs/                    ← 服务日志（按部署约定定位置）
└── (systemd unit / pm2 配置文件，按需)
```

## 二、每一项的来源

| 目标                                           | 来源                                             | 必须 | 说明                                                       |
| ---------------------------------------------- | ------------------------------------------------ | ---- | ---------------------------------------------------------- |
| `dist/cli.js`                                  | `npm run build`                                  | ✅   | `tsc` 编译 `src/`                                          |
| `dist/storage/schema.sql`                      | `src/storage/schema.sql`                         | ✅   | 构建时由 `scripts/copy-schema.js` 复制                     |
| `dist/storage/migrations/*.sql`                | `src/storage/migrations/`                        | ✅   | 同上；**024 必须包含在内**                                 |
| `dist/web/views/**`                            | `src/web/views/`                                 | ✅   | Handlebars 模板，缺了页面 500                              |
| `dist/web/assets/**`                           | `src/web/assets/`                                | ✅   | CSS/JS，缺了页面无样式                                     |
| `dist/web/i18n/*.json`                         | `src/web/i18n/`                                  | ✅   | 文案，缺了 `req.t()` 抛错                                  |
| `dist/web/{routes,plugins,admin,auth,errors}/` | `src/web/`                                       | ✅   | 编译后的路由与插件模块                                     |
| `dist/mcp/server.js`                           | `src/mcp/`                                       | ⭕   | 只用 MCP 时需要                                            |
| `dist.manifest.json`                           | `scripts/sync-up-dist.js`                        | ⭕   | 校验用；丢了也能跑，只是没法证明副本没被改                 |
| `node_modules/`                                | `npm ci --omit=dev`                              | ✅   | **只装生产依赖**                                           |
| `package.json`                                 | `scripts/write-release-manifest.js`              | ✅   | 仅运行期依赖                                               |
| `package-lock.json`                            | `npm install --package-lock-only`（在 `up/` 内） | ✅   | 与上面那个 package.json 配套                               |
| `.env.example`                                 | 仓库根                                           | ✅   | 复制成 `.env` 的模板                                       |
| `.env`                                         | 手工创建                                         | ✅   | **绝不入版本库**                                           |
| `data/raw/`                                    | `mkdir`                                          | ✅   | ETL 下载 DB-IP CSV 的落地点                                |
| `install.sh`                                   | `up/`                                            | ✅   | 部署脚本                                                   |
| `init-runbook.md` / `MANIFEST.md`              | `up/`                                            | ⭕   | 文档                                                       |
| `up/seed-ip-ranges.sql` **直接执行**           | —                                                | ❌   | 它是母本；真正加载的是 `migrations/012_seed_ip_ranges.sql` |

## 三、不需要上服务器的东西

| 不要搬                               | 原因                            |
| ------------------------------------ | ------------------------------- |
| `src/`                               | TypeScript 源码，编译后不再需要 |
| `test/`                              | 测试只在开发机跑                |
| `scripts/`                           | 构建脚本，服务器不构建          |
| `node_modules/` 里的 devDependencies | `npm ci --omit=dev` 不装它们    |
| `up/` 之外的任何仓库内容             | 开发用                          |

## 四、原生依赖

`argon2` 是唯一的原生模块，编译它需要：

```bash
# Debian / Ubuntu
apt-get install -y python3 make g++

# Alpine
apk add --no-cache python3 make g++
```

`install.sh` 会在 `npm ci` 之后检查 `node_modules/argon2` 是否存在，缺了就
报错并给出这条命令——而不是等到第一次登录时才崩。

## 五、路径依赖

| 环境变量        | 默认值                  | 说明                                                                                                      |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`      | `./data`                | 相对路径**相对于进程工作目录**。用 systemd 托管时 `WorkingDirectory` 必须指向安装根目录，否则数据落到别处 |
| `PORT`          | `5001`                  | 监听端口                                                                                                  |
| `WEB_BASE_URL`  | `http://localhost:5001` | 生产必须是真实 HTTPS 域名                                                                                 |
| `COOKIE_SECURE` | `false`                 | 生产必须 `true`（配合 HTTPS）                                                                             |

## 六、校验部署是否成功

```bash
node dist/cli.js migrate:status      # 每一行都是 applied
curl -s localhost:5001/healthz       # {"status":"ok"}
curl -s "localhost:5001/lookup?ip=8.8.8.8"   # 有 country/city 才算数据到位
```

三条都过，基本部署完成。

## 七、校验副本没被改动

```bash
node -e "const m=require('./dist.manifest.json');console.log(m.fileCount+' files')"
```

`dist.manifest.json` 里每个文件都有 SHA-256。怀疑部署副本被改过时，可以
在服务器上重算比对——开发机侧用 `npm run check:release` 做同样的事。
