// SPDX-License-Identifier: MIT
// End-to-end test of the MCP stdio server.
//
// The unit tests cover the tool handlers; nothing covered the *protocol*:
// the JSON-RPC handshake, the tools/list response, the shape of a
// tools/call result, and the difference between "the tool failed" and
// "the tool answered that it found nothing". Those are exactly the
// parts an AI client sees, and exactly the parts that break silently —
// a server that never answers initialize leaves the client hanging with
// no error anywhere.
//
// So this test runs the real thing: it spawns the actual server
// process and talks MCP to it over stdio with the SDK's own client.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { TOOL_NAMES } from "../../src/mcp/tool-names";

let td: TestDb;
let client: Client;
let transport: StdioClientTransport;
// Everything the server wrote to stderr, collected as it arrived. The
// stderr stream is a PassThrough the SDK hands out once the child has
// started, so the listener has to be attached before the first read.
let stderrChunks: string[] = [];

// A /24 in right-aligned 16-byte form — the shape parseIp() writes.
const RANGE_START = "000000000000000000000000cb007100";
const RANGE_END = "000000000000000000000000cb00717f";

beforeAll(async () => {
  td = await createTestDb("mcp_e2e");

  // The server reads its own config from the environment (dotenv does
  // not override variables that are already set), so pointing DB_NAME at
  // the throwaway database is enough — no .env edit, no risk of the
  // test touching the real install.
  const cfg = loadConfig();
  const transportOptions = {
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: "development",
      DB_NAME: td.dbName,
      DB_HOST: cfg.db.host,
      DB_PORT: String(cfg.db.port),
      DB_USER: cfg.db.user,
      DB_PASSWORD: cfg.db.password,
      // The server exits(1) on a missing config; keep the secrets out
      // of the way so it reaches the "ready" line.
      SESSION_SECRET: "e2e-session-secret-not-a-real-credential",
      CSRF_SECRET: "e2e-csrf-secret-not-a-real-credential",
    },
    stderr: "pipe",
  } as const;

  transport = new StdioClientTransport(transportOptions);
  client = new Client({ name: "ipquery-e2e-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // The server writes its "ready" line during startup, which happens
  // inside connect(). Attach the listener right after and read what is
  // already buffered plus whatever arrives next.
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });
    // Drain whatever was written before the listener attached.
    stderrStream.read();
  }

  // Seed a range the lookup tool can find.
  await td.pool.query(
    `INSERT INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        latitude, longitude, geo_source, country_source, city_source)
     VALUES (UNHEX(?), UNHEX(?), 255, 'HK', NULL, 'Central and Western', 'Central',
             22.3193, 114.1694, 'dbip', 'dbip', 'dbip')`,
    [RANGE_START, RANGE_END],
  );
});

afterAll(async () => {
  await client?.close();
  await transport?.close();
  await dropTestDb(td);
});

describe("the MCP stdio server", () => {
  it("completes the initialize handshake and reports its identity", () => {
    expect(client.getServerVersion()).toEqual({ name: "ipquery", version: "1.0.0" });
  });

  it("advertises exactly the 7 read-only tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    // Every tool must carry a description and a JSON schema — a client
    // renders these in the tool picker, and an empty one makes the tool
    // unusable and unrecognisable.
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} has no input schema`).toBeTruthy();
    }
  });

  it("looks an IP up and returns the geolocation", async () => {
    const result = await client.callTool({ name: "ipquery_lookup", arguments: { ip: "203.0.113.10" } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as { ip: string; country: { code: string; name: string } };
    expect(payload.ip).toBe("203.0.113.10");
    expect(payload.country.code).toBe("HK");
    // The ISO fallback: the row carries no country_name, but the API
    // still answers with a name.
    expect(payload.country.name).toBe("Hong Kong");
  });

  it("answers an unknown IP without flagging a protocol-level error", async () => {
    // A miss is a legitimate answer, not a tool failure. A client that
    // sees isError will report "the tool broke" instead of "no data".
    const result = await client.callTool({
      name: "ipquery_lookup",
      arguments: { ip: "198.51.100.77" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });

  it("flags an invalid IP as a tool error", async () => {
    const result = await client.callTool({
      name: "ipquery_lookup",
      arguments: { ip: "not-an-ip" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("invalid ip");
  });

  it("rejects an unknown tool name with a helpful message", async () => {
    const result = await client.callTool({ name: "ipquery_nope", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Unknown tool");
    // The message lists what IS available — otherwise the caller has
    // no way to recover short of guessing.
    expect(text).toContain("ipquery_lookup");
  });

  it("returns the library stats through the protocol", async () => {
    const result = await client.callTool({ name: "ipquery_stats", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as { lastRun: unknown };
    // The shape is the contract; whether a run has happened is not.
    expect(payload).toHaveProperty("lastRun");
  });

  it("returns the queue stats through the protocol", async () => {
    const result = await client.callTool({ name: "ipquery_queue_stats", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload).toHaveProperty("pending");
  });

  it("returns the daily query buckets through the protocol", async () => {
    const result = await client.callTool({ name: "ipquery_queries_daily", arguments: { days: 3 } });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as Array<{ day: string; count: number }>;
    // The tool answers with a bare array of { day, count } — one bucket
    // per day, oldest first.
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(3);
    for (const bucket of payload) {
      expect(typeof bucket.day).toBe("string");
      expect(typeof bucket.count).toBe("number");
    }
  });

  it("keeps stdout clean so the protocol stream is never corrupted", async () => {
    // The server owns stdout for JSON-RPC. A stray console.log would
    // interleave with the protocol frames and break the client — the
    // SDK's own framing would choke on it.
    //
    // The server logs to stderr, which is what the SDK's stderr pipe is
    // for, so the "ready" line must have arrived there. If it had gone
    // to stdout instead, the client would already have failed to parse
    // it — and it did not, which is the real proof.
    const stderrStream = transport.stderr;
    expect(stderrStream).not.toBeNull();
    // Give the stream a moment to deliver whatever is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const collected = stderrChunks.join("");
    expect(collected).toContain("ready");
    // The ready line names the tool count — a server that registered
    // fewer tools than it claims would still say "ready".
    expect(collected).toContain(`${TOOL_NAMES.length} tools`);
  });
});
