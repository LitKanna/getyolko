// Checks the news parser on small copies of each feed shape: node infra/news-feed-test.mjs
import assert from "node:assert/strict";
import { parseFeed, parseNswPage, keep, storyOf, mergeStories, SOURCES } from "./news-feed.mjs";

const now = new Date().toISOString();
const src = (id) => SOURCES.find((s) => s.id === id);

// Google News: the outlet comes off the end of the headline and the summary is dropped.
const gn = `<rss><channel><item><title>ACCC takes egg &#39;cartel&#39; to court - ABC News &amp; Headlines – Australian Broadcasting Corporation</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 12 Oct 2026 07:00:00 GMT</pubDate><description>&lt;a href="x"&gt;ACCC takes egg 'cartel' to court&lt;/a&gt;</description><source url="https://www.abc.net.au">ABC News &amp; Headlines – Australian Broadcasting Corporation</source></item></channel></rss>`;
const [g] = parseFeed(gn).map((r) => storyOf(src("gn-eggs"), r, now));
assert.equal(g.title, "ACCC takes egg 'cartel' to court");
assert.equal(g.source, "ABC News");
assert.equal(g.summary, "");
assert.deepEqual(g.topics, ["prices"]);

// Reddit (Atom): egg posts stay, "nest egg" money posts go, the sub becomes the outlet.
const reddit = `<feed><entry><category term="sydney" label="r/sydney"/><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Coles limit 2 per person&lt;/p&gt;&lt;/div&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;u&quot;&gt; /u/a &lt;/a&gt; &lt;span&gt;&lt;a href=&quot;l&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;c&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><link href="https://www.reddit.com/r/sydney/comments/1abc/no_eggs/" /><published>2026-11-02T22:10:00+00:00</published><title>No eggs at Woolies Strathfield again?</title></entry>
<entry><link href="https://www.reddit.com/r/AusFinance/comments/2/nest/" /><updated>2026-11-02T20:00:00+00:00</updated><title>Is a $200k nest egg enough at 40?</title></entry></feed>`;
const rows = parseFeed(reddit);
assert.equal(rows.filter((r) => keep(src("reddit"), r)).length, 1);
const r = storyOf(src("reddit"), rows[0], now);
assert.equal(r.source, "r/sydney");
assert.equal(r.kind, "reddit");
assert.equal(r.summary, "Coles limit 2 per person");
assert.deepEqual(r.topics, ["prices"]);

// Google Alerts (Atom): the link comes out of google.com/url, bold tags go.
const alerts = `<feed><title>Google Alert - eggs australia</title><entry><title type="html">Free range &lt;b&gt;egg&lt;/b&gt; farmers face &amp;#39;housing shock&amp;#39;</title><link href="https://www.google.com/url?rct=j&amp;sa=t&amp;url=https://www.farmonline.com.au/story/123/&amp;ct=ga"/><published>2026-11-03T07:00:00Z</published></entry></feed>`;
const a = storyOf({ id: "feed:x", name: "Google Alert", group: "Added feeds", kind: "rss", custom: true }, parseFeed(alerts)[0], now);
assert.equal(a.title, "Free range egg farmers face 'housing shock'");
assert.equal(a.url, "https://www.farmonline.com.au/story/123/");
assert.equal(a.source, "farmonline.com.au");

// Capitals are turned into sentence case, acronyms kept.
const efa = parseFeed(`<rss><item><title>IS IT BIRD FLU OR HPIA?</title><link>https://eggfarmersaustralia.org/x/</link><pubDate>Tue, 28 Jul 2026 01:34:45 +0000</pubDate></item></rss>`);
assert.equal(storyOf(src("efa"), efa[0], now).title, "Is it bird flu or HPIA?");

// Inside FMCG keeps egg stories only.
assert.equal(keep(src("inside-fmcg"), { title: "Remedy revamps wellness shot range", url: "https://x.au" }), false);
assert.equal(keep(src("inside-fmcg"), { title: "Easter eggs land early at Coles", url: "https://x.au" }), false);
assert.equal(keep(src("inside-fmcg"), { title: "Egg farmers warn of tighter supply", url: "https://x.au" }), true);

// NSW bird flu page: the Latest advice box.
const nsw = parseNswPage(`<meta property="article:modified_time" content="2026-11-03" /><div class="nsw-callout__body"><p>&nbsp;</p><h2>Latest advice</h2><p>NSW has recorded 78 H5 bird flu events. The two new H5 bird flu events were confirmed in greater crested terns at Cambridge Gardens, Penrith and Newcastle East.</p><p>For details on event locations, go to <a href="x">Agriculture.gov.au</a></p><p>There have been no detections in commercial poultry, captive birds or livestock in NSW, and the risk to human health remains low.</p><p>If you find sick or dead birds or wildlife, including marine species:</p>`);
assert.equal(nsw.events, 78);
assert.equal(nsw.farmsClear, true);
assert.equal(nsw.latest, "greater crested terns at Cambridge Gardens, Penrith and Newcastle East");

// The same story from its own outlet replaces the Google News copy, keeping when it was first seen.
const direct = { ...g, via: "abc-eggs", url: "https://www.abc.net.au/news/x", seen: "2030-01-01T00:00:00.000Z" };
const merged = mergeStories([g], [direct]).items;
assert.equal(merged.length, 1);
assert.equal(merged[0].url, "https://www.abc.net.au/news/x");
assert.equal(merged[0].seen, g.seen);

console.log("news feed tests passed");
