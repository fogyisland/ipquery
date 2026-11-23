// SPDX-License-Identifier: MIT
//
// The marketing copy must not advertise a data source that does not run.
//
// For months the landing page said the service aggregates "MaxMind,
// ip2region and DB-IP" — three sources, with a field-complementarity
// argument built on top of it. The truth was one: the ETL pipeline
// fetched and parsed exactly one family of files. A query of the live
// table's `country_source` column came back with `dbip` and
// `dbip-country` and nothing else — not one row from MaxMind, not one
// from ip2region, and (at the time the copy was written) not one from
// the GitHub-hosted lists either.
//
// A public claim that the code does not support is worse than no claim
// at all: an operator reads the landing page, believes there are three
// independent sources behind a row, and concludes the data is more
// corroborated than it is.
//
// These tests read the i18n files and check that no source is named
// that the pipeline does not run. They are unit tests — the copy is a
// fact about the repository, not about a running server.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");

function readLocale(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(root, "src", "web", "i18n", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/** Every string in a nested object, flattened. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

describe("The marketing copy about data sources", () => {
  it("names no source the pipeline does not run", async () => {
    // The sources the copy may name: the ones the pipeline parses.
    // "dbip" appears under several ETL labels (dbip-city, dbip-country,
    // dbip-asn) and the row-level source of those files is "dbip" or
    // "dbip-country" — so a mention of the DB-IP family is allowed
    // under any of those names.
    //
    // Two mentions of MaxMind are legitimate and are excluded: the
    // settings label for the MaxMind license key (the config option
    // really does exist — it is simply not a data source today), and
    // the 2024 timeline entry, which describes what the project's
    // first commit actually was.
    for (const locale of ["en-US", "zh-CN"]) {
      const strings = collectStrings(readLocale(locale));
      for (const string of strings) {
        for (const claimed of ["ip2region", "MaxMind", "maxmind"]) {
          if (!string.includes(claimed)) continue;
          const legitimate =
            // The settings label for the license key field.
            string === "MaxMind" ||
            // The historical timeline entry about the first commit.
            string.includes("MaxMind-only loader") ||
            string.includes("MaxMind 单源加载器");
          expect(
            legitimate,
            `${locale} advertises ${claimed}: ${JSON.stringify(string)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("names the sources the pipeline does run", () => {
    // The copy should not be emptied out to satisfy the check above —
    // it still has to say where the data comes from.
    const strings = collectStrings(readLocale("en-US")).join("\n");
    expect(strings).toMatch(/DB-IP/);
  });

  it("claims no source the pipeline does not run in the page templates", () => {
    // The templates carry two more claims the dictionary does not:
    // the marketing layout's meta description ("aggregating MaxMind,
    // ip2region, and DB-IP. One query, three sources") and the docs
    // page's sample response, which shows `"source": "maxmind"` four
    // times. The API has never returned "maxmind" for a row it did
    // not fall back to — the real value is "dbip".
    //
    // A sample response is a contract: a reader copies it and expects
    // the shape and the values to be what comes back.
    const views = ["layouts/marketing.hbs", "marketing/docs.hbs"];
    for (const view of views) {
      const text = fs.readFileSync(path.join(root, "src", "web", "views", view), "utf8");
      expect(text, `${view} mentions ip2region`).not.toMatch(/ip2region/i);
      expect(text, `${view} mentions MaxMind`).not.toMatch(/maxmind/i);
    }
  });

  it("shows a source the API actually returns in the sample response", () => {
    // The docs sample must name a source the pipeline fills rows with.
    const text = fs.readFileSync(
      path.join(root, "src", "web", "views", "marketing", "docs.hbs"),
      "utf8",
    );
    expect(text).toMatch(/"dbip"/);
  });
});
