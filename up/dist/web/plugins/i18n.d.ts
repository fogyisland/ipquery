import type { FastifyInstance } from "fastify";
import { type Locale } from "../i18n";
declare module "fastify" {
    interface FastifyRequest {
        locale: Locale;
        t: (key: string, vars?: Record<string, string | number>) => string;
    }
}
export declare function registerI18n(app: FastifyInstance): Promise<void>;
