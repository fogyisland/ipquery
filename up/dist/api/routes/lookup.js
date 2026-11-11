"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lookupErrorHandler = lookupErrorHandler;
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
function ipFromReq(req) {
    const q = req.query.ip;
    if (q)
        return q;
    const p = req.params?.ip;
    if (p)
        return p;
    return undefined;
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
        const sessionUserId = req.session?.userId;
        const isAuthed = req.apiKey !== undefined || sessionUserId !== undefined;
        if (!isAuthed)
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
            userId: req.apiKey?.userId ?? sessionUserId ?? null,
            apiKeyId: req.apiKey?.keyId ?? null,
            sessionId: req.apiKey ? null : (req.session?.id ?? null),
            remoteAddr: remoteBuf,
            userAgent: req.headers["user-agent"] ?? null,
        };
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
}
//# sourceMappingURL=lookup.js.map