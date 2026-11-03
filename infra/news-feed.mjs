/**
 * Egg news for Admin > News: Australian egg supply, prices, bird flu and the industry, from
 * public feeds only. Nothing here is shown on the shop.
 *
 * The cron runs every 15 minutes and reads the sources that are due (at most PER_TICK a tick,
 * so one tick never makes too many requests). Refresh in the admin reads them all at once.
 *   Google News     two searches: egg prices and supply, and bird flu in Australia. Google
 *                   answers Cloudflare with 503, so a GitHub Actions job (news-relay.yml) reads
 *                   these two and posts them to /api/news/relay; the Worker only tries Google
 *                   itself when that relay has been quiet for a day
 *   ABC News        the "Poultry and egg production" and "Bird flu" topic feeds
 *   NSW Government  the bird flu page's "Latest advice" box (no feed, so the Worker reads it)
 *   NSW DPIRD       bird flu updates for poultry farmers (on the extensionAUS site)
 *   Australian Eggs, Egg Farmers of Australia, Inside FMCG (egg stories only)
 *   Outlets         7NEWS, The Guardian Australia, the Sydney Morning Herald, SBS News and Farm
 *                   Online: their general feeds, egg stories from here only
 *   Reddit          new posts about eggs in r/sydney, r/australia and r/AusFinance
 *   Added feeds     any RSS or Atom link the owner pastes in, such as a Google Alerts feed
 * Everything lives in one KV key (NEWS_KEY), written when something changed or every half hour,
 * so the cron adds few KV writes.
 */

const NEWS_KEY = "news:v1";
const CUSTOM_KEY = "news:v1:custom";
const MAX_ITEMS = 500;
const MAX_AGE_MS = 90 * 864e5;
const PER_TICK = 12;
// GitHub runs scheduled jobs on this repo every few hours, not every 15 minutes, so a relay is
// counted as current for a day. Only after that does the Worker try Google itself.
const RELAY_FRESH_MS = 24 * 3600 * 1000;
const MAX_RELAY_BYTES = 3_000_000;
const MIN_GAP_MS = 60 * 1000;
const WRITE_EVERY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;
const MAX_CUSTOM = 10;
const UA = "Mozilla/5.0 (compatible; YolkoNews/1.0; +https://getyolko.com)";
const NSW_URL = "https://www.nsw.gov.au/regional-and-primary-industries/biosecurity/bird-flu";

const GN = (q) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-AU&gl=AU&ceid=AU:en";

/** Built-in sources. `every` is minutes between reads; `filter` keeps only what fits. */
const SOURCES = [
  {
    id: "gn-eggs", name: "Google News", group: "Google News", kind: "rss", every: 15, relay: true,
    url: GN('("egg prices" OR "egg price" OR "egg shortage" OR "egg supply" OR "egg farmers" OR "egg farm" OR "egg industry" OR "caged eggs" OR "free range eggs" OR "egg producers" OR "egg cartel") australia when:7d'),
    about: "Egg prices, supply and farms, every outlet",
  },
  {
    id: "gn-birdflu", name: "Google News", group: "Google News", kind: "rss", every: 15, filter: "au", topic: "birdflu", relay: true,
    url: GN('("bird flu" OR "avian influenza" OR H5N1 OR H7) (poultry OR eggs OR "egg farm" OR chickens OR hens OR farms) (australia OR NSW OR victoria OR queensland) when:7d'),
    about: "Bird flu and poultry farms in Australia, every outlet",
  },
  { id: "abc-eggs", name: "ABC News", group: "ABC News", kind: "rss", every: 15, url: "https://www.abc.net.au/news/feed/2276/rss.xml", about: "Poultry and egg production" },
  { id: "abc-birdflu", name: "ABC News", group: "ABC News", kind: "rss", every: 15, topic: "birdflu", url: "https://www.abc.net.au/news/feed/1676/rss.xml", about: "Bird flu" },
  { id: "nsw-birdflu", name: "NSW Government", group: "NSW Government", kind: "nsw", every: 30, url: NSW_URL, about: "Bird flu page, latest advice" },
  { id: "nsw-dpird", name: "NSW DPIRD", group: "NSW DPIRD", kind: "rss", every: 60, topic: "birdflu", url: "https://extensionaus.com.au/smallscalepoultry/feed/", about: "Bird flu updates for poultry farmers" },
  { id: "aus-eggs", name: "Australian Eggs", group: "Australian Eggs", kind: "rss", every: 60, url: "https://www.australianeggs.org.au/news/rss", about: "The egg industry body" },
  { id: "efa", name: "Egg Farmers of Australia", group: "Egg Farmers of Australia", kind: "rss", every: 60, url: "https://eggfarmersaustralia.org/feed/", about: "The egg farmers' group" },
  { id: "inside-fmcg", name: "Inside FMCG", group: "Inside FMCG", kind: "rss", every: 30, filter: "egg", url: "https://insidefmcg.com.au/feed/", about: "Supermarket trade news, egg stories only" },
  {
    id: "reddit", name: "Reddit", group: "Reddit", kind: "rss", every: 30, filter: "reddit",
    url: "https://www.reddit.com/r/sydney+australia+AusFinance/search.rss?q=eggs&restrict_sr=on&sort=new&t=month",
    about: "New posts about eggs in r/sydney, r/australia and r/AusFinance",
  },
  { id: "7news", name: "7NEWS", group: "News outlets", kind: "rss", every: 30, filter: "egg-local", url: "https://7news.com.au/feed", about: "Egg stories from 7NEWS" },
  { id: "guardian-au", name: "The Guardian", group: "News outlets", kind: "rss", every: 30, filter: "egg-local", url: "https://www.theguardian.com/australia-news/rss", about: "Egg stories from The Guardian Australia" },
  { id: "smh", name: "Sydney Morning Herald", group: "News outlets", kind: "rss", every: 30, filter: "egg-local", url: "https://www.smh.com.au/rss/national.xml", about: "Egg stories from the Herald" },
  { id: "sbs", name: "SBS News", group: "News outlets", kind: "rss", every: 30, filter: "egg-local", url: "https://www.sbs.com.au/news/feed", about: "Egg stories from SBS News" },
  { id: "farmonline", name: "Farm Online", group: "News outlets", kind: "rss", every: 30, filter: "egg-local", url: "https://www.farmonline.com.au/rss.xml", about: "Egg stories from Farm Online" },
];

/* ------------------------------ text helpers ------------------------------ */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', laquo: '"', raquo: '"', middot: "·", bull: "·", copy: "©", reg: "®", trade: "™", eacute: "é", egrave: "è", aacute: "á", oacute: "ó", uuml: "ü", ouml: "ö" };

function decode(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    const v = NAMED[e.toLowerCase()];
    return v == null ? m : v;
  });
}

function cdata(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Feed text to plain text: CDATA, entities (twice, for feeds that escape their HTML), tags. */
function plain(s) {
  let t = decode(cdata(s));
  if (/<[a-z!/]/i.test(t)) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  t = decode(t);
  // Em and en dashes become plain hyphens, like the rest of the admin.
  return t.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(block);
  return m ? m[1] : "";
}

function attr(block, name, att) {
  const m = new RegExp("<" + name + "\\b[^>]*\\b" + att + '\\s*=\\s*"([^"]*)"', "i").exec(block);
  return m ? decode(m[1]) : "";
}

function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "...";
}

const KEEP_CAPS = new Set(["H5N1", "H5", "H7", "HPAI", "HPIA", "NSW", "ACT", "NT", "WA", "SA", "QLD", "VIC", "ACCC", "ABC", "SBS", "RSPCA", "FREPA", "DPIRD", "DAFF", "CSIRO", "CEO", "AU", "UK", "US", "USA"]);

/** A headline in capitals reads as shouting; turn it into sentence case, keeping acronyms. */
function unshout(t) {
  if (/[a-z]/.test(t) || !/[A-Z]{4}/.test(t)) return t;
  let first = true;
  return t.split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w)) return w;
    const bare = w.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    let out = KEEP_CAPS.has(bare) ? w : w.toLowerCase();
    if (first && /[a-z]/i.test(w)) { out = out.replace(/[a-z]/, (c) => c.toUpperCase()); first = false; }
    else if (/^(australian?s?|australia's|sydney|victoria|queensland|tasmania|scolexia)$/i.test(out.replace(/[^a-z']/gi, ""))) out = out.replace(/[a-z]/, (c) => c.toUpperCase());
    if (/[.?!:]$/.test(w)) first = true;
    return out;
  }).join("");
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function cleanUrl(u) {
  let url = String(u || "").trim();
  // Google Alerts links go through google.com/url?url=<the story>.
  try {
    const p = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(p.hostname) && p.pathname === "/url") {
      const real = p.searchParams.get("url") || p.searchParams.get("q");
      if (real && /^https?:\/\//i.test(real)) url = real;
    }
  } catch {}
  return /^https?:\/\//i.test(url) ? url.replace(/^http:\/\//i, "https://") : "";
}

function when(s) {
  const t = Date.parse(String(s || "").trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function titleKey(t) {
  return String(t || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
}

/* ------------------------------ feed parsing ------------------------------ */

/** RSS 2.0 and Atom to plain rows: { title, url, at, summary, publisher, publisherUrl, author }. */
function parseFeed(xml) {
  const text = String(xml || "");
  const out = [];
  const items = text.match(/<item[\s>][\s\S]*?<\/item>/gi);
  if (items) {
    for (const it of items) {
      let title = plain(tag(it, "title"));
      const publisher = plain(tag(it, "source"));
      const publisherUrl = attr(it, "source", "url");
      if (publisher && title.endsWith(" - " + publisher)) title = title.slice(0, -(publisher.length + 3)).trim();
      out.push({
        title,
        url: cleanUrl(plain(tag(it, "link")) || attr(it, "link", "href") || plain(tag(it, "guid"))),
        at: when(plain(tag(it, "pubDate")) || plain(tag(it, "dc:date")) || plain(tag(it, "published")) || plain(tag(it, "updated"))),
        summary: plain(tag(it, "description") || tag(it, "content:encoded")),
        publisher,
        publisherUrl,
        author: plain(tag(it, "dc:creator") || tag(it, "author")),
      });
    }
    return out;
  }
  const entries = text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const en of entries) {
    const links = en.match(/<link\b[^>]*>/gi) || [];
    let href = "";
    for (const l of links) {
      const rel = (/\brel\s*=\s*"([^"]*)"/i.exec(l) || [])[1] || "alternate";
      const h = (/\bhref\s*=\s*"([^"]*)"/i.exec(l) || [])[1];
      if (h && rel === "alternate") { href = decode(h); break; }
      if (h && !href) href = decode(h);
    }
    out.push({
      title: plain(tag(en, "title")),
      url: cleanUrl(href || plain(tag(en, "id"))),
      at: when(plain(tag(en, "published")) || plain(tag(en, "updated"))),
      summary: plain(tag(en, "summary") || tag(en, "content")),
      publisher: "",
      publisherUrl: "",
      author: plain(tag(tag(en, "author"), "name")),
      category: attr(en, "category", "label") || attr(en, "category", "term"),
    });
  }
  return out;
}

function isFeed(xml) {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(String(xml || "").slice(0, 4000));
}

/* ------------------------------ what to keep ------------------------------ */

const AU_RE = /\b(australian?s?|aussies?|aus|nsw|new south wales|sydney|victoria|victorian|vic|queensland|qld|tasmania|tasmanian|south australia|western australia|wa|northern territory|canberra|melbourne|perth|adelaide|hobart|brisbane|darwin|newcastle|wollongong|geelong|bendigo|ballarat|gippsland|riverina|hunter valley|accc|coles|woolworths|woolies|aldi australia|sunny queen|pace farm|manning valley)\b/i;
const AU_PUBLISHER_RE = /australia|\babc\b|\bsbs\b|nine|9news|7news|news\.com\.au|the age|smh|guardian australia|the nightly|daily aus|weekly times|the land|farm online|inside fmcg|crikey|the conversation/i;
const EGG_RE = /\beggs?\b|egg[\s-]?(farm|farmers|industry|price|prices|supply|shortage|producers?|layers?)|\bpoultry\b|\bhens?\b|layer hens?|bird[\s-]?flu|avian (influenza|flu)|\bh5n1\b/i;
const NOT_EGG_RE = /easter eggs?|chocolate eggs?|kinder|nest[\s-]?eggs?|egg[\s-]?hunt|scotch eggs?|eggplant|egg[\s-]?tarts?|eggnog/i;
const REDDIT_EGG_RE = /\beggs?\b/i;
const FOREIGN_RE = /\b(america|american|americans|trump|britain|british|england|scotland|ireland|new zealand|canada|canadian|china|chinese|india|japan|japanese|europe|european|mexico|brazil|south africa|philippines|indonesia|korea)\b/i;
const FOREIGN_CAPS_RE = /\bU\.?S\.?A?\b|\bUK\b|\bNZ\b|\bEU\b/;

const BIRDFLU_RE = /bird[\s-]?flu|avian (influenza|flu)|\bh5n1\b|\bh5\b|\bh7\b|\bhpai\b|housing order|poultry (lockdown|housing)/i;
const PRICE_RE = /\bprices?\b|\bpricing\b|\bcosts?\b|\bcostly\b|cheap|dearer|expensive|inflation|cartel|\baccc\b|price[\s-]?fix|shortages?|\bsupply\b|shelves|buying limits?|purchase limits?|\blimits?\b|out of stock|sold out|no eggs|can'?t find|hard to find|where to (buy|find)|\$\s?\d/i;

function keep(source, row) {
  if (!row.title || !row.url) return false;
  const t = row.title;
  if (source.filter === "reddit") return REDDIT_EGG_RE.test(t) && !NOT_EGG_RE.test(t);
  if (source.filter === "egg") return EGG_RE.test(t) && !NOT_EGG_RE.test(t);
  // General Australian outlets also run overseas egg stories; keep those only if they name Australia.
  if (source.filter === "egg-local") return EGG_RE.test(t) && !NOT_EGG_RE.test(t) && (!(FOREIGN_RE.test(t) || FOREIGN_CAPS_RE.test(t)) || AU_RE.test(t));
  if (source.filter === "au") {
    const host = hostOf(row.publisherUrl || row.url);
    return /\.au$/.test(host) || AU_RE.test(t) || AU_PUBLISHER_RE.test(row.publisher || "");
  }
  return true;
}

/** Bird flu from the headline or the summary; prices and supply from the headline only, since
 *  summaries mention costs in passing. */
function topicsOf(source, title, summary) {
  const out = [];
  if (source.topic === "birdflu" || BIRDFLU_RE.test(title + " " + (summary || ""))) out.push("birdflu");
  if (PRICE_RE.test(title)) out.push("prices");
  return out;
}

/** Outlet names as people say them: "ABC News", not "ABC News & Headlines - Australian ...". */
function cleanPublisher(name, url) {
  let n = String(name || "").trim();
  if (/^https?:\/\//i.test(n)) n = hostOf(n);
  if (/^abc news\b/i.test(n)) return "ABC News";
  if (/^sbs\b/i.test(n)) return "SBS News";
  n = n.split(/\s+[|\u2013\u2014-]\s+/)[0].trim();
  return n || hostOf(url) || "News";
}

/** One feed row to a stored story. */
function storyOf(source, row, nowIso) {
  const reddit = source.filter === "reddit";
  let publisher = row.publisher ? cleanPublisher(row.publisher, row.publisherUrl) : source.custom ? hostOf(row.url) || source.name : source.name;
  if (reddit) {
    const sub = /reddit\.com\/r\/([A-Za-z0-9_]+)/i.exec(row.url);
    publisher = sub ? "r/" + sub[1] : row.category ? "r/" + row.category : "Reddit";
  }
  let summary = row.summary || "";
  // Google News puts the headline and the outlet in the description; that adds nothing.
  if (source.group === "Google News" || titleKey(summary).startsWith(titleKey(row.title).slice(0, 40))) summary = "";
  if (reddit) summary = summary.replace(/submitted by\s+\/?u\/\S+.*$/i, "").replace(/\[link\]\s*\[comments\]\s*$/i, "").trim();
  summary = clip(summary, 220);
  const key = reddit ? "u:" + row.url.replace(/[?#].*$/, "").replace(/\/$/, "") : "t:" + titleKey(row.title);
  return {
    id: fnv(key),
    title: clip(unshout(row.title), 200),
    url: row.url,
    source: clip(publisher, 60),
    via: source.id,
    kind: reddit ? "reddit" : source.kind === "nsw" ? "official" : "news",
    at: row.at && Date.parse(row.at) <= Date.now() + 36e5 ? row.at : nowIso,
    seen: nowIso,
    summary,
    topics: topicsOf(source, row.title, row.summary),
  };
}

/* ------------------------------ NSW bird flu page ------------------------------ */

/** The "Latest advice" box on the NSW bird flu page: the event count, where the newest were and
 *  whether NSW farms are still clear. The page has no feed, so this is what the Worker watches. */
function parseNswPage(html) {
  const page = String(html || "");
  const at = /article:modified_time"\s+content="([^"]+)"/i.exec(page) || /dcterms\.modified"\s+content="([^"]+)"/i.exec(page);
  const start = page.search(/<h2[^>]*>\s*Latest advice\s*<\/h2>/i);
  if (start < 0) return null;
  const box = page.slice(start, start + 6000);
  const paras = (box.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map(plain).filter(Boolean);
  const lines = [];
  for (const p of paras) {
    if (/^if you find sick|^report|^to report/i.test(p)) break;
    if (/^for details on event locations/i.test(p)) continue;
    lines.push(p);
  }
  const text = lines.join(" ").trim();
  if (!text) return null;
  const n = /recorded\s+(\d[\d,]*)\s+H5/i.exec(text);
  const where = /events?\s+(?:was|were)\s+confirmed\s+in\s+([^.]+)\./i.exec(text);
  return {
    events: n ? Number(n[1].replace(/,/g, "")) : null,
    latest: where ? clip(where[1].trim(), 140) : "",
    farmsClear: /no detections in commercial poultry/i.test(text),
    text: clip(text, 600),
    pageDate: at ? when(at[1]) : null,
  };
}

function nswStory(prev, next, nowIso) {
  let title;
  if (prev && prev.farmsClear && !next.farmsClear) title = "NSW bird flu page no longer says farms are clear. Check it now";
  else if (next.events != null && prev && prev.events != null && next.events !== prev.events) {
    title = "NSW bird flu: " + next.events + " cases, up from " + prev.events + (next.latest ? ". Newest in " + next.latest : "");
  } else if (next.events != null && !prev) {
    title = "NSW bird flu: " + next.events + " cases so far" + (next.farmsClear ? ". No farms hit" : "");
  } else title = "NSW bird flu advice updated";
  return {
    id: fnv("nsw:" + next.text),
    title: clip(title, 200),
    url: NSW_URL,
    source: "NSW Government",
    via: "nsw-birdflu",
    kind: "official",
    at: nowIso,
    seen: nowIso,
    summary: clip(next.text, 220),
    topics: ["birdflu"],
  };
}

/* ------------------------------ fetching ------------------------------ */

async function getText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5", "Accept-Language": "en-AU,en;q=0.9" },
      redirect: "follow",
      signal: ctrl.signal,
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const body = await res.text();
    return { ok: true, body: body.length > 3_000_000 ? body.slice(0, 3_000_000) : body };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "No answer in 12 seconds" : String(err?.message || err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Read one source. Returns its stories (and, for the NSW page, the parsed advice). */
async function readSource(source, prevNsw, nowIso) {
  const got = await getText(source.url);
  if (!got.ok) return { ok: false, error: got.error, stories: [] };
  return storiesFrom(source, got.body, prevNsw, nowIso);
}

/** A fetched page or feed to stories. Shared by the Worker's own reads and the GitHub relay. */
function storiesFrom(source, body, prevNsw, nowIso) {
  const got = { body };
  if (source.kind === "nsw") {
    const nsw = parseNswPage(got.body);
    if (!nsw) return { ok: false, error: "The Latest advice box wasn't on the page", stories: [] };
    const changed = !prevNsw || prevNsw.text !== nsw.text;
    return { ok: true, nsw, stories: changed ? [nswStory(prevNsw, nsw, nowIso)] : [], count: 1 };
  }
  if (!isFeed(got.body)) return { ok: false, error: "That link isn't a news feed", stories: [] };
  const rows = parseFeed(got.body);
  const stories = rows.filter((r) => keep(source, r)).map((r) => storyOf(source, r, nowIso));
  return { ok: true, stories, count: rows.length };
}

/* ------------------------------ storage ------------------------------ */

async function getStore(env) {
  const raw = await env.DATA.get(NEWS_KEY, "json");
  return raw && typeof raw === "object" ? { items: [], sources: {}, nsw: null, ...raw } : { items: [], sources: {}, nsw: null };
}

async function getCustom(env) {
  const raw = await env.DATA.get(CUSTOM_KEY, "json");
  return Array.isArray(raw) ? raw : [];
}

function customSources(custom) {
  return custom.map((c) => ({ id: c.id, name: c.name || hostOf(c.url) || "Added feed", group: "Added feeds", kind: "rss", every: 30, url: c.url, about: hostOf(c.url), custom: true, addedAt: c.addedAt }));
}

/** Put new stories in front of the old ones, one row per story, newest first. */
function mergeStories(items, fresh) {
  const byId = new Map(items.map((s) => [s.id, s]));
  let added = 0;
  for (const s of fresh) {
    const old = byId.get(s.id);
    if (!old) { byId.set(s.id, s); added++; continue; }
    // The same story from its own outlet beats the Google News copy of it.
    if (old.via.startsWith("gn-") && !s.via.startsWith("gn-")) byId.set(s.id, { ...s, seen: old.seen, at: old.at < s.at ? old.at : s.at, topics: [...new Set([...old.topics, ...s.topics])] });
    else if (s.topics.some((t) => !old.topics.includes(t))) byId.set(s.id, { ...old, topics: [...new Set([...old.topics, ...s.topics])] });
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  const next = [...byId.values()]
    .filter((s) => Date.parse(s.at) >= cutoff)
    .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
    .slice(0, MAX_ITEMS);
  return { items: next, added };
}

/** Relayed sources are read by GitHub; the Worker tries them itself only once the relay is quiet. */
function relayQuiet(source, state, now) {
  return !source.relay || !state?.relayAt || now - Date.parse(state.relayAt) > RELAY_FRESH_MS;
}

function due(source, state, now) {
  if (!relayQuiet(source, state, now)) return false;
  const last = state?.checkedAt ? Date.parse(state.checkedAt) : 0;
  const gap = (state && !state.ok ? Math.min(source.every, 30) : source.every) * 60 * 1000;
  return now - last >= gap - 60 * 1000;
}

/** Read the given sources and save what changed. `read` swaps in another reader (the relay). */
async function readAndSave(env, store, sources, { force = false, read = null, relayed = false } = {}) {
  const nowIso = new Date().toISOString();
  const reader = read || ((s) => readSource(s, store.nsw, nowIso));
  const results = await Promise.all(sources.map((s) => Promise.resolve(reader(s, nowIso)).then((r) => [s, r])));
  let fresh = [];
  let statusChanged = false;
  const sourceState = { ...store.sources };
  let nsw = store.nsw;
  let nswChanged = false;
  for (const [s, r] of results) {
    const prev = sourceState[s.id];
    if (!prev || prev.ok !== r.ok) statusChanged = true;
    sourceState[s.id] = {
      ok: r.ok,
      checkedAt: nowIso,
      okAt: r.ok ? nowIso : prev?.okAt || null,
      error: r.ok ? null : r.error,
      count: r.ok ? r.stories.length : prev?.count ?? 0,
      ...(s.relay ? { relayAt: relayed && r.ok ? nowIso : prev?.relayAt || null } : {}),
    };
    if (r.ok) fresh = fresh.concat(r.stories);
    if (r.nsw) {
      if (!nsw || nsw.text !== r.nsw.text) nswChanged = true;
      nsw = { ...r.nsw, checkedAt: nowIso, changedAt: !nsw || nsw.text !== r.nsw.text ? nowIso : nsw.changedAt };
    }
  }
  const { items, added } = mergeStories(store.items || [], fresh);
  const age = store.updatedAt ? Date.now() - Date.parse(store.updatedAt) : Infinity;
  const next = { v: 1, updatedAt: nowIso, items, sources: sourceState, nsw };
  if (force || added || statusChanged || nswChanged || age >= WRITE_EVERY_MS) {
    await env.DATA.put(NEWS_KEY, JSON.stringify(next));
  }
  return { store: next, added, read: sources.length, failed: results.filter(([, r]) => !r.ok).length };
}

/* ------------------------------ public API ------------------------------ */

function sourceList(store, custom, now = Date.now()) {
  return SOURCES.concat(customSources(custom)).map((s) => {
    let state = store.sources?.[s.id] || { ok: null, checkedAt: null, count: 0 };
    // A relayed source shows how the last relay went while it is current, not a failed direct read.
    if (!relayQuiet(s, state, now) && state.ok === false) state = { ...state, ok: true, error: null, checkedAt: state.relayAt, okAt: state.relayAt };
    return {
      id: s.id,
      name: s.name,
      group: s.group,
      about: s.about,
      url: s.custom ? s.url : s.kind === "nsw" ? s.url : null,
      custom: !!s.custom,
      every: s.every,
      ...state,
    };
  });
}

/** Everything the News page shows, in one answer. */
async function newsView(env, limit = 300) {
  const [store, custom] = await Promise.all([getStore(env), getCustom(env)]);
  return {
    ok: true,
    updatedAt: store.updatedAt || null,
    items: (store.items || []).slice(0, limit),
    nsw: store.nsw || null,
    sources: sourceList(store, custom),
  };
}

/** Refresh: read every source now, unless that happened in the last minute. */
async function runNewsPoll(env, { force = false } = {}) {
  const store = await getStore(env);
  const age = store.updatedAt ? Date.now() - Date.parse(store.updatedAt) : Infinity;
  const allFresh = Object.keys(store.sources || {}).length > 0 && age < MIN_GAP_MS;
  if (!force && allFresh) return { ran: false, added: 0 };
  const custom = await getCustom(env);
  const now = Date.now();
  const all = SOURCES.concat(customSources(custom)).filter((s) => relayQuiet(s, store.sources?.[s.id], now));
  const r = await readAndSave(env, store, all, { force: true });
  return { ran: true, added: r.added, failed: r.failed };
}

/** Cron, every 15 minutes: read the sources that are due, the longest-waiting first. */
async function runScheduledNews(env) {
  const [store, custom] = await Promise.all([getStore(env), getCustom(env)]);
  const now = Date.now();
  const all = SOURCES.concat(customSources(custom));
  const waiting = all
    .filter((s) => due(s, store.sources?.[s.id], now))
    .sort((a, b) => Date.parse(store.sources?.[a.id]?.checkedAt || 0) - Date.parse(store.sources?.[b.id]?.checkedAt || 0))
    .slice(0, PER_TICK);
  if (!waiting.length) return { ran: false };
  const r = await readAndSave(env, store, waiting);
  return { ran: true, added: r.added, failed: r.failed };
}

/* ------------------------------ GitHub relay ------------------------------ */

const GH_ISSUER = "https://token.actions.githubusercontent.com";
const GH_REPO = "LitKanna/getyolko";
const GH_WORKFLOW = GH_REPO + "/.github/workflows/news-relay.yml@refs/heads/main";
const RELAY_AUDIENCE = "https://getyolko.com";

function b64urlBytes(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** True when the request carries a GitHub Actions OIDC token from news-relay.yml on main of this
 *  repo. No shared secret: GitHub signs the token and the Worker checks it against GitHub's keys. */
async function isGithubRelay(request) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(m[1])));
    const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(m[2])));
    if (header.alg !== "RS256" || !header.kid) return false;
    const now = Date.now() / 1000;
    if (claims.iss !== GH_ISSUER || claims.aud !== RELAY_AUDIENCE) return false;
    if (claims.repository !== GH_REPO || claims.ref !== "refs/heads/main" || claims.job_workflow_ref !== GH_WORKFLOW) return false;
    if (!(claims.exp > now) || !(claims.iat < now + 300)) return false;
    const res = await fetch(GH_ISSUER + "/.well-known/jwks", { cf: { cacheTtl: 3600 } });
    if (!res.ok) return false;
    const jwk = ((await res.json()).keys || []).find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(m[3]), new TextEncoder().encode(m[1] + "." + m[2]));
  } catch {
    return false;
  }
}

/** The feeds the GitHub job read for us: { feeds: [{ id, status, body }] }. Only relayed sources. */
async function takeNewsRelay(env, payload) {
  const feeds = Array.isArray(payload?.feeds) ? payload.feeds : [];
  const byId = new Map(feeds.map((f) => [String(f?.id || ""), f]));
  const sources = SOURCES.filter((s) => s.relay && byId.has(s.id));
  if (!sources.length) return { error: "No relayed feeds in that" };
  const store = await getStore(env);
  const read = (s, nowIso) => {
    const f = byId.get(s.id);
    const body = typeof f.body === "string" ? f.body.slice(0, MAX_RELAY_BYTES) : "";
    if (!body) return { ok: false, error: f.error ? String(f.error).slice(0, 120) : "GitHub couldn't read it", stories: [] };
    return storiesFrom(s, body, store.nsw, nowIso);
  };
  const r = await readAndSave(env, store, sources, { read, relayed: true });
  return { ok: true, read: r.read, added: r.added, failed: r.failed };
}

/** Add or remove a pasted feed (for example a Google Alerts RSS link). */
async function saveNewsFeed(env, body) {
  const custom = await getCustom(env);
  if (body?.remove) {
    const id = String(body.id || "");
    const gone = custom.find((c) => c.id === id);
    if (!gone) return { error: "That feed is already gone" };
    await env.DATA.put(CUSTOM_KEY, JSON.stringify(custom.filter((c) => c.id !== id)));
    const store = await getStore(env);
    const items = (store.items || []).filter((s) => s.via !== id);
    const sources = { ...store.sources };
    delete sources[id];
    await env.DATA.put(NEWS_KEY, JSON.stringify({ ...store, items, sources }));
    return { ok: true, removed: gone };
  }
  let url = String(body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url.replace(/^\/+/, "");
  url = url.replace(/^http:\/\//i, "https://");
  let parsed;
  try { parsed = new URL(url); } catch { return { error: "Paste the whole feed link" }; }
  if (!parsed.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname)) return { error: "Paste the whole feed link" };
  if (url.length > 600) return { error: "That link is too long" };
  if (custom.some((c) => c.url === url) || SOURCES.some((s) => s.url === url)) return { error: "That feed is already on the list" };
  if (custom.length >= MAX_CUSTOM) return { error: "Remove a feed first. The list holds " + MAX_CUSTOM };
  const got = await getText(url);
  if (!got.ok) return { error: "That link didn't open (" + got.error + ")" };
  if (!isFeed(got.body)) return { error: "That link isn't a news feed. In Google Alerts, choose Deliver to: RSS feed, then copy the feed link" };
  const feedTitle = plain(tag(got.body, "title")).replace(/^Google Alert\s*-\s*/i, "");
  const name = clip(String(body?.name || "").replace(/\s+/g, " ").trim() || (/google\.[a-z.]+\/alerts/i.test(url) ? "Google Alert: " + (feedTitle || "eggs") : feedTitle || hostOf(url)), 60);
  const restoreId = String(body?.id || "");
  const row = { id: restoreId.startsWith("feed:") ? restoreId : "feed:" + fnv(url), name, url, addedAt: new Date().toISOString() };
  await env.DATA.put(CUSTOM_KEY, JSON.stringify([...custom, row]));
  const store = await getStore(env);
  const r = await readAndSave(env, store, customSources([row]), { force: true });
  return { ok: true, feed: row, added: r.added };
}

export {
  newsView,
  runNewsPoll,
  runScheduledNews,
  saveNewsFeed,
  isGithubRelay,
  takeNewsRelay,
  // for tests and the relay job
  storiesFrom,
  isFeed,
  parseFeed,
  parseNswPage,
  keep,
  storyOf,
  mergeStories,
  topicsOf,
  plain,
  SOURCES,
};
