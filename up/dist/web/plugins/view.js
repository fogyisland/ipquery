"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerView = registerView;
const view_1 = __importDefault(require("@fastify/view"));
const Handlebars = __importStar(require("handlebars"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const date_fns_1 = require("date-fns");
const locale_1 = require("date-fns/locale");
const wrapped = new WeakSet();
function promoteLayout(page, data, opts, raw) {
    const mergedOpts = { ...(opts ?? {}) };
    if (!mergedOpts.layout && data && typeof data.layout === "string") {
        mergedOpts.layout = data.layout;
    }
    const cleanData = data ? { ...data } : {};
    if ("layout" in cleanData)
        delete cleanData.layout;
    return raw(page, cleanData, mergedOpts);
}
/** Inject `path` (request URL pathname, no query string) into template
 *  context. The sidebar partial uses this to know whether it's rendering
 *  inside an admin page or a personal page, so it can collapse the other
 *  section to a CTA. */
function injectPath(reply, data) {
    const url = reply.request.url;
    const qIdx = url.indexOf("?");
    const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
    if (data) {
        data.path = path;
        if (data.req && typeof data.req === "object") {
            data.req.path = path;
        }
    }
}
async function registerView(app, cfg) {
    const viewsDir = path.join(__dirname, "..", "views");
    Handlebars.registerHelper("t", function (key, opts) {
        const hash = opts?.hash ?? {};
        const locale = this?.locale ?? "zh-CN";
        const tFn = globalThis.__ipqT;
        return tFn ? tFn(locale, key, hash) : key;
    });
    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("ne", (a, b) => a !== b);
    Handlebars.registerHelper("startsWith", (str, prefix) => typeof str === "string" && typeof prefix === "string" && str.startsWith(prefix));
    Handlebars.registerHelper("not", (v) => !v);
    Handlebars.registerHelper("and", (a, b) => Boolean(a) && Boolean(b));
    Handlebars.registerHelper("or", (a, b) => Boolean(a) || Boolean(b));
    Handlebars.registerHelper("range", function (start, end) {
        const s = Number(start);
        const e = Number(end);
        const out = [];
        for (let i = s; i < e; i++)
            out.push(i);
        return out;
    });
    Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
    Handlebars.registerHelper("lt", (a, b) => Number(a) < Number(b));
    Handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
    Handlebars.registerHelper("subtract", (a, b) => Number(a) - Number(b));
    Handlebars.registerHelper("json", (v) => JSON.stringify(v));
    Handlebars.registerHelper("lookup", (obj, key) => {
        if (obj == null || typeof obj !== "object")
            return undefined;
        return obj[String(key)];
    });
    // Find one entry of a sortable-column list by its key. The admin views
    // address a column by name ("id", "email") rather than by index, so the
    // order of the list stays a server-side concern.
    Handlebars.registerHelper("lookupColumn", (columns, key) => {
        if (!Array.isArray(columns))
            return undefined;
        const wanted = String(key);
        return columns.find((c) => c?.key === wanted);
    });
    Handlebars.registerHelper("sparkline-path", (data, max, width, height) => {
        const arr = Array.isArray(data) ? data.map(Number) : [];
        const m = Number(max) || 1;
        const w = Number(width) || 80;
        const h = Number(height) || 24;
        if (arr.length === 0)
            return "";
        if (arr.length === 1) {
            const y = (h - (arr[0] / m) * h * 0.85 + h * 0.075).toFixed(1);
            return `M 0,${y}`;
        }
        const step = w / (arr.length - 1);
        return arr
            .map((v, i) => {
            const x = (i * step).toFixed(1);
            const y = `(${(h - (v / m) * h * 0.85 + h * 0.075).toFixed(1)})`;
            return `${i === 0 ? "M" : "L"} ${x},${y.slice(1, -1)}`;
        })
            .join(" ");
    });
    Handlebars.registerHelper("formatDate", (d) => {
        if (!d)
            return "";
        const date = typeof d === "string" ? new Date(d) : d;
        return date.toISOString().replace("T", " ").slice(0, 19);
    });
    Handlebars.registerHelper("formatRelative", (d) => {
        if (!d)
            return "";
        const date = typeof d === "string" ? new Date(d) : d;
        return (0, date_fns_1.formatDistanceToNow)(date, { addSuffix: true, locale: locale_1.zhCN });
    });
    Handlebars.registerHelper("year", () => new Date().getFullYear());
    Handlebars.registerHelper("ternary", (cond, a, b) => (cond ? a : b));
    Handlebars.registerHelper("percent", (n, digits) => {
        const d = digits == null ? 0 : Number(digits);
        return `${(Number(n) * 100).toFixed(d)}%`;
    });
    Handlebars.registerHelper("max", (...args) => {
        const last = args[args.length - 1];
        const vals = (last && typeof last === "object" && "name" in last && "fn" in last
            ? args.slice(0, -1)
            : args);
        // A list argument is spread into the comparison: `Number([3, 0, 0])`
        // is NaN, not 3, so a caller passing an array got NaN back and every
        // comparison against it was false. That is why the query-volume
        // sparkline rendered as a flat line — its `max` was NaN.
        const numbers = [];
        for (const v of vals) {
            if (Array.isArray(v)) {
                for (const item of v)
                    numbers.push(Number(item));
            }
            else {
                numbers.push(Number(v));
            }
        }
        return numbers.reduce((m, v) => (Number.isFinite(v) ? Math.max(m, v) : m), 0);
    });
    Handlebars.registerHelper("array", (...args) => {
        // Handlebars appends its own options object as the last argument when
        // the helper is called with hash arguments. That object is recognisable
        // by `hash` + `data` + `loc` — the old check looked for `fn`, which
        // only a BLOCK helper's options carry, so the options object leaked
        // into the resulting array as an extra element.
        const last = args[args.length - 1];
        const isHandlebarsOptions = (v) => v != null &&
            typeof v === "object" &&
            "hash" in v &&
            "data" in v &&
            "loc" in v;
        const vals = (isHandlebarsOptions(last) ? args.slice(0, -1) : args);
        return vals;
    });
    // Build an object from hash arguments: `(hash name='role' label='Role')`
    // yields `{ name: 'role', label: 'Role' }`.
    //
    // Handlebars hands a helper its hash arguments inside `options.hash`,
    // and the FIRST POSITIONAL argument it passes is that same options
    // object — not the hash the caller wrote. Returning `options` (what
    // this used to do) therefore produced an object whose own `name` key
    // was the helper's own name and whose real arguments were buried
    // under `.hash`. Every `{{name}}` in a filter bar then rendered
    // "hash", and every option list came out empty.
    Handlebars.registerHelper("hash", (options) => {
        const opts = options;
        return opts?.hash ?? {};
    });
    // A proportional bar for the hit / miss / invalid mix of a set of
    // queries. Plain divs with flex-grow — no chart library, no canvas.
    // The three counts are the only input; the widths are proportional to
    // the total, and a zero-count segment collapses to nothing.
    Handlebars.registerHelper("status-split", (counts) => {
        const src = (counts ?? {});
        // The output is raw markup (the view renders it with triple braces),
        // so nothing from the request may reach it. The counts are the only
        // input and they are coerced to finite non-negative integers here —
        // a negative count would otherwise produce a negative width.
        const safeCount = (v) => {
            const n = Number(v ?? 0);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        };
        const hit = safeCount(src.hit);
        const miss = safeCount(src.miss);
        const invalid = safeCount(src.invalid);
        const total = hit + miss + invalid;
        if (total <= 0) {
            return `<div class="status-split" role="img" aria-label="no queries"></div>`;
        }
        const pct = (n) => ((n / total) * 100).toFixed(3);
        const seg = (cls, n, label) => n > 0
            ? `<div class="status-split-seg status-split-seg--${cls}" style="width:${pct(n)}%" title="${label}: ${n}"></div>`
            : "";
        return [
            `<div class="status-split" role="img" aria-label="hit ${hit}, miss ${miss}, invalid ${invalid}">`,
            seg("hit", hit, "hit"),
            seg("miss", miss, "miss"),
            seg("invalid", invalid, "invalid"),
            `</div>`,
        ].join("");
    });
    // Render a stacked-bar chart for a DailyBucket[]. CSS-grid based — matches
    // the NOC console layout (chart-bars / chart-y / chart-bars-track /
    // chart-bar-col / chart-bar--*). Stacks hit (green) / miss (amber) /
    // invalid (red). x-axis: dates, oldest left. y-axis: query count.
    Handlebars.registerHelper("daily-chart", (data) => {
        const buckets = Array.isArray(data)
            ? data.map((b) => ({
                date: String(b.date ?? ""),
                hit: Number(b.hit ?? 0),
                miss: Number(b.miss ?? 0),
                invalid: Number(b.invalid ?? 0),
                total: Number(b.total ?? 0),
            }))
            : [];
        const maxY = Math.max(1, ...buckets.map((b) => b.total));
        const niceMax = maxY <= 5 ? 5 : Math.ceil(maxY / 5) * 5;
        if (buckets.length === 0 || buckets.every((b) => b.total === 0)) {
            return `<div class="chart-bars">
        <div class="chart-y"><span>0</span></div>
        <div><div class="chart-empty">暂无数据 — run a lookup to populate</div></div>
      </div>`;
        }
        // Y-axis ticks: 0 / 25% / 50% / 75% / 100% of niceMax
        const ticks = [
            niceMax,
            Math.round(niceMax * 0.75),
            Math.round(niceMax * 0.5),
            Math.round(niceMax * 0.25),
            0,
        ];
        const yLabels = ticks.map((v) => `<span>${v}</span>`).join("");
        // Each column: stacked divs sized by percentage of niceMax. Empty bars get
        // a 1px min-height so the column outline is visible.
        const cols = buckets
            .map((b) => {
            const pctHit = (b.hit / niceMax) * 100;
            const pctMiss = (b.miss / niceMax) * 100;
            const pctInv = (b.invalid / niceMax) * 100;
            const dt = new Date(b.date);
            const label = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
            const safe = (n) => (n > 0 ? n : 0);
            return `<div class="chart-bar-col" title="${b.date}: hit ${b.hit} / miss ${b.miss} / invalid ${b.invalid}">
        <div class="chart-bar chart-bar--invalid" style="height: ${safe(pctInv).toFixed(2)}%; min-height: ${b.invalid > 0 ? "2px" : "0"};"></div>
        <div class="chart-bar chart-bar--miss" style="height: ${safe(pctMiss).toFixed(2)}%; min-height: ${b.miss > 0 ? "2px" : "0"};"></div>
        <div class="chart-bar chart-bar--hit" style="height: ${safe(pctHit).toFixed(2)}%; min-height: ${b.hit > 0 ? "2px" : "0"};"></div>
        <div class="chart-bar-total">${b.total || ""}</div>
      </div>
      <span></span>`; // spacer for axis below
        })
            .join("");
        const axisLabels = buckets
            .map((b) => {
            const dt = new Date(b.date);
            return `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
        })
            .map((l) => `<span>${l}</span>`)
            .join("");
        return `<div class="chart-bars" role="img" aria-label="7-day query volume">
      <div class="chart-y">${yLabels}</div>
      <div>
        <div class="chart-bars-track">${cols}</div>
        <div class="chart-bar-axis">${axisLabels}</div>
      </div>
    </div>`;
    });
    const partialsDir = path.join(viewsDir, "partials");
    if (fs.existsSync(partialsDir)) {
        // Recursive walk so marketing/admin/dashboard partials can be namespaced
        // in subfolders and referenced as `{{> marketing/_topnav}}`. Partial
        // name mirrors the relative path with `.hbs` stripped (subdir prefix
        // joined with `/`).
        const walk = (dir, prefix) => {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full, prefix ? `${prefix}/${name}` : name);
                }
                else if (name.endsWith(".hbs")) {
                    const partialName = prefix
                        ? `${prefix}/${name.slice(0, -".hbs".length)}`
                        : name.slice(0, -".hbs".length);
                    Handlebars.registerPartial(partialName, fs.readFileSync(full, "utf-8"));
                }
            }
        };
        walk(partialsDir, "");
    }
    // We deliberately do NOT pass `opts.layout` here. @fastify/view's handlebars
    // render path only honors per-render layouts when no global layout is set --
    // once a global layout is registered, `viewHandlebars` short-circuits and
    // ignores any per-render override. The wrapper below promotes `data.layout`
    // into `opts.layout` so routes that pass `{ layout: 'layouts/X' }` inside
    // `data` actually switch away from any default. (`defaultLayout` is not a
    // recognized @fastify/view option; only `opts.layout` is.)
    await app.register(view_1.default, {
        engine: { handlebars: Handlebars },
        root: viewsDir,
    });
    // We can't re-decorate `reply.view` (Fastify forbids duplicates), so we
    // shim by wrapping the underlying `viewAsync` impl. Capture it on the
    // first request, then replace with a wrapper that promotes `data.layout`
    // into the third-arg position (which `viewHandlebars` actually honors).
    // Tracking wrapped replies in a module-scoped WeakSet instead of mutating
    // an instance property keeps the reply object untouched.
    app.addHook("onRequest", async (_req, reply) => {
        if (wrapped.has(reply))
            return;
        wrapped.add(reply);
        // Fastify's `reply.view`/`reply.viewAsync` are heavily overloaded by
        // @fastify/view; the type system won't accept our widened signatures
        // without a cast at the assignment boundary. The wrappers themselves
        // stay strictly typed via `ReplyView`.
        //
        // Note: `reply.view` already calls `reply.send()` internally
        // (see node_modules/@fastify/view/index.js decorateReply), so the
        // wrapper must NOT call send again — doing so causes FST_ERR_REP_ALREADY_SENT.
        const r = reply;
        const rawAsync = r.viewAsync.bind(reply);
        r.viewAsync = (page, data, opts) => {
            injectPath(reply, data);
            return promoteLayout(page, data, opts, rawAsync);
        };
        const rawView = r.view.bind(reply);
        r.view = (page, data, opts) => {
            injectPath(reply, data);
            return promoteLayout(page, data, opts, rawView);
        };
    });
    app.decorate("viewBaseUrl", cfg.baseUrl);
}
//# sourceMappingURL=view.js.map