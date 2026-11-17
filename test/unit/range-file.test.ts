// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  IPQ_FORMAT,
  IPQ_VERSION,
  encodeHeader,
  encodeRange,
  decodeFile,
  RangeFileError,
} from "../../src/storage/rangeFile";

/** A row as the exporter sees it, before it becomes a line of text. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  line: 0,
  start: "1.0.0.0",
  end: "1.0.0.255",
  countryCode: "AU",
  countryName: "Australia",
  region: null,
  city: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  timezone: null,
  isp: null,
  asn: null,
  asnOrg: null,
  ...over,
});

describe("the .ipq file format", () => {
  it("names itself and its version in the first line", () => {
    // The first line is what tells a person, and a future version of this
    // code, what they are holding. Nothing else in the file identifies it.
    const header = encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 2 });
    expect(header).not.toContain("\n");
    expect(JSON.parse(header)).toEqual({
      format: IPQ_FORMAT,
      version: IPQ_VERSION,
      exportedAt: "2026-11-17T04:12:00.000Z",
      rows: 2,
    });
    expect(IPQ_FORMAT).toBe("ipquery-ranges");
  });

  it("writes one row per line, with the columns a reader can use", () => {
    const line = encodeRange(row({ city: "Sydney", asn: 13335 }));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      start: "1.0.0.0",
      end: "1.0.0.255",
      country: "AU",
      countryName: "Australia",
      city: "Sydney",
      asn: 13335,
    });
  });

  it("omits empty fields instead of writing nulls", () => {
    // A file of eight million lines is mostly empty fields. `"city":null`
    // on every one of them is ~12 bytes a row of nothing.
    const line = encodeRange(row());
    expect(line).not.toContain("null");
  });

  it("round-trips a file through decode", () => {
    const text =
      [
        encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 2 }),
        encodeRange(row({ city: "Sydney" })),
        encodeRange(row({ start: "2400:cb00::", end: "2400:cb00:ffff:ffff:ffff:ffff:ffff:ffff", countryCode: "US" })),
      ].join("\n") + "\n";
    const decoded = decodeFile(text);
    expect(decoded.header.rows).toBe(2);
    expect(decoded.ranges).toHaveLength(2);
    expect(decoded.ranges[0]?.city).toBe("Sydney");
    // Both halves of the address survive as text, so nothing has to guess
    // the family from a byte length.
    expect(decoded.ranges[1]?.start).toBe("2400:cb00::");
  });

  it("refuses a file that does not start with its own header", () => {
    expect(() => decodeFile('{"start":"1.0.0.0"}\n')).toThrow(RangeFileError);
    expect(() => decodeFile('{"format":"something-else","version":1}\n')).toThrow(/not an ipquery-ranges/);
  });

  it("refuses a version it does not understand", () => {
    // Refusing is the point: a reader that guesses at a newer layout
    // imports garbage into a production table.
    expect(() =>
      decodeFile(`${JSON.stringify({ format: IPQ_FORMAT, version: 99, rows: 0 })}\n`),
    ).toThrow(/version 99/);
  });

  it("reports the line number of a row it cannot read", () => {
    // "The file is broken" is useless to an operator holding a 40 MB
    // download. The line number is what makes it fixable.
    const text = [
      encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 2 }),
      encodeRange(row()),
      "{not json",
    ].join("\n") + "\n";
    expect(() => decodeFile(text)).toThrow(/line 3/);
  });

  it("rejects a row whose address is nonsense", () => {
    const text = [
      encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 1 }),
      JSON.stringify({ start: "1.0.0.0", end: "999.0.0.1" }),
    ].join("\n") + "\n";
    expect(() => decodeFile(text)).toThrow(/line 2/);
  });

  it("rejects a range that ends before it starts", () => {
    const text = [
      encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 1 }),
      JSON.stringify({ start: "10.0.0.255", end: "10.0.0.1" }),
    ].join("\n") + "\n";
    expect(() => decodeFile(text)).toThrow(/ends before it starts/);
  });

  it("rejects an IPv4 start paired with an IPv6 end", () => {
    // range_size is computed from two 16-byte values; mixing the families
    // produces a range that covers everything or nothing, and the lookup
    // would then return this row for addresses it has nothing to do with.
    const text = [
      encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 1 }),
      JSON.stringify({ start: "1.0.0.0", end: "2001:db8::" }),
    ].join("\n") + "\n";
    expect(() => decodeFile(text)).toThrow(RangeFileError);
  });

  it("ignores blank lines and a trailing newline", () => {
    const text = [
      encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 1 }),
      "",
      encodeRange(row()),
      "",
    ].join("\n");
    expect(decodeFile(text).ranges).toHaveLength(1);
  });

  it("stops at the import ceiling instead of reading the whole file", () => {
    const lines = [encodeHeader({ exportedAt: "2026-11-17T04:12:00.000Z", rows: 5 })];
    for (let i = 0; i < 5; i++) lines.push(encodeRange(row({ start: `10.0.${i}.0`, end: `10.0.${i}.255` })));
    expect(() => decodeFile(lines.join("\n") + "\n", { maxRows: 3 })).toThrow(/more than 3/);
  });
});
