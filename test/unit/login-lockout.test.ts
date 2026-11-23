// SPDX-License-Identifier: MIT
//
// The login brute-force lockout.
//
// The login form counts failures per email address and locks the account
// after a configured number of attempts. Two properties matter and neither
// is visible in the UI:
//
//   · the counter must be per-account, not global — a lockout that
//     punished one attacker for every user's typo would be a denial of
//     service, not a defence;
//   · the lock must expire — otherwise a handful of typos locks a real
//     user out of their own account until the process restarts.
//
// The state lives in a module-level map, so every test here has to reset
// it; that is what `_resetForTests` exists for.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordLoginFailure,
  recordLoginSuccess,
  isLocked,
  _resetForTests,
} from "../../src/web/plugins/loginRateLimit";

const MAX_ATTEMPTS = 3;
const LOCKOUT_MINUTES = 15;

describe("the login lockout", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetForTests();
  });

  it("does not lock an account below the attempt threshold", () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
      expect(r.locked).toBe(false);
      expect(r.retryAfterSec).toBe(0);
    }
    expect(isLocked("a@x.com").locked).toBe(false);
  });

  it("locks the account on the threshold attempt", () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(true);
    expect(r.retryAfterSec).toBe(LOCKOUT_MINUTES * 60);
  });

  it("reports the lock through isLocked", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    const lock = isLocked("a@x.com");
    expect(lock.locked).toBe(true);
    expect(lock.retryAfterSec).toBe(LOCKOUT_MINUTES * 60);
  });

  it("counts the remaining time down", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    vi.advanceTimersByTime(60_000);
    const lock = isLocked("a@x.com");
    expect(lock.locked).toBe(true);
    expect(lock.retryAfterSec).toBe(LOCKOUT_MINUTES * 60 - 60);
  });

  it("keeps reporting locked for further attempts during the lock", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    vi.advanceTimersByTime(120_000);
    const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(true);
    expect(r.retryAfterSec).toBe(LOCKOUT_MINUTES * 60 - 120);
  });

  it("releases the lock when it expires", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    vi.advanceTimersByTime(LOCKOUT_MINUTES * 60_000 + 1);
    expect(isLocked("a@x.com").locked).toBe(false);
  });

  it("starts a fresh count after the lock expires", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    vi.advanceTimersByTime(LOCKOUT_MINUTES * 60_000 + 1);
    // The counter was zeroed when the lock was taken, so the first
    // attempt after the lock is not immediately a new lockout.
    const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(false);
  });

  it("clears the counter after a successful sign-in", () => {
    recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    recordLoginSuccess("a@x.com");
    const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(false);
  });

  it("clears the counter for a mixed-case address too", () => {
    // The counter is keyed by the lowercased address, so clearing it has
    // to use the same key. If it does not, a sign-in that succeeded
    // leaves the old failure count behind — and the account is one typo
    // away from a lockout it never earned.
    recordLoginFailure("A@X.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    recordLoginFailure("A@X.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    recordLoginSuccess("A@X.com");
    const r = recordLoginFailure("A@X.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(false);
  });

  it("counts each account separately", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    }
    // Somebody else's typos must not lock a different account out.
    expect(isLocked("b@x.com").locked).toBe(false);
    const r = recordLoginFailure("b@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(false);
  });

  it("treats the email case-insensitively", () => {
    // The login route lowercases the address before it calls in, but the
    // counter must not depend on that: "A@X.com" and "a@x.com" are one
    // account, and a lockout that can be bypassed by changing case is
    // no lockout at all.
    recordLoginFailure("A@X.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    const r = recordLoginFailure("a@x.com", MAX_ATTEMPTS, LOCKOUT_MINUTES);
    expect(r.locked).toBe(true);
  });

  it("reports an unknown account as not locked", () => {
    expect(isLocked("nobody@x.com")).toEqual({ locked: false, retryAfterSec: 0 });
  });
});
