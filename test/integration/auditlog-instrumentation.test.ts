// SPDX-License-Identifier: MIT
// Tests that the admin POST handlers instrument themselves with
// `req.auditAction` so the auditLog plugin records them automatically.
// Exercises ONE of the five instrumented handlers end-to-end:
// POST `/admin/users/:id/verify-email` -> wait -> GET `/admin/audit-log` -> assert row.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser, findUserByEmail } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let targetId: number;

beforeAll(async () => {
  td = await createTestDb("auditlog-instrumentation");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "Admin",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  const target = await createUser(app.pool, {
    email: "target@x.com",
    passwordHash: "h",
    displayName: "Target",
  });
  targetId = target.id;
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/users")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe("admin POSTs set req.auditAction", () => {
  it("records user.verify_email when admin verifies target user email", async () => {
    const before = await td.pool.query("SELECT COUNT(*) AS c FROM admin_audit_log");
    const beforeN = Number((before[0] as { c: number }[])[0].c);
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post(`/admin/users/${targetId}/verify-email`)
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    // Wait for the onResponse hook's fire-and-forget recordAuditLog to flush.
    // Polling rather than a fixed timeout: the hook awaits a real DB write
    // (no fake timer), so under heavy parallel-suite load a fixed 200ms wait
    // can race and produce a flaky failure here.
    const deadline = Date.now() + 2000;
    let rows: unknown[] = [];
    while (Date.now() < deadline) {
      const [r2] = await td.pool.query("SELECT * FROM admin_audit_log WHERE action = 'user.verify_email'");
      if (r2.length > 0) {
        rows = r2;
        break;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    if (rows.length === 0) {
      throw new Error("audit log row did not appear within 2000ms");
    }
    const arr = rows as unknown as {
      id: number;
      action: string;
      target_type: string;
      target_id: number;
      actor_email: string;
    }[];
    expect(arr.length).toBe(1);
    expect(arr[0].target_type).toBe("user");
    expect(arr[0].target_id).toBe(targetId);
    // actor_email is the admin's email — verifying the audit chain attributes
    // the action to the logged-in admin, not the target user.
    const admin = await findUserByEmail(td.pool, "admin@x.com");
    expect(arr[0].actor_email).toBe("admin@x.com");
    expect(admin).not.toBeNull();
    // Sanity check that the audit count grew by exactly 1.
    const after = await td.pool.query("SELECT COUNT(*) AS c FROM admin_audit_log");
    const afterN = Number((after[0] as { c: number }[])[0].c);
    expect(afterN).toBe(beforeN + 1);
  });
});
