// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";

/**
 * Every .hbs view must compile.
 *
 * A malformed template does not fail at build time — the build copies the
 * views verbatim. It fails at request time, as a 500, on whichever route
 * happens to render that view. A typo in a rarely-hit error page therefore
 * stays invisible until someone triggers it in production.
 *
 * The failure message is the other reason this test exists. Handlebars
 * reports a broken template with the position of the *offending token*, not
 * of the mistake. A comment written as `{{--` instead of `{{!--` makes the
 * parser treat the comment body as template source, and the error points at
 * some innocuous word inside the comment ("Expecting 'ID', got 'INVALID'"),
 * while the actual defect is three lines earlier. Compiling each view
 * directly turns that into a pointed failure.
 */
const VIEWS_DIR = path.resolve(__dirname, "../../src/web/views");

function collectViews(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectViews(full));
    else if (entry.name.endsWith(".hbs")) found.push(full);
  }
  return found;
}

const viewFiles = collectViews(VIEWS_DIR);

describe("Handlebars views", () => {
  it("finds the view tree", () => {
    // A silently empty list would make every assertion below vacuous.
    expect(viewFiles.length).toBeGreaterThan(20);
  });

  it.each(viewFiles.map((f) => [path.relative(VIEWS_DIR, f), f] as const))("%s compiles", (_name, file) => {
    const source = fs.readFileSync(file, "utf8");
    expect(() => Handlebars.precompile(source)).not.toThrow();
  });

  it.each(viewFiles.map((f) => [path.relative(VIEWS_DIR, f), f] as const))(
    "%s uses well-formed template comments",
    (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      // `{{!--` is the comment opener. `{{--` without the bang is a distinct
      // token: Handlebars accepts it as a block opener in some positions and
      // silently swallows the rest of the template in others. Either way the
      // comment body is parsed as template source, which is never intended.
      const malformed = source.match(/\{\{--(?!!)/g);
      expect(malformed ?? []).toEqual([]);
    },
  );

  it.each(viewFiles.map((f) => [path.relative(VIEWS_DIR, f), f] as const))(
    "%s has no unterminated template comment",
    (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      const openers = (source.match(/\{\{!--/g) ?? []).length;
      const closers = (source.match(/--\}\}/g) ?? []).length;
      expect({ openers, closers }).toEqual({ openers, closers: openers });
    },
  );
});
