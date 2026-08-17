// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import view from '@fastify/view';
import * as Handlebars from 'handlebars';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export async function registerView(app: FastifyInstance, cfg: { baseUrl: string }): Promise<void> {
  const viewsDir = path.join(__dirname, '..', 'views');

  Handlebars.registerHelper('t', function (this: unknown, key: string, opts: unknown) {
    const hash = (opts as { hash?: Record<string, string | number> } | undefined)?.hash ?? {};
    const locale = (this as { locale?: string })?.locale ?? 'zh-CN';
    const tFn = (globalThis as { __ipqT?: (l: string, k: string, v?: Record<string, string | number>) => string }).__ipqT;
    return tFn ? tFn(locale, key, hash) : key;
  });

  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  Handlebars.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
  Handlebars.registerHelper('not', (v: unknown) => !v);
  Handlebars.registerHelper('and', (a: unknown, b: unknown) => Boolean(a) && Boolean(b));
  Handlebars.registerHelper('or', (a: unknown, b: unknown) => Boolean(a) || Boolean(b));
  Handlebars.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));
  Handlebars.registerHelper('lt', (a: unknown, b: unknown) => Number(a) < Number(b));
  Handlebars.registerHelper('add', (a: unknown, b: unknown) => Number(a) + Number(b));
  Handlebars.registerHelper('subtract', (a: unknown, b: unknown) => Number(a) - Number(b));
  Handlebars.registerHelper('json', (v: unknown) => JSON.stringify(v));
  Handlebars.registerHelper('lookup', (obj: unknown, key: unknown) => {
    if (obj == null || typeof obj !== 'object') return undefined;
    return (obj as Record<string, unknown>)[String(key)];
  });
  Handlebars.registerHelper('sparkline-path', (data: unknown, max: unknown, width: unknown, height: unknown) => {
    const arr = Array.isArray(data) ? data.map(Number) : [];
    const m = Number(max) || 1;
    const w = Number(width) || 80;
    const h = Number(height) || 24;
    if (arr.length === 0) return '';
    if (arr.length === 1) {
      const y = (h - (arr[0]! / m) * h * 0.85 + h * 0.075).toFixed(1);
      return `M 0,${y}`;
    }
    const step = w / (arr.length - 1);
    return arr.map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (h - (v / m) * h * 0.85 + h * 0.075).toFixed(1);
      return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
    }).join(' ');
  });
  Handlebars.registerHelper('formatDate', (d: Date | string | null | undefined) => {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toISOString().replace('T', ' ').slice(0, 19);
  });
  Handlebars.registerHelper('formatRelative', (d: Date | string | null | undefined) => {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(d) : d;
    return formatDistanceToNow(date, { addSuffix: true, locale: zhCN });
  });
  Handlebars.registerHelper('year', () => new Date().getFullYear());
  Handlebars.registerHelper('ternary', (cond: unknown, a: unknown, b: unknown) => (cond ? a : b));
  Handlebars.registerHelper('percent', (n: unknown, digits?: unknown) => {
    const d = digits == null ? 0 : Number(digits);
    return `${(Number(n) * 100).toFixed(d)}%`;
  });
  Handlebars.registerHelper('max', (...args: unknown[]) => {
    // Handlebars may append an options object as the last arg; detect by shape.
    const last = args[args.length - 1];
    const vals = (last && typeof last === 'object' && 'name' in (last as object) && 'fn' in (last as object)
      ? args.slice(0, -1)
      : args) as unknown[];
    return vals.reduce((m: number, v: unknown) => Math.max(m, Number(v)), 0);
  });

  // Register all Handlebars partials globally so layouts (e.g. public.hbs) can
  // include them with `{{> nav }}` / `{{> footer }}` / `{{> flash }}`. The
  // view plugin resolves partials by directory path; registering via the
  // engine makes them available regardless of layout.
  const partialsDir = path.join(viewsDir, 'partials');
  if (fs.existsSync(partialsDir)) {
    for (const name of fs.readdirSync(partialsDir)) {
      if (!name.endsWith('.hbs')) continue;
      const partialName = name.slice(0, -'.hbs'.length);
      const partialPath = path.join(partialsDir, name);
      Handlebars.registerPartial(partialName, fs.readFileSync(partialPath, 'utf-8'));
    }
  }

  // @fastify/view validates the layout file at *registration* time (accessSync on
  // `<root>/layouts/public.hbs`) and throws if it is missing. The layout ships with
  // Task 11, so only opt into it once the file is actually on disk; every template
  // may still declare its own layout via the `layout` render option.
  const defaultLayout = 'layouts/public';
  const hasDefaultLayout = fs.existsSync(path.join(viewsDir, `${defaultLayout}.hbs`));

  await app.register(view, {
    engine: { handlebars: Handlebars },
    root: viewsDir,
    ...(hasDefaultLayout ? { defaultLayout, layout: defaultLayout } : {}),
  });

  app.decorate('viewBaseUrl', cfg.baseUrl);
}

declare module 'fastify' {
  interface FastifyInstance {
    viewBaseUrl: string;
  }
}
