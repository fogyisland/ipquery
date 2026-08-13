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
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
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
