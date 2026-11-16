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

const REMOVED = ["ipapi-co", "freeipapi", "iplocate", "ipinfo"];

describe("the ingest provider catalog", () => {
  it("no longer lists the two providers that never answered", () => {
    for (const name of REMOVED) {
      expect(KNOWN_PROVIDERS, `${name} should be gone`).not.toContain(name);
    }
  });

  it("keeps the three that answer without a key", () => {
    for (const name of ["ip-api", "ip-sb", "ip9"]) {
      expect(KNOWN_PROVIDERS).toContain(name);
    }
    expect(KNOWN_PROVIDERS).toHaveLength(3);
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
    expect(providerDisplayName("ip-sb")).toBe("IP.SB");
    expect(providerDisplayName("ip9")).toBe("IP9.COM.CN");
  });
});

describe("the enforced-limit label", () => {
  // Imported here rather than at the top so the file's earlier assertions
  // stay readable.
  it("is omitted for a provider with no published per-minute figure", async () => {
    const { enforcedRateLimitLabel } = await import("../../src/storage/ingestProviders");
    // Nothing in the catalog goes unthrottled today, but the helper has to
    // answer for a custom provider too — and "no limit" must not be printed.
    expect(enforcedRateLimitLabel("a-custom-provider")).toBeNull();
    expect(enforcedRateLimitLabel("something-custom")).toBeNull();
  });

  it("names the figure the code obeys", async () => {
    const { enforcedRateLimitLabel } = await import("../../src/storage/ingestProviders");
    expect(enforcedRateLimitLabel("ip-sb")).toBe("程序限流：100 次/分钟，突发 5 次/秒");
    expect(enforcedRateLimitLabel("ip9")).toBe("程序限流：60 次/分钟");
    expect(enforcedRateLimitLabel("ip-api")).toBe("程序限流：45 次/分钟");
  });
});
