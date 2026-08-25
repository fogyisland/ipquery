// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply } from 'fastify';
import view from '@fastify/view';
import * as Handlebars from 'handlebars';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

type ReplyView = (page: string, data?: Record<string, unknown>, opts?: { layout?: string }) => Promise<unknown>;

const wrapped = new WeakSet<FastifyReply>();

function promoteLayout(
  page: string,
  data: Record<string, unknown> | undefined,
  opts: { layout?: string } | undefined,
  raw: ReplyView,
): Promise<unknown> {
  const mergedOpts: { layout?: string } = { ...(opts ?? {}) };
  if (!mergedOpts.layout && data && typeof data.layout === 'string') {
    mergedOpts.layout = data.layout;
  }
  const cleanData: Record<string, unknown> = data ? { ...data } : {};
  if ('layout' in cleanData) delete cleanData.layout;
  return raw(page, cleanData, mergedOpts);
}

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
      const y = `(${(h - (v / m) * h * 0.85 + h * 0.075).toFixed(1)})`;
      return `${i === 0 ? 'M' : 'L'} ${x},${y.slice(1, -1)}`;
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
    const last = args[args.length - 1];
    const vals = (last && typeof last === 'object' && 'name' in (last as object) && 'fn' in (last as object)
      ? args.slice(0, -1)
      : args) as unknown[];
    return vals.reduce((m: number, v: unknown) => Math.max(m, Number(v)), 0);
  });
  Handlebars.registerHelper('array', (...args: unknown[]) => {
    const last = args[args.length - 1];
    const vals = (last && typeof last === 'object' && 'name' in (last as object) && 'fn' in (last as object)
      ? args.slice(0, -1)
      : args) as unknown[];
    return vals;
  });
  Handlebars.registerHelper('hash', (obj: unknown) => obj);

  const partialsDir = path.join(viewsDir, 'partials');
  if (fs.existsSync(partialsDir)) {
    for (const name of fs.readdirSync(partialsDir)) {
      if (!name.endsWith('.hbs')) continue;
      const partialName = name.slice(0, -'.hbs'.length);
      const partialPath = path.join(partialsDir, name);
      Handlebars.registerPartial(partialName, fs.readFileSync(partialPath, 'utf-8'));
    }
  }

  // We deliberately do NOT pass `opts.layout` here. @fastify/view's handlebars
  // render path only honors per-render layouts when no global layout is set --
  // once a global layout is registered, `viewHandlebars` short-circuits and
  // ignores any per-render override. The wrapper below promotes `data.layout`
  // into `opts.layout` so routes that pass `{ layout: 'layouts/X' }` inside
  // `data` actually switch away from any default. (`defaultLayout` is not a
  // recognized @fastify/view option; only `opts.layout` is.)
  await app.register(view, {
    engine: { handlebars: Handlebars },
    root: viewsDir,
  });

  // We can't re-decorate `reply.view` (Fastify forbids duplicates), so we
  // shim by wrapping the underlying `viewAsync` impl. Capture it on the
  // first request, then replace with a wrapper that promotes `data.layout`
  // into the third-arg position (which `viewHandlebars` actually honors).
  // Tracking wrapped replies in a module-scoped WeakSet instead of mutating
  // an instance property keeps the reply object untouched.

  app.addHook('onRequest', async (_req, reply) => {
    if (wrapped.has(reply)) return;
    wrapped.add(reply);

    // Fastify's `reply.view`/`reply.viewAsync` are heavily overloaded by
    // @fastify/view; the type system won't accept our widened signatures
    // without a cast at the assignment boundary. The wrappers themselves
    // stay strictly typed via `ReplyView`.
    const r = reply as unknown as { view: ReplyView; viewAsync: ReplyView };
    const rawAsync = r.viewAsync.bind(reply);
    r.viewAsync = (page, data, opts) => promoteLayout(page, data, opts, rawAsync);

    const rawView = r.view.bind(reply);
    r.view = async (page, data, opts) => {
      try {
        const html = await promoteLayout(page, data, opts, rawView);
        reply.send(html as string);
      } catch (err) {
        reply.send(err as Error);
      }
      return reply;
    };
  });

  app.decorate('viewBaseUrl', cfg.baseUrl);
}

declare module 'fastify' {
  interface FastifyInstance {
    viewBaseUrl: string;
  }
}


