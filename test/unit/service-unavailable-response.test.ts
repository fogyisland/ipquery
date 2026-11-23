// SPDX-License-Identifier: MIT
//
// A 503 must say "try again later" without explaining the database.
//
// The storage layer distinguishes two kinds of failure behind the same
// 503: the service is up but a dependency is not available right now.
// That distinction is worth making to the client — a 500 invites an
// alert and a give-up, a 503 invites a retry — but the REASON is
// internal.
//
// The full message names the IP range table, the ETL swap, and the
// operator's probe script. None of that belongs in a response to an
// anonymous caller of the public `/lookup` endpoint: it describes the
// shape of the datastore, and it tells an attacker that something
// specific is held.
//
// So the error carries two messages: the internal one (for the log)
// and a short public one (for the client). These tests pin the split.
import { describe, it, expect } from "vitest";
import { createGlobalErrorHandler } from "../../src/api/errorHandler";

describe("the 503 response", () => {
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
    return { reply: reply as never, captured };
  }

  function makeReq() {
    const logs: { level: string; obj: unknown }[] = [];
    const req = {
      log: {
        error: (obj: unknown) => logs.push({ level: "error", obj }),
        warn: (obj: unknown) => logs.push({ level: "warn", obj }),
      },
    };
    return { req: req as never, logs };
  }

  it("answers 503 with a retryable code rather than internal_error", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const err = Object.assign(
      new Error("metadata lock timeout after 10s: the IP range table is held by another session"),
      { statusCode: 503, code: "service_unavailable" },
    );

    createGlobalErrorHandler()(err, req, reply);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: "service_unavailable" });
    // 500's body would tell the client nothing.
    expect(JSON.stringify(captured.body)).not.toContain("internal_error");
  });

  it("does not leak the internal reason to the client", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const err = Object.assign(
      new Error(
        "metadata lock timeout after 10s: the IP range table is held by another session " +
          "(an ETL swap or a LOCK TABLES). Find the holder with scripts/dev/probe-lock-queue.ts",
      ),
      { statusCode: 503, code: "service_unavailable" },
    );

    createGlobalErrorHandler()(err, req, reply);

    const body = JSON.stringify(captured.body);
    expect(body).not.toContain("ip_ranges");
    expect(body).not.toContain("IP range table");
    expect(body).not.toContain("probe-lock-queue");
    expect(body).not.toContain("ETL");
    expect(body).not.toMatch(/metadata lock/i);
  });

  it("gives the client something it can act on", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const err = Object.assign(new Error("internal detail"), {
      statusCode: 503,
      code: "service_unavailable",
    });

    createGlobalErrorHandler()(err, req, reply);

    // A body with only an error code and no message is not much help.
    // The client should be able to tell that retrying is the right move.
    const body = captured.body as { error: string; message?: string };
    expect(body.error).toBe("service_unavailable");
    expect(typeof body.message).toBe("string");
    expect(body.message!.length).toBeGreaterThan(0);
  });

  it("still logs the full reason for the operator", () => {
    const { reply } = makeReply();
    const { req, logs } = makeReq();
    const err = Object.assign(new Error("metadata lock timeout: the IP range table is held"), {
      statusCode: 503,
      code: "service_unavailable",
    });

    createGlobalErrorHandler()(err, req, reply);

    // The operator must keep the whole story even though the client
    // does not get it. The log carries the error object itself, so the
    // check is on the error's message rather than on a stringified
    // object — `JSON.stringify(new Error(...))` is `{}`, because an
    // Error's own properties are not enumerable.
    expect(logs.length).toBeGreaterThan(0);
    const logged = logs.flatMap((l) => {
      const obj = l.obj as { err?: { message?: string } };
      return obj.err?.message ? [obj.err.message] : [];
    });
    expect(logged.some((m) => m.includes("IP range table"))).toBe(true);
  });

  it("a plain 503 without a recognised code still does not leak its message", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const err = Object.assign(new Error("ER_NO_SUCH_TABLE: table ip_ranges_secret does not exist"), {
      statusCode: 503,
      code: "ER_NO_SUCH_TABLE",
    });

    createGlobalErrorHandler()(err, req, reply);

    expect(captured.statusCode).toBe(503);
    expect(JSON.stringify(captured.body)).not.toContain("ip_ranges_secret");
  });
});
