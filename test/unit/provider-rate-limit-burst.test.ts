// SPDX-License-Identifier: MIT
// The burst ceiling, measured on the real clock.
//
// Kept apart from provider-rate-limit.test.ts because that file runs every
// case under fake timers, and a real-clock assertion inside it measures
// whatever the fake clock left behind.
import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../../src/etl/providerRateLimit";

describe("the per-second burst ceiling", () => {
  it("spaces callers by the tighter of the two published figures", async () => {
    // 600/min alone would allow ten per second, but the burst figure is
    // two — the vendor enforces both, so the tighter one wins. Spacing by
    // 500ms keeps every rolling second at two callers or fewer; it does
    // not admit two at once and then pause.
    const limiter = createRateLimiter({ perMinute: 600, burstPerSecond: 2 });
    const stamps: number[] = [];
    const all = Array.from({ length: 3 }, () =>
      limiter.acquire().then(() => stamps.push(Date.now())),
    );

    // A spacing limiter admits ONE caller per slot, so nothing has fired
    // sooner than the first slot boundary.
    await new Promise((r) => setTimeout(r, 50));
    expect(stamps).toHaveLength(1);

    await Promise.all(all);
    expect(stamps).toHaveLength(3);
    // Every caller is at least one 500ms slot behind the previous one.
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(450);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(450);
  });
});
