// Checks the news parser on small copies of each feed shape: node infra/news-feed-test.mjs
import assert from "node:assert/strict";
import { parseFeed, parseNswPage, keep, storyOf, mergeStories, SOURCES, isGithubRelay, takeNewsRelay } from "./news-feed.mjs";

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

// General outlets keep Australian egg stories only.
assert.equal(keep(src("7news"), { title: "Egg prices jump again at Coles", url: "https://7news.com.au/a" }), true);
assert.equal(keep(src("7news"), { title: "US egg prices hit a record as bird flu spreads", url: "https://7news.com.au/b" }), false);
assert.equal(keep(src("7news"), { title: "Bird flu in the US: what it means for Australian eggs", url: "https://7news.com.au/c" }), true);
assert.equal(keep(src("smh"), { title: "Let us talk about the budget", url: "https://smh.com.au/d" }), false);

// The GitHub relay: a bad or missing token is refused; posted feeds are stored like the Worker's own reads.
const fakeReq = (auth) => ({ headers: { get: (k) => (k === "Authorization" ? auth : null) } });
assert.equal(await isGithubRelay(fakeReq(null)), false);
assert.equal(await isGithubRelay(fakeReq("Bearer abc.def.ghi")), false);

{
  // A real RS256 token, signed with a throwaway key, against a stubbed GitHub key list.
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.publicKey);
  const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sign = async (claims) => {
    const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
    const body = b64u(JSON.stringify(claims));
    const sig = await subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head + "." + body));
    return "Bearer " + head + "." + body + "." + b64u(sig);
  };
  const t = Math.floor(Date.now() / 1000);
  const good = { iss: "https://token.actions.githubusercontent.com", aud: "https://getyolko.com", repository: "LitKanna/getyolko", ref: "refs/heads/main", job_workflow_ref: "LitKanna/getyolko/.github/workflows/news-relay.yml@refs/heads/main", iat: t - 10, exp: t + 300 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }), { status: 200 });
  try {
    assert.equal(await isGithubRelay(fakeReq(await sign(good))), true);
    assert.equal(await isGithubRelay(fakeReq(await sign({ ...good, repository: "someone/fork" }))), false);
    assert.equal(await isGithubRelay(fakeReq(await sign({ ...good, ref: "refs/heads/feature" }))), false);
    assert.equal(await isGithubRelay(fakeReq(await sign({ ...good, exp: t - 5 }))), false);
    const forged = (await sign(good)).replace(/\.[\w-]+$/, ".AAAA");
    assert.equal(await isGithubRelay(fakeReq(forged)), false);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const kv = new Map();
  const env = { DATA: { get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  const out = await takeNewsRelay(env, { feeds: [{ id: "gn-eggs", body: gn }, { id: "gn-birdflu", error: "HTTP 503" }, { id: "abc-eggs", body: gn }] });
  assert.equal(out.ok, true);
  assert.equal(out.read, 2); // abc-eggs isn't relayed, so it is ignored
  const store = JSON.parse(kv.get("news:v1"));
  assert.equal(store.items.length, 1);
  assert.equal(store.sources["gn-eggs"].ok, true);
  assert.ok(store.sources["gn-eggs"].relayAt);
  assert.equal(store.sources["gn-birdflu"].ok, false);
  assert.equal((await takeNewsRelay(env, { feeds: [] })).error, "No relayed feeds in that");
}

console.log("news feed tests passed");
