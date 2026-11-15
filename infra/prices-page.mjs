/**
 * The public page /egg-prices-sydney: a guide to what eggs cost in Sydney today, from the shops
 * Admin > Competitors already reads (price-watch.mjs).
 *
 * infra/build-pages.mjs writes egg-prices-sydney.html with two marked slots. The Worker fills
 * them on every request from the same KV record the admin page shows, so the public page and
 * the admin never disagree. This file uses no Node or Worker APIs, so the generator, the Worker
 * and the test (node infra/prices-page-test.mjs) all share it.
 *
 * How it reads. Kanna, 15 Nov 2026, on the first version (tables of other shops with YOLKO's row
 * among them): fix it "without us sounding or looking like creeps". It is a price guide, sorted
 * by the pack and the kind of egg, never shop against shop:
 *   - the poster (the order section's yolk poster, with a real photograph of a tray): one
 *     switch (a dozen, 18 pack, tray of 30) and the price range of the picked pack, its lowest
 *     price in giant type;
 *   - the kinds: a card for cage, cage free and free range, each with its own range and its
 *     packs sorted by price, every pack linking to the shop's own page.
 * YOLKO's own prices have their own section further down the page. They are never a row among
 * the shops' packs, and nothing here measures a shop against YOLKO.
 *
 * Rules for what may show (these are other businesses' prices on a public page):
 *   - only prices the Worker read itself from the shop's own website (never typed-in ones);
 *   - only prices read in the last 24 hours; an older one comes off the page;
 *   - only packs that are in stock, so nobody is told a shop has run out;
 *   - the poster says once when the prices were last updated, and every pack links to the
 *     shop's own page;
 *   - plain numbers, sorted by price. No "cheapest" or "best" claims about anyone.
 * Copy rules are the site's: plain words, no em dashes.
 */

const PRICES_PATH = "/egg-prices-sydney";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The two slots. Their names change whenever their markup does: the Worker goes live with this
// file before the site's pin moves, and a page built for the older markup must be left alone.
const POSTER_SLOT = "guide-poster";
const KINDS_SLOT = "guide-kinds";
const SLOTS = [POSTER_SLOT, KINDS_SLOT];
// The three kinds, in the order Kanna files them (barn laid is cage free).
const KINDS = [
  { id: "caged", name: "Cage", also: "" },
  { id: "barn", name: "Cage free", also: "barn laid" },
  { id: "free_range", name: "Free range", also: "" },
];
// The pack sizes the price check keeps (price-watch.mjs groupOf).
const PACKS = [
  { eggs: 12, id: "dozen", tab: "A dozen", head: "A dozen eggs" },
  { eggs: 18, id: "pack18", tab: "18 pack", head: "An 18 pack" },
  { eggs: 30, id: "tray", tab: "Tray of 30", head: "A tray of 30 eggs" },
];
// A pack's name may only link to the shop it came from.
const SHOP_HOSTS = { Coles: "coles.com.au", Aldi: "aldi.com.au", IGA: "igashop.com.au", Umall: "umall.com.au" };
// The small arrow beside a shop's name: the link leaves the site.
const OUT_ARROW = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l5-5M4.5 3.5h4v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
// An egg that costs a dollar or more is written in dollars: "$1.05", never "105¢".
const cents = (perEgg) => {
  const c = Math.round(perEgg * 100);
  return c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`;
};
const span = (lo, hi, show) => (show(lo) === show(hi) ? show(lo) : `${show(lo)} to ${show(hi)}`);
const list = (words) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** "Thursday 12 November, 11:45am", Sydney time. */
function sydneyTime(ms) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const ampm = get("dayPeriod").toLowerCase().replace(/[^apm]/g, "");
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}${ampm}`;
}

// On the poster the day's name is enough: a price more than a day old is never shown.
const timeTag = (ms) => `<time datetime="${new Date(ms).toISOString()}" title="${sydneyTime(ms)}">${sydneyTime(ms).replace(/^(\S+) [^,]+,/, "$1,")}</time>`;

/** The shop's own page for a pack, or "" when the link is not on that shop's website. */
function shopLink(o) {
  const host = SHOP_HOSTS[o.shop];
  try {
    const u = new URL(String(o.url || ""));
    if (host && u.protocol === "https:" && (u.hostname === host || u.hostname.endsWith(`.${host}`))) return u.toString();
  } catch {}
  return "";
}

/** Shop prices that may show: read by the Worker itself, in the last 24 hours, and complete. */
function freshOffers(latest, now) {
  const kinds = new Set(KINDS.map((k) => k.id));
  const out = [];
  for (const o of latest?.offers || []) {
    if (!o || o.source !== "auto" || !SHOP_HOSTS[o.shop] || !kinds.has(o.housing)) continue;
    const price = Number(o.price_aud);
    const eggs = Number(o.pack_eggs);
    const at = Date.parse(o.checked_at);
    if (!(price > 0) || !(eggs > 0) || !Number.isFinite(at)) continue;
    if (now - at > MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
    out.push({
      shop: o.shop,
      title: String(o.title || "").slice(0, 160),
      housing: o.housing,
      eggs,
      price,
      perEgg: price / eggs,
      out: o.stock === "out_of_stock",
      url: shopLink(o),
      at,
    });
  }
  return out;
}

const byPrice = (a, b) => a.price - b.price || a.shop.localeCompare(b.shop) || a.title.localeCompare(b.title);

/** A price in the poster's giant type: the dollars big, the cents small and raised. */
function bigPrice(price) {
  const [dollars, part] = money(price).slice(1).split(".");
  // The longer the price, the smaller it is set, so the range beside it stays on its line:
  // "$5" is giant, "$13" and "$7.39" a step down, "$11.99" a step below that.
  const size = ["", " is-long", " is-longer"][Math.min(dollars.length + (part ? 1 : 0), 3) - 1];
  return `<span class="pick-num${size}"><span class="pick-cur">$</span>${dollars}${part ? `<span class="pick-cents">.${part}</span>` : ""}</span>`;
}

/** One pack size on the poster: its lowest price in giant type, the highest and the price per egg beside it. */
function posterView(pack, packs) {
  const lo = packs[0].price;
  const hi = packs[packs.length - 1].price;
  return `          <div class="pick-price" data-pack="${pack.id}">
            ${bigPrice(lo)}
            <span class="pick-what"><b>${lo === hi ? pack.head.toLowerCase() : `to ${money(hi)}`}</b><span>${span(lo / pack.eggs, hi / pack.eggs, cents)} an egg</span></span>
          </div>`;
}

function packRow(o) {
  const shop = o.url
    ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.shop)} ${OUT_ARROW}</a>`
    : `<small>${esc(o.shop)}</small>`;
  return `                  <li><b>${money(o.price)}</b><span>${esc(o.title)}</span>${shop}</li>`;
}

/** One pack size as cards: one for each kind of egg, with its range and its packs sorted by price. */
function kindCards(pack, packs) {
  const cards = KINDS.map((k) => {
    const mine = packs.filter((o) => o.housing === k.id);
    const head = `<h3>${k.name}${k.also ? ` <small>${k.also}</small>` : ""}</h3>`;
    if (!mine.length) {
      return `              <li class="kind-card is-empty">
                ${head}
                <p class="kc-none">None online today.</p>
              </li>`;
    }
    const lo = mine[0].price;
    const hi = mine[mine.length - 1].price;
    return `              <li class="kind-card">
                ${head}
                <p class="kc-range">${lo === hi ? `<b>${money(lo)}</b>` : `<b>${money(lo)}</b> <i>to</i> <b>${money(hi)}</b>`}</p>
                <p class="kc-each">${span(lo / pack.eggs, hi / pack.eggs, cents)} an egg</p>
                <ul class="kc-packs">
${mine.map(packRow).join("\n")}
                </ul>
              </li>`;
  });
  return `          <div class="kinds" data-pack="${pack.id}">
            <h2 class="sr-only">${pack.head}, pack by pack</h2>
            <ul class="kind-cards">
${cards.join("\n")}
            </ul>
          </div>`;
}

const waiting = `          <p class="guide-wait">Today's prices are on their way. Look back in a little while.</p>`;

/** The two blocks of the page, as HTML, from the latest price check. */
function pricesBlocks({ latest = null, now = Date.now() } = {}) {
  const fresh = freshOffers(latest, now);
  const checked = fresh.length ? Math.max(...fresh.map((o) => o.at)) : null;
  // A pack nobody can buy today is left off, and so is a size the guide has no switch for.
  const views = PACKS.map((pack) => ({ pack, packs: fresh.filter((o) => !o.out && o.eggs === pack.eggs).sort(byPrice) })).filter((v) => v.packs.length);
  if (!views.length) return { [POSTER_SLOT]: waiting, [KINDS_SLOT]: "", checked };

  const shops = [...new Set(views.flatMap((v) => v.packs.map((o) => o.shop)))].sort();
  const picker = `          <div class="order-choose">
            <fieldset class="picker">
              <legend class="sr-only">Pack size</legend>
${views.map(({ pack }, i) => `              <label class="bundle-opt"><input type="radio" name="pack" id="pack-${pack.id}" value="${pack.id}" autocomplete="off"${i === 0 ? " checked" : ""}><span class="bo-name">${pack.tab}</span></label>`).join("\n")}
            </fieldset>
          </div>`;
  const foot = `          <div class="order-foot guide-foot"><p>Online at ${list(shops.map((s) => `<b>${esc(s)}</b>`))}</p><p>Updated ${timeTag(checked)}</p></div>`;
  const poster = [picker, ...views.map(({ pack, packs }) => posterView(pack, packs)), foot].join("\n");
  const kinds = views.map(({ pack, packs }) => kindCards(pack, packs)).join("\n");
  return { [POSTER_SLOT]: poster, [KINDS_SLOT]: kinds, checked };
}

/** One slot as it sits in the page: the content between its two marker comments. */
function slot(name, content) {
  return `<!-- ${name}:start -->\n${content}\n          <!-- ${name}:end -->`;
}

/** Put fresh blocks into the page the generator wrote. A page without the slots comes back as is. */
function fillPricesPage(html, data) {
  const blocks = pricesBlocks(data);
  let out = String(html);
  for (const name of SLOTS) {
    const re = new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`);
    out = out.replace(re, () => slot(name, blocks[name]));
  }
  return { html: out, checked: blocks.checked };
}

/**
 * The sitemap, with this page's date set to when a price or stock on it last changed (ms). The
 * date never moves backwards: a later build may have changed the page's own words.
 */
function sitemapWithPriceChange(xml, changedMs) {
  if (!Number.isFinite(changedMs) || changedMs <= 0) return String(xml);
  return String(xml).replace(
    new RegExp(`(<loc>[^<]*${PRICES_PATH}</loc>\\s*<lastmod>)([^<]*)(</lastmod>)`),
    (all, before, built, after) => {
      const builtMs = Date.parse(built);
      if (Number.isFinite(builtMs) && builtMs >= changedMs) return all;
      return `${before}${new Date(changedMs).toISOString().replace(/\.\d{3}Z$/, "+00:00")}${after}`;
    }
  );
}

export { pricesBlocks, fillPricesPage, sitemapWithPriceChange, slot, freshOffers, sydneyTime, PRICES_PATH, SLOTS, POSTER_SLOT, KINDS_SLOT, MAX_AGE_MS };
