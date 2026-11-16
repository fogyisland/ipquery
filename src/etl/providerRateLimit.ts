// SPDX-License-Identifier: MIT
//
// Per-provider rate limiting.
//
// Each free geolocation API publishes a ceiling and enforces it by
// returning 429 or by refusing the request outright. The backfill used to
// ignore all of them — `Promise.all` fired every provider at once — so a
// burst of rows spent the provider's whole minute in the first second and
// every later row saw a rate limit that read, in the operator's page, as
// "this provider is broken".
//
// The numbers below are the vendors' published figures, not tuning knobs.
// They sit next to the human-readable quota string in the catalog so the
// figure an operator reads on the page is the figure the code obeys.
//
//   ip-api    45 req/min, HTTP only
//   ipinfo    50,000 req/month — no per-minute figure published, so none
//             is invented here; its own 429 is the signal.
//   ip.sb     100 req/min, and no more than 5 req/s in a burst
//   ip9.com.cn 60 req/min

export interface ProviderRateLimit {
  /** Requests allowed in a rolling minute. */
  perMinute?: number;
  /** Requests allowed in a rolling second. The tighter of this and
   *  perMinute wins, because the vendor enforces both. */
  burstPerSecond?: number;
}

/**
 * The published limits, keyed by the provider name used everywhere else.
 *
 * An empty object means "no published limit" — the provider is not
 * throttled locally, and its own 429 is what disables it.
 */
export const PROVIDER_RATE_LIMITS: Readonly<Record<string, ProviderRateLimit>> = {
  "ip-api": { perMinute: 45 },
  ipinfo: {},
  "ip-sb": { perMinute: 100, burstPerSecond: 5 },
  ip9: { perMinute: 60 },
};

/** The limit for a provider, or an empty one for anything unknown. */
export function providerRateLimit(name: string): ProviderRateLimit {
  return PROVIDER_RATE_LIMITS[name] ?? {};
}

/** The minimum spacing between two calls, in milliseconds. Zero when the
 *  provider publishes no limit. */
function minIntervalMs(limit: ProviderRateLimit): number {
  const gaps: number[] = [];
  if (limit.perMinute && limit.perMinute > 0) gaps.push(60_000 / limit.perMinute);
  if (limit.burstPerSecond && limit.burstPerSecond > 0) gaps.push(1_000 / limit.burstPerSecond);
  return gaps.length === 0 ? 0 : Math.max(...gaps);
}

export interface RateLimiter {
  /** Resolves when the caller may issue its request. Callers queue in
   *  arrival order, so a burst becomes a spaced sequence rather than a
   *  stampede. */
  acquire(): Promise<void>;
  /** How long the next caller would wait, for diagnostics. */
  pendingMs(): number;
}

/**
 * A spacing limiter.
 *
 * Deliberately not a token bucket: the goal is to never exceed the
 * published figure, not to use it up as fast as possible. Spacing calls by
 * `60_000 / perMinute` keeps every rolling window under the ceiling, which
 * is what the vendor actually measures.
 */
export function createRateLimiter(limit: ProviderRateLimit): RateLimiter {
  const gap = minIntervalMs(limit);
  // The timestamp the NEXT call may go at. Chained per acquire so two
  // callers arriving together cannot both read the same slot.
  let nextAt = 0;

  return {
    async acquire(): Promise<void> {
      if (gap === 0) return;
      const now = Date.now();
      const slot = Math.max(now, nextAt);
      nextAt = slot + gap;
      const wait = slot - now;
      if (wait <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    },
    pendingMs(): number {
      if (gap === 0) return 0;
      return Math.max(0, nextAt - Date.now());
    },
  };
}

/** One limiter per provider, created on first use and reused afterwards so
 *  the spacing carries across rows rather than resetting per IP. */
const limiterCache = new Map<string, RateLimiter>();

/** The shared limiter for a provider name. */
export function limiterFor(name: string): RateLimiter {
  let limiter = limiterCache.get(name);
  if (!limiter) {
    limiter = createRateLimiter(providerRateLimit(name));
    limiterCache.set(name, limiter);
  }
  return limiter;
}

/** Test seam: forget every cached limiter. */
export function _resetRateLimiters(): void {
  limiterCache.clear();
}
