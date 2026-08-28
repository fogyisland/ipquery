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
  Handlebars.registerHelper('range', function (this: unknown, start: unknown, end: unknown) {
    const s = Number(start);
    const e = Number(end);
    const out: number[] = [];
    for (let i = s; i < e; i++) out.push(i);
    return out;
  });
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

  // Render an inline stacked-bar chart for a DailyBucket[]. Stacks
  // hit (accent) / miss (warning) / invalid (danger). x-axis: dates, oldest
  // left. y-axis: query count. Renders zero-state when all buckets are empty.
  Handlebars.registerHelper('daily-chart', (data: unknown) => {
    const buckets = Array.isArray(data)
      ? data.map((b) => ({
          date: String((b as Record<string, unknown>).date ?? ''),
          hit: Number((b as Record<string, unknown>).hit ?? 0),
          miss: Number((b as Record<string, unknown>).miss ?? 0),
          invalid: Number((b as Record<string, unknown>).invalid ?? 0),
          total: Number((b as Record<string, unknown>).total ?? 0),
        }))
      : [];
    const W = 640;
    const H = 200;
    const padL = 36, padR = 12, padT = 16, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxY = Math.max(1, ...buckets.map((b) => b.total));
    const niceMax = maxY <= 5 ? 5 : Math.ceil(maxY / 5) * 5;
    const n = buckets.length || 1;
    const groupW = innerW / n;
    const barW = Math.min(36, Math.max(10, groupW * 0.55));
    const yFor = (v: number): number => padT + innerH - (v / niceMax) * innerH;

    // Empty-state: a single faint horizontal line where y=0 sits.
    if (buckets.length === 0 || buckets.every((b) => b.total === 0)) {
      return `<svg class="chart-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="7-day query volume">
        <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="currentColor" stroke-opacity="0.2" />
        <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" fill-opacity="0.4" font-size="13">暂无数据</text>
      </svg>`;
    }

    // Y-axis grid (4 horizontal lines + numeric labels).
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = Math.round((niceMax * i) / 4);
      const y = padT + innerH - (v / niceMax) * innerH;
      grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.08" />`;
      grid += `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">${v}</text>`;
    }

    // Bars + x-axis date labels.
    let bars = '';
    buckets.forEach((b, i) => {
      const gx = padL + i * groupW + (groupW - barW) / 2;
      const yHit = yFor(b.hit);
      const yMiss = yFor(b.hit + b.miss);
      const yInv = yFor(b.hit + b.miss + b.invalid);
      const baseY = padT + innerH;
      const hHit = Math.max(0, baseY - yHit);
      const hMiss = Math.max(0, yHit - yMiss);
      const hInv = Math.max(0, yMiss - yInv);
      if (hHit > 0) bars += `<rect class="chart-bar chart-bar--hit" x="${gx.toFixed(1)}" y="${yHit.toFixed(1)}" width="${barW.toFixed(1)}" height="${hHit.toFixed(1)}" />`;
      if (hMiss > 0) bars += `<rect class="chart-bar chart-bar--miss" x="${gx.toFixed(1)}" y="${yMiss.toFixed(1)}" width="${barW.toFixed(1)}" height="${hMiss.toFixed(1)}" />`;
      if (hInv > 0) bars += `<rect class="chart-bar chart-bar--invalid" x="${gx.toFixed(1)}" y="${yInv.toFixed(1)}" width="${barW.toFixed(1)}" height="${hInv.toFixed(1)}" />`;
      // X label: short date MM-DD, or weekday for the most recent 3 days.
      const d = new Date(b.date);
      const label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      bars += `<text class="chart-tick" x="${(gx + barW / 2).toFixed(1)}" y="${(padT + innerH + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.6">${label}</text>`;
    });

    return `<svg class="chart-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="7-day query volume">
      ${grid}
      ${bars}
    </svg>`;
  });

  const partialsDir = path.join(viewsDir, 'partials');
  if (fs.existsSync(partialsDir)) {
    // Recursive walk so marketing/admin/dashboard partials can be namespaced
    // in subfolders and referenced as `{{> marketing/_topnav}}`. Partial
    // name mirrors the relative path with `.hbs` stripped (subdir prefix
    // joined with `/`).
    const walk = (dir: string, prefix: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full, prefix ? `${prefix}/${name}` : name);
        } else if (name.endsWith('.hbs')) {
          const partialName = prefix
            ? `${prefix}/${name.slice(0, -'.hbs'.length)}`
            : name.slice(0, -'.hbs'.length);
          Handlebars.registerPartial(partialName, fs.readFileSync(full, 'utf-8'));
        }
      }
    };
    walk(partialsDir, '');
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
    //
    // Note: `reply.view` already calls `reply.send()` internally
    // (see node_modules/@fastify/view/index.js decorateReply), so the
    // wrapper must NOT call send again — doing so causes FST_ERR_REP_ALREADY_SENT.
    const r = reply as unknown as { view: ReplyView; viewAsync: ReplyView };
    const rawAsync = r.viewAsync.bind(reply);
    r.viewAsync = (page, data, opts) => promoteLayout(page, data, opts, rawAsync);

    const rawView = r.view.bind(reply);
    r.view = (page, data, opts) => promoteLayout(page, data, opts, rawView);
  });

  app.decorate('viewBaseUrl', cfg.baseUrl);
}

declare module 'fastify' {
  interface FastifyInstance {
    viewBaseUrl: string;
  }
}



