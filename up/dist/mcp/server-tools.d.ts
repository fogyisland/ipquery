import { type McpPool, type ToolDef } from "./tools";
import { lastEtlRun } from "../storage/mysql";
/** A handler takes raw tool arguments and returns a typed result envelope. */
export interface ToolResult {
    isErrorHint?: boolean;
    message?: string;
    [key: string]: unknown;
}
export type ToolHandler = (args: unknown) => Promise<ToolResult>;
export interface ToolRegistration {
    def: ToolDef;
    handler: ToolHandler;
}
/** ISO-serialize the shared lastRun shape (used by ipquery_stats and the
 *  etl-status tool so the two outputs cannot drift). */
export declare function serializeLastRun(last: NonNullable<Awaited<ReturnType<typeof lastEtlRun>>>): ToolResult["lastRun"];
export declare function buildToolRegistrations(deps: McpPool): ToolRegistration[];
