// SPDX-License-Identifier: MIT
// The provider catalog is the set of sources the backfill may vote with.
//
// Three of them were removed on 2026-11-16 — ipapi.co,
// freeipapi.com and iplocate.io. Against the addresses in this library
// their success rate was effectively zero, so every backfill round spent
// its votes on providers that never answered and the majority vote could
// not decide. What is left is the pair that actually responds.
//
// Removing them from the seed alone would not be enough: an existing
// install already has their rows, and `buildProvidersFromConfig` turns any
// enabled row into a live provider. The catalog below is the single list
// that both the seed and the factory agree on.
import { describe, it, expect } from "vitest";
import { KNOWN_PROVIDERS, providerDisplayName } from "../../src/storage/ingestProviders";

const REMOVED = ["ipapi-co", "freeipapi", "iplocate"];

describe("the ingest provider catalog", () => {
  it("no longer lists the two providers that never answered", () => {
    for (const name of REMOVED) {
      expect(KNOWN_PROVIDERS, `${name} should be gone`).not.toContain(name);
    }
  });

  it("keeps the two that do answer", () => {
    for (const name of ["ip-api", "ipinfo"]) {
      expect(KNOWN_PROVIDERS).toContain(name);
    }
    expect(KNOWN_PROVIDERS).toHaveLength(2);
  });

  it("has no display-name entry for a removed provider", () => {
    for (const name of REMOVED) {
      // The function must fall back to the raw name rather than resolving
      // a label for something the catalog no longer knows.
      expect(providerDisplayName(name)).toBe(name);
    }
  });

  it("still labels the providers it does know", () => {
    expect(providerDisplayName("ip-api")).toBe("IP-API");
    expect(providerDisplayName("ipinfo")).toBe("IPinfo.io");
  });
});
