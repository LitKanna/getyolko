/**
 * Competitor egg prices for Admin > Competitors. Comparison only: nothing here ever changes
 * YOLKO's own prices (those are whatever is saved in Admin > Stock & prices).
 *
 * No Australian supermarket offers a price API, so the Worker reads public pages that the
 * shops' robots.txt allows, every 6 hours and when the owner taps Check now:
 *   Coles           /browse/dairy-eggs-fridge/eggs   every egg on one page (Next.js page data)
 *   Aldi            /products/dairy-eggs-fridge/eggs  every egg on one page (product tiles)
 *   IGA             one product page (JSON-LD)
 *   Umall           Shopify /products/<handle>.js
 *   Gourmet Grocer  WooCommerce product page (JSON-LD)
 * Woolworths blocks every automated request (Akamai "Access Denied", even for robots.txt) and
 * Costco only sells eggs through DoorDash, which blocks bots and bans scraping in its terms.
 * Those two are typed in by the owner (TYPED_KEY) and shown with the date they were typed.
 *
 * Every egg is filed the way YOLKO's own catalogue is (catalogue.mjs): dozens or trays, then the
 * kind (cage, free range, cage free; barn laid IS cage free), then the weight class. From the big
 * shops we keep the cheapest egg in each of those groups, so Admin can set like against like.
 */

const LATEST_KEY = "pricewatch:v2:latest";
const EVENTS_KEY = "pricewatch:v2:events";
const TYPED_KEY = "pricewatch:v2:typed";
const EVENTS_MAX = 200;
const EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
// A tap on Check now within a minute of the last check shows that check instead of asking again.
const MIN_GAP_MS = 60 * 1000;
const UA = "Mozilla/5.0 (compatible; YolkoPriceCheck/2.0; +https://getyolko.com)";

const HOUSINGS = ["caged", "barn", "free_range"];
// The rules for which eggs are kept. A new version doesn't fill Recent changes with "new on the list".
const PICK_V = 3;
const KIND_OF = { caged: "cage", barn: "cf", free_range: "fr" };

const COLES_URL = "https://www.coles.com.au/browse/dairy-eggs-fridge/eggs";
const ALDI_URL = "https://www.aldi.com.au/products/dairy-eggs-fridge/eggs/k/1111111162";

// Single products at the smaller shops: caged 30-packs, the same thing a YOLKO tray is.
const PRODUCTS = [
  { shop: "IGA", kind: "jsonld", housing: "caged", url: "https://www.igashop.com.au/product/canabolas-eggs-30-pack-20000005474" },
  { shop: "Umall", kind: "shopify", housing: "caged", url: "https://www.umall.com.au/products/pace-farm-caged-eggs-large-30-pack-1-5kg" },
  { shop: "Gourmet Grocer", kind: "jsonld", housing: "caged", url: "https://gourmetgroceronline.com.au/product/pace-farm-caged-eggs-large-30-pack-1-5kg/" },
];

// What Kanna saw on DoorDash on 3 Nov 2026, so the page starts with Costco filled in.
const TYPED_SEED = [
  {
    id: "typed:costco",
    shop: "Costco",
    title: "Pace Farm caged eggs 30 pack, on DoorDash",
    housing: "caged",
    pack_eggs: 30,
    pack_weight_g: null,
    price_aud: 14.79,
    member_price_aud: 12.99,
    url: "https://www.costco.com.au/content/sameday",
    checked_at: "2026-11-03T07:00:00.000Z",
  },
];

/* ------------------------------ parsing helpers ------------------------------ */

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const NOT_SHELL_RE = /\b(boiled|peeled|whites?|mix|pour|liquid|powder|chocolate|kinder|pasta|fettuccine|pappardelle|papardelle|noodles?|salad|rice|custard|figures|hollow|mayo)\b/i;

function housingOf(t) {
  if (/organic/i.test(t)) return "organic";
  if (/pasture/i.test(t)) return "pasture";
  if (/free[\s-]?range/i.test(t)) return "free_range";
  if (/cage[\s-]?free|\bbarn\b/i.test(t)) return "barn";
  if (/\bcaged?\b|cage[\s-]?(raised|eggs)/i.test(t)) return "caged";
  return null;
}

function gramsOf(t) {
  const m = String(t || "").match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Math.round(m[2].toLowerCase() === "kg" ? v * 1000 : v);
}

function eggsOf(t, grams) {
  const m = String(t || "").match(/\b(\d{1,2})\s*-?\s*(?:pack|pk|pieces?|eggs?|ct)\b/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 4 && n <= 60) return n;
  }
  if (/dozen/i.test(t)) return 12;
  if (!grams) return null;
  if (grams >= 1400 && grams <= 2000) return 30;
  if (grams >= 550 && grams <= 850) return 12;
  if (grams >= 280 && grams <= 420) return 6;
  return null;
}

/** "Pace Farm Caged Eggs Large 30 Pack - 1.5kg (Limited 1 PP) - Gourmet Grocer" -> title + limit. */
function cleanTitle(raw, shop) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  let limit = "";
  const lm = t.match(/[[(]\s*limit(?:ed)?\s*(\d+)\s*(?:pp|per person)?\s*[\])]/i);
  if (lm) {
    limit = lm[1] + " per person";
    t = t.replace(lm[0], " ");
  }
  if (shop) t = t.replace(new RegExp("\\s*[-|]\\s*" + shop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i"), "");
  t = t.replace(/\s+-\s+/g, " ").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim();
  return { title: t.slice(0, 160), limit };
}

/** One shell-egg row, or null when it is not a pack of eggs we can compare. */
function eggRow(o) {
  const text = o.title || "";
  if (NOT_SHELL_RE.test(text)) return null;
  const housing = o.housing || housingOf(text);
  if (!housing) return null;
  const grams = o.pack_weight_g || gramsOf(text);
  const eggs = o.pack_eggs || eggsOf(text, grams);
  const price = num(o.price_aud);
  if (!eggs || !price) return null;
  return {
    id: o.id,
    shop: o.shop,
    title: text.slice(0, 160),
    housing,
    pack_eggs: eggs,
    pack_weight_g: grams || null,
    price_aud: price,
    was_aud: num(o.was_aud) && num(o.was_aud) > price ? num(o.was_aud) : null,
    per_egg_aud: Math.round((price / eggs) * 10000) / 10000,
    limit: o.limit || "",
    stock: o.stock || "in_stock",
    url: String(o.url || "").slice(0, 400),
    source: "auto",
  };
}

/**
 * Where an egg sits next to YOLKO's own: dozen (12) or tray (30, or an 18 pack), its kind, and
 * the nearest weight class. variety matches a catalogue id (cage1750, cf600, cage1000x18) when
 * the weight is close enough, otherwise "cage-tray" and so on: same kind and size, other weight.
 */
function groupOf(o) {
  const kind = KIND_OF[o?.housing] || null;
  const eggs = Number(o?.pack_eggs);
  const format = eggs === 12 ? "dozen" : eggs === 30 || eggs === 18 ? "tray" : null;
  if (!kind || !format) return { format: null, kind, wclass: null, variety: null };
  const classes = format === "dozen" ? [500, 600, 700, 800] : eggs === 18 ? [1000] : [1000, 1500, 1750];
  const g = Number(o.pack_weight_g) || 0;
  let wclass = null;
  if (g) {
    const best = classes.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
    if (Math.abs(best - g) <= (format === "dozen" ? 100 : 150)) wclass = best;
  }
  const x18 = eggs === 18 ? "x18" : "";
  return { format, kind, wclass, variety: wclass ? `${kind}${wclass}${x18}` : `${kind}-${format}${x18}` };
}

const withGroup = (o) => ({ ...o, ...groupOf(o) });

/** The cheapest egg a big shop has in each group (in stock first). Other pack sizes are left out. */
function pickForShop(rows) {
  const best = new Map();
  for (const r of rows) {
    if (!r || !HOUSINGS.includes(r.housing)) continue;
    const { variety } = groupOf(r);
    if (!variety) continue;
    const cur = best.get(variety);
    const out = (x) => (x.stock === "out_of_stock" ? 1 : 0);
    if (!cur || out(r) < out(cur) || (out(r) === out(cur) && r.price_aud < cur.price_aud)) best.set(variety, r);
  }
  return [...best.values()];
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9" },
    redirect: "follow",
    cf: { cacheTtl: 0 },
  });
  if (res.status === 403) throw new Error("blocked us (403)");
  if (res.status === 429) throw new Error("asked us to slow down (429)");
  if (!res.ok) throw new Error("answered " + res.status);
  return res.text();
}

function nextData(html) {
  const tag = '<script id="__NEXT_DATA__" type="application/json">';
  const s = html.indexOf(tag);
  if (s < 0) return null;
  const e = html.indexOf("</script>", s);
  try {
    return JSON.parse(html.slice(s + tag.length, e));
  } catch {
    return null;
  }
}

function jsonLdProduct(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let d;
    try {
      d = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(d) ? d : Array.isArray(d?.["@graph"]) ? d["@graph"] : [d];
    for (const it of items) {
      const type = it && it["@type"];
      if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return it;
    }
  }
  return null;
}

function offerOf(product) {
  const offers = product?.offers;
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o) return { price: null, stock: "unknown" };
  const spec = Array.isArray(o.priceSpecification) ? o.priceSpecification[0] : o.priceSpecification;
  const price = num(o.price ?? o.lowPrice ?? spec?.price);
  const av = String(o.availability || "");
  const stock = /InStock|LimitedAvailability/i.test(av) ? "in_stock" : /OutOfStock|SoldOut|Discontinued/i.test(av) ? "out_of_stock" : "unknown";
  return { price, stock };
}

/* ------------------------------ the shops ------------------------------ */

async function readColes() {
  const html = await getText(COLES_URL);
  const results = nextData(html)?.props?.pageProps?.searchResults?.results;
  if (!Array.isArray(results)) throw new Error("page had no products (blocked or changed)");
  const rows = [];
  for (const r of results) {
    if (!r || r._type !== "PRODUCT" || !r.id) continue;
    const title = [r.brand, r.name, r.size].filter(Boolean).join(" ");
    rows.push(
      eggRow({
        id: "coles:" + r.id,
        shop: "Coles",
        title,
        price_aud: r.pricing?.now,
        was_aud: r.pricing?.was,
        stock: r.availability === false ? "out_of_stock" : "in_stock",
        url: `https://www.coles.com.au/product/${slug(title)}-${r.id}`,
      })
    );
  }
  const picked = pickForShop(rows.filter(Boolean));
  if (!picked.length) throw new Error("page had no eggs we could read");
  return picked;
}

async function readAldi() {
  const html = await getText(ALDI_URL);
  const rows = [];
  const marker = 'data-test="product-tile"';
  let i = html.indexOf(marker);
  while (i >= 0) {
    const next = html.indexOf(marker, i + marker.length);
    const tile = html.slice(i, next < 0 ? i + 6000 : next);
    i = next;
    const href = tile.match(/href="(\/product\/[^"]+)"/);
    const brand = tile.match(/product-tile__brandname"[^>]*>\s*<p[^>]*>([^<]*)</);
    const name = tile.match(/product-tile__name"[^>]*>\s*<p[^>]*>([^<]*)</);
    const priceAt = tile.indexOf('data-test="product-tile__price"');
    const price = priceAt >= 0 ? tile.slice(priceAt).match(/\$\s*(\d+(?:\.\d{1,2})?)/) : null;
    if (!href || !name) continue;
    const id = (href[1].match(/-(\d{6,})$/) || [])[1] || slug(href[1]);
    const brandName = (brand ? brand[1] : "").replace(/&amp;/g, "&").trim();
    const title = [brandName.replace(/\b\w+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase()), name[1].replace(/&amp;/g, "&").trim()].filter(Boolean).join(" ");
    rows.push(
      eggRow({
        id: "aldi:" + id,
        shop: "Aldi",
        title,
        price_aud: price ? price[1] : null,
        stock: /sold[\s-]?out|unavailable/i.test(tile) ? "out_of_stock" : "in_stock",
        url: "https://www.aldi.com.au" + href[1],
      })
    );
  }
  const picked = pickForShop(rows.filter(Boolean));
  if (!picked.length) throw new Error("page had no eggs we could read");
  return picked;
}

async function readProduct(p) {
  if (p.kind === "shopify") {
    const text = await getText(p.url + ".js");
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      throw new Error("sent something that was not product data");
    }
    const v = (d.variants || [])[0] || {};
    const { title, limit } = cleanTitle(d.title, p.shop);
    const row = eggRow({
      id: slug(p.shop) + ":" + slug(d.handle || p.url.split("/").pop()),
      shop: p.shop,
      title,
      housing: p.housing,
      price_aud: Number(v.price ?? d.price) / 100,
      was_aud: v.compare_at_price ? Number(v.compare_at_price) / 100 : null,
      stock: (v.available ?? d.available) === false ? "out_of_stock" : "in_stock",
      limit,
      url: p.url,
    });
    if (!row) throw new Error("product had no price");
    return [row];
  }
  const html = await getText(p.url);
  const product = jsonLdProduct(html);
  if (!product) throw new Error("product is no longer listed");
  const { price, stock } = offerOf(product);
  const { title, limit } = cleanTitle(product.name, p.shop);
  const row = eggRow({
    id: slug(p.shop) + ":" + slug(p.url.replace(/\/$/, "").split("/").pop()),
    shop: p.shop,
    title,
    housing: p.housing,
    price_aud: price,
    stock,
    limit,
    url: p.url,
  });
  if (!row) throw new Error("product had no price");
  return [row];
}

/** Every source in parallel. A shop that fails keeps its last prices, marked stale. */
async function checkAll(prevOffers) {
  const checkedAt = new Date().toISOString();
  const jobs = [
    { key: "coles", shop: "Coles", run: readColes },
    { key: "aldi", shop: "Aldi", run: readAldi },
    ...PRODUCTS.map((p) => ({ key: slug(p.shop), shop: p.shop, url: p.url, run: () => readProduct(p) })),
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const offers = [];
  const sources = {};
  settled.forEach((res, n) => {
    const job = jobs[n];
    const src = sources[job.key] || (sources[job.key] = { shop: job.shop, ok: true, count: 0, error: "", checked_at: checkedAt });
    if (res.status === "fulfilled") {
      for (const o of res.value) offers.push({ ...o, checked_at: checkedAt });
      src.count += res.value.length;
      return;
    }
    src.ok = false;
    src.error = String(res.reason?.message || res.reason || "failed").slice(0, 160);
    const keepOld = (prevOffers || []).filter((o) => o.shop === job.shop && (!job.url || o.url === job.url));
    for (const o of keepOld) offers.push({ ...o, stale: true });
  });
  return { offers, sources, checkedAt };
}

/* ------------------------------ history ------------------------------ */

function diffOffers(prevList, nextList) {
  const prev = new Map((prevList || []).map((o) => [o.id, o]));
  const next = new Map((nextList || []).map((o) => [o.id, o]));
  const at = new Date().toISOString();
  const changes = [];
  const brief = (o) => ({ price_aud: o.price_aud, stock: o.stock });
  for (const [id, n] of next) {
    if (n.stale) continue;
    const p = prev.get(id);
    if (!p) {
      if (prev.size) changes.push({ type: "added", at, id, shop: n.shop, title: n.title, from: null, to: brief(n) });
      continue;
    }
    const priceChanged = num(p.price_aud) !== num(n.price_aud);
    const stockChanged = (p.stock === "out_of_stock") !== (n.stock === "out_of_stock");
    if (!priceChanged && !stockChanged) continue;
    changes.push({
      type: priceChanged ? "price" : "stock",
      at,
      id,
      shop: n.shop,
      title: n.title,
      from: brief(p),
      to: brief(n),
      delta_aud: priceChanged && p.price_aud && n.price_aud ? Math.round((n.price_aud - p.price_aud) * 100) / 100 : null,
    });
  }
  for (const [id, p] of prev) {
    if (!next.has(id)) changes.push({ type: "removed", at, id, shop: p.shop, title: p.title, from: brief(p), to: null });
  }
  return changes;
}

async function getEvents(env) {
  const raw = await env.DATA.get(EVENTS_KEY, "json");
  return Array.isArray(raw) ? raw : [];
}

async function pushEvents(env, changes) {
  if (!changes.length) return;
  const prev = await getEvents(env);
  await env.DATA.put(EVENTS_KEY, JSON.stringify([...changes, ...prev].slice(0, EVENTS_MAX)));
}

async function notifyWebhook(env, changes) {
  const hook = String(env.PRICE_WATCH_WEBHOOK || "").trim();
  if (!hook || !changes.length) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "yolko-price-watch" },
      body: JSON.stringify({ type: "yolko.price_watch.changed", changes }),
    });
  } catch {}
}

/* ------------------------------ typed in by the owner ------------------------------ */

async function getTyped(env) {
  const raw = await env.DATA.get(TYPED_KEY, "json");
  if (raw === null) {
    await env.DATA.put(TYPED_KEY, JSON.stringify(TYPED_SEED));
    return TYPED_SEED.map((o) => ({ ...o }));
  }
  return Array.isArray(raw) ? raw : [];
}

function typedView(o) {
  const per = o.price_aud && o.pack_eggs ? Math.round((o.price_aud / o.pack_eggs) * 10000) / 10000 : null;
  return withGroup({ ...o, per_egg_aud: per, stock: "in_stock", source: "typed" });
}

/** Add or change a typed-in price (Costco, Woolworths, anything the Worker can't read). */
async function saveTyped(env, body) {
  const list = await getTyped(env);
  if (body?.remove) {
    const id = String(body.id || "");
    const gone = list.find((o) => o.id === id);
    if (!gone) return { error: "That price is already gone" };
    await env.DATA.put(TYPED_KEY, JSON.stringify(list.filter((o) => o.id !== id)));
    return { ok: true, removed: gone };
  }
  const shop = String(body?.shop || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const title = String(body?.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const eggs = Math.round(Number(body?.pack_eggs));
  const price = num(body?.price_aud);
  const member = body?.member_price_aud == null || body.member_price_aud === "" ? null : num(body.member_price_aud);
  const housing = HOUSINGS.includes(body?.housing) ? body.housing : "caged";
  let url = String(body?.url || "").trim().slice(0, 400);
  if (!shop) return { error: "Enter the shop" };
  if (!Number.isFinite(eggs) || eggs < 1 || eggs > 60) return { error: "Enter how many eggs are in the pack" };
  if (!price || price > 500) return { error: "Enter the price" };
  if (body?.member_price_aud != null && body.member_price_aud !== "" && (!member || member > 500)) return { error: "Check the member price" };
  if (url && !/^https:\/\//i.test(url)) url = "";
  const id = String(body?.id || "").startsWith("typed:") ? String(body.id) : "typed:" + slug(shop) + "-" + Date.now().toString(36);
  const prev = list.find((o) => o.id === id);
  const row = {
    id,
    shop,
    title: title || (housing === "caged" ? "Caged" : housing === "barn" ? "Barn laid" : "Free range") + " eggs " + eggs + " pack",
    housing,
    pack_eggs: eggs,
    // The size picker always sends a weight, or null for "weight not shown".
    pack_weight_g: body?.pack_weight_g === undefined
      ? (prev?.pack_weight_g ?? null)
      : Number(body.pack_weight_g) > 0 ? Math.min(5000, Math.round(Number(body.pack_weight_g))) : null,
    price_aud: price,
    member_price_aud: member,
    url,
    // Undo puts a removed price back with the date it was typed, not today's.
    checked_at: body?.restore && Date.parse(body?.checked_at) ? new Date(Date.parse(body.checked_at)).toISOString() : new Date().toISOString(),
  };
  const next = prev ? list.map((o) => (o.id === id ? row : o)) : [...list, row].slice(-20);
  await env.DATA.put(TYPED_KEY, JSON.stringify(next));
  if (prev && num(prev.price_aud) !== price) {
    await pushEvents(env, [{
      type: "price",
      at: row.checked_at,
      id,
      shop,
      title: row.title,
      typed: true,
      from: { price_aud: prev.price_aud, stock: "in_stock" },
      to: { price_aud: price, stock: "in_stock" },
      delta_aud: Math.round((price - prev.price_aud) * 100) / 100,
    }]);
  }
  return { ok: true, row: typedView(row) };
}

/* ------------------------------ public API ------------------------------ */

async function getLatest(env) {
  return (await env.DATA.get(LATEST_KEY, "json")) || null;
}

/** Everything the Competitors page shows, in one answer. */
async function priceWatchView(env, limit = 30) {
  const [latest, typed, events] = await Promise.all([getLatest(env), getTyped(env), getEvents(env)]);
  return {
    ok: true,
    updatedAt: latest?.updatedAt || null,
    nextAt: latest?.updatedAt ? new Date(Date.parse(latest.updatedAt) + EVERY_MS).toISOString() : null,
    sources: latest?.sources || {},
    offers: (latest?.offers || []).map(withGroup),
    typed: typed.map(typedView),
    events: events.slice(0, limit),
  };
}

/** Check every shop now (Check now button), unless it was checked in the last minute. */
async function runPoll(env, { force = false } = {}) {
  const prev = await getLatest(env);
  const age = prev?.updatedAt ? Date.now() - Date.parse(prev.updatedAt) : Infinity;
  if (!force && age < MIN_GAP_MS) return { ran: false };
  const { offers, sources, checkedAt } = await checkAll(prev?.offers || []);
  // After the rules change, eggs that only joined or left because of the new rules aren't news.
  const sameRules = prev?.v === PICK_V;
  const changes = diffOffers(prev?.offers || [], offers).filter((c) => sameRules || c.type === "price" || c.type === "stock");
  await env.DATA.put(LATEST_KEY, JSON.stringify({ v: PICK_V, updatedAt: checkedAt, sources, offers }));
  await pushEvents(env, changes);
  await notifyWebhook(env, changes);
  return { ran: true, changeCount: changes.length };
}

/** Cron: every 15 minutes the Worker asks; the shops are only checked once every 6 hours, or
 *  after 30 minutes when a shop didn't answer last time (Umall's Shopify sometimes says 429). */
async function runScheduledPoll(env) {
  const prev = await getLatest(env);
  const age = prev?.updatedAt ? Date.now() - Date.parse(prev.updatedAt) : Infinity;
  const failed = Object.values(prev?.sources || {}).some((s) => s && !s.ok);
  if (age < (failed ? RETRY_MS : EVERY_MS - 5 * 60 * 1000)) return { ran: false };
  return runPoll(env, { force: true });
}

export {
  priceWatchView,
  runPoll,
  runScheduledPoll,
  saveTyped,
  // for tests
  checkAll,
  diffOffers,
  eggRow,
  groupOf,
  pickForShop,
  cleanTitle,
  eggsOf,
  gramsOf,
  housingOf,
};
