// SPDX-License-Identifier: MIT
//
// Per-requester cooldown for the verification-resend endpoint.
//
// POST /verify/resend/:userId sends a real email to a real user. The
// cooldown used to be keyed on the TARGET user id, which stopped
// repeated sends to the same user but did nothing about enumeration: a
// script walking userId 1..N would send one email to every registered
// user, and the per-target cooldown would never fire because each id
// was touched once.
//
// Keying on the REQUESTER's IP closes that: one caller gets one
// verification email per cooldown window, whatever id they name.
//
// State is in-process and bounded. The alternative — a row in the
// `settings` table per caller IP — grows without limit under
// enumeration (each attacker IP leaves a permanent row), and the
// table's key column is a VARCHAR(64), which an IPv6 address plus a
// prefix would eventually overflow.
//
// The in-process limitation is the same one the login-failure lock and
// the provider token buckets already have: on a multi-instance
// deployment each instance enforces its own cooldown. That is a
// deliberate trade — the route-level rate limit above it is the
// outer bound, and a shared store (Redis) is the eventual answer.

interface CooldownEntry {
  /** When the cooldown expires (epoch ms). */
  until: number;
  /** When this entry was created (epoch ms) — used for eviction. */
  seenAt: number;
}

const cooldowns = new Map<string, CooldownEntry>();

/**
 * Maximum number of tracked requesters. Each entry is a short string
 * (an IP) plus two numbers, so 10k entries is well under a megabyte.
 * At the route's 10/hour limit, 10k distinct requesters would take
 * months of sustained abuse to fill.
 */
const MAX_ENTRIES = 10_000;

/**
 * How often to sweep expired entries, in ms. A sweep is O(n) over the
 * map; at 10k entries that is trivial, and running it at most once a
 * minute keeps the cost off the request path.
 */
const SWEEP_INTERVAL_MS = 60_000;

let lastSweepAt = 0;

/** Drop entries whose cooldown has expired. */
function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, entry] of cooldowns) {
    if (entry.until <= now) cooldowns.delete(key);
  }
  // If the map is still over the cap (every entry still live), evict
  // the oldest ones. The cap exists to bound memory; evicting the
  // oldest weakens the cooldown for the busiest callers, which is
  // exactly the right trade-off.
  if (cooldowns.size > MAX_ENTRIES) {
    const sorted = [...cooldowns.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) {
      cooldowns.delete(sorted[i]![0]);
    }
  }
}

/**
 * True when the requester is still inside the cooldown window.
 *
 * `requesterId` identifies the caller — an IP address.
 */
export function isResendOnCooldown(requesterId: string, cooldownMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const entry = cooldowns.get(requesterId);
  if (!entry) return false;
  if (entry.until <= now) {
    cooldowns.delete(requesterId);
    return false;
  }
  return true;
}

/**
 * Start the cooldown for a requester.
 */
export function startResendCooldown(requesterId: string, cooldownMs: number): void {
  const now = Date.now();
  sweep(now);
  cooldowns.set(requesterId, { until: now + cooldownMs, seenAt: now });
}

/**
 * Clear all state. Test-only.
 */
export function _resetForTests(): void {
  cooldowns.clear();
  lastSweepAt = 0;
}
