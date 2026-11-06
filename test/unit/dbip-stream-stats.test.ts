// SPDX-License-Identifier: MIT
//
// Invariant tests for the *WithStats parsers introduced alongside the
// stage-breakdown schema in migration 019. The pipeline persists ParseStats
// to etl_run_parses, so the recorded `rowsEmitted` must equal what the
// legacy array variants yielded — otherwise the operator UI would show
// different row counts than the actual DB content.

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import {
  parseDbipCityCsv,
  parseDbipCityCsvStreamWithStats,
  parseDbipAsnCsvStreamWithStats,
} from "../../src/etl/sources/dbip";

const fixtures = path.join(__dirname, "..", "..", "fixtures");

describe("parseDbipCityCsvStreamWithStats — parity with legacy", () => {
  it("yields the same number of records as parseDbipCityCsv on the city fixture", async () => {
    const legacy = await parseDbipCityCsv(path.join(fixtures, "dbip-sample.csv.gz"));
    const { records, stats } = parseDbipCityCsvStreamWithStats(path.join(fixtures, "dbip-sample.csv.gz"));
    const out: unknown[] = [];
    for await (const r of records) out.push(r);
    expect(out).toHaveLength(legacy.length);
    expect(stats.rowsEmitted).toBe(legacy.length);
    // Fixture file has only valid rows — every skip counter must be zero.
    expect(stats.skipped).toEqual({
      shortLine: 0,
      headerRow: 0,
      unparseableIp: 0,
      missingCol: 0,
      nonNumericAsn: 0,
      other: 0,
    });
    expect(stats.gunzipErrors).toBe(0);
  });
});

describe("parseDbipAsnCsvStreamWithStats — skip counters", () => {
  it("increments nonNumericAsn for a row with a non-integer ASN column", async () => {
    // Synthesize a tiny CSV.gz whose ASN column is "abc" for one row.
    // The legacy parser would still emit the row with asn undefined —
    // we preserve that behaviour, but the WithStats variant now also
    // bumps the counter so the run-detail page can surface "1 row had a
    // non-numeric ASN".
    const csv = [
      "ip_start,ip_end,asn,asn_org",
      "1.2.3.0,1.2.3.255,15169,Google LLC",
      "4.5.6.0,4.5.6.255,not-a-number,TestNet",
      "7.8.9.0,7.8.9.255,13335,Cloudflare, Inc.",
    ].join("\n");
    const tmpPath = path.join(fixtures, "_dbip-asn-nonasn.csv.gz");
    await fs.writeFile(tmpPath, zlib.gzipSync(Buffer.from(csv)));
    try {
      const { records, stats } = parseDbipAsnCsvStreamWithStats(tmpPath);
      const out: { asn?: number }[] = [];
      for await (const r of records) out.push(r);
      expect(out).toHaveLength(3);
      // Non-numeric ASN row is still emitted, with asn undefined.
      expect(out[1]?.asn).toBeUndefined();
      // …and the counter is bumped exactly once.
      expect(stats.skipped.nonNumericAsn).toBe(1);
      expect(stats.rowsEmitted).toBe(3);
      // The first and third rows have valid ASNs.
      expect(out[0]?.asn).toBe(15169);
      expect(out[2]?.asn).toBe(13335);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  });

  it("skips the header line without inflating any skip counter", async () => {
    // streamGzippedCsv strips the very first row when header=true, so the
    // header row never reaches the parser at all — neither headerRow nor
    // shortLine is bumped. The single data row below it is the only one
    // emitted, and rowsEmitted reflects exactly that.
    const csv = ["ip_start,ip_end,asn,asn_org", "1.2.3.0,1.2.3.255,15169,Google LLC"].join("\n");
    const tmpPath = path.join(fixtures, "_dbip-asn-header.csv.gz");
    await fs.writeFile(tmpPath, zlib.gzipSync(Buffer.from(csv)));
    try {
      const { records, stats } = parseDbipAsnCsvStreamWithStats(tmpPath);
      const out: unknown[] = [];
      for await (const r of records) out.push(r);
      expect(out).toHaveLength(1);
      expect(stats.rowsEmitted).toBe(1);
      expect(stats.skipped.headerRow).toBe(0);
      expect(stats.skipped.shortLine).toBe(0);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  });
});
