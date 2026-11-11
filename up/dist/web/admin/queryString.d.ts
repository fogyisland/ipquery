export interface ListQueryFields {
    filters: readonly string[];
    sort: readonly string[];
}
export interface ParsedListQuery {
    filters: Record<string, string>;
    sort: {
        col: string;
        dir: "asc" | "desc";
    } | null;
    page: number;
    limit: number;
    ids: number[];
}
export declare function parseListQuery(rawQs: string, fields: ListQueryFields): ParsedListQuery;
export declare function appendQueryString(existing: string, key: string, value: string): string;
