// SPDX-License-Identifier: MIT
//
// The HTML error pages.
//
// Every rejected request in the web UI lands here rather than on a bare
// JSON body, and the CSRF page in particular makes a promise: it says "you
// can retry" and gives the visitor a button that goes somewhere useful.
//
// The CSRF page used to point every visitor at /init, which told a
// signed-in user with a stale tab that their installation had vanished.
// The renderer now answers with three different destinations depending on
// who is asking, and this file is what keeps that mapping honest.
import { describe, it, expect } from "vitest";
import { sendErrorPage, sendCsrfPage, type ErrorPage } from "../../src/web/errors/render";

interface Captured {
  statusCode: number;
  view: string;
  data: Record<string, unknown>;
}

/** A reply stand-in that records what the renderer asked it to send. */
function makeReply(options?: { session?: { userId: number }; url?: string }) {
  const captured: Captured = { statusCode: 0, view: "", data: {} };
  const req = {
    session: options?.session,
    url: options?.url ?? "/admin/ranges",
    // The real request carries the request's locale; the tests only
    // need to see WHICH key was asked for, so the translator echoes it.
    t: (key: string) => `t:${key}`,
  };
  const reply = {
    request: req,
    code(n: number) {
      captured.statusCode = n;
      return this;
    },
    view(name: string, data: Record<string, unknown>) {
      captured.view = name;
      captured.data = data;
      return this;
    },
  };
  return { reply: reply as never, captured, req };
}

describe("sendErrorPage", () => {
  const cases: Array<{ page: ErrorPage; view: string; title: string }> = [
    { page: "forbidden", view: "errors/403.hbs", title: "error.403.title" },
    { page: "notFound", view: "errors/404.hbs", title: "error.404.title" },
    { page: "server", view: "errors/500.hbs", title: "error.500.title" },
  ];

  for (const c of cases) {
    it(`renders ${c.view} for the ${c.page} page`, () => {
      const { reply, captured } = makeReply();
      sendErrorPage(reply, 403, c.page);
      expect(captured.view).toBe(c.view);
    });

    it(`titles the ${c.page} page with its own key`, () => {
      const { reply, captured } = makeReply();
      sendErrorPage(reply, 403, c.page);
      expect(captured.data.title).toBe(`t:${c.title}`);
    });
  }

  it("sets the status code it was given", () => {
    const { reply, captured } = makeReply();
    sendErrorPage(reply, 404, "notFound");
    expect(captured.statusCode).toBe(404);
  });

  it("renders through the public layout, so a signed-out visitor gets a page", () => {
    // The dashboard and admin shells both assume a session. An error page
    // must not, or a 403 would itself fail to render.
    const { reply, captured } = makeReply();
    sendErrorPage(reply, 403, "forbidden");
    expect(captured.data.layout).toBe("layouts/public");
  });

  it("hands the request to the template so it can translate itself", () => {
    const { reply, captured, req } = makeReply();
    sendErrorPage(reply, 500, "server");
    expect(captured.data.req).toBe(req);
  });
});

describe("sendCsrfPage", () => {
  it("sends the caller back where they came from when signed in", () => {
    const { reply, captured } = makeReply({
      session: { userId: 7 },
      url: "/admin/ranges?page=2",
    });
    sendCsrfPage(reply, 403);
    // The query string is dropped: retrying the page with the same
    // parameters is what the visitor meant, but the form that failed was
    // a POST, and the destination has to be a GET-able URL.
    expect(captured.data.csrfBackHref).toBe("/admin/ranges");
  });

  it("labels the button as a retry for a signed-in visitor", () => {
    const { reply, captured } = makeReply({ session: { userId: 7 } });
    sendCsrfPage(reply, 403);
    expect(captured.data.csrfBackLabel).toBe("t:error.csrf.retry");
  });

  it("sends an anonymous visitor to the sign-in page", () => {
    const { reply, captured } = makeReply({ url: "/admin/ranges" });
    sendCsrfPage(reply, 403);
    expect(captured.data.csrfBackHref).toBe("/login");
    expect(captured.data.csrfBackLabel).toBe("t:error.csrf.signIn");
  });

  it("treats a session without a user id as signed out", () => {
    // `req.session` exists on every request once the session plugin has
    // run, but `userId` is only there once somebody is signed in.
    const { reply, captured } = makeReply({ session: {} as never });
    sendCsrfPage(reply, 403);
    expect(captured.data.csrfBackHref).toBe("/login");
  });

  it("uses the status code it was given", () => {
    const { reply, captured } = makeReply({ session: { userId: 7 } });
    sendCsrfPage(reply, 503);
    expect(captured.statusCode).toBe(503);
  });

  it("renders the csrf view through the public layout", () => {
    const { reply, captured } = makeReply();
    sendCsrfPage(reply, 403);
    expect(captured.view).toBe("errors/csrf.hbs");
    expect(captured.data.layout).toBe("layouts/public");
  });

  it("keeps an empty request url as an empty destination", () => {
    // `req.url` is always a string in Fastify, so the split never
    // yields undefined and the `?? "/"` in the renderer is unreachable.
    // This pins what actually happens rather than what the fallback
    // implies — an assertion that says "/" would be a test that passes
    // for the wrong reason.
    const { reply, captured } = makeReply({ session: { userId: 7 }, url: "" });
    sendCsrfPage(reply, 403);
    expect(captured.data.csrfBackHref).toBe("");
  });
});
