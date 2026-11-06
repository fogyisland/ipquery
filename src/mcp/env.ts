// SPDX-License-Identifier: MIT
import path from "node:path";

/**
 * 项目根目录。编译产物位于 dist/mcp/，源码位于 src/mcp/ —— 两者相对项目根
 * 都恰好两级，因此统一 __dirname 上溯两级即可，无需区分编译/源码场景。
 */
export function resolveProjectRoot(): string {
  return path.resolve(__dirname, "..", "..");
}
