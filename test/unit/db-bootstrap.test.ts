// SPDX-License-Identifier: MIT
// Unit tests for src/api/dbBootstrap.ts.
//
// The functions under test are the ones that decide whether a fresh
// install degrades gracefully (server starts, wizard reachable) or dies
// with a raw driver error the operator cannot act on. They are pure
// enough to test without a database, except for the .env writer, which
// writes to a scratch file instead.
//
// The `IPQUERY_ENV_FILE` override is what keeps the .env writer's tests
// off the developer's own .env — see test/helpers/envIsolation.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isDbUnreachableError,
  describeDbError,
  envFilePath,
  envFileExists,
  writeDbCredentialsToEnv,
} from "../../src/api/dbBootstrap";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

describe("isDbUnreachableError", () => {
  it("treats a refused connection as unreachable", () => {
    expect(isDbUnreachableError({ code: "ECONNREFUSED" })).toBe(true);
  });

  it("treats rejected credentials as unreachable", () => {
    expect(isDbUnreachableError({ code: "ER_ACCESS_DENIED_ERROR" })).toBe(true);
  });

  it("treats a missing database as unreachable", () => {
    expect(isDbUnreachableError({ code: "ER_BAD_DB_ERROR" })).toBe(true);
  });

  it("treats a timeout as unreachable", () => {
    expect(isDbUnreachableError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("treats an unresolvable host as unreachable", () => {
    expect(isDbUnreachableError({ code: "ENOTFOUND" })).toBe(true);
  });

  it("does NOT treat a schema error as unreachable", () => {
    // A broken schema is a real bug. Degrading on it would turn a
    // migration error into a silently half-working install.
    expect(isDbUnreachableError({ code: "ER_PARSE_ERROR" })).toBe(false);
    expect(isDbUnreachableError({ code: "ER_DUP_FIELDNAME" })).toBe(false);
    expect(isDbUnreachableError({ code: "ER_TABLE_EXISTS" })).toBe(false);
  });

  it("does not treat a non-object as unreachable", () => {
    expect(isDbUnreachableError(null)).toBe(false);
    expect(isDbUnreachableError(undefined)).toBe(false);
    expect(isDbUnreachableError("ECONNREFUSED")).toBe(false);
    expect(isDbUnreachableError(new Error("boom"))).toBe(false);
  });

  it("unwraps an AggregateError of connection failures", () => {
    // mysql2 sometimes wraps the individual causes in an AggregateError
    // whose own code is generic — the causes are then the only signal.
    const err = {
      code: "AGGREGATE",
      errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }],
    };
    expect(isDbUnreachableError(err)).toBe(true);
  });

  it("does not unwrap when one of the causes is a real error", () => {
    // The outer code is generic here, so the causes decide — and one of
    // them is a schema error, which must not degrade the boot.
    const err = {
      code: "AGGREGATE",
      errors: [{ code: "ECONNREFUSED" }, { code: "ER_PARSE_ERROR" }],
    };
    expect(isDbUnreachableError(err)).toBe(false);
  });

  it("trusts the outer code when it is a connection failure", () => {
    // mysql2 puts the same connection code on the AggregateError and on
    // each cause, so the outer code is authoritative — the causes are
    // only consulted when the outer code says nothing useful.
    const err = {
      code: "ECONNREFUSED",
      errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    };
    expect(isDbUnreachableError(err)).toBe(true);
  });
});

describe("describeDbError", () => {
  it("names the knob to turn for each kind of failure", () => {
    expect(describeDbError({ code: "ECONNREFUSED" })).toMatch(/refused/i);
    expect(describeDbError({ code: "ER_ACCESS_DENIED_ERROR" })).toMatch(/credentials/i);
    expect(describeDbError({ code: "ER_BAD_DB_ERROR" })).toMatch(/does not exist/i);
    expect(describeDbError({ code: "ETIMEDOUT" })).toMatch(/timed out/i);
    expect(describeDbError({ code: "ENOTFOUND" })).toMatch(/resolved/i);
  });

  it("falls back for an unknown code", () => {
    expect(describeDbError({ code: "WAT" })).toMatch(/could not be reached/i);
    expect(describeDbError(null)).toBe("unknown error");
  });

  it("does not echo the raw driver message", () => {
    // The raw message can carry the server version and hostname. The
    // operator is already on the machine; an attacker reading the page
    // is not.
    const raw = {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:3306 (MySQL 8.0.36)",
      sql: "SELECT 1",
    };
    const described = describeDbError(raw);
    expect(described).not.toContain("127.0.0.1");
    expect(described).not.toContain("8.0.36");
    expect(described).not.toContain("SELECT 1");
  });
});

describe("envFilePath", () => {
  let isolation: EnvIsolation | undefined;

  afterEach(() => {
    isolation?.restore();
    isolation = undefined;
  });

  it("honours the IPQUERY_ENV_FILE override", () => {
    isolation = isolateEnvFile();
    expect(envFilePath()).toBe(isolation.file);
  });

  it("ignores an empty override", () => {
    isolation = isolateEnvFile();
    process.env.IPQUERY_ENV_FILE = "   ";
    // An empty override must fall back to the cwd, not resolve to the
    // cwd itself (which would make the wizard overwrite the directory).
    expect(envFilePath()).toBe(path.resolve(process.cwd(), ".env"));
  });

  it("falls back to .env in the current directory", () => {
    const previous = process.env.IPQUERY_ENV_FILE;
    delete process.env.IPQUERY_ENV_FILE;
    try {
      expect(envFilePath()).toBe(path.resolve(process.cwd(), ".env"));
    } finally {
      if (previous !== undefined) process.env.IPQUERY_ENV_FILE = previous;
    }
  });
});

describe("writeDbCredentialsToEnv", () => {
  let isolation: EnvIsolation | undefined;

  beforeEach(() => {
    isolation = isolateEnvFile();
  });

  afterEach(() => {
    isolation?.restore();
    isolation = undefined;
  });

  it("creates the file when it does not exist yet", () => {
    const file = writeDbCredentialsToEnv({
      host: "db.internal",
      port: 3307,
      user: "ipquery",
      password: "s3cret",
      database: "ipquery",
    });
    expect(file).toBe(isolation!.file);
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain("DB_HOST=db.internal");
    expect(body).toContain("DB_PORT=3307");
    expect(body).toContain("DB_USER=ipquery");
    expect(body).toContain("DB_PASSWORD=s3cret");
    expect(body).toContain("DB_NAME=ipquery");
  });

  it("replaces existing DB_* lines in place instead of appending duplicates", () => {
    // A second `DB_HOST=` line would leave the effective value to
    // dotenv's "first wins" rule — not something an operator should
    // have to reason about when reading their own file.
    fs.writeFileSync(
      isolation!.file,
      ["PORT=5001", "DB_HOST=old", "DB_PORT=3306", "SESSION_SECRET=keepme", ""].join("\n"),
      "utf8",
    );
    writeDbCredentialsToEnv({
      host: "new",
      port: 3307,
      user: "u",
      password: "p",
      database: "d",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("DB_HOST=new");
    expect(body).not.toContain("DB_HOST=old");
    expect(body.match(/DB_HOST=/g)).toHaveLength(1);
    expect(body.match(/DB_PORT=/g)).toHaveLength(1);
  });

  it("keeps unrelated settings", () => {
    fs.writeFileSync(
      isolation!.file,
      ["PORT=5001", "SESSION_SECRET=keepme", "COOKIE_SECURE=true"].join("\n"),
      "utf8",
    );
    writeDbCredentialsToEnv({
      host: "h",
      port: 3306,
      user: "u",
      password: "p",
      database: "d",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("PORT=5001");
    expect(body).toContain("SESSION_SECRET=keepme");
    expect(body).toContain("COOKIE_SECURE=true");
  });

  it("appends the missing DB_* keys to a file that has none", () => {
    fs.writeFileSync(isolation!.file, "PORT=5001", "utf8");
    writeDbCredentialsToEnv({
      host: "h",
      port: 3306,
      user: "u",
      password: "p",
      database: "d",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("PORT=5001");
    expect(body).toContain("DB_HOST=h");
    expect(body).toContain("DB_NAME=d");
  });

  it("reports whether the .env exists", () => {
    expect(envFileExists()).toBe(false);
    fs.writeFileSync(isolation!.file, "PORT=5001", "utf8");
    expect(envFileExists()).toBe(true);
  });
});
