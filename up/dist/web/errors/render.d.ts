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
/**
 * Render one of the `errors/*.hbs` views through the public shell.
 *
 * Every page route that refuses a request uses this, so a rejected request
 * lands on the same typographic surface as the rest of the site instead of a
 * bare JSON body. `layouts/public` is deliberate: an error page must render
 * for someone who is signed out, so it cannot assume the dashboard or admin
 * shell.
 */
export declare function sendErrorPage(reply: FastifyReply, status: number, page: ErrorPage): FastifyReply;
/**
 * The stale-form page: a POST arrived with a CSRF token that no longer
 * matches the session, usually because the tab outlived the session or the
 * cookie was cleared. The caller is not at fault and nothing was changed, so
 * the page explains how to retry rather than treating it as an attack.
 *
 * `status` is 403 for a rejected form and 503 when the CSRF machinery itself
 * cannot answer (the admin POST handlers use both).
 */
export declare function sendCsrfPage(reply: FastifyReply, status: number): FastifyReply;
