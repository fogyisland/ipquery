// SPDX-License-Identifier: MIT
//
// Per-provider token bucket. External IP-geo APIs have free tiers with hard
// per-minute / per-day caps; one runaway batch can lock us out for 24h. Each
// provider gets its own bucket with capacity = burst headroom and refill =
// the published free-tier rate. acquire() blocks the caller until a token is
// available, so the backfill loop runs at a safe steady-state pace without
// us reaching for `p-queue`.
//
// `capacity` is the burst size (e.g. 5 = OK to send 5 at once if bucket is
// full, then 1 every `60/refillPerMin` seconds). `refillPerMin` is the
// sustained rate the API allows (45 for ip-api, 50k/mo for ipinfo, 1k/day
// for iplocate — though we'd set the bucket to the *minute* granularity).
//
// All buckets live in-process. Restart loses state, so the first burst after
// a restart will hit the full `capacity`. For long-running daemons that's
// fine; for one-shot CLI runs that may want stricter pacing, lower
// `capacity` to 1.

export interface RateLimiterConfig {
  capacity: number;
  refillPerMin: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(cfg: RateLimiterConfig) {
    if (cfg.capacity <= 0) throw new Error("capacity must be > 0");
    if (cfg.refillPerMin <= 0) throw new Error("refillPerMin must be > 0");
    this.capacity = cfg.capacity;
    this.refillPerMs = cfg.refillPerMin / 60_000;
    this.tokens = cfg.capacity;
    this.lastRefillAt = Date.now();
  }

  /** Block until a token is available, then consume one. Returns the wait
   *  time in ms — handy for logging and for tests. */
  async acquire(): Promise<number> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return 0;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
      await sleep(waitMs);
    }
  }

  /** Inspect without consuming. Returns tokens available (fractional). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const refilled = elapsed * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillAt = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Multiton: callers ask for a named bucket and we hand back the same
 *  instance every time, so the per-provider counter accumulates across
 *  every backfill call (and across multiple IPs in one batch). */
const buckets = new Map<string, TokenBucket>();

export function getBucket(name: string, cfg: RateLimiterConfig): TokenBucket {
  const existing = buckets.get(name);
  if (existing) return existing;
  const created = new TokenBucket(cfg);
  buckets.set(name, created);
  return created;
}

/** Test hook — drop every cached bucket. Not exposed in production paths. */
export function resetBuckets(): void {
  buckets.clear();
}
