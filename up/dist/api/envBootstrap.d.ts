/**
 * Create the .env file if it does not exist yet.
 *
 * Returns what happened, so the boot can log it:
 *   - `created: true`  a new .env was written from .env.example
 *   - `created: false` an .env was already there and was left untouched
 *
 * Never throws. A boot that dies because it could not write a config
 * file is worse than a boot that starts with the defaults and says so —
 * the operator can always create the file by hand, but they cannot
 * create it from a process that refused to start.
 */
export declare function bootstrapEnvFile(): {
    path: string;
    created: boolean;
    error?: string;
};
/**
 * The values the generated .env ended up with.
 *
 * Exported for the boot log and the tests — the operator should be able
 * to see that the file was written and what it contains, without the
 * secrets themselves ever being printed.
 */
export declare function readEnvValues(file: string): Record<string, string>;
