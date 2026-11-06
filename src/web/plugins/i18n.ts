// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from "fastify";
import { t, parseLocale, type Locale } from "../i18n";

(globalThis as { __ipqT?: typeof t }).__ipqT = t;

declare module "fastify" {
  interface FastifyRequest {
    locale: Locale;
    t: (key: string, vars?: Record<string, string | number>) => string;
  }
}

export async function registerI18n(app: FastifyInstance): Promise<void> {
  app.decorateRequest("locale", "zh-CN" as Locale);
  app.decorateRequest("t", null as unknown as (k: string, v?: Record<string, string | number>) => string);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const raw = req.cookies?.lang;
    req.locale = parseLocale(raw);
    req.t = (key, vars) => t(req.locale, key, vars);
  });
}
