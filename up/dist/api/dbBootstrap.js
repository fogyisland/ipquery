"use strict";
// SPDX-License-Identifier: MIT
//
// Boot without a database.
//
// The problem this file solves: a fresh install has no reachable database.
// The obvious implementation — connect, migrate, serve — dies at the
// first step with "Access denied for user 'root'@'localhost'", so the
// operator never sees the setup wizard that would let them fix exactly
// that. The install becomes a loop: the wizard is unreachable because the
// server is down, and the server is down because the wizard hasn't run.
//
// So the boot is split in two:
//
//   1. A DEGRADED boot, where the database could not be reached. The
//      server starts anyway, exposes ONLY the setup wizard, and tells the
//      operator what is wrong. Everything else answers 503 with a plain
//      explanation rather than crashing the process.
//   2. A NORMAL boot, where the database answered and the migrations ran.
//
// The transition between them is the point of the whole file: when the
// wizard saves working credentials, it re-points the pool at the new
// database, runs the migrations, and flips the server back to normal —
// all without a restart, because the operator is sitting right there in
// the browser waiting for it to work.
//
// Why the credentials live in a file and not in the database: the
// database is exactly what is not reachable yet. A password stored in the
// `settings` table could not be read in the one situation that needs it.
// The `.env` file is the only place both the failed boot and the
// successful one can reach.
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
exports.isDbUnreachableError = isDbUnreachableError;
exports.describeDbError = describeDbError;
exports.envFilePath = envFilePath;
exports.envFileExists = envFileExists;
exports.writeDbCredentialsToEnv = writeDbCredentialsToEnv;
exports.generateSecret = generateSecret;
exports.resolveEnvBootstrap = resolveEnvBootstrap;
exports.parseEnvFile = parseEnvFile;
exports.ensureEnvFile = ensureEnvFile;
exports.databaseIsReachable = databaseIsReachable;
exports.explainCliDbFailure = explainCliDbFailure;
exports.repointPool = repointPool;
exports.probeConnection = probeConnection;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const mysql_1 = require("../storage/mysql");
/**
 * A MySQL error that means "the database is not usable right now" as
 * opposed to "the database is usable and something you asked for was
 * wrong".
 *
 * These are the codes that must degrade the boot rather than kill it:
 * the server is refused, the credentials are wrong, the database does
 * not exist yet, or the handshake timed out.
 *
 * Anything else — a syntax error in a migration, a missing column — is a
 * real failure and must surface. Degrading on those would turn a bug into
 * a silently half-working install.
 */
const DEGRADING_MYSQL_CODES = new Set([
    "ECONNREFUSED", // nothing is listening on that port
    "ER_ACCESS_DENIED_ERROR", // wrong user or password
    "ER_BAD_DB_ERROR", // the database name does not exist
    "ETIMEDOUT", // the handshake timed out
    "PROTOCOL_CONNECTION_LOST", // died mid-handshake
    "ENOTFOUND", // the host does not resolve
    "EHOSTUNREACH", // no route to the host
    "ENETUNREACH", // no network at all
    "EPIPE", // the socket closed under us
]);
/** True when this error means "the database could not be reached". */
function isDbUnreachableError(err) {
    if (typeof err !== "object" || err === null)
        return false;
    const code = err.code;
    if (typeof code === "string" && DEGRADING_MYSQL_CODES.has(code))
        return true;
    // mysql2 wraps some connection failures in an AggregateError with the
    // individual causes attached.
    const errors = err.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        return errors.every((e) => isDbUnreachableError(e));
    }
    return false;
}
/**
 * A short, operator-facing description of why the database could not be
 * reached.
 *
 * Deliberately coarse: it names the kind of problem and the knob to
 * turn, without echoing the driver's raw message. A raw MySQL error can
 * contain the server version, the hostname and other details that are
 * useful to an attacker and useless to the person staring at the screen
 * (they are already on the machine).
 */
function describeDbError(err) {
    if (typeof err !== "object" || err === null)
        return "unknown error";
    const code = err.code;
    switch (code) {
        case "ECONNREFUSED":
            return "the server refused the connection — check that MySQL is running and that the host/port are right";
        case "ER_ACCESS_DENIED_ERROR":
            return "the credentials were rejected — check the user and the password";
        case "ER_BAD_DB_ERROR":
            return "that database does not exist — create it first, or use a different name";
        case "ETIMEDOUT":
            return "the connection timed out — check the host and the firewall";
        case "ENOTFOUND":
            return "the host could not be resolved — check the spelling";
        case "EHOSTUNREACH":
        case "ENETUNREACH":
            return "the host is unreachable — check the network and the firewall";
        default:
            return "the database could not be reached";
    }
}
// ── .env persistence ────────────────────────────────────────────────
/**
 * The environment variable that overrides where the .env file lives.
 *
 * The default is `<cwd>/.env`, which is what dotenv reads and therefore
 * what the process will actually use. The override exists for one
 * reason: the test suite drives the real wizard, and without an override
 * the wizard would write the TEST database into the DEVELOPER'S .env —
 * silently replacing a working local configuration with a throwaway
 * database name, and leaving a project that only runs again after the
 * developer hand-edits the file back.
 *
 * It is an escape hatch, not a feature: nothing in the shipped code sets
 * it, and it does not appear in `.env.example`, because a deployment
 * that points the wizard at some other file would write credentials
 * somewhere the process does not read them.
 */
const ENV_FILE_OVERRIDE = "IPQUERY_ENV_FILE";
/**
 * The absolute path of the .env file the process should write to.
 *
 * `dotenv` reads `.env` from `process.cwd()`, NOT from the directory the
 * code lives in — so the wizard has to write to the same place the
 * process was started from, or the value would never be read back.
 */
function envFilePath() {
    const override = process.env[ENV_FILE_OVERRIDE];
    if (override && override.trim() !== "") {
        return path.resolve(override.trim());
    }
    return path.resolve(process.cwd(), ".env");
}
/**
 * True when the .env file exists on disk.
 *
 * The wizard uses this to tell the operator WHICH file the credentials are
 * about to land in — and to say so plainly when there is no .env at all yet
 * (a fresh unpack, where the release bundle's `.env.example` was never
 * copied). "Your credentials go into .env" is only actionable if the
 * operator knows whether .env already exists; "there is no .env yet, one
 * will be created" tells them this is the first thing being written.
 */
function envFileExists() {
    return fs.existsSync(envFilePath());
}
/**
 * Rewrite the DB_* values in the .env file, keeping everything else.
 *
 * A file-rewrite, not an append: the file is an operator-editable
 * document and appending a second `DB_HOST=` line would leave the
 * effective value to dotenv's "first wins" rule — which is not a thing
 * anyone should have to reason about. The existing values are replaced
 * in place so the file stays one-key-per-line and readable.
 *
 * Keys that are not present are appended to the DB_* block, so a .env
 * without DB_POOL_SIZE still gets a complete set.
 */
function writeDbCredentialsToEnv(input) {
    const file = envFilePath();
    const values = {
        DB_HOST: input.host,
        DB_PORT: String(input.port),
        DB_USER: input.user,
        DB_PASSWORD: input.password,
        DB_NAME: input.database,
    };
    let original = "";
    if (fs.existsSync(file)) {
        original = fs.readFileSync(file, "utf8");
    }
    const lines = original.length > 0 ? original.split(/\r?\n/) : [];
    const pending = new Map(Object.entries(values));
    const out = [];
    for (const line of lines) {
        const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        const key = match?.[2];
        if (key && pending.has(key)) {
            const value = pending.get(key);
            pending.delete(key);
            const indent = match?.[1] ?? "";
            out.push(`${indent}${key}=${value}`);
            continue;
        }
        out.push(line);
    }
    // Anything left was not in the file. Append it as a block.
    if (pending.size > 0) {
        // Trim trailing blank lines so the appended block is not separated by
        // a wall of empty space.
        while (out.length > 0 && out[out.length - 1].trim() === "")
            out.pop();
        if (out.length > 0)
            out.push("");
        out.push("# Database connection — written by the setup wizard.");
        for (const [key, value] of pending) {
            out.push(`${key}=${value}`);
        }
    }
    fs.writeFileSync(file, out.join("\n"), { encoding: "utf8", mode: 0o600 });
    tightenEnvPermissions(file);
    return file;
}
/**
 * Generate a random secret.
 *
 * 48 random bytes, base64-encoded. The length matters: these sign the
 * session cookies and the CSRF tokens, so the secret IS the security
 * boundary. A short or human-chosen secret is a guessable secret.
 */
function generateSecret() {
    return crypto.randomBytes(48).toString("base64");
}
/**
 * The values a .env should have for the keys the wizard owns, computed
 * from what is already on disk.
 *
 * Existing values WIN. The operator may have hand-tuned `PORT` or set
 * `WEB_BASE_URL` to their real domain before opening the wizard, and
 * overwriting that with a generated default would undo their work — the
 * whole point of the wizard is to be safe to run on an install that
 * already has some configuration.
 *
 * Only the keys that are absent, or present but empty, are filled in.
 */
function resolveEnvBootstrap(existing, wanted) {
    const pick = (key, fallback) => {
        const current = existing[key];
        return current !== undefined && current.trim() !== "" ? current : fallback;
    };
    return {
        PORT: pick("PORT", String(wanted.port)),
        WEB_BASE_URL: pick("WEB_BASE_URL", wanted.baseUrl),
        SESSION_SECRET: pick("SESSION_SECRET", wanted.sessionSecret),
        CSRF_SECRET: pick("CSRF_SECRET", wanted.csrfSecret),
    };
}
/**
 * Parse a .env file into a flat key/value map.
 *
 * A deliberately small parser rather than a dependency: it only has to
 * understand the shape this project writes and ships in `.env.example` —
 * `KEY=value`, optional `#` comments, optional surrounding quotes. It
 * does NOT evaluate anything, so a `.env` containing shell substitution
 * is read as the literal text it is.
 */
function parseEnvFile(content) {
    const out = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match)
            continue;
        const key = match[1];
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
/**
 * Create (or complete) the .env file.
 *
 * This is the wizard's step 1: the operator opens /init on a fresh
 * unpack — where only `.env.example` exists — and the wizard writes a
 * working `.env` for them. No shell, no `cp`, no editor.
 *
 * Three sources feed the result, in order of authority:
 *
 *   1. What is already in the file. Never overwritten.
 *   2. What the operator typed on the form (port, base URL).
 *   3. What the wizard generated (the two secrets, and the defaults
 *      for the keys the operator left blank).
 *
 * The `.env.example` template is copied verbatim first, so the file keeps
 * its comments and the full key list — a `.env` that a human can read and
 * edit later, not a two-line file that only the program understands.
 *
 * Returns the path and whether anything was actually written, so the
 * caller can log accurately instead of claiming a write it did not do.
 */
function ensureEnvFile(input) {
    const file = envFilePath();
    const existed = fs.existsSync(file);
    // Two different sources, with different authority:
    //
    //   - The EXISTING .env, if there is one. Its values are the
    //     operator's real configuration and must never be overwritten.
    //   - The .env.example TEMPLATE, which is only a starting point. Its
    //     values are placeholders ("PORT=5001" is what the template
    //     happens to say), NOT a choice the operator made.
    //
    // Mixing them up is how the operator's port silently reverted to the
    // template's default. So the existing file is read first and, when it
    // exists, its values win outright; only the template path treats the
    // template's values as defaults to be replaced.
    const templatePath = path.join(path.dirname(file), ".env.example");
    const templateExists = fs.existsSync(templatePath);
    let content = "";
    if (templateExists) {
        content = fs.readFileSync(templatePath, "utf8");
    }
    else if (existed) {
        content = fs.readFileSync(file, "utf8");
    }
    else {
        content = ["# Generated by the IPQuery setup wizard.", ""].join("\n");
    }
    // The values that must survive whatever happens next.
    const preserved = existed ? parseEnvFile(fs.readFileSync(file, "utf8")) : {};
    const resolved = resolveEnvBootstrap(preserved, {
        port: input.port,
        baseUrl: input.baseUrl,
        // A secret that is already in the file is kept. One that is only in
        // the template (or in neither) is the generated one.
        sessionSecret: preserved.SESSION_SECRET?.trim() ? preserved.SESSION_SECRET : input.sessionSecret,
        csrfSecret: preserved.CSRF_SECRET?.trim() ? preserved.CSRF_SECRET : input.csrfSecret,
    });
    const lines = content.split(/\r?\n/);
    const pending = new Map(Object.entries(resolved));
    const out = [];
    for (const line of lines) {
        const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        const key = match?.[2];
        if (key && pending.has(key)) {
            const value = pending.get(key);
            pending.delete(key);
            // match[1] is the leading whitespace only — match[0] would be the
            // whole "KEY=" prefix and would produce "PORT=PORT=3880".
            const indent = match?.[1] ?? "";
            out.push(`${indent}${key}=${value}`);
            continue;
        }
        out.push(line);
    }
    if (pending.size > 0) {
        while (out.length > 0 && out[out.length - 1].trim() === "")
            out.pop();
        if (out.length > 0)
            out.push("");
        out.push("# --- generated by the setup wizard ---");
        for (const [key, value] of pending) {
            out.push(`${key}=${value}`);
        }
    }
    fs.writeFileSync(file, out.join("\n"), { encoding: "utf8", mode: 0o600 });
    tightenEnvPermissions(file);
    return { path: file, created: !existed };
}
/**
 * Make the .env file readable only by its owner.
 *
 * The `mode` option of `fs.writeFileSync` only applies when the file is
 * CREATED. When the file already exists — which is the normal case,
 * because the operator (or install.sh) copied `.env.example` to `.env`
 * first, and a copy keeps the source's 644 permissions — the mode is
 * ignored and the file keeps whatever it had.
 *
 * That matters because this file holds the database password in plain
 * text. A 644 .env means every other account on the machine can read
 * it. So the permission is set explicitly after the write, on every
 * path, whether the file was created or overwritten.
 *
 * `chmod` is a no-op on Windows for this purpose (NTFS access control
 * is not driven by the POSIX mode bits), so a failure there is not an
 * error worth aborting the wizard over — the file was written and the
 * password is in it either way.
 */
function tightenEnvPermissions(file) {
    try {
        fs.chmodSync(file, 0o600);
    }
    catch (err) {
        // Best-effort. On Windows the mode bits are advisory and chmod can
        // throw on exotic filesystems; failing the whole wizard over the
        // permission bits would be worse than the bits themselves.
        void err;
    }
}
/**
 * True when the configured database answers a ping.
 *
 * Used by the CLI's `serve` command to decide whether to run the ETL and
 * arm the cron schedule BEFORE the server starts. Both of those need a
 * database; running them against an unreachable one would either throw or
 * sit in the driver's connect timeout — and both happen before the server
 * is listening, which would defeat the degraded boot entirely.
 *
 * The connect timeout is deliberately short. This probe runs on the path
 * to serving the wizard, so a slow answer must not delay the operator's
 * way in.
 */
async function databaseIsReachable(cfg) {
    const pool = (0, mysql_1.createPoolFor)({
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        password: cfg.db.password,
        database: cfg.db.database,
        poolSize: 1,
        connectTimeout: 5000,
    });
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.ping();
        return true;
    }
    catch {
        return false;
    }
    finally {
        if (conn) {
            try {
                conn.release();
            }
            catch {
                /* ignore */
            }
        }
        try {
            await pool.end();
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * Turn a database failure into an actionable message for the CLI.
 *
 * The CLI commands that touch the database (`migrate`, `status`,
 * `seed:demo`, `init`) would otherwise die with the driver's raw error:
 *
 *   Error: connect ECONNREFUSED 127.0.0.1:3306
 *
 * Which tells an operator who is mid-install that their MySQL is not
 * running, but not what to do about it in the context of THIS
 * application — namely, that the database has not been configured yet,
 * and that the wizard at /init is where you configure it.
 *
 * Returns null when the error is not a "the database is not reachable"
 * failure, so the caller can rethrow the original error and keep the
 * real stack trace for genuine bugs.
 */
function explainCliDbFailure(err) {
    if (!isDbUnreachableError(err))
        return null;
    return (`the database could not be reached: ${describeDbError(err)}\n` +
        "If you have not configured it yet, run the server and use the setup wizard:\n" +
        "  node dist/cli.js serve\n" +
        "  # then open http://localhost:3880/init and fill in step 2 (database)\n" +
        "Otherwise check the DB_* values in your .env file.");
}
// ── Pool re-pointing ────────────────────────────────────────────────
/**
 * Swap the pool for one that points at a different database.
 *
 * The old pool is ended rather than left open: it holds no useful
 * connections (it just failed), and a leaked pool keeps the process
 * alive after shutdown. Ending it is best-effort — a pool that cannot
 * close must not prevent the new one from taking over.
 */
async function repointPool(app, input) {
    const cfg = app.cfg;
    cfg.db.host = input.host;
    cfg.db.port = input.port;
    cfg.db.user = input.user;
    cfg.db.password = input.password;
    cfg.db.database = input.database;
    const oldPool = app.pool;
    const newPool = (0, mysql_1.createPool)(cfg);
    app.pool = newPool;
    try {
        await oldPool.end();
    }
    catch {
        // A pool that won't close leaks a connection but nothing more; the
        // new pool is already in place and that is what matters.
    }
}
/**
 * Build a pool for a candidate configuration and prove it works.
 *
 * Used by the wizard to validate credentials BEFORE they are persisted —
 * the operator should not end up with a .env that cannot connect. The
 * pool is closed again whether it worked or not, so a failed attempt
 * does not leave a dangling connection.
 *
 * The connect timeout is deliberately short, and explicitly set rather
 * than left to the driver: mysql2's default is around 10 seconds, which
 * is a long time to stare at a spinner while the wizard waits for a
 * verdict on credentials the operator just typed. Five seconds is long
 * enough for a healthy handshake over a slow link and short enough that
 * a wrong host fails fast.
 */
async function probeConnection(input, poolSize, connectTimeout = 5000) {
    const pool = (0, mysql_1.createPoolFor)({
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        database: input.database,
        poolSize,
        connectTimeout,
    });
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.ping();
        return { ok: true };
    }
    catch (err) {
        return { ok: false, reason: describeDbError(err) };
    }
    finally {
        if (conn) {
            try {
                conn.release();
            }
            catch {
                /* ignore */
            }
        }
        try {
            await pool.end();
        }
        catch {
            /* ignore */
        }
    }
}
//# sourceMappingURL=dbBootstrap.js.map