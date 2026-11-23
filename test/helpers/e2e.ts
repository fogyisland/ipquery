// SPDX-License-Identifier: MIT
//
// Shared setup for the browser-level tests.
//
// Every e2e file used to carry its own copy of the same sixty lines:
// create a database, run the migrations, mark it initialised, build the
// server, listen on an ephemeral port, launch chromium. Four copies of
// that block meant four places to fix a mistake, and they had already
// drifted — some dropped the database before creating it (which queues
// behind a leftover lock), some did not mark the database initialised
// (so the setup wizard intercepted every request).
//
// This helper does the setup once, and does it the way the rest of the
// suite does: through `createTestDb`, which creates a UNIQUELY named
// database rather than dropping a fixed one first. That matters —
// `DROP DATABASE` needs an exclusive metadata lock, and a leftover
// lock from a timed-out run would park the cleanup for the server's
// year-long default, before a single assertion ran.
//
// The browser is real. That is the whole point of this directory: the
// unit and integration suites call handlers directly or use Fastify's
// `inject()`, so they never execute a line of the page's JavaScript.
// A dropdown that never opens, a tab that never switches, a chart that
// never draws — all of them pass those suites and fail in a browser.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServer } from "../../src/api/server";
import { loadConfig, type AppConfig } from "../../src/config";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { hashPassword } from "../../src/web/auth/password";
import { createTestDb, dropTestDb, type TestDb } from "./db";

export interface E2eUser {
  id: number;
  email: string;
  sid: string;
}

/**
 * A running server, a browser, and the database behind them.
 *
 * `baseUrl` is the ephemeral port the server bound to, so two e2e files
 * can run without fighting over 3880.
 */
export interface E2eContext {
  app: Awaited<ReturnType<typeof buildServer>>;
  browser: Browser;
  baseUrl: string;
  db: TestDb;
  cfg: AppConfig;
}

/**
 * Bring up a server and a browser against a fresh database.
 *
 * `suffix` names the database; it must be unique per file because the
 * helper creates a uniquely-named database underneath it anyway.
 *
 * The database this returns is a throwaway: `createTestDb` names it
 * `ipquery_test_*` and gives it a name no other run has used. Every
 * row these tests write — users, sessions, query logs, IP ranges — lands
 * there and is dropped on the way out. Nothing the developer's own
 * database holds is read or written, and the assertion below is what
 * guarantees that rather than merely intending it.
 */
export async function startE2e(suffix: string): Promise<E2eContext> {
  const cfg = loadConfig();
  const db = await createTestDb(`e2e_${suffix}`);

  // buildServer reads cfg.db.database, so the app talks to the test
  // database rather than to the developer's own.
  cfg.db.database = db.dbName;

  // Belt and braces: if the database name ever stops carrying the
  // test prefix, every write this suite makes would land in the
  // developer's real data. Refuse to start instead.
  if (!db.dbName.startsWith("ipquery_test_")) {
    await dropTestDb(db).catch(() => undefined);
    throw new Error(
      `refusing to run the e2e suite against ${db.dbName}: only ipquery_test_* databases may be used`,
    );
  }

  const app = await buildServer(cfg);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch();

  return { app, browser, baseUrl, db, cfg };
}

/** Tear down what `startE2e` built, in the reverse order. */
export async function stopE2e(ctx: E2eContext | null): Promise<void> {
  if (!ctx) return;
  // The browser first: a live page holds a connection to the server,
  // and the server's pool holds connections to the database. Closing in
  // this order means the DROP is the last thing standing, so it has
  // nothing left to wait for.
  if (ctx.browser) {
    await ctx.browser.close().catch(() => undefined);
  }
  if (ctx.app) {
    await ctx.app.close().catch(() => undefined);
  }
  await dropTestDb(ctx.db);
}

/**
 * Create a user and a session for them, and return the session id.
 *
 * The session id is a credential, so it travels as a return value
 * rather than through stdout — it never lands in scrollback or in a CI
 * log.
 */
export async function createE2eUser(
  ctx: E2eContext,
  email: string,
  opts?: { role?: "admin" | "user"; password?: string; displayName?: string; verified?: boolean },
): Promise<E2eUser> {
  const password = opts?.password ?? "E2ePass1234";
  const user = await createUser(ctx.app.pool, {
    email,
    passwordHash: await hashPassword(password),
    displayName: opts?.displayName ?? "E2e User",
    role: opts?.role ?? "user",
  });
  if (opts?.verified !== false) {
    await ctx.app.pool.query("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
  }
  const sid = generateToken(16);
  await createSession(ctx.app.pool, sid, user.id, new Date(Date.now() + 3600_000));
  return { id: user.id, email, sid };
}

/**
 * Open a page with the session cookie already set, run the callback,
 * then close the context.
 *
 * A fresh browser context per call means a clean cookie jar: a test that
 * signs in as someone else does not inherit the previous session, and a
 * test that logs out cannot leak that state into the next one.
 */
export async function withPage<T>(
  ctx: E2eContext,
  sid: string | undefined,
  fn: (_page: Page) => Promise<T>,
): Promise<T> {
  const context: BrowserContext = await ctx.browser.newContext();
  try {
    if (sid) {
      await context.addCookies([{ name: "sid", value: sid, domain: "127.0.0.1", path: "/" }]);
    }
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * Insert a query-log row for a user.
 *
 * The dashboard's hero only shows a "last query" block when the user
 * HAS a row, so a browser test of that block needs one.
 */
export async function seedQueryLog(
  ctx: E2eContext,
  userId: number,
  ipText: string,
  status: "hit" | "miss" | "invalid" = "hit",
): Promise<void> {
  const { insertQueryLogs } = await import("../../src/storage/queryLog");
  const { parseIp } = await import("../../src/ip");
  const ip = parseIp(ipText);
  if (!ip) throw new Error(`not an IP: ${ipText}`);
  await insertQueryLogs(ctx.app.pool, [
    {
      ip,
      ipText,
      status,
      userId,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: null,
    },
  ]);
}
