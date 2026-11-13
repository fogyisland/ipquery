/** The map's viewBox. One unit per 0.5 degrees. */
export declare const MAP_WIDTH = 720;
export declare const MAP_HEIGHT = 360;
/** A geographic position, in degrees. */
export interface GeoPoint {
    lat: number;
    lon: number;
}
/** A position in the map's coordinate space (SVG user units). */
export interface MapPoint {
    x: number;
    y: number;
}
/**
 * Project a geographic position onto the map.
 *
 * Returns null for a coordinate outside the valid range rather than
 * clamping it: a latitude of 200 is a data problem, and silently
 * clamping it would draw the marker somewhere that looks deliberate
 * when it is not.
 */
export declare function projectLonLat(point: GeoPoint): MapPoint | null;
/**
 * Format a coordinate for display.
 *
 * The latitude carries a N/S suffix and the longitude an E/W one — a bare
 * "-33.87" is ambiguous, and "the coordinates are -33.87, 151.21" reads as
 * a signed offset rather than a place on Earth.
 */
export declare function formatCoordinate(value: number, axis: "lat" | "lon"): string;
