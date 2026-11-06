import { defineConfig } from "vitest/config";

// Single config — test slices are selected by path:
//   vitest run test/unit           → fast, no DB
//   vitest run test/integration    → requires MySQL
//   vitest run test/e2e            → requires MySQL + playwright
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
    },
  },
});
