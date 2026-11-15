// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseSapicsCountryCsvLine,
  parseSapicsCountryStreamWithStats,
} from "../../src/etl/sources/sapicsCountry";
import { parseIp } from "../../src/ip";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-sapics-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("sapics country parser", () => {
  it("sapics parser skips invalid country codes and IPv4-mapped IPv6", async () => {
    expect(parseSapicsCountryCsvLine('"1.2.3.0","1.2.3.255","CN"')).toMatchObject({
      startIp: parseIp("1.2.3.0"),
      endIp: parseIp("1.2.3.255"),
      countryCode: "CN",
      family: "v4",
    });

    const body = [
      "1.2.3.0,1.2.3.255,CN",
      "2001:db8::,2001:db8::ffff,US",
      "4.5.6.0,4.5.6.255,",
      "4.5.7.0,4.5.7.255,ZZ",
      "4.5.8.0,4.5.8.255,CHN",
      "::ffff:1.2.3.4,::ffff:1.2.3.5,CN",
      "short,row",
    ].join("\n");
    const filePath = path.join(tmpDir, "user-country.csv");
    await fs.writeFile(filePath, body);
    const { records, stats } = parseSapicsCountryStreamWithStats(filePath);
    const emitted = [];
    for await (const record of records) emitted.push(record);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      countryCode: "CN",
      source: "sapics-user",
      etlSource: "sapics-user",
      family: "v4",
    });
    expect(emitted[1]).toMatchObject({
      countryCode: "US",
      source: "sapics-user",
      etlSource: "sapics-user",
      family: "v6",
    });
    expect(stats.rowsEmitted).toBe(2);
    expect(stats.skipped.missingCol).toBe(4);
    expect(stats.skipped.other).toBe(0);
    expect(stats.skipped.shortLine).toBe(1);
    expect(stats.gunzipErrors).toBe(0);
  });
});
