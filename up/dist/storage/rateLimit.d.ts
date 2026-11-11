export interface RateLimiterConfig {
    capacity: number;
    refillPerMin: number;
}
export declare class TokenBucket {
    private readonly capacity;
    private readonly refillPerMs;
    private tokens;
    private lastRefillAt;
    constructor(cfg: RateLimiterConfig);
    /** Block until a token is available, then consume one. Returns the wait
     *  time in ms — handy for logging and for tests. */
    acquire(): Promise<number>;
    /** Inspect without consuming. Returns tokens available (fractional). */
    available(): number;
    private refill;
}
export declare function getBucket(name: string, cfg: RateLimiterConfig): TokenBucket;
/** Test hook — drop every cached bucket. Not exposed in production paths. */
export declare function resetBuckets(): void;
