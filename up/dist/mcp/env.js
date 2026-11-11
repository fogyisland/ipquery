"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProjectRoot = resolveProjectRoot;
// SPDX-License-Identifier: MIT
const node_path_1 = __importDefault(require("node:path"));
/**
 * 项目根目录。编译产物位于 dist/mcp/，源码位于 src/mcp/ —— 两者相对项目根
 * 都恰好两级，因此统一 __dirname 上溯两级即可，无需区分编译/源码场景。
 */
function resolveProjectRoot() {
    return node_path_1.default.resolve(__dirname, "..", "..");
}
//# sourceMappingURL=env.js.map