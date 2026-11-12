// node infra/share-preview-test.mjs : how YOLKO links look when shared, and which Meta pixel
// hears about a visit. Checks the built pages on disk and pulls shareLinkCard out of the Worker.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shareImage, isLinkPreviewAgent, referralCard, SHARE_IMG_PX, SHARE_IMG_MAX_BYTES } from "./share-preview.mjs";
import { SITE_DELIVERY_FEE } from "./delivery-zones.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };
const worker = read("infra/cloudflare-worker.mjs");
const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html") && /og:image/.test(read(f)));
ok(pages.includes("index.html") && pages.length >= 16, "the homepage and the built pages are here");

// 1. The share picture: one photo on every page, and small enough for WhatsApp to draw it.
const image = shareImage(13);
const file = path.join(root, new URL(image).pathname);
ok(fs.existsSync(file), "the share picture is on disk");
const jpg = fs.readFileSync(file);
ok(jpg[0] === 0xff && jpg[1] === 0xd8, "the share picture is a JPEG");
ok(jpg.length < SHARE_IMG_MAX_BYTES, `the share picture is under 600 KB (it is ${Math.round(jpg.length / 1024)} KB)`);
const size = (() => {
  for (let i = 2; i < jpg.length; ) {
    if (jpg[i] !== 0xff) return null;
    const marker = jpg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)];
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  return null;
})();
ok(size && size[0] === SHARE_IMG_PX && size[1] === SHARE_IMG_PX, `the share picture is ${SHARE_IMG_PX} px square`);
for (const f of pages) {
  const html = read(f);
  ok(html.includes(`<meta property="og:image" content="${image}">`), `${f}: og:image is the share picture`);
  ok(html.includes(`<meta name="twitter:image" content="${image}">`), `${f}: twitter:image is the share picture`);
  ok(html.includes(`<meta property="og:image:width" content="${SHARE_IMG_PX}">`), `${f}: og:image:width matches the picture`);
}

// 2. One pixel: the pages and the server name the same one, and no secret can split them.
const pixel = /const META_PIXEL_ID = "(\d+)";/.exec(worker)?.[1];
ok(pixel, "the Worker names its pixel");
ok(!/env\.META_PIXEL_ID/.test(worker), "the Worker does not take its pixel from a secret");
for (const f of [...pages, "infra/build-pages.mjs"]) {
  const src = read(f);
  const ids = [...src.matchAll(/fbq\('init', '(\d+)'\)|facebook\.com\/tr\?id=(\d+)/g)].map((m) => m[1] || m[2]);
  if (f === "index.html" || f === "infra/build-pages.mjs") ok(ids.length === 2, `${f}: has the pixel snippet`);
  ok(ids.every((id) => id === pixel), `${f}: sends to the Worker's pixel`);
}

// 3. Who gets the card: apps that read a link to draw it. People and search engines get the shop.
for (const ua of [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "WhatsApp/2.23.20.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  "TelegramBot (like TwitterBot)",
]) ok(isLinkPreviewAgent(ua), `reads links for cards: ${ua.slice(0, 30)}`);
for (const ua of [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "",
  null,
]) ok(!isLinkPreviewAgent(ua), `gets the shop: ${String(ua).slice(0, 30)}`);

// 4. What the card says.
const card = referralCard({ code: "FRESH5", trayPrice: 13, deliveryFee: SITE_DELIVERY_FEE });
ok(card.title === "Your first egg delivery is free | YOLKO", "card title");
ok(card.description.includes("$5 delivery is free on your first order"), "the card says what the link gives");
ok(card.description.includes("$13") && card.description.includes("cage eggs"), "the card names the price and the eggs plainly");
ok(card.description.includes("Order by Thursday night"), "the card gives the cutoff");
ok(!/[!—–]|cheapest/i.test(card.title + card.description), "the card keeps the brand voice");
ok(card.html.includes('<meta property="og:url" content="https://getyolko.com/r/FRESH5">'), "the card belongs to the share link");
ok(card.html.includes(`<meta property="og:image" content="${image}">`), "the card shows the share picture");
ok(card.html.includes('<meta name="robots" content="noindex">'), "the card page is not for search engines");
ok(!referralCard({ code: 'A"><b>', trayPrice: 13, deliveryFee: 5 }).html.includes("<b>"), "a code cannot break out of the card page");

// 5. The Worker's side: only for a link-reading app, and only for a code that gives the free delivery.
const i = worker.indexOf("async function shareLinkCard(");
const j = worker.indexOf("\n}\n", i);
ok(i > 0 && j > i, "shareLinkCard is in the Worker");
const kv = { "ref:code:ABCDEF": JSON.stringify({ phone: "0400000000", name: "Sam" }) };
let tray = 13;
const shareLinkCard = new Function(
  "isLinkPreviewAgent", "referralCard", "cleanRefCode", "HOUSE_REF_CODES", "refCodeKey", "getSettings", "SITE_DELIVERY_FEE",
  `${worker.slice(i, j + 2)}\nreturn shareLinkCard;`
)(
  isLinkPreviewAgent,
  referralCard,
  (c) => (/^[A-HJKMNP-Z2-9]{6}$/.test(String(c || "").trim().toUpperCase()) ? String(c).trim().toUpperCase() : null),
  new Set(["FRESH5"]),
  (c) => `ref:code:${c}`,
  async () => ({ prices: { tray1: tray } }),
  SITE_DELIVERY_FEE
);
const env = { DATA: { get: async (k) => kv[k] ?? null } };
const req = (ua, method = "GET") => new Request("https://getyolko.com/r/x", { method, headers: ua ? { "User-Agent": ua } : {} });
const FB = "facebookexternalhit/1.1";
let res = await shareLinkCard(req(FB), env, "FRESH5");
ok(res?.status === 200 && (await res.text()).includes("Your first egg delivery is free"), "Facebook reading the shop-wide link gets the card");
ok(res.headers.get("X-Robots-Tag") === "noindex" && res.headers.get("Cache-Control") === "no-store", "the card is never indexed or cached");
res = await shareLinkCard(req("WhatsApp/2.23.20.0"), env, "abcdef");
ok(res?.status === 200 && (await res.text()).includes("https://getyolko.com/r/ABCDEF"), "WhatsApp reading a customer's link gets the card");
res = await shareLinkCard(req(FB, "HEAD"), env, "FRESH5");
ok(res?.status === 200 && (await res.text()) === "", "a HEAD request gets no body");
ok((await shareLinkCard(req(FB), env, "ZZZZZZ")) === null, "a code nobody owns gets the shop, not a promise");
ok((await shareLinkCard(req(FB), env, "nope")) === null, "a broken code gets the shop");
ok((await shareLinkCard(req("Mozilla/5.0 Chrome/126 Safari/537.36"), env, "FRESH5")) === null, "a person gets the shop");
ok((await shareLinkCard(req(""), env, "FRESH5")) === null, "no user agent gets the shop");
tray = 0;
ok((await shareLinkCard(req(FB), env, "FRESH5")) === null, "no card when the tray is not for sale");

if (!process.exitCode) console.log("share preview: all checks passed");
