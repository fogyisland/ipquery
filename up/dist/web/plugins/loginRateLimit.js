"use strict";
// SPDX-License-Identifier: MIT
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordLoginFailure = recordLoginFailure;
exports.recordLoginSuccess = recordLoginSuccess;
exports.isLocked = isLocked;
exports._resetForTests = _resetForTests;
const failures = new Map();
function recordLoginFailure(email, maxAttempts, lockoutMinutes) {
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
function recordLoginSuccess(email) {
    failures.delete(email.toLowerCase());
}
function isLocked(email) {
    const entry = failures.get(email.toLowerCase());
    if (!entry)
        return { locked: false, retryAfterSec: 0 };
    const now = Date.now();
    if (entry.lockUntil > now)
        return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000) };
    return { locked: false, retryAfterSec: 0 };
}
function _resetForTests() {
    failures.clear();
}
//# sourceMappingURL=loginRateLimit.js.map