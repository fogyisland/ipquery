/** A country's display names. */
export interface CountryNames {
    /** English name — what the JSON API returns. */
    en: string;
    /** Simplified Chinese name — what the Chinese UI shows. */
    zh: string;
}
/**
 * Look up a country / region by its ISO 3166-1 alpha-2 code.
 *
 * Returns null for an unknown or malformed code. Callers decide what to
 * show then — the raw code is still better than nothing, but the caller
 * should own that choice, not this function.
 *
 * The code is matched case-insensitively because data sources are
 * inconsistent about it: DB-IP emits "HK", some APIs emit "hk", and a
 * stray lowercase would otherwise silently lose the name.
 */
export declare function countryNamesFor(code: string | null | undefined): CountryNames | null;
/**
 * The English name for a country code, or null when the code is unknown.
 *
 * This is what the JSON API returns: an API that answers `"name": null`
 * for every country has a field that carries no information.
 */
export declare function englishCountryName(code: string | null | undefined): string | null;
/**
 * The Simplified Chinese name for a country code, or null when unknown.
 */
export declare function chineseCountryName(code: string | null | undefined): string | null;
/** Every known country code, for diagnostics and tests. */
export declare function knownCountryCodes(): string[];
