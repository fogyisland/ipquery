# up/ — 部署与首次启动引导物料

本目录是 IPQuery 的**部署交付包**：把「服务器上需要什么」和「第一次启动怎么做」
放在一处。仓库其余部分（`src/`、`test/`）是开发用的源码，不上服务器。

## 内容

| 路径 | 用途 | 谁用 |
|------|------|------|
| `deploy/deploy.sh` | 一键部署：构建 → 装配目录 → 装生产依赖 → 迁移 | 运维 |
| `deploy/MANIFEST.md` | **服务器上全部文件的清单**：路径、来源、必需性、排除项 | 运维 / 交付 |
| `init-runbook.md` | 首次启动操作单：准备 → 引导 → 发布核对 | 运维 |
| `seed-ip-ranges.sql` | 50 条精选示例 IP 段的**母本与人工审阅版** | 运维 |
| `README.md` | 本文件 | 所有人 |

## 最快路径

```bash
./up/deploy/deploy.sh /opt/ipquery
cd /opt/ipquery
cp .env.example .env        # 填 DB_*、SESSION_SECRET、CSRF_SECRET、WEB_BASE_URL
node dist/cli.js init --email <admin@example.com> --password '<强口令>'
node dist/cli.js update     # 灌真实 IP 数据（约 5–15 分钟）
node dist/cli.js serve
```

`deploy.sh` 装完会打印剩余步骤。需要每个文件的完整说明，看
[`deploy/MANIFEST.md`](deploy/MANIFEST.md)。

## 三条容易踩的坑

1. **`.env` 不进版本库**，只在本机（`chmod 600`）。`SESSION_SECRET` 与
   `CSRF_SECRET` 必须是两个不同的随机值，缺任一服务会直接拒启。

2. **种子数据不要手工执行** `up/seed-ip-ranges.sql` —— 它是母本。运行时真正
   加载的是 `src/storage/migrations/012_seed_ip_ranges.sql`（由
   `node dist/cli.js init --seed` 触发），幂等可重跑。

3. **`DATA_DIR` 是相对路径**，相对于进程工作目录。用 systemd / pm2 托管时
   `WorkingDirectory` 必须指向安装根目录，否则 ETL 数据落到别处。

## 与仓库其他部分的关系

- 详细版部署手册：[`docs/setup.md`](../docs/setup.md)
- CLI 命令总览：`node dist/cli.js --help`
- 迁移状态：`node dist/cli.js migrate:status`（每行都该是 `applied`）
