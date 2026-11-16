// SPDX-License-Identifier: MIT
// The insert progress bar must reach 100% by the time the run is done.
//
// It used to stop around 97%. Two things were wrong and they compounded:
//
//   1. The numerator counted rows INSERTED while the denominator counted
//      rows that would be ATTEMPTED. The three DB-IP files overlap on
//      (start_ip, end_ip), so the upsert merges a few hundred thousand of
//      them into rows the earlier file already wrote — the numerator could
//      never catch the denominator.
//
//   2. The swap stage never moved the counter. Even a run whose arithmetic
//      did balance would sit at its last insert percentage while the table
//      was swapped and the run finished.
import { describe, it, expect, vi } from "vitest";
import { EtlProgressSink } from "../../src/etl/pipeline";

/** A pool stub that records the UPDATE the sink issues. */
function stubPool(): {
  pool: { query: ReturnType<typeof vi.fn> };
  lastUpdate: () => Record<string, unknown> | null;
} {
  let captured: Record<string, unknown> | null = null;
  const pool = {
    query: vi.fn(async (_sql: string, params?: unknown[]) => {
      if (params && params.length >= 5) {
        captured = { insertRowsDone: params[3], insertRowsTotal: params[4] };
      }
      return [{ affectedRows: 1 }, []];
    }),
  };
  return { pool, lastUpdate: () => captured };
}

describe("EtlProgressSink insert progress", () => {
  it("counts rows attempted, not rows inserted", async () => {
    // 100 rows parsed, 100 attempted, but 30 of them merged into an
    // existing range. The bar must still read 100/100.
    const { pool } = stubPool();
    const sink = new EtlProgressSink(pool as never, 1, { intervalMs: 0 });
    sink.onParseTotal(100);
    sink.onInsert(100);
    await sink.flush();

    const state = sink.getState();
    expect(state.insertRowsDone).toBe(100);
    expect(state.insertRowsTotal).toBe(100);
  });

  it("jumps to the total when the run reaches the swap", async () => {
    const { pool } = stubPool();
    const sink = new EtlProgressSink(pool as never, 1, { intervalMs: 0 });
    sink.onParseTotal(1000);
    sink.onInsert(970); // still mid-insert
    expect(sink.getState().insertRowsDone).toBe(970);

    sink.setStage("swap");
    const state = sink.getState();
    expect(state.insertRowsDone).toBe(state.insertRowsTotal);
    expect(state.insertRowsDone).toBe(1000);
  });

  it("does not move the counter when the total is unknown", async () => {
    // No parse totals were reported (an older run, or a source that
    // cannot be counted). Jumping to "null" would be a lie; leave the
    // running count alone.
    const { pool } = stubPool();
    const sink = new EtlProgressSink(pool as never, 1, { intervalMs: 0 });
    sink.onInsert(42);
    sink.setStage("swap");
    expect(sink.getState().insertRowsDone).toBe(42);
  });
});
