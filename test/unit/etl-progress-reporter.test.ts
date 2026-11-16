// SPDX-License-Identifier: MIT
// The ETL's long stages report progress on a clock, not on a row count.
//
// A run over eight million rows takes twenty minutes. Until now the CLI
// printed one line when the stage STARTED and one when it finished, so an
// operator had no way to tell a slow run from a hung one — and the only
// live signal was a progress column in the database that the CLI never
// read.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgressReporter } from "../../src/etl/progressReporter";

afterEach(() => {
  vi.useRealTimers();
});

/** Collect the lines a reporter writes. */
function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("createProgressReporter", () => {
  it("stays quiet until the interval elapses", () => {
    vi.useFakeTimers();
    const out = collector();
    const reporter = createProgressReporter({
      label: "city",
      unit: "rows",
      total: 1000,
      intervalMs: 10_000,
      write: out.write,
    });

    reporter.tick(100);
    reporter.tick(100);
    expect(out.lines).toHaveLength(0);

    vi.advanceTimersByTime(10_001);
    reporter.tick(100);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("300");
    expect(out.lines[0]).toContain("1,000");
    expect(out.lines[0]).toContain("30.0%");
  });

  it("reports the rate and a projected finish", () => {
    vi.useFakeTimers();
    const out = collector();
    const reporter = createProgressReporter({
      label: "city",
      unit: "rows",
      total: 10_000,
      intervalMs: 1_000,
      write: out.write,
    });

    reporter.tick(1_000); // t=0, under the interval
    vi.advanceTimersByTime(1_000);
    reporter.tick(1_000); // t=1s, 2000 done in 1s → 2000 rows/s
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/2,000 rows\/s/);
    // 8000 left at 2000/s is four seconds.
    expect(out.lines[0]).toContain("eta 4s");
  });

  it("omits the percentage and ETA when the total is unknown", () => {
    vi.useFakeTimers();
    const out = collector();
    const reporter = createProgressReporter({
      label: "sapics-user",
      unit: "rows",
      intervalMs: 1_000,
      write: out.write,
    });

    reporter.tick(500);
    vi.advanceTimersByTime(1_001);
    reporter.tick(500);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).not.toContain("%");
    expect(out.lines[0]).not.toContain("eta");
    expect(out.lines[0]).toContain("1,000 rows");
  });

  it("finish() always prints, even inside the interval", () => {
    vi.useFakeTimers();
    const out = collector();
    const reporter = createProgressReporter({
      label: "city",
      unit: "rows",
      total: 100,
      intervalMs: 60_000,
      write: out.write,
    });

    reporter.tick(100);
    expect(out.lines).toHaveLength(0);
    reporter.finish();
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("100/100");
    expect(out.lines[0]).toContain("done");
  });

  it("formats a long elapsed time in minutes", () => {
    vi.useFakeTimers();
    const out = collector();
    const reporter = createProgressReporter({
      label: "city",
      unit: "rows",
      intervalMs: 1_000,
      write: out.write,
    });

    vi.advanceTimersByTime(125_000);
    reporter.tick(1);
    expect(out.lines[0]).toContain("elapsed 2m05s");
  });
});
