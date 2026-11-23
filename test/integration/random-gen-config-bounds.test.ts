// SPDX-License-Identifier: MIT
//
// The scheduler form and the runner have to agree on what a valid config is.
//
// They did not. `saveRandomGenConfig` accepted a batch of up to 100 while
// `loadRandomGenConfig` only honoured 20, so an operator who typed 50 saw 50
// in the form and the runner used 20 — the page was reporting a setting the
// process did not have. Separately, the interval picker offered 30/60/300/
// 900/1800 seconds while the shipped default is 180: nothing matched, so the
// browser submitted the first option and a plain "save" silently rewrote the
// schedule. Both cases are covered here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  clampBatchSize,
  clampIntervalSec,
  loadRandomGenConfig,
  saveRandomGenConfig,
  RANDOM_GEN_INTERVAL_PRESETS,
  RANDOM_GEN_BATCH_MAX,
  RANDOM_GEN_INTERVAL_MIN_SEC,
  RANDOM_GEN_INTERVAL_MAX_SEC,
} from "../../src/storage/randomProbeLog";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("randgenclamp");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("random-gen config bounds", () => {
  it("clamps the interval into the range the runner honours", () => {
    expect(clampIntervalSec(5)).toBe(RANDOM_GEN_INTERVAL_MIN_SEC);
    expect(clampIntervalSec(99999)).toBe(RANDOM_GEN_INTERVAL_MAX_SEC);
    expect(clampIntervalSec(180)).toBe(180);
    // A garbage value falls back to the documented default rather than
    // writing NaN into the settings table.
    expect(clampIntervalSec(Number.NaN)).toBe(180);
  });

  it("clamps the batch into the range the runner honours", () => {
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(1000)).toBe(RANDOM_GEN_BATCH_MAX);
    expect(clampBatchSize(Number.NaN)).toBe(1);
  });

  it("offers the shipped default interval as a preset", () => {
    // If 180 is missing, the picker renders with nothing selected and the
    // first option wins on submit.
    expect(RANDOM_GEN_INTERVAL_PRESETS).toContain(180);
  });
});

describe("save then load", () => {
  it("round-trips a value the form could produce", async () => {
    await saveRandomGenConfig(td.pool, { intervalSec: 300, batchSize: 5 });
    const config = await loadRandomGenConfig(td.pool);
    expect(config.intervalSec).toBe(300);
    expect(config.batchSize).toBe(5);
  });

  it("stores what the runner will actually read for an oversized batch", async () => {
    await saveRandomGenConfig(td.pool, { batchSize: 50 });
    const config = await loadRandomGenConfig(td.pool);
    // Previously this persisted 50 and read 20 back: the page showed 50 as
    // active while the runner used 20.
    expect(config.batchSize).toBe(RANDOM_GEN_BATCH_MAX);
  });

  it("does not let a save write an interval the runner would ignore", async () => {
    await saveRandomGenConfig(td.pool, { intervalSec: 5 });
    const config = await loadRandomGenConfig(td.pool);
    expect(config.intervalSec).toBe(RANDOM_GEN_INTERVAL_MIN_SEC);
  });
});
