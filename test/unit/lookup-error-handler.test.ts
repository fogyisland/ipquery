// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { lookupErrorHandler } from "../../src/api/routes/lookup";

describe("lookupErrorHandler", () => {
  function makeReply() {
    const captured: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };
    const reply = {
      code(n: number) {
        captured.statusCode = n;
        return this;
      },
      send(b: unknown) {
        captured.body = b;
        return this;
      },
    };
    return { reply: reply as any, captured };
  }

  it("passes through invalid_ip with its statusCode", () => {
    const { reply, captured } = makeReply();
    const err = Object.assign(new Error("invalid ip: x"), { statusCode: 400, code: "invalid_ip" });
    lookupErrorHandler(err, null, reply);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: "invalid_ip" });
  });

  it("passes through not_found with its statusCode", () => {
    const { reply, captured } = makeReply();
    const err = Object.assign(new Error("not found: 1.1.1.1"), { statusCode: 404, code: "not_found" });
    lookupErrorHandler(err, null, reply);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: "not_found" });
  });

  it("does not leak err.message when error has no .code (security fix)", () => {
    const { reply, captured } = makeReply();
    const err = new Error("database password is secret");
    (err as any).statusCode = 500;
    lookupErrorHandler(err, null, reply);
    expect(captured.statusCode).toBe(500);
    const body = captured.body as { error?: string };
    expect(body.error).toBe("internal_error");
    expect(JSON.stringify(captured.body)).not.toContain("database password is secret");
  });

  it("defaults to statusCode 500 when not set on error", () => {
    const { reply, captured } = makeReply();
    lookupErrorHandler(new Error("boom"), null, reply);
    expect(captured.statusCode).toBe(500);
  });
});
