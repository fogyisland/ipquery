// SPDX-License-Identifier: MIT
//
// The landing page's headline names a number of data sources. The stat
// right below it names the same number, but the second one is computed
// from the pipeline while the first is a hand-written string in the
// i18n dictionary.
//
// They drifted. The pipeline fetches seven files from four upstreams
// (DB-IP contributes three files), and the stat renders "4" — but the
// headline still said "一个查询,三个数据源" / "One query, three
// sources". A visitor reading the same page sees a headline claiming
// three and a badge claiming four, and neither number is trustworthy.
//
// The fix cannot be "trust the copy": the copy is the thing that
// drifts. It has to be derived. This test reads the headline out of
// each locale and checks its number against etlUpstreamCount(), so the
// day a fifth upstream lands, this fails rather than the page.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { etlUpstreamCount } from "../../src/etl/sources/labels";

const root = path.resolve(__dirname, "..", "..");

function readLocale(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(root, "src", "web", "i18n", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/** The `home.features.title` string, read through a fixed path. */
function featuresTitle(locale: string): string {
  const doc = readLocale(locale);
  const home = doc.home as Record<string, unknown>;
  const features = home.features as Record<string, unknown>;
  return String(features.title);
}

describe("The landing page's source-count headline", () => {
  it("names the same number of sources the pipeline actually fetches", () => {
    const expected = etlUpstreamCount();
    expect(expected).toBeGreaterThan(0);

    // The Chinese headline embeds the number as a Chinese numeral
    // ("三个数据源"), so the numeral is looked up by value rather than
    // parsed out of the string.
    const CN_NUMERALS: Record<number, string> = {
      2: "两",
      3: "三",
      4: "四",
      5: "五",
      6: "六",
      7: "七",
      8: "八",
      9: "九",
      10: "十",
    };
    const zh = featuresTitle("zh-CN");
    const zhNumeral = CN_NUMERALS[expected];
    expect(
      zhNumeral,
      `no Chinese numeral is mapped for ${expected} sources — extend CN_NUMERALS`,
    ).toBeDefined();
    expect(
      zh,
      `the zh-CN headline does not name ${expected} sources: ${JSON.stringify(zh)}`,
    ).toContain(`${zhNumeral}个数据源`);

    // The English headline spells the number out.
    const EN_NUMERALS: Record<number, string> = {
      2: "two",
      3: "three",
      4: "four",
      5: "five",
      6: "six",
      7: "seven",
      8: "eight",
      9: "nine",
      10: "ten",
    };
    const enNumeral = EN_NUMERALS[expected];
    expect(
      enNumeral,
      `no English numeral is mapped for ${expected} sources — extend EN_NUMERALS`,
    ).toBeDefined();
    const en = featuresTitle("en-US");
    expect(
      en,
      `the en-US headline does not name ${expected} sources: ${JSON.stringify(en)}`,
    ).toContain(`${enNumeral} sources`);
  });
});
