// What a visitor did on a page, kept on that page view's own row in the visit log (KV visit:*).
// The page sends its running totals (track.js, POST /api/visit/ping) and the row keeps the
// highest value of each, so a repeat, late or out-of-order send can never count twice.
// Nothing typed is read and no name or contact detail is stored.
//
//   row.trk    2 on rows written by track.js (older rows have no engagement at all)
//   row.pageN  which page of the browser session this was: 1 for the landing page
//   row.net    "isp" | "datacentre" | "meta" | "google" | "unknown", from the network's name
//   row.eng    { secs, scroll, scrolled, order, taps: { cta, tray, form, buy, checkout, phone,
//                whatsapp }, n, at }
//
// eng.secs     seconds the page was actually on screen (a hidden tab does not count)
// eng.scroll   deepest point seen, as a percent of the page's height (the first screen counts)
// eng.scrolled true once the visitor moved the page with a finger, wheel or key
// eng.order    true once the homepage order section came into view
// eng.taps     how many times each control was tapped; "form" is how many boxes of the order
//              form were entered or filled, each counted once
// eng.n        how many times the row was written for engagement; eng.at is the time of the last
//
// The page reports every 3 seconds. Writing the row that often would spend the day's KV writes,
// which orders need, so the shop holds the newest totals at the edge (takeVisitPing) and writes
// the row when it matters: the first report, a new kind of tap, a Buy now or checkout tap, a few
// fixed marks, and once the reports have stopped for a few seconds. That last write is what
// makes the time exact when a phone kills the page with no warning.

/** KV writes one page view may cost for engagement. A Buy now or checkout tap may go a little over. */
export const PING_MAX_WRITES = 16;
const PING_VITAL_EXTRA = 4;
/** A page view takes updates for this long after it was opened. */
export const PING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const TAP_KEYS = ["cta", "tray", "form", "buy", "checkout", "phone", "whatsapp"];
const VISIT_ID = /^visit:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z:[a-z0-9]{1,8}$/;

const int = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

/** A ping as the page sent it, cut down to the numbers this file keeps. */
export function cleanPing(body) {
  const b = body && typeof body === "object" ? body : {};
  const from = b.taps && typeof b.taps === "object" ? b.taps : {};
  const taps = {};
  for (const k of TAP_KEYS) {
    const n = int(from[k], 0, 99);
    if (n) taps[k] = n;
  }
  return {
    secs: int(b.secs, 0, 3600),
    scroll: int(b.scroll, 0, 100),
    scrolled: b.scrolled === true,
    order: b.order === true,
    taps,
  };
}

/**
 * The row's engagement after one ping. Every field only ever goes up. Seconds cannot run ahead
 * of the clock: a page opened 10 seconds ago cannot have been on screen for a minute.
 */
export function mergeEngagement(prev, ping, { createdAtMs, nowMs }) {
  const p = prev && typeof prev === "object" ? prev : null;
  const open = Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)) + 5 : 3600;
  const taps = { ...(p?.taps || {}) };
  let changed = !p;
  for (const k of TAP_KEYS) {
    if ((ping.taps[k] || 0) > (taps[k] || 0)) {
      taps[k] = ping.taps[k];
      changed = true;
    }
  }
  const secs = Math.max(p?.secs || 0, Math.min(ping.secs, open));
  const scroll = Math.max(p?.scroll || 0, ping.scroll);
  const scrolled = Boolean(p?.scrolled) || ping.scrolled;
  const order = Boolean(p?.order) || ping.order;
  if (p && (secs > p.secs || scroll > p.scroll || scrolled !== Boolean(p.scrolled) || order !== Boolean(p.order))) changed = true;
  return {
    changed,
    eng: { secs, scroll, scrolled, order, taps, n: (p?.n || 0) + (changed ? 1 : 0), at: new Date(nowMs).toISOString() },
  };
}

const DATACENTRE =
  /amazon|\baws\b|microsoft|azure|digitalocean|linode|akamai|\bovh\b|hetzner|oracle|alibaba|tencent|cloudflare|fastly|vultr|constant company|choopa|contabo|scaleway|leaseweb|\bm247\b|datacamp|cdn77|hostinger|ionos|godaddy|rackspace|colocrossing|psychz|quadranet|bytedance|apple inc|anthropic|openai|hosting|data ?cent(er|re)|dedicated|\bvps\b|\bcloud\b|servers?\b/;

/** The kind of network a visit came over, from its name (Cloudflare's asOrganization). */
export function netKind(asnOrg) {
  const s = String(asnOrg || "").toLowerCase();
  if (!s) return "unknown";
  if (/facebook|meta platforms/.test(s)) return "meta";
  if (/google/.test(s)) return "google";
  if (DATACENTRE.test(s)) return "datacentre";
  return "isp";
}

const NET_WORDS = { meta: "Meta's own network", google: "Google's own network", datacentre: "a data centre network" };

/** Seconds as people say them: 8s, 1m 12s. */
export function sayTime(secs) {
  const s = int(secs, 0, 86400);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Is this page view a person or a robot? "real", "suspect", "new" (opened in the last 90 seconds,
 * nothing back yet) or "" for a row from before track.js.
 *
 * A tap on a control, or a real scroll after a few seconds, is a person on any network: iPhones
 * on iCloud Private Relay arrive through data centres. Without that, a data centre or Meta's or
 * Google's own network is a checker. On an ordinary network a page shut in under 3 seconds with
 * no scroll, or one that sent nothing back at all, is not counted as a person.
 */
export function visitVerdict(row, nowMs = Date.now()) {
  if (!row || row.trk !== 2) return { label: "", why: "" };
  const e = row.eng && typeof row.eng === "object" ? row.eng : null;
  /* Read from the network's name when the row has it, so a name learnt later also re-reads old rows. */
  const net = row.asnOrg ? netKind(row.asnOrg) : row.net || "unknown";
  const taps = e ? TAP_KEYS.reduce((n, k) => n + (Number(e.taps?.[k]) || 0), 0) : 0;
  const did = e ? `on the page ${sayTime(e.secs)}${e.scrolled ? `, scrolled to ${e.scroll}%` : ", no scroll"}${taps ? `, ${taps} ${taps === 1 ? "tap" : "taps"}` : ""}` : "";
  if (e && (taps > 0 || (e.scrolled && e.secs >= 5))) return { label: "real", why: did };
  if (NET_WORDS[net]) return { label: "suspect", why: NET_WORDS[net] + (e ? `, ${did}` : "") };
  if (!e) {
    const age = nowMs - Date.parse(row.createdAt || "");
    if (age < 90 * 1000) return { label: "new", why: "just opened" };
    return { label: "suspect", why: "nothing came back after the page opened" };
  }
  if (e.secs < 3 && !e.scrolled) return { label: "suspect", why: `left in under 3 seconds, no scroll` };
  return { label: "real", why: did };
}

/**
 * One ping against the visit log. Only the browser that opened the page view can add to it (it
 * must name the row and the row's own visitor id), and only while the row is fresh. `budget` is
 * asked just before a write and may say no (the day's allowance is spent); nothing is lost but
 * that one update.
 */
export async function applyVisitPing(kv, body, { now = Date.now(), budget = async () => true, ttl = 90 * 24 * 3600 } = {}) {
  const id = String(body?.id || "");
  if (!VISIT_ID.test(id)) return { ok: false, reason: "id" };
  const row = await kv.get(id, "json");
  if (!row || typeof row !== "object") return { ok: false, reason: "gone" };
  if (!body.v || row.visitorId !== String(body.v)) return { ok: false, reason: "visitor" };
  const createdAtMs = Date.parse(row.createdAt || "");
  if (!(now - createdAtMs < PING_MAX_AGE_MS)) return { ok: false, reason: "old" };
  const prev = row.eng && typeof row.eng === "object" ? row.eng : null;
  const ping = cleanPing(body);
  if (prev && prev.n >= PING_MAX_WRITES) {
    const vital = ["buy", "checkout"].some((k) => (ping.taps[k] || 0) > (prev.taps?.[k] || 0));
    if (!vital || prev.n >= PING_MAX_WRITES + PING_VITAL_EXTRA) return { ok: true, wrote: false, reason: "full" };
  }
  const { eng, changed } = mergeEngagement(prev, ping, { createdAtMs, nowMs: now });
  if (!changed) return { ok: true, wrote: false, reason: "same" };
  if (!(await budget())) return { ok: true, wrote: false, reason: "budget" };
  await kv.put(id, JSON.stringify({ ...row, eng }), { expirationTtl: ttl });
  return { ok: true, wrote: true, eng };
}

/** After this long with no new report from a page, what the edge holds is written to the row. */
export const PING_QUIET_MS = 7000;
/** Seconds on screen at which the row is written whatever else happens. If the quiet write is
    ever lost, the row is still never further behind than the last of these. */
const SAFE_MARKS = [15, 30, 60, 180, 600];
const marksPassed = (secs) => SAFE_MARKS.filter((m) => m <= (Number(secs) || 0)).length;
const totals = (e) => ({ secs: e.secs || 0, scroll: e.scroll || 0, scrolled: Boolean(e.scrolled), order: Boolean(e.order), taps: { ...(e.taps || {}) } });
const sameTotals = (a, b) => Boolean(a && b) && JSON.stringify(totals(a)) === JSON.stringify(totals(b));

/** The newest of two sets of totals, field by field. Either may be missing. */
export function highestTotals(a, b) {
  if (!a || !b) return a || b ? totals(a || b) : null;
  const taps = { ...(a.taps || {}) };
  for (const k of TAP_KEYS) if ((b.taps?.[k] || 0) > (taps[k] || 0)) taps[k] = b.taps[k];
  return { secs: Math.max(a.secs || 0, b.secs || 0), scroll: Math.max(a.scroll || 0, b.scroll || 0), scrolled: Boolean(a.scrolled || b.scrolled), order: Boolean(a.order || b.order), taps };
}

/**
 * One report from a page, taken at the edge. `store` holds the newest totals for each open page
 * view ({ get(id), put(id, state) }, the edge cache in the Worker) and costs no KV write. The row
 * itself is written through applyVisitPing only when it matters (see the top of this file).
 * `defer(ms, fn)` runs fn later (ctx.waitUntil in the Worker); `clock()` is the time now.
 *
 * Every write carries all the totals so far, so a write that is refused, lost or late costs
 * nothing but freshness. If the store is not there at all, each report is written after the
 * quiet wait instead, and the per page and per day limits still hold.
 */
export async function takeVisitPing(kv, store, body, { clock = Date.now, budget, ttl, defer = () => {}, quietMs = PING_QUIET_MS } = {}) {
  const id = String(body?.id || "");
  if (!VISIT_ID.test(id)) return { ok: false, reason: "id" };
  const v = String(body?.v || "");
  if (!v) return { ok: false, reason: "visitor" };
  const now = clock();
  let state = null;
  try { state = await store.get(id); } catch { state = null; }
  if (state && state.v !== v) return { ok: false, reason: "visitor" };
  if (!state) {
    const row = await kv.get(id, "json");
    if (!row || typeof row !== "object") return { ok: false, reason: "gone" };
    if (row.visitorId !== v) return { ok: false, reason: "visitor" };
    const inRow = row.eng && typeof row.eng === "object" ? totals(row.eng) : null;
    state = { v, created: Date.parse(row.createdAt || ""), eng: inRow, sent: inRow, seq: 0 };
  }
  if (!(now - state.created < PING_MAX_AGE_MS)) return { ok: false, reason: "old" };
  const merged = mergeEngagement(state.eng, cleanPing(body), { createdAtMs: state.created, nowMs: now });
  if (!merged.changed) return { ok: true, wrote: false, held: false, reason: "same" };
  const edge = Boolean(state.seq); // the store had this page view: it is doing its job
  state.eng = totals(merged.eng);
  state.seq = (state.seq || 0) + 1;
  state.at = now;
  const seq = state.seq;

  const write = async (st) => {
    const done = await applyVisitPing(kv, { id, v: st.v, ...st.eng }, { now: clock(), budget, ttl });
    // Written or refused, these totals have had their turn: the next write carries them again.
    st.sent = st.eng;
    return Boolean(done.wrote);
  };
  const s = state.sent;
  const urgent =
    !s ||
    TAP_KEYS.some((k) => (state.eng.taps[k] || 0) > 0 && !(s.taps?.[k] > 0)) ||
    ["buy", "checkout"].some((k) => (state.eng.taps[k] || 0) > (s.taps?.[k] || 0)) ||
    marksPassed(state.eng.secs) > marksPassed(s.secs);
  let wrote = false;
  if (urgent) wrote = await write(state);
  try { await store.put(id, state); } catch {}
  if (!urgent) {
    defer(quietMs, async () => {
      let latest = null;
      try { latest = await store.get(id); } catch { latest = null; }
      if (latest && latest.seq !== seq) return; // a newer report came: its own wait decides
      const st = latest || state;
      if (sameTotals(st.eng, st.sent)) return;
      await write(st);
      if (latest) { try { await store.put(id, st); } catch {} }
    });
  }
  return { ok: true, wrote, held: !urgent, edge };
}

/** How many page views each browser session has in a list of rows: { sessionId: count }. */
export function pagesBySession(rows) {
  const out = {};
  for (const r of rows) if (r?.sessionId) out[r.sessionId] = (out[r.sessionId] || 0) + 1;
  return out;
}
