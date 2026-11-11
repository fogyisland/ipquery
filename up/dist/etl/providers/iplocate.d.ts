import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class IplocateProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "iplocate";
    constructor(opts?: {
        apiKey?: string;
        endpoint?: string;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
