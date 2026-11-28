// Live site check: reads getyolko.com the way a customer's browser first sees it and checks
// Kanna's fixed facts on the LIVE pages (the repo checks in shop-rules-test.mjs only see the code).
//   npm run check:live            # or: node infra/live-site-check.mjs [https://getyolko.com]
// Fetches the sitemap pages and /api/settings with plain GETs. It runs no page scripts, so it
// never sends /api/visit and is never counted as a visitor. Read only. Exit 1 if a check fails.
// Mr Yolko's daily check runs it; a failure goes in /mnt/project-files/ops/problem-log.md.

const BASE = (process.argv[2] || "https://getyolko.com").replace(/\/$/, "");
const PRIVATE_PHONE = /0433[ -]?975[ -]?055|61[ -]?433[ -]?975[ -]?055/;
const PRIVATE_PLACE = /\b2129\b|Sydney Markets|Paddy'?s Markets/i;
const PRICES = { tray1: 13, tray2: 25, box: 72 };

const fails = [];
const warns = [];
const fail = (m) => fails.push(m);
const warn = (m) => warns.push(m);

async function get(path) {
  const res = await fetch(BASE + path, { headers: { "user-agent": "yolko-live-check" }, redirect: "follow" });
  return { status: res.status, build: res.headers.get("x-yolko-build"), body: await res.text() };
}

const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");

const sitemap = await get("/sitemap.xml");
const pages = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
if (!pages.length) fail("sitemap.xml lists no pages");

const builds = new Set();
for (const path of pages) {
  let page;
  try {
    page = await get(path);
  } catch (e) {
    fail(`${path}: could not load (${e.message})`);
    continue;
  }
  if (page.status !== 200) fail(`${path}: HTTP ${page.status}`);
  if (page.build) builds.add(page.build);
  if (PRIVATE_PHONE.test(page.body)) fail(`${path}: shows Kanna's private mobile`);
  if (PRIVATE_PLACE.test(page.body)) fail(`${path}: names Kanna's private place or postcode`);
  const words = text(page.body);
  for (const m of words.matchAll(/\$\s?77\b/g)) {
    const near = words.slice(Math.max(0, m.index - 80), m.index + 80);
    if (!/deliver/i.test(near)) fail(`${path}: "$77" without delivery beside it (the box is $72)`);
  }
  if (/\bSunday delivery|deliver(?:y|ies)? on Sundays?\b/i.test(words)) fail(`${path}: mentions Sunday delivery`);
}

const home = await get("/");
const homeWords = text(home.body);
for (const p of ["$13", "$25", "$72"]) if (!homeWords.includes(p)) fail(`home page: no ${p} price`);
if (!/6\s?am (?:to|and|-|until) 12\s?pm/i.test(homeWords)) fail("home page: Saturday 6am to 12pm is missing");

let settings = null;
try {
  settings = JSON.parse((await get("/api/settings")).body);
} catch {
  fail("/api/settings did not answer with JSON");
}
if (settings) {
  for (const [k, v] of Object.entries(PRICES)) {
    if (Number(settings.prices?.[k]) !== v) fail(`checkout price ${k} is ${settings.prices?.[k]}, should be ${v}`);
  }
  const stock = Number(settings.traysAvailable ?? settings.trays);
  if (Number.isFinite(stock) && stock <= 0) warn("stock is 0 trays: the shop shows sold out");
}

if (builds.size > 1) warn(`pages answer with different builds: ${[...builds].join(", ")}`);

const build = [...builds].join("/") || "unknown";
for (const w of warns) console.log(`note  ${w}`);
for (const f of fails) console.log(`FAIL  ${f}`);
console.log(
  fails.length
    ? `live site: ${fails.length} problem(s) on ${pages.length} pages, build ${build}`
    : `live site: all checks hold on ${pages.length} pages, build ${build}`,
);
process.exit(fails.length ? 1 : 0);
