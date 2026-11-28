// Kanna's shop rules, checked on every pull request and every push to main.
//
// Each rule here is something Kanna has had to correct by hand at least once. A rule kept only in
// notes gets forgotten; a rule kept here stops the change before it goes live. When Kanna corrects
// something new about the shop that a script can see, add it here.
//
// Run: node infra/shop-rules-test.mjs   (or npm run test:rules)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// What a customer, a search engine or a shared link can read.
const PAGES = readdirSync(ROOT).filter((f) => f.endsWith(".html"));
const SHOP = [...PAGES, "app.js", "config.js", "track.js"];
// What also reaches customers by email, Stripe or the admin.
const SENT = ["infra/cloudflare-worker.mjs", "infra/build-pages.mjs", "infra/admin.html", "infra/brand.mjs"];

const failures = [];
const fail = (rule, where, detail) => failures.push(`${rule}\n    ${where}: ${detail}`);

/** Code comments are notes for us, not words a customer reads. */
const isCode = (file) => /\.(mjs|js)$/.test(file);
function stripComment(line) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return line.replace(/\s\/\/\s.*$/, "");
}

/** Every match of `re` in `files`, with the line number and a short excerpt. */
function find(files, re) {
  const hits = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((raw, i) => {
      const line = isCode(file) ? stripComment(raw) : raw;
      for (const m of line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
        const at = Math.max(0, m.index - 40);
        hits.push({ where: `${file}:${i + 1}`, text: line.slice(at, m.index + m[0].length + 40).trim(), match: m[0] });
      }
    });
  }
  return hits;
}

// 1. Prices are fixed at $13 a tray, $25 for two, $72 a box, $5 delivery (Kanna, 3 Nov 2026).
//    They never follow cost, competitors or a ratio, and a box is never quoted as $77
//    ($77 is a box plus the $5 delivery on a one-off order).
{
  const rule = "PRICES ARE FIXED: $13 one tray, $25 two trays, $72 a box, $5 delivery";
  const app = read("app.js");
  for (const [key, price] of [["tray1", 13], ["tray2", 25], ["box", 72]]) {
    const m = app.match(new RegExp(`\\b${key}:\\s*\\{[^}]*price:\\s*(\\d+)`));
    if (!m || Number(m[1]) !== price) fail(rule, "app.js", `BUNDLES.${key} is $${m ? m[1] : "?"}, must be $${price}`);
  }
  const pages = read("infra/build-pages.mjs").match(/const PRICE = \{([^}]*)\}/);
  const want = { tray1: 13, tray2: 25, box: 72, delivery: 5 };
  for (const [k, v] of Object.entries(want)) {
    const m = pages && pages[1].match(new RegExp(`${k}:\\s*(\\d+)`));
    if (!m || Number(m[1]) !== v) fail(rule, "infra/build-pages.mjs", `PRICE.${k} is ${m ? m[1] : "missing"}, must be ${v}`);
  }
  const worker = read("infra/cloudflare-worker.mjs").match(/prices:\s*\{\s*tray1:\s*(\d+),\s*tray2:\s*(\d+),\s*box:\s*(\d+)/);
  if (!worker || worker.slice(1).join("/") !== "13/25/72") {
    fail(rule, "infra/cloudflare-worker.mjs", `default prices are ${worker ? worker.slice(1).join("/") : "missing"}, must be 13/25/72`);
  }
  for (const h of find([...SHOP, ...SENT], /box[^.$\n]{0,40}\$77\b|\$77\b[^.\n]{0,25}\bbox\b/i)) {
    if (!/deliver/i.test(h.text)) fail(rule, h.where, `a box is $72, not $77: "${h.text}"`);
  }
}

// 2. Kanna's personal mobile never appears anywhere (Kanna, 13 Nov 2026). The shop's only
//    number is the line 0480 093 935.
{
  const rule = "NEVER SHOW KANNA'S PRIVATE MOBILE; the public number is 0480 093 935";
  for (const h of find([...SHOP, ...SENT, "README.md", "AGENTS.md"], /0433[ -]?975[ -]?055|61[ -]?433[ -]?975[ -]?055/)) {
    fail(rule, h.where, "the private mobile is back");
  }
}

// 3. YOLKO is a home-based, service-area business: never the Sydney Markets address or 2129.
{
  const rule = "NO ADDRESS: never the Sydney Markets address or its 2129 postcode";
  for (const h of find([...SHOP, ...SENT], /\b2129\b|Sydney Markets|Paddy'?s Markets/i)) {
    if (!/HIDDEN_POSTCODES/.test(h.text)) fail(rule, h.where, `"${h.text}"`);
  }
}

// 4. No pop-ups on the shop (Kanna, 26 Oct 2026: "Dont want the toast"). Messages go in the line
//    above Buy now. The admin is not the shop and may keep its own toasts and sheets.
{
  const rule = "NO POP-UPS ON THE SHOP: no toasts, modals, popups, alert/confirm/prompt or <dialog>";
  const re = /\b(alert|confirm|prompt)\s*\(|<dialog\b|class(Name)?\s*=\s*["'`][^"'`]*\b(toast|toasts|modal|popup|pop-up|lightbox)\b|Notification\.requestPermission/;
  for (const h of find(SHOP, re)) fail(rule, h.where, `"${h.text}"`);
}

// 5. No "cheapest", "beats" or "best price" claims (egg prices page rule, Nov 2026). The one FAQ
//    question "What is the cheapest way to buy eggs?" is allowed: its answer is "buy a bigger pack".
{
  const rule = "NO CHEAPEST CLAIMS: never cheapest, beats, best price, lowest price, unbeatable";
  const allowed = /What is the cheapest way to buy eggs\?/;
  for (const h of find(SHOP, /\b(cheapest|beats|best price|best value|lowest price|unbeatable|cheaper than)\b/i)) {
    if (!allowed.test(h.text)) fail(rule, h.where, `"${h.text}"`);
  }
}

// 6. Plain words (Kanna, 15 Nov 2026: "wtf is this real person"). No reassurance filler, and
//    delivery is to homes AND businesses (Kanna, 13 Nov 2026), never "homes only".
{
  const rule = "PLAIN WORDS: no reassurance filler, and never 'homes only'";
  const re = /\b(a real person|real humans?|no bots|we promise|100% guaranteed|homes only|home delivery only|residential only)\b/i;
  for (const h of find([...SHOP, ...SENT], re)) fail(rule, h.where, `"${h.text}"`);
}

// 7. Copy style (AGENTS.md hard rule): no em dashes on the site or in the admin.
{
  const rule = "NO EM DASHES in site or admin copy";
  for (const h of find([...SHOP, "infra/admin.html"], /—/)) fail(rule, h.where, `"${h.text}"`);
}

// 8. Delivery is Saturday only, 6am to 12pm (Kanna, 26 Oct 2026).
{
  const rule = "DELIVERY IS SATURDAY 6AM TO 12PM";
  const home = read("index.html");
  if (!/Saturday[^<]{0,40}6am (to|and) 12pm|6am (to|and) 12pm/.test(home)) fail(rule, "index.html", "the 6am to 12pm Saturday window is gone");
  for (const h of find(SHOP, /\b(Sunday|Friday) (delivery|deliveries|mornings? delivery)\b/i)) fail(rule, h.where, `"${h.text}"`);
}

// 9. All mail goes from and to orders@getyolko.com (Kanna, 25 Oct 2026). The getyolkonow Gmail
//    is only for Google sign-in and never a sender or reply-to address.
{
  const rule = "EMAIL ONLY FROM orders@getyolko.com, never the getyolkonow Gmail";
  for (const h of find([...SHOP, ...SENT], /getyolkonow@gmail\.com/i)) fail(rule, h.where, `"${h.text}"`);
}

if (failures.length) {
  console.error(`shop rules: ${failures.length} broken\n\n  ${failures.join("\n\n  ")}\n`);
  console.error("These are Kanna's standing rules. Fix the change, not the rule. See AGENTS.md \"Shop rules\".");
  process.exit(1);
}
console.log(`shop rules: all 9 rules hold across ${SHOP.length + SENT.length} files`);
