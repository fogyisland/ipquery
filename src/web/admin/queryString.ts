// src/web/admin/queryString.ts
// SPDX-License-Identifier: MIT
export interface ListQueryFields {
  filters: readonly string[];
  sort: readonly string[];
}

export interface ParsedListQuery {
  filters: Record<string, string>;
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  page: number;
  limit: number;
  ids: number[];
}

const MAX_LIMIT = 200;

export function parseListQuery(rawQs: string, fields: ListQueryFields): ParsedListQuery {
  const params = new URLSearchParams(rawQs);
  const filters: Record<string, string> = {};
  for (const f of fields.filters) {
    const v = params.get(f);
    if (v != null && v !== '') filters[f] = v;
  }

  let sort: ParsedListQuery['sort'] = null;
  const s = params.get('sort');
  if (s) {
    const desc = s.startsWith('-');
    const col = desc ? s.slice(1) : s;
    if (fields.sort.includes(col)) sort = { col, dir: desc ? 'desc' : 'asc' };
  }

  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || 25));

  const idsParam = params.get('ids');
  const ids = idsParam
    ? idsParam.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  return { filters, sort, page, limit, ids };
}

export function appendQueryString(existing: string, key: string, value: string): string {
  const sep = existing ? '&' : '';
  return `${existing}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
