// Admin > Growers: Australian egg farms, as a list YOLKO can search, filter and download.
//
// growers-data.json is the list built on 3 Nov 2026. NSW was checked farm by farm (the farm's
// own site, Google Maps, the ACO organic register and Farm Transparency). Other states come from
// Farm Transparency only, so they are leads until someone checks them. Business and location
// details only: name, towns, egg type, website, a phone the farm publishes, certification and
// whether it's trading. No flock sizes, output or prices.
//
// Farm Transparency (farmtransparency.org) has no API, but each state's egg farm list is a plain
// page with no robots.txt rules and terms that don't limit reuse. The Worker re-reads each state
// once a month (two states per cron tick when they're due), keeps only the name, type, town and
// open or closed status, and the admin shows any change: a farm that closed, or a new one.
import DATA from "./growers-data.json" with { type: "json" };

const KEY = "growers:ft:v1";
const FT = "https://www.farmtransparency.org";
export const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
const EVERY_MS = 30 * 864e5;
const RETRY_MS = 864e5;
const PER_TICK = 2;
const CHECK_GAP_MS = 10 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; YolkoGrowers/1.0; +https://getyolko.com)";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };
function decode(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The rows of one Farm Transparency egg farm list page. */
export function parseFtList(html) {
  const out = [];
  const row = /<tr class="[^"]*">\s*<td>\s*<a href="\/facilities\/([^"]+)" class="facility-name">([\s\S]*?)<\/a>\s*<\/td>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = row.exec(html))) {
    const tds = [...m[3].matchAll(/<td class="mobile-hide"[^>]*>([\s\S]*?)<\/td>/g)].map((t) => decode(t[1]));
    if (tds.length < 6) continue;
    out.push({ slug: m[1], name: decode(m[2]), type: tds[0], species: tds[1], town: tds[2], state: tds[3], status: tds[5] });
  }
  return out;
}

/** How many results the page says it has, and how many pages, so a layout change shows up as an error. */
export function ftCounts(html) {
  const r = /\((\d+) results?\)/.exec(html);
  const p = /Page \d+ of (\d+)/.exec(html);
  const none = /No facilities found/i.test(html);
  return { results: r ? Number(r[1]) : none ? 0 : null, pages: p ? Number(p[1]) : 1 };
}

// Which Farm Transparency rows count as an egg grower: named, open, egg farms, not a hatchery,
// breeder or pullet farm, and named as a business (not just a person).
const SKIP = /hatchery|breeder|pullet|rearing|grow-out|former|unknown|potentially closed|parent farms|college of agriculture|^egg farm$|^caged eggs$|^cage eggs$|^free range eggs?$|^free range egg farm$|^free-range egg farm|^egg farm - /i;
const BIZ = /farm|flock|egg|poultry|range|pty|p\/l|\bco\b|trading|holdings|station|organic|produce|hen|chook|yolk|pride|downs|park|valley|foods|country/i;
export function isGrowerRow(f) {
  return f.status === "Open" && /eggs/i.test(f.type) && !/unconfirmed|hatchery/i.test(f.type) && !SKIP.test(f.name) && BIZ.test(f.name);
}
function eggsFrom(name) {
  const k = [];
  if (/free.range/i.test(name)) k.push("Free range");
  if (/pastur/i.test(name)) k.push("Pastured");
  if (/barn/i.test(name)) k.push("Barn laid");
  if (/cage|battery/i.test(name)) k.push("Caged");
  if (/organic/i.test(name)) k.push("Organic");
  return k.join(", ");
}
function slugOf(url) { return String(url || "").split("/facilities/")[1] || ""; }
function idOf(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48); }

async function readState(state, fetcher) {
  const base = `${FT}/facilities/egg-farms?country=Australia&state=${state}`;
  const get = async (url) => {
    const res = await fetcher(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.5", "Accept-Language": "en-AU,en;q=0.9" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  };
  const first = await get(base);
  const counts = ftCounts(first);
  const rows = parseFtList(first);
  for (let p = 2; p <= Math.min(counts.pages, 6); p++) rows.push(...parseFtList(await get(base + "&page=" + p)));
  const seen = new Set();
  const unique = rows.filter((r) => !seen.has(r.slug) && seen.add(r.slug));
  if (counts.results == null && !unique.length) throw new Error("The page layout changed");
  if (counts.results != null && unique.length < counts.results) throw new Error(`Read ${unique.length} of ${counts.results} farms`);
  return unique.map((r) => ({ slug: r.slug, name: r.name, type: r.type, town: r.town, state: r.state || state, status: r.status }));
}

async function loadState(env) {
  return (await env.DATA.get(KEY, "json")) || { states: {} };
}

function isDue(s, now) {
  if (!s || !s.at) return true;
  return now - Date.parse(s.at) > (s.ok ? EVERY_MS : RETRY_MS);
}

/**
 * Re-read the Farm Transparency state lists that are due (a month since the last good read, or a
 * day after a failed one), two per call. force reads all eight at once, at most every 10 minutes.
 */
export async function runGrowersCheck(env, { force = false, now = Date.now(), fetcher = fetch } = {}) {
  const store = await loadState(env);
  if (force && store.forcedAt && now - Date.parse(store.forcedAt) < CHECK_GAP_MS) return { ran: false, read: 0, failed: 0 };
  const due = force ? STATES.slice() : STATES.filter((s) => isDue(store.states[s], now)).slice(0, PER_TICK);
  if (!due.length) return { ran: false, read: 0, failed: 0 };
  const nowIso = new Date(now).toISOString();
  const results = await Promise.all(due.map((s) => readState(s, fetcher).then((rows) => ({ s, rows }), (err) => ({ s, error: String(err?.message || err).slice(0, 120) }))));
  let failed = 0;
  for (const r of results) {
    const prev = store.states[r.s] || {};
    if (r.error) {
      failed++;
      store.states[r.s] = { ...prev, at: nowIso, ok: false, error: r.error };
    } else {
      store.states[r.s] = { at: nowIso, ok: true, okAt: nowIso, error: null, rows: r.rows };
    }
  }
  if (force) store.forcedAt = nowIso;
  await env.DATA.put(KEY, JSON.stringify(store));
  return { ran: true, read: due.length, failed };
}

export async function runScheduledGrowers(env) {
  return runGrowersCheck(env);
}

/**
 * The list for Admin > Growers: the saved list with each Farm Transparency link's latest status,
 * plus farms Farm Transparency has added since (as leads), and how each state read last time.
 */
export async function growersView(env) {
  const store = await loadState(env);
  const live = new Map();
  const readAt = {};
  for (const s of STATES) {
    const st = store.states[s];
    if (!st || !st.okAt || !Array.isArray(st.rows)) continue;
    readAt[s] = st.okAt.slice(0, 10);
    for (const r of st.rows) live.set(r.slug, r);
  }
  const used = new Set();
  const growers = DATA.growers.map((g) => {
    let ftOnly = true, latest = "";
    const sources = g.sources.map((src) => {
      if (src.kind !== "ft") { ftOnly = false; return src; }
      const slug = slugOf(src.url);
      used.add(slug);
      const stRead = readAt[g.state];
      if (!stRead) return src;
      if (stRead > latest) latest = stRead;
      const now = live.get(slug);
      return now ? { ...src, status: now.status, checked: stRead } : { ...src, status: "Removed", checked: stRead };
    });
    const ft = sources.filter((s) => s.kind === "ft");
    const out = { ...g, sources };
    if (ft.length && ft.every((s) => s.status !== "Open") && !g.flag) out.flag = ft.some((s) => s.status === "Removed") ? "No longer on Farm Transparency" : "Farm Transparency says closed";
    if (ftOnly && latest && latest > g.checked) out.checked = latest;
    return out;
  });
  // Farms Farm Transparency added after the list was built, one row per business and state.
  const known = new Set(DATA.ftKnown);
  const fresh = new Map();
  for (const [slug, f] of live) {
    if (known.has(slug) || used.has(slug) || !isGrowerRow(f)) continue;
    const key = f.name.toLowerCase() + "|" + f.state;
    const g = fresh.get(key) || { id: idOf(f.name + "-" + f.state + "-new"), name: f.name, state: f.state, region: null, towns: [], eggs: eggsFrom(f.name), website: null, phone: null, phoneFrom: null, cert: null, note: null, flag: null, confirmed: false, isNew: true, sources: [], checked: readAt[f.state] };
    if (!g.towns.includes(f.town)) g.towns.push(f.town);
    g.sources.push({ kind: "ft", url: FT + "/facilities/" + slug, name: f.name, town: f.town, status: f.status, checked: readAt[f.state] });
    fresh.set(key, g);
  }
  const all = growers.concat([...fresh.values()]);
  return {
    checked: DATA.checked,
    states: STATES.map((s) => {
      const st = store.states[s] || {};
      return { state: s, at: st.at || null, okAt: st.okAt || null, ok: st.ok ?? null, error: st.error || null, count: Array.isArray(st.rows) ? st.rows.length : null };
    }),
    added: fresh.size,
    growers: all,
  };
}
