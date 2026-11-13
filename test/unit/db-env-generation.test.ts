// SPDX-License-Identifier: MIT
// Unit tests for the .env GENERATION path of src/api/dbBootstrap.ts.
//
// The wizard's step 1 creates the .env from scratch: on a fresh unpack
// only `.env.example` exists, and the operator should not have to copy
// it, edit it, or open a shell. These tests pin the two properties that
// make that safe:
//
//   1. Nothing that is already configured gets overwritten. An operator
//      who set PORT by hand before opening the wizard must not have it
//      silently reset.
//   2. The secrets are actually generated. A .env that ships with an
//      empty SESSION_SECRET is worse than no .env: it passes the
//      "the file exists" check while signing every session cookie with
//      an empty string.
//
// The `IPQUERY_ENV_FILE` override keeps these tests off the developer's
// own .env — see test/helpers/envIsolation.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureEnvFile,
  resolveEnvBootstrap,
  parseEnvFile,
  generateSecret,
} from "../../src/api/dbBootstrap";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

describe("parseEnvFile", () => {
  it("reads plain key=value lines", () => {
    const parsed = parseEnvFile(["PORT=3880", "DB_HOST=127.0.0.1"].join("\n"));
    expect(parsed.PORT).toBe("3880");
    expect(parsed.DB_HOST).toBe("127.0.0.1");
  });

  it("skips comments and blank lines", () => {
    const parsed = parseEnvFile(["# a comment", "", "PORT=3880", "  # indented comment"].join("\n"));
    expect(Object.keys(parsed)).toEqual(["PORT"]);
  });

  it("strips surrounding quotes", () => {
    const parsed = parseEnvFile(['A="quoted"', "B='single'", "C=plain"].join("\n"));
    expect(parsed.A).toBe("quoted");
    expect(parsed.B).toBe("single");
    expect(parsed.C).toBe("plain");
  });

  it("keeps a value that contains an equals sign", () => {
    // A base64 secret can contain '='. Truncating at the first one would
    // silently shorten a signing key.
    const parsed = parseEnvFile("SESSION_SECRET=abc123==");
    expect(parsed.SESSION_SECRET).toBe("abc123==");
  });

  it("does not evaluate shell substitution", () => {
    // The file is data, not a script. A literal "$(whoami)" must come
    // back as the literal text, never as the result of a command.
    const parsed = parseEnvFile("DB_PASSWORD=$(whoami)");
    expect(parsed.DB_PASSWORD).toBe("$(whoami)");
  });
});

describe("generateSecret", () => {
  it("produces a long random value", () => {
    const secret = generateSecret();
    // 48 random bytes, base64-encoded.
    expect(secret.length).toBeGreaterThanOrEqual(64);
  });

  it("does not repeat itself", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("resolveEnvBootstrap", () => {
  const wanted = {
    port: 3880,
    baseUrl: "http://localhost:3880",
    sessionSecret: "generated-session",
    csrfSecret: "generated-csrf",
  };

  it("fills in every key when the file has none", () => {
    const resolved = resolveEnvBootstrap({}, wanted);
    expect(resolved.PORT).toBe("3880");
    expect(resolved.WEB_BASE_URL).toBe("http://localhost:3880");
    expect(resolved.SESSION_SECRET).toBe("generated-session");
    expect(resolved.CSRF_SECRET).toBe("generated-csrf");
  });

  it("keeps existing values instead of overwriting them", () => {
    // The operator may have tuned PORT before opening the wizard.
    // Replacing it would undo their work behind their back.
    const resolved = resolveEnvBootstrap(
      { PORT: "9000", WEB_BASE_URL: "https://ip.example.com", SESSION_SECRET: "keep", CSRF_SECRET: "keep2" },
      wanted,
    );
    expect(resolved.PORT).toBe("9000");
    expect(resolved.WEB_BASE_URL).toBe("https://ip.example.com");
    expect(resolved.SESSION_SECRET).toBe("keep");
    expect(resolved.CSRF_SECRET).toBe("keep2");
  });

  it("fills in a key that is present but empty", () => {
    // An empty SESSION_SECRET is not a configuration — it is a hole.
    const resolved = resolveEnvBootstrap({ SESSION_SECRET: "   " }, wanted);
    expect(resolved.SESSION_SECRET).toBe("generated-session");
  });

  it("replaces the loopback placeholder with the operator's address", () => {
    // The startup generator writes WEB_BASE_URL=http://localhost:3880
    // because at boot time the server cannot know its own domain. That
    // is a GUESS, not a choice — and it used to win over the address the
    // operator had just confirmed in the wizard. The result was a .env
    // still pointing at loopback, with the verification email, the
    // password-reset email and the keys-page API address all handing
    // out an address nobody outside the machine can reach.
    for (const placeholder of [
      "http://localhost:3880",
      "http://localhost",
      "https://localhost:8443",
      "http://127.0.0.1:3880",
      "http://[::1]:3880",
      "http://localhost:3880/base",
    ]) {
      const resolved = resolveEnvBootstrap(
        { WEB_BASE_URL: placeholder },
        { ...wanted, baseUrl: "https://ip.pudafo.com" },
      );
      expect(resolved.WEB_BASE_URL, `placeholder ${placeholder}`).toBe("https://ip.pudafo.com");
    }
  });

  it("keeps a real address the operator already chose", () => {
    // The opposite rule: a value that is NOT a placeholder was chosen by
    // somebody. The wizard must not overwrite it with whatever it is
    // offering right now.
    for (const real of [
      "https://ip.pudafo.com",
      "http://192.168.1.10:3880",
      "https://geo.example.com/sub",
    ]) {
      const resolved = resolveEnvBootstrap(
        { WEB_BASE_URL: real },
        { ...wanted, baseUrl: "https://offered.example.com" },
      );
      expect(resolved.WEB_BASE_URL, `real ${real}`).toBe(real);
    }
  });
});

describe("ensureEnvFile", () => {
  let isolation: EnvIsolation | undefined;

  beforeEach(() => {
    isolation = isolateEnvFile("ipq-envgen-");
  });

  afterEach(() => {
    isolation?.restore();
    isolation = undefined;
  });

  it("creates the file from the example template", () => {
    // The template supplies the comments and the full key list, so the
    // result is a file a human can read and edit later.
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      ["# IPQuery configuration", "PORT=5001", "DB_HOST=", "SESSION_SECRET=", ""].join("\n"),
      "utf8",
    );

    const result = ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });

    expect(result.created).toBe(true);
    expect(fs.existsSync(isolation!.file)).toBe(true);
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("# IPQuery configuration");
    expect(body).toContain("PORT=3880");
    expect(body).toContain("SESSION_SECRET=sess");
    expect(body).toContain("CSRF_SECRET=csrf");
  });

  it("reports created=false when the file already existed", () => {
    fs.writeFileSync(isolation!.file, "PORT=3880", "utf8");
    const result = ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    expect(result.created).toBe(false);
  });

  it("keeps the template's other keys", () => {
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      ["PORT=5001", "COOKIE_SECURE=false", "DATA_DIR=./data", ""].join("\n"),
      "utf8",
    );
    ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("COOKIE_SECURE=false");
    expect(body).toContain("DATA_DIR=./data");
  });

  it("replaces the template's placeholder port with the operator's choice", () => {
    // The template says PORT=5001 because that is what the template
    // happens to contain. The operator typed 3880 on the form, and the
    // form is the authority — otherwise the port would silently revert
    // to the template's placeholder every time the wizard ran.
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      "PORT=5001\n",
      "utf8",
    );
    ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("PORT=3880");
    expect(body).not.toContain("PORT=5001");
  });

  it("does not overwrite a port that is already in an existing .env", () => {
    // This is the other half of the rule: a REAL .env — one the
    // operator has — keeps its values. Only the template's placeholders
    // are replaceable.
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      "PORT=5001\n",
      "utf8",
    );
    fs.writeFileSync(isolation!.file, "PORT=9000\nSESSION_SECRET=keepme\n", "utf8");
    ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body).toContain("PORT=9000");
    expect(body).toContain("SESSION_SECRET=keepme");
  });

  it("writes the two secrets exactly once", () => {
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      "SESSION_SECRET=\nCSRF_SECRET=\n",
      "utf8",
    );
    ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    const body = fs.readFileSync(isolation!.file, "utf8");
    expect(body.match(/SESSION_SECRET=/g)).toHaveLength(1);
    expect(body.match(/CSRF_SECRET=/g)).toHaveLength(1);
  });

  it("still writes a usable file when the template is missing", () => {
    // A deployment that shipped without .env.example must not make the
    // wizard fail — it has to produce something loadable regardless.
    const result = ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    expect(fs.existsSync(result.path)).toBe(true);
    const body = fs.readFileSync(result.path, "utf8");
    expect(body).toContain("PORT=3880");
    expect(body).toContain("SESSION_SECRET=sess");
  });

  it("produces a file the env parser can read back", () => {
    fs.writeFileSync(
      path.join(path.dirname(isolation!.file), ".env.example"),
      "PORT=5001\n# comment\nCOOKIE_SECURE=false\n",
      "utf8",
    );
    ensureEnvFile({
      port: 3880,
      baseUrl: "http://localhost:3880",
      sessionSecret: "sess",
      csrfSecret: "csrf",
    });
    const parsed = parseEnvFile(fs.readFileSync(isolation!.file, "utf8"));
    expect(parsed.PORT).toBe("3880");
    expect(parsed.SESSION_SECRET).toBe("sess");
    expect(parsed.CSRF_SECRET).toBe("csrf");
    expect(parsed.COOKIE_SECURE).toBe("false");
  });
});
