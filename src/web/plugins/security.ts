// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";

// The setup wizard loads its two webfonts (Plus Jakarta Sans, JetBrains Mono)
// from Google Fonts. Everything else on the site is same-origin only.
const SETUP_PATH = "/setup";
const FONT_STYLE_ORIGIN = "https://fonts.googleapis.com";
const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

/**
 * Third-party origins a given route is allowed to reach.
 *
 * A `<meta http-equiv="Content-Security-Policy">` cannot grant this: when a
 * document carries both a header policy and a meta policy, the browser
 * enforces the INTERSECTION — a meta tag can only tighten, never loosen. The
 * exception has to be in the header this hook writes, and it has to be
 * scoped to the wizard so the public, auth, dashboard and admin surfaces keep
 * the strict same-origin policy.
 */
function externalOriginsFor(url: string): { styles?: string; fonts?: string } {
  const pathOnly = url.split("?")[0]!.split("#")[0]!;
  if (pathOnly === SETUP_PATH || pathOnly.startsWith(`${SETUP_PATH}/`)) {
    return { styles: FONT_STYLE_ORIGIN, fonts: FONT_FILE_ORIGIN };
  }
  return {};
}

export async function registerSecurityHeaders(
  app: FastifyInstance,
  opts: { cookieSecure: boolean },
): Promise<void> {
  app.addHook("onSend", async (req, reply) => {
    const { styles, fonts } = externalOriginsFor(req.url);
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self' 'unsafe-inline'${styles ? ` ${styles}` : ""}`,
      "img-src 'self' data:",
      `font-src 'self'${fonts ? ` ${fonts}` : ""}`,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; ");

    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", csp);
    if (opts.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}
