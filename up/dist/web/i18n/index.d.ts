export type Locale = "zh-CN" | "en-US";
export declare const SUPPORTED_LOCALES: Locale[];
export declare const DEFAULT_LOCALE: Locale;
export declare function t(locale: Locale, key: string, vars?: Record<string, string | number>): string;
export declare function parseLocale(raw: string | undefined): Locale;
