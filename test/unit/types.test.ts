import { describe, it, expect } from "vitest";
import type { Source, NormalizedRecord, LookupResult, EtlRun } from "../../src/types";

describe("types", () => {
  it("Source covers the labels the pipeline writes, plus 'unknown'", () => {
    // Six labels the ETL writes, three that name a human rather than a
    // file ('multi-provider' from the backfill, 'import' from the
    // range importer, 'seed' from the demo loader), and one that names
    // no source at all: 'unknown', the answer for a row whose origin
    // was not recorded.
    //
    // The list used to include "maxmind" and "ipinfo" — labels of
    // sources this project never wired into the pipeline. A member of
    // this type is a claim about where data came from, so a member
    // nothing can produce is a claim the API cannot keep.
    const sources: Source[] = [
      "unknown",
      "dbip",
      "dbip-country",
      "dbip-asn",
      "metowolf-cn",
      "runishiwo-cn",
      "sapics-user",
      "multi-provider",
      "import",
      "seed",
    ];
    expect(sources).toHaveLength(10);
  });

  it("NormalizedRecord has 16-byte Buffer start/end", () => {
    const r: NormalizedRecord = {
      startIp: Buffer.alloc(16),
      endIp: Buffer.alloc(16),
      source: "dbip",
    };
    expect(r.startIp).toHaveLength(16);
    expect(r.endIp).toHaveLength(16);
  });

  it("LookupResult requires ip and etag", () => {
    const r: LookupResult = {
      ip: "8.8.8.8",
      country: { source: "dbip" },
      etag: "2026-08-12T02:00:00Z",
    };
    expect(r.ip).toBe("8.8.8.8");
  });

  it("EtlRun has required status enum", () => {
    const r: EtlRun = {
      startedAt: new Date(),
      status: "running",
    };
    expect(["running", "success", "failed"]).toContain(r.status);
  });
});
