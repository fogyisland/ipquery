/** Why a caller could not take the lock. */
export type LockBusyReason = "busy";
export interface LockAttempt {
    /** True when the lock was taken and the caller may proceed. */
    acquired: boolean;
    /** Set when acquired is false. */
    reason?: LockBusyReason;
    /** How long to wait before retrying, in ms. Advisory only — the
     *  caller decides whether to surface this to the user. */
    retryAfterMs?: number;
}
export interface ProviderLock {
    /** Try to take the lock without waiting. Returns immediately. */
    tryAcquire(): LockAttempt;
    /** Release a previously-acquired lock. Safe to call when the lock
     *  isn't held (no-op). */
    release(): void;
    /** True while the lock is held. */
    isLocked(): boolean;
    /** Milliseconds since the lock was taken, or 0 if not held. */
    heldForMs(): number;
}
/** A lock that is never contended — used when the caller opts out. */
declare const UNCONTENDED: ProviderLock;
/** Shared instance used by the production call sites. Tests build their
 *  own instances via createProviderLock(). */
export declare const providerFanoutLock: ProviderLock;
export declare function createProviderLock(): ProviderLock;
export { UNCONTENDED };
