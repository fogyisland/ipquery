// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

function readJson(absolutePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
}

/** An npm bin shim ends up calling `node <target>`; prove that this
 *  entry is a real Node script with a shebang and valid syntax. */
function assertNodeEntryIsRunnable(absolutePath: string): void {
  expect(fs.existsSync(absolutePath)).toBe(true);
  const firstLine = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/, 1)[0];
  expect(firstLine).toBe("#!/usr/bin/env node");
  expect(() =>
    execFileSync(process.execPath, ["--check", absolutePath], { stdio: "pipe" }),
  ).not.toThrow();
}

/** Run the real release-manifest generator against a controlled fixture
 *  so the assertion covers its output, not just the checked-in copy. */
function makeReleaseFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipquery-release-"));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(directory, "up"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
  fs.copyFileSync(
    path.join(root, "scripts", "write-release-manifest.js"),
    path.join(directory, "scripts", "write-release-manifest.js"),
  );
  return directory;
}

describe("MCP client configuration", () => {
  it("keeps the project server free of environment placeholders Claude Code cannot inject", () => {
    const config = readJson(path.join(root, ".mcp.json"));
    const servers = config.mcpServers as Record<string, unknown>;
    const server = servers.ipquery as Record<string, unknown>;
    expect(server).toBeDefined();

    const placeholders = Array.from(
      JSON.stringify(server).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g),
      (match) => match[1],
    );
    expect(placeholders).toEqual([]);
  });

  it("starts the project server through the declared bin, not a cwd-relative script path", () => {
    const config = readJson(path.join(root, ".mcp.json"));
    const server = (config.mcpServers as Record<string, Record<string, unknown>>).ipquery;
    expect(server.command).toBe("ipquery-mcp");
    expect(server.args ?? []).toEqual([]);

    const sourceManifest = readJson(path.join(root, "package.json"));
    const bin = sourceManifest.bin as Record<string, string>;
    expect(bin["ipquery-mcp"]).toBe("dist/mcp/server.js");
    assertNodeEntryIsRunnable(path.join(root, bin["ipquery-mcp"]));
  });

  it("resolves every --mcp-config path in docs/mcp.md to a real config with the ipquery server", () => {
    const documentation = fs.readFileSync(path.join(root, "docs", "mcp.md"), "utf8");
    // Only look at real command lines: the prose mentions the flag too,
    // and a mention is not an invocation. A command line either starts
    // with `claude` or continues one.
    const commandLines = documentation
      .split("\n")
      .filter((line) => /^\s*(?:claude\b|#\s*claude\b)/.test(line));
    expect(commandLines.length).toBeGreaterThan(0);

    // Both spellings are valid: `--mcp-config <path>` and
    // `--mcp-config=<path>`. The equals form is the one to prefer in
    // docs — a space-separated flag swallows whatever follows it, so
    // a prompt written after it gets read as the config path.
    const configuredPaths = Array.from(
      commandLines.join("\n").matchAll(/--mcp-config(?:=|\s+)(\S+)/g),
      (match) => match[1],
    );
    expect(configuredPaths.length).toBeGreaterThan(0);

    for (const configuredPath of configuredPaths) {
      const absolutePath = path.resolve(root, configuredPath);
      expect(fs.existsSync(absolutePath)).toBe(true);
      const config = readJson(absolutePath);
      expect(Object.keys(config.mcpServers as Record<string, unknown>)).toContain("ipquery");
    }
  });

  it("writes the MCP bin into a freshly generated release manifest", () => {
    const directory = makeReleaseFixture();
    execFileSync(process.execPath, [path.join(directory, "scripts", "write-release-manifest.js")], {
      cwd: directory,
      stdio: "pipe",
    });

    const sourceManifest = readJson(path.join(directory, "package.json"));
    const generatedManifest = readJson(path.join(directory, "up", "package.json"));
    expect(generatedManifest.bin).toEqual(sourceManifest.bin);
    expect((generatedManifest.bin as Record<string, string>)["ipquery-mcp"]).toBe(
      "dist/mcp/server.js",
    );
  });

  it("declares the MCP bin in the committed release manifest and keeps its entry runnable", () => {
    const releaseManifest = readJson(path.join(root, "up", "package.json"));
    const bin = (releaseManifest.bin ?? {}) as Record<string, string>;
    expect(bin["ipquery-mcp"]).toBe("dist/mcp/server.js");

    const relativeEntry =
      typeof bin["ipquery-mcp"] === "string" ? bin["ipquery-mcp"] : "dist/mcp/server.js";
    assertNodeEntryIsRunnable(path.join(root, "up", relativeEntry));
  });

  it("offers the MCP safety switch in both env templates", () => {
    // MCP_REQUIRE_TOKEN is the switch that makes a tokenless server
    // refuse to start. Without it in the template, an operator who
    // deploys from the template alone runs the MCP server wide open
    // on a production box — the docs are the only place it is
    // mentioned, and the docs are not what the template is read from.
    const documentation = fs.readFileSync(path.join(root, "docs", "mcp.md"), "utf8");
    expect(documentation).toContain("MCP_REQUIRE_TOKEN");

    for (const template of [".env.example", path.join("up", ".env.example")]) {
      const contents = fs.readFileSync(path.join(root, template), "utf8");
      expect(contents, `${template} must offer MCP_REQUIRE_TOKEN`).toContain(
        "MCP_REQUIRE_TOKEN",
      );
    }
  });

  it("keeps the two env templates in step with each other", () => {
    // The deploy bundle carries its own copy of the template. If the
    // two drift, the operator gets whichever one they happened to be
    // handed — so a variable that exists in one and not the other is a
    // configuration bug waiting to happen.
    const sourceKeys = envTemplateKeys(path.join(root, ".env.example"));
    const deployKeys = envTemplateKeys(path.join(root, "up", ".env.example"));
    expect(deployKeys).toEqual(sourceKeys);
  });

  it("tells a deploying operator how to run the MCP server", () => {
    // The MCP server ships in the deploy bundle and the release
    // manifest exports its bin, but a deployment guide that never
    // mentions it leaves the operator with a binary and no instructions
    // — and, more to the point, with no mention of the switch that
    // stops it from serving every tool to anyone who can start it.
    for (const document of ["setup.md", "source-deploy.md"]) {
      const contents = fs.readFileSync(path.join(root, "docs", document), "utf8");
      expect(contents, `${document} must mention the MCP server`).toMatch(/MCP/);
      expect(contents, `${document} must name the MCP safety switch`).toContain(
        "MCP_REQUIRE_TOKEN",
      );
    }
  });
});

/** The variable names a dotenv file declares, in file order.
 *  Comments, blanks and indentation do not count. */
function envTemplateKeys(absolutePath: string): string[] {
  return fs
    .readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("=")[0]!.trim())
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
}
