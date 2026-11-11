// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { isInitialized } from "../../storage/settings";

declare module "fastify" {
  interface FastifyInstance {
    requireSetup: boolean;
  }
}

const SETUP_PATH = "/init";
const SETUP_COMPLETE_PATH = "/init/complete";

// Public routes that must remain reachable while the wizard is up. Adding a
// new public API route? Add it here too, otherwise initGuard will redirect
// it to /init and external integrations / probes will break.
const PUBLIC_API_PATHS = new Set(["/healthz", "/lookup", "/stats"]);
const ASSETS_PREFIX = "/assets/";

function isAllowedUrl(url: string): boolean {
  if (url === SETUP_PATH) return true;
  if (url.startsWith(`${SETUP_PATH}/`)) return true;
  if (PUBLIC_API_PATHS.has(url)) return true;
  if (url.startsWith(ASSETS_PREFIX)) return true;
  return false;
}

function isSetupCompletePath(url: string, method: string): boolean {
  return url === SETUP_COMPLETE_PATH && method === "POST";
}

export async function registerInitGuard(app: FastifyInstance): Promise<void> {
  const initialized = await isInitialized(app.pool);
  app.decorate("requireSetup", !initialized);

  app.addHook("onRequest", async (req, reply) => {
    const url = (req.routeOptions?.url ?? req.url) as string;
    const pathOnly = url.split("?")[0]!;

    if (app.requireSetup) {
      if (isAllowedUrl(pathOnly)) return;
      return reply.code(302).header("Location", "/init").send();
    }

    if (pathOnly === SETUP_PATH || pathOnly.startsWith(`${SETUP_PATH}/`)) {
      return reply.code(404).send("Not Found");
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!isSetupCompletePath(req.url.split("?")[0]!, req.method)) return;
    // Only skip on 4xx/5xx: `POST /init/complete` returns 302, and that
    // redirect is the entire point of the hook (the wizard has just called
    // `markInitialized(app.pool)` and we need to flip the boot-cached flag
    // before the user's next request). Skipping on 3xx left the cache stale
    // and `/login` got redirected back to `/init`.
    if (reply.statusCode >= 400) return;
    const fresh = await isInitialized(app.pool);
    app.requireSetup = !fresh;
  });
}
