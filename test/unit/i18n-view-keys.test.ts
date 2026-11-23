// SPDX-License-Identifier: MIT
//
// Every translation key a view or route asks for must exist in the
// dictionaries.
//
// A missing key is not a loud failure: t() returns the key itself, so the
// page renders "verify.success" or "dashboard.keys.revoke.confirm.title"
// where a sentence belongs. Nothing in the logs points at it, and the two
// places that hit it — the email-verification result and the revoke
// confirmation — are pages an operator rarely opens, so it survives review.
//
// The default locale is the fallback for every other locale, so its
// dictionary has to be complete. en-US is checked too: a key that only
// Chinese carries still renders, but as Chinese text on an English page.
// The one deliberate exception (dashboard.keys.copy, covered by
// web-i18n.test.ts) is listed explicitly rather than by weakening the rule.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import zhCN from "../../src/web/i18n/zh-CN.json";
import enUS from "../../src/web/i18n/en-US.json";

const ROOT = path.resolve(__dirname, "../..");

/** Keys that intentionally exist only in zh-CN. */
const ZH_ONLY = new Set(["dashboard.keys.copy"]);

type Dict = Record<string, unknown>;

function flattenKeys(node: unknown, prefix = ""): string[] {
  if (!node || typeof node !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node as Dict)) {
    const trail = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") out.push(...flattenKeys(value, trail));
    else out.push(trail);
  }
  return out;
}

const zhKeys = new Set(flattenKeys(zhCN));
const enKeys = new Set(flattenKeys(enUS));

function collectFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** `req.t 'key'`, `req.t("key")`, `@root.req.t 'key'`, `t("key")`. A literal
 *  first argument only — a key built from a variable cannot be checked
 *  statically, and those call sites are the ones a reviewer must read. */
const LITERAL_KEY_CALL =
  /\bt\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9._-]*)['"]|\bt\s+['"]([a-zA-Z][a-zA-Z0-9._-]*)['"]/g;

function referencedKeys(): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  const files = [
    ...collectFiles(path.join(ROOT, "src/web/views"), [".hbs"]),
    ...collectFiles(path.join(ROOT, "src/web/routes"), [".ts"]),
    ...collectFiles(path.join(ROOT, "src/web/admin"), [".ts"]),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    LITERAL_KEY_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LITERAL_KEY_CALL.exec(text))) {
      const key = match[1] ?? match[2];
      if (!key || !key.includes(".")) continue; // bare 't' / short locals
      const where = byKey.get(key) ?? new Set<string>();
      where.add(path.relative(ROOT, file));
      byKey.set(key, where);
    }
  }
  return byKey;
}

describe("view and route translation keys", () => {
  const referenced = referencedKeys();

  it("finds a meaningful number of keys to check", () => {
    // A silently empty list would make every assertion below vacuous.
    expect(referenced.size).toBeGreaterThan(100);
  });

  it("exist in the default locale", () => {
    const missing: string[] = [];
    for (const [key, where] of referenced) {
      if (!zhKeys.has(key)) missing.push(`${key}  (${[...where].join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  it("exist in en-US too, barring the documented exceptions", () => {
    const missing: string[] = [];
    for (const [key, where] of referenced) {
      if (ZH_ONLY.has(key)) continue;
      if (!enKeys.has(key)) missing.push(`${key}  (${[...where].join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps the zh-only list honest", () => {
    // A key listed as zh-only that is actually translated would mean the
    // list is stale, and a future en-US gap could hide behind it.
    for (const key of ZH_ONLY) expect(enKeys.has(key), `${key} is translated in en-US`).toBe(false);
  });
});
