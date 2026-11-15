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
  ALL_SPECS,
  candidateMonths,
  DEFAULT_SPECS,
  downloadAll,
  downloadToFile,
  EXTRA_SPECS,
  fetchFixedOneWithAttempts,
  parseDownloadKinds,
  replaceWithValidatedTemp,
  validateGzFile,
  validateTextFile,
  type FixedSpec,
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

describe("EXTRA_SPECS", () => {
  it("EXTRA_SPECS pins the four fixed sources", () => {
    expect(EXTRA_SPECS.map((s) => [s.kind, s.destName, s.etlSource, s.format])).toEqual([
      ["metowolf-cn", "china-ipv4.txt", "metowolf-cn", "cidr"],
      ["runishiwo-cn", "china-v4.txt", "runishiwo-cn", "cidr"],
      ["runishiwo-v6", "china-v6.txt", "runishiwo-v6", "cidr"],
      ["sapics-user", "sapics-user-country.csv", "sapics-user", "country-csv"],
    ]);
    expect(EXTRA_SPECS.map((s) => s.urls)).toEqual([
      [
        "https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt",
        "https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/special/china.txt",
      ],
      [
        "https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v4.txt",
        "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v4.txt",
      ],
      [
        "https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v6.txt",
        "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v6.txt",
      ],
      [
        "https://github.com/sapics/ip-location-db/releases/download/latest/user-country.csv",
        "https://cdn.jsdelivr.net/gh/sapics/ip-location-db@latest/user-country.csv",
      ],
    ]);
  });
});

describe("validateTextFile", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-text-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeText = async (name: string, body: string | Buffer): Promise<string> => {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, body);
    return filePath;
  };

  it("validateTextFile rejects empty, NUL, replacement char, HTML, comment-only and accepts a last line without newline", async () => {
    expect(await validateTextFile(await writeText("empty.txt", ""), "cidr")).toBeTruthy();
    expect(
      await validateTextFile(await writeText("nul.txt", Buffer.from("1.2.3.0/24\u0000\n")), "cidr"),
    ).toBeTruthy();
    expect(
      await validateTextFile(await writeText("replacement.txt", Buffer.from("�\n")), "cidr"),
    ).toBeTruthy();
    expect(
      await validateTextFile(await writeText("html.txt", "<!doctype html>\n"), "cidr"),
    ).toBeTruthy();
    expect(
      await validateTextFile(await writeText("comment-only.txt", "# only a comment\n"), "cidr"),
    ).toBeTruthy();
    expect(await validateTextFile(path.join(tmpDir, "missing.txt"), "cidr")).toBeTruthy();
    expect(
      await validateTextFile(await writeText("no-tail-newline.txt", "1.2.3.0/24\n4.5.6.0/24"), "cidr"),
    ).toBeNull();
    const countryCsv = "1.2.3.0,1.2.3.255,CN\n2001:db8::,2001:db8::ffff,CN";
    expect(await validateTextFile(await writeText("country.csv", countryCsv), "country-csv")).toBeNull();
    expect(
      await validateTextFile(
        await writeText("bad-country.csv", "not-an-ip,not-an-ip,CN\n"),
        "country-csv",
      ),
    ).toBeTruthy();
  });
});

describe("fixed URL refresh", () => {
  let tmpDir: string;
  const validCidr = "# CN IPv6 list\n2001:db8::/32\n";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-fixed-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const urlStub = (
    handlers: Readonly<Record<string, { status: number; body: string }>>,
  ): typeof https.get => {
    const impl = ((url: string, cb: (_res: http.IncomingMessage) => void) => {
      const handler = handlers[url] ?? { status: 500, body: "upstream failure" };
      const res = Readable.from([Buffer.from(handler.body)]) as unknown as http.IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = handler.status;
      (res as unknown as { headers: Record<string, string> }).headers = {
        "content-length": String(Buffer.byteLength(handler.body)),
      };
      setImmediate(() => cb(res));
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (_ms: number, _cb: () => void) => void;
        destroy: (_err?: Error) => void;
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      return req as unknown as http.ClientRequest;
    }) as unknown as typeof https.get;
    return impl;
  };

  const v6Spec = (): FixedSpec => ({ ...EXTRA_SPECS[2]! });

  it("primary 500 falls back to the jsDelivr mirror", async () => {
    const spec = v6Spec();
    const mirror = spec.urls[1]!;
    const result = await fetchFixedOneWithAttempts(
      spec,
      tmpDir,
      undefined,
      urlStub({ [mirror]: { status: 200, body: validCidr } }),
    );
    expect(result.month).toBeNull();
    expect(result.url).toBe(mirror);
    expect(result.etlSource).toBe("runishiwo-v6");
    expect(await fs.readFile(path.join(tmpDir, spec.destName), "utf8")).toBe(validCidr);
  });

  it("fixed refresh keeps the previous cache intact and cleans every temp file", async () => {
    const spec = { ...v6Spec(), destName: "cache-intact.txt" };
    const destPath = path.join(tmpDir, spec.destName);
    const previous = "# previous complete cache\n2001:db8::/48\n";
    await fs.writeFile(destPath, previous);
    const primary = "https://primary.example.test/failure";
    const mirror = "https://mirror.example.test/failure";
    spec.urls = [primary, mirror];
    const { results, failures, attempts } = await downloadAll(
      [spec],
      tmpDir,
      new Date("2026-11-15T00:00:00Z"),
      undefined,
      urlStub({
        [primary]: { status: 500, body: "primary down" },
        [mirror]: { status: 500, body: "mirror down" },
      }),
    );
    expect(results).toEqual([]);
    expect(await fs.readFile(destPath, "utf8")).toBe(previous);
    expect((await fs.readdir(tmpDir)).filter((name) => name.includes("cache-intact.txt."))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.urls).toEqual([primary, mirror]);
    expect(failures[0]!.attemptCount).toBe(2);
    expect(failures[0]!.etlSource).toBe("runishiwo-v6");
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true);
    const failureMessage = failures[0]!.message;
    expect(failureMessage).toContain(primary);
    expect(failureMessage).toContain(mirror);
    expect(failureMessage).toContain("刷新失败、复用旧缓存");
    await fs.rm(destPath);
  });

  it("mirror HTML error page leaves the previous cache intact", async () => {
    const spec = { ...v6Spec(), destName: "html-cache.txt" };
    const destPath = path.join(tmpDir, spec.destName);
    const previous = "2001:db8::/32\n";
    await fs.writeFile(destPath, previous);
    const mirror = spec.urls[1]!;
    await expect(
      fetchFixedOneWithAttempts(
        spec,
        tmpDir,
        undefined,
        urlStub({ [mirror]: { status: 200, body: "<!doctype html><h1>502</h1>" } }),
      ),
    ).rejects.toThrow(mirror);
    expect(await fs.readFile(destPath, "utf8")).toBe(previous);
    expect((await fs.readdir(tmpDir)).filter((name) => name.includes("html-cache.txt."))).toEqual([]);
    await fs.rm(destPath);
  });

  it("replaceWithValidatedTemp renames back when the second rename throws", async () => {
    const destPath = path.join(tmpDir, "atomic.txt");
    const tmpPath = path.join(tmpDir, "atomic.txt.part");
    const backupPath = path.join(tmpDir, "atomic.txt.bak");
    await fs.writeFile(destPath, "old");
    await fs.writeFile(tmpPath, "new");
    let callCount = 0;
    const failingSecondRename = (async (from: string, to: string) => {
      callCount += 1;
      if (callCount === 2) throw new Error("simulated rename failure");
      await fs.rename(from, to);
    }) as typeof fs.rename;
    await expect(
      replaceWithValidatedTemp(destPath, tmpPath, backupPath, failingSecondRename, fs.rm),
    ).rejects.toThrow("simulated rename failure");
    expect(await fs.readFile(destPath, "utf8")).toBe("old");
    await expect(fs.stat(tmpPath)).rejects.toThrow();
    await expect(fs.stat(backupPath)).rejects.toThrow();
    await fs.rm(destPath);
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
    const impl = ((url: string, cb: (_res: http.IncomingMessage) => void) => {
      const res = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = 200;
      (res as unknown as { headers: Record<string, string> }).headers = {
        "content-length": String(advertisedLength),
      };
      setImmediate(() => cb(res));
      // downloadToFile only needs `on` and `setTimeout` on the request.
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (_ms: number, _cb: () => void) => void;
        destroy: (_err?: Error) => void;
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

describe("downloadToFile redirect handling", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ipquery-redir-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A stub client that answers the FIRST request with a redirect to
   *  `location`, and any follow-up request with `body`. */
  const redirectGet = (
    location: string,
    body: string,
  ): { impl: typeof https.get; targets: string[] } => {
    const targets: string[] = [];
    const impl = ((url: string, cb: (_res: http.IncomingMessage) => void) => {
      targets.push(url);
      const isFirst = targets.length === 1;
      const res = Readable.from([Buffer.from(isFirst ? "" : body)]) as unknown as http.IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = isFirst ? 302 : 200;
      (res as unknown as { headers: Record<string, string> }).headers = isFirst
        ? { location }
        : { "content-length": String(body.length) };
      setImmediate(() => cb(res));
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (_ms: number, _cb: () => void) => void;
        destroy: (_err?: Error) => void;
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      return req as unknown as http.ClientRequest;
    }) as unknown as typeof https.get;
    return { impl, targets };
  };

  it("follows an https redirect and writes the body", async () => {
    const dest = path.join(tmpDir, "followed.csv.gz");
    const body = "redirected body";
    const { impl, targets } = redirectGet("https://cdn.example.test/x.gz", body);
    const bytes = await downloadToFile("https://example.test/x.gz", dest, undefined, impl);
    expect(bytes).toBe(body.length);
    expect(await fs.readFile(dest, "utf-8")).toBe(body);
    expect(targets).toEqual(["https://example.test/x.gz", "https://cdn.example.test/x.gz"]);
  });

  it("refuses to follow a redirect to plain http", async () => {
    // The redirect target comes from the server. A hostile or
    // compromised upstream could point it at http:// (downgrading the
    // transfer to plaintext) or at an internal address. We only
    // follow https.
    const dest = path.join(tmpDir, "downgrade.csv.gz");
    const { impl, targets } = redirectGet("http://cdn.example.test/x.gz", "should not arrive");
    await expect(
      downloadToFile("https://example.test/x.gz", dest, undefined, impl),
    ).rejects.toThrow(/non-https redirect/);
    // The redirect was NOT followed.
    expect(targets).toEqual(["https://example.test/x.gz"]);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it("resolves a relative redirect against the current URL", async () => {
    const dest = path.join(tmpDir, "relative.csv.gz");
    const body = "relative body";
    const { impl, targets } = redirectGet("/moved/x.gz", body);
    await downloadToFile("https://example.test/deep/start.gz", dest, undefined, impl);
    expect(targets[1]).toBe("https://example.test/moved/x.gz");
  });
});
