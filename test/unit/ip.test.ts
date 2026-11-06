import { describe, it, expect } from "vitest";
import { parseIp, isValidIp, bufferToString, compareBuffers } from "../../src/ip";

describe("ip", () => {
  it("isValidIp accepts IPv4 and IPv6", () => {
    expect(isValidIp("8.8.8.8")).toBe(true);
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
  });

  it("isValidIp rejects garbage", () => {
    expect(isValidIp("999.999.999.999")).toBe(false);
    expect(isValidIp("abc")).toBe(false);
    expect(isValidIp("")).toBe(false);
  });

  it("parseIp returns 16-byte buffer", () => {
    expect(parseIp("8.8.8.8")).toHaveLength(16);
    expect(parseIp("::1")?.slice(15, 16)[0]).toBe(1);
  });

  it("parseIp IPv4 left-pads with zeros", () => {
    const b = parseIp("8.8.8.8")!;
    expect(b[0]).toBe(0);
    expect(b[1]).toBe(0);
    expect(b[2]).toBe(0);
    expect(b[12]).toBe(8);
    expect(b[13]).toBe(8);
    expect(b[14]).toBe(8);
    expect(b[15]).toBe(8);
  });

  it("parseIp returns null on invalid", () => {
    expect(parseIp("not.an.ip")).toBeNull();
    expect(parseIp("256.0.0.1")).toBeNull();
  });

  it("bufferToString round-trips", () => {
    for (const ip of ["8.8.8.8", "0.0.0.0", "255.255.255.255", "2001:db8::1"]) {
      expect(bufferToString(parseIp(ip)!)).toBe(ip);
    }
  });

  it("compareBuffers is a total order", () => {
    const a = parseIp("8.8.8.0")!;
    const b = parseIp("8.8.8.255")!;
    expect(compareBuffers(a, b)).toBeLessThan(0);
    expect(compareBuffers(b, a)).toBeGreaterThan(0);
    expect(compareBuffers(a, a)).toBe(0);
  });
});
