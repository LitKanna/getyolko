/**
 * Every egg YOLKO can sell, as Kanna set it out on 3 Nov 2026: dozens and trays, then the kind
 * (cage, free range, cage free), then the weight. Barn laid is cage free, never its own kind.
 *
 * Each variety has its own stock and its own prices, saved in Admin > Stock & prices. A variety
 * shows on the shop only when it has a price and stock. The main tray (cage 1.75kg, 30 eggs)
 * keeps its old keys tray1 / tray2 / box and its old stock field traysAvailable, so orders,
 * reminders and links from before this change still work.
 */

export const MAIN = "cage1750";
export const DOZENS_PER_CASE = 15;
export const TRAYS_PER_BOX = 6;
export const KINDS = { cage: "Cage", fr: "Free range", cf: "Cage free" };
export const KIND_ORDER = ["cage", "fr", "cf"];

const tray = (kind, grams, eggs = 30) => ({ id: kind + grams + (eggs === 30 ? "" : "x" + eggs), format: "tray", kind, grams, eggs });
const dozen = (kind, grams) => ({ id: kind + grams, format: "dozen", kind, grams, eggs: 12 });

export const VARIETIES = [
  tray("cage", 1750), tray("cage", 1500), tray("cage", 1000), tray("cage", 1000, 18),
  tray("fr", 1750), tray("fr", 1500),
  tray("cf", 1750), tray("cf", 1500),
  dozen("cage", 500), dozen("cage", 600), dozen("cage", 700), dozen("cage", 800),
  dozen("fr", 500), dozen("fr", 600), dozen("fr", 700), dozen("fr", 800),
  dozen("cf", 600), dozen("cf", 700), dozen("cf", 800),
].map((v) => ({ ...v, main: v.id === MAIN }));

export const VARIETY = Object.fromEntries(VARIETIES.map((v) => [v.id, v]));

export function weightText(g) {
  return g >= 1000 ? `${String(g / 1000).replace(/\.?0+$/, "")}kg` : `${g}g`;
}

/** "Cage 1.5kg", "Cage 1kg 18 pack", "Free range 600g". The section (Trays or Dozens) says the rest. */
export function varietyName(v) {
  const base = `${KINDS[v.kind]} ${weightText(v.grams)}`;
  return v.format === "tray" && v.eggs !== 30 ? `${base} ${v.eggs} pack` : base;
}

/** What one unit of stock is called: tray, 18 pack, dozen. */
export function unitNoun(v, n = 1) {
  const one = v.format === "dozen" ? "dozen" : v.eggs === 30 ? "tray" : `${v.eggs} pack`;
  return n === 1 ? one : v.format === "dozen" ? "dozens" : `${one}s`;
}

function trayLabel(v, packs) {
  const kind = KINDS[v.kind];
  const w = weightText(v.grams);
  const noun = v.eggs === 30 ? "egg tray" : `${v.eggs} pack`;
  const eggs = v.eggs * packs;
  if (packs === 1) return `${kind} ${noun} ${w} (${eggs} eggs)`;
  if (packs === TRAYS_PER_BOX) return `Box of 6 ${kind.toLowerCase()} ${noun}s ${w} (${eggs} eggs)`;
  return `${packs} ${kind.toLowerCase()} ${noun}s ${w} (${eggs} eggs)`;
}

const MAIN_LABELS = { tray1: "Egg tray (30 eggs)", tray2: "2 egg trays (60 eggs)", box: "Full box (180 eggs)" };

/** key -> { key, variety, packs, eggs, option, label }. option: one | two | box | dozen | case. */
export const BUNDLES = {};
for (const v of VARIETIES) {
  if (v.format === "tray") {
    const keys = v.main ? ["tray1", "tray2", "box"] : [`${v.id}-1`, `${v.id}-2`, `${v.id}-box`];
    [["one", 1], ["two", 2], ["box", TRAYS_PER_BOX]].forEach(([option, packs], i) => {
      const key = keys[i];
      BUNDLES[key] = { key, variety: v.id, packs, eggs: v.eggs * packs, option, label: v.main ? MAIN_LABELS[key] : trayLabel(v, packs) };
    });
  } else {
    const kind = KINDS[v.kind];
    const w = weightText(v.grams);
    BUNDLES[v.id] = { key: v.id, variety: v.id, packs: 1, eggs: 12, option: "dozen", label: `${kind} dozen ${w} (12 eggs)` };
    BUNDLES[`${v.id}case`] = { key: `${v.id}case`, variety: v.id, packs: DOZENS_PER_CASE, eggs: 12 * DOZENS_PER_CASE, option: "case", label: `${kind} case ${w} (15 dozens)` };
  }
}
export const BUNDLE_KEYS = Object.keys(BUNDLES);
export const isBundle = (key) => Object.prototype.hasOwnProperty.call(BUNDLES, String(key || ""));
export const bundleLabel = (key) => BUNDLES[key]?.label || "Eggs";
export const bundlesOf = (vid) => BUNDLE_KEYS.filter((k) => BUNDLES[k].variety === vid);

/* ----------------------------------- stock ----------------------------------- */

export function stockOf(settings, vid) {
  if (vid === MAIN) return Math.max(0, Math.floor(Number(settings.traysAvailable) || 0));
  return Math.max(0, Math.floor(Number(settings.stock?.[vid]) || 0));
}

/** Move one variety's stock by delta (never below 0). Returns what is left. */
export function addStock(settings, vid, delta) {
  const next = Math.max(0, stockOf(settings, vid) + delta);
  if (vid === MAIN) settings.traysAvailable = next;
  else settings.stock = { ...(settings.stock || {}), [vid]: next };
  return next;
}

/** What an order takes from stock: { variety, units }, units in trays or dozens. */
export function holdFor(order) {
  const b = BUNDLES[order?.bundle];
  if (!b) return { variety: null, units: 0 };
  return { variety: b.variety, units: b.packs * Math.max(1, Math.floor(Number(order.quantity)) || 1) };
}

/** What an order holds now, including holds saved before varieties ({ trays, dozens }). */
export function heldBy(order) {
  const h = order?.stockHeld;
  if (!h) return holdFor(order);
  if (h.variety) return { variety: h.variety, units: Number(h.units) || 0 };
  if (Number(h.trays) > 0) return { variety: MAIN, units: Number(h.trays) };
  const now = holdFor(order);
  if (Number(h.dozens) > 0 && VARIETY[now.variety]?.format === "dozen") return { variety: now.variety, units: Number(h.dozens) };
  return { variety: null, units: 0 };
}

export const traysIn = (order) => {
  const h = holdFor(order);
  return VARIETY[h.variety]?.format === "tray" ? h.units : 0;
};
export const dozensIn = (order) => {
  const h = holdFor(order);
  return VARIETY[h.variety]?.format === "dozen" ? h.units : 0;
};

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Why this can't be sold right now, or null. The main tray keeps its old rule: it can always be
 * ordered and the shop says when it's sold out. Every other variety needs a price and the stock.
 */
export function stockProblem(settings, key, quantity) {
  const b = BUNDLES[key];
  if (!b) return { code: "bundle", error: "invalid order" };
  const v = VARIETY[b.variety];
  if (!(Number(settings.prices?.[key]) > 0)) {
    return { code: "not_sold", error: `${varietyName(v)} ${v.format === "dozen" ? "dozens" : unitNoun(v, 2)} aren't on sale this week.` };
  }
  if (v.main) return null;
  const left = stockOf(settings, v.id);
  const need = b.packs * Math.max(1, Math.floor(Number(quantity)) || 1);
  if (left <= 0) return { code: "sold_out", error: `${varietyName(v)} ${unitNoun(v, 2)} are sold out this week.` };
  if (need > left) {
    return { code: "stock", error: `Only ${plural(left, unitNoun(v, 1), unitNoun(v, 2))} of ${varietyName(v)} left this week. Pick fewer.` };
  }
  return null;
}

/* ------------------------------- views for pages ------------------------------- */

/** Everything Admin needs to draw Stock & prices and to name any order. */
export function catalogueView() {
  return {
    main: MAIN,
    kinds: KINDS,
    kindOrder: KIND_ORDER,
    varieties: VARIETIES.map((v) => ({ ...v, name: varietyName(v), weight: weightText(v.grams), unit: unitNoun(v, 1), units: unitNoun(v, 2), bundles: bundlesOf(v.id) })),
    bundles: BUNDLES,
  };
}

/**
 * What the shop can sell this week, in shop order. The main tray is always listed; anything
 * else only with stock, and only the options that have a price and fit in that stock.
 */
export function shopView(settings) {
  const out = [];
  for (const v of VARIETIES) {
    const left = stockOf(settings, v.id);
    if (!v.main && left <= 0) continue;
    const options = bundlesOf(v.id)
      .map((k) => BUNDLES[k])
      .filter((b) => Number(settings.prices?.[b.key]) > 0 && (v.main || b.packs <= left))
      .map((b) => ({ key: b.key, option: b.option, packs: b.packs, eggs: b.eggs, price: Number(settings.prices[b.key]), label: b.label }));
    if (!options.length) continue;
    out.push({ id: v.id, format: v.format, kind: v.kind, grams: v.grams, eggs: v.eggs, main: v.main, name: varietyName(v), weight: weightText(v.grams), left, options });
  }
  return out;
}
