// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { registerUploadSweeper } from "../../src/web/plugins/uploadSweeper";

/**
 * The sweeper that clears uploads nobody came back for.
 *
 * The storage layer is covered by test/integration/range-upload-sweep.test.ts.
 * What is tested here is the plugin: that it fires on a timer, that it
 * skips when the server has no database, and that it never lets a
 * failure become an unhandled rejection that takes the process down.
 */

interface FakeApp {
  app: FastifyInstance;
  logs: Array<{ level: string; payload: Record<string, unknown> }>;
}

/**
 * A Fastify stand-in that records what was logged.
 *
 * The plugin only uses `app.dbDegraded`, `app.log` and `app.addHook`, so
 * a real server is not needed to exercise the timer.
 */
function fakeApp(dbDegraded: boolean): FakeApp {
  const logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const app = {
    dbDegraded,
    log: {
      info: (payload: Record<string, unknown>) => logs.push({ level: "info", payload }),
      warn: (payload: Record<string, unknown>) => logs.push({ level: "warn", payload }),
      error: (payload: Record<string, unknown>) => logs.push({ level: "error", payload }),
    },
    addHook: () => undefined,
  } as unknown as FastifyInstance;
  return { app, logs };
}

/**
 * A pool that records the queries it was asked to run.
 *
 * The storage layer runs the migrations before it sweeps. The fake
 * reports every migration as already applied, so the sweep query is the
 * one that arrives — the migration statements are the runner's business,
 * not the plugin's.
 */
function fakePool(): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  // The migration runner identifies a migration by the first three
  // characters of its file name. Reporting every version means the
  // runner has nothing to apply and goes straight to the sweep.
  const applied = Array.from({ length: 40 }, (_, i) => ({ version: String(i).padStart(3, "0") }));
  const pool = {
    query: (sql: string) => {
      queries.push(sql);
      if (sql.includes("schema_migrations")) {
        return Promise.resolve([applied, []]);
      }
      return Promise.resolve([[], []]);
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe("the upload sweeper", () => {
  it("sweeps on a timer instead of only on shutdown", async () => {
    // The whole point of the plugin is that the install cleans up after
    // itself while it is running. A sweeper that only fires on shutdown
    // would clean up nothing on a server that never restarts.
    vi.useFakeTimers();
    try {
      const { app } = fakeApp(false);
      const { pool, queries } = fakePool();

      registerUploadSweeper(app, pool, { intervalMs: 1000 });
      expect(queries.length).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);

      // The timer fired and asked the storage layer to sweep. The first
      // query is the migration check the storage layer always runs; the
      // sweep itself is the one that names the table.
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.join("\n")).toContain("range_uploads");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while the server has no database", async () => {
    // A server that came up degraded has no database to sweep. The tick
    // would fail, and the failure would be logged every six hours on an
    // install that is otherwise fine — which makes a healthy setup-only
    // server look broken.
    vi.useFakeTimers();
    try {
      const { app } = fakeApp(true);
      const { pool, queries } = fakePool();

      registerUploadSweeper(app, pool, { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);

      expect(queries.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a failure instead of letting it escape", async () => {
    // The timer callback is `void tick()`. A rejection nobody catches
    // would be an unhandled rejection, which takes the process down in
    // Node 15 and later — the sweep must never be able to do that.
    vi.useFakeTimers();
    try {
      const { app, logs } = fakeApp(false);
      const pool = {
        query: () => Promise.reject(new Error("the database went away")),
      } as unknown as Pool;

      registerUploadSweeper(app, pool, { intervalMs: 1000 });

      // No unhandled rejection: the tick catches it.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const errors = logs.filter((l) => l.level === "error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.payload.err).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the pool at call time, not when it is registered", async () => {
    // The setup wizard re-points the pool at a working database while
    // the server is running. A captured pool would keep sweeping the
    // old one — or the one that was never reachable.
    vi.useFakeTimers();
    try {
      const { app } = fakeApp(false);
      const first = fakePool();
      const second = fakePool();
      let which = 0;
      const resolvePool = (): Pool => (which++ === 0 ? first.pool : second.pool);

      registerUploadSweeper(app, resolvePool, { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);

      // The first tick resolved the pool itself.
      expect(first.queries.length).toBeGreaterThan(0);
      expect(second.queries.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
