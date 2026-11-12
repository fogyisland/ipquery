// SPDX-License-Identifier: MIT
//
// Generate the .env file before anything reads it.
//
// The order here is the whole point of this file:
//
//   1. This module runs. If there is no .env, it creates one from
//      .env.example, with the port, the base URL and two random secrets.
//   2. dotenv loads .env into process.env.
//   3. The config is resolved from process.env.
//
// Steps 2 and 3 are done by `import "dotenv/config"` in config.ts, which
// is a side-effect import evaluated when that module loads. So this
// module has to run FIRST — which means it cannot import config.ts
// (that would be a cycle) and it cannot import dbBootstrap.ts (which
// imports config.ts).
//
// Hence the duplication below. The parsing and writing rules are the
// same as dbBootstrap.ts's ensureEnvFile() — but that file is loaded
// after dotenv, so it cannot do this job. The two are kept in step by
// test/unit/db-env-generation.test.ts, which exercises both against the
// same expectations.
//
// What is NOT generated here: the database credentials. The DB_* values
// are the one thing the operator has to supply, because a made-up
// password produces a .env that looks configured and cannot connect.
// The wizard collects them in step 2 and writes them into this same file.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The test-only override for where the .env file lives. */
const ENV_FILE_OVERRIDE = "IPQUERY_ENV_FILE";

/** The port used when neither the environment nor the template says. */
const DEFAULT_PORT = 3880;

/**
 * The base URL used when neither the environment nor the template says.
 *
 * This is a PLACEHOLDER, not an answer. At boot time the server has no
 * way to know what domain it will be served on — it has not seen a
 * request yet. So the generated file carries the loopback address and
 * the wizard (step 2) offers the address the operator is actually
 * browsing, which is derived from the request's Host header.
 *
 * The placeholder matters: `WEB_BASE_URL` ends up in the verification
 * email, the password-reset email and the API endpoint template on the
 * keys page. Left as a loopback address, all three hand a real user an
 * address they cannot reach.
 */
const DEFAULT_BASE_URL = "http://localhost:3880";

/**
 * The absolute path of the .env file this process should use.
 *
 * dotenv reads `.env` from `process.cwd()`, NOT from the directory the
 * code lives in — so the file has to be written where the process was
 * started from, or its values would never be read back.
 */
function envFilePath(): string {
  const override = process.env[ENV_FILE_OVERRIDE];
  if (override && override.trim() !== "") {
    return path.resolve(override.trim());
  }
  return path.resolve(process.cwd(), ".env");
}

/**
 * Parse a .env file into a key/value map.
 *
 * Deliberately simple: KEY=VALUE, one per line, `#` starts a comment,
 * optional surrounding quotes are stripped. Values are NOT shell
 * evaluated — a value like `$(rm -rf /)` is data, not a command.
 *
 * A trailing `# comment` is stripped from an unquoted value, which is
 * what dotenv does. The two have to agree: this parser is what the
 * wizard reads the .env with, and dotenv is what the running process
 * reads it with. If they disagreed about the same line, the wizard
 * would hand dotenv a different value than the one the operator sees —
 * and a trailing comment on `WEB_BASE_URL` would end up inside the URL.
 */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: any `#` opens a trailing comment. This is dotenv's
      // rule, and it is stricter than it looks — `abc#def` parses as
      // `abc`, and so does a URL with a fragment. Matching dotenv
      // exactly is the point: this parser is what the wizard reads the
      // .env with, and dotenv is what the running process reads it
      // with. If they disagreed about the same line, the operator would
      // see one value and the server would use another.
      const hash = value.indexOf("#");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** A 48-byte random secret, base64 encoded (64 characters). */
function generateSecret(): string {
  return crypto.randomBytes(48).toString("base64");
}

/**
 * Make the .env file readable only by its owner.
 *
 * The `mode` option of `fs.writeFileSync` only applies when the file is
 * CREATED. Since this module only ever creates the file, the mode does
 * apply here — but the explicit chmod keeps the guarantee true if the
 * file is later rewritten by the wizard.
 *
 * `chmod` is a no-op on Windows for this purpose (NTFS access control is
 * not driven by the POSIX mode bits), so a failure there is not worth
 * aborting the boot over.
 */
function tightenEnvPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    void err;
  }
}

/**
 * Replace the values of `pending` in `content`, leaving every other line
 * exactly as it was.
 *
 * A rewrite in place, not an append: appending a second `PORT=` line
 * would leave the effective value to dotenv's "first wins" rule, which
 * is not a thing anyone should have to reason about.
 *
 * `comments` optionally supplies a trailing comment to append to the
 * rewritten line. It is used to mark the generated base URL as a
 * placeholder, so an operator who opens the file in an editor sees the
 * same thing the wizard tells them: this value is a guess, fix it.
 */
function applyValues(
  content: string,
  pending: Map<string, string>,
  comments?: Map<string, string>,
): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[2];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      // match[1] is the leading whitespace only — match[0] would be the
      // whole "PORT=" prefix and would produce "PORT=PORT=3880".
      const indent = match?.[1] ?? "";
      const comment = comments?.get(key);
      out.push(comment ? `${indent}${key}=${value}  # ${comment}` : `${indent}${key}=${value}`);
      continue;
    }
    out.push(line);
  }

  if (pending.size > 0) {
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    if (out.length > 0) out.push("");
    out.push("# --- generated on first start ---");
    for (const [key, value] of pending) {
      const comment = comments?.get(key);
      out.push(comment ? `${key}=${value}  # ${comment}` : `${key}=${value}`);
    }
  }

  return out.join("\n");
}

/**
 * Create the .env file if it does not exist yet.
 *
 * Returns what happened, so the boot can log it:
 *   - `created: true`  a new .env was written from .env.example
 *   - `created: false` an .env was already there and was left untouched
 *
 * Never throws. A boot that dies because it could not write a config
 * file is worse than a boot that starts with the defaults and says so —
 * the operator can always create the file by hand, but they cannot
 * create it from a process that refused to start.
 */
export function bootstrapEnvFile(): { path: string; created: boolean; error?: string } {
  const file = envFilePath();

  // An existing .env is the operator's real configuration. It always
  // wins — we never overwrite what they wrote.
  if (fs.existsSync(file)) {
    return { path: file, created: false };
  }

  const templatePath = path.join(path.dirname(file), ".env.example");
  let content: string;
  if (fs.existsSync(templatePath)) {
    content = fs.readFileSync(templatePath, "utf8");
  } else {
    // No template to copy. The file still has to exist, or the operator
    // has nothing to edit and the secrets have nowhere to live.
    content = ["# Generated by IPQuery on first start.", ""].join("\n");
  }

  // The environment wins over the defaults: a container that injects
  // PORT=8080 must not end up with a .env that says 3880.
  const envPort = process.env.PORT?.trim() ?? "";
  const port = envPort !== "" ? envPort : String(DEFAULT_PORT);
  const envBaseUrl = process.env.WEB_BASE_URL?.trim() ?? "";
  const baseUrl = envBaseUrl !== "" ? envBaseUrl : DEFAULT_BASE_URL;

  const pending = new Map<string, string>([
    ["PORT", port],
    ["WEB_BASE_URL", baseUrl],
    ["SESSION_SECRET", generateSecret()],
    ["CSRF_SECRET", generateSecret()],
  ]);

  // Only the generated placeholder gets the marker. A base URL that came
  // from the environment was chosen by somebody who knew the deployment —
  // telling them it is a placeholder would be noise.
  const comments = new Map<string, string>();
  if (envBaseUrl === "") {
    comments.set(
      "WEB_BASE_URL",
      "PLACEHOLDER — set this to the public address of this site (the wizard's step 2 offers it)",
    );
  }

  try {
    fs.writeFileSync(file, applyValues(content, pending, comments), {
      encoding: "utf8",
      mode: 0o600,
    });
    tightenEnvPermissions(file);
    return { path: file, created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: file, created: false, error: message };
  }
}

/**
 * The values the generated .env ended up with.
 *
 * Exported for the boot log and the tests — the operator should be able
 * to see that the file was written and what it contains, without the
 * secrets themselves ever being printed.
 */
export function readEnvValues(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
