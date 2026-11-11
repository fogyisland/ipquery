import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class IpinfoProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "ipinfo";
    constructor(opts?: {
        token?: string;
        endpoint?: string;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
