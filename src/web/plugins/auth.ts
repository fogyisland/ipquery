// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const COOKIE_BASE = { httpOnly: true, sameSite: "lax" as const, path: "/" };

export async function setSessionCookie(
  reply: FastifyReply,
  sid: string,
  maxAgeSec: number,
  secure: boolean,
  domain: string,
): Promise<void> {
  reply.setCookie("sid", sid, { ...COOKIE_BASE, maxAge: maxAgeSec, secure, domain: domain || undefined });
}

export async function clearSessionCookie(reply: FastifyReply, domain: string): Promise<void> {
  reply.setCookie("sid", "", { ...COOKIE_BASE, maxAge: 0, domain: domain || undefined });
}

export function isDashboardPath(url: string): boolean {
  return url === "/dashboard" || url.startsWith("/dashboard/");
}

export function isAdminPath(url: string): boolean {
  return url === "/admin" || url.startsWith("/admin/");
}

export async function registerAuthGuards(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.routeOptions?.url ?? req.url;
    if (isDashboardPath(url)) {
      if (!req.user) return reply.code(302).redirect(`/login?next=${encodeURIComponent(req.url)}`);
      if (req.user.isDisabled) return reply.code(302).redirect("/login?disabled=1");
    } else if (isAdminPath(url)) {
      if (!req.user || req.user.role !== "admin")
        return reply.code(403).view("errors/403.hbs", { layout: "layouts/public", req });
      if (req.user.isDisabled) return reply.code(302).redirect("/login?disabled=1");
    }
  });
}
