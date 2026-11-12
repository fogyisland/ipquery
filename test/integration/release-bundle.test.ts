// SPDX-License-Identifier: MIT
//
// The release bundle in up/ is what gets copied to a server.
//
// Two properties are pinned here:
//
//  1. `npm run build` WORKS in the release directory. It did not for a
//     long time: the release package.json carried only the runtime
//     commands, so the natural "copy, npm install, npm run build,
//     start" workflow died with a bare "Missing script: build" and no
//     hint about what to do instead.
//
//     The release ships dist/ already compiled, so its `build` verifies
//     the shipped output rather than regenerating it — which is the
//     check that actually matters when a directory is copied around.
//
//  2. The verification itself detects damage. A checker that only ever
//     prints "OK" is worse than none, because it teaches the operator
//     to trust it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UP_DIR = path.join(REPO_ROOT, "up");

/** Run a script in the release directory and capture its outcome. */
async function runInUp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: UP_DIR,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("the release bundle's package.json", () => {
  let pkg: { scripts?: Record<string, string> };

  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(path.join(UP_DIR, "package.json"), "utf8"));
  });

  it("has a build script", () => {
    // The whole point: `npm run build` must not fail with "Missing
    // script" in the release directory.
    expect(pkg.scripts?.build).toBeDefined();
  });

  it("keeps the runtime commands", () => {
    for (const name of ["start", "serve", "migrate", "update", "init", "status"]) {
      expect(pkg.scripts?.[name], `script "${name}"`).toBeDefined();
    }
  });

  it("every script that points at a file resolves to a file that exists", () => {
    // A script that points at a missing file is the exact failure the
    // build now guards against: the release uploads fine and then dies
    // on the server with a confusing error.
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      const scriptFile = command.match(/node\s+(\S+\.js)/)?.[1];
      if (!scriptFile) continue;
      const abs = path.join(UP_DIR, scriptFile);
      expect(fs.existsSync(abs), `script "${name}" -> ${scriptFile}`).toBe(true);
    }
  });
});

describe("npm run build in the release directory", () => {
  it("succeeds and reports the bundle as intact", async () => {
    const result = await runInUp(["scripts/verify-dist.js"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release bundle is intact");
  }, 120_000);

  it("exits non-zero when a shipped file is missing", async () => {
    // Copy the bundle to a scratch directory so the real one is never
    // touched, then delete a file and confirm the checker notices.
    const scratch = path.join(REPO_ROOT, "test", "tmp-release-verify");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    try {
      fs.cpSync(UP_DIR, scratch, { recursive: true });
      fs.rmSync(path.join(scratch, "dist", "cli.js"), { force: true });

      const result = await runInUpIn(scratch, ["scripts/verify-dist.js"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("cli.js");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it("exits non-zero when a shipped file was modified", async () => {
    const scratch = path.join(REPO_ROOT, "test", "tmp-release-verify");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    try {
      fs.cpSync(UP_DIR, scratch, { recursive: true });
      fs.appendFileSync(path.join(scratch, "dist", "cli.js"), "\n// tampered\n");

      const result = await runInUpIn(scratch, ["scripts/verify-dist.js"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("modified");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Run a script inside an arbitrary release-directory copy. */
async function runInUpIn(
  dir: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: dir,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
