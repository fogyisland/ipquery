import type { FastifyInstance } from "fastify";
export interface RangeExportState {
    readonly id: string;
    readonly file: string;
    readonly rows: number;
    readonly bytes: number;
    readonly createdAt: number;
}
export declare function registerRangeRoutes(app: FastifyInstance): void;
