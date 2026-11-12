// node infra/brand-qr-test.mjs : the logo in the QR code must never cost the code its scan.
// Checks the drawing's shape and how much of the code the egg hides. The scan itself was
// tested by reading rendered codes back (see AGENTS.md, "Brand and logo").
import qrcode from "qrcode-generator";
import { brandQrInfo, eggPoints, QR_LOOK } from "./brand-qr.mjs";
import { LOGO } from "./brand.mjs";

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const links = [
  "https://getyolko.com/",
  "https://getyolko.com/r/W8?m=card",
  "https://getyolko.com/r/ABC234?m=card",
  "https://getyolko.com/r/FRESH5?m=card",
  "https://getyolko.com/r/ABC234?m=card&utm_source=box-card&utm_medium=print&utm_campaign=neighbours",
];
for (const link of links) {
  const q = brandQrInfo(qrcode, link);
  const share = q.hidden / (q.n * q.n);
  // Error level H can lose 30%. The egg takes a quarter of that at most, the rest is for
  // creases, glare and dirt on a printed card.
  ok(share <= 0.08, `${link}: the egg hides ${(share * 100).toFixed(1)}% of the code, over 8%`);
  ok(share >= 0.04, `${link}: the egg hides only ${(share * 100).toFixed(1)}%, is it still readable as the logo?`);
  ok(q.size === q.n + 8 && q.svg.includes(`viewBox="0 0 ${q.size} ${q.size}"`), `${link}: the 4-module quiet zone is missing`);
  ok(q.svg.includes(LOGO.brush) && q.svg.includes(`r="${LOGO.yolk.r}"`), `${link}: the egg logo is missing`);
  // The three corner eyes: ring, hole and centre block each, drawn whole.
  const eyeMoves = [[4, 4], [q.n - 3, 4], [4, q.n - 3]];
  for (const [x, y] of eyeMoves) {
    ok(q.svg.includes(`M${x + QR_LOOK.eye[0]} ${y}h`), `${link}: eye at ${x},${y} is missing`);
  }
  ok(!/NaN|undefined|Infinity/.test(q.svg), `${link}: bad number in the drawing`);
  ok(brandQrInfo(qrcode, link).svg === q.svg, `${link}: the drawing changes between runs`);
}

// The egg sits in the middle of the code.
const q = brandQrInfo(qrcode, links[2]);
const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(q.svg);
const ring = eggPoints(LOGO.egg);
const cx = (Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2;
const cy = (Math.min(...ring.map((p) => p[1])) + Math.max(...ring.map((p) => p[1]))) / 2;
ok(m && Math.abs(Number(m[1]) + cx * Number(m[3]) - q.size / 2) < 0.02 && Math.abs(Number(m[2]) + cy * Number(m[3]) - q.size / 2) < 0.02, "the egg is not centred");
ok(ring.length === 40, "the egg outline did not parse into 4 curves");

if (fails.length) {
  for (const f of fails) console.log("FAIL", f);
  process.exit(1);
}
console.log("brand QR tests passed");
