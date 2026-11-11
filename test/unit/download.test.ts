// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as https from "node:https";
import * as http from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  candidateMonths,
  DEFAULT_SPECS,
  downloadToFile,
  validateGzFile,
} from "../../src/etl/download";

describe("candidateMonths", () => {
  it("returns the current month first, then walks back", () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 7, 15)), 4); // Aug 2026
    expect(months).toEqual(["2026-08", "2026-07", "2026-06", "2026-05"]);
  });

  it("crosses a year boundary backwards", () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 0, 10)), 4); // Jan 2026
    expect(months).toEqual(["2026-01", "2025-12", "2025-11", "2025-10"]);
  });

  it("crosses a year boundary forwards (negative modulo)", () => {
    // Defensive: if someone passes a Date whose UTC month has been
    // mutated weirdly, candidateMonths should still produce a sane list.
    // We test the modulo math directly: month 0..-3 should wrap to
    // 12..10 of the previous year.
    const months = candidateMonths(new Date(Date.UTC(2026, 0, 1)), 4);
    // Dec = month 11 → 2025-12; Nov = 10 → 2025-11; Oct = 9 → 2025-10
    expect(months[0]).toBe("2026-01");
    expect(months[1]).toBe("2025-12");
    expect(months[2]).toBe("2025-11");
    expect(months[3]).toBe("2025-10");
  });

  it("pads single-digit months with a leading zero", () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 8, 1)), 2); // Sep 2026
    expect(months).toEqual(["2026-09", "2026-08"]);
  });

  it("respects the lookback limit", () => {
    expect(candidateMonths(new Date(Date.UTC(2026, 7, 1)), 1)).toHaveLength(1);
    expect(candidateMonths(new Date(Date.UTC(2026, 7, 1)), 12)).toHaveLength(12);
  });
});

describe("DEFAULT_SPECS", () => {
  it("covers city, country, and asn with the canonical pipeline filenames", () => {
    const byDest = new Map(DEFAULT_SPECS.map((s) => [s.destName, s]));
    expect(byDest.get("dbip.csv.gz")?.kind).toBe("city");
    expect(byDest.get("dbip-country.csv.gz")?.kind).toBe("country");
    expect(byDest.get("dbip-asn.csv.gz")?.kind).toBe("asn");
  });

  it("uses the DB-IP download URL stem", () => {
    // If DB-IP renames their URL scheme, we want this to be the only
    // place we have to change it. The test pins the current contract.
    expect(DEFAULT_SPECS.map((s) => s.urlStem)).toEqual([
      "dbip-city-lite",
      "dbip-country-lite",
      "dbip-asn-lite",
    ]);
  });
});

describe("validateGzFile", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-gz-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeGz = async (name: string, body: string): Promise<string> => {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, zlib.gzipSync(Buffer.from(body)));
    return filePath;
  };

  it("accepts an intact gzip member", async () => {
    const filePath = await writeGz("intact.csv.gz", "a,b,c\n1,2,3\n");
    expect(await validateGzFile(filePath)).toBeNull();
  });

  it("rejects a truncated gzip member (the interrupted-download case)", async () => {
    // A half-written .gz: valid header, truncated deflate stream. This
    // is exactly what an interrupted ETL run leaves on disk.
    const filePath = path.join(tmpDir, "truncated.csv.gz");
    const full = zlib.gzipSync(Buffer.from("a,b,c\n".repeat(500)));
    await fs.writeFile(filePath, full.subarray(0, Math.floor(full.length / 2)));
    const problem = await validateGzFile(filePath);
    expect(problem).toBeTruthy();
    expect(problem).toContain("gzip");
  });

  it("rejects a file whose trailer disagrees with its inflated length", async () => {
    // A valid gzip member whose trailer ISIZE has been tampered with.
    const filePath = path.join(tmpDir, "bad-trailer.csv.gz");
    const buf = zlib.gzipSync(Buffer.from("a,b,c\n".repeat(100)));
    buf.writeUInt32LE(999999, buf.length - 4);
    await fs.writeFile(filePath, buf);
    const problem = await validateGzFile(filePath);
    expect(problem).toBeTruthy();
    expect(problem).toMatch(/trailer|inflates|integrity/);
  });

  it("rejects a non-gzip file (e.g. an HTML error page saved as .gz)", async () => {
    const filePath = path.join(tmpDir, "not-gzip.csv.gz");
    await fs.writeFile(filePath, "<html><body>502 Bad Gateway</body></html>");
    const problem = await validateGzFile(filePath);
    expect(problem).toBeTruthy();
    expect(problem).toContain("magic");
  });

  it("rejects a file that is too small to be a gzip member", async () => {
    const filePath = path.join(tmpDir, "tiny.csv.gz");
    await fs.writeFile(filePath, Buffer.from([0x1f, 0x8b]));
    const problem = await validateGzFile(filePath);
    expect(problem).toBeTruthy();
    expect(problem).toContain("too small");
  });

  it("reports a missing file rather than throwing", async () => {
    const problem = await validateGzFile(path.join(tmpDir, "does-not-exist.csv.gz"));
    expect(problem).toBeTruthy();
  });
});

describe("downloadToFile integrity check", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-dl-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // A stub HTTPS client that serves `body` but advertises
  // `advertisedLength` in the Content-Length header. When the two
  // disagree, the server is lying about the size — exactly what a
  // connection dropped mid-transfer looks like to the client.
  const stubGet = (body: string, advertisedLength: number): typeof https.get => {
    const impl = ((url: string, cb: (res: http.IncomingMessage) => void) => {
      const res = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = 200;
      (res as unknown as { headers: Record<string, string> }).headers = {
        "content-length": String(advertisedLength),
      };
      setImmediate(() => cb(res));
      // downloadToFile only needs `on` and `setTimeout` on the request.
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, cb: () => void) => void;
        destroy: (err?: Error) => void;
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      return req as unknown as http.ClientRequest;
    }) as unknown as typeof https.get;
    return impl;
  };

  it("writes the file and resolves when Content-Length matches", async () => {
    const dest = path.join(tmpDir, "ok.csv.gz");
    const body = "hello world";
    const bytes = await downloadToFile(
      "https://example.test/x.gz",
      dest,
      undefined,
      stubGet(body, body.length),
    );
    expect(bytes).toBe(body.length);
    expect(await fs.readFile(dest, "utf-8")).toBe(body);
  });

  it("rejects and deletes the file when the body is shorter than Content-Length", async () => {
    // The interrupted-download case: the socket closed early but the
    // server promised more bytes. The half-written file must NOT be
    // left on disk for the next run to pick up.
    const dest = path.join(tmpDir, "short.csv.gz");
    const body = "only half";
    await expect(
      downloadToFile(
        "https://example.test/x.gz",
        dest,
        undefined,
        stubGet(body, body.length * 2),
      ),
    ).rejects.toThrow(/incomplete download/);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it("rejects when the server sends more than it promised", async () => {
    const dest = path.join(tmpDir, "long.csv.gz");
    const body = "extra bytes here";
    await expect(
      downloadToFile("https://example.test/x.gz", dest, undefined, stubGet(body, 4)),
    ).rejects.toThrow(/incomplete download/);
    await expect(fs.stat(dest)).rejects.toThrow();
  });
});
