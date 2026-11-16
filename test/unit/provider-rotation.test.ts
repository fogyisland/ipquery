// SPDX-License-Identifier: MIT
// Random generation asks ONE provider per IP, taking turns.
//
// The queue-driven backfill wants several opinions per address — that is
// what the vote is for. Random generation is different: the address exists
// to widen coverage, and one confident answer already writes a row. Asking
// every provider about every random IP spends the whole fan-out's quota for
// the same number of rows, and it is exactly the burst that trips a free
// tier.
//
// The rotation is a shuffled cycle rather than a per-IP Math.random(): a
// random pick can starve a provider for a long stretch, while a cycle
// guarantees each source is used equally often.
import { describe, it, expect } from "vitest";
import { createRotation, nextProvider } from "../../src/etl/providerRotation";
import type { IpGeoProvider } from "../../src/etl/providers/types";

/** A provider that only needs a name for these tests. */
function fake(name: string): IpGeoProvider {
  return {
    name,
    lookup: async () => ({ record: null, rateLimited: false }),
  };
}

/** Deterministic "shuffle" that keeps the input order. */
const identity = <T,>(items: T[]): T[] => [...items];

/** Deterministic reverse. */
const reverse = <T,>(items: T[]): T[] => [...items].reverse();

describe("provider rotation", () => {
  it("uses every provider once per cycle", () => {
    const providers = [fake("a"), fake("b"), fake("c")];
    let state = createRotation(providers);
    const chosen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const step = nextProvider(state, providers, identity);
      chosen.push(step.provider!.name);
      state = step.state;
    }
    expect(chosen).toEqual(["a", "b", "c"]);
  });

  it("refills the cycle and keeps going", () => {
    const providers = [fake("a"), fake("b")];
    let state = createRotation(providers);
    const chosen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const step = nextProvider(state, providers, identity);
      chosen.push(step.provider!.name);
      state = step.state;
    }
    // Three full cycles, so each provider is used exactly three times.
    expect(chosen).toEqual(["a", "b", "a", "b", "a", "b"]);
    expect(chosen.filter((n) => n === "a")).toHaveLength(3);
  });

  it("spreads the load evenly across a non-multiple number of picks", () => {
    const providers = [fake("a"), fake("b"), fake("c")];
    let state = createRotation(providers);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 20; i++) {
      const step = nextProvider(state, providers, identity);
      counts[step.provider!.name] += 1;
      state = step.state;
    }
    // 20 picks over 3 providers: no provider may be skipped, and the spread
    // stays within one cycle.
    for (const name of ["a", "b", "c"]) {
      expect(counts[name], name).toBeGreaterThan(0);
    }
    const values = Object.values(counts);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("starts each cycle in a different order", () => {
    // The first provider is whatever the shuffle put first; the point is
    // that the cycle boundary is reshuffled rather than repeating.
    const providers = [fake("a"), fake("b"), fake("c")];
    const state = createRotation(providers);
    const run = (shuffle: typeof identity) => {
      const out: string[] = [];
      let s = state;
      for (let i = 0; i < 3; i++) {
        const step = nextProvider(s, providers, shuffle);
        out.push(step.provider!.name);
        s = step.state;
      }
      return out;
    };
    expect(run(reverse)).toEqual(["c", "b", "a"]);
  });

  it("drops a provider that disappeared mid-run", () => {
    // A 429 disables a provider; the rest of the cycle must not hand it out
    // again just because it was queued before the disable.
    const providers = [fake("a"), fake("b"), fake("c")];
    let state = createRotation(providers);
    const first = nextProvider(state, providers, identity);
    expect(first.provider!.name).toBe("a");
    state = first.state;

    // `b` is gone now.
    const survivors = [fake("a"), fake("c")];
    const second = nextProvider(state, survivors, identity);
    expect(second.provider!.name).toBe("c");
  });

  it("returns null when there is nothing to choose from", () => {
    const step = nextProvider(createRotation([]), []);
    expect(step.provider).toBeNull();
  });
});
