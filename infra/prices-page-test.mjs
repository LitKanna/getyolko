// Checks the public egg prices page (what may show, and how): node infra/prices-page-test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pricesBlocks, fillPricesPage, sitemapWithPriceChange, freshOffers, sydneyTime, sizeOf, priceLine, placeEggs, SLOTS, PRICES_PATH } from "./prices-page.mjs";

const NOW = Date.parse("2026-11-12T02:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600e3).toISOString();
const offer = (o) => ({
  id: "x", shop: "Aldi", title: "Lodge Farms Barn Laid Eggs 1.5kg", housing: "barn", pack_eggs: 30, pack_weight_g: 1500,
  price_aud: 11.99, stock: "in_stock", limit: "", source: "auto", checked_at: at(1),
  url: "https://www.aldi.com.au/product/lodge-farms-barn-laid-eggs", ...o,
});
const PRICES = { tray1: 13, tray2: 25, box: 72 };
const count = (html, needle) => html.split(needle).length - 1;
// One pack's part of a block: from its data-pack to the next one.
const part = (html, pack) => {
  const from = html.indexOf(`data-pack="${pack}"`);
  if (from < 0) return "";
  const to = html.indexOf('data-pack="', from + 12);
  return html.slice(from, to < 0 ? html.length : to);
};

/* ---------- which prices may show ---------- */
{
  const latest = {
    offers: [
      offer({}),
      offer({ shop: "Coles", title: "Old price", checked_at: at(25), url: "https://www.coles.com.au/product/a" }), // over a day old
      offer({ shop: "Costco", title: "Typed in", source: "typed" }), // typed by the owner, not read
      offer({ shop: "Somewhere", title: "Unknown shop" }),
      offer({ title: "No price", price_aud: 0 }),
      offer({ title: "No eggs", pack_eggs: null }),
      offer({ title: "Not an egg kind", housing: "organic" }),
      offer({ title: "From the future", checked_at: new Date(NOW + 3600e3).toISOString() }),
      offer({ title: "No time", checked_at: "soon" }),
    ],
  };
  const fresh = freshOffers(latest, NOW);
  assert.deepEqual(fresh.map((o) => o.title), ["Lodge Farms Barn Laid Eggs 1.5kg"]);
  assert.equal(fresh[0].perEgg.toFixed(4), "0.3997");
  assert.equal(fresh[0].out, false);
  assert.deepEqual(freshOffers(null, NOW), []);
  assert.deepEqual(freshOffers({}, NOW), []);
}

/* ---------- the board and the packs ---------- */
{
  const latest = {
    offers: [
      offer({ shop: "Coles", title: "Sunny Queen Free Range X-large Eggs 30 Pack 1.75kg", housing: "free_range", pack_weight_g: 1750, price_aud: 19.5, url: "https://www.coles.com.au/product/sq" }),
      offer({ shop: "Umall", title: "Pace Farm Caged Eggs Large 30 Pack 1.5kg", housing: "caged", price_aud: 9.99, stock: "out_of_stock", limit: "1 per person", url: "https://www.umall.com.au/products/pf" }),
      offer({}),
      offer({ shop: "IGA", title: "Canabolas Eggs 30 Pack", housing: "caged", pack_weight_g: null, price_aud: 13, limit: "2 per person", url: "https://www.igashop.com.au/product/c" }),
      offer({ title: "Lodge Farms Cage Eggs 700g", housing: "caged", pack_eggs: 12, pack_weight_g: 700, price_aud: 5 }),
      offer({ shop: "Coles", title: "Coles Free Range Eggs 12 Pack 600g", housing: "free_range", pack_eggs: 12, pack_weight_g: 600, price_aud: 6.6, url: "https://www.coles.com.au/product/fr" }),
      offer({ shop: "Coles", title: "Half dozen", housing: "free_range", pack_eggs: 6, pack_weight_g: 300, price_aud: 4, url: "https://www.coles.com.au/product/six" }),
    ],
  };
  const b = pricesBlocks({ latest, prices: PRICES, trayWeight: "1.75", now: NOW });
  const board = b["guide-board"];
  const packs = b["guide-packs"];

  // One switch, an option for each pack size that has a pack today, the first one picked.
  assert.equal(count(board, 'type="radio" name="pack"'), 2);
  assert.match(board, /id="pack-dozen" value="dozen" checked><span>A dozen<\/span>/);
  assert.match(board, /id="pack-tray" value="tray"><span>Tray of 30<\/span>/);
  assert.ok(!board.includes("pack-pack18") && !packs.includes('data-pack="pack18"'), "no 18 pack today, so no option for it");
  assert.equal(count(board, 'class="board-view"'), 2);
  assert.equal(count(packs, 'class="packs"'), 2);
  // A size the guide has no switch for is left off.
  assert.ok(!board.includes("Half dozen") && !packs.includes("Half dozen"));

  // A pack nobody can buy today is left off everywhere, and the range starts at what is on sale.
  for (const html of [board, packs]) assert.ok(!html.includes("Pace Farm Caged Eggs Large") && !/out of stock/i.test(html));
  const tray = part(board, "tray");
  assert.match(tray, /<p class="bp-num is-long"><span class="bp-from">From<\/span><span class="bp-cur">\$<\/span>11\.99<\/p>/);
  assert.match(tray, /<b>to \$19\.50<\/b><span>40¢ to 65¢ an egg<\/span>/);
  const dozen = part(board, "dozen");
  assert.match(dozen, /<p class="bp-num"><span class="bp-from">From<\/span><span class="bp-cur">\$<\/span>5<\/p>/);
  assert.match(dozen, /<b>to \$6\.60<\/b><span>42¢ to 55¢ an egg<\/span>/);

  // A shelf for each kind that has a pack, with its own range, and one egg for each pack.
  assert.deepEqual([...tray.matchAll(/<p class="shelf-name"><b>([^<]+)<\/b>(?:<span>([^<]+)<\/span>)?/g)].map((m) => [m[1], m[2]]),
    [["Cage", "$13"], ["Cage free", "$11.99"], ["Free range", "$19.50"]]);
  assert.equal(count(tray, '<a class="egg'), 4, "three packs and YOLKO's tray");
  assert.equal(count(dozen, '<a class="egg'), 2);
  // Every egg leads to its pack's row, and every row has an egg.
  const eggLinks = [...board.matchAll(/<a class="egg[^"]*" href="#([a-z0-9-]+)"/g)].map((m) => m[1]).filter((id) => id !== "prices-title").sort();
  const rowIds = [...packs.matchAll(/<li id="([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(eggLinks, rowIds);
  assert.deepEqual(rowIds, ["dozen-1", "dozen-2", "tray-1", "tray-2", "tray-3"]);
  // An egg is drawn at the size its pack's weight gives, and says what it is.
  assert.match(tray, /<a class="egg egg-l" href="#tray-1" style="--x:[\d.]+;--r:0" tabindex="-1" data-says="Aldi, \$11\.99: Lodge Farms Barn Laid Eggs 1\.5kg"><\/a>/);
  assert.match(tray, /<a class="egg egg-xl" href="#tray-3"/);
  assert.match(tray, /<a class="egg" href="#tray-2"/, "no weight, so the plain egg");
  // The shelves are a picture of the list under them, so a screen reader gets the list.
  assert.equal(count(board, '<div class="shelves" aria-hidden="true">'), 2);

  // YOLKO's tray: one egg with a yolk on the tray board and one line under it. Nowhere else.
  assert.equal(count(board, 'class="egg egg-xl egg-us"'), 1);
  assert.match(tray, /<a class="egg egg-xl egg-us" href="#prices-title" style="--x:[\d.]+;--r:1" tabindex="-1" data-says="YOLKO, \$13 a tray, delivered Saturday">/);
  assert.match(tray, /<p class="board-key"><span class="egg egg-us" aria-hidden="true"><\/span><span>YOLKO's tray is \$13, <a href="#prices-title">delivered Saturday<\/a><\/span><\/p>/);
  assert.ok(!dozen.includes("YOLKO") && !dozen.includes("egg-us"));
  assert.ok(!packs.includes("YOLKO"), "YOLKO is never a row among the shops' packs");

  // The list: a card for each kind, its packs sorted by price, each linking to the shop's page.
  const trayList = part(packs, "tray");
  assert.match(trayList, /<h2>A tray of 30 eggs<\/h2>\s*<p>3 packs today, sorted by price\.<\/p>/);
  assert.match(trayList, /<div class="kind-cards" data-cards="3">/);
  assert.deepEqual([...trayList.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]), ["Cage", "Cage free <span>barn laid</span>", "Free range"]);
  assert.match(trayList, /<li id="tray-1" data-c="40"><a href="https:\/\/www\.aldi\.com\.au\/product\/lodge-farms-barn-laid-eggs" target="_blank" rel="noopener noreferrer"><span class="pk-price">\$11\.99<\/span><span class="pk-name">Lodge Farms Barn Laid Eggs 1\.5kg<\/span><span class="pk-meta"><b>Aldi<\/b> · large&nbsp;eggs · 40¢&nbsp;an&nbsp;egg<\/span><\/a><\/li>/);
  assert.match(trayList, /<span class="pk-meta"><b>IGA<\/b> · 43¢&nbsp;an&nbsp;egg · 2 per person<\/span>/, "no weight, so no size; the shop's limit is kept");
  assert.match(part(packs, "dozen"), /<h2>A dozen eggs<\/h2>\s*<p>2 packs today, sorted by price\.<\/p>/);

  // The board says once where the prices are from and when they were updated.
  assert.equal(count(board, "<time"), 1);
  assert.match(board, /<p class="board-foot"><span>Online prices at Aldi, Coles and IGA<\/span><span>Updated <time datetime="2026-11-12T01:00:00\.000Z">Thursday 12 November, 12:00pm<\/time><\/span><\/p>/);
  assert.ok(!packs.includes("<time"));
  assert.equal(b.checked, NOW - 3600e3);
  // Never a claim about anyone.
  for (const name of SLOTS) assert.ok(!/cheap|best|lowest|beat|dearer|watch/i.test(b[name]), `${name} makes no claim`);

  // A sold out week: the line says so and stops linking to the order cards.
  const sold = part(pricesBlocks({ latest, prices: PRICES, soldOut: true, now: NOW })["guide-board"], "tray");
  assert.match(sold, /YOLKO's tray is \$13, sold out this week<\/span>/);
  // Another tray weight: the egg is drawn large.
  assert.match(part(pricesBlocks({ latest, prices: PRICES, trayWeight: "1.5", now: NOW })["guide-board"], "tray"), /class="egg egg-l egg-us"/);
  // No tray price saved: YOLKO is left out instead of showing $0.
  const none = pricesBlocks({ latest, prices: { tray1: 0 }, now: NOW });
  assert.ok(!none["guide-board"].includes("YOLKO") && !none["guide-board"].includes("egg-us"));
  assert.equal(count(part(none["guide-board"], "tray"), '<a class="egg'), 3);

  // No shop sells a cage tray today: the Cage shelf still stands for YOLKO's egg, with no range.
  const alone = part(pricesBlocks({ latest: { offers: [offer({})] }, prices: PRICES, now: NOW })["guide-board"], "tray");
  assert.match(alone, /<p class="shelf-name"><b>Cage<\/b><\/p>/);
  assert.match(alone, /<p class="bp-num is-long"><span class="bp-cur">\$<\/span>11\.99<\/p>/, "one price, so no From");
  assert.match(alone, /<b>tray of 30<\/b><span>40¢ an egg<\/span>/);
  assert.match(part(pricesBlocks({ latest: { offers: [offer({})] }, prices: PRICES, now: NOW })["guide-packs"], "tray"), /<p>One pack today\.<\/p>/);
}

/* ---------- other people's text is never trusted ---------- */
{
  const latest = {
    offers: [
      offer({ title: 'Eggs <script>alert(1)</script> "30"', limit: "<b>2</b>", url: "https://www.aldi.com.au/x?a=1&b=<2>" }),
      offer({ shop: "Coles", title: "Wrong site", url: "https://evil.example/coles.com.au" }),
      offer({ shop: "Coles", title: "Script link", url: "javascript:alert(1)" }),
      offer({ shop: "Coles", title: "Lookalike", url: "https://notcoles.com.au/p" }),
    ],
  };
  const b = pricesBlocks({ latest, prices: PRICES, now: NOW });
  const html = b["guide-board"] + b["guide-packs"];
  assert.ok(!html.includes("<script>") && !html.includes("<b>2</b>"));
  assert.match(b["guide-packs"], /<span class="pk-name">Eggs &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;30&quot;<\/span>/);
  assert.match(b["guide-board"], /data-says="Aldi, \$11\.99: Eggs &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;30&quot;"/);
  assert.match(b["guide-packs"], /href="https:\/\/www\.aldi\.com\.au\/x\?a=1&amp;b=%3C2%3E"/);
  for (const t of ["Wrong site", "Script link", "Lookalike"]) {
    assert.match(b["guide-packs"], new RegExp(`<li id="tray-\\d" data-c="40"><div><span class="pk-price">\\$11\\.99</span><span class="pk-name">${t}</span>`), `${t} has no link`);
  }
  assert.equal(count(b["guide-packs"], "<a href="), 1);
  assert.ok(!html.includes("evil.example") && !html.includes("javascript:") && !html.includes("notcoles"));
}

/* ---------- nothing to show: the board says so, and names nobody ---------- */
{
  const outOnly = { offers: [offer({ stock: "out_of_stock" })] };
  for (const latest of [null, { offers: [] }, { offers: [offer({ checked_at: at(30) })] }, outOnly]) {
    const b = pricesBlocks({ latest, prices: PRICES, now: NOW });
    assert.match(b["guide-board"], /^\s*<p class="board-wait">Today's prices are on their way\. Look back in a little while\.<\/p>$/);
    assert.equal(b["guide-packs"], "");
    assert.ok(!/YOLKO|Aldi|Coles|<time/.test(b["guide-board"]));
  }
  assert.equal(pricesBlocks({ latest: null, prices: PRICES, now: NOW }).checked, null);
  assert.equal(pricesBlocks({ latest: outOnly, prices: PRICES, now: NOW }).checked, NOW - 3600e3, "a pack going out of stock still counts as a change");
}

/* ---------- the price line, the shelves and the sizes ---------- */
{
  assert.deepEqual(priceLine([5, 7.5]), { lo: 5, hi: 8, ticks: [5, 6, 7, 8] });
  assert.deepEqual(priceLine([11.99, 13, 19.5]), { lo: 10, hi: 20, ticks: [10, 12, 14, 16, 18, 20] });
  assert.deepEqual(priceLine([7.39, 13.2]), { lo: 6, hi: 14, ticks: [6, 8, 10, 12, 14] });
  assert.deepEqual(priceLine([6]), { lo: 6, hi: 7, ticks: [6, 7] });
  assert.ok(priceLine([3, 480]).ticks.length <= 6);
  // Eggs keep their place by price; one too close to the egg before it goes up a row.
  const line = { lo: 10, hi: 20 };
  const placed = placeEggs([{ price: 13, us: true }, { price: 19.5 }, { price: 13 }, { price: 13.2 }, { price: 15 }], line);
  assert.deepEqual(placed.map((p) => [p.o.price, !!p.o.us, p.x, p.r]), [[13, false, 30, 0], [13, true, 30, 1], [13.2, false, 32, 2], [15, false, 50, 0], [19.5, false, 95, 0]]);
  // A dozen weighs 500, 600, 700 or 800 g.
  assert.deepEqual([[500, 12], [600, 12], [700, 12], [800, 12], [1750, 30], [1500, 30], [900, 18]].map(([g, n]) => sizeOf(g, n).id), ["m", "l", "xl", "j", "xl", "l", "l"]);
  assert.equal(sizeOf(null, 12), null);
}

/* ---------- Sydney time, across daylight saving ---------- */
assert.equal(sydneyTime(Date.parse("2026-11-12T00:45:46Z")), "Thursday 12 November, 11:45am");
assert.equal(sydneyTime(Date.parse("2026-07-01T02:05:00Z")), "Wednesday 1 July, 12:05pm");
assert.equal(sydneyTime(Date.parse("2026-11-12T13:00:00Z")), "Friday 13 November, 12:00am");

/* ---------- filling the built page ---------- */
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const built = readFileSync(join(root, `${PRICES_PATH.slice(1)}.html`), "utf8");
  for (const name of SLOTS) {
    assert.equal(count(built, `<!-- ${name}:start -->`), 1, `${name} slot opens once`);
    assert.equal(count(built, `<!-- ${name}:end -->`), 1, `${name} slot closes once`);
  }
  assert.ok(!built.includes("—"), "no em dashes");
  // As built it has its heading and says prices are coming, so a failed fill still reads as a page.
  assert.match(built, /<h1 id="guide-title">Egg prices in Sydney<\/h1>/);
  assert.match(built, /<p class="board-wait">/);
  // The page's own words make no claim about anyone either, outside the question people search for.
  const words = built.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<summary>[\s\S]*?<\/summary>/g, "");
  assert.ok(!/cheapest|best value|beats|dearer/i.test(words), "no claims in the page's own words");
  const latest = { offers: [offer({}), offer({ shop: "Coles", title: "Coles Free Range Eggs 12 Pack 600g", housing: "free_range", pack_eggs: 12, pack_weight_g: 600, price_aud: 6.6, url: "https://www.coles.com.au/product/fr" })] };
  const once = fillPricesPage(built, { latest, prices: PRICES, now: NOW });
  assert.match(once.html, /Lodge Farms Barn Laid Eggs 1\.5kg/);
  assert.match(once.html, /Coles Free Range Eggs 12 Pack 600g/);
  assert.ok(!once.html.includes("board-wait\">"));
  assert.equal(once.checked, NOW - 3600e3);
  // The board's switch hides the packs by these ids, so the stylesheet must name each one.
  const css = readFileSync(join(root, "styles-modern.css"), "utf8");
  for (const id of ["dozen", "pack18", "tray"]) assert.ok(css.includes(`.guide:has(#pack-${id}:checked) [data-pack]:not([data-pack="${id}"])`), `the stylesheet switches to ${id}`);
  // Filling again gives the same page, and the rest of the page is untouched.
  assert.equal(fillPricesPage(once.html, { latest, prices: PRICES, now: NOW }).html, once.html);
  const strip = (html) => SLOTS.reduce((h, n) => h.replace(new RegExp(`<!-- ${n}:start -->[\\s\\S]*?<!-- ${n}:end -->`), ""), html);
  assert.equal(strip(once.html), strip(built));
  // The structured data on the page still parses, and its answers are on the page.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(once.html)[1]);
  const faq = ld["@graph"].find((n) => n["@type"] === "FAQPage");
  assert.ok(faq.mainEntity.length >= 5);
  for (const q of faq.mainEntity) assert.ok(once.html.includes(`<summary>${q.name}</summary>`), q.name);
  // A page without the slots comes back as it was.
  assert.equal(fillPricesPage("<p>hello</p>", { latest, prices: PRICES, now: NOW }).html, "<p>hello</p>");
  // A price with a dollar sign pattern in it can't disturb the replace.
  const odd = fillPricesPage(built, { latest: { offers: [offer({ title: "Eggs $1 $& $` 30" })] }, prices: PRICES, now: NOW }).html;
  assert.match(odd, /Eggs \$1 \$&amp; \$` 30/);
}

/* ---------- the sitemap date ---------- */
{
  const xml = `<url>\n    <loc>https://getyolko.com/</loc>\n    <lastmod>2026-11-09</lastmod>\n  </url>\n  <url>\n    <loc>https://getyolko.com${PRICES_PATH}</loc>\n    <lastmod>2026-11-12</lastmod>\n  </url>`;
  const later = sitemapWithPriceChange(xml, Date.parse("2026-11-14T06:45:48.080Z"));
  assert.match(later, /egg-prices-sydney<\/loc>\s*<lastmod>2026-11-14T06:45:48\+00:00<\/lastmod>/);
  assert.match(later, /getyolko\.com\/<\/loc>\s*<lastmod>2026-11-09<\/lastmod>/, "other pages keep their dates");
  // An older change never moves the date back, and no change leaves the file alone.
  assert.equal(sitemapWithPriceChange(xml, Date.parse("2026-11-11T00:45:48Z")), xml);
  for (const none of [null, undefined, NaN, 0]) assert.equal(sitemapWithPriceChange(xml, none), xml);
  assert.equal(sitemapWithPriceChange("<urlset></urlset>", NOW), "<urlset></urlset>");
}

console.log("prices page: all checks passed");
