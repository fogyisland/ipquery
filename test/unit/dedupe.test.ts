// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  DEDUPE_CONFLICT_PRIORITY,
  DEDUPE_MAX_INPUT_ROWS,
  dedupeSourceRecords,
} from "../../src/etl/sources/dedupe";
import { parseIp } from "../../src/ip";
import type { Source } from "../../src/types";
import type { EtlRunDownloadSource } from "../../src/storage/mysql";
import type { AddressFamily, SourceRecord } from "../../src/etl/sources/types";

type FileSource = Extract<
  EtlRunDownloadSource,
  "metowolf-cn" | "runishiwo-cn" | "runishiwo-v6" | "sapics-user"
>;

function record(
  family: AddressFamily,
  start: string,
  end: string,
  etlSource: FileSource,
  source: Source = "metowolf-cn",
  countryCode = "CN",
): SourceRecord {
  const startIp = parseIp(start);
  const endIp = parseIp(end);
  if (!startIp || !endIp) throw new Error(`bad test IP: ${start}-${end}`);
  return { startIp, endIp, family, etlSource, source, countryCode };
}

function v4(
  start: string,
  end: string,
  etlSource: FileSource,
  source: Source = "metowolf-cn",
  countryCode = "CN",
): SourceRecord {
  return record("v4", start, end, etlSource, source, countryCode);
}

function v6(
  start: string,
  end: string,
  etlSource: FileSource,
  source: Source = "metowolf-cn",
  countryCode = "CN",
): SourceRecord {
  return record("v6", start, end, etlSource, source, countryCode);
}

async function* from(records: SourceRecord[]): AsyncIterable<SourceRecord> {
  yield* records;
}

function assertIdentity(result: Awaited<ReturnType<typeof dedupeSourceRecords>>): void {
  const byFile = Object.values(result.stats.emittedByFile).reduce((sum, count) => sum + (count ?? 0), 0);
  expect(byFile).toBe(result.stats.emitted);
  expect(result.stats.emitted).toBe(
    result.stats.input - result.stats.contained - result.stats.exactDuplicates,
  );
  for (const [etlSource, count] of Object.entries(result.stats.emittedByFile)) {
    expect(result.records.filter((r) => r.etlSource === etlSource)).toHaveLength(count);
  }
}

describe("dedupeSourceRecords", () => {
  it("dedupe applies containment, exact-duplicate, partial-overlap and limit rules", async () => {
    const contained = await dedupeSourceRecords(
      from([
        v4("10.1.0.0", "10.1.0.255", "metowolf-cn"),
        v4("10.0.0.0", "10.0.255.255", "runishiwo-cn", "runishiwo-cn"),
        v4("10.0.1.0", "10.0.1.255", "metowolf-cn"),
      ]),
    );
    expect(contained.records).toHaveLength(2);
    expect(contained.stats.contained).toBe(1);
    expect(contained.stats.emitted).toBe(2);
    assertIdentity(contained);

    const duplicate = await dedupeSourceRecords(
      from([
        v4("10.0.0.0", "10.0.255.255", "metowolf-cn", "metowolf-cn", "CN"),
        v4("10.0.0.0", "10.0.255.255", "sapics-user", "sapics-user", "US"),
        v4("10.0.0.0", "10.0.255.255", "runishiwo-v6", "runishiwo-cn", "HK"),
      ]),
    );
    expect(duplicate.records).toHaveLength(1);
    expect(duplicate.records[0]).toMatchObject({
      source: "sapics-user",
      etlSource: "sapics-user",
      countryCode: "US",
    });
    expect(duplicate.stats.exactDuplicates).toBe(2);
    expect(DEDUPE_CONFLICT_PRIORITY).toEqual({
      "sapics-user": 3,
      "runishiwo-cn": 2,
      "metowolf-cn": 1,
    });
    expect(Object.keys(duplicate.stats.emittedByFile)).toEqual(["sapics-user"]);
    assertIdentity(duplicate);

    const partial = await dedupeSourceRecords(
      from([
        v4("10.0.0.0", "10.0.255.255", "metowolf-cn"),
        v4("10.0.255.0", "10.1.0.255", "runishiwo-cn", "runishiwo-cn"),
      ]),
    );
    expect(partial.records).toHaveLength(2);
    expect(partial.stats.partialOverlaps).toBe(1);
    assertIdentity(partial);

    const adjacent = await dedupeSourceRecords(
      from([
        v4("10.0.0.0", "10.0.0.255", "metowolf-cn"),
        v4("10.0.1.0", "10.0.1.255", "metowolf-cn"),
      ]),
    );
    expect(adjacent.records).toHaveLength(2);
    expect(adjacent.stats.emitted).toBe(2);
    assertIdentity(adjacent);

    const empty = await dedupeSourceRecords(from([]));
    expect(empty.stats).toEqual({
      input: 0,
      contained: 0,
      exactDuplicates: 0,
      partialOverlaps: 0,
      emitted: 0,
      emittedByFile: {},
    });
    assertIdentity(empty);

    const tooMany: SourceRecord[] = [];
    const template = v4("10.0.0.0", "10.0.0.255", "metowolf-cn");
    for (let index = 0; index < DEDUPE_MAX_INPUT_ROWS + 1; index += 1) {
      tooMany.push(template);
    }
    await expect(dedupeSourceRecords(from(tooMany))).rejects.toThrow(
      String(DEDUPE_MAX_INPUT_ROWS),
    );
  });

  it("dedupe keeps v4 and v6 families separate", async () => {
    const result = await dedupeSourceRecords(
      from([
        v4("0.0.0.0", "255.255.255.255", "metowolf-cn"),
        v6("::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "runishiwo-v6", "runishiwo-cn"),
        v6("2001:db8::", "2001:db8::ffff", "sapics-user", "sapics-user"),
      ]),
    );
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.family).toBe("v4");
    expect(result.records[1]!.family).toBe("v6");
    expect(result.stats.contained).toBe(1);
    expect(result.records[1]!.etlSource).toBe("runishiwo-v6");
    assertIdentity(result);
  });
});
