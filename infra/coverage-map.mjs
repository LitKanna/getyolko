/**
 * The delivery map: one dot per suburb, dark where we deliver and pale where we don't.
 * Built from the same zone data checkout uses, so the picture always matches the rules.
 *
 * buildCoverageMap() returns { svg, width, height, labels } where each label has its
 * position in percent, so the page can place real text over the image.
 * No hub marker is drawn: YOLKO is a service-area business with no public address.
 */
import { SUBURBS, quoteDelivery } from "./delivery-zones.mjs";

const NOT_A_SUBURB = /\b(dc|bc|mc|milpo|lpo|centre|university|westfield|square|plaza|mall|aerodrome|metro)\b/i;

// Places people know, to read the map by.
export const MAP_LABELS = [
  "Hornsby", "Blacktown", "Parramatta", "Chatswood", "Liverpool",
  "Sydney", "Hurstville", "Campbelltown", "Cronulla",
];

export function buildCoverageMap({ width = 560, step = 8, reachKm = 2.1 } = {}) {
  const rows = SUBURBS
    .filter((s) => !NOT_A_SUBURB.test(s.name))
    .map((s) => ({ ...s, ok: quoteDelivery({ lat: s.lat, lng: s.lng, name: s.name, crossing: s.crossing }).deliver }));
  const covered = rows.filter((s) => s.ok);
  const pad = 0.06;
  const latMin = Math.min(...covered.map((s) => s.lat)) - pad;
  const latMax = Math.max(...covered.map((s) => s.lat)) + pad;
  const lngMin = Math.min(...covered.map((s) => s.lng)) - pad;
  const lngMax = Math.max(...covered.map((s) => s.lng)) + pad;
  const kx = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
  const scale = width / ((lngMax - lngMin) * kx);
  const height = Math.round(((latMax - latMin) * scale) / step) * step;
  const xy = (s) => [(s.lng - lngMin) * kx * scale, (latMax - s.lat) * scale];
  const near = rows.filter((s) => s.lat > latMin - 0.05 && s.lat < latMax + 0.05 && s.lng > lngMin - 0.05 && s.lng < lngMax + 0.05);
  const kmPerPx = 111.32 / scale;

  // A dot-matrix map: each grid point takes the status of the nearest suburb,
  // and is left out when no suburb is close (sea, bush, airport).
  const ink = [];
  const pale = [];
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      let best = null;
      let bestD = Infinity;
      for (const s of near) {
        const [sx, sy] = xy(s);
        const d = (sx - x) ** 2 + (sy - y) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best || Math.sqrt(bestD) * kmPerPx > reachKm) continue;
      (best.ok ? ink : pale).push(`M${x} ${y}h0`);
    }
  }
  const r = (step * 0.56).toFixed(1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" stroke-linecap="round" stroke-width="${r}"><path stroke="#e2dbcb" d="${pale.join("")}"/><path stroke="#14120e" d="${ink.join("")}"/></svg>\n`;

  const labels = MAP_LABELS.map((name) => {
    const s = rows.find((row) => row.name === name);
    if (!s) throw new Error(`No map data for ${name}`);
    const [x, y] = xy(s);
    return { name, x: +((x / width) * 100).toFixed(1), y: +((y / height) * 100).toFixed(1) };
  });
  return { svg, width, height, labels, count: covered.length };
}
