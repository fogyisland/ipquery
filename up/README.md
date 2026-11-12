# up/ — 发布目录（可直接部署）

本目录**就是服务器上要跑的东西**。把整个 `up/` 拷到服务器，装一次依赖，
就能跑起来——不需要源码、不需要 TypeScript 工具链、不需要 `npm run build`。

```
cp -r up/ /opt/ipquery/
cd /opt/ipquery
bash install.sh
```

## `npm run build` 在这里做什么

**不编译。** `dist/` 是编好的、随包发布的，服务器上没有源码，也没有
TypeScript 工具链，编译不了。

发布包里的 `build` 跑的是 `scripts/verify-dist.js` —— 它**校验**发布副本：

1. 编译产物在不在（`dist/cli.js`、`dist/api/server.js`、`dist/storage/schema.sql`）
2. 运行期资源在不在（SQL 迁移、Handlebars 视图、静态资源、i18n）
3. 迁移编号有没有重复或乱序
4. `dist/` 里的每个文件是否还对得上 `dist.manifest.json` 的 SHA-256

拷贝过程中出了任何问题（tar 包截断、文件没传全、被改过），它会**报错并以
退出码 1 结束**，而不是让你在一个残缺的副本上起服务。

```bash
npm run build
# [verify-dist] 347 files match dist.manifest.json
# [verify-dist] release bundle is intact — run `node dist/cli.js serve` to start
```

> 想要**真正的编译**，走源码部署：拷贝整个仓库，`npm install && npm run build`。
> 见 [`../docs/source-deploy.md`](../docs/source-deploy.md)。

## 目录里有什么

| 路径                 | 说明                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `dist/`              | **编译好的应用本体**（342 个文件）。`cli.js` 入口、SQL 迁移、Handlebars 视图、静态资源、i18n 文案，全在这里 |
| `dist.manifest.json` | `dist/` 每个文件的大小 + SHA-256，用于校验部署副本是否被改动过                                              |
| `package.json`       | **仅运行期**的依赖清单与命令（不含 devDependencies；`build` 是校验而非编译，见下）                            |
| `package-lock.json`  | 锁定的依赖版本，`npm ci` 靠它复现同一棵树                                                                   |
| `.env.example`       | 环境变量模板，`install.sh` 会复制成 `.env`                                                                  |
| `install.sh`         | 装依赖 → 建 `data/raw/` → 生成 `.env` → 跑迁移                                                              |
| `init-runbook.md`    | 首次启动与上线核对手册                                                                                      |
| `MANIFEST.md`        | 每个文件的来源、必需性，以及**不需要**上服务器的东西                                                        |

## 为什么 `node_modules` 不在这里

它有 **12,466 个文件、49.9 MB**，而且 `argon2` 带平台相关的二进制——必须
在目标机上编译。塞进版本库既臃肿又必然跨平台坏掉。

所以 `install.sh` 在服务器上跑 `npm ci --omit=dev` 装它。代价是服务器需要
能访问 npm 源；完全离线的环境请用 `npm pack` 在有网机器上打包后拷过去。

## `dist/` 怎么保持不过期

`up/dist/` 是提交进版本库的编译产物，天然会跟 `src/` 脱节。防漂移靠三件事：

1. **构建时自动同步** —— `npm run build` 结束后会调用 `scripts/sync-up-dist.js`，
   整体替换 `up/dist/`（不是合并，合并会留下已删除的旧文件）并重写清单。
2. **校验** —— `npm run check:release` 逐文件比对 SHA-256，任何缺失、篡改、
   多余文件都会报出来并以退出码 1 结束。
3. **CI 门禁** —— 把 `check:release` 接进流水线，漂移就不会被提交。

单独同步用 `npm run sync:release`。

## 部署后的三步

```bash
node dist/cli.js serve                                                    # 起服务
# 打开 http://服务器IP:3880/init，走完 6 步向导（第 2 步配数据库）
node dist/cli.js update                                                   # 灌真实 IP 数据（约 5–15 分钟）
```

> **数据库没配好也能起服务。** 首次安装时 `.env` 里通常还没有正确的库口令，
> 而向导正是用来设置它的 —— 如果服务因为连不上库就退出，向导永远打不开。
> 所以数据库不可达时服务照常启动，进入「仅向导模式」：`/init` 正常，其余路径
> 返回 503 或跳回 `/init`。在向导第 2 步填入连接信息并保存后**立即生效，
> 无需重启**。
>
> 顺带一提：**每日 ETL 定时任务也是在这时候才启动的。** 它跟服务在同一个
> 进程里，所以只有在数据库可用之后才能排程 —— 第 2 步保存成功的那一刻，
> 定时任务就挂上了。全程不需要重启。

也可以完全走命令行（需要一个能连上数据库的 `.env`）：

```bash
node dist/cli.js init --email <admin@example.com> --password '<强口令>'   # 建管理员 + 锁 /init
node dist/cli.js update                                                   # 灌真实 IP 数据（约 5–15 分钟）
node dist/cli.js serve                                                    # 起服务
```

数据库连接本身也可以用命令行配（和向导第 2 步是同一套逻辑：**先测后写**，
连不上就报错退出、`.env` 一个字节都不动）：

```bash
export DB_HOST=127.0.0.1 DB_USER=ipquery DB_NAME=ipquery DB_PASSWORD='你的口令'
node dist/cli.js db --host "$DB_HOST" --user "$DB_USER" --name "$DB_NAME" --save
# [db] the connection works
# [db] connection written to /opt/ipquery/.env
# [db] applied 24 migration(s)
```

口令**不要写在命令行上** —— 命令行会进 shell 历史，也会出现在 `ps` 输出里。
用环境变量传（上面就是这么做的）。

## 三个容易踩的坑

1. **`.env` 不进版本库**，只在本机（`chmod 600`）。`SESSION_SECRET` 与
   `CSRF_SECRET` 必须是两个不同的随机值，缺任一服务直接拒启。

2. **示例数据只在你明确要求时才会加载。** `dist/storage/seed/demo-ranges.sql`
   里的 50 条示例段**不会**被迁移自动灌入——一个刚建好的库是干净的。想在开发机
   上灌示例数据：

   ```bash
   node dist/cli.js seed:demo    # 仅开发/演示用
   ```

   **生产环境不要执行这一条。** 生产数据来自 `node dist/cli.js update`（真实
   DB-IP 库）。

3. **`DATA_DIR` 是相对路径**，相对于进程工作目录。用 systemd / pm2 托管时
   `WorkingDirectory` 必须指向安装根目录，否则 ETL 数据落到别处。

## 相关

- 详细版部署手册：[`../docs/setup.md`](../docs/setup.md)
- 源码部署方式（拷贝整个仓库、服务器上编译）：[`../docs/source-deploy.md`](../docs/source-deploy.md)
- 命令总览：`node dist/cli.js --help`
- 迁移状态：`node dist/cli.js migrate:status`（每行都该是 `applied`）
