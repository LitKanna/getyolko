/**
 * The public page /egg-prices-sydney: a guide to what eggs cost in Sydney today, from the shops
 * Admin > Competitors already reads (price-watch.mjs).
 *
 * infra/build-pages.mjs writes egg-prices-sydney.html with two marked slots. The Worker fills
 * them on every request from the same KV record the admin page shows, so the public page and
 * the admin never disagree. This file uses no Node or Worker APIs, so the generator, the Worker
 * and the test (node infra/prices-page-test.mjs) all share it.
 *
 * How it reads (Kanna, 15 Nov 2026: the first version was tables of other shops with YOLKO's
 * row highlighted among them, and it made YOLKO look like it was watching them). It is a price
 * guide now, sorted by the pack and the kind of egg, not by shop:
 *   - the board: one switch (a dozen, 18 pack, tray of 30), the price range in big type, and
 *     a shelf for each kind of egg with one egg drawn for each pack, placed by its price;
 *   - the packs: the same packs as a list under each kind, each linking to the shop's own page.
 * YOLKO's own tray is one egg with a yolk on the tray board and nothing more. It is never a row
 * among the shops' packs.
 *
 * Rules for what may show (these are other businesses' prices on a public page):
 *   - only prices the Worker read itself from the shop's own website (never typed-in ones);
 *   - only prices read in the last 24 hours; an older one comes off the page;
 *   - only packs that are in stock, so nobody is told a shop has run out;
 *   - the board says once when the prices were last updated, and every pack links to the shop's
 *     own page;
 *   - plain numbers, sorted by price. No "cheapest" or "best" claims about anyone.
 * Copy rules are the site's: plain words, no em dashes.
 */

const PRICES_PATH = "/egg-prices-sydney";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SLOTS = ["guide-board", "guide-packs"];
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
// Egg sizes by the weight of one egg (a dozen weighs 500, 600, 700 or 800 g).
const SIZES = [
  { id: "m", name: "medium", upTo: 46 },
  { id: "l", name: "large", upTo: 54 },
  { id: "xl", name: "extra-large", upTo: 62.5 },
  { id: "j", name: "jumbo", upTo: Infinity },
];
// A pack's name may only link to the shop it came from.
const SHOP_HOSTS = { Coles: "coles.com.au", Aldi: "aldi.com.au", IGA: "igashop.com.au", Umall: "umall.com.au" };
// The main tray, by the Admin > Stock & prices "tray weight" setting.
const MAIN_TRAY = { "1.75": 1750, "1.5": 1500 };
// Where YOLKO's egg on the board leads: the shop's own prices, further down the page.
const OWN_PRICES = "#prices-title";
// Two eggs on one shelf closer than this (as a share of the shelf's width) sit on top of each
// other; a little further apart they lean on each other, the way eggs do (each has an ink edge,
// so two that touch still read as two). On the narrowest phone the shelf is about 220px and an
// egg about 18px, so at this gap the one behind still shows at least half of itself.
const EGG_GAP = 4.5;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const cents = (perEgg) => `${Math.round(perEgg * 100)}¢`;
const span = (lo, hi, show) => (show(lo) === show(hi) ? show(lo) : `${show(lo)} to ${show(hi)}`);
const list = (words) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

function sizeOf(grams, eggs) {
  if (!(grams > 0) || !(eggs > 0)) return null;
  const each = grams / eggs;
  return SIZES.find((s) => each < s.upTo);
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
  const kinds = new Set(KINDS.map((k) => k.id));
  const out = [];
  for (const o of latest?.offers || []) {
    if (!o || o.source !== "auto" || !SHOP_HOSTS[o.shop] || !kinds.has(o.housing)) continue;
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
      out: o.stock === "out_of_stock",
      limit: String(o.limit || "").slice(0, 60),
      url: shopLink(o),
      at,
    });
  }
  return out;
}

const byPrice = (a, b) => a.price - b.price || a.shop.localeCompare(b.shop) || a.title.localeCompare(b.title);

/** YOLKO's own tray as it sits on the tray board, from the live shop settings. null without a price. */
function ownTray({ prices, trayWeight, soldOut }) {
  const price = Number(prices?.tray1);
  if (!(price > 0)) return null;
  return { us: true, housing: "caged", eggs: 30, grams: MAIN_TRAY[trayWeight] || null, price, perEgg: price / 30, soldOut: !!soldOut };
}

/** A price line that holds every value: whole steps of $1, $2, $5 and so on, five at most. */
function priceLine(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const step of [1, 2, 5, 10, 20, 50, 100]) {
    const lo = Math.floor(min / step) * step;
    let hi = Math.ceil(max / step) * step;
    if (hi === lo) hi = lo + step;
    if ((hi - lo) / step > 5) continue;
    const ticks = [];
    for (let t = lo; t <= hi; t += step) ticks.push(t);
    return { lo, hi, ticks };
  }
  return { lo: min, hi: max > min ? max : min + 1, ticks: [] };
}

/** Where each egg sits: across by price, and up a row when the egg before it is too close. */
function placeEggs(eggs, line) {
  const rows = [];
  return [...eggs].sort((a, b) => a.price - b.price || Number(!!a.us) - Number(!!b.us)).map((o) => {
    const x = ((o.price - line.lo) / (line.hi - line.lo)) * 100;
    let r = rows.findIndex((last) => x - last >= EGG_GAP);
    if (r < 0) r = rows.length;
    rows[r] = x;
    return { o, x: Math.round(x * 100) / 100, r };
  });
}

function eggMark({ o, x, r }) {
  const size = sizeOf(o.grams, o.eggs);
  const cls = `egg${size ? ` egg-${size.id}` : ""}${o.us ? " egg-us" : ""}`;
  const says = o.us
    ? `YOLKO, ${money(o.price)} a tray, delivered Saturday`
    : `${o.shop}, ${money(o.price)}: ${o.title}`;
  return `                  <a class="${cls}" href="${o.us ? OWN_PRICES : `#${o.id}`}" style="--x:${x};--r:${r}" tabindex="-1" data-says="${esc(says)}"></a>`;
}

/** One pack size on the board: the price range in big type, then a shelf for each kind. */
function boardView(pack, packs, us) {
  const prices = packs.map((o) => o.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const line = priceLine([...prices, ...(us ? [us.price] : [])]);
  const shelves = KINDS.map((k) => {
    const mine = packs.filter((o) => o.housing === k.id);
    const eggs = [...mine, ...(us && us.housing === k.id ? [us] : [])];
    if (!eggs.length) return "";
    const placed = placeEggs(eggs, line);
    const rows = Math.max(...placed.map((p) => p.r)) + 1;
    const range = mine.length ? span(Math.min(...mine.map((o) => o.price)), Math.max(...mine.map((o) => o.price)), money) : "";
    return `              <div class="shelf">
                <p class="shelf-name"><b>${k.name}</b>${range ? `<span>${range}</span>` : ""}</p>
                <div class="shelf-line" style="--rows:${rows}">
${placed.map(eggMark).join("\n")}
                </div>
              </div>`;
  }).filter(Boolean);
  const perEgg = span(lo / pack.eggs, hi / pack.eggs, cents);
  const long = money(lo).length > 3;
  const what = lo === hi
    ? `<b>${pack.tab.toLowerCase()}</b><span>${perEgg} an egg</span>`
    : `<b>to ${money(hi)}</b><span>${perEgg} an egg</span>`;
  const key = us
    ? `
            <p class="board-key"><span class="egg egg-us" aria-hidden="true"></span><span>YOLKO's tray is ${money(us.price)}, ${us.soldOut ? "sold out this week" : `<a href="${OWN_PRICES}">delivered Saturday</a>`}</span></p>`
    : "";
  return `          <div class="board-view" data-pack="${pack.id}">
            <div class="board-price">
              <p class="bp-num${long ? " is-long" : ""}">${lo === hi ? "" : '<span class="bp-from">From</span>'}<span class="bp-cur">$</span>${money(lo).slice(1)}</p>
              <p class="bp-what">${what}</p>
            </div>
            <div class="shelves" aria-hidden="true">
${shelves.join("\n")}
              <ol class="shelf-axis">
${line.ticks.map((t) => `                <li style="--x:${Math.round(((t - line.lo) / (line.hi - line.lo)) * 10000) / 100}">${money(t)}</li>`).join("\n")}
              </ol>
            </div>
            <p class="board-tip" data-tip>Each egg is a pack. Bigger eggs are drawn bigger. Tap one to see it.</p>${key}
          </div>`;
}

function packRow(o) {
  const size = sizeOf(o.grams, o.eggs);
  const meta = [`<b>${esc(o.shop)}</b>`];
  // Hard spaces, so a narrow card breaks the line between two facts and never inside one.
  if (size) meta.push(`${size.name}&nbsp;eggs`);
  meta.push(`${cents(o.perEgg)}&nbsp;an&nbsp;egg`);
  if (o.limit) meta.push(esc(o.limit));
  const inner = `<span class="pk-price">${money(o.price)}</span><span class="pk-name">${esc(o.title)}</span><span class="pk-meta">${meta.join(" · ")}</span>`;
  return `                <li id="${o.id}" data-c="${Math.round(o.perEgg * 100)}">${o.url
    ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div>${inner}</div>`}</li>`;
}

/** One pack size as a list: a card for each kind of egg, its packs sorted by price. */
function packCards(pack, packs) {
  const cards = KINDS.map((k) => {
    const mine = packs.filter((o) => o.housing === k.id);
    if (!mine.length) return "";
    return `            <section class="kind-card">
              <h3>${k.name}${k.also ? ` <span>${k.also}</span>` : ""}</h3>
              <ul>
${mine.map(packRow).join("\n")}
              </ul>
            </section>`;
  }).filter(Boolean);
  return `          <div class="packs" data-pack="${pack.id}">
            <header class="section-head">
              <h2>${pack.head}</h2>
              <p>${packs.length === 1 ? "One pack today." : `${packs.length} packs today, sorted by price.`}</p>
            </header>
            <div class="kind-cards" data-cards="${cards.length}">
${cards.join("\n")}
            </div>
          </div>`;
}

const waiting = `          <p class="board-wait">Today's prices are on their way. Look back in a little while.</p>`;

/** The two blocks of the page, as HTML, from the latest price check and the shop's own settings. */
function pricesBlocks({ latest = null, prices = {}, trayWeight = "1.75", soldOut = false, now = Date.now() } = {}) {
  const fresh = freshOffers(latest, now);
  const checked = fresh.length ? Math.max(...fresh.map((o) => o.at)) : null;
  const us = ownTray({ prices, trayWeight, soldOut });
  // A pack nobody can buy today is left off, and so is a size the guide has no switch for.
  const views = PACKS.map((pack) => {
    const packs = fresh.filter((o) => !o.out && o.eggs === pack.eggs).sort(byPrice).map((o, i) => ({ ...o, id: `${pack.id}-${i + 1}` }));
    return { pack, packs };
  }).filter((v) => v.packs.length);
  if (!views.length) return { "guide-board": waiting, "guide-packs": "", checked };

  const shops = [...new Set(views.flatMap((v) => v.packs.map((o) => o.shop)))].sort();
  const picker = `          <fieldset class="picker board-picker">
            <legend class="sr-only">Pack size</legend>
${views.map(({ pack }, i) => `            <label class="bundle-opt"><input type="radio" name="pack" id="pack-${pack.id}" value="${pack.id}"${i === 0 ? " checked" : ""}><span>${pack.tab}</span></label>`).join("\n")}
          </fieldset>`;
  const foot = `          <p class="board-foot"><span>Online prices at ${list(shops.map(esc))}</span><span>Updated ${timeTag(checked)}</span></p>`;
  const board = [picker, ...views.map(({ pack, packs }) => boardView(pack, packs, pack.eggs === 30 ? us : null)), foot].join("\n");
  const packs = views.map(({ pack, packs: p }) => packCards(pack, p)).join("\n");
  return { "guide-board": board, "guide-packs": packs, checked };
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

export { pricesBlocks, fillPricesPage, sitemapWithPriceChange, slot, freshOffers, sydneyTime, sizeOf, priceLine, placeEggs, PRICES_PATH, SLOTS, MAX_AGE_MS };
