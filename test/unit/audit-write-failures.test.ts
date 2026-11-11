// SPDX-License-Identifier: MIT
//
// Audit-log write failures must not poison a run — but they must not
// disappear either.
//
// Several fire-and-forget writes sit on the provider fan-out path:
// the per-IP probe audit (random_probe_log), the provider failure log
// (provider_error_log, which the circuit breaker reads), and the
// per-provider daily counter. Each one is deliberately non-fatal — a
// failed audit insert must not abort a backfill that is otherwise
// working — but every one of them used to swallow the error
// completely.
//
// That silence has a cost: provider_error_log is the circuit breaker's
// only input, so a dropped write there means the breaker never trips.
// And random_probe_log is the sole record of what each provider said,
// so a dropped row is indistinguishable from a provider that was never
// called.
//
// These tests pin both halves of the contract: the run still completes,
// and the failure is reported through the logger.
//
// Two harnesses are used, because the writes live at two different
// levels:
//
//   - processIp() writes provider_error_log and the daily counter
//     directly, so a stubbed pool can make those writes fail.
//   - random_probe_log is written by the CALLER of processIp(), so it
//     needs the real backfill flow against a real (test) database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { processIp, runBackfill } from "../../src/etl/unknownIpBackfill";
import type { BackfillSummary } from "../../src/etl/unknownIpBackfill";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { insertOrIncrement } from "../../src/storage/unknownIpQueue";
import type { IpGeoProvider, IpGeoRecord } from "../../src/etl/providers/types";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("auditWriteFailures");
});
afterAll(async () => {
  await dropTestDb(td);
});
beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE unknown_ip_queue");
  await td.pool.query("TRUNCATE TABLE ip_ranges");
  await td.pool.query("TRUNCATE TABLE random_probe_log");
});

/** A logger that records the warnings it receives. */
function stubLogger() {
  const warnings: Array<{ msg: string; payload: Record<string, unknown> }> = [];
  return {
    warnings,
    log: vi.fn(),
    warn: vi.fn((msg: string, payload: Record<string, unknown> = {}) => {
      warnings.push({ msg, payload });
    }),
    error: vi.fn(),
  };
}

/**
 * A pool stub that fails the queries matching `failPattern` and
 * delegates everything else to the real pool.
 *
 * The fan-out path issues several kinds of query against the pool: the
 * ip_ranges upsert, the random_probe_log insert, the
 * provider_error_log insert, and the per-provider counter. Only the
 * audit writes are of interest here, so everything else has to reach
 * the real database — otherwise the consensus write silently no-ops and
 * the outcome never reaches "merged".
 */
function stubPool(failPattern: RegExp, realPool: TestDb["pool"]) {
  const realQuery = realPool.query.bind(realPool);
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (failPattern.test(sql)) {
      throw new Error(`simulated write failure: ${failPattern.source}`);
    }
    return realQuery(sql, params as never[]);
  });
  return { pool: { query } as never, query };
}

function rec(over: Partial<IpGeoRecord> = {}): IpGeoRecord {
  return {
    countryCode: "US",
    countryName: "United States",
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    asn: null,
    asnOrg: null,
    ...over,
  };
}

/**
 * Three agreeing providers.
 *
 * majorityVote() needs at least two country-code votes before it will
 * merge anything — a single provider is reported as "no_country". So
 * the fan-out tests use a realistic 3-provider set rather than a lone
 * stub.
 */
const agreeingProviders: IpGeoProvider[] = [
  { name: "stub-a", lookup: async () => ({ record: rec(), rateLimited: false }) },
  { name: "stub-b", lookup: async () => ({ record: rec(), rateLimited: false }) },
  { name: "stub-c", lookup: async () => ({ record: rec(), rateLimited: false }) },
];

/** A provider that always fails — drives the provider_error_log path. */
const failingProvider: IpGeoProvider = {
  name: "stub-fail",
  lookup: async () => {
    throw new Error("provider exploded");
  },
};

/** A provider that returns an explicit errorCode without throwing. */
const errorCodeProvider: IpGeoProvider = {
  name: "stub-errorcode",
  lookup: async () => ({
    record: null,
    rateLimited: false,
    errorCode: "no_country",
    rawResponse: "body",
  }),
};

function emptySummary(): BackfillSummary {
  return {
    considered: 0,
    merged: 0,
    noConsensus: 0,
    noCountry: 0,
    allAbstained: 0,
    alreadyCovered: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    providers: {},
    providersDisabled: [],
    mode: "committed",
    previewRows: [],
  };
}

describe("provider_error_log / counter write failures", () => {
  it("completes the fan-out even when the failure-log write fails", async () => {
    const { pool } = stubPool(/INSERT INTO provider_error_log/, td.pool);
    const log = stubLogger();
    const summary = emptySummary();

    const result = await processIp(
      pool,
      agreeingProviders,
      "8.8.8.8",
      parseIp("8.8.8.8"),
      summary,
      "random",
      false,
      log,
    );

    // The run completed: the provider was consulted and its answer
    // became the outcome.
    expect(result.outcome.kind).toBe("merged");
  });

  it("reports a failed provider_error_log write on the throwing path", async () => {
    const { pool } = stubPool(/INSERT INTO provider_error_log/, td.pool);
    const log = stubLogger();
    const summary = emptySummary();

    await processIp(
      pool,
      [failingProvider],
      "8.8.8.8",
      parseIp("8.8.8.8"),
      summary,
      "random",
      false,
      log,
    );

    const warnings = log.warnings.filter((w) => w.msg === "provider_error_log write failed");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.payload.provider).toBe("stub-fail");
  });

  it("reports a failed provider_error_log write on the errorCode path too", async () => {
    const { pool } = stubPool(/INSERT INTO provider_error_log/, td.pool);
    const log = stubLogger();
    const summary = emptySummary();

    await processIp(
      pool,
      [errorCodeProvider],
      "8.8.8.8",
      parseIp("8.8.8.8"),
      summary,
      "random",
      false,
      log,
    );

    const warnings = log.warnings.filter((w) => w.msg === "provider_error_log write failed");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.payload.errorCode).toBe("no_country");
  });

  it("reports a failed daily-counter write", async () => {
    const { pool } = stubPool(/INSERT INTO provider_call_counter/, td.pool);
    const log = stubLogger();
    const summary = emptySummary();

    await processIp(
      pool,
      agreeingProviders,
      "8.8.8.8",
      parseIp("8.8.8.8"),
      summary,
      "random",
      false,
      log,
    );

    expect(
      log.warnings.some((w) => w.msg === "provider_called_counter write failed"),
    ).toBe(true);
  });

  it("stays quiet when every write succeeds", async () => {
    const { pool } = stubPool(/^$/, td.pool);
    const log = stubLogger();
    const summary = emptySummary();

    await processIp(
      pool,
      agreeingProviders,
      "8.8.8.8",
      parseIp("8.8.8.8"),
      summary,
      "random",
      false,
      log,
    );

    expect(log.warnings).toHaveLength(0);
  });
});

describe("random_probe_log write failures", () => {
  it("completes the backfill even when the probe-audit write fails", async () => {
    const ip = "203.0.113.20";
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);

    const log = stubLogger();
    const { pool } = stubPool(/INSERT INTO random_probe_log/, td.pool);

    const summary = await runBackfill(pool, agreeingProviders, {
      batchLimit: 50,
      logger: log,
    });

    // The IP was still looked up and merged — the audit failure did not
    // abort the run.
    expect(summary.merged).toBe(1);
    // And the failure was reported.
    expect(log.warnings.some((w) => w.msg === "random_probe_log write failed")).toBe(true);
  });

  it("reports the probe-audit failure with the IP it belongs to", async () => {
    const ip = "203.0.113.21";
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);

    const log = stubLogger();
    const { pool } = stubPool(/INSERT INTO random_probe_log/, td.pool);

    await runBackfill(pool, agreeingProviders, { batchLimit: 50, logger: log });

    const warning = log.warnings.find((w) => w.msg === "random_probe_log write failed");
    expect(warning).toBeDefined();
    expect(warning!.payload.ip).toBe(ip);
  });
});
