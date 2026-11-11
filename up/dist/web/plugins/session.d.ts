import type { FastifyInstance } from "fastify";
import type { Session, User } from "../../types";
declare module "fastify" {
    interface FastifyRequest {
        session: (Session & {
            role?: User["role"];
            email?: string;
        }) | null;
        user: User | null;
    }
}
export declare function registerSession(app: FastifyInstance): Promise<void>;
