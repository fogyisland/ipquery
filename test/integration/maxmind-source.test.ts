import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parseMaxmindMmdb } from "../../src/etl/sources/maxmind";

const FIXTURE = path.join(__dirname, "..", "..", "fixtures", "maxmind-sample.mmdb");

describe("maxmind source", () => {
  it("extracts records with country and city", async () => {
    const records = await parseMaxmindMmdb(FIXTURE, "city");
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.source).toBe("maxmind");
    expect(records[0]?.startIp.length).toBe(16);
  });

  it("all records have valid 16-byte start/end buffers", async () => {
    const records = await parseMaxmindMmdb(FIXTURE, "city");
    for (const r of records) {
      expect(r.startIp.length).toBe(16);
      expect(r.endIp.length).toBe(16);
    }
  });
});
