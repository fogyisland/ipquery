import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class IpApiProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "ip-api";
    constructor(opts?: {
        endpoint?: string;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
