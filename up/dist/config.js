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
exports.loadConfig = loadConfig;
exports.redactSecret = redactSecret;
exports.configSummary = configSummary;
// SPDX-License-Identifier: MIT
require("dotenv/config"); // side-effect import: auto-loads .env into process.env at module load
const cronParser = __importStar(require("node-cron"));
function num(v, fallback) {
    if (v === undefined)
        return fallback;
    const n = Number(v);
    if (!Number.isFinite(n))
        throw new Error(`Expected number, got ${v}`);
    return n;
}
function str(v, fallback) {
    return v === undefined || v === "" ? fallback : v;
}
function bool(v, fallback) {
    if (v === undefined)
        return fallback;
    return v === "true" || v === "1";
}
function loadConfig() {
    const schedule = str(process.env.ETL_SCHEDULE, "0 2 * * *");
    if (!cronParser.validate(schedule)) {
        throw new Error(`ETL_SCHEDULE is not a valid cron expression: ${schedule}`);
    }
    const sessionTtl = num(process.env.SESSION_TTL_HOURS, 168);
    if (sessionTtl < 1)
        throw new Error("SESSION_TTL_HOURS must be >= 1");
    const loginMax = num(process.env.LOGIN_MAX_ATTEMPTS, 5);
    if (loginMax < 1)
        throw new Error("LOGIN_MAX_ATTEMPTS must be >= 1");
    return {
        db: {
            host: str(process.env.DB_HOST, "localhost"),
            port: num(process.env.DB_PORT, 3306),
            user: str(process.env.DB_USER, "root"),
            password: str(process.env.DB_PASSWORD, "rootpass"),
            database: str(process.env.DB_NAME, "ipquery"),
            poolSize: num(process.env.DB_POOL_SIZE, 10),
        },
        maxmind: {
            licenseKey: process.env.MAXMIND_LICENSE_KEY || undefined,
            editions: str(process.env.MAXMIND_EDITIONS, "GeoLite2-City,GeoLite2-ASN")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        },
        api: {
            port: num(process.env.PORT, 3000),
            rateLimit: num(process.env.RATE_LIMIT, 60),
        },
        etl: {
            schedule,
            timezone: str(process.env.ETL_TIMEZONE, "UTC"),
            dataDir: str(process.env.DATA_DIR, "./data"),
        },
        web: {
            baseUrl: str(process.env.WEB_BASE_URL, "http://localhost:3100"),
            cookieDomain: str(process.env.COOKIE_DOMAIN, ""),
            cookieSecure: bool(process.env.COOKIE_SECURE, false),
            sessionTtlHours: sessionTtl,
            sessionSecret: str(process.env.SESSION_SECRET, ""),
            csrfSecret: str(process.env.CSRF_SECRET, ""),
        },
        smtp: {
            host: str(process.env.SMTP_HOST, ""),
            port: num(process.env.SMTP_PORT, 587),
            secure: bool(process.env.SMTP_SECURE, false),
            user: str(process.env.SMTP_USER, ""),
            pass: str(process.env.SMTP_PASS, ""),
            from: str(process.env.SMTP_FROM, "IPQuery <noreply@example.com>"),
        },
        security: {
            loginMaxAttempts: loginMax,
            loginLockoutMinutes: num(process.env.LOGIN_LOCKOUT_MINUTES, 15),
            signupRatePerIpPerHour: num(process.env.SIGNUP_RATE_PER_IP_PER_HOUR, 5),
            verifyResendCooldownSeconds: num(process.env.VERIFY_RESEND_COOLDOWN_SECONDS, 60),
        },
        admin: {
            email: str(process.env.ADMIN_BOOTSTRAP_EMAIL, ""),
            password: str(process.env.ADMIN_BOOTSTRAP_PASSWORD, ""),
        },
    };
}
function redactSecret(value) {
    if (value.length <= 8)
        return "*".repeat(value.length);
    return value.slice(0, 4) + "…" + value.slice(-4);
}
function configSummary(cfg) {
    const lines = [
        `[config] db=${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`,
        `[config] maxmind key=${cfg.maxmind.licenseKey ? redactSecret(cfg.maxmind.licenseKey) : "(none)"}`,
        `[config] editions=${cfg.maxmind.editions.join(",")}`,
        `[config] api port=${cfg.api.port} rateLimit=${cfg.api.rateLimit}/min`,
        `[config] etl schedule="${cfg.etl.schedule}" tz=${cfg.etl.timezone} dataDir=${cfg.etl.dataDir}`,
        `[config] web baseUrl=${cfg.web.baseUrl} cookieSecure=${cfg.web.cookieSecure}`,
        `[config] smtp host=${cfg.smtp.host || "(console)"} from=${cfg.smtp.from}`,
        `[config] session secret=${cfg.web.sessionSecret ? redactSecret(cfg.web.sessionSecret) : "(unset)"}`,
        `[config] csrf secret=${cfg.web.csrfSecret ? redactSecret(cfg.web.csrfSecret) : "(unset)"}`,
    ];
    return lines.join("\n");
}
//# sourceMappingURL=config.js.map