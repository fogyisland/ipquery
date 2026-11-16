// SPDX-License-Identifier: MIT
// Each provider's published rate limit is enforced, not just documented.
//
// The free tiers differ by an order of magnitude and the backfill used to
// ignore all of them: `Promise.all` fired every provider at once and the
// `rate_limit_per_min` column was never read. A burst guard is what keeps
// ip.sb's 5 req/s ceiling and ip9's 60 req/min ceiling from turning into
// a 429 that reads as "this provider is broken".
//
// The limits live in the catalog beside the human-readable strings, so the
// number an operator sees on the page is the number the code obeys.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PROVIDER_RATE_LIMITS,
  createRateLimiter,
  providerRateLimit,
} from "../../src/etl/providerRateLimit";

afterEach(() => {
  vi.useRealTimers();
});

describe("the published limits", () => {
  it("carries the vendor figures", () => {
    // ip.sb: 100 req/min with a 5 req/s burst ceiling.
    expect(PROVIDER_RATE_LIMITS["ip-sb"]).toEqual({ perMinute: 100, burstPerSecond: 5 });
    // ip9.com.cn: 60 req/min, no published burst figure.
    expect(PROVIDER_RATE_LIMITS.ip9).toEqual({ perMinute: 60 });
    // ip-api: 45 req/min.
    expect(PROVIDER_RATE_LIMITS["ip-api"]).toEqual({ perMinute: 45 });
    // ipinfo: 50,000 req/month — no per-minute figure, so none is invented.
    expect(PROVIDER_RATE_LIMITS.ipinfo).toEqual({});
  });

  it("falls back to an unlimited window for an unknown provider", () => {
    expect(providerRateLimit("something-custom")).toEqual({});
  });
});

describe("createRateLimiter", () => {
  it("spaces calls to stay under the per-minute ceiling", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const limiter = createRateLimiter({ perMinute: 60 }); // one per second
    const run = async (n: number) => {
      await limiter.acquire();
      calls.push(Date.now());
    };

    // Three acquires at t=0: the first is immediate, the rest must wait.
    const p1 = run(1);
    const p2 = run(2);
    const p3 = run(3);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);

    await Promise.all([p1, p2, p3]);
  });

  it("does not wait at all when the provider publishes no limit", async () => {
    const limiter = createRateLimiter({});
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("serialises callers rather than letting them stampede", async () => {
    vi.useFakeTimers();
    let concurrent = 0;
    let maxConcurrent = 0;
    const limiter = createRateLimiter({ perMinute: 60 });

    const task = async () => {
      await limiter.acquire();
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
    };

    const all = [task(), task(), task(), task()];
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(all);
    // The limiter gates entry, so at most one caller is inside per slot.
    expect(maxConcurrent).toBe(1);
  });
});
