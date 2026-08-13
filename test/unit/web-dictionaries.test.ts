// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import zhCN from '../../src/web/i18n/zh-CN.json';

describe('zh-CN dictionary', () => {
  it('has no empty string values', () => {
    const flatten = (obj: Record<string, unknown>, prefix = ''): [string, unknown][] => {
      const out: [string, unknown][] = [];
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') out.push(...flatten(v as Record<string, unknown>, key));
        else out.push([key, v]);
      }
      return out;
    };
    for (const [k, v] of flatten(zhCN as Record<string, unknown>)) {
      expect(typeof v, `${k} must be string`).toBe('string');
      expect((v as string).length, `${k} must not be empty`).toBeGreaterThan(0);
    }
  });

  it('required keys present', () => {
    const required = [
      'common.signup', 'common.login', 'common.logout',
      'auth.email', 'auth.password', 'auth.signup.submit',
      'lookup.found', 'lookup.notfound',
    ];
    const flatten = (obj: Record<string, unknown>, prefix = ''): [string, unknown][] => {
      const out: [string, unknown][] = [];
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') out.push(...flatten(v as Record<string, unknown>, key));
        else out.push([key, v]);
      }
      return out;
    };
    const keys = new Set(flatten(zhCN as Record<string, unknown>).map(([k]) => k));
    for (const r of required) expect(keys.has(r), `${r} missing`).toBe(true);
  });
});