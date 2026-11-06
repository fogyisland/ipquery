# IPQuery MCP Server

IPQuery 以 MCP (Model Context Protocol) server 形式暴露 7 个只读工具，AI 工具
（Claude Code、Cursor、Claude Desktop 等）通过 stdio 一行配置即可接入。

## 前提

```bash
npm install        # 依赖
npm run build      # 产出 dist/mcp/server.js
```

`.env` 必须位于项目根目录（DB 连接配置）。server 启动时按脚本自身位置定位
项目根的 `.env`，与 AI 客户端启动时的 cwd 无关。

## 接入配置

### Claude Code

```bash
claude mcp add ipquery -- node E:\ToolDevelop\IPQuery\dist\mcp\server.js
```

### Cursor / Claude Desktop（JSON 配置）

```json
{
  "mcpServers": {
    "ipquery": {
      "command": "node",
      "args": ["E:\\ToolDevelop\\IPQuery\\dist\\mcp\\server.js"]
    }
  }
}
```

## 工具一览（全部只读）

| 工具                     | 说明                                                                  | 参数                                                                     |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ipquery_lookup`         | 查询 IPv4/IPv6 归属地（国家/城市/时区/ISP/ASN）；未知 IP 进入回填队列 | `ip`（必填）                                                             |
| `ipquery_stats`          | 库规模摘要：最近 ETL run + 各源记录数                                 | 无                                                                       |
| `ipquery_etl_status`     | 最近 ETL run 详情 + 队列概要                                          | 无                                                                       |
| `ipquery_queue_stats`    | unknown-IP 队列计数（pending/processed/totalQueries）                 | 无                                                                       |
| `ipquery_queue_top`      | 查询次数最高的未知 IP                                                 | `limit`（1-100，默认 20）                                                |
| `ipquery_queries_recent` | 最近查询日志（最新在前）                                              | `limit`（1-50，默认 10）、`status`（hit/miss/invalid）、`includePrivate` |
| `ipquery_queries_daily`  | 按天查询量曲线                                                        | `days`（1-90，默认 30）                                                  |

## 隐私

`ipquery_queries_recent` 默认脱敏：`userEmail` → `p***@e***.com` 格式、
`apiKeyPrefix` 只留前 4 字符。传 `includePrivate: true` 才返回原文（仅建议
本机可信环境排障时使用）。

## 行为说明

- `ipquery_lookup` 与 HTTP API `/lookup` 行为一致：查询未命中的 IP 会写入
  `unknown_ip_queue`，由后台回填任务做多提供商投票补齐；MCP 查询不写查询日志。
- DB 不可达时 server 启动即失败（stderr 明确报错，exit 1），不会带着坏连接运行。
- 所有诊断日志走 stderr，stdout 只承载 MCP 协议帧。
