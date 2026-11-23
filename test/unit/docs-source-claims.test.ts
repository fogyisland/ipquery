// SPDX-License-Identifier: MIT
//
// The repository's own documentation must not advertise a data source
// the ETL pipeline does not run.
//
// This is the same claim the landing page used to make, in a place an
// operator actually reads: the README. It said the service aggregates
// "MaxMind GeoLite2, ip2region, and DB-IP", listed ip2region in the
// license table, and told the reader to go get a MaxMind license key
// before the quick start would work. None of that was true. The
// pipeline fetched DB-IP and open range lists; the MaxMind and
// ip2region parsers existed on disk and were called by nothing.
//
// A README that overstates the data sources sends an operator down a
// license-signup detour and then past a licence table that lists
// software the repository does not ship. It is also the file most
// likely to be quoted in a procurement conversation.
//
// The two legitimate MaxMind mentions are excluded, because both are
// facts about the configuration rather than claims about the data:
// the settings label for the license key (the config option really
// does exist — it is simply not a data source today) and the
// historical timeline entry, which describes what the project's first
// commit actually was.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");

/** The documentation files a reader reads before deploying. */
const DOCS = [
  "README.md",
  "NOTICE",
  "docs/setup.md",
  "docs/source-deploy.md",
  "docs/mcp.md",
  "up/README.md",
  "up/BAOTA.md",
];

/** The strings that are a fact about the config, not a claim about data. */
const LEGITIMATE_MAX_MIND_MENTIONS = [
  // The settings label for the license key field.
  "MaxMind",
  // The historical timeline entry about the first commit.
  "MaxMind-only loader",
  "MaxMind 单源加载器",
];

function readDoc(relativePath: string): string {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return "";
  return fs.readFileSync(absolute, "utf8");
}

/** True when the mention is a legitimate mention rather than a false claim. */
function isLegitimate(sentence: string): boolean {
  return LEGITIMATE_MAX_MIND_MENTIONS.some((allowed) => sentence.includes(allowed));
}

/** Split a document into the chunks a reader would call "a sentence". */
function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.。!！?？])\s+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("The repository documentation", () => {
  it("names no data source the pipeline does not run", () => {
    for (const doc of DOCS) {
      const text = readDoc(doc);
      if (text === "") continue;
      for (const sentence of sentences(text)) {
        for (const claimed of ["ip2region", "MaxMind", "maxmind"]) {
          if (!sentence.includes(claimed)) continue;
          expect(
            isLegitimate(sentence),
            `${doc} advertises ${claimed}: ${JSON.stringify(sentence)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("lists only the sources the pipeline runs in its license table", () => {
    // The license table is the load-bearing part: it tells an operator
    // which terms they are agreeing to. A row for software the
    // repository does not ship sends them to download a license for
    // nothing.
    const readme = readDoc("README.md");
    const tableLines = readme
      .split("\n")
      .filter((line) => line.trim().startsWith("|") && line.includes("]("));

    expect(tableLines.length).toBeGreaterThan(0);
    const tableText = tableLines.join("\n");
    expect(tableText).not.toContain("ip2region");
    expect(tableText).not.toContain("maxmind");
    expect(tableText).not.toContain("MaxMind");
    // The sources the pipeline does run are still listed.
    expect(tableText).toMatch(/DB-IP/i);
  });

  it("does not send the reader to sign up for a license it cannot use", () => {
    // The quick start used to open with "Get a free MaxMind license
    // key" — a step the pipeline does not need and the operator
    // cannot satisfy usefully, because the download is not wired in.
    const readme = readDoc("README.md");
    const quickStart = readme.split("## Quick start")[1]?.split("##")[0] ?? "";
    expect(quickStart).not.toContain("maxmind");
    expect(quickStart).not.toContain("MaxMind");
  });

  it("does not promise the parser work that was removed", () => {
    // The Limitations section listed "MaxMind parser uses a sparse-probe
    // MVP" and "ip2region parser reads the JSON-export form" as
    // pending work. Both parsers are gone; a limitation about a
    // removed parser is a limitation about nothing.
    const readme = readDoc("README.md");
    const limitations = readme.split("## Limitations")[1]?.split("##")[0] ?? "";
    expect(limitations).not.toContain("ip2region");
    expect(limitations).not.toContain("MaxMind");
  });

  it("still tells the reader where the data comes from", () => {
    // The check above must not be satisfiable by emptying the README.
    const readme = readDoc("README.md");
    expect(readme).toMatch(/DB-IP/);
  });
});