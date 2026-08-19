// src/web/admin/csv.ts
// SPDX-License-Identifier: MIT
export type CsvColumn<T> = { header: string; get: (row: T) => string | number | null | undefined };

export function csvForRows<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const escape = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = columns.map((c) => escape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => escape(c.get(r))).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

export function withBom(s: string): string {
  return '﻿' + s;
}
