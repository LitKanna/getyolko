// Checks the public egg prices page (what may show, and how): node infra/prices-page-test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pricesBlocks, fillPricesPage, sitemapWithPriceChange, freshOffers, sydneyTime, SLOTS, POSTER_SLOT, KINDS_SLOT, PRICES_PATH } from "./prices-page.mjs";

const NOW = Date.parse("2026-11-12T02:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600e3).toISOString();
const offer = (o) => ({
  id: "x", shop: "Aldi", title: "Lodge Farms Barn Laid Eggs 1.5kg", housing: "barn", pack_eggs: 30, pack_weight_g: 1500,
  price_aud: 11.99, stock: "in_stock", limit: "", source: "auto", checked_at: at(1),
  url: "https://www.aldi.com.au/product/lodge-farms-barn-laid-eggs", ...o,
});
const count = (html, needle) => html.split(needle).length - 1;
// One pack's part of a block: from its data-pack to the next one.
const part = (html, pack) => {
  const from = html.indexOf(`data-pack="${pack}"`);
  if (from < 0) return "";
  const to = html.indexOf('data-pack="', from + 12);
  return html.slice(from, to < 0 ? html.length : to);
};
// One kind's card in a pack's part: from its heading to the next card.
const card = (html, kind) => {
  const from = html.indexOf(`<h3>${kind}`);
  if (from < 0) return "";
  const to = html.indexOf("<h3>", from + 4);
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

/* ---------- the poster and the kinds ---------- */
{
  const latest = {
    offers: [
      offer({ shop: "Coles", title: "Sunny Queen Free Range X-large Eggs 30 Pack 1.75kg", housing: "free_range", pack_weight_g: 1750, price_aud: 19.5, url: "https://www.coles.com.au/product/sq" }),
      offer({ shop: "Umall", title: "Pace Farm Caged Eggs Large 30 Pack 1.5kg", housing: "caged", price_aud: 9.99, stock: "out_of_stock", limit: "1 per person", url: "https://www.umall.com.au/products/pf" }),
      offer({}),
      offer({ shop: "Coles", title: "Coles Barn Laid Eggs 30 Pack", price_aud: 14.5, url: "https://www.coles.com.au/product/barn" }),
      offer({ shop: "IGA", title: "Canabolas Eggs 30 Pack", housing: "caged", pack_weight_g: null, price_aud: 13, limit: "2 per person", url: "https://www.igashop.com.au/product/c" }),
      offer({ title: "Lodge Farms Cage Eggs 700g", housing: "caged", pack_eggs: 12, pack_weight_g: 700, price_aud: 5 }),
      offer({ shop: "Coles", title: "Coles Free Range Eggs 12 Pack 600g", housing: "free_range", pack_eggs: 12, pack_weight_g: 600, price_aud: 6.6, url: "https://www.coles.com.au/product/fr" }),
      offer({ shop: "Coles", title: "Half dozen", housing: "free_range", pack_eggs: 6, pack_weight_g: 300, price_aud: 4, url: "https://www.coles.com.au/product/six" }),
    ],
  };
  const b = pricesBlocks({ latest, now: NOW });
  const poster = b[POSTER_SLOT];
  const kinds = b[KINDS_SLOT];
  assert.deepEqual(SLOTS, ["guide-poster", "guide-kinds"]);

  // One switch, an option for each pack size that has a pack today, the first one picked.
  assert.equal(count(poster, '<fieldset class="picker">'), 1);
  assert.equal(count(poster, 'type="radio" name="pack"'), 2);
  assert.match(poster, /<input type="radio" name="pack" id="pack-dozen" value="dozen" autocomplete="off" checked><span class="bo-name">A dozen<\/span>/);
  assert.match(poster, /<input type="radio" name="pack" id="pack-tray" value="tray" autocomplete="off"><span class="bo-name">Tray of 30<\/span>/);
  assert.ok(!poster.includes("pack-pack18") && !kinds.includes('data-pack="pack18"'), "no 18 pack today, so no option for it");
  assert.equal(count(poster, '<div class="pick-price" data-pack='), 2);
  assert.equal(count(kinds, '<div class="kinds" data-pack='), 2);
  // A size the guide has no switch for is left off.
  assert.ok(!poster.includes("Half dozen") && !kinds.includes("Half dozen"));

  // A pack nobody can buy today is left off everywhere, and the range starts at what is on sale.
  for (const html of [poster, kinds]) assert.ok(!html.includes("Pace Farm Caged Eggs Large") && !/out of stock/i.test(html));
  // The picked pack's lowest price in giant type, cents small, with the highest and the price per egg beside it.
  const tray = part(poster, "tray");
  assert.match(tray, /<span class="pick-num is-longer"><span class="pick-cur">\$<\/span>11<span class="pick-cents">\.99<\/span><\/span>/);
  assert.match(tray, /<span class="pick-what"><b>to \$19\.50<\/b><span>40¢ to 65¢ an egg<\/span><\/span>/);
  const dozen = part(poster, "dozen");
  assert.match(dozen, /<span class="pick-num"><span class="pick-cur">\$<\/span>5<\/span>/);
  assert.match(dozen, /<span class="pick-what"><b>to \$6\.60<\/b><span>42¢ to 55¢ an egg<\/span><\/span>/);

  // A card for each kind, in Kanna's order, each with its own range and its packs sorted by price.
  const trayCards = part(kinds, "tray");
  assert.match(trayCards, /<h2 class="sr-only">A tray of 30 eggs, pack by pack<\/h2>/);
  assert.deepEqual([...trayCards.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]), ["Cage", "Cage free <small>barn laid</small>", "Free range"]);
  assert.equal(count(trayCards, '<li class="kind-card">'), 3);
  const cageFree = card(trayCards, "Cage free");
  assert.match(cageFree, /<p class="kc-range"><b>\$11\.99<\/b> <i>to<\/i> <b>\$14\.50<\/b><\/p>\s*<p class="kc-each">40¢ to 48¢ an egg<\/p>/);
  assert.deepEqual([...cageFree.matchAll(/<li><b>([^<]+)<\/b><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]),
    [["$11.99", "Lodge Farms Barn Laid Eggs 1.5kg"], ["$14.50", "Coles Barn Laid Eggs 30 Pack"]]);
  // One pack in a kind: one price, no range.
  assert.match(card(trayCards, "Cage<"), /<p class="kc-range"><b>\$13<\/b><\/p>\s*<p class="kc-each">43¢ an egg<\/p>/);
  // Every pack names its shop, and the name opens the shop's own page.
  assert.match(cageFree, /<li><b>\$11\.99<\/b><span>Lodge Farms Barn Laid Eggs 1\.5kg<\/span><a href="https:\/\/www\.aldi\.com\.au\/product\/lodge-farms-barn-laid-eggs" target="_blank" rel="noopener noreferrer">Aldi <svg [^>]*aria-hidden="true">/);
  assert.equal(count(kinds, "<a href="), 6, "six packs on sale, six links");
  // A kind with no pack of this size still has its card, and says so.
  const dozenCards = part(kinds, "dozen");
  assert.match(card(dozenCards, "Cage free"), /^<h3>Cage free <small>barn laid<\/small><\/h3>\s*<p class="kc-none">None online today\.<\/p>/);
  assert.equal(count(dozenCards, '<li class="kind-card is-empty">'), 1);
  assert.equal(count(dozenCards, '<li class="kind-card">'), 2);
  // The guide keeps it spare: a shop's purchase limit is not repeated here.
  assert.ok(!/per person/i.test(poster + kinds));

  // YOLKO is never among the shops' packs: its prices have their own section on the page.
  assert.ok(!/yolko/i.test(poster + kinds));

  // The poster says once where the prices are from and when they were updated.
  assert.equal(count(poster, "<time"), 1);
  assert.match(poster, /<div class="order-foot guide-foot"><p>Online at <b>Aldi<\/b>, <b>Coles<\/b> and <b>IGA<\/b><\/p><p>Updated <time datetime="2026-11-12T01:00:00\.000Z" title="Thursday 12 November, 12:00pm">Thursday, 12:00pm<\/time><\/p><\/div>/);
  assert.ok(!kinds.includes("<time"));
  assert.equal(b.checked, NOW - 3600e3);
  // Never a claim about anyone, and no word about watching shops.
  for (const name of SLOTS) assert.ok(!/cheap|best|lowest|beat|dearer|watch|check|compar/i.test(b[name].replace(/<[^>]+>/g, " ")), `${name} makes no claim`);
  // Nothing in either block needs script.
  for (const name of SLOTS) assert.ok(!/<script|onclick|data-says/i.test(b[name]));

  // One pack in the whole guide: the poster names the pack where the range would be.
  const alone = pricesBlocks({ latest: { offers: [offer({})] }, now: NOW });
  assert.match(part(alone[POSTER_SLOT], "tray"), /<b>a tray of 30 eggs<\/b><span>40¢ an egg<\/span>/);
  assert.equal(count(alone[POSTER_SLOT], 'type="radio" name="pack"'), 1);
  assert.match(alone[POSTER_SLOT], /<p>Online at <b>Aldi<\/b><\/p>/);
  assert.equal(count(part(alone[KINDS_SLOT], "tray"), '<li class="kind-card is-empty">'), 2);

  // Four shops read as a list.
  const four = pricesBlocks({ latest: { offers: [...latest.offers, offer({ shop: "Umall", title: "Umall tray", housing: "caged", price_aud: 12.5, url: "https://www.umall.com.au/products/t" })] }, now: NOW });
  assert.match(four[POSTER_SLOT], /<p>Online at <b>Aldi<\/b>, <b>Coles<\/b>, <b>IGA<\/b> and <b>Umall<\/b><\/p>/);
}

/* ---------- the giant price: the longer it is, the smaller it is set ---------- */
{
  const big = (price, eggs = 12) => /^\s*(<span class="pick-num.*)$/m.exec(
    pricesBlocks({ latest: { offers: [offer({ pack_eggs: eggs, price_aud: price })] }, now: NOW })[POSTER_SLOT])[1];
  assert.equal(big(5), '<span class="pick-num"><span class="pick-cur">$</span>5</span>');
  assert.equal(big(13, 30), '<span class="pick-num is-long"><span class="pick-cur">$</span>13</span>');
  assert.equal(big(7.39, 18), '<span class="pick-num is-long"><span class="pick-cur">$</span>7<span class="pick-cents">.39</span></span>');
  assert.equal(big(11.99, 30), '<span class="pick-num is-longer"><span class="pick-cur">$</span>11<span class="pick-cents">.99</span></span>');
  assert.equal(big(6.5), '<span class="pick-num is-long"><span class="pick-cur">$</span>6<span class="pick-cents">.50</span></span>', "cents always have two digits");
  // An egg that costs a dollar or more is written in dollars.
  const dear = pricesBlocks({ latest: { offers: [offer({ pack_eggs: 12, price_aud: 5 }), offer({ pack_eggs: 12, price_aud: 12.6, housing: "free_range" })] }, now: NOW });
  assert.match(dear[POSTER_SLOT], /<b>to \$12\.60<\/b><span>42¢ to \$1\.05 an egg<\/span>/);
  assert.match(dear[KINDS_SLOT], /<p class="kc-each">\$1\.05 an egg<\/p>/);
}

/* ---------- other people's text is never trusted ---------- */
{
  const latest = {
    offers: [
      offer({ title: 'Eggs <script>alert(1)</script> "30"', limit: "<b>2</b>", url: "https://www.aldi.com.au/x?a=1&b=<2>" }),
      offer({ shop: "Coles", title: "Wrong site", url: "https://evil.example/coles.com.au" }),
      offer({ shop: "Coles", title: "Script link", url: "javascript:alert(1)" }),
      offer({ shop: "Coles", title: "Lookalike", url: "https://notcoles.com.au/p" }),
      offer({ shop: "Coles", title: "Not secure", url: "http://www.coles.com.au/p" }),
    ],
  };
  const b = pricesBlocks({ latest, now: NOW });
  const html = b[POSTER_SLOT] + b[KINDS_SLOT];
  assert.ok(!html.includes("<script>") && !html.includes("<b>2</b>"));
  assert.match(b[KINDS_SLOT], /<span>Eggs &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;30&quot;<\/span>/);
  assert.match(b[KINDS_SLOT], /href="https:\/\/www\.aldi\.com\.au\/x\?a=1&amp;b=%3C2%3E"/);
  for (const t of ["Wrong site", "Script link", "Lookalike", "Not secure"]) {
    assert.match(b[KINDS_SLOT], new RegExp(`<li><b>\\$11\\.99</b><span>${t}</span><small>Coles</small></li>`), `${t} has no link`);
  }
  assert.equal(count(b[KINDS_SLOT], "<a href="), 1);
  assert.ok(!html.includes("evil.example") && !html.includes("javascript:") && !html.includes("notcoles") && !html.includes("http://"));
}

/* ---------- nothing to show: the poster says so, and names nobody ---------- */
{
  const outOnly = { offers: [offer({ stock: "out_of_stock" })] };
  for (const latest of [null, { offers: [] }, { offers: [offer({ checked_at: at(30) })] }, outOnly]) {
    const b = pricesBlocks({ latest, now: NOW });
    assert.match(b[POSTER_SLOT], /^\s*<p class="guide-wait">Today's prices are on their way\. Look back in a little while\.<\/p>$/);
    assert.equal(b[KINDS_SLOT], "");
    assert.ok(!/YOLKO|Aldi|Coles|<time|<input/.test(b[POSTER_SLOT]));
  }
  assert.equal(pricesBlocks({ latest: null, now: NOW }).checked, null);
  assert.equal(pricesBlocks({ latest: outOnly, now: NOW }).checked, NOW - 3600e3, "a pack going out of stock still counts as a change");
  // Called with nothing at all (the build does, before any price is read).
  assert.match(pricesBlocks()[POSTER_SLOT], /guide-wait/);
}

/* ---------- Sydney time, across daylight saving ---------- */
assert.equal(sydneyTime(Date.parse("2026-11-12T00:45:46Z")), "Thursday 12 November, 11:45am");
assert.equal(sydneyTime(Date.parse("2026-07-01T02:05:00Z")), "Wednesday 1 July, 12:05pm");
assert.equal(sydneyTime(Date.parse("2026-11-12T13:00:00Z")), "Friday 13 November, 12:00am");
// The poster shows the day's name and the time; the whole date is there on hover.
assert.match(pricesBlocks({ latest: { offers: [offer({ checked_at: "2026-07-01T02:05:00Z" })] }, now: Date.parse("2026-07-01T03:00:00Z") })[POSTER_SLOT],
  /<time datetime="2026-07-01T02:05:00\.000Z" title="Wednesday 1 July, 12:05pm">Wednesday, 12:05pm<\/time>/);

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
  assert.match(built, /<p class="guide-wait">/);
  assert.equal(count(built, "<h1"), 1);
  // The poster is the order section's, with a real photograph: every size it names is in the repo,
  // and nothing calls the eggs in it YOLKO's.
  assert.match(built, /<div class="order-stage guide-poster" data-order-bar-after>/);
  const photo = /<picture class="order-tray-photo is-active">([\s\S]*?)<\/picture>/.exec(built)[1];
  const files = [...new Set([...photo.matchAll(/\/assets\/price-guide\/[a-z0-9-]+\.(?:webp|jpg)/g)].map((m) => m[0]))];
  assert.equal(files.length, 6, "three widths, as webp and as jpg");
  for (const f of files) assert.ok(existsSync(join(root, f)), `${f} is in the repo`);
  assert.match(photo, /<img src="\/assets\/price-guide\/tray-1200\.jpg\?v=\d+"[^>]* width="1200" height="800" fetchpriority="high" decoding="async" alt="Brown eggs in a paper tray">/);
  assert.equal(count(photo, 'sizes="'), 2, "both sources say how wide the photo is drawn");
  // The page's own words make no claim about anyone either, outside the question people search for.
  const words = built.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<summary>[\s\S]*?<\/summary>/g, "");
  assert.ok(!/cheapest|best value|beats|dearer/i.test(words), "no claims in the page's own words");
  const latest = { offers: [offer({}), offer({ shop: "Coles", title: "Coles Free Range Eggs 12 Pack 600g", housing: "free_range", pack_eggs: 12, pack_weight_g: 600, price_aud: 6.6, url: "https://www.coles.com.au/product/fr" })] };
  const once = fillPricesPage(built, { latest, now: NOW });
  assert.match(once.html, /Lodge Farms Barn Laid Eggs 1\.5kg/);
  assert.match(once.html, /Coles Free Range Eggs 12 Pack 600g/);
  assert.ok(!once.html.includes('guide-wait">'));
  assert.equal(once.checked, NOW - 3600e3);
  // The switch and both blocks sit inside .guide, where the stylesheet's :has() can see them.
  const guide = /<section class="guide"[\s\S]*?<\/section>/.exec(once.html)[0];
  assert.equal(count(guide, 'type="radio" name="pack"'), 2);
  assert.equal(count(guide, 'data-pack="'), 4);
  assert.match(guide, /<p class="guide-note">/);
  // The switch hides the other packs by these ids, so the stylesheet must name each one.
  const css = readFileSync(join(root, "styles-modern.css"), "utf8");
  for (const id of ["dozen", "pack18", "tray"]) assert.ok(css.includes(`.guide:has(#pack-${id}:checked) [data-pack]:not([data-pack="${id}"])`), `the stylesheet switches to ${id}`);
  // Every class the Worker writes has its styles in the pinned stylesheet.
  for (const cls of ["pick-cents", "is-longer", "guide-foot", "guide-wait", "kind-cards", "kind-card", "kc-range", "kc-each", "kc-packs", "kc-none"]) {
    assert.ok(new RegExp(`\\.${cls}\\b`).test(css), `.${cls} is styled`);
  }
  // The page links the stylesheet version the build wrote into the other pages.
  const v = /styles-modern\.css\?v=(\d+)/.exec(built)[1];
  assert.equal(/styles-modern\.css\?v=(\d+)/.exec(readFileSync(join(root, "index.html"), "utf8"))[1], v);
  // Filling again gives the same page, and the rest of the page is untouched.
  assert.equal(fillPricesPage(once.html, { latest, now: NOW }).html, once.html);
  const strip = (html) => SLOTS.reduce((h, n) => h.replace(new RegExp(`<!-- ${n}:start -->[\\s\\S]*?<!-- ${n}:end -->`), ""), html);
  assert.equal(strip(once.html), strip(built));
  // The structured data on the page still parses, and its answers are on the page.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(once.html)[1]);
  const faq = ld["@graph"].find((n) => n["@type"] === "FAQPage");
  assert.ok(faq.mainEntity.length >= 5);
  for (const q of faq.mainEntity) assert.ok(once.html.includes(`<summary>${q.name}</summary>`), q.name);
  // A page without the slots comes back as it was: an older pinned page (slots guide-board and
  // guide-packs) is left alone, never filled with markup it has no styles for.
  assert.equal(fillPricesPage("<p>hello</p>", { latest, now: NOW }).html, "<p>hello</p>");
  const older = "<!-- guide-board:start -->\nold board\n<!-- guide-board:end --><!-- guide-packs:start -->\nold packs\n<!-- guide-packs:end -->";
  assert.equal(fillPricesPage(older, { latest, now: NOW }).html, older);
  // A price with a dollar sign pattern in it can't disturb the replace.
  const odd = fillPricesPage(built, { latest: { offers: [offer({ title: "Eggs $1 $& $` 30" })] }, now: NOW }).html;
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
