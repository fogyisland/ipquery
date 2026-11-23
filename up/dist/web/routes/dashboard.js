"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = dashboardRoutes;
const queryLog_1 = require("../../storage/queryLog");
const apiKeys_1 = require("../../storage/apiKeys");
const users_1 = require("../../storage/users");
const tokens_1 = require("../auth/tokens");
const password_1 = require("../auth/password");
const sessions_1 = require("../../storage/sessions");
const csrf_1 = require("../plugins/csrf");
const country_names_1 = require("../../country-names");
const mcpTokens_1 = require("../../storage/mcpTokens");
const paths_1 = require("../../paths");
/** Pill colour per MCP token status, so the table reads the same way as
 *  the other status cells in the console. */
const MCP_PILL_KIND = {
    pending: "warning",
    approved: "success",
    rejected: "danger",
    revoked: "muted",
};
/** Decorate the token rows with their labels already resolved. The
 *  template cannot call req.t with a computed key, so the translation
 *  happens here, where the request locale is known. */
function decorateTokens(tokens, req) {
    return tokens.map((token) => ({
        ...token,
        scopeLabel: req.t(`dashboard.mcp.scope.${token.scope}`),
        statusLabel: req.t(`dashboard.mcp.status.${token.status}`),
        pillKind: MCP_PILL_KIND[token.status] ?? "muted",
    }));
}
async function dashboardRoutes(app) {
    // /dashboard/* is already gated by the auth guard in src/web/plugins/auth.ts:
    // unauthenticated requests are redirected to /login?next=... before this
    // handler runs, so req.user is guaranteed non-null here.
    app.get("/dashboard", async (req, reply) => {
        // Filter to the current user: each /dashboard is per-account, so showing
        // global counts would leak other users' query volume + hit rate.
        const [counts, lastQuery] = await Promise.all([
            (0, queryLog_1.countQueriesByStatusSince)(app.pool, new Date(Date.now() - 7 * 86400_000), { userId: req.user.id }),
            (0, queryLog_1.getLastUserQuery)(app.pool, req.user.id),
        ]);
        // `country_name` is NULL for every ETL-loaded row, so the name comes
        // from the ISO 3166-1 table instead. Localised, because this is the
        // user's own dashboard.
        const lastQueryNames = (0, country_names_1.countryNamesFor)(lastQuery?.countryCode ?? null);
        const lastQueryCountryName = lastQuery?.countryName ||
            (req.locale === "zh-CN" ? lastQueryNames?.zh : lastQueryNames?.en) ||
            null;
        return reply.view("dashboard/index.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.title"),
            counts,
            lastQuery: lastQuery ? { ...lastQuery, countryName: lastQueryCountryName } : null,
            req,
        });
    });
    app.get("/dashboard/history", async (req, reply) => {
        const q = req.query;
        const page = Math.max(1, Number(q.page) || 1);
        const limit = 25;
        const offset = (page - 1) * limit;
        const { rows, total } = await (0, queryLog_1.listQueryLogs)(app.pool, {
            offset,
            limit,
            userId: req.user.id,
            status: q.status,
        });
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const queryParts = [];
        if (q.status)
            queryParts.push(`status=${encodeURIComponent(q.status)}`);
        const queryString = queryParts.join("&");
        return reply.view("dashboard/history.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.history.title"),
            rows,
            page,
            totalPages,
            status: q.status ?? "",
            queryString,
            req,
        });
    });
    app.get("/dashboard/keys", async (req, reply) => {
        const keys = await (0, apiKeys_1.listApiKeysForUser)(app.pool, req.user.id);
        // Endpoint template — shown next to each key so users know where to
        // send requests. Driven by WEB_BASE_URL so the value updates if the
        // site is re-deployed under a different domain.
        const baseUrl = (app.cfg.web.baseUrl ?? "").replace(/\/+$/, "");
        const endpoint = `${baseUrl}/api/v1/lookup?ip=8.8.8.8&key=YOUR_KEY`;
        return reply.view("dashboard/keys.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.keys.title"),
            keys,
            endpoint,
            baseUrl,
            req,
        });
    });
    app.post("/dashboard/keys", {
        config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const label = (req.body.label ?? "").trim();
        if (!label || label.length > 64) {
            const keys = await (0, apiKeys_1.listApiKeysForUser)(app.pool, req.user.id);
            return reply.code(400).view("dashboard/keys.hbs", {
                layout: "layouts/dashboard",
                title: req.t("dashboard.keys.title"),
                flash: { error: "invalid label" },
                keys,
                req,
            });
        }
        const plaintext = (0, tokens_1.generateApiKey)();
        const keyHash = (0, tokens_1.hashToken)(plaintext);
        const keyPrefix = plaintext.slice(0, 8);
        await (0, apiKeys_1.createApiKey)(app.pool, req.user.id, label, keyHash, keyPrefix);
        const keys = await (0, apiKeys_1.listApiKeysForUser)(app.pool, req.user.id);
        return reply.view("dashboard/keys.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.keys.title"),
            newKeyPlain: plaintext,
            keys,
            req,
        });
    });
    app.post("/dashboard/keys/:id/revoke", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        const key = await (0, apiKeys_1.findApiKeyById)(app.pool, id);
        if (!key || key.userId !== req.user.id) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        req.auditAction = {
            action: "key.revoke",
            targetType: "api_key",
            targetId: id,
            metadata: { source: "dashboard" },
        };
        await (0, apiKeys_1.revokeApiKey)(app.pool, id);
        return reply.code(302).redirect("/dashboard/keys");
    });
    app.get("/dashboard/keys/:id/revoke/confirm", async (req, reply) => {
        const id = Number(req.params.id);
        const key = await (0, apiKeys_1.findApiKeyById)(app.pool, id);
        if (!key || key.userId !== req.user.id) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        return reply.view("dashboard/key-revoke-confirm.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.keys.revoke.confirm.title"),
            key,
            req,
        });
    });
    app.get("/dashboard/mcp-tokens", async (req, reply) => {
        const tokens = decorateTokens(await (0, mcpTokens_1.listMcpTokensForUser)(app.pool, req.user.id), req);
        // The client snippet needs a concrete server path. It is built from the
        // project root so the pasted configuration stays valid wherever the
        // repository lives — an absolute path would tie the user to one machine.
        const serverPath = `${(0, paths_1.resolveProjectRoot)()}/dist/mcp/server.js`;
        // The token plaintext is never recoverable, so the snippet is shown
        // only when the user has an approved token and knows its own value;
        // otherwise it points at the env var the user must fill in themselves.
        const approved = tokens.find((t) => t.status === "approved");
        const clientConfig = approved
            ? JSON.stringify({
                mcpServers: {
                    ipquery: {
                        type: "stdio",
                        command: "node",
                        args: [serverPath],
                        env: { IPQUERY_MCP_TOKEN: "<在此填入你的 Token>" },
                    },
                },
            }, null, 2)
            : null;
        const scopeOptions = [
            { value: "lookup", label: req.t("dashboard.mcp.scope.lookup") },
            { value: "ops", label: req.t("dashboard.mcp.scope.ops") },
        ];
        return reply.view("dashboard/mcp-tokens.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.mcp.title"),
            tokens,
            scopeOptions,
            scopeSelected: "lookup",
            clientConfig,
            req,
        });
    });
    app.post("/dashboard/mcp-tokens", {
        config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const body = req.body;
        const label = (body.label ?? "").trim();
        const scope = body.scope === "ops" ? "ops" : "lookup";
        if (!label || label.length > 64) {
            const tokens = decorateTokens(await (0, mcpTokens_1.listMcpTokensForUser)(app.pool, req.user.id), req);
            return reply.code(400).view("dashboard/mcp-tokens.hbs", {
                layout: "layouts/dashboard",
                title: req.t("dashboard.mcp.title"),
                flash: { error: req.t("dashboard.keys.invalidLabel") },
                tokens,
                scopeOptions: [
                    { value: "lookup", label: req.t("dashboard.mcp.scope.lookup") },
                    { value: "ops", label: req.t("dashboard.mcp.scope.ops") },
                ],
                scopeSelected: scope,
                req,
            });
        }
        const plaintext = (0, tokens_1.generateMcpToken)();
        await (0, mcpTokens_1.createMcpToken)(app.pool, req.user.id, label, (0, tokens_1.hashToken)(plaintext), plaintext.slice(0, 12), scope);
        const tokens = decorateTokens(await (0, mcpTokens_1.listMcpTokensForUser)(app.pool, req.user.id), req);
        return reply.view("dashboard/mcp-tokens.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.mcp.title"),
            flash: { success: req.t("dashboard.mcp.requestSubmitted") },
            newTokenPlain: plaintext,
            tokens,
            scopeOptions: [
                { value: "lookup", label: req.t("dashboard.mcp.scope.lookup") },
                { value: "ops", label: req.t("dashboard.mcp.scope.ops") },
            ],
            scopeSelected: scope,
            req,
        });
    });
    app.post("/dashboard/mcp-tokens/:id/revoke", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        const token = await (0, mcpTokens_1.findMcpTokenById)(app.pool, id);
        if (!token || token.userId !== req.user.id) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        req.auditAction = {
            action: "mcp_token.revoke",
            targetType: "mcp_token",
            targetId: id,
            metadata: { source: "dashboard" },
        };
        await (0, mcpTokens_1.revokeMcpToken)(app.pool, id);
        return reply.code(302).redirect("/dashboard/mcp-tokens");
    });
    app.get("/dashboard/mcp-tokens/:id/revoke/confirm", async (req, reply) => {
        const id = Number(req.params.id);
        const token = await (0, mcpTokens_1.findMcpTokenById)(app.pool, id);
        if (!token || token.userId !== req.user.id) {
            return reply
                .code(404)
                .view("errors/404.hbs", { layout: "layouts/public", title: req.t("error.404.title"), req });
        }
        return reply.view("dashboard/mcp-token-revoke-confirm.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.mcp.revoke.confirm.title"),
            token,
            req,
        });
    });
    app.get("/dashboard/profile", async (req, reply) => {
        // req.user is guaranteed non-null: registerAuthGuards already 302-redirects
        // unauthenticated requests for /dashboard/* paths before this handler runs.
        return reply.view("dashboard/profile.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.title"),
            req,
        });
    });
    // The profile split into three pages. The top-nav account menu links
    // to all three, so each destination needs its own URL — a menu whose
    // entries are anchors into one long form is a menu where every entry
    // looks like a mistake.
    //
    //   /dashboard/profile           — the account overview
    //   /dashboard/profile/details   — display name and email
    //   /dashboard/profile/password  — the password form
    //
    // The POST stays at /dashboard/profile with an `action` field, so the
    // existing form posts and their tests keep working unchanged.
    app.get("/dashboard/profile/details", async (req, reply) => {
        return reply.view("dashboard/profile-details.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.details.title"),
            req,
        });
    });
    app.get("/dashboard/profile/password", async (req, reply) => {
        return reply.view("dashboard/profile-password.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.password.title"),
            req,
        });
    });
    app.post("/dashboard/profile", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const body = req.body;
        const action = body.action ?? "";
        // Each action answers on the page its form lives on. Rendering the
        // details form's result on the password page (or vice versa)
        // would drop the user on a page whose form they did not just fill
        // in, and the flash message would land on a page with nothing to
        // show it against.
        //
        // The helpers RETURN the view promise. `reply.view()` sends the
        // response itself; if the handler does not await it, Fastify sees
        // an un-settled handler and sends an empty 200 first — which is
        // exactly the "Reply was already sent" error.
        //
        // `refreshUser` re-reads the account row after a change. `req.user`
        // is the row as it was when the request arrived, so a handler that
        // saves and then renders without refreshing it shows the user their
        // OLD nickname back — the page says "saved" and displays the value
        // they just replaced, which reads as a failed save.
        //
        // `req.session.email` is refreshed alongside it. The session plugin
        // copies the email onto the session when the request arrives, and
        // three views render that copy (the sidebar footer, the admin
        // topbar, the admin dashboard greeting) — so leaving it stale
        // would show the old address in the chrome of the very page that
        // changed it.
        const refreshUser = async () => {
            const fresh = await (0, users_1.findUserById)(app.pool, req.user.id);
            if (!fresh)
                return;
            req.user = fresh;
            if (req.session) {
                req.session.email = fresh.email;
                req.session.role = fresh.role;
            }
        };
        const detailsView = (flash, status = 200) => reply.code(status).view("dashboard/profile-details.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.details.title"),
            flash,
            req,
        });
        const passwordView = (flash, status = 200) => reply.code(status).view("dashboard/profile-password.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.password.title"),
            flash,
            req,
        });
        if (action === "displayName") {
            const dn = (body.displayName ?? "").trim();
            if (!dn || dn.length > 64) {
                return detailsView({ error: "invalid display_name" }, 400);
            }
            await (0, users_1.updateDisplayName)(app.pool, req.user.id, dn);
            await refreshUser();
            return detailsView({ success: req.t("dashboard.profile.saved") });
        }
        if (action === "email") {
            const email = (body.email ?? "").trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return detailsView({ error: "invalid email" }, 400);
            }
            await (0, users_1.updateEmail)(app.pool, req.user.id, email);
            // email_verified is reset by updateEmail; re-verify by admin or via verification flow (out of scope here)
            // For simplicity in MVP, we just save the new email. Production: trigger re-verification.
            await refreshUser();
            return detailsView({ success: req.t("dashboard.profile.saved") });
        }
        if (action === "password") {
            const old = body.oldPassword ?? "";
            const newPw = body.newPassword ?? "";
            const v = (0, password_1.validatePassword)(newPw);
            if (!v.ok) {
                return passwordView({ error: req.t("auth.signup.error.password_weak") }, 400);
            }
            const hash = await (0, users_1.getUserPasswordHash)(app.pool, req.user.id);
            if (!hash || !(await (0, password_1.verifyPassword)(hash, old))) {
                return passwordView({ error: "old_password_incorrect" }, 401);
            }
            await (0, users_1.updatePassword)(app.pool, req.user.id, await (0, password_1.hashPassword)(newPw));
            // Evict any other browser/device that was logged in as this user
            // (matching the forgot/reset flow's security posture). Keep the
            // current session alive — the user is actively using their own
            // browser; booting them out of a successful save would be hostile.
            // req.session is guaranteed non-null inside /dashboard/* (auth
            // guard would have redirected otherwise).
            const evicted = await (0, sessions_1.destroyAllForUserExcept)(app.pool, req.user.id, req.session.id);
            return passwordView({
                success: evicted > 0
                    ? req.t("dashboard.profile.savedWithEviction", { count: String(evicted) })
                    : req.t("dashboard.profile.saved"),
            });
        }
        return reply.code(400).view("dashboard/profile.hbs", {
            layout: "layouts/dashboard",
            title: req.t("dashboard.profile.title"),
            flash: { error: "unknown action" },
            req,
        });
    });
}
//# sourceMappingURL=dashboard.js.map