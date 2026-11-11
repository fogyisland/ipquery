# up/ — 发布目录（可直接部署）

本目录**就是服务器上要跑的东西**。把整个 `up/` 拷到服务器，装一次依赖，
就能跑起来——不需要源码、不需要 TypeScript 工具链、不需要 `npm run build`。

```
cp -r up/ /opt/ipquery/
cd /opt/ipquery
bash install.sh
```

## 目录里有什么

| 路径                 | 说明                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `dist/`              | **编译好的应用本体**（342 个文件）。`cli.js` 入口、SQL 迁移、Handlebars 视图、静态资源、i18n 文案，全在这里 |
| `dist.manifest.json` | `dist/` 每个文件的大小 + SHA-256，用于校验部署副本是否被改动过                                              |
| `package.json`       | **仅运行期**的依赖清单与命令（不含 devDependencies、不含 build/test 脚本）                                  |
| `package-lock.json`  | 锁定的依赖版本，`npm ci` 靠它复现同一棵树                                                                   |
| `.env.example`       | 环境变量模板，`install.sh` 会复制成 `.env`                                                                  |
| `install.sh`         | 装依赖 → 建 `data/raw/` → 生成 `.env` → 跑迁移                                                              |
| `init-runbook.md`    | 首次启动与上线核对手册                                                                                      |
| `MANIFEST.md`        | 每个文件的来源、必需性，以及**不需要**上服务器的东西                                                        |
| `seed-ip-ranges.sql` | 50 条示例 IP 段的母本与人工审阅版                                                                           |

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
node dist/cli.js init --email <admin@example.com> --password '<强口令>'   # 建管理员 + 锁 /init
node dist/cli.js update                                                   # 灌真实 IP 数据（约 5–15 分钟）
node dist/cli.js serve                                                    # 起服务
```

## 三个容易踩的坑

1. **`.env` 不进版本库**，只在本机（`chmod 600`）。`SESSION_SECRET` 与
   `CSRF_SECRET` 必须是两个不同的随机值，缺任一服务直接拒启。

2. **种子数据不要手工执行** `seed-ip-ranges.sql` —— 它是母本。运行时真正
   加载的是 `dist/storage/migrations/012_seed_ip_ranges.sql`（由
   `node dist/cli.js init --seed` 触发），幂等可重跑。

3. **`DATA_DIR` 是相对路径**，相对于进程工作目录。用 systemd / pm2 托管时
   `WorkingDirectory` 必须指向安装根目录，否则 ETL 数据落到别处。

## 相关

- 详细版部署手册：[`../docs/setup.md`](../docs/setup.md)
- 命令总览：`node dist/cli.js --help`
- 迁移状态：`node dist/cli.js migrate:status`（每行都该是 `applied`）
