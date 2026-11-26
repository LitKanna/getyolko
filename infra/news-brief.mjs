/**
 * Summaries for Admin > News, written from each story's own article, never from the headline.
 *
 * For every story from the last BRIEF_DAYS days the Worker opens the article itself, takes the
 * story's text out of the page (the publisher's own article body, not menus, adverts or related
 * stories) and asks a Workers AI model for a short summary, the key facts and one line on what it
 * could mean for YOLKO. Every number in the answer is checked against the article: a line with a
 * number the article doesn't have is dropped, so the summary only repeats what the source says.
 *
 *   Google News  its links lead to Google, not the article. The feed names the outlet's home
 *                page, so the Worker looks for the same headline in the outlet's own news
 *                sitemap or feed (findOnSite) and reads the article from there. When the outlet
 *                doesn't list it, the story has no summary and the admin says why
 *   Reddit       the post and its top replies, from the thread's own feed
 *   NSW page     the "Latest advice" text the story was made from; no model needed
 *   Paywalled    only the article's opening is public (MLex, for one): the summary says so
 * The Worker leaves alone any page an outlet's robots.txt asks every reader to skip.
 *
 * Cost: Workers AI gives every account 10,000 "neurons" a day free. One summary uses about 150.
 * DAILY_NEURONS caps the day well under that, so this never adds to the bill. Summaries live in
 * one KV key (BRIEFS_KEY), next to the news itself.
 */

import { plain, parseFeed } from "./news-feed.mjs";

const BRIEFS_KEY = "news:v1:briefs";
const BRIEF_DAYS = 21;
const PER_TICK = 3;
const MAX_TRIES = 3;
const RETRY_MS = 2 * 3600 * 1000;
// Outlets list a story in their news sitemap or feed for a day or two, so an older Google News
// story isn't looked for.
const SITE_LOOK_DAYS = 4;
// Pages read per cron tick for summaries, so a tick stays well inside the Worker's request limit.
const READS_PER_TICK = 14;
const DAILY_NEURONS = 6000;
const TEXT_MAX = 12000;
const FULL_MIN = 500;
const FETCH_TIMEOUT_MS = 15 * 1000;
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Tried in order; the next one answers if one fails. `inN`/`outN` are Cloudflare's published
 *  neurons per million input and output tokens, used to keep the day under DAILY_NEURONS. */
const BRIEF_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, points: { type: "array", items: { type: "string" } }, forUs: { type: "string" }, onTopic: { type: "boolean" } },
  required: ["summary", "points", "forUs", "onTopic"],
};
// Checked on this account on 26 Nov 2026 with an ABC egg story: DeepSeek answered in 2 seconds for
// about 60 neurons; Gemma needs its thinking off (else it spends every token thinking); Llama
// needs the JSON shape spelt out (else it can leave a quote open).
const MODELS = [
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", inN: 27273, outN: 109091, opts: { reasoning_effort: "none" } },
  { id: "@cf/google/gemma-4-26b-a4b-it", inN: 9091, outN: 27273, opts: { chat_template_kwargs: { enable_thinking: false } } },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inN: 26668, outN: 204805, opts: { response_format: { type: "json_schema", json_schema: BRIEF_SCHEMA } } },
];

/* ------------------------------ reading the article ------------------------------ */

const STOP = new Set("the a an and or of to in on for at by with from as is are was were be been it its this that these those into over after before about than more most new news says said say".split(" "));

function words(s) {
  return String(s || "").toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

function metaContent(html, key) {
  const re = new RegExp("<meta\\b[^>]*\\b(?:property|name|itemprop)\\s*=\\s*[\"']" + key.replace(/[.:]/g, "\\$&") + "[\"'][^>]*>", "i");
  const tag = re.exec(html);
  if (!tag) return "";
  const c = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag[0]) || /\bcontent\s*=\s*'([^']*)'/i.exec(tag[0]);
  return c ? plain(c[1]) : "";
}

/** Every JSON-LD object on the page, @graph arrays opened up. */
function jsonLd(html) {
  const out = [];
  const blocks = html.match(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    out.push(o);
    if (o["@graph"]) walk(o["@graph"]);
  };
  for (const b of blocks) {
    const body = b.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try { walk(JSON.parse(body)); } catch {}
  }
  return out;
}

const BOILER_RE = /enable javascript|javascript (is )?disabled|update your browser|cookies? (policy|settings|preferences)|all rights reserved|sign up (to|for) (our|the)\b.*newsletter|get the latest .* (delivered|in your inbox)|this service may include material from|^(advertisement|sponsored content|related stories?|read more|more on this|share this|follow us)\b/i;
const PAYWALL_RE = /free trial|already (a )?subscriber|subscribe (now|today|to (continue|read|keep))|subscribers? only|to continue reading|keep reading with|create a free account|(log|sign) ?in to (read|continue|keep)|unlock this (article|story)|this (article|story) is for (subscribers|members)/i;

/** The story's paragraphs in page order. Pictures and their captions, menus, headers, footers and
 *  side panels are taken out first. */
function paragraphs(html) {
  const h = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|figure|figcaption|nav|header|footer|aside|form|button|select|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const out = [];
  const re = /<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(h))) {
    const t = plain(m[2]);
    if (t.length < (m[1] === "li" ? 50 : 30)) continue;
    out.push({ at: m.index, text: t, tag: m[1] });
  }
  return out;
}

/** Paragraphs that sit close together in the page make one block; the article is the biggest block
 *  that shares words with the headline (a paywall's sales pitch or a list of other stories don't). */
function articleBlock(paras, title, lede) {
  const blocks = [];
  let cur = null;
  for (const p of paras) {
    if (!cur || p.at - cur.end > 5000) { cur = { paras: [], end: p.at, len: 0 }; blocks.push(cur); }
    cur.paras.push(p);
    cur.end = p.at + p.text.length;
    cur.len += p.text.length;
  }
  const key = new Set(words(title + " " + lede));
  const scored = blocks.map((b) => {
    const seen = new Set();
    for (const p of b.paras) for (const w of words(p.text)) if (key.has(w)) seen.add(w);
    return { b, hits: seen.size };
  }).filter((x) => !key.size || x.hits >= Math.max(2, Math.ceil(key.size * 0.15)));
  scored.sort((x, y) => y.b.len - x.b.len);
  return scored.length ? scored[0].b.paras : [];
}

/**
 * A fetched article page to what the summary is written from:
 *   { title, lede, site, published, text, from: "article" | "opening" | null, paywall }
 * "article" is the full story; "opening" is only its first lines (a paywall, or a page that
 * builds its text with JavaScript).
 */
function extractArticle(html, url = "") {
  const page = String(html || "");
  // "Headline | MLex | Specialist news..." or "Headline - Australian Eggs": the headline alone.
  let title = metaContent(page, "og:title") || plain((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page) || [])[1] || "");
  title = title.split(/\s+[|·]\s+/)[0].trim();
  const dash = title.lastIndexOf(" - ");
  if (dash > 20 && title.slice(dash + 3).split(/\s+/).length <= 4) title = title.slice(0, dash).trim();
  const lede = metaContent(page, "og:description") || metaContent(page, "description") || metaContent(page, "twitter:description");
  const site = metaContent(page, "og:site_name");
  const published = metaContent(page, "article:published_time") || null;
  let paywall = false;
  let body = "";
  for (const o of jsonLd(page)) {
    if (o.isAccessibleForFree === false || o.isAccessibleForFree === "False" || o.isAccessibleForFree === "false") paywall = true;
    if (typeof o.articleBody === "string" && o.articleBody.length > body.length) body = plain(o.articleBody);
  }
  if (body.length < FULL_MIN) {
    const paras = paragraphs(page).filter((p) => !BOILER_RE.test(p.text));
    if (paras.some((p) => PAYWALL_RE.test(p.text))) paywall = true;
    const story = articleBlock(paras.filter((p) => !PAYWALL_RE.test(p.text)), title, lede);
    const text = story.map((p) => (p.tag === "li" ? "- " : "") + p.text).join("\n\n");
    if (text.length > body.length) body = text;
  }
  let from = null;
  let text = "";
  if (body.length >= FULL_MIN) { from = "article"; text = body.slice(0, TEXT_MAX); }
  else if (lede || body) {
    // Only the opening is public: the lede, and any first lines the page shows, said once.
    from = "opening";
    text = [lede, body && !(lede && body.startsWith(lede.slice(0, 60))) ? body : ""].filter(Boolean).join("\n\n").slice(0, TEXT_MAX);
  }
  if (from === "opening" && text.length < 60) { from = null; text = ""; }
  return { url, title, lede, site, published, text, from, paywall };
}

/** A Reddit thread's own feed: the post first, then the top comments. */
function redditThread(xml, title) {
  const rows = parseFeed(xml);
  if (!rows.length) return { text: "", from: null };
  const post = rows[0];
  const comments = rows.slice(1, 13).map((r) => r.summary.replace(/submitted by\s+\/?u\/\S+.*$/i, "").replace(/\[link\]\s*\[comments\]\s*$/i, "").trim()).filter((c) => c.length > 3);
  const postText = (post.summary || "").replace(/submitted by\s+\/?u\/\S+.*$/i, "").replace(/\[link\]\s*\[comments\]\s*$/i, "").trim();
  const text = ["Post: " + (post.title || title), postText, comments.length ? "Replies:\n" + comments.map((c) => "- " + c).join("\n") : ""].filter(Boolean).join("\n\n");
  return { text: text.slice(0, TEXT_MAX), from: "thread", comments: comments.length };
}

/* ------------------------------ Google News links ------------------------------ */

function isGoogleNews(url) {
  return /^https:\/\/news\.google\.com\/(rss\/)?articles\//i.test(String(url || ""));
}

/* ------------------------------ finding a Google News story's own page ------------------------------ */
// Google News feeds give a news.google.com link and the outlet's home page, not the article. The
// outlet's own feed or its news sitemap (the lists publishers keep for search engines and feed
// readers) usually has the same headline with its real link, so the Worker looks there.

function titleWords(t) {
  return words(String(t || "").replace(/\s+[-|·]\s+[^-|·]{2,60}$/, ""));
}

/** How well a headline matches the story's: 1 is the same words. */
function titleMatch(a, b) {
  const x = titleWords(a), y = new Set(titleWords(b));
  if (!x.length || !y.size) return 0;
  let hit = 0;
  for (const w of new Set(x)) if (y.has(w)) hit++;
  return hit / Math.max(new Set(x).size, y.size);
}

/** Headline-like words in a link: /news/egg-prices-could-soar-12345 gives egg prices could soar. */
function slugWords(u) {
  try { return new URL(u).pathname.split("/").filter(Boolean).pop().replace(/\.[a-z]{2,5}$/i, "").replace(/[-_]+/g, " "); } catch { return ""; }
}

/** Article links and headlines in a sitemap, a sitemap index's child list, or a feed. */
function listEntries(xml) {
  const text = String(xml || "");
  if (/<sitemapindex[\s>]/i.test(text)) {
    const maps = [...text.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>(?:[\s\S]*?<lastmod>\s*([^<\s]+))?[\s\S]*?<\/sitemap>/gi)].map((m) => ({ loc: plain(m[1]), mod: m[2] || "" }));
    return { maps };
  }
  if (/<urlset[\s>]/i.test(text)) {
    const urls = [...text.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => {
      const loc = plain((/<loc>([\s\S]*?)<\/loc>/i.exec(m[1]) || [])[1] || "");
      const t = plain((/<news:title>([\s\S]*?)<\/news:title>/i.exec(m[1]) || [])[1] || "");
      return { url: loc, title: t };
    });
    return { urls };
  }
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000))) return { urls: parseFeed(text).map((r) => ({ url: r.url, title: r.title })) };
  return {};
}

function robotsSitemaps(txt) {
  return [...String(txt || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}

function feedLinks(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?alternate/i.test(tag) || !/application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = (/\bhref\s*=\s*"([^"]+)"/i.exec(tag) || /\bhref\s*=\s*'([^']+)'/i.exec(tag) || [])[1];
    if (!href) continue;
    try { out.push(new URL(plain(href), base).href); } catch {}
  }
  return out;
}

/** Disallowed paths for every reader in a robots.txt: a page there is left alone. */
function robotsRules(txt) {
  // Groups are one or more User-agent lines followed by their rules.
  const rules = [];
  let agents = [], inRules = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (inRules) { agents = []; inRules = false; }
      agents.push(v);
    } else if (k === "disallow" || k === "allow") {
      inRules = true;
      if (k === "disallow" && v && agents.includes("*")) rules.push(v);
    }
  }
  return rules;
}

function robotsAllows(rules, url) {
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { return true; }
  return !(rules || []).some((r) => {
    const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    return re.test(path);
  });
}

/**
 * Look for the story on its outlet's own site. `site` is the outlet's home page from Google News.
 * Reads robots.txt (its news sitemaps, and what it asks readers to leave alone), the home page's
 * feed links and the common feed paths, at most MAX_SITE_READS pages in all. Returns
 * { url, robots } or { error, robots }. `fetchFn` is fetch.
 */
const MAX_SITE_READS = 6;
async function findOnSite(site, title, fetchFn = fetch) {
  let origin;
  try { origin = new URL(site).origin; } catch { return { error: "No outlet site" }; }
  let reads = 0;
  const get = async (u, accept) => {
    if (reads >= MAX_SITE_READS) return null;
    reads++;
    try {
      const res = await fetchFn(u, { headers: { "User-Agent": UA_BROWSER, Accept: accept || "application/xml,text/xml,application/rss+xml,text/html;q=0.8,*/*;q=0.5", "Accept-Language": "en-AU,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const t = await res.text();
      return t.length > 6_000_000 ? t.slice(0, 6_000_000) : t;
    } catch { return null; }
  };
  const robotsTxt = (await get(origin + "/robots.txt", "text/plain")) || "";
  const robots = robotsRules(robotsTxt);
  const sitemaps = robotsSitemaps(robotsTxt).filter((u) => /news/i.test(u)).slice(0, 2);
  let best = null;
  const consider = (list) => {
    for (const e of list || []) {
      if (!e.url || !/^https?:\/\//i.test(e.url)) continue;
      const score = Math.max(titleMatch(title, e.title), e.title ? 0 : titleMatch(title, slugWords(e.url)) * 0.95);
      if (score >= 0.75 && (!best || score > best.score)) best = { url: e.url, score };
    }
  };
  const readList = async (u, depth = 0) => {
    const xml = await get(u);
    if (!xml) return;
    const got = listEntries(xml);
    if (got.urls) consider(got.urls);
    if (got.maps && depth === 0) {
      // A sitemap index: its newest children first (by date, or the news ones, or the last listed).
      const kids = got.maps.slice().sort((a, b) => (b.mod > a.mod ? 1 : b.mod < a.mod ? -1 : 0));
      const pick = (kids.some((k) => k.mod) ? kids : got.maps.slice().reverse()).filter((k) => !/video|image|topic|section|author|tag|categor/i.test(k.loc)).slice(0, 2);
      for (const k of pick) { if (best && best.score >= 0.95) break; await readList(k.loc, 1); }
    }
  };
  for (const sm of sitemaps) { if (best && best.score >= 0.95) break; await readList(sm); }
  if (!best || best.score < 0.95) {
    const home = await get(origin + "/", "text/html");
    const feeds = [...new Set([...feedLinks(home, origin + "/"), origin + "/feed/", origin + "/rss"])].slice(0, 3);
    for (const f of feeds) { if (best && best.score >= 0.95) break; await readList(f, 1); }
  }
  if (best && !robotsAllows(robots, best.url)) return { error: "The outlet asks readers to leave that page alone", robots };
  return best ? { url: best.url, score: best.score, robots } : { error: "Couldn't find the article on " + new URL(origin).hostname, robots };
}

/* ------------------------------ the summary ------------------------------ */

const SYSTEM = [
  "You write short news briefs for the owner of YOLKO, a small Sydney business that delivers trays of eggs to homes and cafés every Saturday.",
  "Use only facts stated in the text you are given. Never add a fact, number, name, place or date that is not in the text, and never guess.",
  "If you only have the opening of an article, summarise just that.",
  "Ignore anything that is not the story itself: menus, adverts, subscription offers, photo captions, other stories.",
  "Write plain Australian English in short sentences. No jargon, no hype, no dashes between clauses, no markdown.",
  "Answer with one JSON object and nothing else.",
].join(" ");

const FROM_WORDS = {
  article: "The full article",
  opening: "Only the article's opening lines (the rest is not public)",
  thread: "A Reddit post and its replies (people's own words, not checked facts)",
  page: "An official government page",
};

function briefMessages(story, art) {
  const date = story.at ? new Date(story.at).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric" }) : "";
  const user = [
    "Headline: " + story.title,
    "Outlet: " + (story.source || art.site || ""),
    date ? "Date: " + date : "",
    "What you have: " + (FROM_WORDS[art.from] || "The article"),
    "",
    'Text:\n"""\n' + art.text + '\n"""',
    "",
    "Return this JSON:",
    "{",
    '  "summary": "Two or three sentences: what happened, who, where and when.",',
    art.from === "opening"
      ? '  "points": ["Only facts the text gives that the summary leaves out, one short sentence each. Usually none: then an empty list."],'
      : '  "points": ["Three to five key facts, one short sentence each, keeping the exact numbers, prices, places, dates and names from the text. Each adds something the summary does not say. Fewer when the text is short."],',
    '  "forUs": "One sentence on what this could mean for egg supply, egg prices or egg buyers in Sydney, drawn only from the text. An empty string when the text does not bear on that.",',
    '  "onTopic": true',
    "}",
    "Set onTopic to false when the text is not really about eggs, egg farming, poultry or bird flu.",
  ].join("\n");
  return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
}

/** The model's words, whichever shape its answer has. */
function modelText(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  const c = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
  if (typeof c === "string") return c;
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return JSON.stringify(out.response);
  return "";
}

function parseJsonLoose(s) {
  const t = String(s || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, dozen: 12, half: 50 };

function numbers(s) {
  return (String(s || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,(?=\d{3}\b)/g, "").replace(/,/g, "").replace(/\.0+$/, "").replace(/^0+(?=\d)/, ""));
}

function numberSet(...texts) {
  const set = new Set();
  for (const t of texts) {
    for (const n of numbers(t)) set.add(n);
    for (const w of String(t || "").toLowerCase().match(/[a-z]+/g) || []) if (NUM_WORDS[w] != null) set.add(String(NUM_WORDS[w]));
  }
  return set;
}

function tidy(s, max) {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  t = t.replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1 to $2").replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\*\*|__|`/g, "");
  if (max && t.length > max) {
    const cut = t.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    t = (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "...");
  }
  return t;
}

/** Sentences, split after a full stop that is followed by a space and a capital or a number, so
 *  "$4.30" or "St. Marys" stay in one piece. */
function sentences(s) {
  return String(s || "").split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9$])/).map((x) => x.trim()).filter(Boolean);
}

/**
 * The model's answer, checked against the text it was given. A line with a number the text
 * doesn't have is dropped (a sentence of the summary, a key fact, or the YOLKO line).
 */
function checkBrief(raw, story, art) {
  const j = raw && typeof raw === "object" ? raw : parseJsonLoose(raw);
  if (!j || typeof j !== "object") return { ok: false, error: "The summary came back unreadable" };
  const known = numberSet(art.text, story.title, art.title, story.at ? new Date(story.at).toISOString().slice(0, 10) : "", story.at ? new Date(story.at).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric" }) : "");
  const fits = (s) => numbers(s).every((n) => known.has(n));
  let dropped = 0;
  const keepIf = (s) => { if (fits(s)) return true; dropped++; return false; };
  const summary = tidy(sentences(tidy(j.summary)).filter(keepIf).join(" "), 600);
  // A key fact that only repeats the summary is left out.
  const sumWords = new Set(words(summary));
  const repeats = (p) => { const w = [...new Set(words(p))]; return w.length > 0 && w.filter((x) => sumWords.has(x)).length / w.length >= 0.85; };
  const points = (Array.isArray(j.points) ? j.points : []).map((p) => tidy(p, 240)).filter((p) => p.length > 3).filter(keepIf).filter((p) => !summary || !repeats(p)).slice(0, 5);
  let forUs = tidy(j.forUs || "", 300);
  if (forUs && !keepIf(forUs)) forUs = "";
  if (/^(none|n\/a|nothing|empty)\.?$/i.test(forUs)) forUs = "";
  if (!summary && !points.length) return { ok: false, error: "The summary didn't match the article", dropped };
  return { ok: true, summary: summary || points[0], points: summary ? points : points.slice(1), forUs, onTopic: j.onTopic !== false, dropped };
}

function estimateNeurons(model, messages, outText, usage) {
  if (usage && Number.isFinite(usage.neurons)) return Math.ceil(usage.neurons);
  const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.2);
  const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? Math.ceil(String(outText || "").length / 3.2) + 50;
  return Math.ceil((inTok * model.inN + outTok * model.outN) / 1e6);
}

/** Ask the models in turn. Returns { ok, brief, model, neurons } or { ok: false, error, neurons }. */
async function summarise(env, story, art, budget) {
  if (!env.AI || typeof env.AI.run !== "function") return { ok: false, error: "Workers AI isn't connected", neurons: 0, stop: true };
  const messages = briefMessages(story, art);
  let neurons = 0;
  let lastError = "";
  for (const model of MODELS) {
    if (budget.skip && budget.skip[model.id] && Date.parse(budget.skip[model.id]) > Date.now()) continue;
    // Never start a call that could take the day past the cap.
    if (budget.used + neurons + estimateNeurons(model, messages, "x".repeat(1400)) > DAILY_NEURONS) return { ok: false, error: "Today's free summaries are used up. More tomorrow", neurons, stop: true };
    let out;
    try {
      out = await env.AI.run(model.id, { messages, max_tokens: 700, temperature: 0.1, ...model.opts });
    } catch (err) {
      lastError = String(err?.message || err).slice(0, 160);
      // A model this account can't use (a paid one on the free plan, or one Cloudflare retired)
      // is left alone for a day.
      if (/paid|plan|not found|no such model|unknown model|deprecated|5016|5007|1031|3036/i.test(lastError)) budget.skip = { ...(budget.skip || {}), [model.id]: new Date(Date.now() + 864e5).toISOString() };
      continue;
    }
    const text = modelText(out);
    neurons += estimateNeurons(model, messages, text, out && out.usage);
    const checked = checkBrief(text, story, art);
    if (checked.ok) return { ok: true, brief: checked, model: model.id, neurons };
    lastError = checked.error;
  }
  return { ok: false, error: lastError || "No model answered", neurons };
}

/* ------------------------------ fetching ------------------------------ */

async function getPage(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA_BROWSER, Accept: accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: "The article's site answered HTTP " + res.status };
    const body = await res.text();
    return { ok: true, body: body.length > 4_000_000 ? body.slice(0, 4_000_000) : body, url: res.url || url };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "The article's site didn't answer in 15 seconds" : String(err?.message || err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* ------------------------------ storage ------------------------------ */

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function getBriefs(env) {
  const raw = await env.DATA.get(BRIEFS_KEY, "json");
  const s = raw && typeof raw === "object" ? raw : {};
  const day = utcDay();
  return { v: 1, items: {}, ...s, day, used: s.day === day ? s.used || 0 : 0, skip: s.skip || {} };
}

async function saveBriefs(env, briefs, liveIds) {
  if (liveIds) for (const id of Object.keys(briefs.items)) if (!liveIds.has(id)) delete briefs.items[id];
  await env.DATA.put(BRIEFS_KEY, JSON.stringify(briefs));
}

/** What the admin gets for a story: never the stored article text. */
function publicBrief(b) {
  if (!b) return null;
  if (b.summary) return { summary: b.summary, points: b.points || [], forUs: b.forUs || "", from: b.from, src: b.src || null, onTopic: b.onTopic !== false, at: b.at };
  if (b.failed) return { failed: true, error: b.error || "", src: b.src || null };
  return { pending: true, src: b.src || null };
}

/** The news view with each story's summary on it. */
function attachBriefs(view, briefs) {
  const map = briefs?.items || {};
  return { ...view, items: (view.items || []).map((s) => (map[s.id] ? { ...s, brief: publicBrief(map[s.id]) } : s)) };
}

/* ------------------------------ the work ------------------------------ */

function inWindow(story, now = Date.now()) {
  return now - Date.parse(story.at) <= BRIEF_DAYS * 864e5;
}

/** Whether a story still wants a summary now. */
function wants(story, b, now = Date.now()) {
  // The outlet's own copy of a story replaced the Google News one: read it afresh.
  if (b && !b.summary && b.forUrl && b.forUrl !== story.url) return true;
  if (b && (b.summary || b.failed)) return false;
  if (b && b.next && Date.parse(b.next) > now) return false;
  return true;
}

const NO_GOOGLE_LINK = "Google News hides this story's own link, and its outlet's site didn't list it";

/** Read the story's source and write its summary. Returns the new record for the story.
 *  `budget` is the briefs store: its `used` neurons and model `skip` list are updated here, and
 *  `reads` counts pages read (the caller's limit). */
async function briefOne(env, story, prev, budget) {
  const now = new Date();
  const base = { ...(prev || {}), tries: (prev?.tries || 0) + 1 };
  delete base.next;
  // The NSW page: the story was made from its "Latest advice" text, which is the summary.
  if (story.kind === "official") {
    const text = story.detail || story.summary || "";
    return { src: story.url, from: "page", summary: tidy(text, 600), points: [], forUs: "", onTopic: true, at: now.toISOString(), model: null };
  }
  const read = (u, accept) => { budget.reads = (budget.reads || 0) + 1; return getPage(u, accept); };
  let src = (prev && prev.src) || (isGoogleNews(story.url) ? "" : story.url);
  let robots = null;
  if (!src) {
    // A Google News story: look for the same headline on the outlet's own site, while it's new
    // enough to be in the outlet's lists.
    if (!story.site || Date.now() - Date.parse(story.seen || story.at) > SITE_LOOK_DAYS * 864e5) return { failed: true, error: NO_GOOGLE_LINK, tries: base.tries, at: now.toISOString() };
    const found = await findOnSite(story.site, story.title, (u, o) => { budget.reads = (budget.reads || 0) + 1; return fetch(u, o); });
    if (!found.url) return fail(base, "", found.error === "No outlet site" ? NO_GOOGLE_LINK : found.error || NO_GOOGLE_LINK);
    src = found.url;
    robots = found.robots;
  }
  let art = null;
  if (prev && prev.text && prev.from) {
    art = { text: prev.text, from: prev.from, title: prev.title || "", site: "" };
  } else if (story.kind === "reddit") {
    const feedUrl = story.url.replace(/[?#].*$/, "").replace(/\/?$/, "/") + ".rss";
    const got = await read(feedUrl, "application/atom+xml, application/xml;q=0.9, */*;q=0.5");
    if (got.ok) {
      const t = redditThread(got.body, story.title);
      if (t.from) art = { text: t.text, from: "thread", title: story.title, site: "Reddit" };
    }
    if (!art && (story.detail || story.summary)) art = { text: "Post: " + story.title + "\n\n" + (story.detail || story.summary), from: "thread", title: story.title, site: "Reddit" };
    if (!art) return fail(base, src, got.error || "Couldn't read the Reddit post");
  } else {
    if (!robots) robots = await robotsFor(budget, src);
    if (!robotsAllows(robots, src)) return { src, failed: true, error: "The outlet asks readers to leave that page alone", tries: base.tries, at: now.toISOString() };
    const got = await read(src);
    if (!got.ok) return fail(base, src, got.error);
    const x = extractArticle(got.body, got.url);
    if (!x.from) return fail(base, src, "The page had no article text to read");
    art = x;
  }
  const r = await summarise(env, story, art, budget);
  budget.used += r.neurons || 0;
  if (!r.ok) {
    // Out of today's allowance or no model bound: try again later without counting it against
    // the story. The article text is kept, so the next try doesn't read the page again.
    const keep = { ...base, src, text: art.text, from: art.from, title: art.title, error: r.error };
    if (r.stop) return { ...keep, tries: prev?.tries || 0, next: new Date(Date.now() + 3600 * 1000).toISOString() };
    return fail(keep, src, r.error);
  }
  return {
    src,
    host: hostOf(src),
    from: art.from,
    summary: r.brief.summary,
    points: r.brief.points,
    forUs: r.brief.forUs,
    onTopic: r.brief.onTopic,
    dropped: r.brief.dropped || 0,
    model: r.model,
    at: now.toISOString(),
  };
}

/** An outlet's robots.txt rules for every reader, kept a week in the briefs store. */
async function robotsFor(budget, url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  const host = new URL(origin).hostname;
  budget.robots = budget.robots || {};
  const kept = budget.robots[host];
  if (kept && Date.now() - Date.parse(kept.at) < 7 * 864e5) return kept.r;
  budget.reads = (budget.reads || 0) + 1;
  const got = await getPage(origin + "/robots.txt", "text/plain");
  const r = got.ok ? robotsRules(got.body).slice(0, 200) : [];
  budget.robots[host] = { r, at: new Date().toISOString() };
  // Keep the list short: the 60 hosts read most recently.
  const hosts = Object.keys(budget.robots);
  if (hosts.length > 60) hosts.sort((a, b) => (budget.robots[a].at < budget.robots[b].at ? -1 : 1)).slice(0, hosts.length - 60).forEach((h) => delete budget.robots[h]);
  return r;
}

function fail(base, src, error) {
  const tries = base.tries || 1;
  if (tries >= MAX_TRIES) return { src, failed: true, error, tries, at: new Date().toISOString() };
  return { ...base, src, error, next: new Date(Date.now() + RETRY_MS * tries).toISOString() };
}

/**
 * Write summaries for the newest stories that don't have one: a few each cron tick, or one story
 * now (`onlyId`, when the owner opens it). `items` is the news list, newest first.
 */
async function runBriefs(env, items, { max = PER_TICK, onlyId = null, reads = READS_PER_TICK } = {}) {
  const briefs = await getBriefs(env);
  const now = Date.now();
  const live = new Set(items.map((s) => s.id));
  const todo = items.filter((s) => (onlyId ? s.id === onlyId : inWindow(s, now)) && wants(s, briefs.items[s.id], now)).slice(0, max);
  briefs.reads = 0;
  let changed = false, done = 0;
  for (const s of todo) {
    if (briefs.used >= DAILY_NEURONS - 200 || briefs.reads >= reads) break;
    let prev = briefs.items[s.id];
    if (prev && !prev.summary && prev.forUrl && prev.forUrl !== s.url) prev = null;
    briefs.items[s.id] = { ...(await briefOne(env, s, prev, briefs)), forUrl: s.url };
    changed = true;
    if (briefs.items[s.id].summary) done++;
  }
  delete briefs.reads;
  // Stories that dropped off the news list take their summaries with them.
  for (const id of Object.keys(briefs.items)) if (!live.has(id)) { delete briefs.items[id]; changed = true; }
  if (changed) await saveBriefs(env, briefs);
  return { done, tried: todo.length, used: briefs.used, briefs };
}

/** The owner opened a story: its summary now, written first if need be. */
async function briefNow(env, items, id) {
  const story = items.find((s) => s.id === id);
  if (!story) return { error: "That story is gone" };
  const r = await runBriefs(env, items, { onlyId: id, max: 1, reads: 10 });
  const b = r.briefs.items[id];
  if (b && b.next && !b.summary && !b.failed) return { brief: { pending: true, error: b.error || "", src: b.src || null, next: b.next } };
  return { brief: publicBrief(b) };
}

export {
  BRIEFS_KEY,
  MODELS,
  DAILY_NEURONS,
  extractArticle,
  paragraphs,
  redditThread,
  isGoogleNews,
  findOnSite,
  titleMatch,
  listEntries,
  robotsRules,
  robotsAllows,
  briefMessages,
  modelText,
  checkBrief,
  summarise,
  getBriefs,
  attachBriefs,
  publicBrief,
  runBriefs,
  briefNow,
  briefOne,
};
