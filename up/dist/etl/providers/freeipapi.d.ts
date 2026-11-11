import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class FreeIpApiProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "freeipapi";
    constructor(opts?: {
        endpoint?: string;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
