"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = authRoutes;
const Handlebars = __importStar(require("handlebars"));
const users_1 = require("../../storage/users");
const tokens_1 = require("../../storage/tokens");
const password_1 = require("../auth/password");
const tokens_2 = require("../auth/tokens");
const csrf_1 = require("../plugins/csrf");
const auth_1 = require("../plugins/auth");
const loginRateLimit_1 = require("../plugins/loginRateLimit");
const verifyResendCooldown_1 = require("../plugins/verifyResendCooldown");
const sessions_1 = require("../../storage/sessions");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const EMAIL_TEMPLATES_DIR = path.join(__dirname, "..", "emails");
let verifyEmailTemplate = null;
async function getVerifyEmailTpl() {
    if (verifyEmailTemplate)
        return verifyEmailTemplate;
    const src = await fs.readFile(path.join(EMAIL_TEMPLATES_DIR, "verify-email.hbs"), "utf8");
    verifyEmailTemplate = Handlebars.compile(src);
    return verifyEmailTemplate;
}
let resetPasswordTemplate = null;
async function getResetPasswordTpl() {
    if (resetPasswordTemplate)
        return resetPasswordTemplate;
    const src = await fs.readFile(path.join(EMAIL_TEMPLATES_DIR, "reset-password.hbs"), "utf8");
    resetPasswordTemplate = Handlebars.compile(src);
    return resetPasswordTemplate;
}
async function authRoutes(app) {
    // GET /signup
    app.get("/signup", async (req, reply) => {
        return reply.view("auth/signup.hbs", { layout: "layouts/auth", title: req.t("auth.signup.title"), req });
    });
    // POST /signup
    app.post("/signup", {
        config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const body = req.body;
        const email = (body.email ?? "").trim().toLowerCase();
        const password = body.password ?? "";
        const displayName = (body.displayName ?? "").trim();
        const error = (msg) => reply.code(400).view("auth/signup.hbs", {
            layout: "layouts/auth",
            title: req.t("auth.signup.title"),
            error: msg,
            req,
        });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return error(req.t("auth.signup.error.email_format"));
        if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
            return error(req.t("auth.signup.error.password_weak"));
        // FIX (Task 14): brief line 103 incorrectly returned email_format for displayName error
        if (displayName.length === 0 || displayName.length > 64)
            return error(req.t("auth.signup.error.displayName_invalid"));
        if (await (0, users_1.findUserByEmail)(app.pool, email))
            return reply.code(409).view("auth/signup.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.signup.title"),
                error: req.t("auth.signup.error.duplicate"),
                req,
            });
        const passwordHash = await (0, password_1.hashPassword)(password);
        const user = await (0, users_1.createUser)(app.pool, { email, passwordHash, displayName });
        // admin bootstrap: only when users table was empty
        const [rows] = await app.pool.query("SELECT COUNT(*) AS c FROM users");
        if (Number(rows[0]?.c) === 1 &&
            app.cfg.admin.email &&
            app.cfg.admin.password &&
            app.cfg.admin.email === email) {
            await app.pool.query(`UPDATE users SET role = 'admin' WHERE id = ?`, [user.id]);
        }
        // send verification email
        const token = (0, tokens_2.generateToken)();
        const tokenHash = (0, tokens_2.hashToken)(token);
        await (0, tokens_1.createVerification)(app.pool, user.id, tokenHash, new Date(Date.now() + 86_400_000));
        const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
        const html = await (await getVerifyEmailTpl())({ verifyUrl });
        await app.mailer.send({
            to: email,
            subject: "IPQuery 邮箱验证",
            text: `请访问以下链接验证邮箱:\n${verifyUrl}`,
            html,
        });
        return reply.code(200).view("auth/signup-success.hbs", {
            layout: "layouts/auth",
            title: req.t("auth.signup.success.title"),
            message: req.t("auth.signup.success.body"),
            req,
        });
    });
    // GET /verify
    app.get("/verify", async (req, reply) => {
        const token = req.query.token ?? "";
        if (!token)
            return reply.code(401).view("auth/verify-result.hbs", {
                layout: "layouts/auth",
                title: req.t("verify.title"),
                success: false,
                message: req.t("verify.invalid"),
                reason: "invalid",
                req,
            });
        const tokenHash = (0, tokens_2.hashToken)(token);
        const v = await (0, tokens_1.findVerificationByHash)(app.pool, tokenHash);
        if (!v)
            return reply.code(401).view("auth/verify-result.hbs", {
                layout: "layouts/auth",
                title: req.t("verify.title"),
                success: false,
                message: req.t("verify.invalid"),
                reason: "invalid",
                req,
            });
        if (v.consumedAt)
            return reply.code(410).view("auth/verify-result.hbs", {
                layout: "layouts/auth",
                title: req.t("verify.title"),
                success: false,
                message: req.t("verify.consumed"),
                reason: "consumed",
                req,
            });
        if (v.expiresAt.getTime() < Date.now())
            return reply.code(410).view("auth/verify-result.hbs", {
                layout: "layouts/auth",
                title: req.t("verify.title"),
                success: false,
                message: req.t("verify.expired"),
                reason: "expired",
                req,
            });
        await (0, users_1.markEmailVerified)(app.pool, v.userId);
        await (0, tokens_1.consumeVerification)(app.pool, v.id);
        return reply.code(302).redirect("/login?verified=1");
    });
    // POST /verify/resend
    //
    // Two protections, both needed:
    //
    //  - A route-level rate limit. The global limit is 60/minute, which
    //    is far too generous for an endpoint that sends an email per
    //    call. A tight per-IP limit is the outer bound.
    //
    //  - A per-requester cooldown, keyed on the requester's IP rather
    //    than on the target userId. The cooldown used to be keyed on the
    //    target, which only stopped repeated sends to the SAME user —
    //    an attacker walking `userId` 1..N would send one email to every
    //    user and be blocked by nothing.
    app.post("/verify/resend/:userId", {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: "1 hour",
                // Key on the requester's IP, not on the target userId, so a
                // single caller cannot spread requests across many ids.
                keyGenerator: (req) => req.ip,
            },
        },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const userId = Number(req.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
            return reply.code(404).redirect("/login");
        }
        // Per-requester cooldown: one verification email per IP per
        // cooldown window, whatever user is being targeted.
        const cooldownMs = app.cfg.security.verifyResendCooldownSeconds * 1000;
        if ((0, verifyResendCooldown_1.isResendOnCooldown)(req.ip, cooldownMs)) {
            return reply.code(429).redirect("/login?cooldown=1");
        }
        const u = await (0, users_1.findUserById)(app.pool, userId);
        if (!u)
            return reply.code(404).redirect("/login");
        const token = (0, tokens_2.generateToken)();
        const tokenHash = (0, tokens_2.hashToken)(token);
        await (0, tokens_1.createVerification)(app.pool, userId, tokenHash, new Date(Date.now() + 86_400_000));
        (0, verifyResendCooldown_1.startResendCooldown)(req.ip, cooldownMs);
        const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
        const html = await (await getVerifyEmailTpl())({ verifyUrl });
        await app.mailer.send({
            to: u.email,
            subject: "IPQuery 邮箱验证",
            text: `请访问以下链接验证邮箱:\n${verifyUrl}`,
            html,
        });
        return reply.code(302).redirect("/login?resent=1");
    });
    // GET /login
    app.get("/login", async (req, reply) => {
        const q = req.query;
        const viewData = { req };
        let notice = {};
        if (q.verified)
            notice.success = req.t("verify.success");
        if (q.disabled)
            notice.error = req.t("auth.login.error.disabled");
        if (q.verify_required)
            notice.info = req.t("auth.verify.required");
        viewData.flash = notice;
        if (q.verify_required && q.userId) {
            viewData.verifyRequired = true;
            viewData.verifyUserId = q.userId;
        }
        return reply.view("auth/login.hbs", {
            layout: "layouts/auth",
            title: req.t("auth.login.title"),
            ...viewData,
        });
    });
    // POST /login
    app.post("/login", {
        config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const body = req.body;
        const email = (body.email ?? "").trim().toLowerCase();
        const password = body.password ?? "";
        const lock = (0, loginRateLimit_1.isLocked)(email);
        if (lock.locked) {
            return reply.code(429).view("auth/login.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.login.title"),
                error: req.t("auth.login.error.locked", { minutes: Math.ceil(lock.retryAfterSec / 60) }),
                req,
            });
        }
        const user = await (0, users_1.findUserByEmail)(app.pool, email);
        if (!user) {
            (0, loginRateLimit_1.recordLoginFailure)(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
            return reply.code(401).view("auth/login.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.login.title"),
                error: req.t("auth.login.error.credentials"),
                email,
                req,
            });
        }
        const hash = await (0, users_1.getUserPasswordHash)(app.pool, user.id);
        const ok = hash ? await (0, password_1.verifyPassword)(hash, password) : false;
        if (!ok) {
            (0, loginRateLimit_1.recordLoginFailure)(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
            return reply.code(401).view("auth/login.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.login.title"),
                error: req.t("auth.login.error.credentials"),
                email,
                req,
            });
        }
        if (!user.emailVerified) {
            return reply.code(302).redirect(`/login?verify_required=1&userId=${user.id}`);
        }
        if (user.isDisabled) {
            return reply.code(302).redirect("/login?disabled=1");
        }
        (0, loginRateLimit_1.recordLoginSuccess)(email);
        const sid = (0, tokens_2.generateToken)(16);
        const expiresAt = new Date(Date.now() + app.cfg.web.sessionTtlHours * 3600_000);
        await (0, sessions_1.createSession)(app.pool, sid, user.id, expiresAt);
        await (0, users_1.setLastLogin)(app.pool, user.id);
        await (0, auth_1.setSessionCookie)(reply, sid, app.cfg.web.sessionTtlHours * 3600, app.cfg.web.cookieSecure, app.cfg.web.cookieDomain);
        // Everyone lands at /dashboard after login — it's the personal console, the
        // place a user starts every session. Admins get a CTA in the sidebar to
        // jump to /admin (see partials/sidebar.hbs); regular users never see admin
        // chrome at all. /admin auth guard 403s non-admins who try to follow the
        // link, so this is safe.
        const fallback = "/dashboard";
        const next = body.next && body.next.startsWith("/") ? body.next : fallback;
        return reply.code(302).redirect(next);
    });
    // POST /logout
    app.post("/logout", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        if (req.session)
            await (0, sessions_1.destroySession)(app.pool, req.session.id);
        await (0, auth_1.clearSessionCookie)(reply, app.cfg.web.cookieDomain);
        return reply.code(302).redirect("/");
    });
    // GET /forgot
    app.get("/forgot", async (req, reply) => {
        return reply.view("auth/forgot.hbs", { layout: "layouts/auth", title: req.t("auth.forgot.title"), req });
    });
    // POST /forgot
    app.post("/forgot", {
        config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const email = (req.body.email ?? "").trim().toLowerCase();
        const user = await (0, users_1.findUserByEmail)(app.pool, email);
        if (user) {
            const token = (0, tokens_2.generateToken)();
            const tokenHash = (0, tokens_2.hashToken)(token);
            await (0, tokens_1.createPasswordReset)(app.pool, user.id, tokenHash, new Date(Date.now() + 2 * 3600_000));
            const resetUrl = `${app.cfg.web.baseUrl}/reset?token=${encodeURIComponent(token)}`;
            const html = await (await getResetPasswordTpl())({ resetUrl });
            await app.mailer.send({
                to: user.email,
                subject: "IPQuery 密码重置",
                text: `请访问以下链接重置密码:\n${resetUrl}`,
                html,
            });
        }
        return reply.view("auth/forgot.hbs", {
            layout: "layouts/auth",
            title: req.t("auth.forgot.title"),
            flash: { success: req.t("auth.forgot.done") },
            req,
        });
    });
    // GET /reset
    app.get("/reset", async (req, reply) => {
        const token = req.query.token ?? "";
        if (!token)
            return reply
                .code(400)
                .view("errors/404.hbs", { layout: "layouts/auth", title: req.t("error.404.title"), req });
        const v = await (0, tokens_1.findPasswordResetByHash)(app.pool, (0, tokens_2.hashToken)(token));
        if (!v || v.consumedAt || v.expiresAt.getTime() < Date.now()) {
            return reply.code(410).view("auth/reset.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.reset.title"),
                error: req.t("verify.expired"),
                token: "",
                req,
            });
        }
        return reply.view("auth/reset.hbs", {
            layout: "layouts/auth",
            title: req.t("auth.reset.title"),
            token,
            req,
        });
    });
    // POST /reset
    app.post("/reset", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return reply.code(403).view("errors/csrf.hbs", { layout: "layouts/public", req });
        const body = req.body;
        const token = body.token ?? "";
        const password = body.password ?? "";
        const passwordConfirm = body.passwordConfirm ?? "";
        const v = await (0, tokens_1.findPasswordResetByHash)(app.pool, (0, tokens_2.hashToken)(token));
        if (!v || v.consumedAt || v.expiresAt.getTime() < Date.now()) {
            return reply.code(410).view("auth/reset.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.reset.title"),
                error: req.t("verify.expired"),
                token,
                req,
            });
        }
        const v1 = (0, password_1.validatePassword)(password);
        if (!v1.ok)
            return reply.code(400).view("auth/reset.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.reset.title"),
                error: req.t("auth.signup.error.password_weak"),
                token,
                req,
            });
        if (password !== passwordConfirm)
            return reply.code(400).view("auth/reset.hbs", {
                layout: "layouts/auth",
                title: req.t("auth.reset.title"),
                error: req.t("auth.signup.error.password_mismatch"),
                token,
                req,
            });
        const newHash = await (0, password_1.hashPassword)(password);
        await (0, users_1.updatePassword)(app.pool, v.userId, newHash);
        await (0, tokens_1.consumePasswordReset)(app.pool, v.id);
        await (0, sessions_1.destroyAllForUser)(app.pool, v.userId);
        return reply.code(302).redirect("/login?reset=1");
    });
}
//# sourceMappingURL=auth.js.map