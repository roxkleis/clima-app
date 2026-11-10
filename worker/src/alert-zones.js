import { boundaries } from "./alert-boundaries.js";

function bounds(points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

function overlaps(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function contains([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function edges(points) {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { a, b, box: bounds([a, b]) };
  });
}

function crosses({ a, b, box }, { a: c, b: d, box: other }) {
  if (!overlaps(box, other)) return false;
  const side = ([ax, ay], [bx, by], [px, py]) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

function within(point, box) {
  return point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];
}

function region(name, polygons) {
  return { name, polygons: polygons.map(points => {
    const ring = points.slice(0, points.length - 1);
    return { ring, box: bounds(ring) };
  }) };
}

export function matchedZones(points) {
  // CAP and the boundaries use closed rings. Remove the duplicated endpoint before testing.
  if (points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points = points.slice(0, -1);
  const box = bounds(points);
  let segments;
  const matches = [];
  for (const zone of zones) {
    const match = zone.polygons.some(({ ring, box: other }) => {
      if (!overlaps(box, other)) return false;
      if (points.some(point => within(point, other) && contains(point, ring)) ||
          ring.some(point => within(point, box) && contains(point, points))) return true;
      segments ??= edges(points);
      return edges(ring).some(segment => segments.some(other => crosses(segment, other)));
    });
    if (match) matches.push(zone.name);
  }
  return matches;
}

// Aproximación de 10 km alrededor del centro de San Miguel.
const nearby = Array.from({ length: 33 }, (_, index) => {
  const angle = 2 * Math.PI * (index % 32) / 32;
  return [-58.713 + 0.109 * Math.cos(angle), -34.543 + 0.090 * Math.sin(angle)];
});

const zones = [
  region("San Miguel", boundaries["San Miguel"]),
  region("Cerca de San Miguel", [nearby]),
  region("CABA", boundaries.CABA),
  region("GBA", Object.entries(boundaries).filter(([name]) => name !== "CABA").flatMap(([, polygons]) => polygons))
];
