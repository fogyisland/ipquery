// SPDX-License-Identifier: MIT
// Unit tests for the STARTUP generation of the .env file.
//
// The requirement this pins down: a fresh install must be able to start
// with nothing but `.env.example` on disk, and the .env has to appear by
// itself — the operator should not have to copy a file, open an editor,
// or fill in a form before the server will even boot.
//
// These tests cover the module that runs BEFORE dotenv reads the file
// (src/api/envBootstrap.ts), because that ordering is the whole trick:
// a .env generated after the config was resolved is a file the running
// process never reads.
//
// The `IPQUERY_ENV_FILE` override keeps these tests off the developer's
// own .env — see test/helpers/envIsolation.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapEnvFile, readEnvValues } from "../../src/api/envBootstrap";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

const TEMPLATE = [
  "# Runtime mode.",
  "NODE_ENV=production",
  "",
  "# MySQL",
  "DB_HOST=localhost",
  "DB_PASSWORD=rootpass",
  "DB_NAME=ipquery",
  "",
  "# API",
  "PORT=5001",
  "",
  "# Web",
  "WEB_BASE_URL=http://localhost:5001",
  "SESSION_SECRET=",
  "CSRF_SECRET=",
].join("\n");

describe("bootstrapEnvFile", () => {
  let iso: EnvIsolation;

  beforeEach(() => {
    iso = isolateEnvFile("ipq-bootenv-");
    fs.writeFileSync(
      path.join(path.dirname(iso.file), ".env.example"),
      TEMPLATE,
      "utf8",
    );
  });

  afterEach(() => {
    iso.restore();
  });

  it("creates the .env when it does not exist", () => {
    const result = bootstrapEnvFile();
    expect(result.created).toBe(true);
    expect(fs.existsSync(iso.file)).toBe(true);
  });

  it("copies the template's comments and every key", () => {
    bootstrapEnvFile();
    const content = fs.readFileSync(iso.file, "utf8");
    // The generated file has to be a file a human can read and edit.
    // A minimal four-key file would be "machine readable" and useless
    // to the operator who has to find the DB settings in it.
    expect(content).toContain("# Runtime mode.");
    expect(content).toContain("# MySQL");
    expect(content).toContain("# Web");
    expect(content).toContain("DB_NAME=ipquery");
    expect(content).toContain("NODE_ENV=production");
  });

  it("fills in a port and a base URL", () => {
    bootstrapEnvFile();
    const values = readEnvValues(iso.file);
    expect(values.PORT).toBe("3880");
    expect(values.WEB_BASE_URL).toBe("http://localhost:3880");
  });

  it("replaces the template's placeholder port", () => {
    // The template says PORT=5001 because that is what the template
    // happens to say. It is NOT a choice the operator made, so the
    // generated value wins.
    bootstrapEnvFile();
    const values = readEnvValues(iso.file);
    expect(values.PORT).not.toBe("5001");
    expect(values.PORT).toBe("3880");
  });

  it("generates two different non-empty secrets", () => {
    bootstrapEnvFile();
    const values = readEnvValues(iso.file);
    expect(values.SESSION_SECRET).toBeTruthy();
    expect(values.CSRF_SECRET).toBeTruthy();
    expect(values.SESSION_SECRET).not.toBe(values.CSRF_SECRET);
    // An empty secret is worse than a missing one: it passes the "the
    // file exists" check while signing every cookie with nothing.
    expect(values.SESSION_SECRET!.length).toBeGreaterThanOrEqual(64);
    expect(values.CSRF_SECRET!.length).toBeGreaterThanOrEqual(64);
  });

  it("leaves the DB_* placeholders alone", () => {
    // The database credentials are the one thing the operator must
    // supply. Writing a made-up password here produces a file that
    // looks configured and cannot connect.
    bootstrapEnvFile();
    const values = readEnvValues(iso.file);
    expect(values.DB_HOST).toBe("localhost");
    expect(values.DB_NAME).toBe("ipquery");
  });

  it("never overwrites an existing .env", () => {
    fs.writeFileSync(iso.file, "PORT=9999\nSESSION_SECRET=keepme\n", "utf8");
    const result = bootstrapEnvFile();
    expect(result.created).toBe(false);
    const values = readEnvValues(iso.file);
    expect(values.PORT).toBe("9999");
    expect(values.SESSION_SECRET).toBe("keepme");
  });

  it("keeps an existing .env even when the environment says otherwise", () => {
    // The environment wins over the defaults for a NEW file, but it
    // never overwrites what the operator wrote.
    fs.writeFileSync(iso.file, "PORT=9999\n", "utf8");
    const previous = process.env.PORT;
    process.env.PORT = "7777";
    try {
      bootstrapEnvFile();
      expect(readEnvValues(iso.file).PORT).toBe("9999");
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });

  it("honours PORT and WEB_BASE_URL from the environment for a new file", () => {
    // A container that injects PORT=8080 must not end up with a .env
    // that says 3880.
    const previousPort = process.env.PORT;
    const previousBase = process.env.WEB_BASE_URL;
    process.env.PORT = "8080";
    process.env.WEB_BASE_URL = "https://geo.example.com";
    try {
      bootstrapEnvFile();
      const values = readEnvValues(iso.file);
      expect(values.PORT).toBe("8080");
      expect(values.WEB_BASE_URL).toBe("https://geo.example.com");
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousBase === undefined) delete process.env.WEB_BASE_URL;
      else process.env.WEB_BASE_URL = previousBase;
    }
  });

  it("still writes a usable file when the template is missing", () => {
    fs.rmSync(path.join(path.dirname(iso.file), ".env.example"), { force: true });
    const result = bootstrapEnvFile();
    expect(result.created).toBe(true);
    const values = readEnvValues(iso.file);
    expect(values.PORT).toBe("3880");
    expect(values.SESSION_SECRET).toBeTruthy();
  });

  it("does not throw when the file cannot be written", () => {
    // A boot that dies because it could not write a config file is worse
    // than a boot that starts with the defaults and says so. The
    // operator can always create the file by hand; they cannot create
    // it from a process that refused to start.
    //
    // The failure is forced by pointing the override at a path inside a
    // directory that does not exist — writeFileSync then fails with
    // ENOENT. (A directory sitting where the file should go is not
    // enough: existsSync() returns true for a directory, so the code
    // would take the "an .env already exists" path and never try to
    // write anything.)
    const iso2 = isolateEnvFile("ipq-bootenv-ro-");
    const missing = path.join(path.dirname(iso2.file), "no-such-dir", ".env");
    const previous = process.env.IPQUERY_ENV_FILE;
    process.env.IPQUERY_ENV_FILE = missing;
    try {
      const result = bootstrapEnvFile();
      expect(result.created).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.IPQUERY_ENV_FILE;
      else process.env.IPQUERY_ENV_FILE = previous;
      iso2.restore();
    }
  });

  it("is idempotent — a second call changes nothing", () => {
    bootstrapEnvFile();
    const first = fs.readFileSync(iso.file, "utf8");
    bootstrapEnvFile();
    expect(fs.readFileSync(iso.file, "utf8")).toBe(first);
  });
});
