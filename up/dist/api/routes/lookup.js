"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lookupErrorHandler = lookupErrorHandler;
exports.callerOf = callerOf;
exports.default = lookupRoute;
const ip_1 = require("../../ip");
const apiKeys_1 = require("../../storage/apiKeys");
const tokens_1 = require("../../web/auth/tokens");
const lookup_core_1 = require("../../lookup-core");
async function doLookup(app, ip) {
    return (0, lookup_core_1.doLookupCore)(app.pool, app.log, ip);
}
function lookupErrorHandler(err, _req, reply) {
    const statusCode = err.statusCode ?? 500;
    const code = err.code;
    if (code === "invalid_ip" || code === "not_found" || code === "invalid_api_key") {
        return reply.code(statusCode).send({ error: code });
    }
    // 503 is a temporary dependency problem, not a broken service. The
    // client is told so, and told to retry — but not why: the reason
    // names the IP range table and the ETL swap, which is the shape of
    // the datastore and nobody else's business.
    //
    // This handler exists so the global one cannot leak a driver message
    // out of /lookup. It must not collapse 503 into `internal_error`:
    // that says "we are broken" when the truth is "come back in a
    // moment", and an API client that trusts the difference will page
    // someone instead of retrying.
    if (statusCode === 503 && code === "service_unavailable") {
        return reply.code(statusCode).send({ error: code });
    }
    return reply.code(statusCode).send({ error: "internal_error" });
}
/**
 * Extract the API key from the request.
 *
 * The `Authorization: Bearer` header is the preferred form. The
 * `?key=` query parameter is still accepted for backwards
 * compatibility, but it is the leaky form: the key lands in the
 * access log, in proxy logs, in browser history and in Referer
 * headers. Callers using it get a `Deprecation` header pointing at the
 * header form.
 */
function extractKey(req) {
    const h = req.headers["authorization"];
    if (typeof h === "string" && h.startsWith("Bearer ")) {
        return { key: h.slice(7), fromQuery: false };
    }
    const xh = req.headers["x-api-key"];
    if (typeof xh === "string" && xh.length > 0) {
        return { key: xh, fromQuery: false };
    }
    const q = req.query?.key;
    if (typeof q === "string" && q.length > 0)
        return { key: q, fromQuery: true };
    return { key: null, fromQuery: false };
}
/**
 * Who is making this request, if anyone can be identified.
 *
 * This is the single place that decides whether a query is attributable.
 * It is shared by the API route and the browser's /try form so the two
 * cannot drift apart: the form used to log nothing at all, which meant
 * the analytics page counted no browser traffic.
 */
function callerOf(req) {
    const sessionUserId = req.session?.userId;
    if (req.apiKey !== undefined) {
        return {
            userId: req.apiKey.userId,
            apiKeyId: req.apiKey.keyId,
            sessionId: null,
        };
    }
    if (sessionUserId !== undefined) {
        return {
            userId: sessionUserId,
            apiKeyId: null,
            sessionId: req.session?.id ?? null,
        };
    }
    return null;
}
function ipFromReq(req) {
    const q = req.query.ip;
    if (q)
        return q;
    const p = req.params?.ip;
    if (p)
        return p;
    return undefined;
}
/** Parse a JSON string without throwing.
 *
 *  Used only on a payload this server produced itself, so a failure here
 *  means the payload was not what we thought — there is nothing to log
 *  and nothing to fix at this point, so it returns undefined rather than
 *  taking the request down. */
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
async function lookupRoute(app) {
    app.setErrorHandler(lookupErrorHandler);
    const preHandler = async (req, reply) => {
        const { key: raw, fromQuery } = extractKey(req);
        if (!raw)
            return;
        if (fromQuery) {
            // Nudge clients off the leaky form without breaking them.
            reply.header("Deprecation", "true");
            reply.header("Link", '</lookup>; rel="successor-version"; documentation="use the Authorization: Bearer header instead of the key query parameter"');
        }
        const found = await (0, apiKeys_1.findActiveApiKeyByHash)(app.pool, (0, tokens_1.hashToken)(raw));
        if (!found) {
            const err = new Error("invalid api key");
            err.statusCode = 401;
            err.code = "invalid_api_key";
            throw err;
        }
        req.apiKey = { keyId: found.id, userId: found.userId, prefix: found.keyPrefix };
        // Stamp last_used_at so /dashboard/keys shows when each key was last
        // exercised. The storage layer throttles this to at most one write
        // per key per minute — the exact timestamp nobody can perceive is
        // not worth a DB round-trip on every request.
        await (0, apiKeys_1.touchApiKey)(app.pool, found.id);
    };
    const logOnSend = async (req, reply, payload) => {
        // Two auth paths produce an attributable caller: an API key (X-API-key
        // / Bearer / ?key=) or a logged-in web session. Without one of those
        // we have no userId and the row would be anonymous — better to skip
        // than to inflate analytics with unattributable traffic. The public
        // /lookup endpoint stays usable for unauthenticated callers; we just
        // don't log it.
        const caller = callerOf(req);
        if (!caller)
            return payload;
        // In Fastify 4, payload is already serialized to a string by the time onSend runs.
        // Detect status from reply.statusCode + request context (which IP was asked).
        const statusCode = reply.statusCode;
        const ipText = ipFromReq(req);
        let status;
        if (statusCode === 200) {
            status = "hit";
        }
        else if (statusCode === 404) {
            status = "miss";
        }
        else if (statusCode === 400) {
            status = "invalid";
        }
        else {
            // 401 invalid_api_key or other auth failures → don't log
            return payload;
        }
        if (!ipText)
            return payload;
        const buf = (0, ip_1.parseIp)(ipText);
        if (!buf)
            return payload;
        const remoteBuf = req.ip ? (0, ip_1.parseIp)(req.ip) : null;
        req.pendingLog = {
            ip: buf,
            ipText,
            status,
            // API-key auth: attribute to the key's owning user + the key itself.
            // Session auth: attribute to the session user + the session id; no
            // api_key_id since the lookup was made from the browser, not a key.
            userId: caller.userId,
            apiKeyId: caller.apiKeyId,
            sessionId: caller.sessionId,
            remoteAddr: remoteBuf,
            userAgent: req.headers["user-agent"] ?? null,
        };
        return payload;
    };
    /**
     * The batch's counterpart to `logOnSend`.
     *
     * A batch contributes one query-log row per address, because the log
     * answers "which addresses were asked about" — a batch of a hundred
     * that logged one row would understate the traffic by a factor of a
     * hundred and make the "top addresses" page wrong.
     *
     * The status of each address comes from its own answer: a hit, a miss
     * (not in the library), or invalid. A request that was refused
     * outright — a malformed body, or more addresses than the cap — never
     * reached a lookup, so it logs nothing.
     */
    const logBatchOnSend = async (req, reply, payload) => {
        const caller = callerOf(req);
        if (!caller)
            return payload;
        if (reply.statusCode !== 200)
            return payload;
        // Fastify hands `onSend` the payload already serialized when the route
        // declares no response schema, so it arrives as a JSON string. A route
        // that did declare one would hand over the object. Both are accepted:
        // the log row must not depend on which shape the payload took.
        const answer = (typeof payload === "string" ? safeJsonParse(payload) : payload);
        const entries = answer?.results;
        if (!Array.isArray(entries))
            return payload;
        const remoteBuf = req.ip ? (0, ip_1.parseIp)(req.ip) : null;
        const userAgent = req.headers["user-agent"] ?? null;
        const rows = [];
        for (const entry of entries) {
            if (!entry || typeof entry.ip !== "string")
                continue;
            const buf = (0, ip_1.parseIp)(entry.ip);
            if (!buf)
                continue;
            rows.push({
                ip: buf,
                ipText: entry.ip,
                status: entry.found ? "hit" : "miss",
                userId: caller.userId,
                apiKeyId: caller.apiKeyId,
                sessionId: caller.sessionId,
                remoteAddr: remoteBuf,
                userAgent,
            });
        }
        if (rows.length > 0)
            req.pendingLog = rows;
        return payload;
    };
    app.get("/lookup", { preHandler, onSend: logOnSend }, async (req, reply) => {
        const ip = req.query.ip;
        // The error code carries everything the caller needs. The rejected
        // input is NOT echoed back: it is unbounded in length (isValidIp
        // has no size cap) and reflecting it into a response is a
        // content-reflection pattern that becomes a real injection the
        // moment any downstream consumer renders this body as HTML.
        if (!ip || !(0, ip_1.isValidIp)(ip))
            return reply.code(400).send({ error: "invalid_ip" });
        return doLookup(app, ip);
    });
    app.get("/lookup/:ip", { preHandler, onSend: logOnSend }, async (req, reply) => {
        const ip = req.params.ip;
        if (!(0, ip_1.isValidIp)(ip))
            return reply.code(400).send({ error: "invalid_ip" });
        return doLookup(app, ip);
    });
    /**
     * Look several addresses up in one call.
     *
     * A POST, not a GET: a hundred addresses do not fit in a URL, and a URL
     * lands in every access log and proxy log on the way. A body does not.
     *
     * The batch never fails as a whole. One malformed address does not cost
     * the caller the other ninety-nine answers — the bad one is marked and
     * the rest land. The caller's job is reconciliation, and a single bad
     * line in a log file must not cost them the file.
     *
     * The cap is refused rather than applied silently. A caller who asked
     * for a hundred and one addresses would otherwise get a hundred answers
     * that looked like all of them, and a reconciliation built on that
     * would quietly miss a row.
     */
    app.post("/lookup/batch", { preHandler, onSend: logBatchOnSend }, async (req, reply) => {
        const body = req.body;
        const ips = body?.ips;
        if (!Array.isArray(ips) || ips.length === 0) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        if (ips.length > lookup_core_1.MAX_BATCH_SIZE) {
            return reply.code(400).send({
                error: "invalid_request",
                message: `at most ${lookup_core_1.MAX_BATCH_SIZE} addresses per request`,
            });
        }
        // Every entry has to be a string before anything is looked up. A
        // number or an object in the list is a caller's bug, and answering
        // it with a "invalid_ip" marker would hide the bug behind a
        // plausible-looking answer — the caller would never learn their
        // client sent the wrong shape.
        if (!ips.every((ip) => typeof ip === "string")) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        const trimmed = ips.map((ip) => ip.trim());
        const answer = await (0, lookup_core_1.doLookupBatchCore)(app.pool, app.log, trimmed);
        return reply.send(answer);
    });
}
//# sourceMappingURL=lookup.js.map