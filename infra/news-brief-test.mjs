// Checks the Admin > News summaries on small copies of real page shapes: node infra/news-brief-test.mjs
import assert from "node:assert/strict";
import {
  extractArticle,
  checkBrief,
  titleMatch,
  listEntries,
  robotsRules,
  robotsAllows,
  findOnSite,
  summarise,
  runBriefs,
  briefNow,
  attachBriefs,
  getBriefs,
  modelText,
  briefMessages,
  BRIEFS_KEY,
  DAILY_NEURONS,
} from "./news-brief.mjs";
import { parseFeed, storyOf, SOURCES } from "./news-feed.mjs";

const now = new Date().toISOString();
const para = (n, words) => Array.from({ length: n }, (_, i) => `<p>${words} sentence number ${i + 1} about free-range hens and egg farmers in South Australia.</p>`).join("\n");

/* ---------- reading an article ---------- */

// An ABC-like page: a picture caption, the story, then a footer and a far-off related list.
{
  const html = `<html><head><meta property="og:title" content="Free-range hens set free again as bird flu spread slows in SA">
  <meta property="og:description" content="Egg farmers rethink housing their free-range hens as H5N1 eases."></head><body>
  <nav><p>Home News Sport Weather and a long menu line that goes on and on</p></nav>
  <figure><img src="x"><figcaption><p>H5N1 bird flu has not yet spread into Australia's poultry sector. (ABC Rural: Georgia)</p></figcaption></figure>
  <div>${para(8, "Free-range hens egg farmers bird flu SA")}</div>
  <p>SA's chief veterinarian said the state had recorded 342 bird flu cases as of Monday.</p>
  ${" ".repeat(9000)}
  <div><p>Related: Funerals and Memorial Services topic page with nothing about the story here.</p></div>
  <footer><p>This service may include material from Agence France-Presse (AFP), APTN, Reuters, AAP.</p></footer>
  </body></html>`;
  const a = extractArticle(html, "https://www.abc.net.au/news/x");
  assert.equal(a.from, "article");
  assert.equal(a.title, "Free-range hens set free again as bird flu spread slows in SA");
  assert.match(a.text, /342 bird flu cases/);
  assert.doesNotMatch(a.text, /ABC Rural: Georgia/, "picture captions are left out");
  assert.doesNotMatch(a.text, /Funerals|Agence France|long menu/, "menus, footers and far-off lists are left out");
}

// JSON-LD articleBody wins when a page builds its paragraphs with JavaScript.
{
  const body = "Egg prices rose 12 per cent in October as bird flu kept supply tight across New South Wales. ".repeat(8);
  const html = `<html><head><title>Egg prices rise 12 per cent - The Outlet</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "NewsArticle", articleBody: body }] })}</script></head><body><div id="app"></div></body></html>`;
  const a = extractArticle(html);
  assert.equal(a.from, "article");
  assert.equal(a.title, "Egg prices rise 12 per cent", "the outlet's name comes off the title");
  assert.match(a.text, /12 per cent in October/);
}

// A paywall (MLex): its sales pitch is not the story; only the opening (the description) is.
{
  const html = `<html><head><meta property="og:title" content="File clearer pleadings in Sunny Queen egg cartel case, Australian watchdog told | MLex | Specialist news and analysis on legal risk and regulation">
  <meta property="og:description" content="Australia’s competition regulator should set out its allegations more clearly in its cartel case against egg supplier Sunny Queen and 11 other respondents, a judge said."></head><body>
  <p>MLex identifies risk to business wherever it emerges, with specialist reporters across the globe providing exclusive news and deep-dive analysis.</p>
  <p>Know what others in the room don’t, with features including:</p>
  <ul><li>Daily newsletters for Antitrust, M&amp;A, Trade, Data Privacy &amp; Security, Technology, AI and more</li>
  <li>Curated case files bringing together news, analysis and source documents in a single timeline</li></ul>
  <p>Experience MLex today with a 14-day free trial.</p><p>Already a subscriber? Click here to login</p></body></html>`;
  const a = extractArticle(html);
  assert.equal(a.title, "File clearer pleadings in Sunny Queen egg cartel case, Australian watchdog told");
  assert.equal(a.from, "opening");
  assert.equal(a.paywall, true);
  assert.match(a.text, /^Australia’s competition regulator/);
  assert.doesNotMatch(a.text, /MLex identifies|free trial|newsletters/);
}

// A page with no story text at all gives nothing to summarise.
assert.equal(extractArticle("<html><body><div id=app></div></body></html>").from, null);

/* ---------- the model's answer, checked against the article ---------- */

const story = { id: "s1", title: "Egg prices could hit $7.50 if bird flu reaches farms", source: "Yahoo", at: "2026-11-19T01:00:00Z" };
const art = { from: "article", title: story.title, text: "A $4.30 carton of eggs could cost $7.50 if bird flu hits Australia's poultry farms, EY says. Three states have had cases. Prices rose 47 per cent in 2024. About 1,200 farms supply the market." };
{
  const raw = "```json\n" + JSON.stringify({
    summary: "EY says a $4.30 carton could cost $7.50 if bird flu reaches poultry farms. Prices would rise by 80 per cent overnight.",
    points: ["Prices rose 47 per cent in 2024.", "About 1,200 farms supply the market.", "Three states have had cases.", "There are 9 million hens at risk.", "A $4.30 carton could cost $7.50 if bird flu reaches farms."],
    forUs: "Stock up before the 2027 peak.",
    onTopic: true,
  }) + "\n```";
  const b = checkBrief(raw, story, art);
  assert.equal(b.ok, true);
  assert.equal(b.summary, "EY says a $4.30 carton could cost $7.50 if bird flu reaches poultry farms.", "a sentence with a number the article lacks goes");
  assert.deepEqual(b.points, ["Prices rose 47 per cent in 2024.", "About 1,200 farms supply the market.", "Three states have had cases."], "made-up numbers and repeats of the summary go");
  assert.equal(b.forUs, "", "the YOLKO line goes when its number isn't in the article");
  assert.equal(b.dropped, 3);
}
{
  // Number words in the article back digits in the summary; long dashes become plain words.
  const b = checkBrief({ summary: "Cases were found in 3 states — NSW, Victoria and SA.", points: [], forUs: "", onTopic: false }, story, art);
  assert.equal(b.summary, "Cases were found in 3 states, NSW, Victoria and SA.");
  assert.equal(b.onTopic, false);
}
assert.equal(checkBrief("not json at all", story, art).ok, false);
assert.equal(checkBrief({ summary: "There are 9 million hens.", points: [] }, story, art).ok, false, "nothing left after the check is no summary");
// The prompt carries the article and says what kind of text it is.
{
  const m = briefMessages(story, { ...art, from: "opening" });
  assert.equal(m[0].role, "system");
  assert.match(m[1].content, /Only the article's opening lines/);
  assert.match(m[1].content, /\$4\.30 carton/);
  assert.match(m[1].content, /Usually none/);
}
assert.equal(modelText({ choices: [{ message: { content: "{}" } }] }), "{}");
assert.equal(modelText({ response: { a: 1 } }), '{"a":1}');

/* ---------- finding a Google News story on its outlet's own site ---------- */

assert.ok(titleMatch("Chicken run: Australia police charge woman after poultry heist", "Chicken run: Australia police charge woman after poultry heist - The Straits Times") > 0.95);
assert.ok(titleMatch("Egg prices ease into holidays", "Bird flu found in Victoria") < 0.2);
{
  const news = `<urlset><url><loc>https://outlet.com.au/story/1/eggs/</loc><news:news><news:title>Egg prices to soar as bird flu spreads</news:title></news:news></url></urlset>`;
  assert.deepEqual(listEntries(news).urls, [{ url: "https://outlet.com.au/story/1/eggs/", title: "Egg prices to soar as bird flu spreads" }]);
  const index = `<sitemapindex><sitemap><loc>https://o.com/a.xml</loc><lastmod>2026-11-01</lastmod></sitemap><sitemap><loc>https://o.com/b.xml</loc><lastmod>2026-11-25</lastmod></sitemap></sitemapindex>`;
  assert.deepEqual(listEntries(index).maps.map((m) => m.loc), ["https://o.com/a.xml", "https://o.com/b.xml"]);
}
{
  const rules = robotsRules("User-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nUser-agent: Other\nDisallow: /account/login\nDisallow: /*/subscribe\n\nUser-agent: GPTBot\nDisallow: /\n");
  assert.deepEqual(rules, ["/account/login", "/*/subscribe"]);
  assert.equal(robotsAllows(rules, "https://www.mlex.com/mlex/antitrust/articles/2552681"), true);
  assert.equal(robotsAllows(rules, "https://x.com/a/subscribe?x=1"), false);
}

function fakeFetch(pages) {
  const calls = [];
  const fn = async (u) => {
    calls.push(u);
    const body = pages[u];
    return { ok: body != null, status: body != null ? 200 : 404, url: u, text: async () => body ?? "" };
  };
  fn.calls = calls;
  return fn;
}
{
  const f = fakeFetch({
    "https://outlet.com.au/robots.txt": "User-agent: *\nDisallow: /private/\nSitemap: https://outlet.com.au/sitemap-news.xml\nSitemap: https://outlet.com.au/sitemap.xml",
    "https://outlet.com.au/sitemap-news.xml": `<urlset><url><loc>https://outlet.com.au/story/9/egg-prices/</loc><news:title>Egg prices to soar as bird flu spreads</news:title></url></urlset>`,
  });
  const r = await findOnSite("https://outlet.com.au", "Egg prices to soar as bird flu spreads", f);
  assert.equal(r.url, "https://outlet.com.au/story/9/egg-prices/");
  assert.ok(f.calls.length <= 3, "a good match in the news sitemap stops the search");
}
{
  // Found only by the link's words, in the home page's own feed.
  const f = fakeFetch({
    "https://blog.com.au/robots.txt": "User-agent: *\nDisallow:",
    "https://blog.com.au/": `<html><head><link rel="alternate" type="application/rss+xml" href="/news.xml"></head></html>`,
    "https://blog.com.au/news.xml": `<rss><channel><item><title></title><link>https://blog.com.au/2026/11/meliora-launches-mung-bean-egg-at-coles/</link></item></channel></rss>`,
  });
  const r = await findOnSite("https://blog.com.au", "Meliora launches mung bean egg at Coles", f);
  assert.equal(r.url, "https://blog.com.au/2026/11/meliora-launches-mung-bean-egg-at-coles/");
}
{
  const f = fakeFetch({
    "https://shy.com/robots.txt": "User-agent: *\nDisallow: /news/",
    "https://shy.com/sitemap-news.xml": "",
    "https://shy.com/": `<link rel="alternate" type="application/rss+xml" href="https://shy.com/feed">`,
    "https://shy.com/feed": `<rss><item><title>Egg cartel case back in court</title><link>https://shy.com/news/egg-cartel</link></item></rss>`,
  });
  const r = await findOnSite("https://shy.com", "Egg cartel case back in court", f);
  assert.equal(r.url, undefined);
  assert.match(r.error, /leave that page alone/);
}
{
  // An older story has left the feed: the site's own search feed finds it.
  const f = fakeFetch({
    "https://wp.com.au/robots.txt": "User-agent: *\nDisallow: /wp-admin/",
    "https://wp.com.au/feed/": `<rss><item><title>Something newer</title><link>https://wp.com.au/newer/</link></item></rss>`,
    "https://wp.com.au/?s=australia%20conduct%20largest%20wild%20bird&feed=rss2": `<rss><channel><title>Search Results</title><item><title>Australia to Conduct Largest Wild-Bird Vaccination Experiment Ever Attempted</title><link>https://wp.com.au/australia-to-conduct-largest-wild-bird-vaccination-experiment/</link></item></channel></rss>`,
  });
  const r = await findOnSite("https://wp.com.au", "Australia to Conduct Largest Wild-Bird Vaccination Experiment Ever Attempted", f);
  assert.equal(r.url, "https://wp.com.au/australia-to-conduct-largest-wild-bird-vaccination-experiment/");
  assert.ok(f.calls.length <= 8, "the search is one read on top of the lists");
}
{
  // A site that asks readers to keep out of its search is not searched.
  const f = fakeFetch({ "https://nosearch.com/robots.txt": "User-agent: *\nDisallow: /?s=" });
  const r = await findOnSite("https://nosearch.com", "Egg cartel case back in court", f);
  assert.equal(r.url, undefined);
  assert.ok(!f.calls.some((u) => u.includes("?s=")));
}

/* ---------- the models: one that fails hands over to the next ---------- */
{
  const tried = [];
  const env = {
    AI: {
      run: async (model) => {
        tried.push(model);
        if (model.includes("deepseek")) throw new Error("AiError: 5016: This model requires the Workers Paid plan");
        return { choices: [{ message: { content: JSON.stringify({ summary: "EY says a $4.30 carton could cost $7.50.", points: ["Three states have had cases."], forUs: "", onTopic: true }) } }], usage: { neurons: 17.2 } };
      },
    },
  };
  const budget = { used: 0, skip: {} };
  const r = await summarise(env, story, art, budget);
  assert.equal(r.ok, true);
  assert.match(r.model, /gemma/);
  assert.equal(r.neurons, 18);
  assert.ok(budget.skip["@cf/deepseek-ai/deepseek-v4.1-flash-1017"], "a model the plan can't use is left alone for a day");
  const again = await summarise(env, story, art, budget);
  assert.equal(again.ok, true);
  assert.equal(tried.filter((m) => m.includes("deepseek")).length, 1);
  // A day that has used its free allowance stops before calling a model.
  const full = await summarise(env, story, art, { used: DAILY_NEURONS - 10, skip: {} });
  assert.equal(full.ok, false);
  assert.equal(full.stop, true);
  assert.equal((await summarise({}, story, art, { used: 0 })).stop, true, "no AI binding: nothing to call");
}

/* ---------- the cron run and what the admin gets ---------- */

function kv() {
  const m = new Map();
  return { get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, m };
}
const articlePage = (title, text) => `<html><head><meta property="og:title" content="${title}"></head><body>${text.split(". ").map((t) => "<p>" + t + ".</p>").join("")}</body></html>`;
{
  const env = {
    DATA: kv(),
    AI: { run: async (_m, { messages }) => ({ choices: [{ message: { content: JSON.stringify({ summary: messages[1].content.includes("Sunny Queen") ? "Sunny Queen and 11 other companies face a cartel case." : "Egg prices rose 47 per cent in 2024.", points: [], forUs: "", onTopic: true }) } }], usage: { neurons: 60 } }) },
  };
  const longText = "Egg prices rose 47 per cent in 2024 as bird flu hit farms in Victoria. Free-range cartons doubled in price at Coles and Woolworths. ".repeat(6);
  const cartel = "The ACCC says Sunny Queen and 11 other companies coordinated egg supply since 2020. Sunny Queen denies the claims and will defend the case in the Federal Court. ".repeat(5);
  const pages = {
    "https://www.abc.net.au/news/eggs": articlePage("Egg prices rose 47 per cent in 2024", longText),
    "https://www.abc.net.au/robots.txt": "User-agent: *\nDisallow: /search",
    "https://outlet.com.au/robots.txt": "Sitemap: https://outlet.com.au/news-sitemap.xml",
    "https://outlet.com.au/news-sitemap.xml": `<urlset><url><loc>https://outlet.com.au/story/sunny-queen</loc><news:title>Sunny Queen cartel case back in court</news:title></url></urlset>`,
    "https://outlet.com.au/story/sunny-queen": articlePage("Sunny Queen cartel case back in court", cartel),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(pages);
  try {
    const items = [
      { id: "a", title: "Egg prices rose 47 per cent in 2024", url: "https://www.abc.net.au/news/eggs", source: "ABC News", kind: "news", at: now, seen: now, summary: "" },
      { id: "g", title: "Sunny Queen cartel case back in court", url: "https://news.google.com/rss/articles/CBMiAAA?oc=5", site: "https://outlet.com.au", source: "The Outlet", kind: "news", at: now, seen: now, summary: "" },
      { id: "n", title: "NSW bird flu: 86 cases", url: "https://www.nsw.gov.au/bird-flu", source: "NSW Government", kind: "official", at: now, seen: now, summary: "NSW has recorded 86 H5...", detail: "NSW has recorded 86 H5 bird flu events. No farms are affected." },
      { id: "x", title: "Old Google story", url: "https://news.google.com/rss/articles/CBMiBBB?oc=5", source: "Somewhere", kind: "news", at: now, seen: now, summary: "" },
      { id: "old", title: "A month-old story", url: "https://www.abc.net.au/news/old", source: "ABC News", kind: "news", at: new Date(Date.now() - 40 * 864e5).toISOString(), seen: now, summary: "" },
    ];
    const r = await runBriefs(env, items, { max: 10 });
    const b = (await getBriefs(env)).items;
    assert.equal(b.a.summary, "Egg prices rose 47 per cent in 2024.");
    assert.equal(b.a.from, "article");
    assert.equal(b.g.src, "https://outlet.com.au/story/sunny-queen", "a Google News story is read from its outlet's own page");
    assert.match(b.g.summary, /Sunny Queen/);
    assert.equal(b.n.summary, "NSW has recorded 86 H5 bird flu events. No farms are affected.", "the NSW page's own words, no model");
    assert.equal(b.x.failed, true, "a Google story with no outlet site can't be read");
    assert.equal(b.old, undefined, "month-old stories are left alone");
    assert.equal(r.used, 120);

    // What the admin gets: no stored article text, and a summary on each story.
    const view = attachBriefs({ items }, await getBriefs(env));
    const g = view.items.find((s) => s.id === "g");
    assert.equal(g.brief.src, "https://outlet.com.au/story/sunny-queen");
    assert.equal(g.brief.text, undefined);
    assert.equal(view.items.find((s) => s.id === "x").brief.failed, true);
    assert.equal(view.items.find((s) => s.id === "old").brief, undefined);

    // The outlet's own copy replacing a Google one is read afresh.
    const swapped = items.map((s) => (s.id === "x" ? { ...s, url: "https://www.abc.net.au/news/eggs" } : s));
    await runBriefs(env, swapped);
    assert.equal((await getBriefs(env)).items.x.summary, "Egg prices rose 47 per cent in 2024.");

    // Stories gone from the list take their summaries with them.
    await runBriefs(env, items.filter((s) => s.id !== "a"));
    assert.equal((await getBriefs(env)).items.a, undefined);

    // Opening a story writes its summary right then; an unknown story says so.
    const fresh = [{ id: "z", title: "Egg prices rose 47 per cent in 2024", url: "https://www.abc.net.au/news/eggs", source: "ABC News", kind: "news", at: now, seen: now, summary: "" }];
    const now1 = await briefNow(env, fresh, "z");
    assert.equal(now1.brief.summary, "Egg prices rose 47 per cent in 2024.");
    assert.equal((await briefNow(env, fresh, "nope")).error, "That story is gone");

    // A page that can't be read is tried again later, then marked unreadable after three tries.
    const broken = [{ id: "b", title: "Broken", url: "https://www.abc.net.au/news/missing", source: "ABC News", kind: "news", at: now, seen: now, summary: "" }];
    await runBriefs(env, broken);
    let rec = (await getBriefs(env)).items.b;
    assert.equal(rec.tries, 1);
    assert.ok(Date.parse(rec.next) > Date.now());
    const store = JSON.parse(env.DATA.m.get(BRIEFS_KEY));
    store.items.b = { ...store.items.b, tries: 2, next: new Date(Date.now() - 1000).toISOString() };
    env.DATA.m.set(BRIEFS_KEY, JSON.stringify(store));
    await runBriefs(env, broken);
    rec = (await getBriefs(env)).items.b;
    assert.equal(rec.failed, true);
    assert.match(rec.error, /HTTP 404/);

    // A Google story that came in before its outlet was known is looked for once it is, with
    // its tries started afresh, and not again and again after that.
    const early = [{ id: "e", title: "Sunny Queen cartel case back in court", url: "https://news.google.com/rss/articles/CBMiEEE?oc=5", source: "The Outlet", kind: "news", at: now, seen: now, summary: "" }];
    await runBriefs(env, early);
    rec = (await getBriefs(env)).items.e;
    assert.equal(rec.failed, true);
    assert.equal(rec.noSite, true);
    const known = [{ ...early[0], site: "https://outlet.com.au" }];
    await runBriefs(env, known);
    rec = (await getBriefs(env)).items.e;
    assert.equal(rec.src, "https://outlet.com.au/story/sunny-queen");
    assert.match(rec.summary, /Sunny Queen/);
    const lost = [{ ...early[0], id: "l", title: "A story no outlet lists", site: "https://outlet.com.au" }];
    const st = JSON.parse(env.DATA.m.get(BRIEFS_KEY));
    st.items.l = { failed: true, noSite: true, error: "x", tries: 1 };
    env.DATA.m.set(BRIEFS_KEY, JSON.stringify(st));
    await runBriefs(env, lost);
    rec = (await getBriefs(env)).items.l;
    assert.equal(rec.tries, 1, "tries start afresh");
    assert.equal(rec.failed, undefined, "not given up after one look");
    assert.equal(rec.noSite, undefined);
    assert.ok(Date.parse(rec.next) > Date.now(), "and not looked for again until later");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- summaries stored by the first version ---------- */
{
  const env = { DATA: kv() };
  env.DATA.m.set(BRIEFS_KEY, JSON.stringify({ v: 1, items: { g: { failed: true, error: "Google News hides this story's own link, and its outlet's site didn't list it", tries: 1 }, h: { failed: true, error: "HTTP 404", tries: 3 }, a: { summary: "Kept." } } }));
  const b = await getBriefs(env);
  assert.equal(b.v, 2);
  assert.equal(b.items.g, undefined, "a Google story given up on is looked for again");
  assert.equal(b.items.h.failed, true);
  assert.equal(b.items.a.summary, "Kept.");
}

/* ---------- stories keep what their summary needs ---------- */
{
  const gn = `<rss><channel><item><title>Egg prices to soar - The Outlet</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 23 Nov 2026 07:00:00 GMT</pubDate><source url="https://outlet.com.au">The Outlet</source></item></channel></rss>`;
  const s = storyOf(SOURCES.find((x) => x.id === "gn-eggs"), parseFeed(gn)[0], now);
  assert.equal(s.site, "https://outlet.com.au");
  const long = "Coles in Strathfield had a 2 carton limit on eggs again this week. ".repeat(8);
  const reddit = `<feed><entry><content type="html">${long}</content><link href="https://www.reddit.com/r/sydney/comments/1abc/no_eggs/" /><published>2026-11-02T22:10:00+00:00</published><title>No eggs at Woolies again?</title></entry></feed>`;
  const r = storyOf(SOURCES.find((x) => x.id === "reddit"), parseFeed(reddit)[0], now);
  assert.ok(r.summary.length <= 220);
  assert.ok(r.detail.length > 400, "a Reddit post keeps its whole text for the summary");
}

console.log("news brief tests passed");
