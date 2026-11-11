"use strict";
// SPDX-License-Identifier: MIT
//
// Provider-fan-out mutex.
//
// Every path that calls the external IP-geo providers fans out over the
// same free-tier quotas (ip-api: 45 req/min; ipinfo: 50k/mo; iplocate:
// 1k/day). Three independent entry points can fire at once:
//
//   1. POST /admin/ingest/backfill/preview  (dry-run)
//   2. POST /admin/ingest/backfill/confirm  (real write)
//   3. the continuous random-IP runner        (every 60s)
//
// Each has its own re-entrancy guard, but none of them knows about the
// others — so an admin clicking "confirm" while a random-IP tick is in
// flight doubles the provider call rate, and two admins confirming at
// once double it again. On a 1k/day quota that is the difference between
// a healthy install and a 24-hour lockout.
//
// This module is a single named mutex shared by all three callers. The
// lock is held for the duration of one fan-out run and released in a
// finally block, so a throwing run never wedges the lock.
//
// Scope note: the lock is in-process. A multi-instance deployment (one
// container per core, behind a load balancer) gets one lock per
// process, so the guarantee degrades to "per instance" there. A
// MySQL-backed advisory lock (GET_LOCK) would be the cross-instance
// answer; that is a deliberate follow-up rather than something to bolt
// on here, because it would put a DB round-trip on the hot path of
// every provider call.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNCONTENDED = exports.providerFanoutLock = void 0;
exports.createProviderLock = createProviderLock;
/** A lock that is never contended — used when the caller opts out. */
const UNCONTENDED = {
    tryAcquire: () => ({ acquired: true }),
    release: () => { },
    isLocked: () => false,
    heldForMs: () => 0,
};
exports.UNCONTENDED = UNCONTENDED;
/** Shared instance used by the production call sites. Tests build their
 *  own instances via createProviderLock(). */
exports.providerFanoutLock = createProviderLock();
function createProviderLock() {
    let heldSince = 0;
    return {
        tryAcquire() {
            if (heldSince !== 0) {
                return { acquired: false, reason: "busy", retryAfterMs: 0 };
            }
            heldSince = Date.now();
            return { acquired: true };
        },
        release() {
            heldSince = 0;
        },
        isLocked() {
            return heldSince !== 0;
        },
        heldForMs() {
            return heldSince === 0 ? 0 : Date.now() - heldSince;
        },
    };
}
//# sourceMappingURL=providerLock.js.map