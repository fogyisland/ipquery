"use strict";
// SPDX-License-Identifier: MIT
//
// The degraded-mode gate.
//
// When the database could not be reached at boot, the server serves the
// setup wizard and nothing else. Every other route would throw "Pool is
// closed" / "no connection" on its first query, and the operator would
// see a stack trace instead of "configure your database first".
//
// WHY THIS IS A SEPARATE PLUGIN, REGISTERED EARLY
//
// Fastify runs `onRequest` hooks in registration order, and the FIRST one
// to reply wins — the rest never run. The session hook is an onRequest
// hook that queries the database: it loads the session behind the `sid`
// cookie. If the gate were registered after it (the obvious place, next
// to the routes), a request carrying a stale `sid` cookie would hit the
// session hook FIRST, that hook would query a dead pool, and the request
// would come back 500 `{"error":"internal_error"}` instead of the clean
// 503 that tells the operator what to do.
//
// That is not a hypothetical: a browser that visited the site before the
// database went down still carries the `sid` cookie, so EVERY API call
// would 500. The gate therefore has to be registered BEFORE the session
// hook, and it has to be obvious that this ordering is deliberate — hence
// a plugin with its own file, rather than an inline hook in server.ts
// where a future edit could easily move it.
//
// The gate reads `app.dbDegraded` at REQUEST time, not at registration
// time, because the wizard flips that flag the moment it saves working
// credentials. The transition from degraded to normal therefore takes
// effect on the very next request, with no restart.
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDegradedGate = registerDegradedGate;
/**
 * Register the degraded-mode gate.
 *
 * Must be called BEFORE `registerSession` / `registerAuthGuards` /
 * `registerCsrf`, so that a degraded server answers 503 instead of
 * letting those hooks query a database that is not there.
 */
function registerDegradedGate(app) {
    app.addHook("onRequest", async (req, reply) => {
        if (!app.dbDegraded)
            return;
        const pathOnly = (req.routeOptions?.url ?? req.url).split("?")[0];
        // The wizard and its assets are the whole point of a degraded server.
        if (pathOnly.startsWith("/init"))
            return;
        if (pathOnly.startsWith("/assets/"))
            return;
        if (pathOnly === "/healthz") {
            // Health checks must report the real state, not pretend to be
            // fine: a load balancer polling a server that cannot reach its
            // database should take it out of rotation.
            return reply.code(503).type("application/json").send({
                status: "degraded",
                reason: "the database is not configured yet",
            });
        }
        return reply
            .code(503)
            .type("text/plain; charset=utf-8")
            .send("IPQuery is running in setup-only mode: the database could not be reached.\n" +
            "Open /init to configure the database connection.\n");
    });
}
//# sourceMappingURL=degradedGate.js.map