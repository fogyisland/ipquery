import { defineConfig } from "vitest/config";

// Single config — test slices are selected by path:
//   vitest run test/unit           → fast, no DB
//   vitest run test/integration    → requires MySQL
//   vitest run test/e2e            → requires MySQL + playwright
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 90_000,
    // A fresh test database runs every migration from scratch, and each
    // CREATE/ALTER TABLE is an implicit commit whose metadata write is
    // durable. On a machine with a slow disk that is roughly a second
    // per statement, so building the schema from empty costs ~40s and
    // the E2E setup hook (which also runs the ETL pipeline) can take
    // over a minute. 180s leaves room for a few more migrations without
    // the hook silently failing on a slow disk.
    hookTimeout: 180_000,
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
