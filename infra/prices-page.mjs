/**
 * The public page /egg-prices-sydney: what eggs cost at the shops Admin > Competitors already
 * reads (price-watch.mjs), next to YOLKO's own tray.
 *
 * infra/build-pages.mjs writes egg-prices-sydney.html with three marked slots. The Worker fills
 * the slots on every request from the same KV record the admin page shows, so the public page
 * and the admin never disagree. This file uses no Node or Worker APIs, so the generator, the
 * Worker and the test (node infra/prices-page-test.mjs) all share it.
 *
 * Rules for what may show (these are other businesses' prices on a public page):
 *   - only prices the Worker read itself from the shop's own website (never typed-in ones);
 *   - only prices read in the last 24 hours; an older one comes off the page;
 *   - every table says when it was checked, and every pack links to the shop's own page;
 *   - plain numbers, sorted by price per egg. No "cheapest" or "best" claims about anyone.
 * Copy rules are the site's: plain words, no em dashes.
 */

const PRICES_PATH = "/egg-prices-sydney";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SLOTS = ["prices-trays", "prices-packs", "prices-sources"];
const KINDS = { caged: "Cage", barn: "Cage free (barn laid)", free_range: "Free range" };
const KIND_ORDER = ["caged", "barn", "free_range"];
const KIND_HEAD = { caged: "Cage eggs", barn: "Cage free eggs (barn laid)", free_range: "Free range eggs" };
// A pack's name may only link to the shop it came from.
const SHOP_HOSTS = { Coles: "coles.com.au", Aldi: "aldi.com.au", IGA: "igashop.com.au", Umall: "umall.com.au" };
// The main tray, by the Admin > Stock & prices "tray weight" setting.
const MAIN_TRAY = {
  "1.75": { grams: 1750, name: "Pace Farm extra-large cage eggs, 30" },
  "1.5": { grams: 1500, name: "Pace Farm large cage eggs, 30" },
};

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const cents = (perEgg) => `${Math.round(perEgg * 100)}¢`;
const perKilo = (price, grams) => (grams > 0 ? price / (grams / 1000) : null);

function weightText(grams) {
  if (!(grams > 0)) return "";
  return grams >= 1000 ? `${String(grams / 1000)}&nbsp;kg` : `${grams}&nbsp;g`;
}

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

const timeTag = (ms) => `<time datetime="${new Date(ms).toISOString()}">${sydneyTime(ms)}</time>`;

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
  const out = [];
  for (const o of latest?.offers || []) {
    if (!o || o.source !== "auto" || !SHOP_HOSTS[o.shop] || !KINDS[o.housing]) continue;
    const price = Number(o.price_aud);
    const eggs = Number(o.pack_eggs);
    const at = Date.parse(o.checked_at);
    if (!(price > 0) || !(eggs > 0) || !Number.isFinite(at)) continue;
    if (now - at > MAX_AGE_MS || at - now > 5 * 60 * 1000) continue;
    const grams = Number(o.pack_weight_g) > 0 ? Number(o.pack_weight_g) : null;
    out.push({
      shop: o.shop,
      title: String(o.title || "").slice(0, 160),
      housing: o.housing,
      eggs,
      grams,
      price,
      perEgg: price / eggs,
      perKilo: perKilo(price, grams),
      out: o.stock === "out_of_stock",
      limit: String(o.limit || "").slice(0, 60),
      url: shopLink(o),
      at,
    });
  }
  return out;
}

// In stock first, then by price per egg, then by price.
const byValue = (a, b) => Number(a.out) - Number(b.out) || a.perEgg - b.perEgg || a.price - b.price || a.shop.localeCompare(b.shop);

/** YOLKO's own tray as a row, from the live shop settings. null when the tray has no price. */
function ownTray({ prices, trayWeight, soldOut }) {
  const price = Number(prices?.tray1);
  if (!(price > 0)) return null;
  const tray = MAIN_TRAY[trayWeight] || null;
  return {
    us: true,
    shop: "YOLKO",
    title: tray ? tray.name : "Tray of 30 eggs",
    housing: tray ? "caged" : null,
    eggs: 30,
    grams: tray ? tray.grams : null,
    price,
    perEgg: price / 30,
    perKilo: tray ? perKilo(price, tray.grams) : null,
    out: !!soldOut,
    limit: "",
    url: "/#order",
    at: null,
  };
}

function row(o) {
  const meta = [];
  if (o.housing) meta.push(esc(KINDS[o.housing]));
  if (o.grams) meta.push(weightText(o.grams));
  if (o.us) meta.push("delivered Saturday");
  if (o.limit) meta.push(esc(o.limit));
  if (o.out) meta.push(`<span class="cmp-out">${o.us ? "Sold out this week" : "Out of stock online"}</span>`);
  const name = o.url
    ? o.us
      ? `<a href="${esc(o.url)}">${esc(o.title)}</a>`
      : `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.title)}</a>`
    : esc(o.title);
  const kilo = o.perKilo ? `${money(Math.round(o.perKilo * 100) / 100)}<span class="cmp-unit"> a kilo</span>` : "";
  return `            <tr${o.us ? ' class="cmp-us"' : ""}>
              <th scope="row">${esc(o.shop)}</th>
              <td class="cmp-pack">${name}<span class="cmp-meta">${meta.join(" · ")}</span></td>
              <td class="cmp-price">${money(o.price)}</td>
              <td class="cmp-num">${cents(o.perEgg)}<span class="cmp-unit"> an egg</span></td>
              <td class="cmp-num">${kilo}</td>
            </tr>`;
}

function table(rows, caption) {
  return `          <table class="cmp-table">
            <caption class="sr-only">${caption}</caption>
            <thead><tr><th scope="col">Shop</th><th scope="col">Pack</th><th scope="col">Price</th><th scope="col">Per egg</th><th scope="col">Per kilo</th></tr></thead>
            <tbody>
${rows.join("\n")}
            </tbody>
          </table>`;
}

const waiting = `          <p class="cmp-note">We are checking the shops' prices again. Look back in a little while.</p>`;

/** The three blocks of the page, as HTML, from the latest price check and the shop's own settings. */
function pricesBlocks({ latest = null, prices = {}, trayWeight = "1.75", soldOut = false, delivery = 5, now = Date.now() } = {}) {
  const offers = freshOffers(latest, now);
  const checked = offers.length ? Math.max(...offers.map((o) => o.at)) : null;
  const us = ownTray({ prices, trayWeight, soldOut });
  const stamp = checked ? `          <p class="cmp-checked">Checked ${timeTag(checked)}, Sydney time.</p>\n` : "";

  /* Trays of 30, with YOLKO's tray in its place. */
  const shopTrays = offers.filter((o) => o.eggs === 30);
  const trayRows = [...shopTrays, ...(us ? [us] : [])].sort(byValue);
  const inStock = shopTrays.filter((o) => !o.out).map((o) => o.price);
  let range = "";
  if (inStock.length) {
    const lo = Math.min(...inStock);
    const hi = Math.max(...inStock);
    range = lo === hi
      ? `A pack of 30 in stock at these shops is ${money(lo)}.`
      : `Packs of 30 in stock at these shops run from ${money(lo)} to ${money(hi)}.`;
    if (us) range += ` YOLKO's tray of 30 is ${money(us.price)}.`;
  }
  const two = Number(prices?.tray2);
  const box = Number(prices?.box);
  const more = [];
  if (us && two > 0) more.push(`two trays are ${money(two)} (${money(two / 2)} each)`);
  if (us && box > 0) more.push(`a box of six is ${money(box)} (${money(box / 6)} each)`);
  const own = us
    ? `          <p class="cmp-note">At YOLKO ${more.length ? `${more.join(" and ")}. ` : ""}Delivery is ${money(Number(delivery))} an order, however many trays you buy.</p>`
    : "";
  const trays = [
    stamp + (range ? `          <p class="cmp-lead">${range}</p>` : ""),
    trayRows.length ? table(trayRows.map(row), "Price of a tray of 30 eggs at each shop") : "",
    shopTrays.length ? "" : waiting,
    own,
  ].filter((s) => s.trim()).join("\n");

  /* Dozens and 18 packs, grouped by kind. */
  const small = offers.filter((o) => o.eggs !== 30);
  const groups = KIND_ORDER.map((k) => [k, small.filter((o) => o.housing === k).sort(byValue)]).filter(([, list]) => list.length);
  const packRows = groups.flatMap(([k, list]) => [
    `            <tr class="cmp-group"><th colspan="5" scope="colgroup">${KIND_HEAD[k]}</th></tr>`,
    ...list.map(row),
  ]);
  const dozen = us ? `          <p class="cmp-note">YOLKO sells by the tray. 30 eggs for ${money(us.price)} works out at ${money(Math.round((us.price / 30) * 12 * 100) / 100)} a dozen.</p>` : "";
  const packs = [stamp.trimEnd(), packRows.length ? table(packRows, "Price of a dozen or an 18 pack of eggs at each shop") : waiting, dozen]
    .filter((s) => s.trim())
    .join("\n");

  /* When each shop was last read. */
  const shops = [...new Set(offers.map((o) => o.shop))].sort();
  const sources = shops.length
    ? `          <ul class="cmp-sources">
${shops.map((s) => `            <li><strong>${esc(s)}</strong> checked ${timeTag(Math.max(...offers.filter((o) => o.shop === s).map((o) => o.at)))}</li>`).join("\n")}
          </ul>`
    : waiting;

  return { "prices-trays": trays, "prices-packs": packs, "prices-sources": sources, checked };
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

export { pricesBlocks, fillPricesPage, sitemapWithPriceChange, slot, freshOffers, sydneyTime, PRICES_PATH, SLOTS, MAX_AGE_MS };
