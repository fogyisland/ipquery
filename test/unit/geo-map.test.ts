// SPDX-License-Identifier: MIT
// Unit tests for the map projection and the inline SVG renderer.
//
// The projection is arithmetic, which means it is worth pinning
// exactly: if the formula ever changes, the marker would land in the
// wrong place — a silent, plausible-looking wrong.
import { describe, it, expect } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH, formatCoordinate, projectLonLat } from "../../src/web/maps/geo-map";
import { renderWorldMap } from "../../src/web/maps/render-map";
import { LAND_PATH } from "../../src/web/maps/land-path";

describe("projectLonLat", () => {
  it("maps the whole world onto the viewBox", () => {
    // The north-west corner and the south-east corner.
    const nw = projectLonLat({ lat: 90, lon: -180 });
    const se = projectLonLat({ lat: -90, lon: 180 });
    expect(nw).toEqual({ x: 0, y: 0 });
    expect(se).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });

  it("puts the equator in the middle", () => {
    const mid = projectLonLat({ lat: 0, lon: 0 });
    expect(mid).toEqual({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
  });

  it("places well-known cities in the right quadrant", () => {
    // Beijing: north, east.
    const beijing = projectLonLat({ lat: 39.9042, lon: 116.4074 })!;
    expect(beijing.x).toBeGreaterThan(MAP_WIDTH / 2);
    expect(beijing.y).toBeLessThan(MAP_HEIGHT / 2);
    // New York: north, west.
    const newYork = projectLonLat({ lat: 40.7128, lon: -74.006 })!;
    expect(newYork.x).toBeLessThan(MAP_WIDTH / 2);
    expect(newYork.y).toBeLessThan(MAP_HEIGHT / 2);
    // Sydney: south, east.
    const sydney = projectLonLat({ lat: -33.8688, lon: 151.2093 })!;
    expect(sydney.x).toBeGreaterThan(MAP_WIDTH / 2);
    expect(sydney.y).toBeGreaterThan(MAP_HEIGHT / 2);
    // Cape Town: south, east (18.4°E — just east of the prime meridian).
    const capeTown = projectLonLat({ lat: -33.9249, lon: 18.4241 })!;
    expect(capeTown.x).toBeGreaterThan(MAP_WIDTH / 2);
    expect(capeTown.y).toBeGreaterThan(MAP_HEIGHT / 2);
    // Buenos Aires: south, west.
    const buenosAires = projectLonLat({ lat: -34.6037, lon: -58.3816 })!;
    expect(buenosAires.x).toBeLessThan(MAP_WIDTH / 2);
    expect(buenosAires.y).toBeGreaterThan(MAP_HEIGHT / 2);
  });

  it("rejects coordinates outside the valid range", () => {
    // Out of range is a data problem. Clamping would draw a marker
    // somewhere that looks deliberate when it is not.
    expect(projectLonLat({ lat: 91, lon: 0 })).toBeNull();
    expect(projectLonLat({ lat: -91, lon: 0 })).toBeNull();
    expect(projectLonLat({ lat: 0, lon: 181 })).toBeNull();
    expect(projectLonLat({ lat: 0, lon: -181 })).toBeNull();
    expect(projectLonLat({ lat: Number.NaN, lon: 0 })).toBeNull();
    expect(projectLonLat({ lat: 0, lon: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("accepts the exact boundary values", () => {
    expect(projectLonLat({ lat: 90, lon: -180 })).not.toBeNull();
    expect(projectLonLat({ lat: -90, lon: 180 })).not.toBeNull();
  });
});

describe("formatCoordinate", () => {
  it("suffixes the latitude with N or S", () => {
    expect(formatCoordinate(35.6762, "lat")).toBe("35.68°N");
    expect(formatCoordinate(-33.8688, "lat")).toBe("33.87°S");
  });

  it("suffixes the longitude with E or W", () => {
    expect(formatCoordinate(139.6503, "lon")).toBe("139.65°E");
    expect(formatCoordinate(-74.006, "lon")).toBe("74.01°W");
  });

  it("treats zero as positive rather than signed", () => {
    expect(formatCoordinate(0, "lat")).toBe("0.00°N");
    expect(formatCoordinate(0, "lon")).toBe("0.00°E");
  });
});

describe("renderWorldMap", () => {
  const options = { label: "test label", source: "maxmind" };

  it("returns null when there is no position", () => {
    expect(renderWorldMap(undefined, options)).toBeNull();
  });

  it("returns null for an unprojectable position", () => {
    expect(renderWorldMap({ lat: 200, lon: 0 }, options)).toBeNull();
  });

  it("emits an SVG with the map, the graticule and the marker", () => {
    const rendered = renderWorldMap({ lat: 35.6762, lon: 139.6503 }, options)!;
    expect(rendered.svg).toContain("<svg");
    expect(rendered.svg).toContain('viewBox="0 0 720 360"');
    expect(rendered.svg).toContain("m-map-land");
    expect(rendered.svg).toContain("m-map-graticule");
    expect(rendered.svg).toContain("m-map-marker-dot");
    expect(rendered.marker).not.toBeNull();
  });

  it("escapes the aria-label so it cannot break out of the attribute", () => {
    const rendered = renderWorldMap(
      { lat: 0, lon: 0 },
      {
        label: 'evil" onload="alert(1)',
        source: "maxmind",
      },
    )!;
    expect(rendered.svg).not.toContain('onload="alert(1)"');
    expect(rendered.svg).toContain("&quot;");
  });

  it("carries no script and no external reference", () => {
    const rendered = renderWorldMap({ lat: 0, lon: 0 }, options)!;
    expect(rendered.svg).not.toMatch(/<script/i);
    expect(rendered.svg).not.toMatch(/https?:\/\/(?!www\.naturalearthdata\.com)/i);
  });
});

describe("the land path data", () => {
  it("is a non-empty set of closed rings inside the viewBox", () => {
    expect(LAND_PATH.length).toBeGreaterThan(1000);
    const coords = LAND_PATH.match(/-?\d+\.\d+/g) ?? [];
    // Every coordinate pair must be inside the viewBox, or the map
    // would render a stray line outside the frame.
    for (let i = 0; i < coords.length; i += 2) {
      const x = Number(coords[i]);
      const y = Number(coords[i + 1]);
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(MAP_WIDTH + 0.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThanOrEqual(MAP_HEIGHT + 0.5);
    }
  });

  it("contains only draw commands", () => {
    const commands = LAND_PATH.match(/[A-Za-z]/g) ?? [];
    for (const command of commands) {
      expect("MLZ").toContain(command);
    }
  });
});
