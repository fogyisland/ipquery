// ESLint v9 flat config. Two phases:
//   - Phase A (now): style + correctness rules that can be enabled without
//     churning the codebase. `npm run lint` is wired into CI.
//   - Phase B (later): type-checked rules from `recommendedTypeChecked`.
//     Enable after a follow-up PR fixes the 200+ existing violations.
//
// Prettier conflict resolution comes last via `eslint-config-prettier`.
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: [
      "dist/**",
      // The committed release copy of dist/. It is generated output —
      // linting it would flag the compiler's own output, and it is
      // verified by `npm run check:release` instead.
      "up/dist/**",
      "coverage/**",
      "node_modules/**",
      "*.config.{js,ts}",
      "scripts/build.js", // build tool — runs under Node, not part of src
      "scripts/copy-schema.js",
      // Release-packaging tools — run under Node, print progress to
      // stdout by design.
      "scripts/sync-up-dist.js",
      "scripts/write-release-manifest.js",
      // Vendored client libraries — linted by prettier for formatting only.
      "src/web/assets/js/htmx.min.js",
      "src/web/assets/js/**/*.min.js",
      // type-checked rules excluded here would need parserOptions.project
      // per file; we keep them off for now.
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Project conventions.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "no-debugger": "error",
      "no-undef": "off", // TS already handles this; avoid duplicate reports
    },
  },
  {
    // Tests / dev scripts — relax stylistic rules where console + any are
    // legitimately useful for harnesses.
    files: ["test/**/*.ts", "scripts/dev/**/*.ts", "vitest.config.ts"],
    rules: {
      "no-console": "off",
    },
  },
  prettierConfig,
);
