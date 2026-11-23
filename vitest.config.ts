import { defineConfig } from "vitest/config";

// Single config — test slices are selected by path:
//   vitest run test/unit           → fast, no DB
//   vitest run test/integration    → requires MySQL
//   vitest run test/e2e            → requires MySQL + playwright
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A test that builds a schema from empty and then runs the migrations
    // again is not a slow test — it is doing 30 DDL statements, each an
    // implicit commit with a durable metadata write. 90s was enough when the
    // suite only ran `runMigrations`; the schema report runs it twice.
    testTimeout: 180_000,
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
      // A floor, not a target.
      //
      // These are calibrated against the unit slice — `vitest run
      // test/unit --coverage` — because that is the slice CI can gate
      // on without a database. Measured there: 44.03% statements,
      // 77.97% branches, 58.79% functions. The floor sits a couple of
      // points below so ordinary churn does not fail a build, while a
      // whole new module arriving untested (which is what happened
      // with the CSV export and the login lockout) does.
      //
      // A larger slice always clears these: the full suite measures
      // 87.72% statements because the integration and browser tests
      // exercise the routes and plugins the unit slice never loads.
      thresholds: {
        statements: 42,
        branches: 74,
        functions: 55,
        lines: 42,
      },
    },
  },
});
