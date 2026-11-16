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
export declare const PROVIDER_RATE_LIMITS: Readonly<Record<string, ProviderRateLimit>>;
/** The limit for a provider, or an empty one for anything unknown. */
export declare function providerRateLimit(name: string): ProviderRateLimit;
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
export declare function createRateLimiter(limit: ProviderRateLimit): RateLimiter;
/** The shared limiter for a provider name. */
export declare function limiterFor(name: string): RateLimiter;
/** Test seam: forget every cached limiter. */
export declare function _resetRateLimiters(): void;
