// SPDX-License-Identifier: MIT
//
// The configuration surface must not carry a setting for a data source
// the ETL pipeline does not run.
//
// `MAXMIND_LICENSE_KEY` and `MAXMIND_EDITIONS` were read at boot into
// `cfg.maxmind`, printed in the startup banner, shown on the admin
// settings page as a masked secret and a pair of edition pills — and
// then read by nothing. No pipeline step consumes them, because the
// MaxMind parser is gone.
//
// The cost of leaving them is not the two env lines. It is the
// startup banner: a line reading `[config] maxmind key=abcd…wxyz`
// tells an operator the server holds a MaxMind licence and is
// therefore loading MaxMind data. It is not. The banner is the first
// thing anyone reads when something is wrong.
//
// The env templates get the same treatment: a variable in
// `.env.example` is an instruction to the operator to set it, and
// "set this" for a value nothing reads is busywork with a false
// promise attached.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");

const ENV_TEMPLATES = [".env.example", "up/.env.example"];

function readTemplate(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

/** The variable names a dotenv file declares, in file order. */
function envTemplateKeys(relativePath: string): string[] {
  return readTemplate(relativePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("=")[0]!.trim())
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
}

describe("The configuration surface", () => {
  it("reads no variable for a source the pipeline does not run", () => {
    const config = fs.readFileSync(path.join(root, "src", "config.ts"), "utf8");
    expect(config).not.toMatch(/MAXMIND/i);
  });

  it("prints no banner line for a source the pipeline does not run", () => {
    const config = fs.readFileSync(path.join(root, "src", "config.ts"), "utf8");
    // The startup banner is what an operator reads first. It must not
    // claim a licence or an edition list the server never uses.
    expect(config).not.toMatch(/cfg\.maxmind/);
  });

  it("offers no environment variable for a source the pipeline does not run", () => {
    for (const template of ENV_TEMPLATES) {
      const keys = envTemplateKeys(template);
      expect(keys, `${template} declares MAXMIND_LICENSE_KEY`).not.toContain(
        "MAXMIND_LICENSE_KEY",
      );
      expect(keys, `${template} declares MAXMIND_EDITIONS`).not.toContain("MAXMIND_EDITIONS");
    }
  });

  it("keeps the environment templates otherwise in step with each other", () => {
    // Removing the variable from one template and forgetting the other
    // leaves a release bundle that differs from the source tree.
    expect(envTemplateKeys(".env.example")).toEqual(envTemplateKeys("up/.env.example"));
  });
});
