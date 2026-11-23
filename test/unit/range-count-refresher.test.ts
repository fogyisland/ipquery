// SPDX-License-Identifier: MIT
//
// The cached `ip_ranges` row count.
//
// An exact `COUNT(*)` over the 8M-row library takes seconds, and the
// dashboard, the landing page and the console's auto-refresh all read the
// count. So the count is stored and refreshed on a timer instead.
//
// The behaviour worth pinning down is the *policy*: refresh only when the
// stored value has actually gone stale. Refreshing on every tick would
// put the seconds-long count back on the page path — the exact thing the
// cache exists to avoid — and never refreshing would leave the number
// permanently wrong after a bulk write that did not go through the ETL.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";

const mocks = vi.hoisted(() => ({
  readStoredRangeCount: vi.fn(),
  refreshRangeCount: vi.fn(),
}));

vi.mock("../../src/storage/rangeCount", () => ({
  RANGE_COUNT_MAX_AGE_MS: 6 * 60 * 60 * 1000,
  readStoredRangeCount: mocks.readStoredRangeCount,
  refreshRangeCount: mocks.refreshRangeCount,
}));

const { registerRangeCountRefresher } = await import("../../src/web/plugins/rangeCountRefresher");

const HOUR = 60 * 60 * 1000;

function fakeApp(dbDegraded = false) {
  const logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const hooks: Array<() => Promise<void>> = [];
  const app = {
    dbDegraded,
    log: {
      info: (payload: Record<string, unknown>) => logs.push({ level: "info", payload }),
      warn: (payload: Record<string, unknown>) => logs.push({ level: "warn", payload }),
      error: (payload: Record<string, unknown>) => logs.push({ level: "error", payload }),
    },
    addHook: (_name: string, fn: () => Promise<void>) => hooks.push(fn),
  } as unknown as FastifyInstance;
  return { app, logs, hooks };
}

function fakePool(): Pool {
  return { query: () => Promise.resolve([[], []]) } as unknown as Pool;
}

describe("the range count refresher", () => {
  beforeEach(() => {
    mocks.readStoredRangeCount.mockReset();
    mocks.refreshRangeCount.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the stored count without recomputing it when it is fresh", async () => {
    const { app } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue({
      value: 8150000,
      kind: "exact",
      syncedAt: new Date(Date.now() - HOUR),
    });
    mocks.refreshRangeCount.mockResolvedValue({ value: 9000000, kind: "exact", syncedAt: new Date() });

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    await expect(refreshNow()).resolves.toBe(8150000);
    // The expensive path was not taken: an exact count over 8M rows is
    // what the cache is there to avoid.
    expect(mocks.refreshRangeCount).not.toHaveBeenCalled();
  });

  it("recomputes the count when the stored value has gone stale", async () => {
    const { app } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue({
      value: 8150000,
      kind: "exact",
      syncedAt: new Date(Date.now() - 7 * HOUR),
    });
    mocks.refreshRangeCount.mockResolvedValue({ value: 9000000, kind: "exact", syncedAt: new Date() });

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    await expect(refreshNow()).resolves.toBe(9000000);
    expect(mocks.refreshRangeCount).toHaveBeenCalledTimes(1);
  });

  it("computes the count when nothing has ever been stored", async () => {
    const { app } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue(null);
    mocks.refreshRangeCount.mockResolvedValue({ value: 42, kind: "exact", syncedAt: new Date() });

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    await expect(refreshNow()).resolves.toBe(42);
    expect(mocks.refreshRangeCount).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the server has no database", async () => {
    // A setup-only server has no ip_ranges table to count. Touching it
    // would log a failure every interval on an install that is otherwise
    // healthy, which makes a working setup look broken.
    const { app, logs } = fakeApp(true);
    mocks.readStoredRangeCount.mockResolvedValue(null);

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    await expect(refreshNow()).resolves.toBeNull();
    expect(mocks.readStoredRangeCount).not.toHaveBeenCalled();
    expect(mocks.refreshRangeCount).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("survives a storage failure and says so", async () => {
    const { app, logs } = fakeApp();
    mocks.readStoredRangeCount.mockRejectedValue(new Error("connection lost"));

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    // The timer must not turn a transient database blip into an
    // unhandled rejection that takes the server down.
    await expect(refreshNow()).resolves.toBeNull();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("reports no count when the refresh itself fails", async () => {
    const { app } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue(null);
    mocks.refreshRangeCount.mockResolvedValue(null);

    const { refreshNow } = registerRangeCountRefresher(app, fakePool(), { intervalMs: 6 * HOUR });

    await expect(refreshNow()).resolves.toBeNull();
  });

  it("resolves the pool at call time so the wizard can re-point it", async () => {
    // The setup wizard attaches a database to a server that started
    // without one. If the pool were captured at registration, the
    // refresher would keep counting the old (absent) database.
    const { app } = fakeApp();
    const good = fakePool();
    const bad = fakePool();
    mocks.readStoredRangeCount.mockResolvedValue({
      value: 7,
      kind: "exact",
      syncedAt: new Date(),
    });

    let current: Pool = bad;
    const { refreshNow } = registerRangeCountRefresher(app, () => current, { intervalMs: 6 * HOUR });

    await refreshNow();
    expect(mocks.readStoredRangeCount).toHaveBeenLastCalledWith(bad);

    current = good;
    await refreshNow();
    expect(mocks.readStoredRangeCount).toHaveBeenLastCalledWith(good);
  });

  it("refreshes on its timer, not only when asked", async () => {
    vi.useFakeTimers();
    const { app } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue(null);
    mocks.refreshRangeCount.mockResolvedValue({ value: 5, kind: "exact", syncedAt: new Date() });

    registerRangeCountRefresher(app, fakePool(), { intervalMs: 1000 });
    expect(mocks.refreshRangeCount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.refreshRangeCount).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when the server closes", async () => {
    vi.useFakeTimers();
    const { app, hooks } = fakeApp();
    mocks.readStoredRangeCount.mockResolvedValue(null);
    mocks.refreshRangeCount.mockResolvedValue({ value: 5, kind: "exact", syncedAt: new Date() });

    registerRangeCountRefresher(app, fakePool(), { intervalMs: 1000 });

    for (const hook of hooks) await hook();

    await vi.advanceTimersByTimeAsync(5000);
    // A timer that outlives the server keeps a handle on the pool and
    // can fire during shutdown.
    expect(mocks.refreshRangeCount).not.toHaveBeenCalled();
  });
});
