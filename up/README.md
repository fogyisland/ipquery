# up/ — 首次启动引导物料（first-run bootstrap assets）

本目录存放 IPQuery 首次启动（init）流程所依赖的引导内容。
初始化向导在 `/init`（原 `/setup`），六步：欢迎 → 数据库 → 站点 → 管理员 → 种子数据 → 完成。

## 内容

| 文件 | 用途 |
|------|------|
| `seed-ip-ranges.sql` | 50 条精选示例 IP 段（公共 DNS、知名站点等），供向导第 5 步「示例数据」与 CLI `--seed` 使用。运行时由 `src/storage/migrations/012_seed_ip_ranges.sql` 直接加载，本文件是内容母本与人工审阅版。 |
| `init-runbook.md` | 全新部署操作手册：环境准备、向导/CLI 两种引导方式、发布（上线）核对清单。 |

## 使用方式

- **Web 向导（推荐）**：`make run` 后浏览器打开 `http://localhost:5001/init`。
- **CLI**：`node dist/cli.js init --email <admin@example.com> --password <strong-password> [--seed]`。
- 种子数据与 ETL 真实数据互不冲突：seed 行 `country_source='seed'`，ETL 行使用其他来源值，幂等可重跑。
