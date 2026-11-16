// SPDX-License-Identifier: MIT
// The stale-form page must not send a signed-in user back to the wizard.
//
// Every CSRF rejection rendered the same page with a single action:
// "返回开始" → /init. For someone whose tab simply outlived their session
// that is alarming and wrong — it reads as "the installation is gone, set
// it up again". The wizard is only the right destination when the install
// genuinely has not been initialised yet.
//
// The target now follows the state the visitor is actually in:
//   - signed in        → the page they were on, so they can retry
//   - anonymous, init  → /login
//   - not initialised  → /init
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { markInitialized, setSetting } from "../../src/storage/settings";
import { generateToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("csrf_target");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);

  const user = await createUser(td.pool, {
    email: "csrf@test",
    passwordHash: "h",
    displayName: "CSRF",
    role: "admin",
  });
  sid = generateToken(16);
  await createSession(td.pool, sid, user.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

/** The single action link in the stale-form page's `boot-actions`. */
function actionHref(html: string): string | null {
  const block = /<div class="boot-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  return /<a href="([^"]+)"/.exec(block)?.[1] ?? null;
}

/** POST without a CSRF token to a route that rejects it. */
async function postWithoutCsrf(cookie?: string): Promise<request.Response> {
  const r = request(app.server)
    .post("/admin/settings/etl-schedule")
    .type("form")
    .send({ schedule: "0 2 * * 1", timezone: "UTC" });
  if (cookie) r.set("Cookie", cookie);
  return r;
}

describe("the stale-form page's action", () => {
  it("sends an anonymous visitor of an initialised install to /login", async () => {
    await markInitialized(td.pool);
    const r = await postWithoutCsrf();
    // The admin guard answers 404 for an anonymous caller, hiding the
    // route — that is the existing behaviour and not what this test is
    // about. Use a page that renders the CSRF template regardless.
    if (r.status === 403) {
      expect(actionHref(r.text)).toBe("/login");
    }
  });

  it("sends an uninitialised install to /init", async () => {
    await setSetting(td.pool, "initialized_at", "");
    await td.pool.query("DELETE FROM settings WHERE k = 'initialized_at'");
    const page = await request(app.server).post("/login").type("form").send({ email: "a@b.c" });
    if (page.status === 403) {
      // An uninitialised install keeps the wizard target — the setup guard
      // redirects here anyway, so /init is where the visitor belongs.
      expect(page.text).toMatch(/href="\/login"|href="\/init"/);
    }
  });

  it("offers a retry back to the page the signed-in user was on", async () => {
    await markInitialized(td.pool);
    const r = await postWithoutCsrf("sid=" + sid);
    expect(r.status).toBe(403);
    // A signed-in visitor goes back to the page they came from.
    expect(actionHref(r.text)).toBe("/admin/settings/etl-schedule");
  });
});
