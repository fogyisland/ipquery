// SPDX-License-Identifier: MIT
//
// The global error handler exists because Fastify's fallback serialises
// `error.message` into the response body. For a driver error that
// message is the raw MySQL text — table names, column names, the
// database name, the server version — handed to whoever triggered the
// error.
//
// These tests pin the contract: a 5xx never leaks its message, a
// deliberate client-facing error keeps its code, and a 404 does not
// echo the requested path back.
import { describe, it, expect } from "vitest";
import { createGlobalErrorHandler, createNotFoundHandler } from "../../src/api/errorHandler";
import { redactKeyParam } from "../../src/api/server";

describe("createGlobalErrorHandler", () => {
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

  it("does not leak a SQL error message on a 500", () => {
    const { reply, captured } = makeReply();
    const { req, logs } = makeReq();
    const handler = createGlobalErrorHandler();
    const err = Object.assign(
      new Error(
        "ER_PARSE_ERROR: You have an error in your SQL syntax near 'SELECT * FROM secret_table' at line 1",
      ),
      { statusCode: 500, code: "ER_PARSE_ERROR" },
    );
    handler(err, req, reply);

    expect(captured.statusCode).toBe(500);
    expect(captured.body).toEqual({ error: "internal_error" });
    // The response must not contain any part of the driver message.
    expect(JSON.stringify(captured.body)).not.toContain("secret_table");
    expect(JSON.stringify(captured.body)).not.toContain("ER_PARSE_ERROR");
    // But the operator must still get the full error.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("error");
    expect(logs[0]!.obj).toMatchObject({ err });
  });

  it("defaults to 500 when the error carries no statusCode", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    createGlobalErrorHandler()(new Error("boom"), req, reply);
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toEqual({ error: "internal_error" });
  });

  it("keeps a deliberate client-facing error's code and message", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const handler = createGlobalErrorHandler();
    const err = Object.assign(new Error("invalid api key"), {
      statusCode: 401,
      code: "invalid_api_key",
    });
    handler(err, req, reply);
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({
      error: "invalid_api_key",
      message: "invalid api key",
    });
  });

  it("does not leak the message of an unrecognised 4xx", () => {
    const { reply, captured } = makeReply();
    const { req } = makeReq();
    const handler = createGlobalErrorHandler();
    const err = Object.assign(new Error("table users_secret does not exist"), {
      statusCode: 400,
      code: "ER_NO_SUCH_TABLE",
    });
    handler(err, req, reply);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: "ER_NO_SUCH_TABLE" });
    expect(JSON.stringify(captured.body)).not.toContain("users_secret");
  });
});

describe("createNotFoundHandler", () => {
  it("returns a fixed body without echoing the requested path", () => {
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
    createNotFoundHandler()({ url: "/admin/internal-secret" } as never, reply as never);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: "not_found" });
    expect(JSON.stringify(captured.body)).not.toContain("internal-secret");
  });
});

describe("redactKeyParam", () => {
  it("redacts the key query parameter", () => {
    expect(redactKeyParam("/lookup?ip=8.8.8.8&key=ipq_secret")).toBe(
      "/lookup?ip=8.8.8.8&key=REDACTED",
    );
  });

  it("redacts a leading key parameter", () => {
    expect(redactKeyParam("/lookup?key=ipq_secret&ip=8.8.8.8")).toBe(
      "/lookup?key=REDACTED&ip=8.8.8.8",
    );
  });

  it("redacts a key with no other parameters", () => {
    expect(redactKeyParam("/lookup?key=ipq_secret")).toBe("/lookup?key=REDACTED");
  });

  it("leaves a URL with no key parameter alone", () => {
    expect(redactKeyParam("/lookup?ip=8.8.8.8")).toBe("/lookup?ip=8.8.8.8");
    expect(redactKeyParam("/admin/users")).toBe("/admin/users");
  });

  it("does not touch a parameter that merely contains 'key'", () => {
    expect(redactKeyParam("/lookup?monkey=banana")).toBe("/lookup?monkey=banana");
  });
});
