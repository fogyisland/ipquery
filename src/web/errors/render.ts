// SPDX-License-Identifier: MIT
import type { FastifyReply } from "fastify";

/**
 * Which HTML error page a rejected request gets.
 *
 * - `forbidden` — the caller is signed in but lacks the role.
 * - `notFound`  — the page does not exist, or must not be distinguishable
 *                 from one that does not exist.
 * - `server`    — an internal fault the caller cannot act on.
 */
export type ErrorPage = "forbidden" | "notFound" | "server";

const VIEW_FOR: Record<ErrorPage, string> = {
  forbidden: "errors/403.hbs",
  notFound: "errors/404.hbs",
  server: "errors/500.hbs",
};

const TITLE_KEY: Record<ErrorPage, string> = {
  forbidden: "error.403.title",
  notFound: "error.404.title",
  server: "error.500.title",
};

/**
 * Render one of the `errors/*.hbs` views through the public shell.
 *
 * Every page route that refuses a request uses this, so a rejected request
 * lands on the same typographic surface as the rest of the site instead of a
 * bare JSON body. `layouts/public` is deliberate: an error page must render
 * for someone who is signed out, so it cannot assume the dashboard or admin
 * shell.
 */
export function sendErrorPage(reply: FastifyReply, status: number, page: ErrorPage): FastifyReply {
  const req = reply.request;
  return reply.code(status).view(VIEW_FOR[page], {
    layout: "layouts/public",
    title: req.t(TITLE_KEY[page]),
    req,
  });
}

/**
 * The stale-form page: a POST arrived with a CSRF token that no longer
 * matches the session, usually because the tab outlived the session or the
 * cookie was cleared. The caller is not at fault and nothing was changed, so
 * the page explains how to retry rather than treating it as an attack.
 *
 * `status` is 403 for a rejected form and 503 when the CSRF machinery itself
 * cannot answer (the admin POST handlers use both).
 */
export function sendCsrfPage(reply: FastifyReply, status: number): FastifyReply {
  const req = reply.request;
  return reply.code(status).view("errors/csrf.hbs", {
    layout: "layouts/public",
    title: req.t("error.csrf.title"),
    req,
  });
}
