# 首次启动（init）与发布核对手册

> 详细版见 `docs/setup.md`；服务器文件清单见 [`MANIFEST.md`](MANIFEST.md)。
> 本手册随发布目录一起交付，按「部署 → 引导 → 发布核对」三段执行。

## 〇、部署

`up/` 目录**就是发布包**：里面已经带着编译好的 `dist/`、依赖清单和 `.env`
模板。把整个目录拷到服务器即可：

```bash
cp -r up/ /opt/ipquery/
cd /opt/ipquery
bash install.sh
```

`install.sh` 依次做四件事：

1. `npm ci --omit=dev` 装运行期依赖
2. 建 `data/raw/`（ETL 下载 CSV 的落地点）
3. 没有 `.env` 就从模板生成一份，并提示填哪些项
4. 跑 `node dist/cli.js migrate` 应用迁移

第 4 步需要 `.env` 里的数据库凭据是真的——模板里的 `rootpass` 是占位符，
直接跑会报 `ER_ACCESS_DENIED_ERROR`。这是预期行为：脚本不会替你猜密码。

**手工部署**：照 [`MANIFEST.md`](MANIFEST.md) 搬文件——那张表列了服务器上
需要的**每一个文件**、来源、必需性，以及不需要搬的（`src/`、`test/`、`scripts/`）。

## 一、准备

1. **数据库**：新建空库（迁移会自动建表，无需手工导 schema）：

   ```sql
   CREATE DATABASE ipquery DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'ipquery'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
   GRANT ALL PRIVILEGES ON ipquery.* TO 'ipquery'@'localhost';
   FLUSH PRIVILEGES;
   ```

2. **`.env`**：`install.sh` 已经从 `.env.example` 生成好了，编辑它，至少填
   `DB_*`、`SESSION_SECRET`、`CSRF_SECRET`、`WEB_BASE_URL`、`PORT`。密钥生成：

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```

   生产环境缺任一密钥服务会直接拒启（fail-fast，不静默降级）。两个密钥必须不同。

3. **原生依赖**：`argon2` 需要编译工具链，否则 `npm ci` 会失败：

   ```bash
   apt-get install -y python3 make g++     # Debian / Ubuntu
   apk add --no-cache python3 make g++    # Alpine
   ```

## 二、引导（三选一）

| 方式     | 命令 / 入口                                                                      | 适用                     |
| -------- | -------------------------------------------------------------------------------- | ------------------------ |
| Web 向导 | `node dist/cli.js serve` 后浏览器开 `http://localhost:5001/init`                 | 首次部署、想看界面       |
| CLI 无头 | `make init`（读 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` / `ADMIN_SEED`） | Ansible / Terraform / CI |
| CLI 直调 | `node dist/cli.js init --email <admin> --password '<强口令>' [--seed]`           | 同上，显式传参           |

- 向导六步：欢迎 → 数据库 → 站点 → 管理员 → 种子数据 → 完成。
- 未初始化时除 `/init*`、`/healthz`、`/lookup`、`/stats`、`/assets/*` 外全部 302 到 `/init`；
  初始化完成后 `/init` 返回 404。
- 种子数据三选一：**示例数据**（`up/seed-ip-ranges.sql` 的 50 条精选段，瞬时）、
  **真实数据**（DB-IP 后台 ETL，约 5–15 分钟，可关浏览器回来仍见进度）、**跳过**。

## 三、发布（上线）核对清单

- [ ] `/lookup?ip=8.8.8.8` 返回国家/城市（否则数据为空，等 ETL 或 `node dist/cli.js update`）
- [ ] `COOKIE_SECURE=true`、`WEB_BASE_URL` 为真实 HTTPS 域名
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 独立随机值，不复用
- [ ] 数据库账号非 root，仅授权本库；`.env` 权限收紧（`chmod 600`），不进版本库
- [ ] `SESSION_SECRET` / `CSRF_SECRET` 只写本机 `.env`，任何提交文件不得含真实凭据
- [ ] systemd / pm2 / NSSM 托管服务进程，不靠前台终端
- [ ] 反代转发 `X-Forwarded-For`，否则限流把所有人算成一个 IP
- [ ] `DATA_DIR` 指向容量足够磁盘（DB-IP 原始 CSV 约 100+ MB）
- [ ] `node dist/cli.js migrate:status` 全部 `applied`
- [ ] `/init` 已返回 404（确认初始化锁定生效）

### 迁移与发布的顺序

新增的迁移（如 migration 024 的 `provider_call_counter_minute`）可以先于代码上线：

- **代码先、迁移后**：分钟表缺失时调用计数写入降级为告警、读取自动回退日表，
  熔断仍按日表生效，不会静默失效；补跑 `node dist/cli.js migrate` 后自动升级为分钟粒度。
- **迁移先、代码后**：新表先建好，旧代码不认识它、不受影响。

两种顺序都安全，但**迁移后**能拿到修复后的熔断粒度——旧代码读不到分钟表，
仍会按天桶统计。
