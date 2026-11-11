import type { IpGeoProvider, IpGeoLookupResult } from "./providers/types";
export interface GenericProviderRow {
    name: string;
    urlTemplate: string;
    method: "GET" | "POST";
    requestBody: string | null;
    responseFormat: "json" | "text";
    countryPath: string | null;
    cityPath: string | null;
    asnPath: string | null;
    timeoutMs: number | null;
    apiKey: string | null;
}
export declare class GenericHttpProvider implements IpGeoProvider {
    private readonly row;
    readonly name: string;
    constructor(row: GenericProviderRow);
    lookup(ipOrBuffer: string | Buffer): Promise<IpGeoLookupResult>;
    private parseTextFallback;
}
