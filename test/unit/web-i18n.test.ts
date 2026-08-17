// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { t } from '../../src/web/i18n';

describe('web i18n t()', () => {
  it('returns Chinese value for known key', () => {
    // assume zh-CN.json has key "common.signup" with value "注册"
    expect(t('zh-CN', 'common.signup')).toBe('注册');
  });

  it('returns English value when both locales have the key', () => {
    expect(t('en-US', 'common.signup')).toBe('Sign up');
  });

  it('falls back to Chinese when locale missing the key', () => {
    // 'dashboard.keys.copy' is intentionally absent from en-US.json so the
    // fallback branch in t() is exercised by this test.
    expect(t('en-US', 'dashboard.keys.copy')).toBe('复制');
  });

  it('returns key itself when key missing everywhere', () => {
    expect(t('zh-CN', 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('interpolates {var} placeholders', () => {
    // zh-CN.json: "greeting.hello": "你好,{name}"
    expect(t('zh-CN', 'greeting.hello', { name: '张三' })).toBe('你好,张三');
  });

  it('interpolates multiple variables', () => {
    // zh-CN.json: "lookup.found": "{ip} 位于 {country}"
    expect(t('zh-CN', 'lookup.found', { ip: '8.8.8.8', country: '美国' })).toBe('8.8.8.8 位于 美国');
  });
});
