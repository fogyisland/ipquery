// SPDX-License-Identifier: MIT
//
// The console prints absolute timestamps in the clock the DATABASE keeps
// them in — the server's own wall clock, which is what the pool reads
// (`timezone: "local"`).
//
// That is the right thing to show an operator who works on the same host
// as the database. But a bare "2026-01-15 03:04:05" says nothing about
// WHICH clock it is: an operator reading the console from another zone,
// or reading a screenshot in a bug report, has no way to place it. The
// CSV export already answers this by writing the offset out; the console
// does not.
//
// This file renders the REAL helper — the same one the views call — and
// pins the zone marker in place.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import Handlebars from "handlebars";
import { registerView } from "../../src/web/plugins/view";

beforeAll(async () => {
  // The helpers live inside the view plugin's `register` hook, so the only
  // way to exercise the REAL implementations is to run the plugin. A copy
  // in the test file would drift from the original.
  const app = Fastify();
  await registerView(app, { baseUrl: "http://localhost" });
  await app.ready();
  await app.close();
});

/** The offset of the clock a date is written in, as "±HH:MM". */
function offsetLabel(date: Date): string {
  // getTimezoneOffset() is the number of minutes to ADD to local time to
  // reach UTC, so the offset FROM UTC is its negation.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

const template = Handlebars.compile(`{{formatDate ts}}`);

describe("the formatDate helper", () => {
  it("names the clock the timestamp is in", () => {
    // A wall-clock instant, read the way the driver hands one over: the
    // local components ARE the clock the database wrote.
    const ts = new Date(2026, 0, 15, 3, 4, 5);
    expect(template({ ts })).toBe(`2026-01-15 03:04:05 ${offsetLabel(ts)}`);
  });

  it("keeps the wall clock the database wrote", () => {
    // The digits must not move: the console shows the clock the row was
    // stamped in, and the offset says which one that is.
    const ts = new Date(2026, 6, 4, 23, 59, 58);
    const rendered = template({ ts });
    expect(rendered).toMatch(/^2026-07-04 23:59:58 [+-]\d{2}:\d{2}$/);
  });

  it("reads a string the same way it reads a Date", () => {
    const ts = new Date(2026, 0, 15, 3, 4, 5);
    expect(template({ ts: ts.toISOString() })).toBe(template({ ts }));
  });

  it("returns an empty string for a missing timestamp", () => {
    expect(template({ ts: null })).toBe("");
    expect(template({ ts: undefined })).toBe("");
    expect(template({ ts: "not a date" })).toBe("");
  });
});
