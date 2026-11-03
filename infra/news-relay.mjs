// Reads the news feeds that refuse Cloudflare (Google News answers the Worker with 503) and posts
// them to the site, which parses and stores them like its own reads. Run by
// .github/workflows/news-relay.yml every 15 minutes: node infra/news-relay.mjs
//
// The Worker trusts the post because it carries GitHub's OIDC token for this workflow on main,
// so there is no shared secret to keep. Locally (no OIDC env) it only prints what it read.
import { SOURCES, isFeed } from "./news-feed.mjs";

const SITE = process.env.YOLKO_SITE || "https://getyolko.com";
const AUDIENCE = "https://getyolko.com";
const UA = "Mozilla/5.0 (compatible; YolkoNews/1.0; +https://getyolko.com)";

async function read(source) {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.5", "Accept-Language": "en-AU,en;q=0.9" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    if (!res.ok) return { id: source.id, error: "HTTP " + res.status };
    if (!isFeed(body)) return { id: source.id, error: "Not a feed" };
    return { id: source.id, body };
  } catch (err) {
    return { id: source.id, error: String(err?.message || err).slice(0, 120) };
  }
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) return null;
  const res = await fetch(url + "&audience=" + encodeURIComponent(AUDIENCE), { headers: { Authorization: "Bearer " + bearer } });
  if (!res.ok) throw new Error("GitHub OIDC token: HTTP " + res.status);
  return (await res.json()).value;
}

const feeds = await Promise.all(SOURCES.filter((s) => s.relay).map(read));
for (const f of feeds) console.log(f.id, f.error ? "failed: " + f.error : "ok, " + f.body.length + " bytes");

const token = await oidcToken();
if (!token) {
  console.log("No GitHub OIDC token here, so nothing was posted.");
  process.exit(0);
}
const res = await fetch(SITE + "/api/news/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "User-Agent": UA },
  body: JSON.stringify({ feeds }),
});
const text = await res.text();
console.log("site answered", res.status, text.slice(0, 300));
if (!res.ok) process.exit(1);
