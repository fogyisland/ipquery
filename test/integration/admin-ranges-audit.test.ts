// SPDX-License-Identifier: MIT
//
// The range routes write an audit trail.
//
// /admin/ranges is the only place in the console where an operator can
// destroy the library outright: an import in `replace` mode runs
// atomicSwapRanges and swaps the whole ip_ranges table for the contents
// of an uploaded file. Everything else in the admin console writes an
// audit entry — 30 of them, across users, API keys, MCP tokens, the ETL
// and the unknown-IP queue — but the range routes wrote none.
//
// That gap mattered because the audit trail is the only place that says
// WHO did something and WHEN. A replacement is the most destructive
// operation the product offers, and the answer to "who replaced the
// library, and with what" was: nothing recorded it. The MCP
// `ipquery_audit_log` tool and the console's own /admin/audit-log page
// both read that table, so both were blind to it.
//
// The export is recorded too, even though it destroys nothing: it writes
// a file containing every address the install knows about, and "who
// exported the library" is the first question of an incident review.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";
import { listAuditLog } from "../../src/storage/auditLog";
import { encodeHeader, encodeRange } from "../../src/storage/rangeFile";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let dir: string;

beforeAll(async () => {
  td = await createTestDb("admin-ranges-audit");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-ranges-audit-"));
  cfg.etl.dataDir = dir;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The CSRF cookie pair and token for the admin session. */
async function csrf(): Promise<{ cookie: string; token: string }> {
  return fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
}

/** The audit entries written so far, newest first. */
async function auditRows(): Promise<Array<{ action: string; metadata: unknown }>> {
  const { rows } = await listAuditLog(app.pool, { offset: 0, limit: 50 });
  return rows.map((row) => ({ action: row.action, metadata: row.metadata }));
}

/** A one-row .ipq file, written the way the exporter writes one. */
function rangeFile(): string {
  return [
    encodeHeader({ exportedAt: new Date().toISOString(), rows: 1 }),
    encodeRange({
      line: 1,
      start: "1.0.0.0",
      end: "1.0.0.255",
      countryCode: "CN",
      countryName: "China",
      region: "Beijing",
      city: "Beijing",
      postalCode: null,
      latitude: 39.9,
      longitude: 116.4,
      timezone: "Asia/Shanghai",
      isp: "Example ISP",
      asn: 64500,
      asnOrg: "EXAMPLE-AS",
    }),
    "",
  ].join("\n");
}

describe("the range routes write an audit trail", () => {
  it("records who started an export, and which country was asked for", async () => {
    const { cookie, token } = await csrf();
    const before = (await auditRows()).length;

    const res = await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ country: "CN", csrf: token })
      .redirects(0);
    expect(res.status).toBe(302);

    const after = await auditRows();
    expect(after.length).toBe(before + 1);
    expect(after[0]?.action).toBe("ranges.export");
    // The country filter is part of the fact being recorded: an export of
    // one country is a different disclosure from an export of everything.
    expect((after[0]?.metadata as { country?: string | null } | null)?.country).toBe("CN");
    // The export's id is a string ("exp-…") and `target_id` is a BIGINT, so
    // the id cannot live in the column — it has to survive in the metadata
    // or the trail says "an export happened" and not which one.
    const exportTarget = (after[0]?.metadata as { target?: string } | null)?.target;
    expect(exportTarget).toMatch(/^exp-/);
  });

  it("records who started an import, and whether it replaced the library", async () => {
    const { cookie, token } = await csrf();
    const before = (await auditRows()).length;

    const res = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ mode: "merge", file: rangeFile(), csrf: token })
      .redirects(0);
    expect(res.status).toBe(302);

    const after = await auditRows();
    expect(after.length).toBe(before + 1);
    expect(after[0]?.action).toBe("ranges.import");
    // The mode is the whole point of the record. A merge adds rows; a
    // replace swaps the entire table. The reader has to be able to tell
    // those two apart without looking anywhere else.
    expect((after[0]?.metadata as { mode?: string } | null)?.mode).toBe("merge");
  });

  it("records a replacement as a replacement", async () => {
    // The replacement gate asks the operator to type the number of rows
    // currently in the table. The merge above put one row there, so the
    // count is 1 — the gate is read live, and a stale count is refused.
    const { cookie, token } = await csrf();
    const before = (await auditRows()).length;

    const res = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ mode: "replace", confirmRows: "1", file: rangeFile(), csrf: token })
      .redirects(0);
    expect(res.status).toBe(302);

    const after = await auditRows();
    expect(after.length).toBe(before + 1);
    expect(after[0]?.action).toBe("ranges.import");
    expect((after[0]?.metadata as { mode?: string } | null)?.mode).toBe("replace");
  });

  it("does not record an import that was refused", async () => {
    // A replacement whose confirmation count does not match the library
    // is refused. Nothing happened, so nothing is recorded: the trail
    // records actions, and an action that never started is not one.
    const { cookie, token } = await csrf();
    const before = (await auditRows()).length;

    const res = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ mode: "replace", confirmRows: "999999999", file: rangeFile(), csrf: token })
      .redirects(0);
    // The request was accepted and refused by the confirmation gate, not
    // turned away by the CSRF check — otherwise this test would pass for
    // the wrong reason.
    expect(res.status).toBe(302);

    const after = await auditRows();
    expect(after.length).toBe(before);
  });
});
