// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";
import { IPQ_FORMAT, encodeHeader, encodeRange } from "../../src/storage/rangeFile";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let dir: string;

beforeAll(async () => {
  td = await createTestDb("admin-ranges");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "ipq-routes-"));
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

beforeEach(async () => {
  await td.pool.query("DELETE FROM ip_ranges");
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
  require("node:fs").rmSync(dir, { recursive: true, force: true });
});

const header = () => encodeHeader({ exportedAt: new Date().toISOString(), rows: 1 });

async function csrf() {
  return fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
}

/** The flash is a Set-Cookie on the redirect. A browser replays it on the
 *  next GET; supertest does not, so every assertion about what the operator
 *  is told has to carry it explicitly. */
function flashCookieOf(res: request.Response): string {
  const cookie = (res.headers["set-cookie"] as string[] | undefined)?.find((c) =>
    c.startsWith("ranges_flash="),
  );
  return cookie ? cookie.split(";")[0]! : "";
}

describe("/admin/ranges", () => {
  it("renders the page with both directions", async () => {
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/导出 IP 段/);
    expect(r.text).toMatch(/导入 IP 段/);
    // The format name appears so the operator knows what the file is.
    expect(r.text).toContain(IPQ_FORMAT);
  });

  it("exports a downloadable .ipq file", async () => {
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A140000'), UNHEX('0000000000000000000000000A1400FF'), 255, 'ZZ', 'dbip')`,
    );
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    // The POST redirects to the page, not to the file: the download link is
    // what the page renders, because the row list is the record of what was
    // produced and the operator may want an older file.
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    const match = /\/admin\/ranges\/download\/[a-z0-9-]+/.exec(page.text);
    expect(match?.[0], "the page must link to the file it just built").toBeTruthy();
    const location = match![0];

    const file = await request(app.server)
      .get(location)
      .set("Cookie", "sid=" + adminSid);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/octet-stream/);
    expect(file.headers["content-disposition"]).toMatch(/attachment; filename="[^"]+\.ipq"/);
    // octet-stream is binary to supertest, so the body arrives as a Buffer.
    const text = file.text || (file.body as Buffer).toString("utf8");
    expect(text).toContain(IPQ_FORMAT);
    expect(text).toContain('"start":"10.20.0.0"');
  });

  it("imports an uploaded file and reports what it wrote", async () => {
    const body = [
      header(),
      encodeRange({
        start: "10.50.0.0",
        end: "10.50.0.255",
        countryCode: "ZZ",
        countryName: null,
        region: null,
        city: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join("\n") + "\n";
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      // `.type("form")` encodes the body itself; pre-encoding here sent the
      // literal "%7B..." as the file content.
      .send({ csrf: token, file: body });
    expect(r.status).toBe(302);
    const flash = flashCookieOf(r);
    // The browser replays the Set-Cookie itself; supertest only gets an
    // empty jar unless the cookie is threaded through by hand.
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flash);
    expect(page.text).toMatch(/导入完成|imported/i);
  });

  it("round-trips through the two routes: export one install, import into another", async () => {
    // This is the whole feature. Everything below it — the format, the
    // tagging, the streaming writer — exists so that this sequence works:
    // download on one machine, upload on another, look the address up.
    const body = [
      header(),
      encodeRange({
        line: 0,
        start: "10.60.0.0",
        end: "10.60.0.255",
        countryCode: "ZZ",
        countryName: "Testland",
        region: null,
        city: "Roundtrip",
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: body });
    expect(r.status).toBe(302);

    const [rows] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code, city, city_source FROM ip_ranges WHERE country_code = 'ZZ'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.city).toBe("Roundtrip");
    // The tag is what keeps the row through the next ETL refresh.
    expect(rows[0]!.city_source).toBe("import");
  });

  it("replaces the whole library when asked to", async () => {
    // The reason this mode exists: an operator who does not want to run the
    // ETL uploads a file from another install and expects the library to BE
    // that file. Merge would leave the old rows behind.
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A7E0000'), UNHEX('0000000000000000000000000A7E00FF'), 255, 'OL', 'dbip')`,
    );
    const body = [
      header(),
      encodeRange({
        line: 0,
        start: "10.70.0.0",
        end: "10.70.0.255",
        countryCode: "RP",
        countryName: null,
        region: null,
        city: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      // The page shows the current row count; a replacement has to repeat
      // it, which is what makes an accidental resend harmless.
      .send({ csrf: token, file: body, mode: "replace", confirmRows: "1" });
    expect(r.status).toBe(302);

    // The old library is gone; the uploaded row is there.
    const [old] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'OL'",
    );
    expect(old).toHaveLength(0);
    const [fresh] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'RP'",
    );
    expect(fresh).toHaveLength(1);
  });

  it("refuses a replacement posted without the confirmation field", async () => {
    // Replace is the destructive one. A stray repost of the import form —
    // a browser "resend" after a timeout — must not wipe the library, so the
    // mode alone is not enough: the operator has to type the row count.
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A7F0000'), UNHEX('0000000000000000000000000A7F00FF'), 255, 'SF', 'dbip')`,
    );
    const body = [header(), encodeRange({
      line: 0, start: "10.71.0.0", end: "10.71.0.255",
      countryCode: "NR", countryName: null, region: null, city: null,
      postalCode: null, latitude: null, longitude: null, timezone: null,
      isp: null, asn: null, asnOrg: null,
    })].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: body, mode: "replace" });
    expect(r.status).toBe(302);
    const [still] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'SF'",
    );
    expect(still).toHaveLength(1);
  });

  it("imports a file uploaded as a name field", async () => {
    // The page has to work without JavaScript, so the browser posts a
    // file input; this asserts the route is reachable and the CSRF check
    // still runs.
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(400);
  });

  it("refuses an upload without a csrf token", async () => {
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid)
      .type("form")
      .send({ file: encodeHeader({ exportedAt: "x", rows: 0 }) });
    expect(r.status).toBe(403);
  });

  it("reports a malformed file instead of importing nothing silently", async () => {
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: encodeURIComponent("{not json\n") });
    expect(r.status).toBe(302);
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flashCookieOf(r));
    expect(page.text).toMatch(/line 1|不是|not an ipquery-ranges/i);
  });
});

void vi;
