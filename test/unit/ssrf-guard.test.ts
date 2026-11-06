// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { assertSafeHttpUrl } from "../../src/storage/ssrf";

// We mock node:dns/promises so test runs don't actually hit the DNS
// resolver for "api.ipify.com" etc. By default every mocked hostname
// resolves to 1.1.1.1 (public, safe).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, _opts?: unknown) => {
    return [{ address: "1.1.1.1", family: 4 }];
  }),
}));

describe("assertSafeHttpUrl — SSRF guard", () => {
  it("rejects http://localhost/foo", async () => {
    const r = await assertSafeHttpUrl("http://localhost/foo");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_hostname_localhost/);
  });

  it("rejects http://127.0.0.1/foo", async () => {
    const r = await assertSafeHttpUrl("http://127.0.0.1/foo");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_ip_127/);
  });

  it("rejects http://10.0.0.5/foo", async () => {
    const r = await assertSafeHttpUrl("http://10.0.0.5/foo");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_ip_10/);
  });

  it("rejects http://192.168.1.1/foo", async () => {
    const r = await assertSafeHttpUrl("http://192.168.1.1/foo");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_ip_192/);
  });

  it("rejects http://169.254.169.254/latest/meta-data/ (AWS metadata)", async () => {
    const r = await assertSafeHttpUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_ip_169/);
  });

  it("rejects file:///etc/passwd", async () => {
    const r = await assertSafeHttpUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_scheme_file/);
  });

  it("rejects javascript:alert(1)", async () => {
    const r = await assertSafeHttpUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_scheme_javascript/);
  });

  it("accepts https://api.ipify.com/foo when DNS resolves to a public IP", async () => {
    const r = await assertSafeHttpUrl("https://api.ipify.com/foo");
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("rejects a hostname that resolves to a private IP (DNS check)", async () => {
    // Override the mock to simulate a DNS-poisoned hostname.
    const dns = await import("node:dns/promises");
    const lookupMock = dns.lookup as unknown as ReturnType<typeof vi.fn>;
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const r = await assertSafeHttpUrl("https://attacker.example/foo");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/resolved_to_blocked_10/);
  });

  it("rejects an unparseable URL", async () => {
    const r = await assertSafeHttpUrl("not a url at all");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_url/);
  });
});
