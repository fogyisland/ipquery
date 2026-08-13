// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, generateCsrf, verifyCsrf } from '../../src/web/auth/tokens';

describe('tokens', () => {
  it('generateToken default length 52', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Z2-7]{52}$/);
  });

  it('generateToken bytes=16 → 26 chars', () => {
    const t = generateToken(16);
    expect(t).toMatch(/^[A-Z2-7]{26}$/);
  });

  it('generateToken is unique', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
  });

  it('hashToken is deterministic SHA-256 hex 64', () => {
    const a = hashToken('hello');
    const b = hashToken('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashToken differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('generateCsrf returns 64 hex chars', () => {
    const c = generateCsrf();
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyCsrf matches with recent timestamp', () => {
    const t = generateCsrf();
    expect(verifyCsrf(t, t, Date.now(), 60_000)).toBe(true);
  });

  it('verifyCsrf rejects mismatch', () => {
    const t = generateCsrf();
    expect(verifyCsrf(t, 'different', Date.now(), 60_000)).toBe(false);
  });

  it('verifyCsrf rejects expired', () => {
    const t = generateCsrf();
    const issuedAt = Date.now() - 120_000;
    expect(verifyCsrf(t, t, issuedAt, 60_000)).toBe(false);
  });
});