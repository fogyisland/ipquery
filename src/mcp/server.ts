// SPDX-License-Identifier: MIT
// MCP stdio server 入口。stdio 通道被 MCP 协议占用，所有诊断输出走 stderr。
import { config as dotenvConfig } from "dotenv";
import { resolveProjectRoot } from "./env";

dotenvConfig({ path: `${resolveProjectRoot()}/.env`, quiet: true });
