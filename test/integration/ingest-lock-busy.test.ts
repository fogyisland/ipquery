// SPDX-License-Identifier: MIT
//
// The provider-fan-out mutex at the route level.
//
// The backfill route and the manual-generate route fan out to the same
// external IP-geo providers as the continuous random-IP runner. When
// another ingest path already holds the shared mutex, these routes must
// skip the run — no provider calls, no writes — and report the skip
// rather than an all-zero "success" summary.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { insertOrIncrement } from "../../src/storage/unknownIpQueue";
import { parseIp } from "../../src/ip";
import { providerFanoutLock } from "../../src/etl/providerLock";
import { csrfTripleFrom } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("ingest-lock-busy");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
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
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE unknown_ip_queue");
  await td.pool.query("TRUNCATE TABLE ip_ranges");
});

afterEach(() => {
  // Never leave the shared lock held — a stuck lock would break every
  // later test in the suite.
  providerFanoutLock.release();
});

/** Queue one pending IP so the backfill route has work to consider. */
async function queueOneIp(): Promise<void> {
  const ip = "203.0.113.10";
  await insertOrIncrement(td.pool, parseIp(ip)!, ip);
}

/** Build the auth + CSRF headers for a POST. */
async function postHeaders(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/admin/ingest").set("Cookie", `sid=${adminSid}`);
  const pair = csrfTripleFrom(r.headers["set-cookie"] as string[]);
  return { cookie: `sid=${adminSid}; ${pair.cookie}`, token: pair.token };
}

describe("backfill route — provider mutex busy", () => {
  it("skips the preview and bounces to /admin/ingest", async () => {
    await queueOneIp();
    providerFanoutLock.tryAcquire(); // simulate a concurrent ingest path

    const { cookie, token } = await postHeaders();
    const r = await request(app.server)
      .post("/admin/ingest/backfill/preview")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, batchLimit: "1" });

    expect(r.status).toBe(302);
    // Redirected to the ingest page, NOT to the preview page.
    expect(r.headers.location).toBe("/admin/ingest");
    // The preview cookie was NOT issued with a value — the route clears
    // any stale one, which Fastify sends as `backfill_preview=; Max-Age=0`.
    const setCookie = r.headers["set-cookie"] as string[];
    const previewCookie = setCookie.find((c) => c.startsWith("backfill_preview="));
    if (previewCookie) {
      const value = previewCookie.split(";")[0].split("=")[1];
      expect(value === "" || value === undefined).toBe(true);
    }
    // Nothing was written.
    const [ranges] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(ranges.length).toBe(0);
  });

  it("flashes a 'lock busy' summary rather than an all-zero success", async () => {
    await queueOneIp();
    providerFanoutLock.tryAcquire();

    const { cookie, token } = await postHeaders();
    const r = await request(app.server)
      .post("/admin/ingest/backfill/preview")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, batchLimit: "1" });

    const setCookie = r.headers["set-cookie"] as string[];
    const summaryCookie = setCookie.find((c) => c.startsWith("backfill_summary="));
    expect(summaryCookie).toBeDefined();
    const raw = decodeURIComponent(summaryCookie!.split(";")[0].split("=")[1]!);
    expect(JSON.parse(raw)).toEqual({ kind: "preview_lock_busy" });
  });

  it("leaves the queue rows pending so the next run picks them up", async () => {
    await queueOneIp();
    providerFanoutLock.tryAcquire();

    const { cookie, token } = await postHeaders();
    await request(app.server)
      .post("/admin/ingest/backfill/preview")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, batchLimit: "1" });

    const [rows] = await td.pool.query<{ processed_at: Date | null; last_attempt_reason: string | null }[]>(
      `SELECT processed_at, last_attempt_reason FROM unknown_ip_queue`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].processed_at).toBeNull();
    expect(rows[0].last_attempt_reason).toBeNull();
  });

  it("releases the shared lock so the next request is not blocked", async () => {
    await queueOneIp();
    providerFanoutLock.tryAcquire();
    providerFanoutLock.release();

    expect(providerFanoutLock.isLocked()).toBe(false);
    const { cookie, token } = await postHeaders();
    const r = await request(app.server)
      .post("/admin/ingest/backfill/preview")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, batchLimit: "1" });
    // With the lock free, the route proceeds to the preview page.
    expect(r.headers.location).toBe("/admin/ingest/backfill/preview");
  });
});

describe("manual generate route — provider mutex busy", () => {
  it("skips the run and flashes a 'lock busy' summary", async () => {
    providerFanoutLock.tryAcquire();

    const { cookie, token } = await postHeaders();
    const r = await request(app.server)
      .post("/admin/ingest/generate")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, count: "3" });

    expect(r.status).toBe(302);
    const setCookie = r.headers["set-cookie"] as string[];
    const summaryCookie = setCookie.find((c) => c.startsWith("generate_summary="));
    expect(summaryCookie).toBeDefined();
    const raw = decodeURIComponent(summaryCookie!.split(";")[0].split("=")[1]!);
    expect(JSON.parse(raw)).toEqual({ kind: "lock_busy" });

    // No ranges written.
    const [ranges] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(ranges.length).toBe(0);
  });
});
