import { type GeoPoint } from "./geo-map";
/** The rendered map, ready to be dropped into a template. */
export interface RenderedMap {
    /** The complete <svg> element. */
    svg: string;
    /** Where the marker sits, for the tests to assert on. */
    marker: {
        x: number;
        y: number;
    } | null;
}
/**
 * Build the map SVG for one position.
 *
 * Returns null when the position cannot be projected (out of range or
 * non-finite), so the caller can show the coordinates as plain text
 * instead of a map with a marker at a made-up position.
 */
export declare function renderWorldMap(point: GeoPoint | undefined, options: {
    label: string;
    source: string;
}): RenderedMap | null;
