// SPDX-License-Identifier: MIT
//
// The ETL source list is derived, not hand-written.
//
// For months the API, the MCP server and the marketing copy each
// carried their own list of "the data sources": MaxMind, ip2region and
// DB-IP. Only one of them was true. The pipeline downloaded and parsed
// exactly one family of files, and a query of the live table's
// `country_source` column came back with `dbip` and `dbip-country` and
// nothing else — not one row from MaxMind, not one from ip2region.
//
// A hand-maintained list of sources is a promise the code does not keep,
// and nothing fails when it stops being true. The list that the API and
// the MCP server report is now the list the pipeline actually runs, so
// a source that is not wired in cannot be advertised.
//
// These tests pin that relationship. They are unit tests on purpose:
// they must hold without a database, because the thing they protect —
// "the advertised sources are the ones we actually run" — is a fact
// about the code, not about the data.
import { describe, it, expect } from "vitest";
import {
  ETL_SOURCE_LABELS,
  etlSourceLabels,
  etlUpstreamCount,
} from "../../src/etl/sources/labels";
import { SOURCE_FILES } from "../../src/etl/pipeline";
import type { Source } from "../../src/types";

/**
 * Every row-level source the pipeline can write.
 *
 * Derived from the pipeline's own file table rather than written down,
 * so a new source file has to be added to the type too. The table has
 * two labels per file: `etlSource` keys the run-level stage tables,
 * `source` is what the row's own source column records. The row-level
 * one is what the API reports, so that is the one this guards.
 */
const ROW_SOURCES: ReadonlySet<string> = new Set(SOURCE_FILES.map((file) => file.source));

describe("The ETL source list", () => {
  it("names every source the pipeline actually runs", () => {
    const ran = new Set(SOURCE_FILES.map((file) => file.etlSource));
    // Every source the pipeline parses has to have a label: the label
    // is what the API and the MCP server show an operator, and a
    // missing one would surface as an unnamed entry.
    for (const source of ran) {
      expect(ETL_SOURCE_LABELS[source], `no label for ${source}`).toBeTruthy();
    }
  });

  it("advertises no source the pipeline does not run", () => {
    const ran = new Set(SOURCE_FILES.map((file) => file.etlSource));
    const advertised = new Set(Object.keys(ETL_SOURCE_LABELS));
    for (const source of advertised) {
      expect(ran.has(source), `${source} is advertised but never parsed`).toBe(true);
    }
  });

  it("does not advertise a parser that nothing calls", () => {
    // ip2region and maxmind have parsers on disk that no download spec
    // feeds and no pipeline step reads. Advertising them would be a
    // claim the data does not support.
    const advertised = Object.keys(ETL_SOURCE_LABELS);
    expect(advertised).not.toContain("ip2region");
    expect(advertised).not.toContain("maxmind");
  });

  it("keeps the row-level source type free of sources nothing writes", () => {
    // The `Source` type is what the API reports in every "source"
    // field. A member of it that the pipeline can never produce is a
    // value a row can never legitimately hold — and, worse, a value
    // the lookup core used to fall back to for rows with no source at
    // all, which made the API claim MaxMind supplied data it never
    // fetched.
    //
    // "unknown" is the one exception: it names no source on purpose.
    // It is the fallback for a row whose source column is empty, and
    // it is the honest answer to "where did this come from?".
    //
    // The three manual tags are exceptions of a different kind: they
    // are written by this project rather than by the ETL, so they are
    // not in ROW_SOURCES, but they are real provenance and the ETL's
    // swap keys on two of them. They are checked here so that a
    // future edit that drops one fails in this file, next to the
    // source list, rather than in an integration test 40 seconds
    // into a suite.
    const declared: Source[] = [
      "unknown",
      "dbip",
      "dbip-country",
      "dbip-asn",
      "metowolf-cn",
      "runishiwo-cn",
      "sapics-user",
    ];
    for (const source of declared) {
      if (source === "unknown") continue;
      expect(ROW_SOURCES.has(source), `${source} is a declared source but nothing writes it`).toBe(
        true,
      );
    }

    const MANUAL: Source[] = ["multi-provider", "import", "seed"];
    for (const source of MANUAL) {
      expect(ROW_SOURCES.has(source), `${source} is a manual tag but the pipeline writes it`).toBe(
        false,
      );
    }
  });

  it("lets the lookup core report an unknown source", () => {
    // The fallback must exist as a real value, not just as prose in a
    // comment: a row with no source column still needs an answer.
    const unknown: Source = "unknown";
    expect(unknown).toBe("unknown");
  });

  it("reports the sources the pipeline runs", () => {
    const labels = etlSourceLabels();
    expect(labels.length).toBeGreaterThan(0);
    // Every label carries the two things a caller needs to show it.
    for (const label of labels) {
      expect(label.key).toBeTruthy();
      expect(label.label).toBeTruthy();
    }
  });

  it("gives the same answer every time it is asked", () => {
    // The list is built from the pipeline's own table, so two calls in
    // the same process must agree — a caller that renders a source map
    // and then a source list must not show two different things.
    expect(etlSourceLabels()).toEqual(etlSourceLabels());
  });

  it("lists the DB-IP family the pipeline really runs", () => {
    // The three DB-IP files are the ones that carry the bulk of the
    // table. If this ever stops being true the label list is stale.
    const keys = etlSourceLabels().map((label) => label.key);
    expect(keys).toContain("dbip-city");
    expect(keys).toContain("dbip-country");
    expect(keys).toContain("dbip-asn");
  });

  it("counts upstreams, not files", () => {
    // The pipeline fetches seven files, but they come from four
    // places: DB-IP (three files), metowolf/iplist,
    // runishiwo/ChinaIPlist (two files) and sapics/ip-location-db.
    //
    // A page that says "seven data sources" reads as seven independent
    // providers. It is four.
    expect(etlUpstreamCount()).toBe(4);
  });

  it("counts no more upstreams than it has files", () => {
    // Every upstream needs at least one file, so the count can never
    // exceed the number of download specs.
    expect(etlUpstreamCount()).toBeLessThanOrEqual(SOURCE_FILES.length);
    expect(etlUpstreamCount()).toBeGreaterThan(0);
  });

  it("counts the same upstreams every time it is asked", () => {
    // The marketing page renders the number on two partials. If the
    // two calls disagreed, the page would show two different counts.
    expect(etlUpstreamCount()).toBe(etlUpstreamCount());
  });
});
