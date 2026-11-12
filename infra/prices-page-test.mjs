// Checks the public egg prices page (what may show, and how): node infra/prices-page-test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pricesBlocks, fillPricesPage, sitemapWithPriceChange, freshOffers, sydneyTime, SLOTS, PRICES_PATH } from "./prices-page.mjs";

const NOW = Date.parse("2026-11-12T02:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600e3).toISOString();
const offer = (o) => ({
  id: "x", shop: "Aldi", title: "Lodge Farms Barn Laid Eggs 1.5kg", housing: "barn", pack_eggs: 30, pack_weight_g: 1500,
  price_aud: 11.99, stock: "in_stock", limit: "", source: "auto", checked_at: at(1),
  url: "https://www.aldi.com.au/product/lodge-farms-barn-laid-eggs", ...o,
});
const PRICES = { tray1: 13, tray2: 25, box: 72 };
const count = (html, needle) => html.split(needle).length - 1;

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
  assert.equal(fresh[0].perKilo.toFixed(2), "7.99");
  assert.deepEqual(freshOffers(null, NOW), []);
  assert.deepEqual(freshOffers({}, NOW), []);
}

/* ---------- the tray table ---------- */
{
  const latest = {
    offers: [
      offer({ shop: "Coles", title: "Sunny Queen Free Range X-large Eggs 30 Pack 1.75kg", housing: "free_range", pack_weight_g: 1750, price_aud: 19.5, url: "https://www.coles.com.au/product/sq" }),
      offer({ shop: "Umall", title: "Pace Farm Caged Eggs Large 30 Pack 1.5kg", housing: "caged", price_aud: 9.99, stock: "out_of_stock", limit: "1 per person", url: "https://www.umall.com.au/products/pf" }),
      offer({}),
      offer({ shop: "IGA", title: "Canabolas Eggs 30 Pack", housing: "caged", pack_weight_g: null, price_aud: 13, url: "https://www.igashop.com.au/product/c" }),
      offer({ title: "Lodge Farms Cage Eggs 700g", housing: "caged", pack_eggs: 12, pack_weight_g: 700, price_aud: 5 }),
    ],
  };
  const b = pricesBlocks({ latest, prices: PRICES, trayWeight: "1.75", now: NOW });
  const trays = b["prices-trays"];
  // In stock first by price per egg, YOLKO in its place, out of stock last.
  const order = ["Lodge Farms Barn Laid", "Canabolas", "Pace Farm extra-large cage eggs, 30", "Sunny Queen", "Pace Farm Caged Eggs Large"];
  const where = order.map((t) => trays.indexOf(t));
  assert.ok(where.every((n) => n >= 0), "every tray is listed");
  assert.deepEqual([...where].sort((x, y) => x - y), where, "trays are in price order, out of stock last");
  assert.equal(count(trays, '<tr class="cmp-us">'), 1);
  assert.match(trays, /<th scope="row">YOLKO<\/th>/);
  assert.match(trays, /\$13<\/td>\s*<td class="cmp-num">43¢/);
  assert.match(trays, /\$7\.43<span class="cmp-unit"> a kilo<\/span>/);
  assert.match(trays, /Out of stock online/);
  assert.match(trays, /1 per person/);
  // The lead only speaks about packs in stock.
  assert.match(trays, /Packs of 30 in stock at these shops run from \$11\.99 to \$19\.50\. YOLKO's tray of 30 is \$13\./);
  assert.match(trays, /two trays are \$25 \(\$12\.50 each\) and a box of six is \$72 \(\$12 each\)\. Delivery is \$5 an order/);
  assert.match(trays, /Checked <time datetime="2026-11-12T01:00:00\.000Z">Thursday 12 November, 12:00pm<\/time>, Sydney time\./);
  // The dozen is in the other table, under its kind.
  assert.ok(!trays.includes("Lodge Farms Cage Eggs 700g"));
  assert.match(b["prices-packs"], /Cage eggs<\/th><\/tr>\s*<tr>\s*<th scope="row">Aldi<\/th>\s*<td class="cmp-pack"><a href="https:\/\/www\.aldi\.com\.au\/product\/lodge-farms-barn-laid-eggs" target="_blank" rel="noopener noreferrer">Lodge Farms Cage Eggs 700g/);
  assert.match(b["prices-packs"], /30 eggs for \$13 works out at \$5\.20 a dozen/);
  // One line per shop saying when it was read.
  assert.equal(count(b["prices-sources"], "<li>"), 4);
  // Never a claim about who is cheapest.
  for (const name of SLOTS) assert.ok(!/cheapest|best value|lowest/i.test(b[name]), `${name} makes no claim`);
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
  const html = pricesBlocks({ latest, prices: PRICES, now: NOW })["prices-trays"];
  assert.ok(!html.includes("<script>") && !html.includes("<b>2</b>"));
  assert.match(html, /Eggs &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;30&quot;/);
  assert.match(html, /href="https:\/\/www\.aldi\.com\.au\/x\?a=1&amp;b=%3C2%3E"/);
  for (const t of ["Wrong site", "Script link", "Lookalike"]) assert.match(html, new RegExp(`<td class="cmp-pack">${t}<span`), `${t} has no link`);
  assert.ok(!html.includes("evil.example") && !html.includes("javascript:") && !html.includes("notcoles"));
}

/* ---------- nothing fresh: only YOLKO, and it says so ---------- */
{
  for (const latest of [null, { offers: [] }, { offers: [offer({ checked_at: at(30) })] }]) {
    const b = pricesBlocks({ latest, prices: PRICES, now: NOW });
    assert.equal(count(b["prices-trays"], "<tr"), 2, "heading row and YOLKO's row");
    assert.match(b["prices-trays"], /We are checking the shops' prices again/);
    assert.ok(!b["prices-trays"].includes("Checked <time"));
    assert.ok(!b["prices-packs"].includes("<table"));
    assert.match(b["prices-sources"], /We are checking the shops' prices again/);
    assert.equal(b.checked, null);
  }
  // A sold out week and another tray size.
  const sold = pricesBlocks({ latest: null, prices: PRICES, trayWeight: "1.5", soldOut: true, now: NOW })["prices-trays"];
  assert.match(sold, /Pace Farm large cage eggs, 30/);
  assert.match(sold, /Sold out this week/);
  assert.match(sold, /\$8\.67<span class="cmp-unit"> a kilo/);
  // No tray price saved: YOLKO is left out instead of showing $0.
  const none = pricesBlocks({ latest: null, prices: { tray1: 0 }, now: NOW });
  assert.ok(!none["prices-trays"].includes("YOLKO"));
  assert.ok(!none["prices-packs"].includes("YOLKO"));
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
  // As built it already shows YOLKO's own tray, so a failed fill still reads as a page.
  assert.match(built, /<tr class="cmp-us">/);
  const latest = { offers: [offer({}), offer({ shop: "Coles", title: "Coles Free Range Eggs 12 Pack 600g", housing: "free_range", pack_eggs: 12, pack_weight_g: 600, price_aud: 6.6, url: "https://www.coles.com.au/product/fr" })] };
  const once = fillPricesPage(built, { latest, prices: PRICES, now: NOW });
  assert.match(once.html, /Lodge Farms Barn Laid Eggs 1\.5kg/);
  assert.match(once.html, /Coles Free Range Eggs 12 Pack 600g/);
  assert.equal(once.checked, NOW - 3600e3);
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
