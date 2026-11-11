import type { FastifyInstance, FastifyReply } from "fastify";
export declare function setSessionCookie(reply: FastifyReply, sid: string, maxAgeSec: number, secure: boolean, domain: string): Promise<void>;
export declare function clearSessionCookie(reply: FastifyReply, domain: string): Promise<void>;
export declare function isDashboardPath(url: string): boolean;
export declare function isAdminPath(url: string): boolean;
export declare function registerAuthGuards(app: FastifyInstance): Promise<void>;
