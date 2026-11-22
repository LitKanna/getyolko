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
// eng.taps     how many times each control was tapped; "form" is 1 once a form box was entered
// eng.n        how many sends changed the row; eng.at is the time of the last one

/** KV writes one page view may cost for engagement. A Buy now or checkout tap may go a little over. */
export const PING_MAX_WRITES = 8;
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
  /amazon|\baws\b|microsoft|azure|digitalocean|linode|akamai|\bovh\b|hetzner|oracle|alibaba|tencent|cloudflare|fastly|vultr|constant company|choopa|contabo|scaleway|leaseweb|\bm247\b|datacamp|cdn77|hostinger|ionos|godaddy|rackspace|colocrossing|psychz|quadranet|bytedance|apple inc|hosting|data ?cent(er|re)|dedicated|\bvps\b|\bcloud\b|servers?\b/;

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
  const net = row.net || netKind(row.asnOrg);
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

/** How many page views each browser session has in a list of rows: { sessionId: count }. */
export function pagesBySession(rows) {
  const out = {};
  for (const r of rows) if (r?.sessionId) out[r.sessionId] = (out[r.sessionId] || 0) + 1;
  return out;
}
