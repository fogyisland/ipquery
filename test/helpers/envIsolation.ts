// SPDX-License-Identifier: MIT
// Keep the test suite out of the developer's .env.
//
// Step 2 of the setup wizard WRITES the database connection to a .env
// file — that is the whole point of the step. Without an isolation
// mechanism the wizard therefore writes into whatever .env the process
// would read, which during a test run is the developer's own project
// .env. The result is a developer's working configuration silently
// replaced by a throwaway test database name, and a project that only
// runs again after they hand-edit the file back.
//
// The wizard honours IPQUERY_ENV_FILE for exactly this purpose (see
// src/api/dbBootstrap.ts). Point it at a scratch file and the wizard
// writes there instead.
//
// This is NOT a production feature: nothing in the shipped code sets the
// variable, and it is deliberately absent from .env.example — a
// deployment that pointed the wizard at some other file would write
// credentials somewhere the process does not read them back.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface EnvIsolation {
  /** The scratch .env the wizard will write to. */
  file: string;
  /** Put the original value back. Call this in afterAll. */
  restore: () => void;
}

/**
 * Point the wizard's .env writes at a throwaway file.
 *
 * Returns the path and a restore function. The scratch file is removed
 * on restore, so a failed run does not leave it behind.
 */
export function isolateEnvFile(dirPrefix = "ipq-env-"): EnvIsolation {
  const previous = process.env.IPQUERY_ENV_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
  const file = path.join(dir, ".env");
  process.env.IPQUERY_ENV_FILE = file;
  return {
    file,
    restore: () => {
      if (previous === undefined) delete process.env.IPQUERY_ENV_FILE;
      else process.env.IPQUERY_ENV_FILE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
