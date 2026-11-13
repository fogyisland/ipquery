"use strict";
// SPDX-License-Identifier: MIT
// Equirectangular projection helpers for the inline world map.
//
// The map is drawn server-side into an inline SVG. Equirectangular is used
// because BOTH axes are linear in the geographic coordinates:
//
//   x = (lon + 180) / 360 * W
//   y = (90 - lat) / 180 * H
//
// That linearity is the whole point: the marker for a looked-up IP can be
// placed with plain arithmetic, with no projection library, no client-side
// JavaScript (the CSP forbids inline scripts), and no round trip to a tile
// server (which would leak the visitor's IP to a third party).
//
// A Mercator map would have been prettier in the populated latitudes, but
// its y term is non-linear and would need a table lookup to invert.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAP_HEIGHT = exports.MAP_WIDTH = void 0;
exports.projectLonLat = projectLonLat;
exports.formatCoordinate = formatCoordinate;
/** The map's viewBox. One unit per 0.5 degrees. */
exports.MAP_WIDTH = 720;
exports.MAP_HEIGHT = 360;
/**
 * Project a geographic position onto the map.
 *
 * Returns null for a coordinate outside the valid range rather than
 * clamping it: a latitude of 200 is a data problem, and silently
 * clamping it would draw the marker somewhere that looks deliberate
 * when it is not.
 */
function projectLonLat(point) {
    const { lat, lon } = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return null;
    if (lat < -90 || lat > 90)
        return null;
    if (lon < -180 || lon > 180)
        return null;
    return {
        x: ((lon + 180) / 360) * exports.MAP_WIDTH,
        y: ((90 - lat) / 180) * exports.MAP_HEIGHT,
    };
}
/**
 * Format a coordinate for display.
 *
 * The latitude carries a N/S suffix and the longitude an E/W one — a bare
 * "-33.87" is ambiguous, and "the coordinates are -33.87, 151.21" reads as
 * a signed offset rather than a place on Earth.
 */
function formatCoordinate(value, axis) {
    const rounded = value.toFixed(2);
    if (axis === "lat") {
        const suffix = value < 0 ? "S" : "N";
        return `${Math.abs(value).toFixed(2)}°${suffix}`;
    }
    const suffix = value < 0 ? "W" : "E";
    return `${Math.abs(value).toFixed(2)}°${suffix}`;
}
//# sourceMappingURL=geo-map.js.map