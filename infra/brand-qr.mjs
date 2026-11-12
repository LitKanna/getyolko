// The shop's QR code: soft squares, rounded corner eyes and the egg logo in the middle.
// Used for the printed box cards (Admin > Delivery run). Scanning comes first: the logo size
// below was picked by test, see AGENTS.md "Brand and logo" before changing it.
import { LOGO } from "./brand.mjs";

const INK = "#14120e";

export const QR_LOOK = {
  // Egg height as a share of the code's width. 0.25 reads as the logo on a 36mm print and
  // hides about 6.5% of the code; error level H can lose 30%.
  logoH: 0.25,
  // Clear space around the egg's brush stroke, in modules.
  air: 0.5,
  // Corner radius of a free-standing square, in modules.
  soft: 0.42,
  // Corner radii of the three eyes: outer ring, its hole, the centre block.
  eye: [2.2, 1.3, 1],
};

const f = (v) => String(Math.round(v * 100) / 100).replace(/^(-?)0\./, "$1.");

/** The egg outline ("M x y" then relative cubics) as a ring of points. */
export function eggPoints(d, steps = 10) {
  const nums = d.match(/-?\d*\.?\d+/g).map(Number);
  let x = nums[0];
  let y = nums[1];
  const out = [];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const [a1, b1, a2, b2, a3, b3] = nums.slice(i, i + 6);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        x + 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t * a3,
        y + 3 * u * u * t * b1 + 3 * u * t * t * b2 + t * t * t * b3,
      ]);
    }
    x += a3;
    y += b3;
  }
  return out;
}

const roundSquare = (x, y, w, q, hole) =>
  hole
    ? `M${f(x + q)} ${f(y)}a${q} ${q} 0 0 0 ${-q} ${q}v${f(w - 2 * q)}a${q} ${q} 0 0 0 ${q} ${q}h${f(w - 2 * q)}a${q} ${q} 0 0 0 ${q} ${-q}v${f(2 * q - w)}a${q} ${q} 0 0 0 ${-q} ${-q}z`
    : `M${f(x + q)} ${f(y)}h${f(w - 2 * q)}a${q} ${q} 0 0 1 ${q} ${q}v${f(w - 2 * q)}a${q} ${q} 0 0 1 ${-q} ${q}h${f(2 * q - w)}a${q} ${q} 0 0 1 ${-q} ${-q}v${f(2 * q - w)}a${q} ${q} 0 0 1 ${q} ${-q}z`;

/**
 * Draw `text` as the shop's QR code. `qrcode` is the qrcode-generator function.
 * Returns the SVG and the numbers the test checks: modules a side, and how many the egg hides.
 * The code has the 4-module quiet zone scanners need. Whole modules make way for the egg, so
 * none is cut in half; the gap follows the egg's own outline to hide as little as it can.
 */
export function brandQrInfo(qrcode, text, look = QR_LOOK) {
  const qr = qrcode(0, "H");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + 8;
  const inEye = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  // Place the egg in the middle: logo units to modules.
  const s = (n * look.logoH) / LOGO.h;
  const ring = eggPoints(LOGO.egg);
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const ox = size / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * s;
  const oy = size / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * s;
  const pts = ring.map(([x, y]) => [ox + x * s, oy + y * s]);
  // Half the brush stroke, the air around it, and half a module so no square pokes into the air.
  const reach = 12.5 * s + look.air + 0.45;
  const inEgg = (r, c) => {
    const px = c + 4.5;
    const py = r + 4.5;
    let inside = false;
    let near = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[j];
      if (y1 > py !== y2 > py && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) inside = !inside;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
      near = Math.min(near, Math.hypot(px - x1 - t * dx, py - y1 - t * dy));
    }
    return inside || near < reach;
  };
  const gap = [];
  let hidden = 0;
  for (let r = 0; r < n; r++) {
    gap.push([]);
    for (let c = 0; c < n; c++) {
      const hit = inEgg(r, c);
      gap[r].push(hit);
      if (hit) hidden++;
    }
  }
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c) && !inEye(r, c) && !gap[r][c];

  // A square's corner is rounded only where nothing dark touches it, so runs and blocks stay whole.
  const R = look.soft;
  const corners = (r, c) => {
    const up = dark(r - 1, c);
    const dn = dark(r + 1, c);
    const lf = dark(r, c - 1);
    const rt = dark(r, c + 1);
    return [!up && !lf, !up && !rt, !dn && !rt, !dn && !lf];
  };
  const arc = (on, dx, dy) => (on ? `a${f(R)} ${f(R)} 0 0 1 ${f(dx * R)} ${f(dy * R)}` : "");
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      const x = c + 4;
      const y = r + 4;
      const [tl, tr, br, bl] = corners(r, c);
      if (!tl && !tr && !br && !bl) {
        // A plain square: join it to the plain squares that follow in the row.
        let w = 1;
        while (dark(r, c + w) && !corners(r, c + w).some(Boolean)) w++;
        d += `M${x} ${y}h${w}v1h-${w}z`;
        c += w - 1;
        continue;
      }
      const q = (on) => (on ? R : 0);
      d += `M${f(x + q(tl))} ${y}h${f(1 - q(tl) - q(tr))}${arc(tr, 1, 1)}v${f(1 - q(tr) - q(br))}${arc(br, -1, 1)}h${f(q(br) + q(bl) - 1)}${arc(bl, -1, -1)}v${f(q(bl) + q(tl) - 1)}${arc(tl, 1, -1)}z`;
    }
  }
  let eyes = "";
  for (const [ex, ey] of [[4, 4], [n - 3, 4], [4, n - 3]]) {
    eyes += roundSquare(ex, ey, 7, look.eye[0]) + roundSquare(ex + 1, ey + 1, 5, look.eye[1], true) + roundSquare(ex + 2, ey + 2, 3, look.eye[2]);
  }
  const place = `translate(${f(ox)} ${f(oy)}) scale(${Math.round(s * 10000) / 10000})`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code">` +
    `<path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="${INK}" d="${d}${eyes}"/>` +
    `<g transform="${place}"><path fill="${INK}" d="${LOGO.brush}"/><circle cx="${LOGO.yolk.cx}" cy="${LOGO.yolk.cy}" r="${LOGO.yolk.r}" fill="${LOGO.yolk.fill}"/></g></svg>`;
  return { svg, n, size, hidden };
}

export const brandQr = (qrcode, text, look) => brandQrInfo(qrcode, text, look).svg;
