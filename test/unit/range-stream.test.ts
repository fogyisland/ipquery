// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  decodeStream,
  RangeFileError,
  encodeHeader,
  encodeRange,
  IPQ_FORMAT,
} from "../../src/storage/rangeFile";

const rec = (start: string, end: string, over: Record<string, unknown> = {}) => ({
  line: 0,
  start,
  end,
  countryCode: null,
  countryName: null,
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

const file = (rows: unknown[], meta = { exportedAt: "2026-11-17T04:12:00.000Z", rows: rows.length }) =>
  [encodeHeader(meta), ...rows.map((r) => encodeRange(r as never))].join("\n") + "\n";

/** Feed `text` to the decoder in chunks of `size`, the way a network read
 *  delivers it. */
async function* chunks(text: string, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < text.length; i += size) {
    yield Buffer.from(text.slice(i, i + size), "utf8");
  }
}

async function collect(text: string, size: number, onBatch?: (batch: readonly unknown[]) => Promise<void>) {
  const headers: unknown[] = [];
  const batches: unknown[][] = [];
  await decodeStream(Readable.from(chunks(text, size)), {
    onHeader: (h) => headers.push(h),
    onBatch: async (batch) => {
      batches.push([...batch]);
      await onBatch?.(batch);
    },
  });
  return { headers, batches, total: batches.reduce((n, b) => n + b.length, 0) };
}

describe("decodeStream", () => {
  it("reads a file split at arbitrary byte boundaries", async () => {
    // A network read has no idea where a line ends. A decoder that splits on
    // the chunk boundary rather than on the newline either drops lines or
    // fails on JSON that happens to straddle two reads.
    const text = file([
      rec("1.0.0.0", "1.0.0.255", { countryCode: "AU" }),
      rec("2.0.0.0", "2.0.0.255", { countryCode: "US" }),
      rec("3.0.0.0", "3.0.0.255", { countryCode: "DE" }),
    ]);
    for (const size of [1, 2, 7, 13, 64, 1024]) {
      const out = await collect(text, size);
      expect(out.total, `chunk size ${size}`).toBe(3);
      expect(out.batches.flat()).toHaveLength(3);
    }
  });

  it("reports the header before any row reaches the callback", async () => {
    // The header is what tells the importer how many rows to expect, and a
    // refusal ("this is version 99") has to happen before a million rows
    // have been written into a staging table.
    const text = file([rec("1.0.0.0", "1.0.0.255")]);
    const order: string[] = [];
    await decodeStream(Readable.from(chunks(text, 5)), {
      onHeader: (h) => order.push(`header:${h.format}`),
      onBatch: async () => {
        order.push("batch");
      },
    });
    expect(order[0]).toBe(`header:${IPQ_FORMAT}`);
    expect(order.slice(1).every((o) => o === "batch")).toBe(true);
  });

  it("hands rows over in batches rather than one at a time", async () => {
    // One INSERT per row is what makes a nine-million-row import take
    // hours instead of minutes.
    const rows = Array.from({ length: 1500 }, (_, i) =>
      rec(`10.${Math.floor(i / 256)}.${i % 256}.0`, `10.${Math.floor(i / 256)}.${i % 256}.255`),
    );
    const out = await collect(file(rows), 4096);
    expect(out.total).toBe(1500);
    expect(out.batches.length).toBeLessThan(10);
    expect(out.batches.every((b) => b.length > 0)).toBe(true);
  });

  it("names the line number of a row it cannot parse", async () => {
    const text = [encodeHeader({ exportedAt: "x", rows: 2 }), encodeRange(rec("1.0.0.0", "1.0.0.255")), "{oops"].join("\n") + "\n";
    await expect(collect(text, 16)).rejects.toThrow(/line 3/);
  });

  it("refuses a file whose version it does not read", async () => {
    const text = JSON.stringify({ format: IPQ_FORMAT, version: 99, rows: 0 }) + "\n";
    await expect(collect(text, 8)).rejects.toThrow(/version 99/);
  });

  it("stops at the row ceiling instead of consuming the whole upload", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => rec(`10.0.${i}.0`, `10.0.${i}.255`));
    const stream = Readable.from(chunks(file(rows), 32));
    await expect(
      decodeStream(stream, {
        onHeader: () => undefined,
        onBatch: async () => undefined,
        maxRows: 4,
      }),
    ).rejects.toThrow(RangeFileError);
  });

  it("treats an empty body as a file with no header", async () => {
    // The upload was interrupted or the wrong file was picked. Silence
    // would leave the operator believing an import of zero rows happened.
    await expect(collect("", 8)).rejects.toThrow(/header/);
  });

  it("ignores a byte-order mark at the start of the upload", async () => {
    const text = "﻿" + file([rec("1.0.0.0", "1.0.0.255")]);
    const out = await collect(text, 16);
    expect(out.total).toBe(1);
  });
});
