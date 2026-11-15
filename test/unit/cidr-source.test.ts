// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseCidrLine,
  parseMetowolfCidrStreamWithStats,
  parseRunishiwoV4CidrStreamWithStats,
  parseRunishiwoV6CidrStreamWithStats,
} from "../../src/etl/sources/cidr";
import { parseIp } from "../../src/ip";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-cidr-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function fixture(name: string, body: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, body);
  return filePath;
}

describe("CIDR source parsers", () => {
  it("CIDR parser covers prefix boundaries and rejects bad prefixes", () => {
    expect(parseCidrLine("1.2.3.4/24")).toMatchObject({
      startIp: parseIp("1.2.3.0"),
      endIp: parseIp("1.2.3.255"),
      countryCode: "CN",
      family: "v4",
    });
    expect(parseCidrLine("1.2.3.4")).toMatchObject({
      startIp: parseIp("1.2.3.4"),
      endIp: parseIp("1.2.3.4"),
      family: "v4",
    });
    expect(parseCidrLine("2001:db8::1")).toMatchObject({
      startIp: parseIp("2001:db8::1"),
      endIp: parseIp("2001:db8::1"),
      family: "v6",
    });
    expect(parseCidrLine("0.0.0.0/0")).toMatchObject({
      startIp: parseIp("0.0.0.0"),
      endIp: parseIp("255.255.255.255"),
      family: "v4",
    });
    expect(parseCidrLine("1.2.3.4/32")).toMatchObject({
      startIp: parseIp("1.2.3.4"),
      endIp: parseIp("1.2.3.4"),
    });
    const v6All = parseCidrLine("::/0");
    expect(v6All?.startIp).toEqual(Buffer.alloc(16));
    expect(v6All?.endIp).toEqual(Buffer.alloc(16, 0xff));
    expect(parseCidrLine("2001:db8::/128")).toMatchObject({
      startIp: parseIp("2001:db8::"),
      endIp: parseIp("2001:db8::"),
      family: "v6",
    });
    expect(parseCidrLine("1.2.3.4/33")).toBeNull();
    expect(parseCidrLine("2001:db8::/129")).toBeNull();
    expect(parseCidrLine("garbage/24")).toBeNull();
    expect(parseCidrLine("::ffff:1.2.3.4/120")).toBeNull();
  });

  it("CIDR stream skips comments and counts malformed rows without gzip errors", async () => {
    const body = [
      "# CN IPv4 List | Last Update: 2026-11-15",
      "// another comment",
      "",
      "1.2.3.0/24",
      "1.2.3.4/33",
      "5.6.7.0/24,9.9.9.0/24",
    ].join("\n");
    const { records, stats } = parseMetowolfCidrStreamWithStats(
      await fixture("metowolf.txt", body),
    );
    const emitted = [];
    for await (const record of records) emitted.push(record);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      countryCode: "CN",
      source: "metowolf-cn",
      etlSource: "metowolf-cn",
      family: "v4",
    });
    expect(stats).toEqual({
      rowsEmitted: 1,
      skipped: {
        shortLine: 0,
        headerRow: 0,
        unparseableIp: 2,
        missingCol: 0,
        nonNumericAsn: 0,
        other: 0,
      },
      gunzipErrors: 0,
    });
  });

  it("runishiwo v4 and v6 entry points preserve their file-level source labels", async () => {
    const v4Path = await fixture("runishiwo-v4.txt", "10.0.0.0/8\n");
    const v6Path = await fixture("runishiwo-v6.txt", "2001:db8::/32\n");
    const v4 = parseRunishiwoV4CidrStreamWithStats(v4Path);
    const v6 = parseRunishiwoV6CidrStreamWithStats(v6Path);
    const v4Records = [];
    const v6Records = [];
    for await (const record of v4.records) v4Records.push(record);
    for await (const record of v6.records) v6Records.push(record);
    expect(v4Records[0]).toMatchObject({
      source: "runishiwo-cn",
      etlSource: "runishiwo-cn",
      family: "v4",
    });
    expect(v6Records[0]).toMatchObject({
      source: "runishiwo-cn",
      etlSource: "runishiwo-v6",
      family: "v6",
    });
    expect(v4.stats.gunzipErrors).toBe(0);
    expect(v6.stats.gunzipErrors).toBe(0);
  });
});
