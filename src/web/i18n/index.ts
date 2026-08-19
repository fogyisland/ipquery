// SPDX-License-Identifier: MIT
import zhCN from './zh-CN.json';
import enUS from './en-US.json';

export type Locale = 'zh-CN' | 'en-US';
export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en-US'];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

const dictionaries: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN as Record<string, unknown>,
  'en-US': enUS as Record<string, unknown>,
};

function lookup(dict: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    const obj = cur as Record<string, unknown>;
    const p = parts[i] as string;
    const direct = obj[p];
    if (typeof direct === 'string') {
      // String leaf: resolve directly if it's the final segment. If intermediate
      // (e.g. `admin.users.delete` is a string but key continues to `.confirm.title`),
      // fall through to the literal-dotted-key fallback below.
      if (i === parts.length - 1) return direct;
    } else if (direct && typeof direct === 'object') {
      cur = direct;
      continue;
    }
    // Direct segment didn't yield an object. Try literal-dotted-key fallback in
    // the current object — handles JSON files that intermix flat string leaves
    // with nested dotted keys (e.g. both `delete: "..."` and `delete.confirm.title: "..."`).
    const remaining = parts.slice(i).join('.');
    if (typeof obj[remaining] === 'string') return obj[remaining];
    return undefined;
  }
  if (typeof cur === 'string') return cur;
  return undefined;
}

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = lookup(dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE], key)
    ?? lookup(dictionaries[DEFAULT_LOCALE], key)
    ?? key;
  if (typeof raw !== 'string') return key;
  if (!vars) return raw;
  let s = raw;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function parseLocale(raw: string | undefined): Locale {
  if (raw === 'en-US') return 'en-US';
  return DEFAULT_LOCALE;
}
