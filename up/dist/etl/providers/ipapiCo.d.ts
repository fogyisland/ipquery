import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class IpapiCoProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "ipapi-co";
    constructor(opts?: {
        endpoint?: string;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
