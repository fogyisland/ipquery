import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        apiKey?: {
            keyId: number;
            userId: number;
            prefix: string;
        };
    }
}
export declare function lookupErrorHandler(err: unknown, _req: unknown, reply: {
    code: (n: number) => {
        send: (b: unknown) => unknown;
    };
    send: (b: unknown) => unknown;
}): unknown;
export default function lookupRoute(app: FastifyInstance): Promise<void>;
