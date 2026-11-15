# IPQuery MCP Server

IPQuery 以 MCP (Model Context Protocol) server 形式暴露 7 个只读工具，AI 工具
（Claude Code、Cursor、Claude Desktop 等）通过 stdio 一行配置即可接入。

## 工具一览（全部只读）

| 工具                     | 权限范围 | 说明                                                    | 参数                                                                     |
| ------------------------ | -------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ipquery_lookup`         | 全部     | 查询 IPv4/IPv6 归属地（国家/城市/时区/ISP/ASN）          | `ip`（必填）                                                             |
| `ipquery_stats`          | ops      | 库规模摘要：最近 ETL run + 各源记录数                   | 无                                                                       |
| `ipquery_etl_status`     | ops      | 最近 ETL run 详情 + 队列概要                            | 无                                                                       |
| `ipquery_queue_stats`    | ops      | unknown-IP 队列计数（pending/processed/totalQueries）   | 无                                                                       |
| `ipquery_queue_top`      | ops      | 查询次数最高的未知 IP                                   | `limit`（1-100，默认 20）                                                |
| `ipquery_queries_recent` | ops      | 最近查询日志（最新在前）                                | `limit`（1-50，默认 10）、`status`（hit/miss/invalid）、`includePrivate` |
| `ipquery_queries_daily`  | ops      | 按天查询量曲线                                          | `days`（1-90，默认 30）                                                  |

## 前提

```bash
npm install        # 依赖
npm run build      # 产出 dist/mcp/server.js
```

`.env` 必须位于项目根目录（DB 连接配置）。server 启动时按脚本自身位置定位
项目根的 `.env`，与 AI 客户端启动时的 cwd 无关。

## 凭证：MCP Token

MCP server 需要一枚 **MCP Token** 才能在受控环境下工作。Token 有两种权限范围：

| 范围      | 可用工具                     | 说明                                       |
| --------- | ---------------------------- | ------------------------------------------ |
| `lookup`  | 仅 `ipquery_lookup`          | 只需要查 IP 归属地时用这个                 |
| `ops`     | 全部 7 个                    | 可读查询日志、回填队列、ETL 状态等运维数据 |

**Token 需要管理员批准。** 用户在控制台 `/dashboard/mcp-tokens` 申请，管理员在
`/admin/mcp-tokens` 批准或拒绝 —— 批准前 token 不生效，server 会拒绝连接。

这是刻意的：5 个工具读的是运维数据（`ipquery_queries_recent` 会返回用户邮箱、
API Key 前缀），不能让任何人自助拿到。API Key（`/dashboard/keys`）依旧是自助创建
的，两套凭证互不影响。

### 本机开发：免 token

不带 `IPQUERY_MCP_TOKEN` 启动时，server 以 **local 模式** 运行，7 个工具全开。
这是为了让开发者在本机 `node dist/mcp/server.js` 直接可用。

生产环境请设置 `MCP_REQUIRE_TOKEN=true` —— 此时没有 token 的 server **启动即失败**，
而不是降级成免认证运行。

## 接入配置

### Claude Code

**推荐**（免交互批准，user scope）：

```bash
# 先在控制台申请并等待管理员批准，拿到 ipqt_ 开头的 token
claude mcp add --scope user ipquery -- \
  --env IPQUERY_MCP_TOKEN=ipqt_xxxxxxxx \
  node /绝对路径/IPQuery/dist/mcp/server.js
```

单次调用方式（适合脚本 / CI）。用 `--mcp-config=<路径>` 的等号写法，提示词的位置
就不会跟配置路径打架：

```bash
claude -p --mcp-config=./.mcp.json "查一下 8.8.8.8"
```

`--mcp-config` 读进来的 server 属于 dynamic scope，不走 project scope 的
首次批准门槛，因此不需要先在 `~/.claude/settings.json` 里批准。实测一次调用即可
拿到全部 7 个工具。

**团队共享**（project scope，随仓库入库）：

仓库根目录已带 `.mcp.json`：

```json
{
  "mcpServers": {
    "ipquery": {
      "type": "stdio",
      "command": "ipquery-mcp",
      "args": []
    }
  }
}
```

这里用 `ipquery-mcp` 命令而不是脚本路径，是有意的：`.mcp.json` 会被
Cursor、Claude Desktop 等其它客户端读取，而 Claude Code **不会**向项目级
`.mcp.json` 注入 `${workspaceFolder}` 这类变量——它只按普通环境变量去展开，
找不到就报 `Missing environment variables: workspaceFolder`，server 根本起不来。
改成走 `bin` 之后，配置与安装路径彻底解耦，谁装在哪儿都不影响。

> 如果暂时还没做全局安装，`ipquery-mcp` 不在 `PATH` 里，server 同样起不来。
> 先跑下面的[全局安装](#全局安装路径无关)再回到这里。

Claude Code 出于安全考虑，**首次使用需要手动批准一次**该 server（提示出现在
会话启动时）。批准之后，server 名被记进 `~/.claude/settings.json` 的
`enabledMcpjsonServers` 列表（会话级选择在 `~/.claude.json` 的
`projects.<路径>` 里；两者都能生效）。

想跳过这一步，可以在 `~/.claude/settings.json` 里写：

```json
{
  "enabledMcpjsonServers": ["ipquery"]
}
```

或者一次性批准本项目的全部 server：

```json
{
  "enableAllProjectMcpServers": true
}
```

这两个开关都是**用户级**设置，不进仓库 —— 批准与否由每个使用者自己决定。

### Cursor / Claude Desktop（JSON 配置）

```json
{
  "mcpServers": {
    "ipquery": {
      "command": "node",
      "args": ["E:\\ToolDevelop\\IPQuery\\dist\\mcp\\server.js"],
      "env": {
        "IPQUERY_MCP_TOKEN": "ipqt_xxxxxxxx"
      }
    }
  }
}
```

### 全局安装（路径无关）

`package.json` 声明了 `bin`：

```bash
npm install -g /绝对路径/IPQuery     # 或 npm link
claude mcp add --scope user ipquery -- ipquery-mcp
```

这样注册命令与安装路径无关，换机器不用改配置。

用发布包（`up/` 目录）安装同样可以，它也声明了同一个 `bin`：

```bash
npm install -g /绝对路径/IPQuery/up
claude mcp add --scope user ipquery -- ipquery-mcp
```

## 环境变量

| 变量                 | 说明                                                          |
| -------------------- | ------------------------------------------------------------- |
| `IPQUERY_MCP_TOKEN`  | MCP Token 明文。不设 = local 模式（7 工具全开）              |
| `MCP_REQUIRE_TOKEN`  | 设为 `true` / `1` 时，没有 token 的 server 启动即失败          |

## 隐私

`ipquery_queries_recent` 默认脱敏：`userEmail` → `p***@e***.com` 格式、
`apiKeyPrefix` 只留前 4 字符。传 `includePrivate: true` 才返回原文（仅建议
本机可信环境排障时使用）。

`lookup` 范围的 token 根本看不到这个工具 —— 脱敏之外还有一层结构性的隔离。

## 行为说明

- `ipquery_lookup` 与 HTTP API `/lookup` 行为一致：查询未命中的 IP 会写入
  `unknown_ip_queue`，由后台回填任务做多提供商投票补齐；MCP 查询不写查询日志。
- DB 不可达时 server 启动即失败（stderr 明确报错，exit 1），不会带着坏连接运行。
- token 未批准 / 已吊销 / 不存在时，server **启动即失败**并说明原因 —— 不会
  先连上再在每次调用时报错。
- 权限范围在 `tools/list` 阶段就生效：`lookup` 范围的客户端根本看不到运维工具。
- 所有诊断日志走 stderr，stdout 只承载 MCP 协议帧。
