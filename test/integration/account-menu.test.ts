// SPDX-License-Identifier: MIT
//
// The top-nav account menu.
//
// The marketing top nav used to show a bare "控制台" link for a signed-in
// visitor. The link went to /dashboard, which reads `ip_ranges` — so a
// slow or locked library made the whole header appear dead. Worse, the
// link gave no way out: no profile, no password change, no logout.
//
// The header now shows the user's NAME and opens a menu with four
// entries: 个人中心 (account), 档案 (profile details), 更改密码 (change
// password), 注销 (log out).
//
// The menu is a `<details>` element, not a JS-driven dropdown. That is
// a deliberate choice: the page's CSP is `script-src 'self'`, and a
// JS-driven menu would need either an inline handler (blocked) or a
// controller file that has to re-implement focus management, Escape
// handling and outside-click dismissal that `<details>` gives for free.
//
// The three destinations need real pages, not anchors on one long
// profile form, so this file also pins the two new routes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { hashPassword } from "../../src/web/auth/password";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("dash-account-menu");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const u = await createUser(app.pool, {
    email: "menu@x.com",
    passwordHash: await hashPassword("OldPassword1"),
    displayName: "MenuUser",
  });
  sid = generateToken(16);
  await createSession(app.pool, sid, u.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("top-nav account menu", () => {
  it("shows the user's name in the header, not a bare 'console' link", async () => {
    const r = await request(app.server)
      .get("/")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    // The display name is what identifies the account.
    expect(r.text).toContain("MenuUser");
  });

  it("offers all four menu destinations", async () => {
    const r = await request(app.server)
      .get("/")
      .set("Cookie", "sid=" + sid);
    const html = r.text;
    // 个人中心 — the account overview.
    expect(html).toContain('href="/dashboard"');
    // 档案 — profile details.
    expect(html).toContain('href="/dashboard/profile/details"');
    // 更改密码 — change password.
    expect(html).toContain('href="/dashboard/profile/password"');
    // 注销 — log out. It is a POST, so it carries a CSRF token.
    expect(html).toContain('action="/logout"');
    expect(html).toContain('name="csrf"');
  });

  it("does not show the menu to a signed-out visitor", async () => {
    const r = await request(app.server).get("/");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('href="/dashboard/profile/password"');
    // The sign-in link is still there.
    expect(r.text).toContain('href="/login"');
  });
});

describe("profile sub-pages", () => {
  it("GET /dashboard/profile/details renders the display-name and email forms", async () => {
    const r = await request(app.server)
      .get("/dashboard/profile/details")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    // The nickname field.
    expect(r.text).toContain('name="displayName"');
    // The email field.
    expect(r.text).toContain('name="email"');
    // …and NOT the password form — that has its own page now.
    expect(r.text).not.toContain('name="newPassword"');
  });

  it("GET /dashboard/profile/password renders the password form and nothing else", async () => {
    const r = await request(app.server)
      .get("/dashboard/profile/password")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="oldPassword"');
    expect(r.text).toContain('name="newPassword"');
    // The details forms live on the other page.
    expect(r.text).not.toContain('name="displayName"');
  });

  it("GET /dashboard/profile renders the account overview", async () => {
    const r = await request(app.server)
      .get("/dashboard/profile")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    // An overview, not a form: it links to the two sub-pages.
    expect(r.text).toContain('href="/dashboard/profile/details"');
    expect(r.text).toContain('href="/dashboard/profile/password"');
  });

  it("the sub-pages redirect an anonymous visitor to the sign-in page", async () => {
    for (const path of [
      "/dashboard/profile/details",
      "/dashboard/profile/password",
    ]) {
      const r = await request(app.server).get(path);
      expect(r.status).toBe(302);
      expect(r.headers["location"]).toContain("/login");
    }
  });

  it("POST /dashboard/profile/password changes the password", async () => {
    // The CSRF pair comes from the page the form lives on.
    const page = await request(app.server)
      .get("/dashboard/profile/password")
      .set("Cookie", "sid=" + sid);
    const cookies = page.headers["set-cookie"] as string[];
    const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
    const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
    const token = /csrf=([a-f0-9]+)/.exec(csrfLine)![1]!;

    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", `sid=${sid}; ${csrfLine}; ${issuedLine}; ${bindLine}`)
      .type("form")
      .send({
        action: "password",
        oldPassword: "OldPassword1",
        newPassword: "MenuPassword2",
        csrf: token,
      });
    expect(r.status).toBe(200);
    expect(r.text).toContain("资料已保存");
  });

  it("POST /dashboard/profile/details saves the display name", async () => {
    const page = await request(app.server)
      .get("/dashboard/profile/details")
      .set("Cookie", "sid=" + sid);
    const cookies = page.headers["set-cookie"] as string[];
    const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
    const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
    const token = /csrf=([a-f0-9]+)/.exec(csrfLine)![1]!;

    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", `sid=${sid}; ${csrfLine}; ${issuedLine}; ${bindLine}`)
      .type("form")
      .send({ action: "displayName", displayName: "RenamedUser", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("资料已保存");
  });

  it("the response shows the nickname it just saved", async () => {
    // The re-rendered page must show the NEW nickname, not the one the
    // request was authenticated with. `req.user` is the row loaded at
    // the start of the request, so a handler that saves and then
    // renders without refreshing it shows the user their old name —
    // which reads as "the save did not work".
    const page = await request(app.server)
      .get("/dashboard/profile/details")
      .set("Cookie", "sid=" + sid);
    const cookies = page.headers["set-cookie"] as string[];
    const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
    const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
    const token = /csrf=([a-f0-9]+)/.exec(csrfLine)![1]!;

    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", `sid=${sid}; ${csrfLine}; ${issuedLine}; ${bindLine}`)
      .type("form")
      .send({ action: "displayName", displayName: "FreshName", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("FreshName");
    expect(r.text).not.toContain("RenamedUser");
  });

  it("the response shows the email it just saved", async () => {
    const page = await request(app.server)
      .get("/dashboard/profile/details")
      .set("Cookie", "sid=" + sid);
    const cookies = page.headers["set-cookie"] as string[];
    const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
    const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
    const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
    const token = /csrf=([a-f0-9]+)/.exec(csrfLine)![1]!;

    const r = await request(app.server)
      .post("/dashboard/profile")
      .set("Cookie", `sid=${sid}; ${csrfLine}; ${issuedLine}; ${bindLine}`)
      .type("form")
      .send({ action: "email", email: "renamed@x.com", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("renamed@x.com");
    expect(r.text).not.toContain("menu@x.com");
  });
});
