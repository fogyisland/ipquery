// SPDX-License-Identifier: MIT
//
// Unit tests for the ISO 3166-1 country / region name table.
//
// The table exists because `ip_ranges.country_name` is NULL for every
// ETL-loaded row: DB-IP's free CSVs carry a country *code* only, and
// MaxMind — the source that could fill the name — never runs through the
// pipeline. Without this table a Hong Kong address answers "HK" under a
// heading that says "国家" (country).
import { describe, it, expect } from "vitest";
import {
  countryNamesFor,
  chineseCountryName,
  englishCountryName,
  knownCountryCodes,
} from "../../src/country-names";

describe("countryNamesFor", () => {
  it("names the regions that the address data gives their own codes", () => {
    // The case that started this: Hong Kong has its own ISO code, so it
    // must never be reported as part of China — or as a "country".
    expect(countryNamesFor("HK")).toEqual({ en: "Hong Kong", zh: "香港" });
    expect(countryNamesFor("MO")).toEqual({ en: "Macao", zh: "澳门" });
    expect(countryNamesFor("TW")).toEqual({ en: "Taiwan", zh: "台湾" });
  });

  it("covers the common sovereign states", () => {
    expect(countryNamesFor("US")).toEqual({ en: "United States", zh: "美国" });
    expect(countryNamesFor("CN")).toEqual({ en: "China", zh: "中国" });
    expect(countryNamesFor("JP")).toEqual({ en: "Japan", zh: "日本" });
    expect(countryNamesFor("DE")).toEqual({ en: "Germany", zh: "德国" });
  });

  it("matches the code case-insensitively", () => {
    // Data sources are inconsistent about case; a stray lowercase must
    // not silently lose the name.
    expect(countryNamesFor("hk")).toEqual(countryNamesFor("HK"));
    expect(countryNamesFor("hK")).toEqual(countryNamesFor("HK"));
  });

  it("tolerates surrounding whitespace", () => {
    expect(countryNamesFor(" HK ")).toEqual(countryNamesFor("HK"));
  });

  it("returns null for an unknown or malformed code", () => {
    // Inventing a name for a code we don't recognise would be worse
    // than admitting we don't have one.
    expect(countryNamesFor("ZZ")).toBeNull();
    expect(countryNamesFor("X")).toBeNull();
    expect(countryNamesFor("USA")).toBeNull();
    expect(countryNamesFor("")).toBeNull();
    expect(countryNamesFor(null)).toBeNull();
    expect(countryNamesFor(undefined)).toBeNull();
  });
});

describe("englishCountryName / chineseCountryName", () => {
  it("returns the single-language name", () => {
    expect(englishCountryName("HK")).toBe("Hong Kong");
    expect(chineseCountryName("HK")).toBe("香港");
  });

  it("returns null for an unknown code in either language", () => {
    expect(englishCountryName("ZZ")).toBeNull();
    expect(chineseCountryName("ZZ")).toBeNull();
  });
});

describe("the table itself", () => {
  it("covers every officially assigned ISO 3166-1 alpha-2 code", () => {
    // 249 officially assigned codes. A count above that means a
    // user-assigned code crept in; below means one is missing.
    const codes = knownCountryCodes();
    expect(codes).toHaveLength(249);
  });

  it("has unique, well-formed codes", () => {
    const codes = knownCountryCodes();
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("gives every code a name in both languages", () => {
    for (const code of knownCountryCodes()) {
      const names = countryNamesFor(code);
      expect(names, `missing entry for ${code}`).not.toBeNull();
      expect(names!.en.length).toBeGreaterThan(0);
      expect(names!.zh.length).toBeGreaterThan(0);
      // A name that is just the code back is not a name.
      expect(names!.en).not.toBe(code);
      expect(names!.zh).not.toBe(code);
    }
  });
});
