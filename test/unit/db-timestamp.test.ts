// SPDX-License-Identifier: MIT
//
// A DATETIME the database wrote, printed for a human or a spreadsheet.
//
// The driver reads these literals in the SERVER's own clock, so the Date
// it hands back IS that wall clock — not an instant in UTC. Printing it
// through `toISOString()` converts it, which shifts the digits by the
// server's offset from UTC. The export then disagrees with the console,
// which prints the wall clock: the same row, two different times, in two
// places a minute apart.
//
// These tests pin the property that matters — the printed digits are the
// ones the database holds, and the string says which clock they are in.
import { describe, it, expect } from "vitest";
import { formatDbTimestamp } from "../../src/storage/dbTimestamp";

describe("a timestamp the database wrote", () => {
  it("prints the wall clock it holds, not a UTC conversion of it", () => {
    const d = new Date(2026, 0, 15, 3, 4, 5, 67);
    expect(formatDbTimestamp(d).slice(0, 19)).toBe("2026-01-15T03:04:05");
  });

  it("says which clock the digits are in", () => {
    const d = new Date(2026, 0, 15, 3, 4, 5, 67);
    expect(formatDbTimestamp(d)).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it("round-trips: the string names the same instant", () => {
    const d = new Date(2026, 0, 15, 3, 4, 5, 67);
    expect(new Date(formatDbTimestamp(d)).getTime()).toBe(d.getTime());
  });

  it("keeps the millisecond precision the column has", () => {
    const d = new Date(2026, 0, 15, 3, 4, 5, 7);
    expect(formatDbTimestamp(d)).toContain(".007");
  });

  it("renders nothing for a missing value", () => {
    expect(formatDbTimestamp(null)).toBe("");
    expect(formatDbTimestamp(undefined)).toBe("");
  });

  it("renders nothing for a value that is not a date", () => {
    expect(formatDbTimestamp("not a date")).toBe("");
  });

  it("accepts the string form a DATETIME literal arrives in", () => {
    // A row read with `dateStrings: true` arrives as
    // "2026-01-15 03:04:05". That literal has no offset in it, so it
    // names a wall clock — and reading it must not move the digits.
    expect(formatDbTimestamp("2026-01-15 03:04:05").slice(0, 19)).toBe("2026-01-15T03:04:05");
  });

  it("reads a literal that carries an offset as that instant", () => {
    // An explicit offset is unambiguous, so it names a moment — and the
    // printed string has to name the same one.
    const s = "2026-01-15T03:04:05Z";
    expect(new Date(formatDbTimestamp(s)).getTime()).toBe(new Date(s).getTime());
  });
});
