import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";

describe("probe fs under fake timers", () => {
  it("does fs.promises.readdir settle under fake timers", async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = fs.promises.readdir("./src/storage/migrations").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    console.log("readdir settled after advance:", settled);
    await p;
    console.log("readdir settled after await:", settled);
    vi.useRealTimers();
    expect(true).toBe(true);
  });
});
