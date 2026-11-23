// SPDX-License-Identifier: MIT
//
// A cached DB-IP file must be replaced when DB-IP publishes a newer month.
//
// This is the bug that let the library sit on one month forever: the reuse
// decision was "the gzip on disk is intact", which stays true indefinitely.
// Every run after the first reported `skipped` and finished as success, so
// the freeze was invisible in the console. The month now lives in a sidecar
// next to the file and is compared against the newest release DB-IP
// actually publishes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as http from "node:http";
import * as https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  DEFAULT_SPECS,
  downloadAll,
  fetchOneWithAttempts,
  headRequest,
  isCacheCurrent,
  monthSidecarPath,
  probeNewestMonth,
  readMonthSidecar,
  takeDownloadAttempts,
  IDLE_TIMEOUT_MS,
} from "../../src/etl/download";

const CITY_CSV =
  "ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n9.9.9.0,9.9.9.255,EU,GB,England,London,51.5,-0.1\n";

/** A gzip member for the CSV fixture — what a real download produces. */
const CITY_GZ = zlib.gzipSync(Buffer.from(CITY_CSV));

function fakeRequest(): http.ClientRequest {
  const req = new EventEmitter() as EventEmitter & {
    setTimeout: (_ms: number, _cb: () => void) => void;
    destroy: (_err?: Error) => void;
  };
  req.setTimeout = () => undefined;
  req.destroy = () => undefined;
  return req as unknown as http.ClientRequest;
}

function fakeResponse(
  status: number,
  body: Buffer | null,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const res = Readable.from(body ? [body] : []) as unknown as http.IncomingMessage;
  (res as unknown as { statusCode: number }).statusCode = status;
  (res as unknown as { headers: Record<string, string> }).headers = headers;
  return res;
}

/**
 * One https stub standing in for DB-IP for both request kinds:
 *
 *  - a GET on a monthly file answers the fixture body;
 *  - a HEAD (what `headRequest` sends — it passes `method: "HEAD"` is NOT
 *    how this seam works: `probeNewestMonth` uses the same `getImpl`, and
 *    distinguishes itself by having no body) still has to answer by month.
 *
 * The seam is a single function, so the stub keys on the month in the URL
 * and serves `months` as published, everything else as 404 — which is what
 * DB-IP does for a release that is not out yet.
 */
function dbipStub(
  months: readonly string[],
  opts: { body?: Buffer | null; failNetwork?: boolean } = {},
): typeof https.get {
  return ((url: string, cb: (_res: http.IncomingMessage) => void) => {
    if (opts.failNetwork) throw new Error("ECONNRESET");
    const match = /-(\d{4}-\d{2})\.csv\.gz$/.exec(url);
    const month = match?.[1];
    const published = month !== undefined && months.includes(month);
    // `headRequest` drains the body without reading it, so answering a HEAD
    // with no body is fine; the GET path needs the bytes.
    const body = opts.body === undefined ? CITY_GZ : opts.body;
    const res = published
      ? fakeResponse(200, body, body ? { "content-length": String(body.length) } : {})
      : fakeResponse(404, null);
    setImmediate(() => cb(res));
    return fakeRequest();
  }) as unknown as typeof https.get;
}

const citySpec = DEFAULT_SPECS[0]!;

describe("month sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipq-month-"));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("is null until something records a month", async () => {
    expect(await readMonthSidecar(dir, citySpec.destName)).toBeNull();
  });

  it("ignores a garbage sidecar rather than trusting it", async () => {
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "yesterday\n");
    expect(await readMonthSidecar(dir, citySpec.destName)).toBeNull();
  });

  it("treats an unknown month as stale (refetch, never reuse blindly)", () => {
    expect(isCacheCurrent(null, "2026-11")).toBe(false);
  });

  it("treats a newer cached month as current (clock skew, a manual copy)", () => {
    expect(isCacheCurrent("2026-12", "2026-11")).toBe(true);
  });

  it("compares months, not strings", () => {
    expect(isCacheCurrent("2026-11", "2026-11")).toBe(true);
    expect(isCacheCurrent("2026-10", "2026-11")).toBe(false);
    expect(isCacheCurrent("2025-12", "2026-01")).toBe(false);
  });
});

describe("probeNewestMonth", () => {
  it("returns the newest month DB-IP actually publishes", async () => {
    // The calendar month is 2026-11, but only 2026-10 is published — the
    // current month's file appears a few days in.
    const newest = await probeNewestMonth(citySpec, new Date(Date.UTC(2026, 10, 2)), 6, (url) =>
      headRequest(url, dbipStub(["2026-10"])),
    );
    expect(newest).toBe("2026-10");
  });

  it("returns null when nothing in the window exists", async () => {
    const newest = await probeNewestMonth(citySpec, new Date(Date.UTC(2026, 10, 5)), 3, (url) =>
      headRequest(url, dbipStub([])),
    );
    expect(newest).toBeNull();
  });

  it("propagates a network failure instead of walking to an older month", async () => {
    await expect(
      probeNewestMonth(citySpec, new Date(Date.UTC(2026, 10, 5)), 6, (url) =>
        headRequest(url, dbipStub([], { failNetwork: true })),
      ),
    ).rejects.toThrow(/ECONNRESET/);
  });
});

describe("fetchOneWithAttempts cache decision", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipq-cache-"));
    takeDownloadAttempts(); // clear the accumulator between cases
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("reuses the cached file when its month is the newest release", async () => {
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-11\n");
    const result = await fetchOneWithAttempts(
      citySpec,
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      6,
      undefined,
      dbipStub(["2026-11"]),
    );
    expect(result.reused).toBe(true);
    expect(result.month).toBe("2026-11");
    // Nothing was fetched, so no temp files were left behind.
    expect((await fs.promises.readdir(dir)).filter((n) => n.includes(".part-"))).toEqual([]);
    const attempts = takeDownloadAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("skipped");
    expect(attempts[0]!.month).toBe("2026-11");
  });

  it("downloads the newer release when the cache is a month behind", async () => {
    // The core regression: a valid gzip from October must NOT be reused in
    // November just because it still decompresses.
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-10\n");
    const result = await fetchOneWithAttempts(
      citySpec,
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      6,
      undefined,
      dbipStub(["2026-11"]),
    );
    expect(result.reused).toBeUndefined();
    expect(result.month).toBe("2026-11");
    expect(await readMonthSidecar(dir, citySpec.destName)).toBe("2026-11");
    expect(takeDownloadAttempts().map((a) => a.status)).toEqual(["success"]);
  });

  it("refreshes a file with no sidecar at all (install predating this)", async () => {
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    const result = await fetchOneWithAttempts(
      citySpec,
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      6,
      undefined,
      dbipStub(["2026-11"]),
    );
    expect(result.month).toBe("2026-11");
    expect(await readMonthSidecar(dir, citySpec.destName)).toBe("2026-11");
    takeDownloadAttempts();
  });

  it("re-downloads when the sidecar says current but the file is truncated", async () => {
    const truncated = CITY_GZ.subarray(0, Math.floor(CITY_GZ.length / 2));
    await fs.promises.writeFile(path.join(dir, citySpec.destName), truncated);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-11\n");
    const result = await fetchOneWithAttempts(
      citySpec,
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      6,
      undefined,
      dbipStub(["2026-11"]),
    );
    expect(result.reused).toBeUndefined();
    const onDisk = await fs.promises.readFile(path.join(dir, citySpec.destName));
    expect(onDisk.length).toBe(CITY_GZ.length);
    expect(await readMonthSidecar(dir, citySpec.destName)).toBe("2026-11");
    takeDownloadAttempts();
  });

  it("keeps the previous cache when the new download fails", async () => {
    // A failed refresh must leave the old month usable rather than a
    // half-written file in the canonical path.
    const previous = CITY_GZ;
    await fs.promises.writeFile(path.join(dir, citySpec.destName), previous);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-10\n");
    // Publish 2026-11 for HEAD, but serve a body shorter than its
    // Content-Length for the GET — the interrupted-transfer case.
    const broken = zlib.gzipSync(Buffer.from(CITY_CSV)).subarray(0, 20);
    const stub = ((url: string, cb: (_res: http.IncomingMessage) => void) => {
      const published = url.includes("2026-11");
      const res = published
        ? fakeResponse(200, broken, { "content-length": String(CITY_GZ.length) })
        : fakeResponse(404, null);
      setImmediate(() => cb(res));
      return fakeRequest();
    }) as unknown as typeof https.get;
    await expect(
      fetchOneWithAttempts(citySpec, dir, new Date(Date.UTC(2026, 10, 20)), 6, undefined, stub),
    ).rejects.toThrow(/incomplete download/);
    expect((await fs.promises.readFile(path.join(dir, citySpec.destName))).length).toBe(previous.length);
    expect(await readMonthSidecar(dir, citySpec.destName)).toBe("2026-10");
    expect(
      (await fs.promises.readdir(dir)).filter((n) => n.includes(".part-") || n.includes(".bak-")),
    ).toEqual([]);
    takeDownloadAttempts();
  });

  it("fails rather than reusing a cache when no release is reachable", async () => {
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-09\n");
    await expect(
      fetchOneWithAttempts(citySpec, dir, new Date(Date.UTC(2026, 10, 20)), 2, undefined, dbipStub([])),
    ).rejects.toThrow(/no city release/);
    // The old cache is untouched, so the next successful run can still use it
    // as a fallback at the pipeline level.
    expect(await readMonthSidecar(dir, citySpec.destName)).toBe("2026-09");
    takeDownloadAttempts();
  });
});

describe("downloadAll with a stale monthly cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipq-dlall-"));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
    takeDownloadAttempts();
  });

  it("reports the new month and records one success attempt", async () => {
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-10\n");
    const { results, attempts } = await downloadAll(
      [citySpec],
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      undefined,
      dbipStub(["2026-11"]),
    );
    expect(results[0]!.month).toBe("2026-11");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("success");
    expect(attempts[0]!.month).toBe("2026-11");
  });

  it("keeps the skipped row (with its month) when the cache is current", async () => {
    await fs.promises.writeFile(path.join(dir, citySpec.destName), CITY_GZ);
    await fs.promises.writeFile(monthSidecarPath(dir, citySpec.destName), "2026-11\n");
    const { attempts } = await downloadAll(
      [citySpec],
      dir,
      new Date(Date.UTC(2026, 10, 20)),
      undefined,
      dbipStub(["2026-11"]),
    );
    // The month is recorded, so the run-detail page can say WHICH release
    // is live — it used to be null for every reused file.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("skipped");
    expect(attempts[0]!.month).toBe("2026-11");
  });
});

describe("download timeout", () => {
  it("is an idle budget, not a cap on total transfer time", () => {
    // 82 MB at 1.29 MB/s takes ~66 s; the old fixed 120 s cap had no
    // headroom for a slow start. The value is an inactivity window, so
    // it can be generous without letting a dead socket hang forever.
    expect(IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(IDLE_TIMEOUT_MS).toBeLessThan(600_000);
  });
});
