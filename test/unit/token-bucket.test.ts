// SPDX-License-Identifier: MIT
//
// The per-provider token bucket.
//
// External IP-geo APIs have hard free-tier caps — 45 requests a minute for
// ip-api, a few thousand a day for the others. One runaway backfill can
// lock the account out for a day, and the failure is invisible until the
// API starts answering 429.
//
// The bucket is the only thing standing between the backfill loop and that
// lockout, so its arithmetic is worth pinning down: a bucket that refills
// too fast is the bug this file exists to catch, and a bucket that refills
// too slowly just makes the backfill take forever.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenBucket, getBucket, resetBuckets } from "../../src/storage/rateLimit";

describe("TokenBucket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a capacity of zero or less", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerMin: 60 })).toThrow(/capacity/i);
    expect(() => new TokenBucket({ capacity: -1, refillPerMin: 60 })).toThrow(/capacity/i);
  });

  it("rejects a refill rate of zero or less", () => {
    expect(() => new TokenBucket({ capacity: 1, refillPerMin: 0 })).toThrow(/refillPerMin/i);
    expect(() => new TokenBucket({ capacity: 1, refillPerMin: -5 })).toThrow(/refillPerMin/i);
  });

  it("starts full", () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerMin: 60 });
    expect(bucket.available()).toBe(5);
  });

  it("hands out a burst of tokens without waiting", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket({ capacity: 3, refillPerMin: 60 });
    await expect(bucket.acquire()).resolves.toBe(0);
    await expect(bucket.acquire()).resolves.toBe(0);
    await expect(bucket.acquire()).resolves.toBe(0);
    expect(bucket.available()).toBe(0);
  });

  it("blocks once the burst is spent and refills over time", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket({ capacity: 1, refillPerMin: 60 });
    await bucket.acquire();
    expect(bucket.available()).toBe(0);

    // One token at 60/minute is one second away.
    let settled = false;
    const pending = bucket.acquire().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    // Not a millisecond early: a bucket that hands out a token before it
    // is refilled is how the API's rate limit gets exceeded.
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
    expect(bucket.available()).toBe(0);
  });

  it("refills proportionally to the elapsed time", async () => {
    vi.useFakeTimers();
    // 6 a minute is one token every ten seconds, so the refill stays
    // well below the bucket's capacity and the arithmetic is visible.
    const bucket = new TokenBucket({ capacity: 10, refillPerMin: 6 });

    // The bucket starts full, so a refill can only be observed after
    // some of the burst has been spent.
    for (let i = 0; i < 5; i++) await bucket.acquire();
    expect(bucket.available()).toBe(5);

    // 30 seconds at 6/minute is three tokens.
    vi.advanceTimersByTime(30_000);
    expect(bucket.available()).toBeCloseTo(8, 5);
  });

  it("never refills past the capacity", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket({ capacity: 4, refillPerMin: 600 });
    await bucket.acquire();
    expect(bucket.available()).toBe(3);

    // A minute at 600/minute is 600 tokens — far more than the bucket
    // holds. It must saturate, not grow.
    vi.advanceTimersByTime(60_000);
    expect(bucket.available()).toBe(4);
  });

  it("does not refill while time has not moved", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket({ capacity: 4, refillPerMin: 60 });
    await bucket.acquire();
    expect(bucket.available()).toBe(3);
    expect(bucket.available()).toBe(3);
  });
});

describe("getBucket", () => {
  beforeEach(() => {
    resetBuckets();
  });

  it("returns the same instance for the same name", () => {
    const a = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    const b = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    expect(a).toBe(b);
  });

  it("keeps a separate bucket per name", () => {
    const a = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    const b = getBucket("ipinfo", { capacity: 5, refillPerMin: 45 });
    expect(a).not.toBe(b);
  });

  it("accumulates state across calls, so the cap is shared", async () => {
    // This is the point of the multiton: two backfills against the same
    // provider share one budget. If each call built a fresh bucket, both
    // would burst to `capacity` and together exceed the API's cap.
    const first = getBucket("ip-api", { capacity: 2, refillPerMin: 1 });
    await first.acquire();
    await first.acquire();

    const second = getBucket("ip-api", { capacity: 2, refillPerMin: 1 });
    expect(second.available()).toBeLessThan(0.01);
  });

  it("ignores the config of a later call for an existing bucket", () => {
    const first = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    const second = getBucket("ip-api", { capacity: 99, refillPerMin: 999 });
    expect(second).toBe(first);
    expect(second.available()).toBe(5);
  });

  it("drops every cached bucket on reset", () => {
    const first = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    resetBuckets();
    const second = getBucket("ip-api", { capacity: 5, refillPerMin: 45 });
    expect(second).not.toBe(first);
  });
});
