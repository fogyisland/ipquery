import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class IpSbProvider implements IpGeoProvider {
    private readonly opts;
    readonly name = "ip-sb";
    constructor(opts?: {
        endpoint?: string;
        timeoutMs?: number;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
