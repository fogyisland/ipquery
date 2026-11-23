// SPDX-License-Identifier: MIT
//
// A source value read out of the database must be one the API can stand
// behind.
//
// The `ip_ranges` table's source columns are free-form text. The ETL
// writes six known labels into them, but the column predates the
// source tracking: rows inserted by hand, by an older build, or by a
// backfill carry whatever was there — including "maxmind" and "ipinfo",
// the two labels of sources this project never wired into the pipeline.
//
// Reading such a value as-is and casting it to the `Source` type makes
// the type a lie: the API would report "the data came from MaxMind" for
// a row the pipeline never touched. Normalizing at the read boundary
// keeps the promise honest — an unrecognized label becomes "unknown",
// which is what it is.
//
// This is a unit test on purpose: the normalization is a pure function
// of a string, and it has to hold without a database.
import { describe, it, expect } from "vitest";
import { normalizeSource } from "../../src/storage/mysql";

describe("normalizeSource", () => {
  it("keeps a source the pipeline writes", () => {
    expect(normalizeSource("dbip")).toBe("dbip");
    expect(normalizeSource("dbip-country")).toBe("dbip-country");
    expect(normalizeSource("dbip-asn")).toBe("dbip-asn");
    expect(normalizeSource("metowolf-cn")).toBe("metowolf-cn");
    expect(normalizeSource("runishiwo-cn")).toBe("runishiwo-cn");
    expect(normalizeSource("sapics-user")).toBe("sapics-user");
  });

  it("keeps 'unknown' as itself", () => {
    expect(normalizeSource("unknown")).toBe("unknown");
  });

  it("keeps the manual tags a human-authored row carries", () => {
    // The unknown-IP backfill tags its findings 'multi-provider' and
    // the range importer tags its rows 'import'. Those tags are the
    // only record of who wrote a row, and the ETL's swap preserves
    // exactly the rows carrying them — so normalizing them away
    // erases the provenance and leaves the swap with nothing to key
    // on.
    expect(normalizeSource("multi-provider")).toBe("multi-provider");
    expect(normalizeSource("import")).toBe("import");
  });

  it("keeps the demo loader's 'seed' tag", () => {
    // The demo loader writes 'seed' on every row it adds, and
    // findRange() demotes a seed row below any real ETL row — the
    // ranking reads the raw column, but the API reports the row's
    // source, and "unknown" would be a false answer about a row
    // whose origin is recorded.
    //
    // 'seed' is deliberately NOT one of MANUAL_SOURCE_TAGS: a
    // refresh is supposed to replace the demo rows, so they are not
    // carried across the way the backfill's and the importer's rows
    // are. It still has to survive a read.
    expect(normalizeSource("seed")).toBe("seed");
  });

  it("turns a source the pipeline never wrote into 'unknown'", () => {
    // These are the labels of sources that were never wired in. A row
    // carrying one is a row from before the pipeline existed, and
    // reporting it as the source would be a false claim.
    expect(normalizeSource("maxmind")).toBe("unknown");
    expect(normalizeSource("ipinfo")).toBe("unknown");
  });

  it("turns an empty source into 'unknown'", () => {
    expect(normalizeSource(null)).toBe("unknown");
    expect(normalizeSource(undefined)).toBe("unknown");
    expect(normalizeSource("")).toBe("unknown");
  });

  it("turns a nonsense source into 'unknown'", () => {
    expect(normalizeSource("not-a-source")).toBe("unknown");
    expect(normalizeSource("DBIP")).toBe("unknown");
  });
});
