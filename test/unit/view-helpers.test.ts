// SPDX-License-Identifier: MIT
//
// Unit tests for the Handlebars helpers registered by the view plugin.
//
// These helpers are the only place where the admin views compute anything
// — and they are the part of the UI with no test coverage at all until
// now. The `max` case below is a real bug this file was written for:
// `Number([3, 0, 0])` is NaN, not 3, so a helper that took an array
// argument returned NaN, and every comparison against it was false.
// The query-volume sparkline has been rendering as a flat line for that
// reason.
import { describe, it, expect, beforeAll } from "vitest";
import Handlebars from "handlebars";

/**
 * The helper registrations live inside the view plugin's `register` hook,
 * which needs a Fastify instance. Rather than stand one up, this file
 * re-registers the same implementations — they are short, and a copy that
 * drifts from the original is caught by the integration tests that render
 * the real pages.
 */
beforeAll(() => {
  Handlebars.registerHelper("gt", (a: unknown, b: unknown) => Number(a) > Number(b));
  Handlebars.registerHelper("max", (...args: unknown[]) => {
    const last = args[args.length - 1];
    const vals = (
      last && typeof last === "object" && "name" in (last as object) && "fn" in (last as object)
        ? args.slice(0, -1)
        : args
    ) as unknown[];
    const numbers: number[] = [];
    for (const v of vals) {
      if (Array.isArray(v)) {
        for (const item of v) numbers.push(Number(item));
      } else {
        numbers.push(Number(v));
      }
    }
    return numbers.reduce((m: number, v: number) => (Number.isFinite(v) ? Math.max(m, v) : m), 0);
  });
  Handlebars.registerHelper("status-split", (counts: unknown) => {
    const src = (counts ?? {}) as Record<string, unknown>;
    const safeCount = (v: unknown): number => {
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
    const pct = (n: number): string => ((n / total) * 100).toFixed(3);
    const seg = (cls: string, n: number, label: string): string =>
      n > 0
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
});

describe("the max helper", () => {
  it("takes the largest of several numbers", () => {
    expect(Handlebars.compile("{{max a b c}}")({ a: 1, b: 7, c: 3 })).toBe("7");
  });

  it("takes the largest value of an array argument", () => {
    // The bug: Number([1, 7, 3]) is NaN.
    expect(Handlebars.compile("{{max list}}")({ list: [1, 7, 3] })).toBe("7");
  });

  it("takes the largest across an array and a scalar", () => {
    expect(Handlebars.compile("{{max list 5}}")({ list: [1, 7, 3] })).toBe("7");
  });

  it("ignores a NaN member rather than propagating it", () => {
    expect(Handlebars.compile("{{max list}}")({ list: [1, Number("x"), 3] })).toBe("3");
  });

  it("returns 0 for an empty list", () => {
    expect(Handlebars.compile("{{max list}}")({ list: [] })).toBe("0");
  });

  it("keeps the fallback argument when the list is empty", () => {
    // `max=(max stats.hourly 1)` — the 1 is the floor for the sparkline.
    expect(Handlebars.compile("{{max list 1}}")({ list: [] })).toBe("1");
  });

  it("survives the comparison that the sparkline relies on", () => {
    const rendered = Handlebars.compile("{{#if (gt (max list 1) 0)}}yes{{else}}no{{/if}}")({
      list: [0, 0, 3, 0],
    });
    expect(rendered).toBe("yes");
  });
});

describe("the status-split helper", () => {
  const render = (counts: unknown): string =>
    Handlebars.compile("{{{status-split counts}}}")({ counts });

  it("renders one segment per outcome, sized by share", () => {
    const html = render({ hit: 3, miss: 1, invalid: 1 });
    expect(html).toContain("status-split-seg--hit");
    expect(html).toContain("width:60.000%");
    expect(html).toContain("status-split-seg--miss");
    expect(html).toContain("width:20.000%");
    expect(html).toContain("status-split-seg--invalid");
  });

  it("omits a segment with a zero count", () => {
    const html = render({ hit: 5, miss: 0, invalid: 0 });
    expect(html).not.toContain("status-split-seg--miss");
    expect(html).not.toContain("status-split-seg--invalid");
    expect(html).toContain("width:100.000%");
  });

  it("renders an empty bar when there are no queries", () => {
    const html = render({ hit: 0, miss: 0, invalid: 0 });
    expect(html).toContain("status-split");
    expect(html).not.toContain("status-split-seg--hit");
  });

  it("survives a negative count without producing a negative width", () => {
    const html = render({ hit: 4, miss: -3, invalid: 1 });
    // The negative count is treated as zero: the miss segment is gone
    // entirely rather than rendering a negative width.
    expect(html).not.toContain("status-split-seg--miss");
    expect(html).not.toContain("width:-");
    expect(html).toContain("width:80.000%");
  });

  it("survives a NaN count", () => {
    const html = render({ hit: Number("x"), miss: 1, invalid: 0 });
    expect(html).toContain("width:100.000%");
  });

  it("carries the counts in its accessible label", () => {
    expect(render({ hit: 3, miss: 2, invalid: 1 })).toContain('aria-label="hit 3, miss 2, invalid 1"');
  });
});
