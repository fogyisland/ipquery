// SPDX-License-Identifier: MIT
//
// Probe the built MCP server over stdio.
//
// Speaks JSON-RPC to `dist/mcp/server.js`: initialize, tools/list, and
// one tools/call. Prints what came back.
//
// This is a development probe, not a test — the test suite covers the
// tool's behaviour against a fake pool. What this checks is the thing
// a unit test cannot: that the *built* server really starts, really
// registers the tool, and really answers it.
//
// Usage: node scripts/dev/mcp-probe.cjs [tool-name] [arguments-json]
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const TOOL_NAME = process.argv[2] || "ipquery_etl_sources";
const SERVER = path.resolve(__dirname, "..", "..", "dist", "mcp", "server.js");

/** Collect the child's stdout, one JSON-RPC message per line. */
function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") lines.push(line);
      index = buffer.indexOf("\n");
    }
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  return { child, lines, errors };
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function parse(lines) {
  const messages = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // The server writes a human-readable banner on stdout before
      // the JSON-RPC stream starts; anything unparseable is that.
    }
  }
  return messages;
}

async function main() {
  const { child, lines, errors } = startServer();

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-probe", version: "1.0.0" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 400));
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // A second argument lets the probe exercise the tools that need
  // one (a run id, a list of addresses).
  const ARGUMENTS = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: ARGUMENTS },
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const messages = parse(lines);
  const init = messages.find((m) => m.id === 1);
  const list = messages.find((m) => m.id === 2);
  const call = messages.find((m) => m.id === 3);

  console.log("INIT:", init ? `${init.result.serverInfo.name} v${init.result.serverInfo.version}` : "(no response)");

  if (list && list.result && Array.isArray(list.result.tools)) {
    console.log(`TOOLS: ${list.result.tools.length}`);
    for (const tool of list.result.tools) console.log("  -", tool.name);
  } else {
    console.log("TOOLS: (no response)");
  }

  if (call && call.result && Array.isArray(call.result.content)) {
    console.log(`CALL ${TOOL_NAME}:`);
    console.log(call.result.content[0].text);
  } else if (call && call.error) {
    console.log(`CALL ${TOOL_NAME}: ERROR ${JSON.stringify(call.error)}`);
  } else {
    console.log(`CALL ${TOOL_NAME}: (no response)`);
  }

  if (errors.length > 0) {
    console.log("STDERR:");
    console.log(errors.join("").trim());
  }

  child.stdin.end();
  child.kill();
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
