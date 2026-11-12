import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyInstance {
        requireSetup: boolean;
    }
}
/**
 * Register the setup guard.
 *
 * Two things happen here, and both must happen at BOOT:
 *
 *   1. The `requireSetup` decorator is added. Fastify refuses to add a
 *      decorator after the server has started (FST_ERR_DEC_AFTER_START),
 *      so it cannot be added later from a route handler.
 *
 *   2. The request hooks are installed. Fastify likewise refuses to add
 *      a hook after `ready()` (FST_ERR_INSTANCE_ALREADY_LISTENING).
 *
 * That is why the DEGRADED boot — where the database cannot be reached
 * and the initialization state therefore cannot be read — still calls
 * this function, passing `knownInitialized: false`. The install is by
 * definition uninitialized when there is no database to ask, so the
 * answer is known without asking.
 *
 * The wizard does NOT re-register the guard once it has connected: the
 * hooks are already installed and the `requireSetup` flag is already
 * false for an uninitialized install. What the wizard does flip is
 * `app.dbDegraded`, which is what actually opens the rest of the
 * application — see the gate in src/web/plugins/degradedGate.ts.
 */
export declare function registerInitGuard(app: FastifyInstance, opts?: {
    knownInitialized?: boolean;
}): Promise<void>;
