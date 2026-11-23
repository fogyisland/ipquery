import { describe, it, expect, vi } from "vitest";
import { registerUploadSweeper } from "./src/web/plugins/uploadSweeper";

describe("probe", () => {
  it("fires the timer", async () => {
    vi.useFakeTimers();
    const queries: string[] = [];
    const applied = Array.from({ length: 40 }, (_, i) => ({ version: String(i).padStart(3, "0") }));
    const pool = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.includes("schema_migrations")) return Promise.resolve([applied, []] as never);
        return Promise.resolve([[], []] as never);
      },
    } as never;
    const logs: unknown[] = [];
    const app = {
      dbDegraded: false,
      log: {
        info: (p: unknown) => logs.push(["info", p]),
        warn: (p: unknown) => logs.push(["warn", p]),
        error: (p: unknown) => logs.push(["error", p]),
      },
      addHook: () => undefined,
    } as never;
    registerUploadSweeper(app, pool, { intervalMs: 1000 });
    expect(queries.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    console.log("queries after tick:", queries.length);
    console.log("logs:", JSON.stringify(logs).slice(0, 500));
    vi.useRealTimers();
    expect(true).toBe(true);
  });
});
