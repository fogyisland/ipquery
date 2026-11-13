// SPDX-License-Identifier: MIT
// Renders the world map as an inline SVG string.
//
// Everything is server-rendered on purpose:
//
//   - The CSP forbids inline scripts (\`script-src 'self'\`), so a
//     client-side map library would need an external .js file anyway.
//   - A tile server (Mapbox, OpenStreetMap, ...) would hand the
//     visitor's IP address to a third party, and would need the CSP
//     relaxed to allow it. Neither is acceptable for a page whose
//     whole point is "look up an IP".
//
// So the map is a static SVG plus one marker, both emitted inline.

import { LAND_PATH } from "./land-path";
import { MAP_HEIGHT, MAP_WIDTH, projectLonLat, type GeoPoint } from "./geo-map";

/** The rendered map, ready to be dropped into a template. */
export interface RenderedMap {
  /** The complete <svg> element. */
  svg: string;
  /** Where the marker sits, for the tests to assert on. */
  marker: { x: number; y: number } | null;
}

/**
 * Escape a value for use inside an XML attribute.
 *
 * The only values that reach here are numbers and short source tags, but
 * the source tag comes from the database, and the country name is
 * operator-visible text. Neither is trusted to be well-formed.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the map SVG for one position.
 *
 * Returns null when the position cannot be projected (out of range or
 * non-finite), so the caller can show the coordinates as plain text
 * instead of a map with a marker at a made-up position.
 */
export function renderWorldMap(
  point: GeoPoint | undefined,
  options: { label: string; source: string },
): RenderedMap | null {
  if (point === undefined) return null;
  const projected = projectLonLat(point);
  if (projected === null) return null;

  const marker = `
    <g class="m-map-marker">
      <circle cx="${projected.x.toFixed(2)}" cy="${projected.y.toFixed(2)}" r="7" class="m-map-marker-halo"></circle>
      <circle cx="${projected.x.toFixed(2)}" cy="${projected.y.toFixed(2)}" r="3.5" class="m-map-marker-dot"></circle>
      <title>${escapeAttr(options.label)}</title>
    </g>`;

  const svg = `<svg class="m-map-svg" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-label="${escapeAttr(options.label)}" preserveAspectRatio="xMidYMid meet">
      <rect class="m-map-ocean" x="0" y="0" width="${MAP_WIDTH}" height="${MAP_HEIGHT}"></rect>
      <path class="m-map-land" d="${LAND_PATH}"></path>
      <g class="m-map-graticule" aria-hidden="true">
        <path d="M0 90H${MAP_WIDTH}M0 180H${MAP_WIDTH}M0 270H${MAP_WIDTH}"></path>
      </g>${marker}
    </svg>`;

  return { svg, marker: { x: projected.x, y: projected.y } };
}
