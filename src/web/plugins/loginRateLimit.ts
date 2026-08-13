// SPDX-License-Identifier: MIT

interface LockEntry { failures: number; lockUntil: number }

const failures = new Map<string, LockEntry>();

export function recordLoginFailure(email: string, maxAttempts: number, lockoutMinutes: number): { locked: boolean; retryAfterSec: number } {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = failures.get(key) ?? { failures: 0, lockUntil: 0 };
  if (entry.lockUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000) };
  }
  entry.failures += 1;
  if (entry.failures >= maxAttempts) {
    entry.lockUntil = now + lockoutMinutes * 60_000;
    entry.failures = 0;
    failures.set(key, entry);
    return { locked: true, retryAfterSec: lockoutMinutes * 60 };
  }
  failures.set(key, entry);
  return { locked: false, retryAfterSec: 0 };
}

export function recordLoginSuccess(email: string): void {
  failures.delete(email.toLowerCase());
}

export function isLocked(email: string): { locked: boolean; retryAfterSec: number } {
  const entry = failures.get(email.toLowerCase());
  if (!entry) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (entry.lockUntil > now) return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000) };
  return { locked: false, retryAfterSec: 0 };
}

export function _resetForTests(): void { failures.clear(); }
