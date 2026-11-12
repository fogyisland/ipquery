import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
/** The five DB_* values the wizard collects. */
export interface DbConnectionInput {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}
/** True when this error means "the database could not be reached". */
export declare function isDbUnreachableError(err: unknown): boolean;
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
export declare function describeDbError(err: unknown): string;
/**
 * The absolute path of the .env file the process should write to.
 *
 * `dotenv` reads `.env` from `process.cwd()`, NOT from the directory the
 * code lives in — so the wizard has to write to the same place the
 * process was started from, or the value would never be read back.
 */
export declare function envFilePath(): string;
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
export declare function envFileExists(): boolean;
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
export declare function writeDbCredentialsToEnv(input: DbConnectionInput): string;
/**
 * The settings the setup wizard can write into a freshly generated .env.
 *
 * `DB_*` is deliberately absent: the database connection is collected in
 * step 2 and written by `writeDbCredentialsToEnv`, which has to prove the
 * connection works before it puts anything on disk.
 */
export interface EnvBootstrapInput {
    port: number;
    baseUrl: string;
    sessionSecret: string;
    csrfSecret: string;
}
/**
 * Generate a random secret.
 *
 * 48 random bytes, base64-encoded. The length matters: these sign the
 * session cookies and the CSRF tokens, so the secret IS the security
 * boundary. A short or human-chosen secret is a guessable secret.
 */
export declare function generateSecret(): string;
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
export declare function resolveEnvBootstrap(existing: Record<string, string>, wanted: EnvBootstrapInput): Record<string, string>;
/**
 * Parse a .env file into a flat key/value map.
 *
 * A deliberately small parser rather than a dependency: it only has to
 * understand the shape this project writes and ships in `.env.example` —
 * `KEY=value`, optional `#` comments, optional surrounding quotes. It
 * does NOT evaluate anything, so a `.env` containing shell substitution
 * is read as the literal text it is.
 */
export declare function parseEnvFile(content: string): Record<string, string>;
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
export declare function ensureEnvFile(input: EnvBootstrapInput): {
    path: string;
    created: boolean;
};
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
export declare function databaseIsReachable(cfg: AppConfig): Promise<boolean>;
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
export declare function explainCliDbFailure(err: unknown): string | null;
/**
 * Swap the pool for one that points at a different database.
 *
 * The old pool is ended rather than left open: it holds no useful
 * connections (it just failed), and a leaked pool keeps the process
 * alive after shutdown. Ending it is best-effort — a pool that cannot
 * close must not prevent the new one from taking over.
 */
export declare function repointPool(app: FastifyInstance, input: DbConnectionInput): Promise<void>;
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
export declare function probeConnection(input: DbConnectionInput, poolSize: number, connectTimeout?: number): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
