// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { ADMIN_NAV_GROUPS } from "../../src/web/admin/nav";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUid: number;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("sidebar");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "Admin",
    role: "admin",
  });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("public vs authed chrome", () => {
  // Marketing redesign: public pages (home / about / try / docs / status)
  // now render inside layouts/marketing — top nav + footer, NO sidebar.
  // The sidebar lives only on authed pages (admin / dashboard), where the
  // user needs quick navigation to all their screens.
  it("public / uses marketing chrome (no sidebar, has top nav + footer)", async () => {
    const r = await request(app.server).get("/");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/class="m-topnav"/);
    expect(r.text).toMatch(/class="m-footer"/);
    expect(r.text).toMatch(/\/try/);
  });

  it("public /about uses marketing chrome (no sidebar)", async () => {
    const r = await request(app.server).get("/about");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/class="m-topnav"/);
  });

  it("admin sidebar links appear once authenticated", async () => {
    const r = await request(app.server)
      .get("/admin/users")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="sidebar"/);
    expect(r.text).toMatch(/\/admin\/queries/);
    expect(r.text).toMatch(/\/admin\/audit-log/);
    expect(r.text).toContain("admin@x.com");
  });

  it("groups navigation by task and shows a resolved breadcrumb", async () => {
    const r = await request(app.server)
      .get("/admin/users/1")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // The four groups come from src/web/admin/nav.ts, not from a hand-written
    // list in the template.
    expect(r.text).toContain("监控与流量");
    expect(r.text).toContain("数据管道");
    expect(r.text).toContain("访问与身份");
    expect(r.text).toContain("系统与治理");
    // /admin/audit (per-query log) is in 监控与流量, /admin/audit-log
    // (admin actions) is in 系统与治理. Both must still be reachable.
    expect(r.text).toMatch(/href="\/admin\/audit"/);
    expect(r.text).toMatch(/href="\/admin\/audit-log"/);
    expect(r.text).toMatch(/admin-topbar-current[^>]*>用户/);
    // A detail page keeps its section lit and does not light the dashboard.
    expect(r.text).toMatch(/href="\/admin\/users"[^>]*class="sidebar-link active"/);
    expect(r.text).not.toMatch(/href="\/admin"[^>]*class="sidebar-link active"/);
  });

  it("translates the navigation when the reader picks English", async () => {
    // The nav labels resolve through `req.t`, which closes over the locale
    // the i18n plugin derived from the `lang` cookie. Resolving them from
    // the view context instead would silently pin the console to Chinese.
    const r = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('lang="en-US"');
    expect(r.text).toContain("Data Pipeline");
    expect(r.text).toContain("System &amp; Governance");
    expect(r.text).toMatch(/admin-topbar-current[^>]*>Users/);
    // The Chinese strings must not survive into the English render.
    expect(r.text).not.toContain("监控与流量");
    expect(r.text).not.toContain("数据管道");
  });

  it("writes relative timestamps in the reader's language", async () => {
    // `formatRelative` used to pin every timestamp to Chinese, so an
    // English operator read "大约 9 小时前" in a panel that was otherwise
    // in English. It now takes the request and follows its locale.
    const zh = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=zh-CN`);
    expect(zh.status).toBe(200);
    // date-fns words a fresh row as "不到 1 分钟前" and an older one as
    // "大约 8 小时内"; either one proves the Chinese locale is in play.
    expect(zh.text).toMatch(/(不到\s*1\s*分钟前|大约\s*\d+\s*(分钟|小时|天)(前|内))/);

    const en = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(en.status).toBe(200);
    // date-fns phrases a row created a moment ago as "in about 8 hours".
    expect(en.text).toMatch(/in about\s*\d+\s*(minute|hour|day)s?/);
    expect(en.text).not.toMatch(/不到|大约/);
  });

  it("keeps every navigation entry reachable and in its own group", async () => {
    // The nav model is the single source of truth for the sidebar and the
    // breadcrumb. This walks it: every entry must resolve to a live route,
    // and the group the breadcrumb names must be the group the entry sits
    // in. A renamed href or a moved route breaks one of the two.
    for (const group of ADMIN_NAV_GROUPS) {
      for (const item of group.items) {
        const r = await request(app.server)
          .get(item.href)
          .set("Cookie", "sid=" + adminSid);
        expect(r.status, `${item.href} must be reachable`).toBe(200);

        const groupLabel = group.labelKey === "nav.admin.groups.monitor"
          ? "监控与流量"
          : group.labelKey === "nav.admin.groups.data"
            ? "数据管道"
            : group.labelKey === "nav.admin.groups.access"
              ? "访问与身份"
              : "系统与治理";
        // The breadcrumb prints the group the entry belongs to.
        expect(
          r.text,
          `${item.href} must land in ${group.key}`,
        ).toMatch(
          new RegExp(
            `admin-topbar-group[^>]*>${groupLabel}<[^>]*>[\\s\\S]{0,200}admin-topbar-current`,
          ),
        );
      }
    }
  });

  it("does not let one section swallow a sibling path", async () => {
    // /admin/audit reads the per-query log and belongs with the query
    // pages; /admin/audit-log records admin actions and belongs with
    // governance. They share a prefix, so the first must match exactly —
    // otherwise the operator loses the audit log entirely.
    const audit = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(audit.status).toBe(200);
    expect(audit.text).toMatch(/admin-topbar-group[^>]*>监控与流量</);

    const auditLog = await request(app.server)
      .get("/admin/audit-log")
      .set("Cookie", "sid=" + adminSid);
    expect(auditLog.status).toBe(200);
    expect(auditLog.text).toMatch(/admin-topbar-group[^>]*>系统与治理</);
  });
});
