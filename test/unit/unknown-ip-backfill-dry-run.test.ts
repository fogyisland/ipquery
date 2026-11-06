// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { insertOrIncrement } from "../../src/storage/unknownIpQueue";
import { runBackfill } from "../../src/etl/unknownIpBackfill";
import type { IpGeoProvider, IpGeoRecord, IpGeoLookupResult } from "../../src/etl/providers/types";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("unkbackDryRun");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE unknown_ip_queue");
  await td.pool.query("TRUNCATE TABLE ip_ranges");
});

function rec(over: Partial<IpGeoRecord>): IpGeoRecord {
  return {
    countryCode: null,
    countryName: null,
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

class StubProvider implements IpGeoProvider {
  readonly name: string;
  responses: Map<string, IpGeoRecord | null>;
  constructor(name: string, responses: Record<string, IpGeoRecord | null>) {
    this.name = name;
    this.responses = new Map(Object.entries(responses));
  }
  async lookup(ip: string): Promise<IpGeoLookupResult> {
    return { record: this.responses.get(ip) ?? null, rateLimited: false };
  }
}

describe("runBackfill dry-run", () => {
  it("does NOT insert into ip_ranges when dryRun=true", async () => {
    const ip = "203.0.113.10";
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    // Spy on pool.query so we can count how many INSERT/UPDATE statements
    // hit ip_ranges / unknown_ip_queue during the run. We restore the
    // original after restoring so other tests aren't affected.
    const querySpy = vi.spyOn(td.pool, "query");
    try {
      const providers = [
        new StubProvider("a", { [ip]: rec({ countryCode: "US", asn: 15169, city: "Mountain View" }) }),
        new StubProvider("b", { [ip]: rec({ countryCode: "US", asn: 15169, city: "Mountain View" }) }),
        new StubProvider("c", { [ip]: rec({ countryCode: "US", asn: 15169, city: "Mountain View" }) }),
      ];
      const summary = await runBackfill(td.pool, providers, { batchLimit: 50, dryRun: true });
      expect(summary.mode).toBe("preview");
      // Counts are populated as if the run would have happened, so the
      // preview page can show "X merged / Y skipped" the same way the
      // post-commit banner does.
      expect(summary.merged).toBe(1);
      expect(summary.previewRows.length).toBe(1);
      expect(summary.previewRows[0].ipText).toBe(ip);
      expect(summary.previewRows[0].countryCode).toBe("US");
      expect(summary.previewRows[0].city).toBe("Mountain View");
      expect(summary.previewRows[0].asn).toBe(15169);
      expect(summary.previewRows[0].outcome).toBe("merged");

      // The KEY assertion: no INSERT into ip_ranges happened during the
      // dry-run. We check both the spy (zero INSERT statements on
      // ip_ranges) AND the actual table contents.
      const allSql = querySpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allSql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+ip_ranges/i);
      // No UPDATE on unknown_ip_queue either (markProcessed / markAttempted).
      expect(allSql).not.toMatch(/UPDATE\s+unknown_ip_queue\s+SET\s+processed_at/i);
    } finally {
      querySpy.mockRestore();
    }

    // Independent confirmation: ip_ranges is empty.
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(rows.length).toBe(0);
  });

  it("does NOT mark queue rows processed when dryRun=true", async () => {
    const ip = "203.0.113.20";
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new StubProvider("a", { [ip]: rec({ countryCode: "DE" }) }),
      new StubProvider("b", { [ip]: rec({ countryCode: "DE" }) }),
      new StubProvider("c", { [ip]: rec({ countryCode: "DE" }) }),
    ];
    await runBackfill(td.pool, providers, { batchLimit: 50, dryRun: true });

    // Queue row is still pending — no markProcessed / markAttempted writes.
    const [rows] = await td.pool.query<{ processed_at: Date | null; last_attempt_reason: string | null }[]>(
      `SELECT processed_at, last_attempt_reason FROM unknown_ip_queue WHERE ip = ?`,
      [buf],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].processed_at).toBeNull();
    expect(rows[0].last_attempt_reason).toBeNull();
  });

  it("records no_consensus preview rows without writing anything", async () => {
    const ip = "203.0.113.30";
    const buf = parseIp(ip)!;
    await insertOrIncrement(td.pool, buf, ip);

    const providers = [
      new StubProvider("a", { [ip]: rec({ countryCode: "US" }) }),
      new StubProvider("b", { [ip]: rec({ countryCode: "CA" }) }),
      new StubProvider("c", { [ip]: rec({ countryCode: "DE" }) }),
    ];
    const summary = await runBackfill(td.pool, providers, { batchLimit: 50, dryRun: true });
    expect(summary.mode).toBe("preview");
    expect(summary.noConsensus).toBe(1);
    expect(summary.previewRows.length).toBe(1);
    expect(summary.previewRows[0].outcome).toBe("no_consensus");
    expect(summary.previewRows[0].countryCode).toBeNull();

    // No writes happened.
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(rows.length).toBe(0);
    const [queueRows] = await td.pool.query<{ last_attempt_reason: string | null }[]>(
      `SELECT last_attempt_reason FROM unknown_ip_queue`,
    );
    expect(queueRows[0].last_attempt_reason).toBeNull();
  });

  it("object shape on dryRun=true is BackfillSummary-compatible (mode === preview)", async () => {
    const summary = await runBackfill(td.pool, [], { batchLimit: 50, dryRun: true });
    expect(summary.mode).toBe("preview");
    expect(summary.previewRows).toEqual([]);
    expect(summary.merged).toBe(0);
    expect(summary.noConsensus).toBe(0);
  });
});
