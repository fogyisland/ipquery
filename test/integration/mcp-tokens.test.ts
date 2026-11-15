// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken, generateMcpToken, hashToken } from "../../src/web/auth/tokens";
import {
  createMcpToken,
  findMcpTokenById,
  findApprovedMcpTokenByHash,
  decideMcpToken,
} from "../../src/storage/mcpTokens";
import { authenticate } from "../../src/mcp/auth";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let userSid: string;
let adminId: number;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("mcp-tokens");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);

  const user = await createUser(app.pool, {
    email: "u@x.com",
    passwordHash: "h",
    displayName: "U",
  });
  userId = user.id;
  userSid = generateToken(16);
  await createSession(app.pool, userSid, userId, new Date(Date.now() + 3600_000));

  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminId = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminId, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

/** Fetch the CSRF triple the dashboard/admin pages hand out. */
async function csrfOf(path: string, sid: string): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get(path).set("Cookie", "sid=" + sid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}; ${bindLine}`, token: tokenMatch[1]! };
}

describe("user-facing MCP token requests", () => {
  it("GET /dashboard/mcp-tokens renders the empty state", async () => {
    const r = await request(app.server)
      .get("/dashboard/mcp-tokens")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("暂无 MCP Token");
  });

  it("requires a signed-in session", async () => {
    const r = await request(app.server).get("/dashboard/mcp-tokens");
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/login");
  });

  it("a request starts as pending and shows the plaintext once", async () => {
    const { cookie, token } = await csrfOf("/dashboard/mcp-tokens", userSid);
    const r = await request(app.server)
      .post("/dashboard/mcp-tokens")
      .set("Cookie", "sid=" + userSid + "; " + cookie)
      .type("form")
      .send({ label: "my editor", scope: "lookup", csrf: token });
    expect(r.status).toBe(200);
    const m = /ipqt_[A-Z2-7]{52}/.exec(r.text);
    expect(m).not.toBeNull();

    // The token exists but is NOT approved, so it must not authenticate.
    const stored = await findApprovedMcpTokenByHash(app.pool, hashToken(m![0]));
    expect(stored).toBeNull();

    const [rows] = await app.pool.query<Array<{ status: string; scope: string } & Record<string, unknown>>>(
      "SELECT status, scope FROM mcp_tokens WHERE label = ?",
      ["my editor"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].scope).toBe("lookup");
  });

  it("never shows the plaintext again on a later page load", async () => {
    const r = await request(app.server)
      .get("/dashboard/mcp-tokens")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/ipqt_[A-Z2-7]{52}/);
  });

  it("rejects a request without a label", async () => {
    const { cookie, token } = await csrfOf("/dashboard/mcp-tokens", userSid);
    const r = await request(app.server)
      .post("/dashboard/mcp-tokens")
      .set("Cookie", "sid=" + userSid + "; " + cookie)
      .type("form")
      .send({ label: "   ", csrf: token });
    expect(r.status).toBe(400);
  });

  it("a user cannot revoke another user's token", async () => {
    const plain = generateMcpToken();
    // A genuinely different account — the token must not be reachable
    // from the current user's dashboard.
    const stranger = await createUser(app.pool, {
      email: "stranger@x.com",
      passwordHash: "h",
      displayName: "S",
    });
    const other = await createMcpToken(
      app.pool,
      stranger.id,
      "other",
      hashToken(plain),
      plain.slice(0, 12),
      "lookup",
    );
    const { cookie, token } = await csrfOf("/dashboard/mcp-tokens", userSid);
    const r = await request(app.server)
      .post(`/dashboard/mcp-tokens/${other.id}/revoke`)
      .set("Cookie", "sid=" + userSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(404);
  });
});

describe("admin approval", () => {
  it("GET /admin/mcp-tokens lists the pending requests", async () => {
    const plain = generateMcpToken();
    await createMcpToken(app.pool, userId, "awaiting", hashToken(plain), plain.slice(0, 12), "ops");
    const r = await request(app.server)
      .get("/admin/mcp-tokens")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("awaiting");
    expect(r.text).toContain("待批准");
  });

  it("requires an admin session", async () => {
    const r = await request(app.server)
      .get("/admin/mcp-tokens")
      .set("Cookie", "sid=" + userSid);
    // The admin guard answers 404 for a signed-in non-admin — it must
    // not leak the existence of the approval queue.
    expect(r.status).toBe(404);
  });

  it("approving a token lets it authenticate the MCP server", async () => {
    const plain = generateMcpToken();
    const token = await createMcpToken(
      app.pool,
      userId,
      "to-approve",
      hashToken(plain),
      plain.slice(0, 12),
      "ops",
    );
    const { cookie, token: csrfValue } = await csrfOf("/admin/mcp-tokens", adminSid);
    const r = await request(app.server)
      .post(`/admin/mcp-tokens/${token.id}/approve`)
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: csrfValue, note: "internal tooling" });
    expect(r.status).toBe(302);

    const stored = await findMcpTokenById(app.pool, token.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedBy).toBe(adminId);
    expect(stored?.decisionNote).toBe("internal tooling");

    // The token now authenticates, with the scope it was granted.
    const auth = await authenticate(app.pool, plain, true);
    expect(auth.mode).toBe("token");
    expect(auth.scope).toBe("ops");
    expect(auth.allowedTools.size).toBe(7);
  });

  it("an approved lookup token reaches only the lookup tool", async () => {
    const plain = generateMcpToken();
    const token = await createMcpToken(
      app.pool,
      userId,
      "lookup-only",
      hashToken(plain),
      plain.slice(0, 12),
      "lookup",
    );
    await decideMcpToken(app.pool, token.id, "approved", adminId, null);
    const auth = await authenticate(app.pool, plain, true);
    expect(auth.scope).toBe("lookup");
    expect([...auth.allowedTools]).toEqual(["ipquery_lookup"]);
  });

  it("rejecting a token keeps it unusable", async () => {
    const plain = generateMcpToken();
    const token = await createMcpToken(
      app.pool,
      userId,
      "to-reject",
      hashToken(plain),
      plain.slice(0, 12),
      "ops",
    );
    const { cookie, token: csrfValue } = await csrfOf("/admin/mcp-tokens", adminSid);
    const r = await request(app.server)
      .post(`/admin/mcp-tokens/${token.id}/reject`)
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: csrfValue, note: "not needed" });
    expect(r.status).toBe(302);

    const stored = await findMcpTokenById(app.pool, token.id);
    expect(stored?.status).toBe("rejected");
    await expect(authenticate(app.pool, plain, true)).rejects.toThrow(/MCP token rejected/);
  });

  it("revoking an approved token disables it", async () => {
    const plain = generateMcpToken();
    const token = await createMcpToken(
      app.pool,
      userId,
      "to-revoke",
      hashToken(plain),
      plain.slice(0, 12),
      "ops",
    );
    await decideMcpToken(app.pool, token.id, "approved", adminId, null);
    const { cookie, token: csrfValue } = await csrfOf("/admin/mcp-tokens", adminSid);
    const r = await request(app.server)
      .post(`/admin/mcp-tokens/${token.id}/revoke`)
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: csrfValue });
    expect(r.status).toBe(302);

    const stored = await findMcpTokenById(app.pool, token.id);
    expect(stored?.status).toBe("revoked");
    expect(stored?.revokedAt).not.toBeNull();
    await expect(authenticate(app.pool, plain, true)).rejects.toThrow(/MCP token rejected/);
  });

  it("a pending token cannot be approved twice", async () => {
    const plain = generateMcpToken();
    const token = await createMcpToken(
      app.pool,
      userId,
      "twice",
      hashToken(plain),
      plain.slice(0, 12),
      "lookup",
    );
    const first = await decideMcpToken(app.pool, token.id, "approved", adminId, null);
    const second = await decideMcpToken(app.pool, token.id, "rejected", adminId, null);
    expect(first).toBe(1);
    expect(second).toBe(0);
    // The second decision must not overwrite the first.
    const stored = await findMcpTokenById(app.pool, token.id);
    expect(stored?.status).toBe("approved");
  });

  it("bulk approval decides every selected pending token", async () => {
    const first = await createMcpToken(
      app.pool,
      userId,
      "bulk-1",
      hashToken("ipqt_BULKONE"),
      "ipqt_BULKONE",
      "lookup",
    );
    const second = await createMcpToken(
      app.pool,
      userId,
      "bulk-2",
      hashToken("ipqt_BULKTWO"),
      "ipqt_BULKTWO",
      "lookup",
    );
    const { cookie, token: csrfValue } = await csrfOf("/admin/mcp-tokens", adminSid);
    const r = await request(app.server)
      .post("/admin/mcp-tokens/bulk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ ids: `${first.id},${second.id}`, action: "approve", csrf: csrfValue });
    expect(r.status).toBe(302);
    expect((await findMcpTokenById(app.pool, first.id))?.status).toBe("approved");
    expect((await findMcpTokenById(app.pool, second.id))?.status).toBe("approved");
  });

  it("renders no inline event handlers (CSP-safe)", async () => {
    const r = await request(app.server)
      .get("/admin/mcp-tokens")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/on(?:click|submit)=/);
  });
});
