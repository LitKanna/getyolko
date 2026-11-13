import { checkDeliveryAddress, SITE_DELIVERY_FEE, MAX_DELIVERY_KM } from "./delivery-zones.mjs";
import { priceWatchView, runPoll, runScheduledPoll, saveTyped, getLatest as latestShopPrices, lastPriceChange } from "./price-watch.mjs";
import { fillPricesPage, sitemapWithPriceChange, PRICES_PATH } from "./prices-page.mjs";
import { newsView, runNewsPoll, runScheduledNews, saveNewsFeed, isGithubRelay, takeNewsRelay } from "./news-feed.mjs";
import { growersView, runGrowersCheck, runScheduledGrowers } from "./growers.mjs";
import {
  MAIN, DOZENS_PER_CASE, VARIETIES, BUNDLES, BUNDLE_KEYS, isBundle, bundleLabel,
  stockOf, addStock, holdFor, heldBy, traysIn, stockProblem, catalogueView, shopView,
} from "./catalogue.mjs";
import { qrcode } from "qrcode-generator";
// The admin page lives in its own file; wrangler bundles .html as a text module.
import ADMIN_HTML from "./admin.html";
import { logoAlone, iconLinks } from "./brand.mjs";
import { brandQr } from "./brand-qr.mjs";
import { emailTitlePicture } from "./email-titles.mjs";
import { isLinkPreviewAgent, referralCard } from "./share-preview.mjs";
import {
  LINE_NUMBER, LINE_CONFIG_KEY, LINE_LOG_KEY, sameText, voiceAnswer, voiceAfter, textFromWebhook, textEmail,
} from "./phone-line.mjs";

// Pin to commit SHA so GitHub raw serves the exact deploy (update on each push).
const DEPLOY_SHA = "e7bf7e43f2692a20eff301107e6479db5d8bc470";
// Chalk-tray heroes must not 404 when the storefront pin drifts (this caused the
// black hero / “broken ratios” look after a later Worker deploy from main).
const CHALK_ASSETS_SHA = "fef7c19ba6c7cc2dd35edbb2538b0df2a0522b49";
const UPSTREAM_LIVE = `https://raw.githubusercontent.com/LitKanna/getyolko/${DEPLOY_SHA}`;
const UPSTREAM_ASSETS = `https://raw.githubusercontent.com/LitKanna/getyolko/${DEPLOY_SHA}`;
const UPSTREAM_CHALK = `https://raw.githubusercontent.com/LitKanna/getyolko/${CHALK_ASSETS_SHA}`;

// HTML stays no-store so Back from Stripe reloads the page instead of restoring a
// stuck "Opening…" button from bfcache. Hash-named fonts never change. Code and
// config get 5 minutes so a missed ?v= bump heals quickly; versioned images a day.
function browserCacheControl(ext, url) {
  if (ext === "html") return "no-store, no-cache, must-revalidate, max-age=0";
  if (url.pathname.startsWith("/assets/fonts/")) return "public, max-age=31536000, immutable";
  if (ext === "js" || ext === "css" || ext === "mjs") return "public, max-age=300";
  if (url.searchParams.has("v")) return "public, max-age=86400";
  return "public, max-age=300";
}

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  woff2: "font/woff2",
  woff: "font/woff",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  json: "application/json",
  md: "text/plain; charset=utf-8",
};

const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Dozen varieties (each sold as 1 dozen or a case of 15) and the tray varieties other than the
// main cage 1.75kg tray, whose stock is still traysAvailable. See catalogue.mjs.
const DOZEN_KEYS = VARIETIES.filter((v) => v.format === "dozen").map((v) => v.id);
const OTHER_VARIETIES = VARIETIES.filter((v) => !v.main).map((v) => v.id);
const TRAY_VARIETIES = VARIETIES.filter((v) => v.format === "tray" && !v.main).map((v) => v.id);

const DEFAULT_SETTINGS = {
  prices: {
    tray1: 13, tray2: 25, box: 72,
    cage600: 6, cage700: 7, cage800: 8,
    fr600: 8, fr700: 9, fr800: 10,
    cage600case: 90, cage700case: 105, cage800case: 120,
    fr600case: 120, fr700case: 135, fr800case: 150,
  },
  traysAvailable: 24, // the main cage 1.75kg tray
  stock: {}, // every other variety: { fr1500: 12, cage600: 30 }. 0 or missing = not on the shop
  trayWeight: "1.75",
  boxCost: 55, // what a box of 6 main trays costs
  trayCosts: {}, // what a box of 6 costs, for each other tray variety
  // Wholesale case cost (15 dozen packs) per dozen variety. Each one is independent.
  dozenCosts: {
    cage600: 75, cage700: 75, cage800: 75,
    fr600: 90, fr700: 90, fr800: 90,
  },
  pickup: {
    Monday: { enabled: false, open: "09:00", close: "14:00" },
    Tuesday: { enabled: false, open: "09:00", close: "14:00" },
    Wednesday: { enabled: false, open: "09:00", close: "14:00" },
    Thursday: { enabled: false, open: "09:00", close: "14:00" },
    Friday: { enabled: true, open: "10:00", close: "16:30" },
    Saturday: { enabled: true, open: "06:00", close: "14:00" },
    Sunday: { enabled: false, open: "09:00", close: "14:00" },
  },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanPickupDay(input, fallback) {
  if (!input || typeof input !== "object") return fallback;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
    open: TIME_RE.test(input.open) ? input.open : fallback.open,
    close: TIME_RE.test(input.close) ? input.close : fallback.close,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

async function getOrderIndex(env) {
  const raw = await env.DATA.get("orders:index", "json");
  return Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id.startsWith("order:")) : [];
}

async function pushOrderIndex(env, orderId) {
  const ids = await getOrderIndex(env);
  if (!ids.includes(orderId)) {
    ids.unshift(orderId);
    // Cap index so the single KV value stays small
    await env.DATA.put("orders:index", JSON.stringify(ids.slice(0, 500)));
  }
}

/** Latest unpaid order for a phone. reused when customer cancels Stripe and retries. */
function openOrderKey(phone) {
  return `openorder:${String(phone || "").replace(/\D/g, "")}`;
}

async function getOpenUnpaidOrder(env, phone) {
  const id = await env.DATA.get(openOrderKey(phone));
  if (!id || !String(id).startsWith("order:")) return null;
  const order = await env.DATA.get(String(id), "json");
  if (!order || order.paymentStatus === "paid") {
    await env.DATA.delete(openOrderKey(phone)).catch(() => null);
    return null;
  }
  return order;
}

async function rememberOpenOrder(env, phone, orderId) {
  await env.DATA.put(openOrderKey(phone), orderId, { expirationTtl: 6 * 3600 });
}

async function clearOpenOrder(env, phone, orderId) {
  // A newer order for the same phone may own the pointer by now.
  if (orderId && (await env.DATA.get(openOrderKey(phone)).catch(() => null)) !== orderId) return;
  await env.DATA.delete(openOrderKey(phone)).catch(() => null);
}

function isAdmin(request, env) {
  const raw = env.ADMIN_KEY;
  if (!raw) return false;
  const expected = String(raw).trim();
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return false;
  return m[1].trim() === expected;
}


/* ---------- Asset library (admin + live publish) ---------- */
const ASSET_REGISTRY = [{"id":"chalk-tray/1","label":"chalk-tray/1","preview":"/assets/chalk-tray/1-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/1-928.jpg","jpg640":"/assets/chalk-tray/1-640.jpg","webp928":"/assets/chalk-tray/1-928.webp","webp640":"/assets/chalk-tray/1-640.webp","jpg1536":"/assets/chalk-tray/1-1536.jpg","webp1536":"/assets/chalk-tray/1-1536.webp","jpg2048":"/assets/chalk-tray/1-2048.jpg","webp2048":"/assets/chalk-tray/1-2048.webp"},"square":{"jpg":"/assets/chalk-tray/1-square-560.jpg","webp":"/assets/chalk-tray/1-square-560.webp"},"rotatable":true,"chalkPrice":1},{"id":"chalk-tray/2","label":"chalk-tray/2","preview":"/assets/chalk-tray/2-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/2-928.jpg","jpg640":"/assets/chalk-tray/2-640.jpg","webp928":"/assets/chalk-tray/2-928.webp","webp640":"/assets/chalk-tray/2-640.webp","jpg1536":"/assets/chalk-tray/2-1536.jpg","webp1536":"/assets/chalk-tray/2-1536.webp","jpg2048":"/assets/chalk-tray/2-2048.jpg","webp2048":"/assets/chalk-tray/2-2048.webp"},"square":{"jpg":"/assets/chalk-tray/2-square-560.jpg","webp":"/assets/chalk-tray/2-square-560.webp"},"rotatable":true,"chalkPrice":2},{"id":"chalk-tray/3","label":"chalk-tray/3","preview":"/assets/chalk-tray/3-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/3-928.jpg","jpg640":"/assets/chalk-tray/3-640.jpg","webp928":"/assets/chalk-tray/3-928.webp","webp640":"/assets/chalk-tray/3-640.webp","jpg1536":"/assets/chalk-tray/3-1536.jpg","webp1536":"/assets/chalk-tray/3-1536.webp","jpg2048":"/assets/chalk-tray/3-2048.jpg","webp2048":"/assets/chalk-tray/3-2048.webp"},"square":{"jpg":"/assets/chalk-tray/3-square-560.jpg","webp":"/assets/chalk-tray/3-square-560.webp"},"rotatable":true,"chalkPrice":3},{"id":"chalk-tray/4","label":"chalk-tray/4","preview":"/assets/chalk-tray/4-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/4-928.jpg","jpg640":"/assets/chalk-tray/4-640.jpg","webp928":"/assets/chalk-tray/4-928.webp","webp640":"/assets/chalk-tray/4-640.webp","jpg1536":"/assets/chalk-tray/4-1536.jpg","webp1536":"/assets/chalk-tray/4-1536.webp","jpg2048":"/assets/chalk-tray/4-2048.jpg","webp2048":"/assets/chalk-tray/4-2048.webp"},"square":{"jpg":"/assets/chalk-tray/4-square-560.jpg","webp":"/assets/chalk-tray/4-square-560.webp"},"rotatable":true,"chalkPrice":4},{"id":"chalk-tray/5","label":"chalk-tray/5","preview":"/assets/chalk-tray/5-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/5-928.jpg","jpg640":"/assets/chalk-tray/5-640.jpg","webp928":"/assets/chalk-tray/5-928.webp","webp640":"/assets/chalk-tray/5-640.webp","jpg1536":"/assets/chalk-tray/5-1536.jpg","webp1536":"/assets/chalk-tray/5-1536.webp","jpg2048":"/assets/chalk-tray/5-2048.jpg","webp2048":"/assets/chalk-tray/5-2048.webp"},"square":{"jpg":"/assets/chalk-tray/5-square-560.jpg","webp":"/assets/chalk-tray/5-square-560.webp"},"rotatable":true,"chalkPrice":5},{"id":"chalk-tray/6","label":"chalk-tray/6","preview":"/assets/chalk-tray/6-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/6-928.jpg","jpg640":"/assets/chalk-tray/6-640.jpg","webp928":"/assets/chalk-tray/6-928.webp","webp640":"/assets/chalk-tray/6-640.webp","jpg1536":"/assets/chalk-tray/6-1536.jpg","webp1536":"/assets/chalk-tray/6-1536.webp","jpg2048":"/assets/chalk-tray/6-2048.jpg","webp2048":"/assets/chalk-tray/6-2048.webp"},"square":{"jpg":"/assets/chalk-tray/6-square-560.jpg","webp":"/assets/chalk-tray/6-square-560.webp"},"rotatable":true,"chalkPrice":6},{"id":"chalk-tray/7","label":"chalk-tray/7","preview":"/assets/chalk-tray/7-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/7-928.jpg","jpg640":"/assets/chalk-tray/7-640.jpg","webp928":"/assets/chalk-tray/7-928.webp","webp640":"/assets/chalk-tray/7-640.webp","jpg1536":"/assets/chalk-tray/7-1536.jpg","webp1536":"/assets/chalk-tray/7-1536.webp","jpg2048":"/assets/chalk-tray/7-2048.jpg","webp2048":"/assets/chalk-tray/7-2048.webp"},"square":{"jpg":"/assets/chalk-tray/7-square-560.jpg","webp":"/assets/chalk-tray/7-square-560.webp"},"rotatable":true,"chalkPrice":7},{"id":"chalk-tray/8","label":"chalk-tray/8","preview":"/assets/chalk-tray/8-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/8-928.jpg","jpg640":"/assets/chalk-tray/8-640.jpg","webp928":"/assets/chalk-tray/8-928.webp","webp640":"/assets/chalk-tray/8-640.webp","jpg1536":"/assets/chalk-tray/8-1536.jpg","webp1536":"/assets/chalk-tray/8-1536.webp","jpg2048":"/assets/chalk-tray/8-2048.jpg","webp2048":"/assets/chalk-tray/8-2048.webp"},"square":{"jpg":"/assets/chalk-tray/8-square-560.jpg","webp":"/assets/chalk-tray/8-square-560.webp"},"rotatable":true,"chalkPrice":8},{"id":"chalk-tray/9","label":"chalk-tray/9","preview":"/assets/chalk-tray/9-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/9-928.jpg","jpg640":"/assets/chalk-tray/9-640.jpg","webp928":"/assets/chalk-tray/9-928.webp","webp640":"/assets/chalk-tray/9-640.webp","jpg1536":"/assets/chalk-tray/9-1536.jpg","webp1536":"/assets/chalk-tray/9-1536.webp","jpg2048":"/assets/chalk-tray/9-2048.jpg","webp2048":"/assets/chalk-tray/9-2048.webp"},"square":{"jpg":"/assets/chalk-tray/9-square-560.jpg","webp":"/assets/chalk-tray/9-square-560.webp"},"rotatable":true,"chalkPrice":9},{"id":"chalk-tray/10","label":"chalk-tray/10","preview":"/assets/chalk-tray/10-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/10-928.jpg","jpg640":"/assets/chalk-tray/10-640.jpg","webp928":"/assets/chalk-tray/10-928.webp","webp640":"/assets/chalk-tray/10-640.webp","jpg1536":"/assets/chalk-tray/10-1536.jpg","webp1536":"/assets/chalk-tray/10-1536.webp","jpg2048":"/assets/chalk-tray/10-2048.jpg","webp2048":"/assets/chalk-tray/10-2048.webp"},"square":{"jpg":"/assets/chalk-tray/10-square-560.jpg","webp":"/assets/chalk-tray/10-square-560.webp"},"rotatable":true,"chalkPrice":10},{"id":"chalk-tray/11","label":"chalk-tray/11","preview":"/assets/chalk-tray/11-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/11-928.jpg","jpg640":"/assets/chalk-tray/11-640.jpg","webp928":"/assets/chalk-tray/11-928.webp","webp640":"/assets/chalk-tray/11-640.webp","jpg1536":"/assets/chalk-tray/11-1536.jpg","webp1536":"/assets/chalk-tray/11-1536.webp","jpg2048":"/assets/chalk-tray/11-2048.jpg","webp2048":"/assets/chalk-tray/11-2048.webp"},"square":{"jpg":"/assets/chalk-tray/11-square-560.jpg","webp":"/assets/chalk-tray/11-square-560.webp"},"rotatable":true,"chalkPrice":11},{"id":"chalk-tray/12","label":"chalk-tray/12","preview":"/assets/chalk-tray/12-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/12-928.jpg","jpg640":"/assets/chalk-tray/12-640.jpg","webp928":"/assets/chalk-tray/12-928.webp","webp640":"/assets/chalk-tray/12-640.webp","jpg1536":"/assets/chalk-tray/12-1536.jpg","webp1536":"/assets/chalk-tray/12-1536.webp","jpg2048":"/assets/chalk-tray/12-2048.jpg","webp2048":"/assets/chalk-tray/12-2048.webp"},"square":{"jpg":"/assets/chalk-tray/12-square-560.jpg","webp":"/assets/chalk-tray/12-square-560.webp"},"rotatable":true,"chalkPrice":12},{"id":"chalk-tray/13","label":"chalk-tray/13","preview":"/assets/chalk-tray/13-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/13-928.jpg","jpg640":"/assets/chalk-tray/13-640.jpg","webp928":"/assets/chalk-tray/13-928.webp","webp640":"/assets/chalk-tray/13-640.webp","jpg1536":"/assets/chalk-tray/13-1536.jpg","webp1536":"/assets/chalk-tray/13-1536.webp","jpg2048":"/assets/chalk-tray/13-2048.jpg","webp2048":"/assets/chalk-tray/13-2048.webp"},"square":{"jpg":"/assets/chalk-tray/13-square-560.jpg","webp":"/assets/chalk-tray/13-square-560.webp"},"rotatable":true,"chalkPrice":13},{"id":"chalk-tray/14","label":"chalk-tray/14","preview":"/assets/chalk-tray/14-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/14-928.jpg","jpg640":"/assets/chalk-tray/14-640.jpg","webp928":"/assets/chalk-tray/14-928.webp","webp640":"/assets/chalk-tray/14-640.webp","jpg1536":"/assets/chalk-tray/14-1536.jpg","webp1536":"/assets/chalk-tray/14-1536.webp","jpg2048":"/assets/chalk-tray/14-2048.jpg","webp2048":"/assets/chalk-tray/14-2048.webp"},"square":{"jpg":"/assets/chalk-tray/14-square-560.jpg","webp":"/assets/chalk-tray/14-square-560.webp"},"rotatable":true,"chalkPrice":14},{"id":"chalk-tray/15","label":"chalk-tray/15","preview":"/assets/chalk-tray/15-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/15-928.jpg","jpg640":"/assets/chalk-tray/15-640.jpg","webp928":"/assets/chalk-tray/15-928.webp","webp640":"/assets/chalk-tray/15-640.webp","jpg1536":"/assets/chalk-tray/15-1536.jpg","webp1536":"/assets/chalk-tray/15-1536.webp","jpg2048":"/assets/chalk-tray/15-2048.jpg","webp2048":"/assets/chalk-tray/15-2048.webp"},"square":{"jpg":"/assets/chalk-tray/15-square-560.jpg","webp":"/assets/chalk-tray/15-square-560.webp"},"rotatable":true,"chalkPrice":15},{"id":"chalk-tray/16","label":"chalk-tray/16","preview":"/assets/chalk-tray/16-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/16-928.jpg","jpg640":"/assets/chalk-tray/16-640.jpg","webp928":"/assets/chalk-tray/16-928.webp","webp640":"/assets/chalk-tray/16-640.webp","jpg1536":"/assets/chalk-tray/16-1536.jpg","webp1536":"/assets/chalk-tray/16-1536.webp","jpg2048":"/assets/chalk-tray/16-2048.jpg","webp2048":"/assets/chalk-tray/16-2048.webp"},"square":{"jpg":"/assets/chalk-tray/16-square-560.jpg","webp":"/assets/chalk-tray/16-square-560.webp"},"rotatable":true,"chalkPrice":16},{"id":"chalk-tray/17","label":"chalk-tray/17","preview":"/assets/chalk-tray/17-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/17-928.jpg","jpg640":"/assets/chalk-tray/17-640.jpg","webp928":"/assets/chalk-tray/17-928.webp","webp640":"/assets/chalk-tray/17-640.webp","jpg1536":"/assets/chalk-tray/17-1536.jpg","webp1536":"/assets/chalk-tray/17-1536.webp","jpg2048":"/assets/chalk-tray/17-2048.jpg","webp2048":"/assets/chalk-tray/17-2048.webp"},"square":{"jpg":"/assets/chalk-tray/17-square-560.jpg","webp":"/assets/chalk-tray/17-square-560.webp"},"rotatable":true,"chalkPrice":17},{"id":"chalk-tray/18","label":"chalk-tray/18","preview":"/assets/chalk-tray/18-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/18-928.jpg","jpg640":"/assets/chalk-tray/18-640.jpg","webp928":"/assets/chalk-tray/18-928.webp","webp640":"/assets/chalk-tray/18-640.webp","jpg1536":"/assets/chalk-tray/18-1536.jpg","webp1536":"/assets/chalk-tray/18-1536.webp","jpg2048":"/assets/chalk-tray/18-2048.jpg","webp2048":"/assets/chalk-tray/18-2048.webp"},"square":{"jpg":"/assets/chalk-tray/18-square-560.jpg","webp":"/assets/chalk-tray/18-square-560.webp"},"rotatable":true,"chalkPrice":18},{"id":"chalk-tray/19","label":"chalk-tray/19","preview":"/assets/chalk-tray/19-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/19-928.jpg","jpg640":"/assets/chalk-tray/19-640.jpg","webp928":"/assets/chalk-tray/19-928.webp","webp640":"/assets/chalk-tray/19-640.webp","jpg1536":"/assets/chalk-tray/19-1536.jpg","webp1536":"/assets/chalk-tray/19-1536.webp","jpg2048":"/assets/chalk-tray/19-2048.jpg","webp2048":"/assets/chalk-tray/19-2048.webp"},"square":{"jpg":"/assets/chalk-tray/19-square-560.jpg","webp":"/assets/chalk-tray/19-square-560.webp"},"rotatable":true,"chalkPrice":19},{"id":"chalk-tray/20","label":"chalk-tray/20","preview":"/assets/chalk-tray/20-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/20-928.jpg","jpg640":"/assets/chalk-tray/20-640.jpg","webp928":"/assets/chalk-tray/20-928.webp","webp640":"/assets/chalk-tray/20-640.webp","jpg1536":"/assets/chalk-tray/20-1536.jpg","webp1536":"/assets/chalk-tray/20-1536.webp","jpg2048":"/assets/chalk-tray/20-2048.jpg","webp2048":"/assets/chalk-tray/20-2048.webp"},"square":{"jpg":"/assets/chalk-tray/20-square-560.jpg","webp":"/assets/chalk-tray/20-square-560.webp"},"rotatable":true,"chalkPrice":20},{"id":"chalk-tray/21","label":"chalk-tray/21","preview":"/assets/chalk-tray/21-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/21-928.jpg","jpg640":"/assets/chalk-tray/21-640.jpg","webp928":"/assets/chalk-tray/21-928.webp","webp640":"/assets/chalk-tray/21-640.webp","jpg1536":"/assets/chalk-tray/21-1536.jpg","webp1536":"/assets/chalk-tray/21-1536.webp","jpg2048":"/assets/chalk-tray/21-2048.jpg","webp2048":"/assets/chalk-tray/21-2048.webp"},"square":{"jpg":"/assets/chalk-tray/21-square-560.jpg","webp":"/assets/chalk-tray/21-square-560.webp"},"rotatable":true,"chalkPrice":21},{"id":"chalk-tray/22","label":"chalk-tray/22","preview":"/assets/chalk-tray/22-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/22-928.jpg","jpg640":"/assets/chalk-tray/22-640.jpg","webp928":"/assets/chalk-tray/22-928.webp","webp640":"/assets/chalk-tray/22-640.webp","jpg1536":"/assets/chalk-tray/22-1536.jpg","webp1536":"/assets/chalk-tray/22-1536.webp","jpg2048":"/assets/chalk-tray/22-2048.jpg","webp2048":"/assets/chalk-tray/22-2048.webp"},"square":{"jpg":"/assets/chalk-tray/22-square-560.jpg","webp":"/assets/chalk-tray/22-square-560.webp"},"rotatable":true,"chalkPrice":22},{"id":"chalk-tray/23","label":"chalk-tray/23","preview":"/assets/chalk-tray/23-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/23-928.jpg","jpg640":"/assets/chalk-tray/23-640.jpg","webp928":"/assets/chalk-tray/23-928.webp","webp640":"/assets/chalk-tray/23-640.webp","jpg1536":"/assets/chalk-tray/23-1536.jpg","webp1536":"/assets/chalk-tray/23-1536.webp","jpg2048":"/assets/chalk-tray/23-2048.jpg","webp2048":"/assets/chalk-tray/23-2048.webp"},"square":{"jpg":"/assets/chalk-tray/23-square-560.jpg","webp":"/assets/chalk-tray/23-square-560.webp"},"rotatable":true,"chalkPrice":23},{"id":"chalk-tray/24","label":"chalk-tray/24","preview":"/assets/chalk-tray/24-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/24-928.jpg","jpg640":"/assets/chalk-tray/24-640.jpg","webp928":"/assets/chalk-tray/24-928.webp","webp640":"/assets/chalk-tray/24-640.webp","jpg1536":"/assets/chalk-tray/24-1536.jpg","webp1536":"/assets/chalk-tray/24-1536.webp","jpg2048":"/assets/chalk-tray/24-2048.jpg","webp2048":"/assets/chalk-tray/24-2048.webp"},"square":{"jpg":"/assets/chalk-tray/24-square-560.jpg","webp":"/assets/chalk-tray/24-square-560.webp"},"rotatable":true,"chalkPrice":24},{"id":"chalk-tray/25","label":"chalk-tray/25","preview":"/assets/chalk-tray/25-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/25-928.jpg","jpg640":"/assets/chalk-tray/25-640.jpg","webp928":"/assets/chalk-tray/25-928.webp","webp640":"/assets/chalk-tray/25-640.webp","jpg1536":"/assets/chalk-tray/25-1536.jpg","webp1536":"/assets/chalk-tray/25-1536.webp","jpg2048":"/assets/chalk-tray/25-2048.jpg","webp2048":"/assets/chalk-tray/25-2048.webp"},"square":{"jpg":"/assets/chalk-tray/25-square-560.jpg","webp":"/assets/chalk-tray/25-square-560.webp"},"rotatable":true,"chalkPrice":25},{"id":"chalk-tray/26","label":"chalk-tray/26","preview":"/assets/chalk-tray/26-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/26-928.jpg","jpg640":"/assets/chalk-tray/26-640.jpg","webp928":"/assets/chalk-tray/26-928.webp","webp640":"/assets/chalk-tray/26-640.webp","jpg1536":"/assets/chalk-tray/26-1536.jpg","webp1536":"/assets/chalk-tray/26-1536.webp","jpg2048":"/assets/chalk-tray/26-2048.jpg","webp2048":"/assets/chalk-tray/26-2048.webp"},"square":{"jpg":"/assets/chalk-tray/26-square-560.jpg","webp":"/assets/chalk-tray/26-square-560.webp"},"rotatable":true,"chalkPrice":26},{"id":"chalk-tray/27","label":"chalk-tray/27","preview":"/assets/chalk-tray/27-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/27-928.jpg","jpg640":"/assets/chalk-tray/27-640.jpg","webp928":"/assets/chalk-tray/27-928.webp","webp640":"/assets/chalk-tray/27-640.webp","jpg1536":"/assets/chalk-tray/27-1536.jpg","webp1536":"/assets/chalk-tray/27-1536.webp","jpg2048":"/assets/chalk-tray/27-2048.jpg","webp2048":"/assets/chalk-tray/27-2048.webp"},"square":{"jpg":"/assets/chalk-tray/27-square-560.jpg","webp":"/assets/chalk-tray/27-square-560.webp"},"rotatable":true,"chalkPrice":27},{"id":"chalk-tray/28","label":"chalk-tray/28","preview":"/assets/chalk-tray/28-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/28-928.jpg","jpg640":"/assets/chalk-tray/28-640.jpg","webp928":"/assets/chalk-tray/28-928.webp","webp640":"/assets/chalk-tray/28-640.webp","jpg1536":"/assets/chalk-tray/28-1536.jpg","webp1536":"/assets/chalk-tray/28-1536.webp","jpg2048":"/assets/chalk-tray/28-2048.jpg","webp2048":"/assets/chalk-tray/28-2048.webp"},"square":{"jpg":"/assets/chalk-tray/28-square-560.jpg","webp":"/assets/chalk-tray/28-square-560.webp"},"rotatable":true,"chalkPrice":28},{"id":"chalk-tray/29","label":"chalk-tray/29","preview":"/assets/chalk-tray/29-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/29-928.jpg","jpg640":"/assets/chalk-tray/29-640.jpg","webp928":"/assets/chalk-tray/29-928.webp","webp640":"/assets/chalk-tray/29-640.webp","jpg1536":"/assets/chalk-tray/29-1536.jpg","webp1536":"/assets/chalk-tray/29-1536.webp","jpg2048":"/assets/chalk-tray/29-2048.jpg","webp2048":"/assets/chalk-tray/29-2048.webp"},"square":{"jpg":"/assets/chalk-tray/29-square-560.jpg","webp":"/assets/chalk-tray/29-square-560.webp"},"rotatable":true,"chalkPrice":29},{"id":"chalk-tray/30","label":"chalk-tray/30","preview":"/assets/chalk-tray/30-square-560.jpg","kind":"chalk","defaultCategory":"Hero","hero":{"jpg928":"/assets/chalk-tray/30-928.jpg","jpg640":"/assets/chalk-tray/30-640.jpg","webp928":"/assets/chalk-tray/30-928.webp","webp640":"/assets/chalk-tray/30-640.webp","jpg1536":"/assets/chalk-tray/30-1536.jpg","webp1536":"/assets/chalk-tray/30-1536.webp","jpg2048":"/assets/chalk-tray/30-2048.jpg","webp2048":"/assets/chalk-tray/30-2048.webp"},"square":{"jpg":"/assets/chalk-tray/30-square-560.jpg","webp":"/assets/chalk-tray/30-square-560.webp"},"rotatable":true,"chalkPrice":30},{"id":"hero-eggs","label":"hero-eggs","preview":"/assets/hero-eggs-700.jpg","kind":"brand","defaultCategory":"Brand","hero":{"jpg1400":"/assets/hero-eggs-1400.jpg","jpg700":"/assets/hero-eggs-700.jpg"},"square":{"jpg":"/assets/hero-eggs-700.jpg"},"rotatable":true},{"id":"hero-tray-real","label":"hero-tray-real","preview":"/assets/hero-tray-real-540.jpg","kind":"brand","defaultCategory":"Brand","hero":{"jpg1080":"/assets/hero-tray-real-1080.jpg","webp1080":"/assets/hero-tray-real-1080.webp","jpg1400":"/assets/hero-tray-real-1400.jpg","jpg700":"/assets/hero-tray-real-700.jpg","jpg540":"/assets/hero-tray-real-540.jpg"},"square":{"jpg":"/assets/hero-tray-real-540.jpg"},"rotatable":true},{"id":"market-sign","label":"market-sign","preview":"/assets/market-sign.png","kind":"brand","defaultCategory":"Brand","hero":{},"square":{"jpg":"/assets/market-sign.png"},"rotatable":true},{"id":"pace-farm-tray","label":"pace-farm-tray","preview":"/assets/pace-farm-tray-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1400":"/assets/pace-farm-tray-1400.jpg","jpg700":"/assets/pace-farm-tray-700.jpg","jpg540":"/assets/pace-farm-tray-540.jpg"},"square":{"jpg":"/assets/pace-farm-tray-540.jpg"},"rotatable":true},{"id":"pace-tray-150kg","label":"pace-tray-150kg","preview":"/assets/pace-tray-150kg-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/pace-tray-150kg-1080.jpg","webp1080":"/assets/pace-tray-150kg-1080.webp","jpg1400":"/assets/pace-tray-150kg-1400.jpg","jpg700":"/assets/pace-tray-150kg-700.jpg","jpg540":"/assets/pace-tray-150kg-540.jpg"},"square":{"jpg":"/assets/pace-tray-150kg-540.jpg"},"rotatable":true},{"id":"references/fairdinks-cage-175-1280","label":"references/fairdinks-cage-175-1280","preview":"/assets/references/fairdinks-cage-175-1280.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/fairdinks-cage-175-1280.jpg"},"rotatable":true},{"id":"references/fairdinks-cagefree-175-1280","label":"references/fairdinks-cagefree-175-1280","preview":"/assets/references/fairdinks-cagefree-175-1280.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/fairdinks-cagefree-175-1280.jpg"},"rotatable":true},{"id":"references/fairdinks-pace-cage-175","label":"references/fairdinks-pace-cage-175","preview":"/assets/references/fairdinks-pace-cage-175.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/fairdinks-pace-cage-175.jpg"},"rotatable":true},{"id":"references/fairdinks-pace-cage-175-hi","label":"references/fairdinks-pace-cage-175-hi","preview":"/assets/references/fairdinks-pace-cage-175-hi.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/fairdinks-pace-cage-175-hi.jpg"},"rotatable":true},{"id":"references/gourmet-farmfresh-cage-xl-30-175","label":"references/gourmet-farmfresh-cage-xl-30-175","preview":"/assets/references/gourmet-farmfresh-cage-xl-30-175.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/gourmet-farmfresh-cage-xl-30-175.jpg"},"rotatable":true},{"id":"references/pace-150-ref","label":"references/pace-150-ref","preview":"/assets/references/pace-150-ref.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-150-ref.jpg"},"rotatable":true},{"id":"references/pace-175-ref","label":"references/pace-175-ref","preview":"/assets/references/pace-175-ref.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-175-ref.jpg"},"rotatable":true},{"id":"references/pace-175-ref2","label":"references/pace-175-ref2","preview":"/assets/references/pace-175-ref2.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-175-ref2.jpg"},"rotatable":true},{"id":"references/pace-cage-175-hi","label":"references/pace-cage-175-hi","preview":"/assets/references/pace-cage-175-hi.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-cage-175-hi.jpg"},"rotatable":true},{"id":"references/pace-cage-175-retail","label":"references/pace-cage-175-retail","preview":"/assets/references/pace-cage-175-retail.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-cage-175-retail.jpg"},"rotatable":true},{"id":"references/pace-cage-175-retail-hi","label":"references/pace-cage-175-retail-hi","preview":"/assets/references/pace-cage-175-retail-hi.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-cage-175-retail-hi.jpg"},"rotatable":true},{"id":"references/pace-caged-150-hi","label":"references/pace-caged-150-hi","preview":"/assets/references/pace-caged-150-hi.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-caged-150-hi.jpg"},"rotatable":true},{"id":"references/pace-caged-150-woolies","label":"references/pace-caged-150-woolies","preview":"/assets/references/pace-caged-150-woolies.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-caged-150-woolies.jpg"},"rotatable":true},{"id":"references/pace-cagefree-175-retail","label":"references/pace-cagefree-175-retail","preview":"/assets/references/pace-cagefree-175-retail.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-cagefree-175-retail.jpg"},"rotatable":true},{"id":"references/pace-logo-retail-extract","label":"references/pace-logo-retail-extract","preview":"/assets/references/pace-logo-retail-extract.png","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-logo-retail-extract.png"},"rotatable":true},{"id":"references/pace-logo-retail-packaging","label":"references/pace-logo-retail-packaging","preview":"/assets/references/pace-logo-retail-packaging.png","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-logo-retail-packaging.png"},"rotatable":true},{"id":"references/pace-logo-retail-wide","label":"references/pace-logo-retail-wide","preview":"/assets/references/pace-logo-retail-wide.png","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-logo-retail-wide.png"},"rotatable":true},{"id":"references/pace-official-farm-fresh-cage","label":"references/pace-official-farm-fresh-cage","preview":"/assets/references/pace-official-farm-fresh-cage.png","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-official-farm-fresh-cage.png"},"rotatable":true},{"id":"references/pace-official-favicon","label":"references/pace-official-favicon","preview":"/assets/references/pace-official-favicon.png","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/pace-official-favicon.png"},"rotatable":true},{"id":"references/umall-pace-cage-30-150","label":"references/umall-pace-cage-30-150","preview":"/assets/references/umall-pace-cage-30-150.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/umall-pace-cage-30-150.jpg"},"rotatable":true},{"id":"references/wool-701985-alt","label":"references/wool-701985-alt","preview":"/assets/references/wool-701985-alt.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-701985-alt.jpg"},"rotatable":true},{"id":"references/wool-701985-front","label":"references/wool-701985-front","preview":"/assets/references/wool-701985-front.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-701985-front.jpg"},"rotatable":true},{"id":"references/wool-701985-hi","label":"references/wool-701985-hi","preview":"/assets/references/wool-701985-hi.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-701985-hi.jpg"},"rotatable":true},{"id":"references/wool-92940-xl12","label":"references/wool-92940-xl12","preview":"/assets/references/wool-92940-xl12.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-92940-xl12.jpg"},"rotatable":true},{"id":"references/wool-92940-xl12-alt","label":"references/wool-92940-xl12-alt","preview":"/assets/references/wool-92940-xl12-alt.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-92940-xl12-alt.jpg"},"rotatable":true},{"id":"references/wool-caged-701985","label":"references/wool-caged-701985","preview":"/assets/references/wool-caged-701985.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_1","label":"references/wool-caged-701985_1","preview":"/assets/references/wool-caged-701985_1.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_1.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_2","label":"references/wool-caged-701985_2","preview":"/assets/references/wool-caged-701985_2.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_2.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_3","label":"references/wool-caged-701985_3","preview":"/assets/references/wool-caged-701985_3.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_3.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_4","label":"references/wool-caged-701985_4","preview":"/assets/references/wool-caged-701985_4.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_4.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_5","label":"references/wool-caged-701985_5","preview":"/assets/references/wool-caged-701985_5.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_5.jpg"},"rotatable":true},{"id":"references/wool-caged-701985_6","label":"references/wool-caged-701985_6","preview":"/assets/references/wool-caged-701985_6.jpg","kind":"reference","defaultCategory":"References","hero":{},"square":{"jpg":"/assets/references/wool-caged-701985_6.jpg"},"rotatable":true},{"id":"social-eggs","label":"social-eggs","preview":"/assets/social-eggs-540.jpg","kind":"brand","defaultCategory":"Brand","hero":{"jpg1080":"/assets/social-eggs-1080.jpg","webp1080":"/assets/social-eggs-1080.webp","jpg540":"/assets/social-eggs-540.jpg"},"square":{"jpg":"/assets/social-eggs-540.jpg"},"rotatable":true},{"id":"studio-tray","label":"studio-tray","preview":"/assets/studio-tray-square-560.jpg","kind":"studio","defaultCategory":"Hero","hero":{"jpg928":"/assets/studio-tray-928.jpg","jpg640":"/assets/studio-tray-640.jpg","webp928":"/assets/studio-tray-928.webp","webp640":"/assets/studio-tray-640.webp"},"square":{"jpg":"/assets/studio-tray-square-560.jpg","webp":"/assets/studio-tray-square-560.webp"},"rotatable":true},{"id":"studio-tray-v2","label":"studio-tray-v2","preview":"/assets/studio-tray-v2-square-560.jpg","kind":"studio","defaultCategory":"Hero","hero":{"jpg928":"/assets/studio-tray-v2-928.jpg","jpg640":"/assets/studio-tray-v2-640.jpg","webp928":"/assets/studio-tray-v2-928.webp","webp640":"/assets/studio-tray-v2-640.webp"},"square":{"jpg":"/assets/studio-tray-v2-square-560.jpg","webp":"/assets/studio-tray-v2-square-560.webp"},"rotatable":true},{"id":"studio-tray-v3","label":"studio-tray-v3","preview":"/assets/studio-tray-v3-square-560.jpg","kind":"studio","defaultCategory":"Hero","hero":{"jpg928":"/assets/studio-tray-v3-928.jpg","jpg640":"/assets/studio-tray-v3-640.jpg","webp928":"/assets/studio-tray-v3-928.webp","webp640":"/assets/studio-tray-v3-640.webp"},"square":{"jpg":"/assets/studio-tray-v3-square-560.jpg","webp":"/assets/studio-tray-v3-square-560.webp"},"rotatable":true},{"id":"studio-tray-v5","label":"studio-tray-v5","preview":"/assets/studio-tray-v5-square-560.jpg","kind":"studio","defaultCategory":"Hero","hero":{"jpg928":"/assets/studio-tray-v5-928.jpg","jpg640":"/assets/studio-tray-v5-640.jpg","webp928":"/assets/studio-tray-v5-928.webp","webp640":"/assets/studio-tray-v5-640.webp"},"square":{"jpg":"/assets/studio-tray-v5-square-560.jpg","webp":"/assets/studio-tray-v5-square-560.webp"},"rotatable":true},{"id":"studio-tray-v6","label":"studio-tray-v6","preview":"/assets/studio-tray-v6-square-560.jpg","kind":"studio","defaultCategory":"Hero","hero":{"jpg928":"/assets/studio-tray-v6-928.jpg","jpg640":"/assets/studio-tray-v6-640.jpg","webp928":"/assets/studio-tray-v6-928.webp","webp640":"/assets/studio-tray-v6-640.webp"},"square":{"jpg":"/assets/studio-tray-v6-square-560.jpg","webp":"/assets/studio-tray-v6-square-560.webp"},"rotatable":true},{"id":"tray","label":"tray","preview":"/assets/tray-order-400.jpg","kind":"other","defaultCategory":"Other","hero":{},"square":{"jpg":"/assets/tray-order-400.jpg"},"rotatable":true},{"id":"tray-orange-amber","label":"tray-orange-amber","preview":"/assets/tray-orange-amber-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-amber-1080.jpg","webp1080":"/assets/tray-orange-amber-1080.webp","jpg1400":"/assets/tray-orange-amber-1400.jpg","jpg700":"/assets/tray-orange-amber-700.jpg","jpg540":"/assets/tray-orange-amber-540.jpg"},"square":{"jpg":"/assets/tray-orange-amber-540.jpg"},"rotatable":true},{"id":"tray-orange-golden","label":"tray-orange-golden","preview":"/assets/tray-orange-golden-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-golden-1080.jpg","webp1080":"/assets/tray-orange-golden-1080.webp","jpg1400":"/assets/tray-orange-golden-1400.jpg","jpg700":"/assets/tray-orange-golden-700.jpg","jpg540":"/assets/tray-orange-golden-540.jpg"},"square":{"jpg":"/assets/tray-orange-golden-540.jpg"},"rotatable":true},{"id":"tray-orange-market","label":"tray-orange-market","preview":"/assets/tray-orange-market-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-market-1080.jpg","webp1080":"/assets/tray-orange-market-1080.webp","jpg1400":"/assets/tray-orange-market-1400.jpg","jpg700":"/assets/tray-orange-market-700.jpg","jpg540":"/assets/tray-orange-market-540.jpg"},"square":{"jpg":"/assets/tray-orange-market-540.jpg"},"rotatable":true},{"id":"tray-orange-premium","label":"tray-orange-premium","preview":"/assets/tray-orange-premium-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-premium-1080.jpg","webp1080":"/assets/tray-orange-premium-1080.webp","jpg1400":"/assets/tray-orange-premium-1400.jpg","jpg700":"/assets/tray-orange-premium-700.jpg","jpg540":"/assets/tray-orange-premium-540.jpg"},"square":{"jpg":"/assets/tray-orange-premium-540.jpg"},"rotatable":true},{"id":"tray-orange-retail","label":"tray-orange-retail","preview":"/assets/tray-orange-retail-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-retail-1080.jpg","webp1080":"/assets/tray-orange-retail-1080.webp","jpg1400":"/assets/tray-orange-retail-1400.jpg","jpg700":"/assets/tray-orange-retail-700.jpg","jpg540":"/assets/tray-orange-retail-540.jpg"},"square":{"jpg":"/assets/tray-orange-retail-540.jpg"},"rotatable":true},{"id":"tray-orange-sunset","label":"tray-orange-sunset","preview":"/assets/tray-orange-sunset-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-orange-sunset-1080.jpg","webp1080":"/assets/tray-orange-sunset-1080.webp","jpg1400":"/assets/tray-orange-sunset-1400.jpg","jpg700":"/assets/tray-orange-sunset-700.jpg","jpg540":"/assets/tray-orange-sunset-540.jpg"},"square":{"jpg":"/assets/tray-orange-sunset-540.jpg"},"rotatable":true},{"id":"tray-product","label":"tray-product","preview":"/assets/tray-product-540.jpg","kind":"product","defaultCategory":"Product","hero":{"jpg1080":"/assets/tray-product-1080.jpg","webp1080":"/assets/tray-product-1080.webp","jpg1400":"/assets/tray-product-1400.jpg","jpg700":"/assets/tray-product-700.jpg","jpg540":"/assets/tray-product-540.jpg"},"square":{"jpg":"/assets/tray-product-540.jpg"},"rotatable":true},{"id":"variants/tray-a-real30-market","label":"variants/tray-a-real30-market","preview":"/assets/variants/tray-a-real30-market-540.jpg","kind":"variant","defaultCategory":"Variants","hero":{"jpg1080":"/assets/variants/tray-a-real30-market-1080.jpg","webp1080":"/assets/variants/tray-a-real30-market-1080.webp","jpg1400":"/assets/variants/tray-a-real30-market-1400.jpg","jpg700":"/assets/variants/tray-a-real30-market-700.jpg","jpg540":"/assets/variants/tray-a-real30-market-540.jpg"},"square":{"jpg":"/assets/variants/tray-a-real30-market-540.jpg"},"rotatable":true},{"id":"variants/tray-c-orange-market-30","label":"variants/tray-c-orange-market-30","preview":"/assets/variants/tray-c-orange-market-30-540.jpg","kind":"variant","defaultCategory":"Variants","hero":{"jpg1080":"/assets/variants/tray-c-orange-market-30-1080.jpg","webp1080":"/assets/variants/tray-c-orange-market-30-1080.webp","jpg1400":"/assets/variants/tray-c-orange-market-30-1400.jpg","jpg700":"/assets/variants/tray-c-orange-market-30-700.jpg","jpg540":"/assets/variants/tray-c-orange-market-30-540.jpg"},"square":{"jpg":"/assets/variants/tray-c-orange-market-30-540.jpg"},"rotatable":true},{"id":"variants/tray-d-authentic-plastic-175kg","label":"variants/tray-d-authentic-plastic-175kg","preview":"/assets/variants/tray-d-authentic-plastic-175kg-540.jpg","kind":"variant","defaultCategory":"Variants","hero":{"jpg1080":"/assets/variants/tray-d-authentic-plastic-175kg-1080.jpg","webp1080":"/assets/variants/tray-d-authentic-plastic-175kg-1080.webp","jpg1400":"/assets/variants/tray-d-authentic-plastic-175kg-1400.jpg","jpg700":"/assets/variants/tray-d-authentic-plastic-175kg-700.jpg","jpg540":"/assets/variants/tray-d-authentic-plastic-175kg-540.jpg"},"square":{"jpg":"/assets/variants/tray-d-authentic-plastic-175kg-540.jpg"},"rotatable":true},{"id":"yolko-app-icon-1024","label":"yolko-app-icon-1024","preview":"/assets/yolko-app-icon-1024.png","kind":"brand","defaultCategory":"Brand","hero":{},"square":{"jpg":"/assets/yolko-app-icon-1024.png"},"rotatable":true}];
const DEFAULT_ASSET_CATEGORIES = ["Hero", "Product", "Brand", "Variants", "References", "Other"];
const DEFAULT_LIVE_ASSETS = ["chalk-tray/12", "chalk-tray/13", "chalk-tray/25", "chalk-tray/15"];

function registryById() {
  const map = Object.create(null);
  for (const item of ASSET_REGISTRY) map[item.id] = item;
  return map;
}

async function getAssetLibrary(env) {
  const stored = (await env.DATA.get("assets:library", "json")) || {};
  const byId = registryById();
  const categories = Array.isArray(stored.categories) && stored.categories.length
    ? stored.categories.map(String).filter(Boolean)
    : DEFAULT_ASSET_CATEGORIES.slice();
  for (const c of DEFAULT_ASSET_CATEGORIES) {
    if (!categories.includes(c)) categories.push(c);
  }
  const itemMeta = stored.items && typeof stored.items === "object" ? stored.items : {};
  const items = ASSET_REGISTRY.map((base) => {
    const meta = itemMeta[base.id] || {};
    const category = typeof meta.category === "string" && meta.category
      ? meta.category
      : base.defaultCategory;
    return {
      ...base,
      category,
      favorite: meta.favorite === true,
      deleted: meta.deleted === true,
    };
  });
  const cleanIds = (arr) => {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const id of arr) {
      if (typeof id !== "string" || !byId[id]) continue;
      if (out.includes(id)) continue;
      out.push(id);
    }
    return out;
  };
  let draft = cleanIds(stored.draft);
  let published = cleanIds(stored.published);
  if (!draft) draft = DEFAULT_LIVE_ASSETS.filter((id) => byId[id]);
  if (!published) published = draft.slice();
  // Drop deleted from selections
  const deleted = new Set(items.filter((i) => i.deleted).map((i) => i.id));
  draft = draft.filter((id) => !deleted.has(id));
  published = published.filter((id) => !deleted.has(id));
  return {
    categories,
    items,
    draft,
    published,
    publishedAt: typeof stored.publishedAt === "string" ? stored.publishedAt : null,
  };
}

async function saveAssetLibrary(env, lib) {
  const items = {};
  for (const it of lib.items) {
    const base = ASSET_REGISTRY.find((r) => r.id === it.id);
    const cat = it.category || (base && base.defaultCategory) || "Other";
    const favorite = it.favorite === true;
    const deleted = it.deleted === true;
    const defaultCat = (base && base.defaultCategory) || "Other";
    if (favorite || deleted || cat !== defaultCat) {
      items[it.id] = { category: cat, favorite, deleted };
    }
  }
  await env.DATA.put("assets:library", JSON.stringify({
    categories: lib.categories,
    items,
    draft: lib.draft,
    published: lib.published,
    publishedAt: lib.publishedAt,
  }));
}

function resolveLiveAssets(lib) {
  const byId = Object.fromEntries(lib.items.map((i) => [i.id, i]));
  const seenChalk = { hero: false };
  const out = [];
  for (const id of lib.published) {
    const it = byId[id];
    if (!it || it.deleted) continue;
    // Hide studio heroes until logos/artifacts are remade (no YOLKO on boxes).
    if (id === "studio-tray" || String(id).startsWith("studio-tray-")) continue;
    // Only one chalk slide. price swap handles $12–$20
    if (it.kind === "chalk") {
      if (seenChalk.hero) continue;
      seenChalk.hero = true;
    }
    out.push({
      id: it.id,
      label: it.label,
      kind: it.kind,
      chalkPrice: it.chalkPrice || null,
      preview: it.preview,
      hero: it.hero,
      square: it.square,
    });
  }
  return out;
}


const HOSTING_ASN_RE = /amazon|aws|google\s*(cloud|llc)|microsoft|azure|digitalocean|ovh|hetzner|linode|vultr|hosting|datacenter|data centre|\bvps\b|colocation|dedicated server/i;

const ALLOWED_ORIGINS = [
  "https://getyolko.com",
  "https://www.getyolko.com",
  "https://yolko-site.maruthi4a5.workers.dev",
];

function isAllowedOrigin(request) {
  const origin = String(request.headers.get("Origin") || "").replace(/\/$/, "");
  if (origin && ALLOWED_ORIGINS.includes(origin)) return true;
  const referer = String(request.headers.get("Referer") || "");
  if (ALLOWED_ORIGINS.some((a) => referer === a + "/" || referer.startsWith(a + "/"))) return true;
  return false;
}

async function issueOrderToken(env) {
  const token = crypto.randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
  const issuedAt = Date.now();
  await env.DATA.put(`otok:${token}`, JSON.stringify({ issuedAt }), { expirationTtl: 600 });
  return { token, issuedAt };
}

async function consumeOrderToken(env, token) {
  const t = String(token || "").trim();
  if (!/^[a-zA-Z0-9]{20,80}$/.test(t)) return { ok: false, reason: "missing" };
  const key = `otok:${t}`;
  const data = await env.DATA.get(key, "json");
  if (!data || !data.issuedAt) return { ok: false, reason: "invalid" };
  await env.DATA.delete(key);
  const age = Date.now() - Number(data.issuedAt);
  // No minimum age. Buy now must work immediately on every tap.
  if (age > 10 * 60 * 1000) return { ok: false, reason: "expired" };
  return { ok: true, age };
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    ""
  );
}

function clientMeta(request) {
  const cf = request.cf || {};
  const ua = String(request.headers.get("User-Agent") || "").slice(0, 160);
  return {
    country: String(cf.country || request.headers.get("CF-IPCountry") || "").toUpperCase() || null,
    asnOrg: String(cf.asOrganization || "").slice(0, 80) || null,
    colo: String(cf.colo || "").slice(0, 8) || null,
    ua: ua || null,
  };
}


function parseUa(ua) {
  const s = String(ua || "");
  let os = "Unknown";
  if (/Windows/i.test(s)) os = "Windows";
  else if (/Android/i.test(s)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/Linux/i.test(s)) os = "Linux";

  let browser = "Unknown";
  if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) browser = "Chrome";
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = "Safari";
  else if (/Firefox\//i.test(s)) browser = "Firefox";

  let deviceType = "desktop";
  if (/iPad|Tablet/i.test(s)) deviceType = "tablet";
  else if (/Mobi|Android|iPhone|iPod/i.test(s)) deviceType = "mobile";

  return { os, browser, deviceType };
}

function cleanVisitId(v) {
  const s = String(v || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(s)) return null;
  return s;
}

async function getVisitIndex(env) {
  const raw = await env.DATA.get("visits:index", "json");
  return Array.isArray(raw) ? raw : [];
}

async function pushVisitIndex(env, visitId) {
  const ids = await getVisitIndex(env);
  const next = [visitId, ...ids.filter((x) => x !== visitId)].slice(0, 800);
  await env.DATA.put("visits:index", JSON.stringify(next));
}

function enrichCfGeo(request) {
  const cf = request.cf || {};
  return {
    country: String(cf.country || request.headers.get("CF-IPCountry") || "").toUpperCase() || null,
    city: String(cf.city || "").slice(0, 80) || null,
    region: String(cf.region || cf.regionCode || "").slice(0, 80) || null,
    postalCode: String(cf.postalCode || "").slice(0, 16) || null,
    continent: String(cf.continent || "").slice(0, 8) || null,
    timezone: String(cf.timezone || "").slice(0, 64) || null,
    latitude: cf.latitude != null ? String(cf.latitude).slice(0, 16) : null,
    longitude: cf.longitude != null ? String(cf.longitude).slice(0, 16) : null,
    asnOrg: String(cf.asOrganization || "").slice(0, 80) || null,
    colo: String(cf.colo || "").slice(0, 8) || null,
  };
}

// Rolling-window rate limit stored in KV. Returns true if the request is allowed.
async function allowRate(env, key, limit, windowSec) {
  const id = `rl:${key}`;
  const now = Date.now();
  const data = (await env.DATA.get(id, "json")) || { hits: [] };
  const hits = (Array.isArray(data.hits) ? data.hits : []).filter((t) => now - t < windowSec * 1000);
  if (hits.length >= limit) return false;
  hits.push(now);
  await env.DATA.put(id, JSON.stringify({ hits }), { expirationTtl: windowSec + 120 });
  return true;
}


function stripeDetailsFromSession(session) {
  const pi = session?.payment_intent;
  const charge = pi && typeof pi === "object" ? pi.latest_charge : null;
  const receiptUrl =
    (charge && typeof charge === "object" && charge.receipt_url) ||
    session?.receipt_url ||
    null;
  const amount =
    Number.isFinite(Number(session?.amount_total)) ? Number(session.amount_total) / 100 : null;
  const actuallyPaid = session?.payment_status === "paid";
  // Only stamp paidAt from a real charge (or paid session). Never use session.created -
  // that made unpaid checkouts look paid in admin after hydrate.
  const paidAtSec = actuallyPaid
    ? ((charge && typeof charge === "object" && charge.created) || null)
    : null;
  return {
    sessionId: session?.id || null,
    paymentIntentId: typeof pi === "string" ? pi : pi?.id || null,
    paymentStatus: String(session?.payment_status || "unpaid"),
    receiptUrl,
    amountTotal: amount,
    currency: String(session?.currency || "aud").toUpperCase(),
    email: session?.customer_details?.email || session?.customer_email || null,
    cardBrand: charge?.payment_method_details?.card?.brand || null,
    cardLast4: charge?.payment_method_details?.card?.last4 || null,
    paidAt: paidAtSec ? new Date(paidAtSec * 1000).toISOString() : null,
  };
}

const STRIPE_BRAND = "YOLKO";
// Every email customers see or reply to is the Zoho mailbox. The old Gmail is only for Google.
const SHOP_EMAIL = "orders@getyolko.com";
const STRIPE_SUPPORT_EMAIL = SHOP_EMAIL;
// The shop's own line (phone-line.mjs), never a personal mobile (Kanna, 13 Nov 2026).
const STRIPE_SUPPORT_PHONE = LINE_NUMBER;
// Bump the version when the business profile above changes, so Stripe gets it again.
const STRIPE_BRAND_FLAG = "stripe:branded:yolko:4";

// Stripe's pay page in the shop's own look: cream page, yolk button, the logo. Stripe reads the
// pictures by their public address, so they must be live before they are named here, and a
// changed picture needs a new file name.
const STRIPE_LOOK = {
  "branding_settings[display_name]": STRIPE_BRAND,
  "branding_settings[background_color]": "#faf7f0",
  "branding_settings[button_color]": "#ffd32a",
  "branding_settings[border_style]": "rounded",
  "branding_settings[font_family]": "be_vietnam_pro",
  "branding_settings[logo][type]": "url",
  "branding_settings[logo][url]": "https://getyolko.com/assets/brand/pay/logo-1.png",
  "branding_settings[icon][type]": "url",
  "branding_settings[icon][url]": "https://getyolko.com/assets/brand/icon-512.png",
};
const STRIPE_LOOK_NOTE = "stripe:look:refused";
// The Stripe account's own branding, which its receipt page uses. Stripe paints the page in the
// brand colour, so it must be cream: on ink the ink logo vanished (Kanna rejected that on sight,
// 12 Nov 2026). The accent is the yolk. Keep these the same as the dashboard, or this puts them back.
const STRIPE_ACCOUNT_LOOK = { primary: "#faf7f0", secondary: "#ffd32a" };
const STRIPE_ACCOUNT_PICTURES = {
  icon: ["business_icon", "assets/brand/icon-512.png"],
  logo: ["business_logo", "assets/brand/pay/logo-1.png"],
};

/** Create a Checkout Session. The look is optional: if Stripe refuses it, the payment still goes ahead without it. */
async function postCheckoutSession(env, params) {
  const send = () =>
    fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }).then((r) => r.json());
  const session = await send();
  const looks = [...params.keys()].filter((k) => k.startsWith("branding_settings"));
  if (!session?.error || !looks.length) return session;
  for (const k of looks) params.delete(k);
  const plain = await send();
  if (!plain?.error) {
    // It worked without the look, so the look was the problem. Leave a note the admin can read.
    const note = `${session.error.param || ""} ${session.error.message || "refused"}`.trim().slice(0, 300);
    console.log("stripe refused the pay page look", note);
    await env.DATA.put(STRIPE_LOOK_NOTE, JSON.stringify({ at: new Date().toISOString(), note }), { expirationTtl: 30 * 24 * 3600 }).catch(() => null);
  }
  return plain;
}

/** Hand Stripe one of the shop's pictures and return its file id. Kept, so each picture is sent once. */
async function stripeBrandFile(env, purpose, path) {
  const key = `stripe:file:${purpose}:${path}`;
  const have = await env.DATA.get(key).catch(() => null);
  if (have) return have;
  const img = await fetch(`${UPSTREAM_ASSETS}/${path}`);
  if (!img.ok) return null;
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("file", new File([await img.arrayBuffer()], path.split("/").pop(), { type: "image/png" }));
  const resp = await fetch("https://files.stripe.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_KEY}` },
    body: form,
  });
  const file = await resp.json().catch(() => null);
  if (!file?.id) return null;
  await env.DATA.put(key, file.id).catch(() => null);
  return file.id;
}

/** Colours, icon and logo on the Stripe account, for its receipt page. Its own request, so a refusal here never undoes the business name. */
async function ensureStripeAccountLook(env) {
  const body = new URLSearchParams({
    "settings[branding][primary_color]": STRIPE_ACCOUNT_LOOK.primary,
    "settings[branding][secondary_color]": STRIPE_ACCOUNT_LOOK.secondary,
  });
  for (const [field, [purpose, path]] of Object.entries(STRIPE_ACCOUNT_PICTURES)) {
    const id = await stripeBrandFile(env, purpose, path).catch(() => null);
    if (id) body.set(`settings[branding][${field}]`, id);
  }
  const resp = await fetch("https://api.stripe.com/v1/account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const account = await resp.json().catch(() => null);
  if (!account || account.error) return { ok: false, error: account?.error?.message || "stripe error" };
  return { ok: true, ...stripeAccountLook(account) };
}

function stripeAccountLook(account) {
  const b = account?.settings?.branding || {};
  return {
    icon: Boolean(b.icon),
    logo: Boolean(b.logo),
    primaryColor: b.primary_color || null,
    secondaryColor: b.secondary_color || null,
  };
}

/** Ensure Checkout / receipts show YOLKO. not the personal Stripe account email. */
async function ensureStripeBranding(env) {
  if (!env.STRIPE_KEY) return { ok: false, error: "payments not configured" };
  const body = new URLSearchParams({
    "business_profile[name]": STRIPE_BRAND,
    "business_profile[support_email]": STRIPE_SUPPORT_EMAIL,
    "business_profile[support_phone]": STRIPE_SUPPORT_PHONE,
    "business_profile[support_url]": "https://getyolko.com",
    "business_profile[url]": "https://getyolko.com",
    "settings[payments][statement_descriptor]": STRIPE_BRAND,
  });
  const resp = await fetch("https://api.stripe.com/v1/account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const account = await resp.json();
  if (account.error) return { ok: false, error: account.error.message || "stripe error", account };
  const look = await ensureStripeAccountLook(env).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  // If the look did not take, try again tomorrow rather than on every checkout.
  await env.DATA.put(STRIPE_BRAND_FLAG, "1", { expirationTtl: (look.ok ? 30 : 1) * 24 * 3600 }).catch(() => null);
  return {
    ok: true,
    look,
    name: account.business_profile?.name || null,
    statementDescriptor: account.settings?.payments?.statement_descriptor || null,
    supportEmail: account.business_profile?.support_email || null,
    supportPhone: account.business_profile?.support_phone || null,
    supportUrl: account.business_profile?.support_url || null,
    email: account.email || null,
  };
}

/** Fire-and-forget branding unless we already did it recently. */
async function maybeEnsureStripeBranding(env, ctx) {
  const done = await env.DATA.get(STRIPE_BRAND_FLAG).catch(() => null);
  if (done) return;
  const job = ensureStripeBranding(env).catch(() => null);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
}

/** Build Stripe Checkout Session for an order using live admin prices. */
async function createCheckoutForOrder(env, order, settings, ctx) {
  const quantity = Math.min(20, Math.max(1, Math.floor(Number(order.quantity)) || 1));
  const bundle = isBundle(order.bundle) ? order.bundle : null;
  if (!bundle || !(Number(settings.prices[bundle]) > 0)) {
    return { error: "invalid order bundle", status: 400 };
  }
  // A variety can sell out between making the order and paying for it.
  const problem = stockProblem(settings, bundle, quantity);
  if (problem) return { error: problem.error, code: problem.code, status: 400 };

  const unitPrice = Number(settings.prices[bundle]);
  const subtotal = unitPrice * quantity;
  const isDelivery = order.fulfillment === "delivery";
  // A referral, same-building or earned free delivery is decided when the order is made.
  const deliveryFee = isDelivery
    ? (order.deliveryPerk ? 0 : Number(order.deliveryFee) > 0 ? Number(order.deliveryFee) : SITE_DELIVERY_FEE)
    : 0;
  const total = subtotal + deliveryFee;
  const unitAmount = Math.round(unitPrice * 100);

  order.quantity = quantity;
  order.subtotal = subtotal;
  order.deliveryFee = deliveryFee;
  order.price = total;

  const fulfillDesc = isDelivery
    ? `Saturday ${order.pickupDate || ""} delivery · ${order.deliveryAddress || "Sydney area"}${order.deliveryPerk ? " · Free delivery" : ""}`.trim()
    : `Pickup ${order.pickupDay}${order.pickupDate ? " " + order.pickupDate : ""} at Paddy's Markets Flemington`;

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "aud",
    "line_items[0][price_data][product_data][name]": bundleLabel(bundle),
    "line_items[0][price_data][product_data][description]": fulfillDesc,
    "line_items[0][price_data][unit_amount]": String(unitAmount),
    "line_items[0][quantity]": String(quantity),
    "metadata[orderId]": order.id,
    "metadata[bundle]": bundle,
    "metadata[quantity]": String(quantity),
    "metadata[subtotal]": String(subtotal),
    "metadata[deliveryFee]": String(deliveryFee),
    ...(order.deliveryPerk ? { "metadata[deliveryPerk]": order.deliveryPerk } : {}),
    success_url: "https://getyolko.com/?paid={CHECKOUT_SESSION_ID}",
    cancel_url: "https://getyolko.com/#order",
    ...STRIPE_LOOK,
  });
  if (deliveryFee > 0) {
    params.set("line_items[1][price_data][currency]", "aud");
    params.set("line_items[1][price_data][product_data][name]", "Saturday delivery");
    params.set("line_items[1][price_data][product_data][description]", "Flat fee on entire order");
    params.set("line_items[1][price_data][unit_amount]", String(Math.round(deliveryFee * 100)));
    params.set("line_items[1][quantity]", "1");
  }

  // One live session per order: a stale tab must not be able to pay for an
  // order that has since been edited. Check the previous session alongside
  // creating the new one so Buy now stays one round trip.
  const prevId = String(order.sessionId || "").startsWith("cs_") ? order.sessionId : null;
  const [prev, session] = await Promise.all([
    prevId ? fetchStripeSession(env, prevId).catch(() => null) : null,
    postCheckoutSession(env, params),
  ]);
  const prevGone = prev?.error?.code === "resource_missing";
  if (prevId && !prevGone && (!prev || prev.error)) {
    // Can't tell if the old session was paid: don't risk overwriting a payment.
    if (session?.id) runLater(ctx, expireStripeSession(env, session.id));
    return { error: "checkout failed", detail: "please try again", status: 502 };
  }
  if (prev?.payment_status === "paid") {
    // Already paid. `order` holds this request's edits, so never save it;
    // record the payment from a fresh copy only if the webhook clearly missed it.
    if (session?.id) runLater(ctx, expireStripeSession(env, session.id));
    if (mayRecordPaid(env, prev)) runLater(ctx, recordMissedPayment(env, order.id, prev));
    return { error: "already paid", alreadyPaid: true, status: 409 };
  }
  if (!session.url) {
    return { error: "checkout failed", detail: session.error?.message || null, status: 502 };
  }

  if (prev?.status === "open") runLater(ctx, expireStripeSession(env, prevId));
  order.paymentStatus = "pending";
  order.sessionId = session.id;
  await env.DATA.put(order.id, JSON.stringify(order));
  return { url: session.url, price: total, subtotal, deliveryFee, unitPrice, orderId: order.id };
}

// ---------------------------------------------------------------------------
// Payment confirmation: Stripe webhook + order confirmation email (ZeptoMail).
// Secrets: STRIPE_WEBHOOK_SECRET, ZEPTOMAIL_TOKEN, ORDER_EMAIL_FROM.
// Optional: ORDER_NOTIFY_EMAIL (shop copy), ZEPTOMAIL_API_URL (region host).

// Zoho CPaaS (same API as ZeptoMail). Override for other data centres, e.g.
// https://cpaas.zoho.eu/v1.1/email or https://api.zeptomail.com.au/v1.1/email.
const ZEPTOMAIL_DEFAULT_URL = "https://cpaas.zoho.com/v1.1/email";
const STRIPE_SIG_TOLERANCE_SEC = 300;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Verify a Stripe-Signature header (t=...,v1=...) against the raw body. */
async function verifyStripeSignature(payload, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const [k, v] = part.split("=", 2).map((s) => (s || "").trim());
    if (k === "t") t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSec - t) > STRIPE_SIG_TOLERANCE_SEC) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = new TextEncoder().encode(`${t}.${payload}`);
  for (const sig of sigs) {
    if (await crypto.subtle.verify("HMAC", key, hexToBytes(sig), signed)) return true;
  }
  return false;
}

async function fetchStripeSession(env, sid) {
  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}?expand[]=payment_intent.latest_charge`,
    { headers: { Authorization: `Bearer ${env.STRIPE_KEY}` } }
  );
  return resp.json();
}

/** Refunds are terminal: a late webhook or success page must not revive them. */
function isRefunded(order, session) {
  const charge = session?.payment_intent?.latest_charge;
  return (
    order?.paymentStatus === "refunded" ||
    Boolean(order?.stripe?.refundId) ||
    Boolean(charge && typeof charge === "object" && charge.refunded === true)
  );
}

/**
 * The order can be edited after a Checkout Session was created (Reserve, or a
 * retry that reused the order). Record what was actually paid for.
 */
function alignOrderWithSession(order, session) {
  const md = session?.metadata || {};
  if (session?.id) order.sessionId = session.id;
  // Sessions created before metadata[quantity] existed can't be aligned safely.
  const qty = Math.floor(Number(md.quantity));
  if (!(qty >= 1) || !isBundle(md.bundle)) return order;
  order.bundle = md.bundle;
  order.quantity = qty;
  if (md.subtotal !== undefined && Number.isFinite(Number(md.subtotal))) order.subtotal = Number(md.subtotal);
  if (md.deliveryFee !== undefined && Number.isFinite(Number(md.deliveryFee))) order.deliveryFee = Number(md.deliveryFee);
  const paid = Number(session?.amount_total) / 100;
  if (Number.isFinite(paid)) order.price = paid;
  return order;
}

// With the webhook configured, other paths only record a payment it has
// clearly missed: one old enough that KV copies everywhere have settled.
const WEBHOOK_GRACE_SEC = 600;

function paymentAgeSec(session) {
  const charge = session?.payment_intent?.latest_charge;
  const created = charge && typeof charge === "object" ? Number(charge.created) : NaN;
  return Number.isFinite(created) ? Date.now() / 1000 - created : null;
}

function mayRecordPaid(env, session) {
  if (!env.STRIPE_WEBHOOK_SECRET) return true;
  const age = paymentAgeSec(session);
  return age !== null && age > WEBHOOK_GRACE_SEC;
}

function runLater(ctx, promise) {
  const job = Promise.resolve(promise).catch((err) => console.log("background job failed", String(err?.message || err)));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  return job;
}

function expireStripeSession(env, sid) {
  return fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}/expire`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_KEY}` },
  });
}

/** Order as it looks once this session is paid (no KV writes). */
function paidView(order, session) {
  const view = { ...order, paymentStatus: "paid", stripe: { ...(order.stripe || {}), ...stripeDetailsFromSession(session) } };
  return alignOrderWithSession(view, session);
}

/** Idempotently mark an order paid from a paid Checkout Session. */
async function markOrderPaid(env, order, session) {
  if (isRefunded(order, session)) return { order, newlyPaid: false, refunded: true };
  if (order.paymentStatus !== "paid") {
    const held = heldBy(order);
    alignOrderWithSession(order, session);
    // Stock already held (admin confirmed first) for other items: move it.
    const now = holdFor(order);
    if (order.stockTaken && (held.variety !== now.variety || held.units !== now.units)) {
      const settings = await getSettings(env);
      if (held.variety) addStock(settings, held.variety, held.units);
      if (now.variety) addStock(settings, now.variety, -now.units);
      await putStock(env, settings);
      order.stockHeld = now;
    }
    order.paymentStatus = "paid";
    order.stripe = { ...(order.stripe || {}), ...stripeDetailsFromSession(session) };
    // Paid customers jump the queue: auto-confirm and allocate trays.
    if (order.status === "new" || order.status === "cancelled") order.status = "confirmed";
    await syncStock(env, order, order.status);
    await env.DATA.put(order.id, JSON.stringify(order));
    // The admin rings for an order once it is paid, not when checkout opens: orders-head carries this.
    await env.DATA.put("orders:lastpaid", `${order.id}|${Date.now()}`).catch(() => null);
    if (order.phone) await clearOpenOrder(env, order.phone, order.id);
    await noteReminderOrder(env, order).catch((err) => console.log("reminder signup failed", order.id, String(err?.message || err)));
    await noteReferralOrder(env, order).catch((err) => console.log("referral note failed", order.id, String(err?.message || err)));
    return { order, newlyPaid: true };
  }
  if (!order.stripe?.amountTotal) {
    order.stripe = { ...(order.stripe || {}), ...stripeDetailsFromSession(session) };
    await env.DATA.put(order.id, JSON.stringify(order));
  }
  return { order, newlyPaid: false };
}

function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function orderRef(order) {
  return String(order.id || "").slice(-6).toUpperCase();
}

// Customer emails wear the brand: the Brush egg logo on a white card, one yolk brush stroke under
// the word that matters, a yolk button, and a black band to close. Colours and type are the
// site's. The pictures are small PNGs on getyolko.com (mail apps do not draw SVG): the logo, the
// egg and the heading each sit on their own rounded plate, so they still read when a phone's dark
// mode recolours the email around them. Bump the number in a file's name if its picture ever
// changes, because mail apps keep their copy for good. Gmail never loads a web font, so the rest
// of an email shows in the phone's own font there; that is why the heading is a picture
// (infra/email-titles.mjs).
const EMAIL_C = { canvas: "#faf7f0", paper: "#ffffff", ink: "#14120e", ink2: "#3d3b36", muted: "#6b675e", line: "#e6e0d2", subtle: "#f3eee2", yellow: "#ffd32a" };
// Single quotes only: this sits inside style="..." attributes.
// The words: the brand font where a mail app loads it (Apple Mail). Gmail never does, and only
// shows fonts the device already has, so next comes Apple's rounded font (`ui-rounded`: iPhone,
// iPad and Mac), which Kanna picked on 12 Nov 2026 from four drawn options. Other devices fall
// through to their own font, as before.
const EMAIL_FONT = `'Plus Jakarta Sans',ui-rounded,'SF Pro Rounded',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
// WhatsApp Business is not live on the shop's line yet, so the emails ask for a reply only.
// Once it is live, set this to `https://wa.me/${LINE_NUMBER.replace(/\D/g, "")}`.
const EMAIL_WA = "";
const EMAIL_HELP_TEXT = EMAIL_WA ? `Questions? Reply to this email or WhatsApp us: ${EMAIL_WA}` : "Questions? Reply to this email.";
const EMAIL_IMG = "https://getyolko.com/assets/brand/email";

/**
 * The quiet list every customer email is built on (Kanna picked it on 12 Nov 2026): a sand box
 * with one row per fact, a muted name on the left and the answer in bold on the right.
 * `rows` are [name, answer as HTML] pairs; empty entries are skipped.
 */
function emailList(rows) {
  const C = EMAIL_C;
  const list = rows.filter(Boolean);
  const body = list
    .map(([name, value], i) => {
      const rule = i === list.length - 1 ? "" : `border-bottom:1px solid ${C.line};`;
      return `<tr><td valign="top" style="padding:11px 0;${rule}font-size:15px;line-height:22px;color:${C.muted};white-space:nowrap">${htmlEscape(name)}</td><td valign="top" align="right" style="padding:11px 0 11px 12px;${rule}font-size:15px;line-height:22px;font-weight:700;color:${C.ink}">${value}</td></tr>`;
    })
    .join("\n");
  return `<tr><td style="padding-top:16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.subtle};border-radius:14px"><tr><td style="padding:6px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${body}
</table></td></tr></table></td></tr>`;
}

/** The plain second line of a list answer (HTML). */
function emailUnder(text) {
  return `<span style="display:block;font-weight:400;color:${EMAIL_C.ink2}">${htmlEscape(text)}</span>`;
}

/** A list answer in bigger type, for the amount that matters (HTML). */
function emailBig(text) {
  return `<span style="font-size:18px;font-weight:800;letter-spacing:-0.3px">${htmlEscape(text)}</span>`;
}

/**
 * The item line: "2 egg trays (60 eggs)", or "3 x Egg tray (30 eggs)" for more than one. The
 * words in brackets stay together, so a narrow phone wraps before the bracket, not inside it.
 */
function emailItem(quantity, label) {
  const name = String(label).replace(/\([^)]*\)/g, (m) => m.replace(/ /g, "\u00a0"));
  return quantity > 1 ? `${quantity} x ${name}` : name;
}

/**
 * The price line under an item: "$25.00 + $5.00 delivery". No-break spaces keep
 * "+ $5.00 delivery" together, so a narrow phone that has to wrap the line breaks it after the
 * first amount.
 */
function emailPriceLine(subtotal, deliveryFee, free) {
  if (free) return `${money(subtotal)} +\u00a0free\u00a0delivery`;
  return Number(deliveryFee) > 0 ? `${money(subtotal)} +\u00a0${money(deliveryFee)}\u00a0delivery` : money(subtotal);
}

/** The same button across the whole width of its box (HTML, not a table row). */
function emailWideButton(href, label) {
  const C = EMAIL_C;
  return `<a href="${htmlEscape(href)}" style="display:block;text-align:center;background:${C.yellow};color:${C.ink};text-decoration:none;font-weight:700;font-size:16px;line-height:22px;padding:14px 20px;border-radius:999px">${htmlEscape(label)}</a>`;
}

/**
 * An email's heading with the yolk brush stroke under `mark`, one word of it. The stroke is a
 * background picture, so a mail app that skips those (desktop Outlook) shows the plain heading.
 */
function emailTitle(title, mark) {
  const t = String(title);
  const i = mark ? t.indexOf(mark) : -1;
  if (i < 0) return htmlEscape(t);
  return `${htmlEscape(t.slice(0, i))}<span style="white-space:nowrap;background-image:url(${EMAIL_IMG}/underline-1.png);background-repeat:no-repeat;background-position:50% 100%;background-size:100% 12px">${htmlEscape(mark)}</span>${htmlEscape(t.slice(i + mark.length))}`;
}

/**
 * A whole customer email: the logo and a small `label` on top, the heading (a picture in the
 * brand font when infra/email-titles.mjs has one, text otherwise), `rows` (table rows inside the
 * white card; the first one needs no space above it), the black band with the help line, then
 * the sign-off: the site and the shop's address, as links. `why` (HTML) goes under it on emails
 * that are not about an order: why this person got it and how to stop it.
 */
function emailFrame({ subject, preheader, label = "", title, mark = "", rows, help, why = "" }) {
  const C = EMAIL_C;
  const FONT = EMAIL_FONT;
  const side = `background:${C.paper};border-left:1px solid ${C.line};border-right:1px solid ${C.line}`;
  const pic = emailTitlePicture(title, mark);
  // The picture carries 12px of its own room on every side, so its words line up with the rows.
  const head = pic
    ? `<tr><td style="${side};padding:16px 12px 0"><img src="${EMAIL_IMG}/${pic.file}" width="${pic.width}" height="${pic.height}" alt="${htmlEscape(title)}" style="display:block;width:100%;max-width:${pic.width}px;height:auto;border:0;outline:none;font-family:${FONT};font-size:26px;line-height:34px;font-weight:800;letter-spacing:-0.8px;color:${C.ink}"></td></tr>`
    : `<tr><td style="${side};padding:28px 24px 12px;font-family:${FONT};font-size:28px;line-height:34px;font-weight:800;color:${C.ink};letter-spacing:-0.8px">${emailTitle(title, mark)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${htmlEscape(subject)}</title>
<style>@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:400 800;src:url(https://getyolko.com/assets/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2) format("woff2")}</style></head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.canvas}">${htmlEscape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};font-family:${FONT}"><tr><td align="center" style="padding:28px 12px 32px;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;font-family:${FONT}">
<tr><td style="background:${C.paper};border:1px solid ${C.line};border-radius:16px 16px 0 0;padding:12px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><a href="https://getyolko.com" style="text-decoration:none"><img src="${EMAIL_IMG}/logo-1.png" width="138" height="50" alt="YOLKO" style="display:block;border:0;outline:none;font-family:${FONT};font-size:20px;line-height:50px;font-weight:800;color:${C.ink}"></a></td>
<td align="right" style="padding-right:8px;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.muted}">${htmlEscape(label)}</td>
</tr></table>
</td></tr>
${head}
<tr><td style="${side};padding:${pic ? 4 : 0}px 24px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${rows}
</table>
</td></tr>
<tr><td style="background:${C.ink};border-radius:0 0 16px 16px;padding:14px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="43" valign="middle"><img src="${EMAIL_IMG}/egg-1.png" width="43" height="48" alt="" style="display:block;border:0;outline:none"></td>
<td valign="middle" style="padding-left:12px;font-family:${FONT};font-size:14px;line-height:20px;color:#ffffff">${htmlEscape(help)} Reply to this email${EMAIL_WA ? ` or message us on <a href="${EMAIL_WA}" style="color:#ffffff;text-decoration:underline">WhatsApp</a>` : ""}.</td>
</tr></table>
</td></tr>
<tr><td align="center" style="padding:20px 12px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted}"><a href="https://getyolko.com" style="color:${C.muted};text-decoration:underline">getyolko.com</a> &nbsp;·&nbsp; <a href="mailto:${SHOP_EMAIL}" style="color:${C.muted};text-decoration:underline">${SHOP_EMAIL}</a></td></tr>
${why ? `<tr><td align="center" style="padding:16px 12px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted}">${why}</td></tr>` : ""}
</table>
</td></tr></table></body></html>`;
}

function buildOrderEmail(order) {
  const first = String(order.name || "").split(/\s+/)[0] || "there";
  const item = bundleLabel(order.bundle);
  const qty = Math.max(1, Number(order.quantity) || 1);
  const total = order.stripe?.amountTotal != null ? order.stripe.amountTotal : order.price;
  const when = `Saturday${order.pickupDate ? " " + order.pickupDate : ""}`;
  const where = order.deliveryAddress || "Your delivery address";
  const ref = orderRef(order);
  const receipt = order.stripe?.receiptUrl || "";
  const subject = `Your YOLKO order is confirmed (#${ref})`;
  const C = EMAIL_C;
  const preheader = `Order #${ref} is confirmed. Delivery on ${when}, ${DELIVERY_HOURS}.`;

  const html = emailFrame({
    subject,
    preheader,
    label: `Order #${ref}`,
    title: "Your eggs are booked for Saturday",
    mark: "Saturday",
    help: "Need to change something?",
    rows: `<tr><td style="font-size:16px;line-height:24px;color:${C.ink2}">Thanks, ${htmlEscape(first)}. We have your payment.</td></tr>
${emailList([
  ["Delivery", `${htmlEscape(when)}${emailUnder(DELIVERY_HOURS)}`],
  order.deliveryAddress ? ["Address", htmlEscape(where)] : null,
  ["Your order", `${htmlEscape(emailItem(qty, item))}${order.subtotal != null ? emailUnder(emailPriceLine(order.subtotal, order.deliveryFee, !(Number(order.deliveryFee) > 0) && !!order.deliveryPerk)) : ""}`],
  ["Total paid", emailBig(`${money(total)} AUD`)],
])}
${receipt ? `<tr><td style="padding-top:16px">${emailWideButton(receipt, "View receipt")}</td></tr>` : ""}`,
  });

  const text = [
    `Thanks, ${first}. Your eggs are booked for Saturday.`,
    "",
    `Order #${ref}`,
    `${qty} x ${item}`,
    order.subtotal != null ? `Subtotal: ${money(order.subtotal)}` : null,
    Number(order.deliveryFee) > 0 ? `Delivery: ${money(order.deliveryFee)}` : order.deliveryPerk ? "Delivery: Free" : null,
    `Total paid: ${money(total)} AUD`,
    "",
    `Delivery: ${when}, ${DELIVERY_HOURS}`,
    where,
    receipt ? `\nReceipt: ${receipt}` : null,
    "",
    EMAIL_HELP_TEXT,
    "YOLKO · getyolko.com",
  ].filter((l) => l !== null).join("\n");

  return { subject, html, text };
}

function buildRefundEmail(order, refund) {
  const first = String(order.name || "").split(/\s+/)[0] || "there";
  const item = bundleLabel(order.bundle);
  const qty = Math.max(1, Number(order.quantity) || 1);
  const ref = orderRef(order);
  const amount = money(refund.amount);
  const currency = String(refund.currency || "AUD").toUpperCase();
  const paid = order.stripe?.amountTotal != null ? order.stripe.amountTotal : order.price;
  const partial = Number(refund.amount) + 0.001 < Number(paid);
  // completes: this refund pays back everything left after earlier partial refunds.
  const rest = partial && refund.completes;
  const card = order.stripe?.cardLast4
    ? `${order.stripe.cardBrand ? order.stripe.cardBrand.toUpperCase() + " " : ""}card ending ${order.stripe.cardLast4}`
    : "your original payment method";
  const subject = `Your YOLKO refund (#${ref})`;
  const lead = rest
    ? `We've refunded the rest of your order, ${amount} ${currency}.`
    : partial
      ? `We've refunded part of your order, ${amount} ${currency}.`
      : `We've refunded your order in full, ${amount} ${currency}.`;
  const timing = "Refunds usually take 5 to 10 business days to reach your account, depending on your bank.";
  const C = EMAIL_C;

  const html = emailFrame({
    subject,
    preheader: `Your refund of ${amount} for order #${ref} is on its way.`,
    label: `Order #${ref}`,
    title: "Your refund is on its way",
    mark: "refund",
    help: "Questions about your refund?",
    rows: `<tr><td style="font-size:16px;line-height:24px;color:${C.ink2}">Hi ${htmlEscape(first)}, ${rest ? "the rest of your order is refunded" : partial ? "part of your order is refunded" : "your order is refunded in full"}.</td></tr>
${emailList([
  ["Your order", htmlEscape(emailItem(qty, item))],
  partial && paid != null ? ["Paid", htmlEscape(`${money(paid)} AUD`)] : null,
  ["Refunded to", htmlEscape((card.charAt(0).toUpperCase() + card.slice(1)).replace(/ ending (\w+)$/, " ending\u00a0$1"))],
  ["Refund", emailBig(`${amount} ${currency}`)],
])}
<tr><td style="padding-top:12px;font-size:14px;line-height:21px;color:${C.muted}">${htmlEscape(timing)}</td></tr>`,
  });

  const text = [
    `Hi ${first}, your refund is on its way.`,
    "",
    lead,
    timing,
    "",
    `Order #${ref}`,
    `${qty} x ${item}`,
    partial && paid != null ? `Paid: ${money(paid)} AUD` : null,
    `Refunded to: ${card}`,
    `Amount refunded: ${amount} ${currency}`,
    "",
    EMAIL_HELP_TEXT,
    "YOLKO · getyolko.com",
  ].filter((l) => l !== null).join("\n");

  return { subject, html, text };
}

/**
 * Send the confirmation via ZeptoMail. Returns { ok, skipped?, error? }.
 * test: admin sample send, marked [Test] in the subject and never copied to the shop.
 */
async function sendOrderConfirmationEmail(env, order, { test = false } = {}) {
  return sendCustomerEmail(env, order, buildOrderEmail(order), { test });
}

/**
 * Subject of an admin sample: "[Test 9:31pm] ...", Sydney time. The time makes each sample its
 * own conversation in Gmail. With a bare "[Test]" a second sample landed under the first one,
 * and Gmail folded its whole body away as a repeat ("Show trimmed content").
 */
function testSubject(subject, now = new Date()) {
  const time = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit", hour12: true })
    .format(now)
    .replace(/\s+/g, "")
    .toLowerCase();
  return `[Test ${time}] ${subject}`;
}

/** Send one YOLKO email to the order's customer through Zoho CPaaS (the ZeptoMail API). */
async function sendCustomerEmail(env, order, { subject, html, text }, { test = false } = {}) {
  const token = String(env.ZEPTOMAIL_TOKEN || "").trim();
  const from = String(env.ORDER_EMAIL_FROM || "").trim();
  const to = String(order.stripe?.email || order.email || "").trim();
  if (!token || !from) return { ok: false, skipped: true, reason: "email not configured" };
  if (!to) return { ok: false, skipped: true, reason: "no customer email" };

  const payload = {
    from: { address: from, name: STRIPE_BRAND },
    to: [{ email_address: { address: to, name: order.name || "" } }],
    reply_to: [{ address: SHOP_EMAIL, name: STRIPE_BRAND }],
    subject: test ? testSubject(subject) : subject,
    htmlbody: html,
    textbody: text,
  };
  const notify = String(env.ORDER_NOTIFY_EMAIL || "").trim();
  if (!test && notify && notify.toLowerCase() !== to.toLowerCase()) {
    payload.bcc = [{ email_address: { address: notify, name: STRIPE_BRAND } }];
  }

  let resp;
  try {
    resp = await fetch(String(env.ZEPTOMAIL_API_URL || ZEPTOMAIL_DEFAULT_URL), {
      method: "POST",
      headers: {
        Authorization: `Zoho-enczapikey ${token.replace(/^Zoho-enczapikey\s+/i, "")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, transient: true, error: String(err?.message || err).slice(0, 300) };
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const error = data?.error?.details?.[0]?.message || data?.error?.message || `HTTP ${resp.status}`;
    return { ok: false, transient: resp.status >= 500 || resp.status === 429, error: String(error).slice(0, 300) };
  }
  return { ok: true, to, requestId: data?.request_id || null };
}

const refundEmailKey = (refundId) => `email:refund:${refundId}`;
const refundTryKey = (refundId) => `email:refund:try:${refundId}`;

// Refunds made before this (when refund emails and charge.refunded handling
// went live) are never emailed or recorded retroactively.
const REFUND_EMAIL_LAUNCH = Date.parse("2026-11-03T08:45:00Z");

/**
 * Email the customer about one refund, once. Each refund has a single sender
 * and a single retry path: the admin Refund button for refunds it creates
 * (retried by the cron), the webhook for refunds made in the Stripe
 * dashboard (retried by Stripe redelivering). The marker stops resends.
 */
async function maybeSendRefundEmail(env, order, refund) {
  if (!emailConfigured(env)) return { ok: false, skipped: true, reason: "email not configured" };
  if (!refund?.id || !(Number(refund.amount) > 0)) return { ok: false, skipped: true, reason: "no refund" };
  const key = refundEmailKey(refund.id);
  if (await env.DATA.get(key)) return { ok: true, already: true };
  const result = await sendCustomerEmail(env, order, buildRefundEmail(order, refund)).catch((err) => ({
    ok: false,
    error: String(err?.message || err),
  }));
  try {
    if (result.ok) {
      await env.DATA.put(key, JSON.stringify({ sentAt: new Date().toISOString(), to: result.to, requestId: result.requestId, orderId: order.id }));
    } else {
      console.log("refund email not sent", order.id, refund.id, result.error || result.reason);
      const prev = (await env.DATA.get(refundTryKey(refund.id), "json")) || {};
      await env.DATA.put(
        refundTryKey(refund.id),
        JSON.stringify({ orderId: order.id, attempts: (prev.attempts || 0) + 1, lastTriedAt: new Date().toISOString(), lastError: result.error || result.reason }),
        { expirationTtl: 4 * 24 * 3600 }
      );
    }
  } catch (err) {
    // Bookkeeping only; never turn a sent email into a failure.
    console.log("refund email bookkeeping failed", refund.id, String(err?.message || err));
  }
  return result;
}

/**
 * Cron retry for failed admin refund emails, found by their try keys so an
 * order's place in the order index doesn't matter. Dashboard refunds retry
 * through Stripe redelivering instead.
 */
async function retryRefundEmails(env, now) {
  const listed = await env.DATA.list({ prefix: refundTryKey("") }).catch(() => null);
  for (const { name } of listed?.keys || []) {
    const refundId = name.slice(refundTryKey("").length);
    const tries = await env.DATA.get(name, "json").catch(() => null);
    if (!tries?.orderId || (tries.attempts || 0) >= EMAIL_MAX_ATTEMPTS) continue;
    if (now - (Date.parse(tries.lastTriedAt || "") || 0) < 10 * 60000) continue;
    const order = await env.DATA.get(tries.orderId, "json").catch(() => null);
    const s = order?.stripe || {};
    const refundedAt = Date.parse(s.refundedAt || "") || 0;
    if (order?.paymentStatus !== "refunded" || s.refundId !== refundId || s.refundSource === "stripe") continue;
    if (refundedAt < REFUND_EMAIL_LAUNCH || now - refundedAt < WEBHOOK_GRACE_SEC * 1000 || now - refundedAt > 3 * 24 * 3600 * 1000) continue;
    if (await env.DATA.get(refundEmailKey(refundId))) continue;
    await maybeSendRefundEmail(env, order, { id: refundId, amount: s.refundAmount, currency: s.refundCurrency, completes: true })
      .catch((err) => console.log("refund email retry failed", tries.orderId, String(err?.message || err)));
  }
}

async function stripeGet(env, path, timeoutMs = 10000) {
  try {
    const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await resp.json();
  } catch (err) {
    return { error: { message: String(err?.message || err) } };
  }
}

const liveRefunds = (charge) =>
  (charge?.refunds?.data || []).filter((r) => r.status !== "failed" && r.status !== "canceled");
// Refunds the charge.refunded webhook records and emails: made outside the
// admin (the Refund button tags its refunds with metadata.orderId) since launch.
const webhookRefunds = (charge) =>
  liveRefunds(charge).filter((r) => !r.metadata?.orderId && Number(r.created) * 1000 >= REFUND_EMAIL_LAUNCH);
const hasAdminRefund = (charge) => liveRefunds(charge).some((r) => r.metadata?.orderId);

/** A paid order's charge with its refunds, or null. */
async function fetchChargeWithRefunds(env, { paymentIntentId, chargeId }, timeoutMs) {
  if (paymentIntentId) {
    const pi = await stripeGet(env, `payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.refunds`, timeoutMs);
    return pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  }
  if (chargeId) {
    const charge = await stripeGet(env, `charges/${encodeURIComponent(chargeId)}?expand[]=refunds`, timeoutMs);
    return charge.error ? null : charge;
  }
  return null;
}

/**
 * A full refund made in the Stripe dashboard in the last WEBHOOK_GRACE_SEC.
 * The webhook records it (status and stock), and this location's copy of the
 * order may not show that yet: admin paths must not apply it a second time.
 */
function webhookRefundPending(charge) {
  const own = webhookRefunds(charge);
  if (charge?.refunded !== true || !own.length || hasAdminRefund(charge)) return false;
  return Date.now() / 1000 - Math.max(...own.map((r) => Number(r.created) || 0)) < WEBHOOK_GRACE_SEC;
}

/**
 * charge.refunded: record refunds made outside the admin (Stripe dashboard)
 * and email the customer. Refunds created by /api/refund carry
 * metadata.orderId; that path records and emails them itself.
 */
async function handleChargeRefunded(env, chargeId) {
  if (!/^(ch|py)_/.test(String(chargeId || ""))) return { ignored: "no charge" };
  const charge = await stripeGet(env, `charges/${encodeURIComponent(chargeId)}?expand[]=refunds`);
  if (charge.error) return { error: charge.error.message || "stripe error" };
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return { ignored: "no payment intent" };
  const external = webhookRefunds(charge);
  if (!external.length) return { ignored: "no dashboard refunds" };
  const sessions = await stripeGet(env, `checkout/sessions?payment_intent=${encodeURIComponent(piId)}&limit=1`);
  if (sessions.error) return { error: sessions.error.message || "stripe error" };
  const orderId = sessions.data?.[0]?.metadata?.orderId;
  if (!String(orderId || "").startsWith("order:")) return { ignored: "no order" };
  const order = await env.DATA.get(orderId, "json");
  if (!order) return { ignored: "order not found" };
  // A refund of a second payment for the same order (a duplicate checkout)
  // leaves the order, its stock and the customer's emails alone.
  if (order.stripe?.paymentIntentId && order.stripe.paymentIntentId !== piId) return { ignored: "not the order's payment" };

  const currency = String(charge.currency || "aud").toUpperCase();
  const amountRefunded = Number(charge.amount_refunded) / 100;
  if (hasAdminRefund(charge)) {
    // The admin Refund button finished this charge and records the order itself.
  } else if (charge.refunded === true && order.paymentStatus !== "refunded") {
    order.paymentStatus = "refunded";
    order.status = "cancelled";
    order.stripe = {
      ...(order.stripe || {}),
      refundId: external[0].id,
      refundStatus: external[0].status,
      refundAmount: amountRefunded,
      refundCurrency: currency,
      refundedAt: new Date().toISOString(),
      refundSource: "stripe",
    };
    await syncStock(env, order, "cancelled");
    await env.DATA.put(orderId, JSON.stringify(order));
  } else if (order.stripe?.amountRefunded !== amountRefunded) {
    order.stripe = { ...(order.stripe || {}), amountRefunded, refundCurrency: currency };
    await env.DATA.put(orderId, JSON.stringify(order));
  }
  // The newest refund on a fully refunded charge pays back whatever was left.
  const newest = liveRefunds(charge).reduce((a, r) => (!a || Number(r.created) > Number(a.created) ? r : a), null);
  let sent = 0;
  let failed = 0;
  for (const r of external) {
    const completes = charge.refunded === true && r.id === newest?.id;
    const res = await maybeSendRefundEmail(env, order, { id: r.id, amount: Number(r.amount) / 100, currency, completes });
    if (res.ok && !res.already) sent++;
    else if (!res.ok && res.transient) failed++;
  }
  // Stripe redelivers on an error response: the order writes above are
  // idempotent and the markers stop resending emails that went out.
  if (failed) return { orderId, emailsSent: sent, error: "refund email failed" };
  return { orderId, refunds: external.length, emailsSent: sent };
}

/** Record a payment the live paths missed, from a fresh copy, and email the customer. */
async function recordMissedPayment(env, orderId, session) {
  const order = await env.DATA.get(orderId, "json");
  if (!order) return null;
  const result = await markOrderPaid(env, order, session);
  if (result.newlyPaid) {
    await maybeSendOrderEmail(env, orderId);
    console.log("recorded missed payment", orderId);
  }
  return result;
}

function emailConfigured(env) {
  return Boolean(String(env.ZEPTOMAIL_TOKEN || "").trim() && String(env.ORDER_EMAIL_FROM || "").trim());
}

// Side-effect markers live in their own keys: whole-order writes from other
// paths (possibly from a stale KV copy) must not erase them.
const emailSentKey = (orderId) => `email:sent:${orderId}`;
const metaSentKey = (orderId) => `meta:sent:${orderId}`;
const EMAIL_MAX_ATTEMPTS = 4;

/**
 * Send the confirmation once per order. The short claim key stops a double
 * send when two paths race in the same location; the sent marker is the
 * record of truth.
 */
async function maybeSendOrderEmail(env, orderId, { force = false } = {}) {
  if (!emailConfigured(env)) return { ok: false, skipped: true, reason: "email not configured" };
  const order = await env.DATA.get(orderId, "json");
  if (!order || order.paymentStatus !== "paid") return { ok: false, skipped: true, reason: "not paid" };
  const claimKey = `email:claim:${orderId}`;
  if (!force) {
    if (order.status === "cancelled") return { ok: false, skipped: true, reason: "cancelled" };
    if (order.confirmationEmail?.sentAt || (await env.DATA.get(emailSentKey(orderId)))) {
      return { ok: true, already: true };
    }
    if (await env.DATA.get(claimKey)) return { ok: false, inProgress: true };
    await env.DATA.put(claimKey, "1", { expirationTtl: 120 });
  }
  const result = await sendOrderConfirmationEmail(env, order).catch((err) => ({
    ok: false,
    transient: true,
    error: String(err?.message || err),
  }));
  const now = new Date().toISOString();
  try {
    if (result.ok) {
      await env.DATA.put(emailSentKey(orderId), JSON.stringify({ sentAt: now, to: result.to, requestId: result.requestId }));
      await rememberEmailForEvents(env, order, result.requestId);
    }
    const fresh = (await env.DATA.get(orderId, "json")) || order;
    const prev = fresh.confirmationEmail || {};
    fresh.confirmationEmail = result.ok
      ? { sentAt: now, to: result.to, requestId: result.requestId, attempts: (prev.attempts || 0) + 1 }
      : { ...prev, lastError: result.error || result.reason, lastTriedAt: now, attempts: (prev.attempts || 0) + 1 };
    await env.DATA.put(orderId, JSON.stringify(fresh));
  } catch (err) {
    // Bookkeeping only; never turn a sent email into a failure.
    console.log("order email bookkeeping failed", orderId, String(err?.message || err));
  }
  if (!result.ok) {
    if (!force) await env.DATA.delete(claimKey).catch(() => null);
    console.log("order email not sent", orderId, result.error || result.reason);
  }
  return result;
}

// Orders paid before this (when sends began writing the email:sent marker)
// are never emailed retroactively.
const ORDER_EMAIL_LAUNCH = Date.parse("2026-10-22T10:57:00Z");

/** One row of the admin Emails page: what happened to this order's confirmation. */
function orderEmailEntry(order, marker) {
  const ce = order.confirmationEmail || {};
  const sentAt = ce.sentAt || marker?.sentAt || null;
  const to = String(ce.to || marker?.to || order.stripe?.email || order.email || "").trim();
  const paidAt = order.stripe?.paidAt || null;
  let status = "not_sent";
  let reason = null;
  if (sentAt) status = "sent";
  else if (ce.lastError) {
    status = "failed";
    reason = String(ce.lastError);
  } else if (!to) reason = "no_email";
  else if (!(Date.parse(paidAt || "") > ORDER_EMAIL_LAUNCH)) reason = "before_launch";
  else reason = "pending";
  return {
    orderId: order.id,
    ref: orderRef(order),
    name: order.name || "",
    to,
    status,
    reason,
    sentAt,
    requestId: ce.requestId || marker?.requestId || null,
    attempts: ce.attempts || 0,
    lastTriedAt: ce.lastTriedAt || null,
    paidAt,
    createdAt: order.createdAt || null,
    subject: `Your YOLKO order is confirmed (#${orderRef(order)})`,
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
  };
}

// Zoho Mail for the admin mailbox (read, reply and write as orders@getyolko.com).
// Secrets: ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET from a Zoho API console "Server-based
// Application" whose redirect URI is https://getyolko.com/api/zoho/callback. The owner signs
// in once with "Connect Zoho Mail" on the admin Emails page; the refresh token is stored in
// KV, encrypted with a key derived from ZOHO_CLIENT_SECRET, so a KV read alone can't use it.
// A ZOHO_REFRESH_TOKEN secret (Self Client) still works and wins over the stored login.
// Optional: ZOHO_ACCOUNTS_URL / ZOHO_MAIL_URL (other data centres), ZOHO_MAIL_ACCOUNT_ID.
const ZOHO_AUTH_KEY = "zoho:mail:auth";
const ZOHO_SCOPES = "ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.ALL";
const ZOHO_ACCOUNTS_HOST = /^accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|com\.cn)|zohocloud\.ca)$/;

function zohoClientConfigured(env) {
  return Boolean(String(env.ZOHO_CLIENT_ID || "").trim() && String(env.ZOHO_CLIENT_SECRET || "").trim());
}

function zohoMailHostFor(accountsUrl) {
  try {
    const host = new URL(accountsUrl).host;
    if (ZOHO_ACCOUNTS_HOST.test(host)) return `https://${host.replace(/^accounts\./, "mail.")}`;
  } catch {}
  return "https://mail.zoho.com";
}

function b64(bytes) {
  const u = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  return Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));
}

async function zohoVaultKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`yolko-zoho-vault:${String(env.ZOHO_CLIENT_SECRET).trim()}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealSecret(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await zohoVaultKey(env), new TextEncoder().encode(plain));
  return { iv: b64(iv), ct: b64(ct) };
}

async function openSecret(env, sealed) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, await zohoVaultKey(env), unb64(sealed.ct));
  return new TextDecoder().decode(pt);
}

/** The Zoho Mail login in use, or null when the mailbox isn't connected. */
async function zohoAuth(env) {
  if (!zohoClientConfigured(env)) return null;
  const fixed = String(env.ZOHO_REFRESH_TOKEN || "").trim();
  if (fixed) {
    const accountsUrl = String(env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/+$/, "");
    return {
      refreshToken: fixed,
      accountsUrl,
      mailUrl: String(env.ZOHO_MAIL_URL || zohoMailHostFor(accountsUrl)).replace(/\/+$/, ""),
      accountId: String(env.ZOHO_MAIL_ACCOUNT_ID || "").trim() || null,
      address: null,
      source: "secret",
    };
  }
  const saved = await env.DATA.get(ZOHO_AUTH_KEY, "json").catch(() => null);
  if (!saved?.token) return null;
  let refreshToken;
  try {
    refreshToken = await openSecret(env, saved.token);
  } catch {
    // The client secret changed, so the stored login can't be read any more.
    return null;
  }
  return { ...saved, token: undefined, refreshToken, source: "login" };
}

// Zoho allows only 10 new access tokens per 10 minutes per login, and turns the
// login away for a while past that. So one access token is shared by every isolate
// through KV (sealed, like the login) and the site asks Zoho about once an hour;
// parallel calls in one request share one ask; and after a failed ask every isolate
// waits a minute before asking again instead of hammering Zoho.
const ZOHO_ACCESS_KEY = "zoho:mail:access";
const ZOHO_PAUSE_KEY = "zoho:mail:pause";
const ZOHO_PAUSE_MS = 60000;
// This isolate's copy, keyed to the login it came from.
let zohoToken = null;
let zohoAccount = null;
// Set once Zoho has refused a sender name in fromAddress, see zohoMailSend.
let zohoPlainFromOnly = false;
// A refresh in flight, per request: each request builds its own auth object, so a
// promise is never awaited by a request other than the one that started it.
const zohoAsking = new WeakMap();

async function zohoAccessToken(env, auth) {
  const tag = auth.refreshToken.slice(-12);
  if (zohoToken && zohoToken.tag === tag && zohoToken.exp > Date.now() + 60000) return zohoToken.token;
  let asking = zohoAsking.get(auth);
  if (!asking) {
    asking = zohoSharedToken(env, auth, tag).finally(() => zohoAsking.delete(auth));
    zohoAsking.set(auth, asking);
  }
  return asking;
}

/** The shared token from KV, or a new one from Zoho (unless asking is paused). */
async function zohoSharedToken(env, auth, tag) {
  // KV only ever holds a one-way id for the login, never a piece of the token.
  const login = (await sha256Hex(`zoho-login:${auth.refreshToken}`)).slice(0, 16);
  const kept = await env.DATA.get(ZOHO_ACCESS_KEY, "json").catch(() => null);
  if (kept?.login === login && kept.exp > Date.now() + 120000) {
    try {
      const shared = { tag, id: kept.id, token: await openSecret(env, kept.token), exp: kept.exp };
      zohoToken = shared;
      return shared.token;
    } catch {
      // Sealed with an older client secret: ask Zoho for a new one below.
    }
  }
  const pause = await env.DATA.get(ZOHO_PAUSE_KEY, "json").catch(() => null);
  if (pause?.login === login && pause.until > Date.now()) {
    const err = new Error(`${pause.message || "Zoho sign-in failed"}. Try again in a minute`);
    err.reconnect = Boolean(pause.reconnect);
    err.signin = true;
    throw err;
  }
  let data;
  try {
    data = await zohoRefresh(env, auth);
  } catch (err) {
    // The sign-in failed, not any one email: callers can keep their work for later.
    if (err && typeof err === "object") err.signin = true;
    const note = { login, until: Date.now() + ZOHO_PAUSE_MS, message: String(err?.message || err).slice(0, 200), reconnect: Boolean(err?.reconnect) };
    await env.DATA.put(ZOHO_PAUSE_KEY, JSON.stringify(note), { expirationTtl: Math.ceil(ZOHO_PAUSE_MS / 1000) }).catch(() => null);
    throw err;
  }
  await env.DATA.delete(ZOHO_PAUSE_KEY).catch(() => null);
  const life = Math.max(300, Number(data.expires_in) || 3600) * 1000;
  // A local copy: other requests in this isolate can change zohoToken while this one waits on KV.
  const fresh = { tag, id: randomHex(6), token: data.access_token, exp: Date.now() + life };
  zohoToken = fresh;
  try {
    const sealed = await sealSecret(env, fresh.token);
    await env.DATA.put(ZOHO_ACCESS_KEY, JSON.stringify({ login, id: fresh.id, token: sealed, exp: fresh.exp }), {
      expirationTtl: Math.floor(life / 1000) - 60,
    });
  } catch {
    // Not shared this time: this isolate still has it, and the others ask Zoho themselves.
  }
  return fresh.token;
}

/** Ask Zoho for a new access token, with one more try when Zoho's side hiccups. */
async function zohoRefresh(env, auth) {
  const clientId = String(env.ZOHO_CLIENT_ID).trim();
  const clientSecret = String(env.ZOHO_CLIENT_SECRET).trim();
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    let resp;
    let text = "";
    try {
      resp = await fetch(`${auth.accountsUrl}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken, client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(10000),
      });
      text = await resp.text();
    } catch (e) {
      err = new Error(`Zoho sign-in failed: ${e?.name === "TimeoutError" ? "Zoho didn't answer in 10 seconds" : String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    // Zoho answers some failures with HTTP 200 and an error field.
    if (resp.ok && data?.access_token) return data;
    const expired = data?.error === "invalid_code";
    const said = data?.error ? `: ${String(data.error).slice(0, 120)}` : ` (HTTP ${resp.status}${zohoErrorText(text, [auth.refreshToken, clientId, clientSecret])})`;
    err = new Error(expired ? "The Zoho login has expired. Connect Zoho Mail again" : `Zoho sign-in failed${said}`);
    err.reconnect = expired;
    // Only a hiccup on Zoho's side is worth one more try; a refusal stands.
    if (resp.status < 500) break;
  }
  throw err;
}

/** A short, safe excerpt of an error page: no markup, and never anything we sent. */
function zohoErrorText(text, secrets) {
  let s = String(text || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const v of secrets) if (v && v.length >= 8) s = s.split(v).join("[hidden]");
  s = s.slice(0, 120);
  return s ? `: ${s}` : "";
}

/** Forget an access token Zoho turned down, here and in KV (unless KV already holds a newer one). */
async function zohoDropToken(env, token) {
  if (!zohoToken || zohoToken.token !== token) return;
  const { id } = zohoToken;
  zohoToken = null;
  const kept = await env.DATA.get(ZOHO_ACCESS_KEY, "json").catch(() => null);
  if (id && kept?.id === id) await env.DATA.delete(ZOHO_ACCESS_KEY).catch(() => null);
}

async function zohoMailFetch(env, auth, path, { method = "GET", body, raw = false, timeout = 15000 } = {}) {
  const token = await zohoAccessToken(env, auth);
  const headers = { Authorization: `Zoho-oauthtoken ${token}`, Accept: raw ? "*/*" : "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${auth.mailUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // A raw download streams after this returns, and the timer covers the whole body.
    signal: AbortSignal.timeout(timeout),
  });
  if (resp.status === 401) await zohoDropToken(env, token);
  if (raw && resp.ok) return resp;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = new Error(String(data?.data?.moreInfo || data?.status?.description || `Zoho Mail said HTTP ${resp.status}`).slice(0, 300));
    err.status = resp.status;
    // A turned-down token is a sign-in problem; the next call signs in again.
    if (resp.status === 401) err.signin = true;
    throw err;
  }
  return data;
}

/**
 * Send from the Zoho mailbox under the shop's name, so mail apps show "YOLKO" and not the bare
 * address (Gmail draws its sender circle from the first letter of that name, and "orders" gave
 * an O). Zoho's docs only promise a plain address in fromAddress. So if Zoho answers the named
 * form with an error, the same email goes out again with the plain address: the name can never
 * stop an email. A sign-in problem, a rate limit or a timeout is not about the name and is not
 * retried here (after a timeout the first try may have been sent).
 */
async function zohoMailSend(env, auth, path, mail) {
  if (!zohoPlainFromOnly) {
    try {
      return await zohoMailFetch(env, auth, path, { method: "POST", body: { ...mail, fromAddress: `${STRIPE_BRAND} <${mail.fromAddress}>` } });
    } catch (err) {
      if (!err?.status || err.status === 401 || err.status === 429) throw err;
      const data = await zohoMailFetch(env, auth, path, { method: "POST", body: mail });
      // The plain form went through, so it was the name Zoho refused. Stop trying it.
      zohoPlainFromOnly = true;
      return data;
    }
  }
  return zohoMailFetch(env, auth, path, { method: "POST", body: mail });
}

/** The mailbox account plus its Inbox and Sent folder ids. */
async function zohoMailAccount(env, auth) {
  const tag = auth.refreshToken.slice(-12);
  if (zohoAccount && zohoAccount.tag === tag) return zohoAccount;
  let accountId = auth.accountId;
  let address = auth.address;
  if (!accountId || !address) {
    const data = await zohoMailFetch(env, auth, "/accounts");
    const list = Array.isArray(data?.data) ? data.data : [];
    const acct = list.find((a) => String(a.accountId) === String(accountId)) || list.find((a) => String(a.primaryEmailAddress || "").toLowerCase() === SHOP_EMAIL) || list[0];
    if (!acct?.accountId) throw new Error("This Zoho login has no mailbox");
    accountId = String(acct.accountId);
    address = acct.primaryEmailAddress || acct.mailboxAddress || address || null;
  }
  const fdata = await zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(accountId)}/folders`);
  const folders = Array.isArray(fdata?.data) ? fdata.data : [];
  const pick = (type) => folders.find((f) => String(f.folderType || "").toLowerCase() === type) || folders.find((f) => String(f.folderName || "").toLowerCase() === type);
  zohoAccount = {
    tag,
    accountId,
    address,
    folders: { inbox: pick("inbox")?.folderId ? String(pick("inbox").folderId) : null, sent: pick("sent")?.folderId ? String(pick("sent").folderId) : null },
  };
  return zohoAccount;
}

function decodeMailEntities(s) {
  return String(s || "").replace(/&(lt|gt|quot|amp|#39);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', amp: "&", "#39": "'" }[e]));
}

/** One mailbox row for the admin list. */
function mailRow(m) {
  return {
    messageId: String(m.messageId || ""),
    folderId: String(m.folderId || ""),
    threadId: m.threadId ? String(m.threadId) : null,
    subject: decodeMailEntities(m.subject),
    from: decodeMailEntities(m.fromAddress),
    fromName: decodeMailEntities(m.sender),
    to: decodeMailEntities(m.toAddress),
    summary: decodeMailEntities(m.summary),
    receivedAt: Number(m.receivedTime || m.sentDateInGMT) ? new Date(Number(m.receivedTime || m.sentDateInGMT)).toISOString() : null,
    unread: String(m.status) === "0",
    hasAttachment: String(m.hasAttachment) === "1",
  };
}

/* ---------- Pictures and attachments in the admin mailbox ----------
   Zoho's message HTML points inline pictures at its own web app (/mail/ImageDisplay?...&cid=...),
   which only works inside mail.zoho.com, so on getyolko.com they were broken boxes. cid: links,
   http: pictures and hosts that refuse other sites' Referer don't load in the admin either. So every
   picture and attachment comes through the site: inline pictures and files straight from the Zoho
   API, remote pictures through a small proxy (no cookies, no Referer, and Kanna's IP stays hidden).
   <img> tags and new tabs can't send the admin's Bearer key, so each link carries an HMAC made with
   a key derived from ADMIN_KEY, and links to the mailbox's own files run out after about a week. */
const MAIL_FILE_DAYS = 7;
const MAIL_IMAGE_MAX = 25 * 1024 * 1024;
let mailSigning = null;

async function mailSigningKey(env) {
  const secret = String(env.ADMIN_KEY || "").trim();
  if (!secret) throw new Error("ADMIN_KEY isn't set");
  if (mailSigning?.secret === secret) return mailSigning.key;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`yolko-mail-files:${secret}`));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  mailSigning = { secret, key };
  return key;
}

async function mailSign(env, text) {
  const mac = await crypto.subtle.sign("HMAC", await mailSigningKey(env), new TextEncoder().encode(text));
  return b64(mac.slice(0, 16)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mailSigOk(env, text, sig) {
  if (!sig || !env.ADMIN_KEY) return false;
  const want = await mailSign(env, text);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Links to the mailbox's own files last a week, rounded to the day so the browser can cache them. */
function mailFileExpiry() {
  const day = 86400;
  return (Math.floor(Date.now() / 1000 / day) + MAIL_FILE_DAYS + 1) * day;
}

function mailLink(origin, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return `${origin}${path}?${q}`;
}

/** A picture on the web, through the site's proxy. The address is the whole secret, so it never runs out. */
async function mailRemoteImageLink(env, origin, href) {
  return mailLink(origin, "/api/admin/mail/image", { u: href, s: await mailSign(env, `img\n${href}`) });
}

/** One inline picture of a message (by its Content-ID, and Zoho's attachment id when known). */
async function mailInlineLink(env, origin, folderId, messageId, cid, attId, x) {
  const s = await mailSign(env, `inl\n${folderId}\n${messageId}\n${cid}\n${attId}\n${x}`);
  return mailLink(origin, "/api/admin/mail/inline", { f: folderId, m: messageId, c: cid, a: attId, x, s });
}

/** One attachment. The name is signed too: its extension decides how the file is served. */
async function mailFileLink(env, origin, folderId, messageId, attId, name, x, download) {
  const s = await mailSign(env, `att\n${folderId}\n${messageId}\n${attId}\n${name}\n${x}`);
  return mailLink(origin, "/api/admin/mail/file", { f: folderId, m: messageId, a: attId, n: name, x, s, dl: download ? 1 : "" });
}

function decodeAttr(v) {
  return String(v).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" }[k];
  });
}

function escAttr(v) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A Content-ID without its <angle brackets>. Compare with cidKey(); send Zoho the original. */
function normCid(v) {
  return String(v || "").trim().replace(/^<|>$/g, "");
}

function cidKey(v) {
  return normCid(v).toLowerCase();
}

const ZOHO_WEB_HOST = /(^|\.)zoho(mail)?\.[a-z.]+$/i;

/** What a picture address in a message points at: a remote picture, an inline part, or nothing we can fetch. */
function mailImageTarget(raw) {
  const v = String(raw || "").trim();
  if (!v || /^(data|blob|about|javascript):/i.test(v)) return null;
  if (/^cid:/i.test(v)) {
    let cid = v.slice(4);
    try { cid = decodeURIComponent(cid); } catch {}
    return { inline: true, cid: normCid(cid), file: "" };
  }
  let u;
  try {
    u = new URL(v.startsWith("//") ? `https:${v}` : v, "https://mail.zoho.com");
  } catch {
    return null;
  }
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("//");
  if ((relative || ZOHO_WEB_HOST.test(u.hostname)) && /\/ImageDisplay$/i.test(u.pathname)) {
    return { inline: true, cid: normCid(u.searchParams.get("cid")), file: String(u.searchParams.get("f") || "") };
  }
  if (relative || !/^https?:$/.test(u.protocol) || u.href.length > 4000) return null;
  return { inline: false, href: u.href };
}

/**
 * The message HTML with every picture pointed at the site: <img src/srcset>, background="",
 * style="...url()" and <style> blocks. Remote <img>s keep their address in data-yolko-orig, so the
 * admin can try it directly if the proxy can't get it.
 */
async function rewriteMailImages(env, origin, html, { folderId, messageId, inline = [], embed = null }) {
  html = String(html || "");
  const x = mailFileExpiry();
  const own = new URL(origin).host;
  const links = new Map();
  const byCid = new Map(inline.filter((p) => p.cid).map((p) => [cidKey(p.cid), p]));
  const resolve = (raw) => {
    const key = String(raw || "").trim();
    if (links.has(key)) return;
    const t = mailImageTarget(key);
    if (!t) return links.set(key, null);
    if (!t.inline) {
      if (new URL(t.href).host === own) return links.set(key, null);
      return links.set(key, mailRemoteImageLink(env, origin, t.href).then((href) => ({ href, orig: t.href })));
    }
    // Zoho names inline parts 1.png, 2.jpg... in the order they come, so that is the fallback match.
    const n = /^(\d+)\./.exec(t.file);
    const same = t.cid ? byCid.get(cidKey(t.cid)) : null;
    const part = same || (n ? inline[Number(n[1]) - 1] : null) || null;
    const cid = same ? normCid(same.cid) : t.cid || (part ? normCid(part.cid) : "");
    if (!cid && !part) return links.set(key, null);
    const attId = part ? part.attachmentId : "";
    const link = () => mailInlineLink(env, origin, folderId, messageId, cid, attId, x).then((href) => ({ href }));
    // Small pictures go right into the message (see MAIL_EMBED_EACH), the rest load by link.
    links.set(key, embed ? embed(cid, attId).then((d) => (d ? { href: d } : link())) : link());
  };

  const TAG = /<([a-z][\w:-]*)((?:\s+(?:[^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/gi;
  const ATTR = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const CSS_URL = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
  const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
  const srcsetUrls = (v) => v.split(/,\s+|,(?=\S)/).map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
  const attrValue = (m) => decodeAttr(m[5] ?? m[6] ?? m[7] ?? "");

  // First pass: find every address and sign them all at once.
  for (const tag of html.matchAll(TAG)) {
    for (const a of (tag[2] || "").matchAll(ATTR)) {
      const name = a[2].toLowerCase();
      if (a[4] === undefined) continue;
      const val = attrValue(a);
      if (name === "src" || name === "background" || name === "poster") resolve(val);
      else if (name === "srcset") srcsetUrls(val).forEach(resolve);
      else if (name === "style") for (const u of val.matchAll(CSS_URL)) resolve(u[2]);
    }
  }
  for (const b of html.matchAll(STYLE_BLOCK)) for (const u of b[2].matchAll(CSS_URL)) resolve(u[2]);
  if (!links.size) return html;
  const done = new Map();
  await Promise.all([...links].map(async ([k, p]) => done.set(k, p ? await p.catch(() => null) : null)));
  const swap = (raw) => done.get(String(raw || "").trim())?.href || null;
  const swapCss = (css) => css.replace(CSS_URL, (m, q, u) => (swap(u) ? `url("${swap(u)}")` : m));

  // Second pass: write the new addresses in.
  html = html.replace(STYLE_BLOCK, (m, open, css, close) => open + swapCss(css) + close);
  return html.replace(TAG, (whole, tagName, attrs, slash) => {
    if (!attrs) return whole;
    let orig = "";
    const out = attrs.replace(ATTR, (m, sp, name, eq, _q, dq, sq, bare) => {
      if (eq === undefined) return m;
      const n = name.toLowerCase();
      const val = decodeAttr(dq ?? sq ?? bare ?? "");
      if (n === "src" || n === "background" || n === "poster") {
        const hit = done.get(val.trim());
        if (!hit) return m;
        if (hit.orig && n === "src") orig = hit.orig;
        return `${sp}${name}="${escAttr(hit.href)}"`;
      }
      if (n === "srcset") {
        const next = val.replace(/(^|,)(\s*)([^\s,]+)/g, (mm, c, ws, u) => (swap(u) ? `${c}${ws}${swap(u)}` : mm));
        return next === val ? m : `${sp}${name}="${escAttr(next)}"`;
      }
      if (n === "style" && /url\(/i.test(val)) {
        const next = swapCss(val);
        return next === val ? m : `${sp}${name}="${escAttr(next)}"`;
      }
      return m;
    });
    if (out === attrs) return whole;
    return `<${tagName}${out}${orig && /^img$/i.test(tagName) ? ` data-yolko-orig="${escAttr(orig)}"` : ""}${slash ? " /" : ""}>`;
  });
}

/** What a mail attachment is, from its name: a picture to show, a file the browser can open, or one to save. */
const MAIL_FILE_TYPES = {
  png: ["image/png", "image"], jpg: ["image/jpeg", "image"], jpeg: ["image/jpeg", "image"], jpe: ["image/jpeg", "image"],
  gif: ["image/gif", "image"], webp: ["image/webp", "image"], avif: ["image/avif", "image"], bmp: ["image/bmp", "image"],
  pdf: ["application/pdf", "open"], txt: ["text/plain; charset=utf-8", "open"], csv: ["text/plain; charset=utf-8", "open"],
  log: ["text/plain; charset=utf-8", "open"], mp3: ["audio/mpeg", "open"], m4a: ["audio/mp4", "open"], wav: ["audio/wav", "open"],
  mp4: ["video/mp4", "open"], mov: ["video/quicktime", "open"], webm: ["video/webm", "open"],
};

function mailFileType(name) {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(String(name || "")) || [])[1];
  return MAIL_FILE_TYPES[String(ext || "").toLowerCase()] || ["application/octet-stream", "file"];
}

/** The picture format from the first bytes, for hosts and Zoho parts that say application/octet-stream. */
function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 64));
  const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70) && /^avi[fs]$/.test(String.fromCharCode(...b.slice(8, 12)))) return "image/avif";
  if (at(0, 0x42, 0x4d)) return "image/bmp";
  if (at(0, 0, 0, 1, 0)) return "image/x-icon";
  const head = new TextDecoder().decode(buf.slice(0, 1024)).replace(/^\ufeff/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

const MAIL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/apng"]);

// Served from getyolko.com, so a file must never run as a page there: sandbox anything that could.
const MAIL_FILE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const MAIL_SANDBOX = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

function mailMiss(status = 404) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...MAIL_FILE_HEADERS } });
}

/** A picture response, or null when the bytes aren't a picture. */
async function mailImageResponse(resp, maxAge) {
  if (!resp?.ok) return null;
  if (Number(resp.headers.get("Content-Length")) > MAIL_IMAGE_MAX) return null;
  let type = String(resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  let body = resp.body;
  if (!MAIL_IMAGE_TYPES.has(type)) {
    const buf = await resp.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength > MAIL_IMAGE_MAX) return null;
    type = sniffImage(buf);
    if (!type) return null;
    body = buf;
  }
  return new Response(body, {
    headers: { "Content-Type": type, "Content-Security-Policy": MAIL_SANDBOX, "Cache-Control": `private, max-age=${maxAge}`, ...MAIL_FILE_HEADERS },
  });
}

/* A message never changes once it arrives, so what Zoho says about it (and its inline
 * pictures) is kept in this data centre's cache. Opening it again then skips Zoho, which is
 * the slow part: every call to Zoho crosses the Pacific. Keys are signed, so they can't be
 * guessed, and the Cache API is only read by this code. */
const MAIL_CACHE_SECS = 30 * 86400;
// Inline pictures up to this size go straight into the message, so they show with the text.
const MAIL_EMBED_EACH = 400 * 1024;
const MAIL_EMBED_TOTAL = 2 * 1024 * 1024;
// How long the message waits for its inline pictures before sending links instead.
const MAIL_EMBED_WAIT = 2000;
// Which way of asking Zoho for an inline picture worked last ("cid" or "att"), so it goes first.
let mailInlineWay = "cid";

async function mailCacheKey(env, kind, parts) {
  const sig = await mailSign(env, `cache\n${kind}\n${parts.join("\n")}`);
  return new Request(`https://getyolko.com/__yolko-mail-cache/${kind}/${sig}`);
}

function mailCacheKeep(ctx, job) {
  job = job.catch(() => null);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  return job;
}

/** Keep a download in the cache while it streams to the browser, unless it's over 25 MB. */
async function mailCacheStream(cache, key, stream) {
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAIL_IMAGE_MAX) {
      await reader.cancel().catch(() => null);
      return;
    }
    parts.push(value);
  }
  if (!size) return;
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.byteLength;
  }
  await cache.put(key, new Response(buf, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": `max-age=${MAIL_CACHE_SECS}` } }));
}

/** A Zoho Mail JSON answer about one message, from the cache when we have it. */
async function zohoMailCached(env, auth, ctx, path) {
  const cache = globalThis.caches?.default;
  const key = cache ? await mailCacheKey(env, "api", [path]).catch(() => null) : null;
  if (key) {
    const hit = await cache.match(key).catch(() => null);
    const data = hit ? await hit.json().catch(() => null) : null;
    if (data) return data;
  }
  const data = await zohoMailFetch(env, auth, path);
  if (key && data?.data) {
    mailCacheKeep(ctx, cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${MAIL_CACHE_SECS}` } })));
  }
  return data;
}

/** The bytes of a Zoho download when they are a picture: { type, buf }, or null. */
async function mailPictureBytes(resp) {
  if (!resp?.ok) return null;
  if (Number(resp.headers.get("Content-Length")) > MAIL_IMAGE_MAX) return null;
  const buf = await resp.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength || buf.byteLength > MAIL_IMAGE_MAX) return null;
  let type = String(resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!MAIL_IMAGE_TYPES.has(type)) type = sniffImage(buf);
  return type ? { type, buf } : null;
}

/** One inline picture of a message, by its Content-ID (and Zoho's part id when known). */
async function mailInlinePicture(env, auth, ctx, accountId, folderId, messageId, cid, attId) {
  const cache = globalThis.caches?.default;
  const key = cache ? await mailCacheKey(env, "inl", [accountId, folderId, messageId, cid, attId]).catch(() => null) : null;
  if (key) {
    const hit = await cache.match(key).catch(() => null);
    const buf = hit ? await hit.arrayBuffer().catch(() => null) : null;
    if (buf?.byteLength) return { type: hit.headers.get("Content-Type") || "application/octet-stream", buf };
  }
  const base = `/accounts/${encodeURIComponent(accountId)}/folders/${folderId}/messages/${messageId}`;
  const get = async (path) => mailPictureBytes(await zohoMailFetch(env, auth, path, { raw: true, timeout: 30000 }).catch(() => null));
  const byCid = cid ? () => get(`${base}/inline?contentId=${encodeURIComponent(cid)}`) : null;
  const byAtt = /^[\w.-]{1,80}$/.test(attId) ? () => get(`${base}/attachments/${attId}`) : null;
  const ways = mailInlineWay === "att" ? [["att", byAtt], ["cid", byCid]] : [["cid", byCid], ["att", byAtt]];
  let out = null;
  for (const [way, ask] of ways) {
    if (!ask) continue;
    out = await ask();
    if (out) {
      mailInlineWay = way;
      break;
    }
  }
  if (!out) {
    // Look the part up again in case Zoho's ids moved on.
    const info = await zohoMailFetch(env, auth, `${base}/attachmentinfo?includeInline=true`).catch(() => null);
    const parts = Array.isArray(info?.data?.inline) ? info.data.inline : [];
    const hit = parts.find((p) => cid && cidKey(p.cid || p.contentId) === cidKey(cid));
    if (hit?.attachmentId && String(hit.attachmentId) !== attId) out = await get(`${base}/attachments/${encodeURIComponent(hit.attachmentId)}`);
    if (!out && hit?.cid && normCid(hit.cid) !== cid) out = await get(`${base}/inline?contentId=${encodeURIComponent(normCid(hit.cid))}`);
  }
  if (out && key) {
    mailCacheKeep(ctx, cache.put(key, new Response(out.buf.slice(0), { headers: { "Content-Type": out.type, "Cache-Control": `max-age=${MAIL_CACHE_SECS}` } })));
  }
  return out;
}

/** Content-Disposition with the real file name (RFC 6266 / 5987). */
function contentDisposition(kind, name) {
  const plain = String(name || "file").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(String(name || "file"))}`;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "Name <a@b.c>, d@e.f" into a clean comma list of addresses, or null if any is bad. */
function cleanAddressList(v, max = 10) {
  const parts = String(v || "")
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/<([^>]+)>/.exec(p)?.[1] || p).trim());
  if (parts.length > max || parts.some((p) => p.length > 254 || !EMAIL_RE.test(p))) return null;
  return parts.join(",");
}

/** Plain text written in the admin, as a simple HTML email in the shop's style. */
function mailHtml(text, quote) {
  const body = htmlEscape(text).replace(/\r?\n/g, "<br>");
  const q = quote?.text
    ? `<br><div style="color:#6d6b64">${htmlEscape(quote.header || "")}</div><blockquote style="margin:6px 0 0;padding:0 0 0 12px;border-left:3px solid #e5e0d5;color:#3d3b36">${htmlEscape(String(quote.text).slice(0, 20000)).replace(/\r?\n/g, "<br>")}</blockquote>`
    : "";
  return `<div style="font-family:'Plus Jakarta Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#171714">${body}<br><br><span style="color:#6d6b64">YOLKO · getyolko.com</span>${q}</div>`;
}

/* ---------- The shop's phone line (phone-line.mjs) ---------- */

/** Keep the last 100 calls and texts to the line, newest first, for looking back. */
async function lineLog(env, entry) {
  const list = (await env.DATA.get(LINE_LOG_KEY, "json").catch(() => null)) || [];
  list.unshift({ ...entry, at: new Date().toISOString() });
  await env.DATA.put(LINE_LOG_KEY, JSON.stringify(list.slice(0, 100)));
}

/** A text to the line goes to the shop mailbox, so it shows in Admin > Emails with the rest. */
async function emailLineText(env, msg) {
  const auth = await zohoAuth(env);
  if (!auth) return;
  const acct = await zohoMailAccount(env, auth);
  const mail = textEmail(msg);
  await zohoMailSend(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/messages`, {
    fromAddress: acct.address || SHOP_EMAIL,
    toAddress: SHOP_EMAIL,
    subject: mail.subject,
    content: mailHtml(mail.text),
    mailFormat: "html",
  });
}

/* ---------- Thursday reorder reminders ----------
 * Customers who tick "Remind me" at checkout get one email each Thursday before
 * Saturday delivery, with a link that fills in their last order. These go from the
 * orders@getyolko.com mailbox (Zoho Mail), never through the CPaaS order sender,
 * whose terms forbid marketing. Every email carries an unsubscribe link.
 */
const REMIND_INDEX = "remind:index";
const REMIND_OFF = "remind:off";
const REMIND_LAST_RUN = "remind:lastrun";
const remindSubKey = (h) => `remind:sub:${h}`;
const remindTokKey = (t) => `remind:tok:${t}`;
const remindRunKey = (sat) => `remind:run:${sat}`;
const REMIND_TOKEN_RE = /^[a-f0-9]{32}$/;
// Thursday is the last day to order, so reminders go from 10am until 8pm Sydney
// time, leaving a few hours before orders close at midnight. A few per cron tick
// (every 15 minutes, so up to 160 a week) keeps one run well inside the Worker's
// per-invocation subrequest limit.
const REMIND_START_HOUR = 10;
const REMIND_END_HOUR = 20;
const REMIND_BATCH = 4;
const REMIND_MAX = 2000;
const DELIVERY_HOURS = "6am to 12pm";
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sydney's calendar date, weekday and hour (daylight saving included). */
function sydneyClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: get("weekday"), hour: Number(get("hour")) % 24 };
}

/** The Saturday `ahead` days from Sydney's date, as an ISO date and the site's "31 Oct" label. */
function saturdayFrom(clock, ahead) {
  const d = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + ahead));
  return { iso: d.toISOString().slice(0, 10), label: `${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}` };
}

/**
 * The Saturday a new order goes to. Orders close Thursday night (Sydney time): until
 * then it is this week's run, and from Friday the one after. app.js shows the same
 * date on the order form. `cutoff` is how an email names the deadline.
 */
function deliverySaturday(now = new Date()) {
  const c = sydneyClock(now);
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[c.weekday];
  return { ...saturdayFrom(c, 6 - idx + (idx >= 5 ? 7 : 0)), cutoff: idx === 4 ? "tonight" : "Thursday night" };
}

/** The Saturday this week's reminders are for, or null outside Thursday 10am to 8pm. */
function reminderWindow(now = new Date()) {
  const c = sydneyClock(now);
  if (c.weekday !== "Thu" || c.hour < REMIND_START_HOUR || c.hour >= REMIND_END_HOUR) return null;
  return deliverySaturday(now);
}

/** The next Thursday reminders go out (today while today's window is still open). */
function nextReminderDay(now = new Date()) {
  const c = sydneyClock(now);
  const idx = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[c.weekday];
  let ahead = (4 - idx + 7) % 7;
  if (ahead === 0 && c.hour >= REMIND_START_HOUR) ahead = 7;
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + ahead));
  return `Thu ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}`;
}

async function getRemindIndex(env) {
  const list = await env.DATA.get(REMIND_INDEX, "json").catch(() => null);
  return Array.isArray(list) ? list : [];
}

async function setRemindIndex(env, list) {
  await env.DATA.put(REMIND_INDEX, JSON.stringify(list.slice(0, REMIND_MAX)));
}

/** What a reminder offers: their last order, or one main tray when that isn't on sale this week. */
function reminderItem(rec, settings, freeDelivery = false) {
  let same = isBundle(rec.bundle);
  let bundle = same ? rec.bundle : "tray1";
  let quantity = Math.min(10, Math.max(1, Math.floor(Number(rec.quantity)) || 1));
  if (stockProblem(settings, bundle, quantity)) {
    bundle = "tray1";
    quantity = 1;
    same = false;
  }
  const subtotal = (Number(settings.prices?.[bundle]) || 0) * quantity;
  const deliveryFee = freeDelivery ? 0 : SITE_DELIVERY_FEE;
  // same: this is what they ordered last time, not the one tray offered when that is sold out.
  return { bundle, quantity, same, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

/**
 * After a paid order: sign the customer up when they ticked the box, and keep an
 * existing reminder's "last order" current so the reorder link matches it.
 */
async function noteReminderOrder(env, order) {
  const email = String(order.stripe?.email || order.email || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return;
  const h = (await sha256Hex(email)).slice(0, 24);
  const rec = await env.DATA.get(remindSubKey(h), "json");
  if (!rec && !order.remindOptIn) return;
  const now = new Date().toISOString();
  const next = {
    ...(rec || {}),
    email,
    name: order.name || rec?.name || "",
    phone: order.phone || rec?.phone || "",
    bundle: order.bundle,
    quantity: order.quantity,
    deliveryStreet: order.deliveryStreet || "",
    deliverySuburb: order.deliverySuburb || "",
    deliveryCity: order.deliveryCity || "",
    deliveryPostcode: order.deliveryPostcode || "",
    lastOrderId: order.id,
    lastPaidAt: order.stripe?.paidAt || now,
    lastPickupDate: order.pickupDate || "",
  };
  const joining = order.remindOptIn && (!rec || rec.unsubscribedAt);
  if (joining) {
    next.optedInAt = now;
    delete next.unsubscribedAt;
  }
  if (!next.token) {
    next.token = randomHex(16);
    await env.DATA.put(remindTokKey(next.token), h);
  }
  await env.DATA.put(remindSubKey(h), JSON.stringify(next));
  if (joining) {
    const list = await getRemindIndex(env);
    if (!list.includes(h)) await setRemindIndex(env, [h, ...list]);
  }
}

async function reminderByToken(env, token) {
  if (!REMIND_TOKEN_RE.test(String(token || ""))) return null;
  const h = await env.DATA.get(remindTokKey(token));
  if (!h) return null;
  const rec = await env.DATA.get(remindSubKey(h), "json");
  return rec && rec.token === token ? { h, rec } : null;
}

function reminderLinks(token) {
  return {
    reorder: `https://getyolko.com/?utm_source=reminder&utm_medium=email&utm_campaign=thursday#reorder=${token}`,
    stop: `https://getyolko.com/api/reminders/stop?t=${token}`,
  };
}

function buildReminderEmail(rec, settings, sat, ref = null) {
  const first = String(rec.name || "").split(/\s+/)[0] || "there";
  const free = Number(ref?.credits) > 0;
  const item = reminderItem(rec, settings, free);
  const label = bundleLabel(item.bundle);
  const links = reminderLinks(rec.token);
  const cutoff = sat.cutoff || "Thursday night";
  const subject = `Eggs this Saturday, ${sat.label}? Order by ${cutoff}`;
  const C = EMAIL_C;
  const preheader = `Orders close ${cutoff} for Saturday ${sat.label}, ${DELIVERY_HOURS}. Your last order is ready to go again.`;
  const html = emailFrame({
    subject,
    preheader,
    label: `Saturday ${sat.label}`,
    title: "Eggs this Saturday?",
    mark: "Saturday",
    help: "Questions?",
    // One quiet list instead of a long opening sentence: the day, the deadline, the order and
    // the total, each on its own row, then one wide button.
    rows: `<tr><td style="font-size:16px;line-height:24px;color:${C.ink2}">Hi ${htmlEscape(first)}, ${item.same ? "want the same again?" : "want eggs this week?"}</td></tr>
${emailList([
  ["Delivery", `Saturday ${htmlEscape(sat.label)}${emailUnder(DELIVERY_HOURS)}`],
  ["Order by", htmlEscape(cutoff.charAt(0).toUpperCase() + cutoff.slice(1))],
  ["Your order", `${htmlEscape(emailItem(item.quantity, label))}${emailUnder(emailPriceLine(item.subtotal, item.deliveryFee, free))}`],
  ["Total", emailBig(money(item.total))],
])}
${free ? `<tr><td style="padding-top:14px;font-size:15px;line-height:22px;color:${C.ink2}">You've earned a free delivery, so this one is on us. It comes off at checkout.</td></tr>` : ""}
<tr><td style="padding-top:16px">${emailWideButton(links.reorder, "Order again")}</td></tr>
<tr><td style="padding-top:12px;font-size:14px;line-height:21px;color:${C.muted}">It opens your order filled in, ready to pay. Not this week? Just ignore this email.</td></tr>
${ref?.link ? `<tr><td style="padding-top:22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${C.line};padding-top:18px;font-size:15px;line-height:22px;font-weight:700;color:${C.ink}">Free delivery for a neighbour</td></tr><tr><td style="padding-top:4px;font-size:14px;line-height:21px;color:${C.ink2}">Send them your link. Their first delivery is free, and so is your next one.</td></tr><tr><td style="padding-top:8px;font-size:15px;line-height:22px"><a href="${htmlEscape(ref.link)}" style="font-weight:600;color:${C.ink};text-decoration:underline">${htmlEscape(ref.link.replace("https://", ""))}</a></td></tr></table></td></tr>` : ""}`,
    why: `Sent each Thursday because you asked.<br><a href="${htmlEscape(links.stop)}" style="color:${C.ink2};font-weight:600;text-decoration:underline">Stop reminders</a>`,
  });
  return { subject, html };
}

/** Send one reminder from the Zoho mailbox. Returns { ok, error?, reconnect?, signin? }. */
async function sendReminderEmail(env, auth, rec, settings, sat, { test = false } = {}) {
  // A sample's share link is a dummy that opens the plain shop, so tapping it in a
  // test email never saves a "Test sent you free delivery" note on that phone.
  const ref = test
    ? { code: "SAMPLE", link: shareLink("SAMPLE"), credits: 0 }
    : await referralFor(env, rec.phone, rec.name).catch(() => null);
  const { subject, html } = buildReminderEmail(rec, settings, sat, ref);
  try {
    const acct = await zohoMailAccount(env, auth);
    await zohoMailSend(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/messages`, {
      fromAddress: acct.address || SHOP_EMAIL,
      toAddress: rec.email,
      subject: test ? testSubject(subject) : subject,
      content: html,
      mailFormat: "html",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reconnect: Boolean(err?.reconnect), signin: Boolean(err?.signin), error: String(err?.message || err).slice(0, 300) };
  }
}

/** Cron: work through this week's reminders a few at a time. */
async function runReminders(env, now = new Date()) {
  const sat = reminderWindow(now);
  if (!sat) return { skipped: "window" };
  const runKey = remindRunKey(sat.iso);
  let run = await env.DATA.get(runKey, "json");
  if (run?.done) return { skipped: "done" };
  if (await env.DATA.get(REMIND_OFF)) return { skipped: "paused" };
  const settings = await getSettings(env);
  // Sold out: nothing to offer, and the reminder would only disappoint.
  if (!(Number(settings.traysAvailable) > 0)) return { skipped: "sold out" };
  const auth = await zohoAuth(env);
  if (!auth) return { skipped: "mailbox not connected" };
  if (!run) run = { sat: sat.iso, label: sat.label, startedAt: now.toISOString(), pending: await getRemindIndex(env), sent: 0, skipped: 0, failed: 0 };
  const batch = run.pending.splice(0, REMIND_BATCH);
  for (let i = 0; i < batch.length; i++) {
    const h = batch[i];
    const rec = await env.DATA.get(remindSubKey(h), "json");
    if (!rec || rec.unsubscribedAt || rec.lastSentFor === sat.iso) {
      run.skipped++;
      continue;
    }
    // Already ordered for this Saturday.
    const recent = Date.now() - Date.parse(rec.lastPaidAt || 0) < 14 * 86400 * 1000;
    if (rec.lastPickupDate === sat.label && recent) {
      run.skipped++;
      continue;
    }
    const result = await sendReminderEmail(env, auth, rec, settings, sat);
    if (result.reconnect || result.signin) {
      // The mailbox login expired, or Zoho turned the sign-in away for now. Nothing is
      // wrong with this customer, so keep them and the rest for a later run.
      run.pending.unshift(...batch.slice(i));
      run.lastError = result.error;
      break;
    }
    if (result.ok) {
      run.sent++;
      await env.DATA.put(remindSubKey(h), JSON.stringify({ ...rec, lastSentFor: sat.iso, lastSentAt: new Date().toISOString(), sends: (rec.sends || 0) + 1, lastError: undefined }));
    } else {
      run.failed++;
      run.lastError = result.error;
      await env.DATA.put(remindSubKey(h), JSON.stringify({ ...rec, lastError: result.error }));
    }
  }
  if (!run.pending.length) {
    run.done = true;
    run.finishedAt = new Date().toISOString();
  }
  await env.DATA.put(runKey, JSON.stringify(run), { expirationTtl: 60 * 86400 });
  const { pending, ...summary } = run;
  await env.DATA.put(REMIND_LAST_RUN, JSON.stringify({ ...summary, left: pending.length }));
  return summary;
}

/** The admin's one-line view of reminders. */
async function reminderStatus(env) {
  const [list, off, lastRun] = await Promise.all([
    getRemindIndex(env),
    env.DATA.get(REMIND_OFF).catch(() => null),
    env.DATA.get(REMIND_LAST_RUN, "json").catch(() => null),
  ]);
  return { on: !off, subscribers: list.length, next: nextReminderDay(), lastRun: lastRun || null };
}

/** "maruthi@gmail.com" as "ma•••@gmail.com". */
function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  return domain ? `${user.slice(0, 2)}•••@${domain}` : "";
}

/** A small page in the shop's style, for the unsubscribe link. */
function reminderPage(title, body, status = 200) {
  const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEscape(title)} · YOLKO</title>
${iconLinks().join("")}
<style>@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:400 800;src:url(/assets/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2) format("woff2")}
body{margin:0;background:#faf7f0;color:#171714;font:16px/1.5 "Plus Jakarta Sans",-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:440px;margin:0 auto;padding:48px 16px}
.logo{display:inline-block;color:#14120e}
.logo svg{display:block;height:34px;width:auto;overflow:visible}
.card{margin-top:20px;background:#fffefb;border:1px solid #e5e0d5;border-radius:16px;padding:28px 24px}
h1{margin:0;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.2px}
p{margin:10px 0 0;color:#3d3b36}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:20px;padding:0 22px;border:0;border-radius:12px;background:#171714;color:#fffefb;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
</style></head><body><main><a class="logo" href="/" aria-label="YOLKO home">${logoAlone()}</a><div class="card"><h1>${htmlEscape(title)}</h1>${body}</div></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
  });
}

/* ---------- Referrals and same-building orders ----------
 * Every paying customer gets a share link (getyolko.com/r/CODE). A friend's first
 * order through it ships free, and the friend who shared it gets their next
 * delivery free. Orders to one building for the same Saturday share a trip: later
 * ones ship free, and anyone there who already paid for delivery gets their next
 * one free. A free delivery owed is a credit on the customer's phone number,
 * used up by their next checkout. Kanna chose "free delivery for both" (2026-10-26).
 */
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REF_CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const REF_MAX_CREDITS = 10;
const REF_BACKFILL = "ref:backfill";
const refCustKey = (phone) => `ref:cust:${phone}`;
const refMineKey = (phone) => `ref:mine:${phone}`;
const refCodeKey = (code) => `ref:code:${code}`;
// Shop-wide link (Kanna, 10 Nov 2026): getyolko.com/?ref=FRESH5 (or /r/FRESH5) makes a new
// customer's first delivery free, like a friend's link, but nobody earns a credit from it.
// Add utm_source wherever it is shared, so the visit log shows which place brings orders.
const HOUSE_REF_CODES = new Set(["FRESH5"]);
const bldgKey = (date, h) => `bldg:${date}:${h}`;
const AU_MOBILE_RE = /^04\d{8}$/;
const STREET_TYPES = {
  street: "st", road: "rd", avenue: "ave", av: "ave", parade: "pde", drive: "dr", place: "pl",
  crescent: "cres", cr: "cres", court: "ct", lane: "ln", highway: "hwy", boulevard: "blvd",
  terrace: "tce", close: "cl", circuit: "cct", square: "sq", grove: "gr", esplanade: "esp",
};
const UNIT_WORDS = "unit|units|u|apartment|apt|flat|suite|ste|level|lvl|shop|villa|townhouse|th";

function newRefCode() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

function cleanRefCode(code) {
  const c = String(code || "").trim().toUpperCase();
  return REF_CODE_RE.test(c) ? c : null;
}

function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0].slice(0, 30);
}

function shareLink(code) {
  return `https://getyolko.com/r/${code}`;
}

/**
 * The card for a share link (see share-preview.mjs), only for an app that reads links to
 * draw their cards, and only for a code that really gives a free first delivery.
 */
async function shareLinkCard(request, env, rawCode) {
  if (!isLinkPreviewAgent(request.headers.get("User-Agent"))) return null;
  const code = cleanRefCode(rawCode);
  if (!code) return null;
  if (!HOUSE_REF_CODES.has(code) && !(await env.DATA.get(refCodeKey(code)))) return null;
  const settings = await getSettings(env);
  const trayPrice = Number(settings.prices.tray1);
  if (!(trayPrice > 0)) return null;
  const card = referralCard({ code, trayPrice, deliveryFee: SITE_DELIVERY_FEE });
  return new Response(request.method === "HEAD" ? null : card.html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
  });
}

/** The customer's share code, made the first time it's needed. */
async function ensureRefCode(env, phone, name) {
  if (!AU_MOBILE_RE.test(phone || "")) return null;
  const mine = await env.DATA.get(refMineKey(phone));
  if (mine) return mine;
  let code = newRefCode();
  for (let i = 0; i < 3 && (HOUSE_REF_CODES.has(code) || (await env.DATA.get(refCodeKey(code)))); i++) code = newRefCode();
  await env.DATA.put(refCodeKey(code), JSON.stringify({ phone, name: firstNameOf(name), createdAt: new Date().toISOString() }));
  await env.DATA.put(refMineKey(phone), code);
  return code;
}

/**
 * "Unit 4, 12 Smith Street" and "4/12 Smith St" are the same building: the street
 * number and name without the unit, plus the postcode (or suburb).
 */
function buildingAddress(street, postcode, suburb) {
  let s = String(street || "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(new RegExp(`^(?:${UNIT_WORDS}) ?[a-z]?\\d+[a-z]? ?[/-]? ?`), "");
  s = s.replace(/^[a-z]?\d+[a-z]? ?\/ ?/, "");
  s = s.replace(new RegExp(` (?:${UNIT_WORDS}) ?[a-z]?\\d+[a-z]?$`), "");
  const m = /^(\d+[a-z]?(?:-\d+[a-z]?)?) (.+)$/.exec(s.replace(/ ?- ?/g, "-"));
  if (!m) return null;
  const name = m[2].split(" ").map((w) => STREET_TYPES[w] || w).join(" ");
  const area = /^2\d{3}$/.test(postcode || "") ? postcode : String(suburb || "").toLowerCase().trim();
  return area ? `${m[1]} ${name} ${area}` : null;
}

/**
 * Whether this order ships free and why: another order to the same building that
 * Saturday, a friend's link or the shop-wide link on a first order, or a free delivery
 * already earned. `refFrom` is the link's code on a first order; only a friend's code
 * earns its owner a credit (`house` marks the shop-wide one).
 */
async function deliveryPerk(env, { phone, ref, street, postcode, suburb, pickupDate }) {
  const addr = buildingAddress(street, postcode, suburb);
  const building = addr ? (await sha256Hex(addr)).slice(0, 24) : null;
  const code = cleanRefCode(ref);
  const house = !!code && HOUSE_REF_CODES.has(code);
  const [cust, bldg, friend] = await Promise.all([
    env.DATA.get(refCustKey(phone), "json").catch(() => null),
    building && pickupDate ? env.DATA.get(bldgKey(pickupDate, building), "json").catch(() => null) : null,
    code && !house ? env.DATA.get(refCodeKey(code), "json").catch(() => null) : null,
  ]);
  const firstOrder = !(Number(cust?.paidOrders) > 0);
  const refFrom = firstOrder && (house || (friend?.phone && friend.phone !== phone)) ? code : null;
  let perk = null;
  if (bldg?.orders?.length) perk = "building";
  else if (refFrom) perk = house ? "offer" : "friend";
  else if (Number(cust?.credits) > 0) perk = "credit";
  return { perk, refFrom, refBy: refFrom && !house ? friend.name || "" : "", house: !!refFrom && house, building };
}

/**
 * An unpaid order paid for after orders closed (made Thursday, paid Friday) moves to
 * the next Saturday, and its free delivery is checked again for that run.
 */
async function rollDeliveryDate(env, order) {
  if (order.fulfillment !== "delivery") return;
  const { label } = deliverySaturday();
  if (order.pickupDate === label) return;
  order.pickupDate = label;
  applyDeliveryPerk(order, await deliveryPerk(env, perkInput(order, { ref: order.refFrom })));
}

function perkInput(order, body) {
  return {
    phone: order.phone,
    ref: body?.ref,
    street: order.deliveryStreet,
    postcode: order.deliveryPostcode,
    suburb: order.deliverySuburb,
    pickupDate: order.pickupDate,
  };
}

function applyDeliveryPerk(order, p) {
  for (const k of ["deliveryPerk", "refFrom", "refBy", "refHouse", "building"]) delete order[k];
  if (order.fulfillment !== "delivery" || !p) return;
  if (p.building) order.building = p.building;
  if (p.refFrom) {
    order.refFrom = p.refFrom;
    order.refBy = p.refBy;
    if (p.house) order.refHouse = true;
  }
  if (p.perk) {
    order.deliveryPerk = p.perk;
    order.deliveryFee = 0;
    order.price = Number(order.subtotal) || 0;
  }
}

async function addRefCredit(env, phone, entry) {
  const cust = (await env.DATA.get(refCustKey(phone), "json")) || {};
  const earned = Array.isArray(cust.earned) ? cust.earned : [];
  if (earned.some((e) => e.orderId === entry.orderId && e.why === entry.why)) return;
  const credits = Math.min(REF_MAX_CREDITS, (Number(cust.credits) || 0) + 1);
  await env.DATA.put(refCustKey(phone), JSON.stringify({ ...cust, credits, earned: [entry, ...earned].slice(0, 20) }));
}

/** After a paid order: count it, use up a credit, and pay out referral and building credits. */
async function noteReferralOrder(env, order) {
  const phone = order.phone;
  if (!AU_MOBILE_RE.test(phone || "")) return;
  const cust = (await env.DATA.get(refCustKey(phone), "json")) || {};
  const seen = Array.isArray(cust.orders) ? cust.orders : [];
  if (seen.includes(order.id)) return;
  const at = new Date().toISOString();
  const next = {
    ...cust,
    name: firstNameOf(order.name) || cust.name || "",
    orders: [order.id, ...seen].slice(0, 30),
    paidOrders: (Number(cust.paidOrders) || 0) + 1,
    lastPaidAt: at,
    credits: Number(cust.credits) || 0,
  };
  if (order.deliveryPerk === "credit") next.credits = Math.max(0, next.credits - 1);

  if (order.refFrom && !HOUSE_REF_CODES.has(order.refFrom)) {
    const friend = await env.DATA.get(refCodeKey(order.refFrom), "json");
    if (friend?.phone && friend.phone !== phone) await addRefCredit(env, friend.phone, { why: "friend", orderId: order.id, at });
  }

  if (order.building && order.pickupDate) {
    const key = bldgKey(order.pickupDate, order.building);
    const b = (await env.DATA.get(key, "json")) || { orders: [] };
    if (!b.orders.some((o) => o.id === order.id)) {
      b.orders.push({ id: order.id, phone, fee: Number(order.deliveryFee) || 0 });
      b.credited = Array.isArray(b.credited) ? b.credited : [];
      // A shared trip: everyone who paid for delivery to this building gets the next one free.
      if (new Set(b.orders.map((o) => o.phone)).size > 1) {
        for (const o of b.orders) {
          if (!(o.fee > 0) || b.credited.includes(o.phone)) continue;
          b.credited.push(o.phone);
          if (o.phone === phone) next.credits = Math.min(REF_MAX_CREDITS, next.credits + 1);
          else await addRefCredit(env, o.phone, { why: "building", orderId: o.id, at });
        }
      }
      await env.DATA.put(key, JSON.stringify(b), { expirationTtl: 14 * 86400 });
    }
  }
  await env.DATA.put(refCustKey(phone), JSON.stringify(next));
}

/** What the reminder email shows: their share link and any free delivery they've earned. */
async function referralFor(env, phone, name) {
  if (!AU_MOBILE_RE.test(phone || "")) return null;
  const [code, cust] = await Promise.all([ensureRefCode(env, phone, name), env.DATA.get(refCustKey(phone), "json").catch(() => null)]);
  return code ? { code, link: shareLink(code), credits: Number(cust?.credits) || 0 } : null;
}

/**
 * The shop's QR code as a scalable SVG: soft squares, rounded eyes and the egg logo in the
 * middle, at error level H with the 4-module quiet zone scanners need. Drawn by brand-qr.mjs.
 */
function qrSvg(text) {
  return brandQr(qrcode, text);
}

/**
 * One printed card per customer on a delivery run, for them to pass to a neighbour.
 * The QR opens their share link tagged as a card, so the Visits page can count scans.
 */
async function refCardsFor(env, ids) {
  const orders = (await Promise.all(ids.map((id) => env.DATA.get(id, "json").catch(() => null)))).filter(Boolean);
  const seen = new Set();
  const cards = [];
  for (const o of orders) {
    if (seen.has(o.phone)) continue;
    seen.add(o.phone);
    const code = await ensureRefCode(env, o.phone, o.name).catch(() => null);
    if (!code) continue;
    const first = firstNameOf(o.name);
    const link = shareLink(code);
    cards.push({
      id: o.id,
      first: first ? first.charAt(0).toUpperCase() + first.slice(1) : "",
      code,
      link: link.replace(/^https:\/\//, ""),
      svg: qrSvg(`${link}?m=card`),
    });
  }
  return cards;
}

/**
 * Cron, once after launch: count orders paid before referrals existed, so a past
 * customer doesn't get a friend's first-order discount. 40 orders a tick.
 */
async function runReferralBackfill(env) {
  const state = (await env.DATA.get(REF_BACKFILL, "json")) || { at: 0 };
  if (state.done) return { skipped: "done" };
  const ids = await getOrderIndex(env);
  const chunk = ids.slice(state.at, state.at + 40);
  const byPhone = new Map();
  for (const id of chunk) {
    const o = await env.DATA.get(id, "json").catch(() => null);
    if (!o || o.paymentStatus !== "paid" || !AU_MOBILE_RE.test(o.phone || "")) continue;
    byPhone.set(o.phone, [...(byPhone.get(o.phone) || []), o]);
  }
  for (const [phone, orders] of byPhone) {
    const cust = (await env.DATA.get(refCustKey(phone), "json")) || {};
    const seen = Array.isArray(cust.orders) ? cust.orders : [];
    const fresh = orders.map((o) => o.id).filter((id) => !seen.includes(id));
    if (!fresh.length) continue;
    await env.DATA.put(refCustKey(phone), JSON.stringify({
      ...cust,
      name: cust.name || firstNameOf(orders[0].name),
      orders: [...seen, ...fresh].slice(0, 30),
      paidOrders: (Number(cust.paidOrders) || 0) + fresh.length,
    }));
  }
  const at = state.at + chunk.length;
  const done = at >= ids.length;
  await env.DATA.put(REF_BACKFILL, JSON.stringify(done ? { done, at, finishedAt: new Date().toISOString() } : { at }));
  return { at, done };
}

/** Delivery events for order emails, from Zoho's webhooks, keyed by the send's request id. */
const emailReqKey = (requestId) => `email:req:${requestId}`;
const emailEventsKey = (orderId) => `email:events:${orderId}`;

async function rememberEmailForEvents(env, order, requestId) {
  if (!requestId || !order?.id) return;
  await env.DATA.put(emailReqKey(requestId), order.id, { expirationTtl: 180 * 24 * 3600 }).catch(() => null);
}

function normalizeEmailEvent(name) {
  const n = String(name || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (n.includes("hardbounce")) return "hardBounce";
  if (n.includes("softbounce")) return "softBounce";
  if (n.includes("click")) return "click";
  if (n.includes("open")) return "open";
  if (n.includes("fbl") || n.includes("feedback") || n.includes("complaint") || n.includes("spam")) return "spam";
  if (n.includes("deliver")) return "delivered";
  return null;
}

/** Fold one event into an order's delivery record. */
function applyEmailEvent(rec, kind, at, detail) {
  const out = { ...(rec || {}) };
  if (kind === "delivered") out.deliveredAt = out.deliveredAt || at;
  if (kind === "open") {
    out.openedAt = out.openedAt || at;
    out.lastOpenedAt = at;
    out.opens = (out.opens || 0) + 1;
    out.deliveredAt = out.deliveredAt || at;
  }
  if (kind === "click") {
    out.clickedAt = out.clickedAt || at;
    out.deliveredAt = out.deliveredAt || at;
  }
  if (kind === "hardBounce") out.bounce = { type: "hard", at, reason: detail || "The address doesn't accept mail" };
  if (kind === "softBounce" && out.bounce?.type !== "hard") out.bounce = { type: "soft", at, reason: detail || "The mailbox didn't take it yet" };
  if (kind === "spam") out.spamAt = at;
  out.updatedAt = new Date().toISOString();
  return out;
}

/** Which email features are switched on, from which secrets exist (never their values). */
async function emailStatus(env) {
  let host = "";
  try {
    host = new URL(String(env.ZEPTOMAIL_API_URL || ZEPTOMAIL_DEFAULT_URL)).host;
  } catch {}
  const clientReady = zohoClientConfigured(env);
  let inbox = { clientReady, connected: false };
  if (clientReady) {
    const auth = await zohoAuth(env).catch(() => null);
    if (auth) inbox = { clientReady, connected: true, account: auth.address || null, connectedAt: auth.connectedAt || null, source: auth.source };
  }
  const lastEventAt = await env.DATA.get("email:events:last").catch(() => null);
  return {
    sending: { connected: emailConfigured(env), from: String(env.ORDER_EMAIL_FROM || "").trim() || null, host, replyTo: SHOP_EMAIL },
    inbox,
    deliveryLogs: { connected: Boolean(lastEventAt), lastEventAt: lastEventAt || null },
    reminders: await reminderStatus(env).catch(() => null),
  };
}

/**
 * Cron safety net (every 15 min). Both checks only touch payments at least
 * WEBHOOK_GRACE_SEC old, so they never race the live webhook.
 * 1. Paid Checkout Sessions (last 26 h) whose order is still unpaid: the
 *    webhook was missed (wrong secret, outage) and so was the success page.
 * 2. Recent paid orders with no confirmation email yet: retried a few times.
 * 3. Admin refunds whose refund email failed: retried the same way.
 */
async function reconcileOrders(env) {
  if (env.STRIPE_KEY) {
    const since = Math.floor(Date.now() / 1000) - 26 * 3600;
    const list = await fetch(
      `https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100&created[gte]=${since}&expand[]=data.payment_intent.latest_charge`,
      { headers: { Authorization: `Bearer ${env.STRIPE_KEY}` } }
    ).then((r) => r.json()).catch(() => null);
    for (const session of list?.data || []) {
      const orderId = session?.metadata?.orderId;
      if (session.payment_status !== "paid" || !String(orderId || "").startsWith("order:")) continue;
      const age = paymentAgeSec(session);
      if (age === null || age < WEBHOOK_GRACE_SEC) continue;
      try {
        const order = await env.DATA.get(orderId, "json");
        if (!order || order.paymentStatus === "paid" || isRefunded(order, session)) continue;
        await recordMissedPayment(env, orderId, session);
        // Each one writes the shared "settings" key; KV allows one write per second.
        await new Promise((r) => setTimeout(r, 1100));
      } catch (err) {
        console.log("reconcile failed", orderId, String(err?.message || err));
      }
    }
  }

  if (!emailConfigured(env)) return;
  const now = Date.now();
  for (const id of (await getOrderIndex(env)).slice(0, 40)) {
    const order = await env.DATA.get(id, "json").catch(() => null);
    if (!order || order.paymentStatus !== "paid" || order.status === "cancelled") continue;
    const ce = order.confirmationEmail || {};
    const paidAt = Date.parse(order.stripe?.paidAt || "") || 0;
    if (
      !ce.sentAt &&
      paidAt > ORDER_EMAIL_LAUNCH &&
      now - paidAt > WEBHOOK_GRACE_SEC * 1000 &&
      now - paidAt < 3 * 24 * 3600 * 1000 &&
      (ce.attempts || 0) < EMAIL_MAX_ATTEMPTS &&
      now - (Date.parse(ce.lastTriedAt || "") || 0) > 10 * 60000
    ) {
      await maybeSendOrderEmail(env, id).catch((err) => console.log("email retry failed", id, String(err?.message || err)));
    }
  }
  await retryRefundEmails(env, now);
}

// How many trays (any tray variety) an order takes. See catalogue.mjs.
const traysFor = traysIn;

const STORED_SETTINGS = ["prices", "traysAvailable", "stock", "trayWeight", "boxCost", "trayCosts", "dozenCosts", "pickup"];

/** Save settings without the fields getSettings works out on read. */
async function putStock(env, settings) {
  const out = {};
  for (const k of STORED_SETTINGS) if (settings[k] !== undefined) out[k] = settings[k];
  await env.DATA.put("settings", JSON.stringify(out));
}

// Reserve or release stock as an order moves through statuses.
// Paid customers always hold their eggs (unless cancelled). Confirmed/done also hold.
async function syncStock(env, order, newStatus) {
  const paid = order.paymentStatus === "paid";
  const holds = newStatus !== "cancelled" && (paid || ["confirmed", "done"].includes(newStatus));
  let move = null;

  if (holds && !order.stockTaken) {
    const now = holdFor(order);
    move = { variety: now.variety, delta: -now.units };
    order.stockTaken = true;
    order.stockHeld = now;
  } else if (!holds && order.stockTaken) {
    // Release what was taken, even if the order's items were edited since.
    const held = heldBy(order);
    move = { variety: held.variety, delta: held.units };
    order.stockTaken = false;
    delete order.stockHeld;
  }

  const variety = move?.variety || holdFor(order).variety;
  if (move && move.variety && move.delta !== 0) {
    const settings = await getSettings(env);
    const left = addStock(settings, move.variety, move.delta);
    await putStock(env, settings);
    if (move.variety === MAIN) {
      // Fire-and-forget: pause Meta ads at 0 trays, resume when restocked.
      syncMetaAdsForStock(env, settings.traysAvailable).catch(() => {});
    }
    return {
      variety: move.variety,
      units: move.delta,
      left,
      delta: move.variety === MAIN ? move.delta : 0,
      traysAvailable: settings.traysAvailable,
    };
  }
  const s = await getSettings(env);
  return {
    variety,
    units: 0,
    left: variety ? stockOf(s, variety) : 0,
    delta: 0,
    traysAvailable: s.traysAvailable,
  };
}

/** Default Flemington ad set from Ads Manager paste kit / meta-browser.mjs */
const DEFAULT_META_ADSET_IDS = ["120251266112450131"]; // New Sales Ad Set. Sydney Markets 45 km
const META_GRAPH = "https://graph.facebook.com/v21.0";
const META_STOCK_FLAG = "meta:ads:pausedByStock";

function metaAdSetIds(env) {
  const raw = String(env.META_ADSET_IDS || env.META_ADSET_ID || "").trim();
  if (!raw) return DEFAULT_META_ADSET_IDS;
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Pause Meta ad sets when traysAvailable hits 0; re-activate only if we paused them.
 * Needs Cloudflare secret META_ACCESS_TOKEN. Optional META_ADSET_ID / META_ADSET_IDS.
 * Box = 6 trays already counted in traysAvailable / traysFor().
 */
async function syncMetaAdsForStock(env, traysAvailable) {
  const token = String(env.META_ACCESS_TOKEN || "").trim();
  if (!token) return { ok: false, skipped: true, reason: "no_token" };

  const trays = Math.max(0, Math.floor(Number(traysAvailable) || 0));
  const ids = metaAdSetIds(env);
  if (!ids.length) return { ok: false, skipped: true, reason: "no_adset" };

  const flag = await env.DATA.get(META_STOCK_FLAG);
  const wePaused = flag === "1";

  if (trays <= 0) {
    const results = [];
    for (const id of ids) {
      const res = await fetch(`${META_GRAPH}/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PAUSED", access_token: token }),
      });
      const json = await res.json().catch(() => ({}));
      results.push({ id, ok: !json.error, error: json.error?.message || null });
    }
    await env.DATA.put(META_STOCK_FLAG, "1");
    await env.DATA.put(
      "meta:ads:lastSync",
      JSON.stringify({ at: new Date().toISOString(), trays, action: "pause", results })
    );
    return { ok: results.every((r) => r.ok), action: "pause", trays, results };
  }

  if (wePaused && trays > 0) {
    const results = [];
    for (const id of ids) {
      const res = await fetch(`${META_GRAPH}/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE", access_token: token }),
      });
      const json = await res.json().catch(() => ({}));
      results.push({ id, ok: !json.error, error: json.error?.message || null });
    }
    await env.DATA.delete(META_STOCK_FLAG);
    await env.DATA.put(
      "meta:ads:lastSync",
      JSON.stringify({ at: new Date().toISOString(), trays, action: "activate", results })
    );
    return { ok: results.every((r) => r.ok), action: "activate", trays, results };
  }

  return { ok: true, action: "noop", trays, wePaused: !!wePaused };
}

/**
 * Public Meta Pixel ID (Events Manager → YOLKO), the same id the pages carry in their pixel
 * snippet. A sale only pairs its browser event with its server event on one pixel, so the
 * server always uses this id. The old META_PIXEL_ID secret is no longer read: it still held
 * the pixel of an ad account nobody can open, and would have split the two again.
 */
const META_PIXEL_ID = "2008953469766472";

function metaPixelId() {
  return META_PIXEL_ID;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeMetaPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("61")) return digits;
  if (digits.startsWith("0")) return "61" + digits.slice(1);
  return digits;
}

function normalizeMetaEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Send Purchase to Meta Conversions API (server-side).
 * Needs META_ACCESS_TOKEN. Dedupes with browser Pixel via event_id = order.id.
 */
async function sendMetaPurchase(env, order, opts = {}) {
  const token = String(env.META_ACCESS_TOKEN || "").trim();
  const pixelId = metaPixelId(env);
  if (!token) return { ok: false, skipped: true, reason: "no_token" };
  if (!pixelId) return { ok: false, skipped: true, reason: "no_pixel" };
  if (!order || order.paymentStatus !== "paid") {
    return { ok: false, skipped: true, reason: "not_paid" };
  }
  if (!opts.force && (order.metaPurchaseSent || (await env.DATA.get(metaSentKey(order.id)).catch(() => null)))) {
    return { ok: true, skipped: true, reason: "already_sent", eventId: order.id };
  }

  const email = normalizeMetaEmail(order.stripe?.email || opts.email || "");
  const phone = normalizeMetaPhone(order.phone);
  const userData = {};
  if (email) userData.em = [await sha256Hex(email)];
  if (phone) userData.ph = [await sha256Hex(phone)];
  if (order.ip) userData.client_ip_address = String(order.ip);
  if (order.ua) userData.client_user_agent = String(order.ua).slice(0, 512);
  if (opts.fbp) userData.fbp = String(opts.fbp);
  if (opts.fbc) userData.fbc = String(opts.fbc);

  const paidAt = order.stripe?.paidAt || order.createdAt || new Date().toISOString();
  let eventTime = Math.floor(new Date(paidAt).getTime() / 1000);
  if (!Number.isFinite(eventTime)) eventTime = Math.floor(Date.now() / 1000);
  // Meta accepts events up to ~7 days old for attribution windows.
  const oldest = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  if (eventTime < oldest) eventTime = oldest + 60;

  const value = Number(order.stripe?.amountTotal != null ? order.stripe.amountTotal : order.price) || 0;
  const contentName =
    isBundle(order.bundle) ? bundleLabel(order.bundle) : String(order.bundle || "eggs");

  const event = {
    event_name: "Purchase",
    event_time: eventTime,
    event_id: String(order.id),
    event_source_url: "https://getyolko.com/",
    action_source: "website",
    user_data: userData,
    custom_data: {
      currency: "AUD",
      value,
      content_type: "product",
      content_name: contentName,
      order_id: String(order.id),
      num_items: Math.max(1, Number(order.quantity) || 1),
    },
  };

  const url = `${META_GRAPH}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [event], partner_agent: "yolko-worker" }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error || !res.ok) {
    return {
      ok: false,
      error: body.error?.message || `meta http ${res.status}`,
      code: body.error?.code || null,
      body,
    };
  }
  return {
    ok: true,
    eventId: order.id,
    eventsReceived: body.events_received ?? null,
    fbtrace_id: body.fbtrace_id || null,
    value,
    contentName,
  };
}

async function markMetaPurchaseSent(env, order, metaResult, { writeOrder = true } = {}) {
  if (!order?.id || !metaResult?.ok || metaResult.skipped) return order;
  const sentAt = new Date().toISOString();
  const eventId = metaResult.eventId || order.id;
  await env.DATA.put(metaSentKey(order.id), JSON.stringify({ sentAt, eventId }));
  order.metaPurchaseSent = true;
  order.metaPurchaseSentAt = sentAt;
  order.metaPurchaseEventId = eventId;
  if (writeOrder) {
    // Patch a fresh copy so fields other paths wrote meanwhile survive.
    const fresh = (await env.DATA.get(order.id, "json")) || order;
    fresh.metaPurchaseSent = true;
    fresh.metaPurchaseSentAt = sentAt;
    fresh.metaPurchaseEventId = eventId;
    await env.DATA.put(order.id, JSON.stringify(fresh));
  }
  return order;
}

function normalizeDozenCosts(stored) {
  const defaults = DEFAULT_SETTINGS.dozenCosts;
  const fromMap = stored?.dozenCosts && typeof stored.dozenCosts === "object" ? stored.dozenCosts : null;
  // Migrate legacy single dozenCost → all SKUs
  let legacy = stored?.dozenCost != null ? Number(stored.dozenCost) : null;
  if (Number.isFinite(legacy) && legacy > 0 && legacy < 30) {
    legacy = Math.round(legacy * DOZENS_PER_CASE * 100) / 100;
  }
  const out = {};
  for (const key of DOZEN_KEYS) {
    const n = Number(fromMap?.[key]);
    if (Number.isFinite(n) && n >= 0) {
      out[key] = Math.round(n * 100) / 100;
    } else if (Number.isFinite(legacy) && legacy >= 0) {
      out[key] = legacy;
    } else if (defaults[key] !== undefined) {
      out[key] = defaults[key];
    }
  }
  return out;
}

/** YOLKO's own prices, for setting competitors against them (never changed from there). */
async function myPrices(env) {
  const settings = await getSettings(env);
  const prices = {};
  for (const k of BUNDLE_KEYS) if (Number(settings.prices[k]) > 0) prices[k] = Number(settings.prices[k]);
  const stock = Object.fromEntries(VARIETIES.map((v) => [v.id, stockOf(settings, v.id)]));
  return { tray1: prices.tray1, tray2: prices.tray2, box: prices.box, prices, stock };
}

/**
 * /egg-prices-sydney for the public: the built page with its tables filled from the same price
 * check Admin > Competitors shows, next to the shop's own live tray prices. If anything fails the
 * page goes out as built (YOLKO's prices and "checking the shops again"), never an error.
 */
async function pricesPageHtml(html, env) {
  try {
    const [latest, settings] = await Promise.all([latestShopPrices(env), getSettings(env)]);
    return fillPricesPage(html, {
      latest,
      prices: settings.prices,
      trayWeight: settings.trayWeight,
      soldOut: Number(settings.traysAvailable) === 0,
      delivery: SITE_DELIVERY_FEE,
      now: Date.now(),
    }).html;
  } catch (err) {
    console.log("prices page fill failed", String(err?.message || err));
    return html;
  }
}

function cleanCosts(map, keys) {
  const out = {};
  for (const k of keys) {
    const n = Number(map?.[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n * 100) / 100;
  }
  return out;
}

async function getSettings(env) {
  return settingsFrom((await env.DATA.get("settings", "json")) || {});
}

/** Settings as every page reads them, from what is stored in KV. */
function settingsFrom(stored) {
  // Prices are exactly what the owner saved in Admin. Nothing here derives them from
  // each other or from a cost. 0 or missing = that option isn't sold.
  const prices = { ...DEFAULT_SETTINGS.prices };
  for (const [k, v] of Object.entries(stored.prices || {})) {
    if (isBundle(k) && Number.isFinite(Number(v)) && Number(v) >= 0) prices[k] = Number(v);
  }
  // A case of 15 that was never priced follows its dozen (as it always has). Once the owner
  // saves a case price, even 0, that is what it is.
  for (const id of DOZEN_KEYS) {
    const caseKey = `${id}case`;
    if (stored.prices?.[caseKey] === undefined && prices[caseKey] === undefined && Number(prices[id]) > 0) {
      prices[caseKey] = Math.round(Number(prices[id]) * DOZENS_PER_CASE);
    }
  }
  const stock = {};
  for (const id of OTHER_VARIETIES) {
    const n = Math.max(0, Math.floor(Number(stored.stock?.[id]) || 0));
    if (n > 0) stock[id] = n;
  }
  const dozenCosts = normalizeDozenCosts(stored);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    prices,
    stock,
    trayCosts: cleanCosts(stored.trayCosts, TRAY_VARIETIES),
    dozenCosts,
    // Older pages read one shared dozen count. It is now the sum of every dozen variety.
    dozensAvailable: DOZEN_KEYS.reduce((sum, id) => sum + (stock[id] || 0), 0),
    pickup: Object.fromEntries(
      WEEK_DAYS.map((d) => [d, cleanPickupDay((stored.pickup || {})[d], DEFAULT_SETTINGS.pickup[d])])
    ),
  };
}

async function handleApi(request, env, url, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Public: current prices and stock. `shop` is what the shop can sell this week; Admin also
  // gets the whole catalogue to draw Stock & prices and name any order.
  if (url.pathname === "/api/settings" && request.method === "GET") {
    const settings = await getSettings(env);
    const out = { ...settings, shop: shopView(settings) };
    if (isAdmin(request, env)) out.catalogue = catalogueView();
    return json(out);
  }

  // Admin: update prices and stock
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "bad json" }, 400);

    const current = await getSettings(env);
    const prices = { ...current.prices };
    for (const key of BUNDLE_KEYS) {
      const raw = body?.prices?.[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      // The main tray always has a price. Anything else can be set to 0 to take it off the shop.
      if (BUNDLES[key].variety === MAIN && n <= 0) continue;
      prices[key] = Math.round(n);
    }
    const dozenCosts = { ...current.dozenCosts, ...cleanCosts(body?.dozenCosts, DOZEN_KEYS) };
    const trayCosts = { ...current.trayCosts, ...cleanCosts(body?.trayCosts, TRAY_VARIETIES) };
    // Stock moves on its own as orders are paid, so only the varieties sent here change.
    const stock = { ...current.stock };
    if (body?.stock && typeof body.stock === "object") {
      for (const id of OTHER_VARIETIES) {
        if (body.stock[id] === undefined) continue;
        const n = Number(body.stock[id]);
        if (Number.isFinite(n)) stock[id] = Math.max(0, Math.floor(n));
      }
    }
    for (const id of Object.keys(stock)) if (!(stock[id] > 0)) delete stock[id];
    const next = {
      prices,
      traysAvailable: Number.isFinite(Number(body?.traysAvailable))
        ? Math.max(0, Math.floor(Number(body.traysAvailable)))
        : current.traysAvailable,
      stock,
      trayWeight: ["1.5", "1.75", "fr-700", "fr-600"].includes(body?.trayWeight)
        ? body.trayWeight
        : current.trayWeight,
      boxCost: Number.isFinite(Number(body?.boxCost))
        ? Math.max(0, Number(body.boxCost))
        : (current.boxCost ?? 55),
      trayCosts,
      dozenCosts,
      pickup: Object.fromEntries(
        WEEK_DAYS.map((d) => [d, cleanPickupDay((body?.pickup || {})[d], current.pickup[d])])
      ),
    };
    await putStock(env, next);
    if (next.traysAvailable !== current.traysAvailable) {
      syncMetaAdsForStock(env, next.traysAvailable).catch(() => {});
    }
    const saved = settingsFrom(next);
    return json({ ...saved, shop: shopView(saved), catalogue: catalogueView() });
  }

  // Admin: sync Meta ad pause/resume from current tray stock (sold out = pause)
  if (url.pathname === "/api/meta-ads-stock-sync" && (request.method === "POST" || request.method === "GET")) {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const settings = await getSettings(env);
    const result = await syncMetaAdsForStock(env, settings.traysAvailable);
    const last = await env.DATA.get("meta:ads:lastSync", "json");
    return json({
      traysAvailable: settings.traysAvailable,
      note: "Pauses configured Meta ad sets when traysAvailable is 0 (box = 6 trays). Resumes only if this automation paused them.",
      ...result,
      last,
      hasToken: Boolean(String(env.META_ACCESS_TOKEN || "").trim()),
      adSetIds: metaAdSetIds(env),
    });
  }

  // Public: short-lived one-time token required to place an order (anti-bot)
  if (url.pathname === "/api/order-token" && request.method === "GET") {
    if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403);
    const { token } = await issueOrderToken(env);
    return json({ token, ttlSec: 600 });
  }

  // A friend's share link: whose it is, so the shop can say who sent the free delivery.
  if (url.pathname === "/api/referral" && request.method === "GET") {
    if (!(await allowRate(env, `referral:${clientIp(request) || "unknown"}`, 30, 3600))) return json({ error: "rate" }, 429);
    const code = cleanRefCode(url.searchParams.get("code"));
    if (code && HOUSE_REF_CODES.has(code)) return json({ ok: true, code, name: "", house: true }, 200, { "Cache-Control": "no-store" });
    const rec = code ? await env.DATA.get(refCodeKey(code), "json").catch(() => null) : null;
    if (!rec) return json({ ok: false }, 404, { "Cache-Control": "no-store" });
    return json({ ok: true, code, name: rec.name || "" }, 200, { "Cache-Control": "no-store" });
  }

  // "Order again" in a reminder email: the customer's last order, to fill in the form.
  if (url.pathname === "/api/reorder" && request.method === "GET") {
    if (!(await allowRate(env, `reorder:${clientIp(request) || "unknown"}`, 30, 3600))) return json({ error: "rate" }, 429);
    const found = await reminderByToken(env, url.searchParams.get("t"));
    if (!found) return json({ error: "This link has expired" }, 404);
    const { h, rec } = found;
    const item = reminderItem(rec, await getSettings(env));
    runLater(ctx, env.DATA.put(remindSubKey(h), JSON.stringify({ ...rec, clicks: (rec.clicks || 0) + 1, lastClickAt: new Date().toISOString() })));
    return json(
      {
        ok: true,
        name: rec.name || "",
        phone: rec.phone || "",
        bundle: item.bundle,
        quantity: item.quantity,
        deliveryStreet: rec.deliveryStreet || "",
        deliverySuburb: rec.deliverySuburb || "",
        deliveryCity: rec.deliveryCity || "Sydney",
        deliveryPostcode: rec.deliveryPostcode || "",
        subscribed: !rec.unsubscribedAt,
      },
      200,
      { "Cache-Control": "no-store" }
    );
  }

  // Unsubscribe link in reminder emails. GET asks and POST stops, because mail
  // scanners open links (GET) before the customer does.
  if (url.pathname === "/api/reminders/stop" && (request.method === "GET" || request.method === "POST")) {
    const token = String(url.searchParams.get("t") || "");
    const found = await reminderByToken(env, token);
    if (!found) return reminderPage("This link has expired", "<p>Still getting reminders? Reply to one and we will stop them.</p>", 404);
    const { h, rec } = found;
    const done = reminderPage("You're unsubscribed", "<p>You won't get Thursday reminders any more. Changed your mind? Tick the reminder box next time you order.</p><a class=\"btn\" href=\"/\">Back to YOLKO</a>");
    if (request.method === "GET") {
      if (rec.unsubscribedAt) return done;
      return reminderPage(
        "Stop Thursday reminders?",
        `<p>We'll stop emailing ${htmlEscape(maskEmail(rec.email))} before Saturday delivery.</p><form method="post" action="/api/reminders/stop?t=${token}"><button type="submit">Unsubscribe</button></form>`
      );
    }
    if (!rec.unsubscribedAt) {
      await env.DATA.put(remindSubKey(h), JSON.stringify({ ...rec, unsubscribedAt: new Date().toISOString() }));
      const list = await getRemindIndex(env);
      if (list.includes(h)) await setRemindIndex(env, list.filter((x) => x !== h));
    }
    return done;
  }

  // Public: check delivery suburb / postcode is within 45 km of Sydney Markets
  if (url.pathname === "/api/delivery-check" && request.method === "POST") {
    if (!isAllowedOrigin(request)) {
      return json({ error: "forbidden", code: "origin" }, 403);
    }
    const body = await request.json().catch(() => null);
    const result = checkDeliveryAddress({
      street: body?.street || body?.deliveryStreet || "Address check",
      suburb: body?.suburb || body?.deliverySuburb,
      city: body?.city || body?.deliveryCity,
      postcode: body?.postcode || body?.deliveryPostcode,
    });
    return json({
      ...result,
      maxKm: MAX_DELIVERY_KM,
      fee: result.deliver ? SITE_DELIVERY_FEE : null,
    }, result.ok ? 200 : 400);
  }

  // Public: place an order
  if (url.pathname === "/api/orders" && request.method === "POST") {
    if (!isAllowedOrigin(request)) {
      return json({ error: "forbidden", code: "origin" }, 403);
    }

    const body = await request.json().catch(() => null);
    const name = String(body?.name || "").trim().slice(0, 80);
    const phone = String(body?.phone || "").replace(/\D/g, "").slice(0, 12);
    const bundle = BUNDLE_KEYS.includes(body?.bundle) ? body.bundle : null;
    // Storefront is delivery-only (Saturday). Reject legacy pickup payloads.
    if (body?.fulfillment === "pickup") {
      return json({ error: "Pickup is no longer available. Saturday delivery only", code: "delivery_only" }, 400);
    }
    const fulfillment = "delivery";
    let pickupDay = WEEK_DAYS.includes(body?.pickupDay) ? body.pickupDay : null;
    const quantity = Math.min(20, Math.max(1, Math.floor(Number(body?.quantity)) || 1));
    let pickupDate = String(body?.pickupDate || "").replace(/[^0-9A-Za-z ]/g, "").slice(0, 12);
    const deliveryStreet = String(body?.deliveryStreet || "").trim().slice(0, 120);
    const deliverySuburb = String(body?.deliverySuburb || "").trim().slice(0, 60);
    const deliveryCity = String(body?.deliveryCity || "").trim().slice(0, 60);
    const deliveryPostcode = String(body?.deliveryPostcode || "").replace(/\D/g, "").slice(0, 4);
    const legacyAddress = String(body?.deliveryAddress || "").trim().slice(0, 200);
    let deliveryAddress = "";
    let deliveryZone = null;
    // Honeypot: bots fill hidden field. pretend success, save nothing.
    // Accept legacy "company" too. Never return a fake order id (that breaks Buy now → checkout).
    const honeypot = String(body?.yolko_hp || body?.company || "").trim();
    if (honeypot) {
      return json({ ok: true, ignored: true });
    }

    const tokenCheck = await consumeOrderToken(env, body?.token);
    if (!tokenCheck.ok) {
      return json({ error: "refresh and try again", code: "token_" + tokenCheck.reason }, 403);
    }

    if (fulfillment === "delivery") {
      pickupDay = "Saturday";
      // The Worker decides the run, so a stale tab can't book a Saturday that has closed.
      pickupDate = deliverySaturday().label;
      const street = deliveryStreet || legacyAddress;
      deliveryZone = checkDeliveryAddress({
        street,
        suburb: deliverySuburb,
        city: deliveryCity,
        postcode: deliveryPostcode,
      });
      // Legacy free-text: "street, suburb, postcode"
      if (!deliveryZone.ok && !deliverySuburb && !deliveryPostcode && legacyAddress.length >= 5) {
        const parts = legacyAddress.split(",").map((p) => p.trim()).filter(Boolean);
        const maybePc = parts.length ? String(parts[parts.length - 1]).replace(/\D/g, "") : "";
        const pc = maybePc.length === 4 ? maybePc : "";
        const suburb = parts.length >= 2 ? parts[parts.length - (pc ? 2 : 1)] : "";
        const streetPart = parts.length >= 2 ? parts.slice(0, parts.length - (pc ? 2 : 1)).join(", ") : legacyAddress;
        deliveryZone = checkDeliveryAddress({
          street: streetPart || legacyAddress,
          suburb,
          city: deliveryCity || "Sydney",
          postcode: pc || deliveryPostcode,
        });
      }
      if (!deliveryZone.ok) {
        return json({
          error: deliveryZone.error || "delivery address required",
          code: deliveryZone.code === "out_of_range" ? "delivery_range" : "delivery_address",
          maxKm: MAX_DELIVERY_KM,
          roadKmEstimate: deliveryZone.roadKmEstimate || null,
        }, 400);
      }
      deliveryAddress = deliveryZone.formatted;
    }

    if (!name || name.length < 2 || !/^04\d{8}$/.test(phone) || !bundle || !pickupDay) {
      return json({ error: "invalid order" }, 400);
    }
    // Block obvious junk names
    if (/^[a-z]{1,2}$/i.test(name) || /https?:|www\.|@/.test(name)) {
      return json({ error: "invalid order" }, 400);
    }

    const settings = await getSettings(env);
    if (fulfillment === "delivery") {
      // Delivery is Saturday only (even if pickup Saturday hours were toggled off).
      if (pickupDay !== "Saturday") {
        return json({ error: "delivery only on Saturday", code: "delivery_day" }, 400);
      }
    } else if (!settings.pickup[pickupDay]?.enabled) {
      return json({ error: "pickup day unavailable" }, 400);
    }

    // Every variety but the main tray needs a price and enough stock (catalogue.mjs).
    const problem = stockProblem(settings, bundle, quantity);
    if (problem) return json({ error: problem.error, code: problem.code }, 400);

    // Record country on the order; do not hard-block (iCloud Private Relay / VPN
    // can make real Sydney customers look non-AU and break Buy now).
    const ip = clientIp(request);
    const meta = clientMeta(request);
    // Soft anti-spam: allow retries after cancelling Stripe Checkout.
    // Prefer reusing an unpaid order for the same phone (no duplicate rows).
    const existingOpen = await getOpenUnpaidOrder(env, phone);
    if (existingOpen) {
      const subtotal = settings.prices[bundle] * quantity;
      const deliveryFee = fulfillment === "delivery" ? SITE_DELIVERY_FEE : 0;
      existingOpen.name = name;
      existingOpen.bundle = bundle;
      existingOpen.quantity = quantity;
      existingOpen.fulfillment = fulfillment;
      existingOpen.deliveryAddress = fulfillment === "delivery" ? deliveryAddress : "";
      existingOpen.deliveryStreet = fulfillment === "delivery" ? (deliveryZone?.street || deliveryStreet) : "";
      existingOpen.deliverySuburb = fulfillment === "delivery" ? (deliveryZone?.suburb || deliverySuburb) : "";
      existingOpen.deliveryCity = fulfillment === "delivery" ? (deliveryZone?.city || deliveryCity) : "";
      existingOpen.deliveryPostcode = fulfillment === "delivery" ? (deliveryZone?.postcode || deliveryPostcode) : "";
      existingOpen.deliveryKm = fulfillment === "delivery" ? (deliveryZone?.roadKmEstimate || null) : null;
      existingOpen.deliveryFee = deliveryFee;
      existingOpen.pickupDay = pickupDay;
      existingOpen.pickupDate = pickupDate;
      existingOpen.subtotal = subtotal;
      existingOpen.price = subtotal + deliveryFee;
      existingOpen.updatedAt = new Date().toISOString();
      if (body?.remind === true) existingOpen.remindOptIn = true;
      else delete existingOpen.remindOptIn;
      applyDeliveryPerk(existingOpen, await deliveryPerk(env, perkInput(existingOpen, body)));
      // Keep pending so checkout can mint a fresh session after cancel.
      if (existingOpen.paymentStatus !== "paid") existingOpen.paymentStatus = existingOpen.paymentStatus || "new";
      if (existingOpen.status === "cancelled") existingOpen.status = "new";
      await env.DATA.put(existingOpen.id, JSON.stringify(existingOpen));
      await rememberOpenOrder(env, phone, existingOpen.id);
      return json({
        ok: true,
        id: existingOpen.id,
        price: existingOpen.price,
        deliveryFee: existingOpen.deliveryFee,
        deliveryPerk: existingOpen.deliveryPerk || null,
        deliveryKm: existingOpen.deliveryKm,
        deliveryAddress: existingOpen.deliveryAddress,
        reused: true,
      });
    }

    // No IP/phone rate limits. Buy now / cancel / retry must always work.
    const subtotal = settings.prices[bundle] * quantity;
    const deliveryFee = fulfillment === "delivery" ? SITE_DELIVERY_FEE : 0;
    const now = new Date();
    const id = `order:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
    const order = {
      id,
      name,
      phone,
      bundle,
      quantity,
      fulfillment,
      deliveryAddress: fulfillment === "delivery" ? deliveryAddress : "",
      deliveryStreet: fulfillment === "delivery" ? (deliveryZone?.street || deliveryStreet) : "",
      deliverySuburb: fulfillment === "delivery" ? (deliveryZone?.suburb || deliverySuburb) : "",
      deliveryCity: fulfillment === "delivery" ? (deliveryZone?.city || deliveryCity) : "",
      deliveryPostcode: fulfillment === "delivery" ? (deliveryZone?.postcode || deliveryPostcode) : "",
      deliveryKm: fulfillment === "delivery" ? (deliveryZone?.roadKmEstimate || null) : null,
      deliveryFee,
      pickupDay,
      pickupDate,
      subtotal,
      price: subtotal + deliveryFee,
      status: "new",
      createdAt: now.toISOString(),
      ip: ip || null,
      country: meta.country,
      asnOrg: meta.asnOrg,
      colo: meta.colo,
      ua: meta.ua,
      visitorId: cleanVisitId(body?.visitorId),
      ...(body?.remind === true ? { remindOptIn: true } : {}),
    };
    applyDeliveryPerk(order, await deliveryPerk(env, perkInput(order, body)));
    await env.DATA.put(id, JSON.stringify(order));
    await pushOrderIndex(env, id);
    await rememberOpenOrder(env, phone, id);
    return json({
      ok: true,
      id,
      price: order.price,
      deliveryFee: order.deliveryFee,
      deliveryPerk: order.deliveryPerk || null,
      deliveryKm: order.deliveryKm,
      deliveryAddress: order.deliveryAddress,
    });
  }

  // Admin: auth check only (no KV list. free tier list() has a daily cap)
  if (url.pathname === "/api/admin/ping" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    return json({ ok: true });
  }

  // Admin: one-read check for new orders, so a background tab can poll cheaply.
  if (url.pathname === "/api/admin/orders-head" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const [ids, lastPaid] = await Promise.all([getOrderIndex(env), env.DATA.get("orders:lastpaid").catch(() => null)]);
    return json({ count: ids.length, latest: ids[0] || null, lastPaid: lastPaid || null });
  }

  // Admin: list orders, newest first (uses orders:index. avoids KV list())
  if (url.pathname === "/api/orders" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    try {
      const ids = await getOrderIndex(env);
      const orders = await Promise.all(ids.map((id) => env.DATA.get(id, "json").catch(() => null)));
      const valid = orders
        .filter((o) => o && typeof o === "object")
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json({ orders: valid });
    } catch (err) {
      return json({ error: "orders_failed", detail: String(err && err.message || err), orders: [] }, 500);
    }
  }

  // Public: create a locked-amount Stripe checkout for an existing order
  // Amounts always come from live admin settings (+ delivery fee on the order).
  if (url.pathname === "/api/checkout" && request.method === "POST") {
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);
    const body = await request.json().catch(() => null);
    const orderId = String(body?.orderId || "");
    if (!orderId.startsWith("order:")) return json({ error: "bad order" }, 400);

    const order = await env.DATA.get(orderId, "json");
    if (!order) return json({ error: "order not found" }, 404);
    if (order.paymentStatus === "paid") return json({ error: "already paid" }, 400);

    // Don't block checkout on branding. refresh in background if needed.
    maybeEnsureStripeBranding(env, ctx);

    await rollDeliveryDate(env, order);
    const settings = await getSettings(env);
    const result = await createCheckoutForOrder(env, order, settings, ctx);
    if (result.error) return json({ error: result.error, code: result.code || null, detail: result.detail || null }, result.status || 502);
    return json(result);
  }

  // Public: ONE-SHOT Buy now. create/reuse order + Stripe session in a single request.
  if (url.pathname === "/api/buy-now" && request.method === "POST") {
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);
    if (!isAllowedOrigin(request)) {
      return json({ error: "forbidden", code: "origin" }, 403);
    }

    const body = await request.json().catch(() => null);
    const name = String(body?.name || "").trim().slice(0, 80);
    const phone = String(body?.phone || "").replace(/\D/g, "").slice(0, 12);
    const bundle = BUNDLE_KEYS.includes(body?.bundle) ? body.bundle : null;
    if (body?.fulfillment === "pickup") {
      return json({ error: "Pickup is no longer available. Saturday delivery only", code: "delivery_only" }, 400);
    }
    const fulfillment = "delivery";
    let pickupDay = WEEK_DAYS.includes(body?.pickupDay) ? body.pickupDay : null;
    const quantity = Math.min(20, Math.max(1, Math.floor(Number(body?.quantity)) || 1));
    let pickupDate = String(body?.pickupDate || "").replace(/[^0-9A-Za-z ]/g, "").slice(0, 12);
    const deliveryStreet = String(body?.deliveryStreet || "").trim().slice(0, 120);
    const deliverySuburb = String(body?.deliverySuburb || "").trim().slice(0, 60);
    const deliveryCity = String(body?.deliveryCity || "").trim().slice(0, 60);
    const deliveryPostcode = String(body?.deliveryPostcode || "").replace(/\D/g, "").slice(0, 4);
    const legacyAddress = String(body?.deliveryAddress || "").trim().slice(0, 200);
    let deliveryAddress = "";
    let deliveryZone = null;

    const honeypot = String(body?.yolko_hp || body?.company || "").trim();
    if (honeypot) return json({ ok: true, ignored: true });

    // Token optional for speed when already prefetched; still consume if present.
    if (body?.token) {
      const tokenCheck = await consumeOrderToken(env, body.token);
      if (!tokenCheck.ok && tokenCheck.reason !== "missing") {
        // Ignore expired/invalid. Buy now must stay fast; other checks remain.
      }
    }

    if (fulfillment === "delivery") {
      pickupDay = "Saturday";
      // The Worker decides the run, so a stale tab can't book a Saturday that has closed.
      pickupDate = deliverySaturday().label;
      const street = deliveryStreet || legacyAddress;
      deliveryZone = checkDeliveryAddress({
        street,
        suburb: deliverySuburb,
        city: deliveryCity,
        postcode: deliveryPostcode,
      });
      if (!deliveryZone.ok && !deliverySuburb && !deliveryPostcode && legacyAddress.length >= 5) {
        const parts = legacyAddress.split(",").map((p) => p.trim()).filter(Boolean);
        const maybePc = parts.length ? String(parts[parts.length - 1]).replace(/\D/g, "") : "";
        const pc = maybePc.length === 4 ? maybePc : "";
        const suburb = parts.length >= 2 ? parts[parts.length - (pc ? 2 : 1)] : "";
        const streetPart = parts.length >= 2 ? parts.slice(0, parts.length - (pc ? 2 : 1)).join(", ") : legacyAddress;
        deliveryZone = checkDeliveryAddress({
          street: streetPart || legacyAddress,
          suburb,
          city: deliveryCity || "Sydney",
          postcode: pc || deliveryPostcode,
        });
      }
      if (!deliveryZone.ok) {
        return json({
          error: deliveryZone.error || "delivery address required",
          code: deliveryZone.code === "out_of_range" ? "delivery_range" : "delivery_address",
          maxKm: MAX_DELIVERY_KM,
          roadKmEstimate: deliveryZone.roadKmEstimate || null,
        }, 400);
      }
      deliveryAddress = deliveryZone.formatted;
    }

    if (!name || name.length < 2 || !/^04\d{8}$/.test(phone) || !bundle || !pickupDay) {
      return json({ error: "invalid order" }, 400);
    }
    if (/^[a-z]{1,2}$/i.test(name) || /https?:|www\.|@/.test(name)) {
      return json({ error: "invalid order" }, 400);
    }

    const settings = await getSettings(env);
    if (fulfillment === "delivery") {
      if (pickupDay !== "Saturday") {
        return json({ error: "delivery only on Saturday", code: "delivery_day" }, 400);
      }
    } else if (!settings.pickup[pickupDay]?.enabled) {
      return json({ error: "pickup day unavailable" }, 400);
    }
    const problem = stockProblem(settings, bundle, quantity);
    if (problem) return json({ error: problem.error, code: problem.code }, 400);

    const meta = clientMeta(request);
    // AU mobile is required already. do not hard-block on CF country
    // (Private Relay / VPN falsely flags Sydney customers).

    maybeEnsureStripeBranding(env, ctx);

    const subtotal = settings.prices[bundle] * quantity;
    const deliveryFee = fulfillment === "delivery" ? SITE_DELIVERY_FEE : 0;
    let order = await getOpenUnpaidOrder(env, phone);
    if (order) {
      order.name = name;
      order.bundle = bundle;
      order.quantity = quantity;
      order.visitorId = cleanVisitId(body?.visitorId) || order.visitorId || null;
      order.fulfillment = fulfillment;
      order.deliveryAddress = fulfillment === "delivery" ? deliveryAddress : "";
      order.deliveryStreet = fulfillment === "delivery" ? (deliveryZone?.street || deliveryStreet) : "";
      order.deliverySuburb = fulfillment === "delivery" ? (deliveryZone?.suburb || deliverySuburb) : "";
      order.deliveryCity = fulfillment === "delivery" ? (deliveryZone?.city || deliveryCity) : "";
      order.deliveryPostcode = fulfillment === "delivery" ? (deliveryZone?.postcode || deliveryPostcode) : "";
      order.deliveryKm = fulfillment === "delivery" ? (deliveryZone?.roadKmEstimate || null) : null;
      order.deliveryFee = deliveryFee;
      order.pickupDay = pickupDay;
      order.pickupDate = pickupDate;
      order.subtotal = subtotal;
      order.price = subtotal + deliveryFee;
      order.updatedAt = new Date().toISOString();
      if (order.status === "cancelled") order.status = "new";
    } else {
      const now = new Date();
      const id = `order:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
      order = {
        id,
        name,
        phone,
        bundle,
        quantity,
        fulfillment,
        deliveryAddress: fulfillment === "delivery" ? deliveryAddress : "",
        deliveryStreet: fulfillment === "delivery" ? (deliveryZone?.street || deliveryStreet) : "",
        deliverySuburb: fulfillment === "delivery" ? (deliveryZone?.suburb || deliverySuburb) : "",
        deliveryCity: fulfillment === "delivery" ? (deliveryZone?.city || deliveryCity) : "",
        deliveryPostcode: fulfillment === "delivery" ? (deliveryZone?.postcode || deliveryPostcode) : "",
        deliveryKm: fulfillment === "delivery" ? (deliveryZone?.roadKmEstimate || null) : null,
        deliveryFee,
        pickupDay,
        pickupDate,
        subtotal,
        price: subtotal + deliveryFee,
        status: "new",
        createdAt: now.toISOString(),
        ip: clientIp(request) || null,
        country: meta.country,
        asnOrg: meta.asnOrg,
        colo: meta.colo,
        ua: meta.ua,
        visitorId: cleanVisitId(body?.visitorId),
      };
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(pushOrderIndex(env, id));
      } else {
        await pushOrderIndex(env, id);
      }
    }

    // "Email me a reminder each Thursday" at checkout; signed up once the order is paid.
    if (body?.remind === true) order.remindOptIn = true;
    else delete order.remindOptIn;
    applyDeliveryPerk(order, await deliveryPerk(env, perkInput(order, body)));

    let result = await createCheckoutForOrder(env, order, settings, ctx);
    if (result.alreadyPaid) {
      // The reused order was paid in the meantime, so this is a new purchase.
      const now = new Date();
      const {
        sessionId: _s, paymentStatus: _p, stripe: _st, stockTaken: _t, updatedAt: _u,
        confirmationEmail: _c, metaPurchaseSent: _m, metaPurchaseSentAt: _ma, metaPurchaseEventId: _me,
        ...details
      } = order;
      order = {
        ...details,
        id: `order:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`,
        status: "new",
        createdAt: now.toISOString(),
      };
      await pushOrderIndex(env, order.id);
      result = await createCheckoutForOrder(env, order, settings, ctx);
    }
    // One write, with the final order id (KV allows one write per key per second).
    await rememberOpenOrder(env, phone, order.id);
    if (result.error) return json({ error: result.error, code: result.code || null, detail: result.detail || null }, result.status || 502);
    return json({ ok: true, ...result });
  }

  // Stripe webhook: the reliable "paid" signal, even if the customer closes
  // the tab before returning to the site. Marks the order paid and emails them.
  if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
    if (!env.STRIPE_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      return json({ error: "webhook not configured" }, 503);
    }
    const payload = await request.text();
    const ok = await verifyStripeSignature(
      payload,
      request.headers.get("Stripe-Signature"),
      env.STRIPE_WEBHOOK_SECRET
    );
    if (!ok) return json({ error: "bad signature" }, 400);

    const event = JSON.parse(payload);
    if (event.type === "charge.refunded") {
      const result = await handleChargeRefunded(env, event.data?.object?.id);
      return json({ received: true, ...result }, result.error ? 502 : 200);
    }
    const handled = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
    if (!handled.includes(event.type)) return json({ received: true, ignored: event.type });

    const sid = event.data?.object?.id;
    if (!sid) return json({ received: true, ignored: "no session" });
    // Re-fetch so we act on Stripe's current state with charge details expanded,
    // and take the order id from Stripe's copy rather than the event payload.
    const session = await fetchStripeSession(env, sid);
    if (session.error) return json({ error: session.error.message || "stripe error" }, 502);
    const orderId = session.metadata?.orderId;
    if (!String(orderId || "").startsWith("order:")) {
      return json({ received: true, ignored: "no order" });
    }
    if (session.payment_status !== "paid") return json({ received: true, pending: true });

    const order = await env.DATA.get(orderId, "json");
    if (!order) return json({ received: true, ignored: "order not found" });
    const { refunded } = await markOrderPaid(env, order, session);
    if (refunded) return json({ received: true, ignored: "refunded" });
    // The paid state is saved; email problems are retried by the cron, not by
    // making Stripe redeliver.
    const email = await maybeSendOrderEmail(env, orderId).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    return json({ received: true, email: { ok: !!email.ok, reason: email.reason || email.error || null } });
  }

  // Admin: send (or resend) the order confirmation email for a paid order
  if (url.pathname === "/api/admin/order-email" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const id = String(body?.id || "");
    if (!id.startsWith("order:")) return json({ error: "bad order" }, 400);
    const result = await maybeSendOrderEmail(env, id, { force: true });
    return json(result, result.ok ? 200 : 502);
  }

  // Admin: printable share cards (QR codes) for the boxes on a delivery run
  if (url.pathname === "/api/admin/ref-cards" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const ids = (Array.isArray(body?.ids) ? body.ids : []).map(String).filter((id) => id.startsWith("order:")).slice(0, 60);
    if (!ids.length) return json({ error: "No orders" }, 400);
    const [cards, settings] = await Promise.all([refCardsFor(env, ids), getSettings(env)]);
    return json({ ok: true, cards, trayPrice: Number(settings.prices?.tray1) || null });
  }

  // Admin: every paid order's confirmation email and whether it went out
  if (url.pathname === "/api/admin/emails" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const ids = await getOrderIndex(env);
    const orders = (await Promise.all(ids.map((id) => env.DATA.get(id, "json").catch(() => null)))).filter(
      (o) => o && typeof o === "object" && (o.paymentStatus === "paid" || o.paymentStatus === "refunded")
    );
    // The sent marker survives whole-order writes from stale copies, so check it too.
    const markers = await Promise.all(
      orders.map((o) => (o.confirmationEmail?.sentAt ? null : env.DATA.get(emailSentKey(o.id), "json").catch(() => null)))
    );
    const events = await Promise.all(orders.map((o) => env.DATA.get(emailEventsKey(o.id), "json").catch(() => null)));
    // Emails sent before delivery tracking began get their request ids indexed once.
    if (!(await env.DATA.get("email:req:backfill:1"))) {
      await Promise.all(
        orders.map((o, i) => rememberEmailForEvents(env, o, o.confirmationEmail?.requestId || markers[i]?.requestId))
      );
      await env.DATA.put("email:req:backfill:1", "1");
    }
    const when = (e) => e.sentAt || e.lastTriedAt || e.paidAt || e.createdAt || "";
    const emails = orders
      .map((o, i) => ({ ...orderEmailEntry(o, markers[i]), delivery: events[i] || null }))
      .sort((a, b) => String(when(b)).localeCompare(String(when(a))));
    return json({ ok: true, emails, status: await emailStatus(env) });
  }

  // Admin: the confirmation email for one order, rebuilt exactly as it is sent
  if (url.pathname === "/api/admin/email-preview" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const id = String(url.searchParams.get("id") || "");
    if (!id.startsWith("order:")) return json({ error: "bad order" }, 400);
    const order = await env.DATA.get(id, "json");
    if (!order) return json({ error: "Order not found" }, 404);
    const { subject, html, text } = buildOrderEmail(order);
    return json({
      ok: true,
      subject,
      html,
      text,
      to: String(order.confirmationEmail?.to || order.stripe?.email || order.email || "").trim() || null,
      toName: order.name || "",
      from: String(env.ORDER_EMAIL_FROM || "").trim() || null,
      fromName: STRIPE_BRAND,
      replyTo: SHOP_EMAIL,
      sent: Boolean(order.confirmationEmail?.sentAt),
    });
  }

  // Admin: send a sample confirmation or refund email to any address (one a minute)
  if (url.pathname === "/api/admin/test-email" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    if (!emailConfigured(env)) return json({ ok: false, error: "Email sending isn't set up" }, 503);
    const body = await request.json().catch(() => null);
    const to = String(body?.to || "").trim();
    if (to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ ok: false, error: "Enter a valid email address" }, 400);
    if (await env.DATA.get("email:test:recent")) return json({ ok: false, error: "One test a minute. Try again shortly" }, 429);
    await env.DATA.put("email:test:recent", "1", { expirationTtl: 60 });
    const settings = await getSettings(env);
    const subtotal = Number(settings.prices?.tray2) || 0;
    const sample = {
      id: "order:test-sample",
      name: "Test",
      bundle: "tray2",
      quantity: 1,
      subtotal,
      deliveryFee: SITE_DELIVERY_FEE,
      price: subtotal + SITE_DELIVERY_FEE,
      deliveryAddress: "1 Example St, Sydney NSW",
      stripe: { email: to },
    };
    const result = body?.kind === "refund"
      ? await sendCustomerEmail(env, sample, buildRefundEmail(sample, { id: "re_test", amount: sample.price, currency: "AUD" }), { test: true })
      : await sendOrderConfirmationEmail(env, sample, { test: true });
    return json(result, result.ok ? 200 : 502);
  }

  // Admin: Thursday reminders, who is signed up and how the last run went
  if (url.pathname === "/api/admin/reminders" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const list = await getRemindIndex(env);
    const recs = (await Promise.all(list.slice(0, 300).map((h) => env.DATA.get(remindSubKey(h), "json").catch(() => null)))).filter(Boolean);
    const people = recs.map((r) => ({
      name: r.name || "",
      email: r.email,
      suburb: r.deliverySuburb || "",
      since: r.optedInAt || null,
      lastSentAt: r.lastSentAt || null,
      clicks: r.clicks || 0,
      lastError: r.lastError || null,
    }));
    return json({ ok: true, ...(await reminderStatus(env)), people });
  }

  // Admin: pause or resume Thursday reminders
  if (url.pathname === "/api/admin/reminders" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    if (typeof body?.on !== "boolean") return json({ error: "bad request" }, 400);
    if (body.on) await env.DATA.delete(REMIND_OFF);
    else await env.DATA.put(REMIND_OFF, new Date().toISOString());
    return json({ ok: true, ...(await reminderStatus(env)) });
  }

  // Admin: send a sample reminder whose links work, for a made-up customer who is
  // never in the Thursday list (one a minute)
  if (url.pathname === "/api/admin/reminders/test" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ ok: false, error: "Connect Zoho Mail first" }, 503);
    const body = await request.json().catch(() => null);
    const to = String(body?.to || "").trim();
    if (to.length > 254 || !EMAIL_RE.test(to)) return json({ ok: false, error: "Enter a valid email address" }, 400);
    if (await env.DATA.get("remind:test:recent")) return json({ ok: false, error: "One test a minute. Try again shortly" }, 429);
    await env.DATA.put("remind:test:recent", "1", { expirationTtl: 60 });
    const prev = await env.DATA.get(remindSubKey("test"), "json").catch(() => null);
    const token = prev?.token || randomHex(16);
    const rec = {
      name: "Test",
      email: to,
      phone: "0400000000",
      bundle: "tray2",
      quantity: 1,
      deliveryStreet: "1 Example St",
      deliverySuburb: "Strathfield",
      deliveryCity: "Sydney",
      deliveryPostcode: "2135",
      token,
    };
    await env.DATA.put(remindSubKey("test"), JSON.stringify(rec));
    if (!prev?.token) await env.DATA.put(remindTokKey(token), "test");
    const result = await sendReminderEmail(env, auth, rec, await getSettings(env), deliverySaturday(), { test: true });
    return json(result, result.ok ? 200 : 502);
  }

  // Admin: start the one-time Zoho Mail sign-in. Returns the Zoho consent URL to open.
  if (url.pathname === "/api/admin/zoho/connect" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    if (!zohoClientConfigured(env)) return json({ error: "The Zoho client isn't set up on the Worker yet" }, 503);
    const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[^A-Za-z0-9]/g, "");
    await env.DATA.put(`zoho:oauth:state:${state}`, "1", { expirationTtl: 600 });
    const auth = new URL(`${String(env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/+$/, "")}/oauth/v2/auth`);
    auth.search = new URLSearchParams({
      scope: ZOHO_SCOPES,
      client_id: String(env.ZOHO_CLIENT_ID).trim(),
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: `${url.origin}/api/zoho/callback`,
      state,
    }).toString();
    return json({ ok: true, url: auth.toString() });
  }

  // Zoho sends the owner back here after they allow access.
  if (url.pathname === "/api/zoho/callback" && request.method === "GET") {
    const back = (status, msg) =>
      Response.redirect(`${url.origin}/admin#emails?zoho=${status}${msg ? `&msg=${encodeURIComponent(String(msg).slice(0, 160))}` : ""}`, 302);
    const state = String(url.searchParams.get("state") || "");
    if (!/^[A-Za-z0-9]{16,64}$/.test(state) || !(await env.DATA.get(`zoho:oauth:state:${state}`))) {
      return back("error", "That sign-in link expired. Try Connect again");
    }
    await env.DATA.delete(`zoho:oauth:state:${state}`);
    if (url.searchParams.get("error")) return back("error", url.searchParams.get("error") === "access_denied" ? "Access wasn't allowed" : url.searchParams.get("error"));
    const code = String(url.searchParams.get("code") || "");
    if (!code || !zohoClientConfigured(env)) return back("error", "Zoho didn't send a sign-in code");
    let accountsUrl = String(env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/+$/, "");
    const server = url.searchParams.get("accounts-server");
    if (server) {
      try {
        const host = new URL(server).host;
        if (ZOHO_ACCOUNTS_HOST.test(host)) accountsUrl = `https://${host}`;
      } catch {}
    }
    try {
      const resp = await fetch(`${accountsUrl}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: String(env.ZOHO_CLIENT_ID).trim(),
          client_secret: String(env.ZOHO_CLIENT_SECRET).trim(),
          redirect_uri: `${url.origin}/api/zoho/callback`,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!data?.refresh_token) return back("error", `Zoho said: ${data?.error || `HTTP ${resp.status}`}`);
      const mailUrl = String(env.ZOHO_MAIL_URL || zohoMailHostFor(accountsUrl)).replace(/\/+$/, "");
      const auth = { refreshToken: data.refresh_token, accountsUrl, mailUrl, accountId: null, address: null };
      zohoToken = { tag: auth.refreshToken.slice(-12), token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
      zohoAccount = null;
      const acct = await zohoMailAccount(env, auth);
      if (String(acct.address || "").toLowerCase() !== SHOP_EMAIL) {
        zohoToken = null;
        zohoAccount = null;
        return back("error", `That was ${acct.address || "another account"}. Sign in to Zoho as ${SHOP_EMAIL}`);
      }
      await env.DATA.put(
        ZOHO_AUTH_KEY,
        JSON.stringify({
          token: await sealSecret(env, data.refresh_token),
          accountsUrl,
          mailUrl: auth.mailUrl,
          accountId: acct.accountId,
          address: acct.address,
          connectedAt: new Date().toISOString(),
        })
      );
      return back("connected");
    } catch (err) {
      return back("error", String(err?.message || err));
    }
  }

  // Admin: sign the shop out of Zoho Mail (revokes the stored login).
  if (url.pathname === "/api/admin/zoho/disconnect" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env).catch(() => null);
    if (auth?.source === "login") {
      await fetch(`${auth.accountsUrl}/oauth/v2/token/revoke?token=${encodeURIComponent(auth.refreshToken)}`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => null);
    }
    await env.DATA.delete(ZOHO_AUTH_KEY);
    await Promise.all([env.DATA.delete(ZOHO_ACCESS_KEY), env.DATA.delete(ZOHO_PAUSE_KEY)]).catch(() => null);
    zohoToken = null;
    zohoAccount = null;
    return json({ ok: true, stillConnected: auth?.source === "secret" });
  }

  // Admin: the mailbox (Inbox or Sent) of orders@getyolko.com
  if (url.pathname === "/api/admin/mail" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ ok: true, connected: false, messages: [] });
    const folder = url.searchParams.get("folder") === "sent" ? "sent" : "inbox";
    const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 40)));
    const start = Math.max(1, Math.floor(Number(url.searchParams.get("start")) || 1));
    try {
      const acct = await zohoMailAccount(env, auth);
      const folderId = acct.folders[folder];
      if (!folderId) throw new Error(`No ${folder} folder in this mailbox`);
      const data = await zohoMailFetch(
        env,
        auth,
        `/accounts/${encodeURIComponent(acct.accountId)}/messages/view?folderId=${folderId}&start=${start}&limit=${limit}&sortorder=false&includeto=true`
      );
      const messages = (Array.isArray(data?.data) ? data.data : []).map(mailRow);
      return json({ ok: true, connected: true, account: acct.address, folder, folderId, start, messages, hasMore: messages.length === limit });
    } catch (err) {
      return json({ ok: false, connected: true, reconnect: Boolean(err?.reconnect), error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // Admin: how many unread messages wait in the inbox (for the nav badge)
  if (url.pathname === "/api/admin/mail/unread" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ ok: true, connected: false, unread: 0 });
    try {
      const acct = await zohoMailAccount(env, auth);
      const data = await zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/messages/view?folderId=${acct.folders.inbox}&status=unread&limit=99&sortorder=false`);
      const list = Array.isArray(data?.data) ? data.data : [];
      return json({ ok: true, connected: true, unread: list.length, latest: list[0] ? mailRow(list[0]) : null });
    } catch (err) {
      return json({ ok: false, connected: true, reconnect: Boolean(err?.reconnect), error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // Admin: one message, with its recipients and attachments. Opening it marks it read.
  if (url.pathname === "/api/admin/mail/message" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ error: "Zoho Mail isn't connected" }, 503);
    const folderId = String(url.searchParams.get("folderId") || "");
    const messageId = String(url.searchParams.get("messageId") || "");
    if (!/^\d{1,30}$/.test(folderId) || !/^\d{1,30}$/.test(messageId)) return json({ error: "bad message" }, 400);
    try {
      const acct = await zohoMailAccount(env, auth);
      const base = `/accounts/${encodeURIComponent(acct.accountId)}/folders/${folderId}/messages/${messageId}`;
      if (url.searchParams.get("markRead") === "1") {
        // Marking it read doesn't hold up the message.
        mailCacheKeep(
          ctx,
          zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/updatemessage`, {
            method: "PUT",
            body: { mode: "markAsRead", messageId: [messageId] },
          })
        );
      }
      const [content, details, files] = await Promise.all([
        zohoMailCached(env, auth, ctx, `${base}/content`),
        zohoMailCached(env, auth, ctx, `${base}/details`).catch(() => null),
        zohoMailCached(env, auth, ctx, `${base}/attachmentinfo?includeInline=true`).catch(() => null),
      ]);
      const d = details?.data || {};
      // Inline pictures and attachments load through signed links to this site (see rewriteMailImages).
      const inline = (Array.isArray(files?.data?.inline) ? files.data.inline : []).map((p) => ({
        cid: String(p.cid || p.contentId || ""),
        attachmentId: String(p.attachmentId || ""),
        name: String(p.attachmentName || ""),
      }));
      const x = mailFileExpiry();
      const attachments = await Promise.all(
        (Array.isArray(files?.data?.attachments) ? files.data.attachments : []).map(async (a) => {
          const id = String(a.attachmentId || "");
          const name = decodeMailEntities(a.attachmentName) || "attachment";
          const [, kind] = mailFileType(name);
          const download = await mailFileLink(env, url.origin, folderId, messageId, id, name, x, true);
          const open = kind === "file" ? download : await mailFileLink(env, url.origin, folderId, messageId, id, name, x, false);
          return { id, name, size: Number(a.attachmentSize) || 0, kind, url: open, download };
        })
      );
      // Small inline pictures come inside the message, so they show at once with the text.
      const until = Date.now() + MAIL_EMBED_WAIT;
      let room = MAIL_EMBED_TOTAL;
      const embed = async (cid, attId) => {
        const job = mailCacheKeep(ctx, mailInlinePicture(env, auth, ctx, acct.accountId, folderId, messageId, cid, attId));
        const pic = await Promise.race([job, new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()), null))]);
        if (!pic || pic.buf.byteLength > MAIL_EMBED_EACH || pic.buf.byteLength > room) return null;
        room -= pic.buf.byteLength;
        return `data:${pic.type};base64,${b64(pic.buf)}`;
      };
      const raw = String(content?.data?.content || "");
      const html = await rewriteMailImages(env, url.origin, raw, { folderId, messageId, inline, embed }).catch(() => raw);
      return json({
        ok: true,
        html,
        subject: decodeMailEntities(d.subject),
        from: decodeMailEntities(d.fromAddress),
        fromName: decodeMailEntities(d.sender),
        to: decodeMailEntities(d.toAddress),
        cc: decodeMailEntities(d.ccAddress),
        replyTo: decodeMailEntities(d.replyTo),
        receivedAt: Number(d.receivedTime || d.sentDateInGMT) ? new Date(Number(d.receivedTime || d.sentDateInGMT)).toISOString() : null,
        attachments,
      });
    } catch (err) {
      return json({ ok: false, reconnect: Boolean(err?.reconnect), error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // Admin: download one attachment
  if (url.pathname === "/api/admin/mail/attachment" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ error: "Zoho Mail isn't connected" }, 503);
    const folderId = String(url.searchParams.get("folderId") || "");
    const messageId = String(url.searchParams.get("messageId") || "");
    const attachmentId = String(url.searchParams.get("attachmentId") || "");
    if (!/^\d{1,30}$/.test(folderId) || !/^\d{1,30}$/.test(messageId) || !/^[\w.-]{1,80}$/.test(attachmentId)) return json({ error: "bad attachment" }, 400);
    try {
      const acct = await zohoMailAccount(env, auth);
      const resp = await zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`, { raw: true });
      return new Response(resp.body, {
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream",
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
          ...CORS,
        },
      });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // Admin: a picture from the web inside a message, fetched by the site. Signed instead of the
  // Bearer key because <img> can't send headers (see rewriteMailImages).
  if (url.pathname === "/api/admin/mail/image" && request.method === "GET") {
    const u = String(url.searchParams.get("u") || "");
    if (!(await mailSigOk(env, `img\n${u}`, url.searchParams.get("s")))) return mailMiss(403);
    let target;
    try {
      target = new URL(u);
    } catch {
      return mailMiss(400);
    }
    if (!/^https?:$/.test(target.protocol)) return mailMiss(400);
    const resp = await fetch(target.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; YOLKO-Mail-Images/1.0; +https://getyolko.com)",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      redirect: "follow",
      cf: { cacheEverything: true, cacheTtl: 86400, cacheTtlByStatus: { "200-299": 86400, "400-599": 0 } },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    return (await mailImageResponse(resp, 604800).catch(() => null)) || mailMiss(resp && !resp.ok ? 404 : 502);
  }

  // Admin: an inline picture of a message (the ones Zoho writes as /mail/ImageDisplay?...&cid=).
  if (url.pathname === "/api/admin/mail/inline" && request.method === "GET") {
    const q = (k) => String(url.searchParams.get(k) || "");
    const [folderId, messageId, cid, attId, x] = ["f", "m", "c", "a", "x"].map(q);
    if (!/^\d{1,30}$/.test(folderId) || !/^\d{1,30}$/.test(messageId) || !/^\d{1,12}$/.test(x)) return mailMiss(400);
    if (Number(x) * 1000 < Date.now()) return mailMiss(410);
    if (!(await mailSigOk(env, `inl\n${folderId}\n${messageId}\n${cid}\n${attId}\n${x}`, q("s")))) return mailMiss(403);
    const auth = await zohoAuth(env);
    if (!auth) return mailMiss(503);
    try {
      const acct = await zohoMailAccount(env, auth);
      const pic = await mailInlinePicture(env, auth, ctx, acct.accountId, folderId, messageId, cid, attId);
      if (!pic) return mailMiss(404);
      const maxAge = Math.max(0, Number(x) - Math.floor(Date.now() / 1000));
      return new Response(pic.buf, {
        headers: { "Content-Type": pic.type, "Content-Security-Policy": MAIL_SANDBOX, "Cache-Control": `private, max-age=${maxAge}, immutable`, ...MAIL_FILE_HEADERS },
      });
    } catch {
      return mailMiss(502);
    }
  }

  // Admin: open or save an attachment. Pictures, PDFs, text and media open in the browser;
  // anything else (and dl=1) downloads with its real name.
  if (url.pathname === "/api/admin/mail/file" && request.method === "GET") {
    const q = (k) => String(url.searchParams.get(k) || "");
    const [folderId, messageId, attId, name, x] = ["f", "m", "a", "n", "x"].map(q);
    if (!/^\d{1,30}$/.test(folderId) || !/^\d{1,30}$/.test(messageId) || !/^[\w.-]{1,80}$/.test(attId) || !/^\d{1,12}$/.test(x)) return mailMiss(400);
    if (Number(x) * 1000 < Date.now()) return mailMiss(410);
    if (!(await mailSigOk(env, `att\n${folderId}\n${messageId}\n${attId}\n${name}\n${x}`, q("s")))) return mailMiss(403);
    const auth = await zohoAuth(env);
    if (!auth) return mailMiss(503);
    try {
      const acct = await zohoMailAccount(env, auth);
      // Kept in the cache too (up to 25 MB), so photo tiles show at once the next time.
      const cache = globalThis.caches?.default;
      const key = cache ? await mailCacheKey(env, "att", [acct.accountId, folderId, messageId, attId]).catch(() => null) : null;
      const hit = key ? await cache.match(key).catch(() => null) : null;
      let body = hit?.body || null;
      if (!body) {
        const resp = await zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/folders/${folderId}/messages/${messageId}/attachments/${attId}`, { raw: true, timeout: 120000 });
        body = resp.body;
        if (key && body && !(Number(resp.headers.get("Content-Length")) > MAIL_IMAGE_MAX)) {
          const [mine, kept] = body.tee();
          body = mine;
          mailCacheKeep(ctx, mailCacheStream(cache, key, kept));
        }
      }
      const [type, kind] = mailFileType(name);
      const save = q("dl") === "1" || kind === "file";
      const headers = {
        "Content-Type": save ? "application/octet-stream" : type,
        "Content-Disposition": contentDisposition(save ? "attachment" : "inline", name),
        "Cache-Control": `private, max-age=${Math.max(0, Number(x) - Math.floor(Date.now() / 1000))}, immutable`,
        ...MAIL_FILE_HEADERS,
      };
      // Chrome won't show a PDF in a sandboxed page, and a PDF or media file can't run script here anyway.
      if (!save && kind === "image") headers["Content-Security-Policy"] = MAIL_SANDBOX;
      if (!save && type.startsWith("text/")) headers["Content-Security-Policy"] = MAIL_SANDBOX;
      return new Response(body, { headers });
    } catch {
      return mailMiss(502);
    }
  }

  // Admin: mark a message read or unread
  if (url.pathname === "/api/admin/mail/flag" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ error: "Zoho Mail isn't connected" }, 503);
    const body = await request.json().catch(() => null);
    const messageId = String(body?.messageId || "");
    if (!/^\d{1,30}$/.test(messageId)) return json({ error: "bad message" }, 400);
    try {
      const acct = await zohoMailAccount(env, auth);
      await zohoMailFetch(env, auth, `/accounts/${encodeURIComponent(acct.accountId)}/updatemessage`, {
        method: "PUT",
        body: { mode: body?.read === false ? "markAsUnread" : "markAsRead", messageId: [messageId] },
      });
      return json({ ok: true });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // Admin: send a new email, or reply to one, from orders@getyolko.com
  if (url.pathname === "/api/admin/mail/send" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const auth = await zohoAuth(env);
    if (!auth) return json({ error: "Zoho Mail isn't connected" }, 503);
    const body = await request.json().catch(() => null);
    const to = cleanAddressList(body?.to);
    const cc = body?.cc ? cleanAddressList(body.cc) : "";
    const subject = String(body?.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const text = String(body?.text || "").trim();
    if (!to) return json({ error: "Check the To address" }, 400);
    if (cc === null) return json({ error: "Check the Cc address" }, 400);
    if (!subject) return json({ error: "Add a subject" }, 400);
    if (!text || text.length > 20000) return json({ error: text ? "That message is too long" : "Write a message first" }, 400);
    const replyId = body?.replyTo?.messageId ? String(body.replyTo.messageId) : "";
    if (replyId && !/^\d{1,30}$/.test(replyId)) return json({ error: "bad message" }, 400);
    try {
      const acct = await zohoMailAccount(env, auth);
      const mail = {
        fromAddress: acct.address || SHOP_EMAIL,
        toAddress: to,
        ...(cc ? { ccAddress: cc } : {}),
        subject,
        content: mailHtml(text, body?.quote),
        mailFormat: "html",
      };
      const path = replyId
        ? `/accounts/${encodeURIComponent(acct.accountId)}/messages/${replyId}`
        : `/accounts/${encodeURIComponent(acct.accountId)}/messages`;
      const data = await zohoMailSend(env, auth, path, replyId ? { ...mail, action: "reply" } : mail);
      return json({ ok: true, to, messageId: data?.data?.messageId ? String(data.data.messageId) : null });
    } catch (err) {
      return json({ ok: false, reconnect: Boolean(err?.reconnect), error: String(err?.message || err).slice(0, 300) }, 502);
    }
  }

  // The shop's phone line. Telnyx asks what to do with a call and hands over each text. The
  // address carries a key kept in KV, because the answer names the phone that calls ring on.
  if (url.pathname.startsWith("/api/line/")) {
    const [kind, key] = url.pathname.slice("/api/line/".length).split("/");
    const config = await env.DATA.get(LINE_CONFIG_KEY, "json").catch(() => null);
    if (!config?.key || !key || !sameText(key, config.key)) return json({ error: "not found" }, 404);
    if (kind === "voice" && (request.method === "POST" || request.method === "GET")) {
      const form = request.method === "POST" ? new URLSearchParams(await request.text().catch(() => "")) : url.searchParams;
      const after = url.searchParams.get("after") === "1";
      const from = String(form.get("From") || "").replace(/[^\d+]/g, "").slice(0, 20);
      const status = String(form.get("DialCallStatus") || "").slice(0, 20);
      ctx.waitUntil(lineLog(env, after ? { kind: "call-end", from, status } : { kind: "call", from }).catch(() => null));
      const answer = after ? voiceAfter(status) : voiceAnswer(config, `https://getyolko.com/api/line/voice/${encodeURIComponent(key)}?after=1`);
      return new Response(answer, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (kind === "sms" && request.method === "POST") {
      const msg = textFromWebhook(await request.json().catch(() => null));
      if (!msg) return json({ ok: true, ignored: true });
      // Telnyx sends a text again if it gets no answer in time: each one is emailed once.
      const seen = `line:sms:${msg.id}`;
      if (await env.DATA.get(seen).catch(() => null)) return json({ ok: true, repeat: true });
      await env.DATA.put(seen, "1", { expirationTtl: 7 * 24 * 3600 }).catch(() => null);
      ctx.waitUntil(lineLog(env, { kind: "text", from: msg.from, text: msg.text.slice(0, 300), pictures: msg.pictures }).catch(() => null));
      ctx.waitUntil(emailLineText(env, msg).catch((err) => console.log("line text email failed", String(err?.message || err))));
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  // Zoho CPaaS webhooks: delivered, opened, clicked, bounced and spam reports for order emails.
  // Zoho calls this without credentials, so an event only counts when its request_id or email
  // reference matches an email this Worker sent (the email:req:<id> keys written at send time).
  if (url.pathname === "/api/zoho/email-events") {
    if (request.method === "GET" || request.method === "HEAD") return json({ ok: true });
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const raw = (await request.text()).slice(0, 262144);
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      // Some Zoho webhooks post form fields that hold JSON.
      for (const [, v] of new URLSearchParams(raw)) {
        try {
          payload = JSON.parse(v);
          break;
        } catch {}
      }
    }
    if (!payload || typeof payload !== "object") return json({ ok: true, ignored: "unreadable" });
    const names = [].concat(payload.event_name || []);
    const messages = [].concat(payload.event_message || []).slice(0, 50);
    let applied = 0;
    for (const [i, m] of messages.entries()) {
      const datas = [].concat(m?.event_data || []).slice(0, 20);
      const info = m?.email_info || {};
      for (const d of datas.length ? datas : [{}]) {
        const kind = normalizeEmailEvent(d?.object || names[i] || names[0]);
        if (!kind) continue;
        const ids = [m?.request_id, info.email_reference, info.client_reference].filter(Boolean).map(String);
        let orderId = null;
        for (const id of ids) {
          orderId = await env.DATA.get(emailReqKey(id));
          if (orderId) break;
        }
        if (!orderId) continue;
        const det = [].concat(d?.details || [])[0] || {};
        const at = det.time ? new Date(det.time).toISOString() : new Date().toISOString();
        const reason = String(det.reason || det.diagnostic_message || "").slice(0, 200) || null;
        const rec = await env.DATA.get(emailEventsKey(orderId), "json").catch(() => null);
        await env.DATA.put(emailEventsKey(orderId), JSON.stringify(applyEmailEvent(rec, kind, Number.isNaN(Date.parse(at)) ? new Date().toISOString() : at, reason)));
        applied++;
      }
    }
    if (names.length) await env.DATA.put("email:events:last", new Date().toISOString());
    return json({ ok: true, applied });
  }

  // Public: confirm payment after returning from Stripe
  if (url.pathname === "/api/confirm-payment" && request.method === "GET") {
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);
    const sid = url.searchParams.get("session") || "";
    if (!sid.startsWith("cs_")) return json({ error: "bad session" }, 400);

    const session = await fetchStripeSession(env, sid);
    const orderId = session?.metadata?.orderId;
    const paid = session?.payment_status === "paid";

    let meta = null;
    let purchase = null;
    let share = null;
    if (paid && orderId) {
      let order = await env.DATA.get(orderId, "json");
      if (order) {
        if (env.STRIPE_WEBHOOK_SECRET) {
          // The webhook is the single writer of the paid state. It often runs in
          // another Cloudflare location, and KV is eventually consistent, so a
          // second writer here could double-count stock or overwrite its record.
          if (!isRefunded(order, session)) order = paidView(order, session);
        } else {
          let newlyPaid;
          ({ order, newlyPaid } = await markOrderPaid(env, order, session));
          if (newlyPaid) {
            const job = maybeSendOrderEmail(env, orderId);
            if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
          }
        }

        // Meta CAPI Purchase (dedupe with browser Pixel via event_id = order.id)
        const fbp = url.searchParams.get("fbp") || "";
        const fbc = url.searchParams.get("fbc") || "";
        meta = await sendMetaPurchase(env, order, {
          email: session?.customer_details?.email || order.stripe?.email || "",
          fbp: fbp || undefined,
          fbc: fbc || undefined,
        });
        if (meta?.ok && !meta.skipped) {
          order = await markMetaPurchaseSent(env, order, meta, { writeOrder: !env.STRIPE_WEBHOOK_SECRET });
        }
        purchase = {
          eventId: order.id,
          value: Number(order.stripe?.amountTotal != null ? order.stripe.amountTotal : order.price) || 0,
          currency: "AUD",
          contentName: isBundle(order.bundle) ? bundleLabel(order.bundle) : String(order.bundle || "eggs"),
          numItems: Math.max(1, Number(order.quantity) || 1),
        };
        const code = await ensureRefCode(env, order.phone, order.name).catch(() => null);
        if (code) share = { code, link: shareLink(code) };
      }
    }
    return json({
      paid,
      purchase,
      share,
      meta: meta
        ? { ok: meta.ok, skipped: !!meta.skipped, reason: meta.reason || null, error: meta.error || null }
        : null,
      pixelId: metaPixelId(env),
    });
  }

  // Admin: backfill Meta Purchase for a paid order (e.g. first sale before CAPI existed)
  if (url.pathname === "/api/meta-purchase-backfill" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const id = String(body?.id || "");
    if (!id.startsWith("order:")) return json({ error: "bad order" }, 400);
    let order = await env.DATA.get(id, "json");
    if (!order) return json({ error: "not found" }, 404);
    const force = Boolean(body?.force);
    const meta = await sendMetaPurchase(env, order, {
      force,
      email: body?.email || order.stripe?.email || "",
      fbp: body?.fbp || undefined,
      fbc: body?.fbc || undefined,
    });
    if (meta?.ok && !meta.skipped) {
      order = await markMetaPurchaseSent(env, order, meta);
    }
    const marker = order.metaPurchaseSent ? null : await env.DATA.get(metaSentKey(id), "json").catch(() => null);
    return json({
      ok: !!meta?.ok,
      orderId: id,
      metaPurchaseSent: !!order.metaPurchaseSent || !!marker,
      metaPurchaseSentAt: order.metaPurchaseSentAt || marker?.sentAt || null,
      ...meta,
      pixelId: metaPixelId(env),
    });
  }

  // Admin: set Stripe public business name to YOLKO (Checkout "Pay …" header)
  if (url.pathname === "/api/stripe-branding" && (request.method === "POST" || request.method === "GET")) {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);

    if (request.method === "GET") {
      const resp = await fetch("https://api.stripe.com/v1/account", {
        headers: { Authorization: `Bearer ${env.STRIPE_KEY}` },
      });
      const account = await resp.json();
      if (account.error) return json({ error: account.error.message || "stripe error" }, 502);
      return json({
        ok: true,
        name: account.business_profile?.name || null,
        statementDescriptor: account.settings?.payments?.statement_descriptor || null,
        supportEmail: account.business_profile?.support_email || null,
        supportPhone: account.business_profile?.support_phone || null,
        supportUrl: account.business_profile?.support_url || null,
        url: account.business_profile?.url || null,
        accountEmail: account.email || null,
        look: stripeAccountLook(account),
        payPageRefused: await env.DATA.get(STRIPE_LOOK_NOTE, "json").catch(() => null),
      });
    }

    const result = await ensureStripeBranding(env);
    if (!result.ok) return json(result, 502);
    return json(result);
  }

  // Admin: pull / refresh Stripe receipt details for a paid order
  if (url.pathname === "/api/stripe-receipt" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);
    const id = String(url.searchParams.get("id") || "");
    if (!id.startsWith("order:")) return json({ error: "bad order" }, 400);
    let order = await env.DATA.get(id, "json");
    if (!order) return json({ error: "not found" }, 404);
    if (!order.sessionId) return json({ error: "no stripe session" }, 404);

    if (order.stripe?.receiptUrl && order.stripe?.amountTotal != null && order.paymentStatus === "paid") {
      return json({
        ok: true,
        paid: true,
        paymentStatus: "paid",
        stripe: order.stripe,
        cached: true,
      });
    }

    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.sessionId)}?expand[]=payment_intent.latest_charge`,
      { headers: { Authorization: `Bearer ${env.STRIPE_KEY}` } }
    );
    const session = await resp.json();
    if (session.error) return json({ error: session.error.message || "stripe error" }, 502);

    if (session.payment_status === "paid" && order.paymentStatus !== "paid" && !isRefunded(order, session)) {
      if (mayRecordPaid(env, session)) {
        order = (await recordMissedPayment(env, id, session))?.order || order;
      } else {
        // Recent payment: the webhook records it; this copy may be stale.
        order = paidView(order, session);
      }
    } else {
      order.stripe = { ...(order.stripe || {}), ...stripeDetailsFromSession(session) };
      await env.DATA.put(id, JSON.stringify(order));
    }
    return json({
      ok: true,
      paid: order.paymentStatus === "paid",
      paymentStatus: order.paymentStatus || "pending",
      stripe: order.stripe,
      cached: false,
    });
  }

  // Admin: full refund of a paid Stripe order (money back to original payer)
  if (url.pathname === "/api/refund" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    if (!env.STRIPE_KEY) return json({ error: "payments not configured" }, 503);
    const body = await request.json().catch(() => null);
    const id = String(body?.id || "");
    if (!id.startsWith("order:")) return json({ error: "bad order" }, 400);

    const order = await env.DATA.get(id, "json");
    if (!order) return json({ error: "not found" }, 404);
    if (order.paymentStatus === "refunded") {
      return json({ ok: true, already: true, stripe: order.stripe || null });
    }
    if (order.paymentStatus !== "paid") {
      return json({ error: "order is not paid" }, 400);
    }

    let paymentIntentId = order.stripe?.paymentIntentId || null;
    let chargeId = null;

    // Resolve PaymentIntent / charge from Checkout session if needed
    if (!paymentIntentId && order.sessionId) {
      const sessResp = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.sessionId)}?expand[]=payment_intent.latest_charge`,
        { headers: { Authorization: `Bearer ${env.STRIPE_KEY}` } }
      );
      const session = await sessResp.json();
      if (session.error) return json({ error: session.error.message || "stripe session error" }, 502);
      const pi = session.payment_intent;
      paymentIntentId = typeof pi === "string" ? pi : pi?.id || null;
      const charge = pi && typeof pi === "object" ? pi.latest_charge : null;
      chargeId = typeof charge === "string" ? charge : charge?.id || null;
      order.stripe = { ...(order.stripe || {}), ...stripeDetailsFromSession(session) };
    }

    if (!paymentIntentId && !chargeId) {
      return json({ error: "no stripe payment found for this order" }, 400);
    }

    const refundParams = new URLSearchParams({
      reason: "requested_by_customer",
      // metadata.orderId marks refunds made here: the charge.refunded webhook
      // leaves those to this path (one sender per refund email).
      "metadata[orderId]": id,
      "metadata[source]": "yolko-admin",
      "metadata[customerName]": String(order.name || "").slice(0, 80),
    });
    if (paymentIntentId) refundParams.set("payment_intent", paymentIntentId);
    else refundParams.set("charge", chargeId);

    const refundResp = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: refundParams.toString(),
    });
    const refund = await refundResp.json();
    if (refund.error) {
      // Already fully refunded in Stripe. sync local state
      const msg = String(refund.error.message || "");
      if (/already been refunded|has already been refunded/i.test(msg)) {
        const charge = await fetchChargeWithRefunds(env, { paymentIntentId, chargeId });
        if (webhookRefundPending(charge)) {
          return json({ ok: true, already: true, syncing: true, stripe: order.stripe || null });
        }
        // A refund this button made whose request failed before saving it:
        // record it now and send its email (the marker stops a second copy).
        const mine = liveRefunds(charge).find((r) => r.metadata?.orderId === id);
        order.paymentStatus = "refunded";
        order.status = "cancelled";
        if (mine && !order.stripe?.refundId) {
          order.stripe = {
            ...(order.stripe || {}),
            refundId: mine.id,
            refundStatus: mine.status,
            refundAmount: Number(mine.amount) / 100,
            refundCurrency: String(mine.currency || "aud").toUpperCase(),
            refundedAt: new Date(Number(mine.created) * 1000).toISOString(),
            paymentIntentId: paymentIntentId || order.stripe?.paymentIntentId || null,
          };
        }
        const stock = await syncStock(env, order, "cancelled");
        await env.DATA.put(id, JSON.stringify(order));
        const refundEmail = mine && Number(mine.created) * 1000 >= REFUND_EMAIL_LAUNCH
          ? await maybeSendRefundEmail(env, order, {
            id: mine.id,
            amount: Number(mine.amount) / 100,
            currency: String(mine.currency || "aud").toUpperCase(),
            completes: true,
          })
          : null;
        return json({
          ok: true,
          already: true,
          refundEmail: refundEmail && { ok: Boolean(refundEmail.ok), skipped: Boolean(refundEmail.skipped), error: refundEmail.error || null },
          traysAvailable: stock.traysAvailable,
          stockDelta: stock.delta,
          stock,
          stripe: order.stripe || null,
        });
      }
      return json({ error: refund.error.message || "refund failed" }, 502);
    }

    order.paymentStatus = "refunded";
    order.status = "cancelled";
    order.stripe = {
      ...(order.stripe || {}),
      refundId: refund.id,
      refundStatus: refund.status,
      refundAmount: Number.isFinite(Number(refund.amount)) ? Number(refund.amount) / 100 : order.price,
      refundCurrency: String(refund.currency || "aud").toUpperCase(),
      refundedAt: new Date().toISOString(),
      paymentIntentId: paymentIntentId || order.stripe?.paymentIntentId || null,
    };
    const stock = await syncStock(env, order, "cancelled");
    await env.DATA.put(id, JSON.stringify(order));
    // A failed send is retried by the cron.
    const refundEmail = await maybeSendRefundEmail(env, order, {
      id: refund.id,
      amount: order.stripe.refundAmount,
      currency: order.stripe.refundCurrency,
      completes: true,
    });

    return json({
      ok: true,
      refundId: refund.id,
      amount: order.stripe.refundAmount,
      currency: order.stripe.refundCurrency,
      status: refund.status,
      email: order.stripe.email || null,
      refundEmail: { ok: Boolean(refundEmail.ok), skipped: Boolean(refundEmail.skipped), error: refundEmail.error || null },
      traysAvailable: stock.traysAvailable,
      stockDelta: stock.delta,
      stock,
      stripe: order.stripe,
    });
  }

  // Admin: update order status
  if (url.pathname === "/api/order-status" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const id = String(body?.id || "");
    const status = ["new", "confirmed", "done", "cancelled"].includes(body?.status) ? body.status : null;
    if (!id.startsWith("order:") || !status) return json({ error: "bad request" }, 400);
    const order = await env.DATA.get(id, "json");
    if (!order) return json({ error: "not found" }, 404);
    if (order.paymentStatus === "paid" && order.stripe?.paymentIntentId && env.STRIPE_KEY) {
      // Fails open: a slow Stripe never blocks order updates.
      const charge = await fetchChargeWithRefunds(env, { paymentIntentId: order.stripe.paymentIntentId }, 4000);
      if (webhookRefundPending(charge)) {
        return json({ error: "Refunded in Stripe a moment ago. Refresh in a minute." }, 409);
      }
    }
    const stock = await syncStock(env, order, status);
    order.status = status;
    await env.DATA.put(id, JSON.stringify(order));
    return json({ ok: true, trays: traysFor(order), stockDelta: stock.delta, traysAvailable: stock.traysAvailable, stock });
  }


  // Public: published hero/order images
  if (url.pathname === "/api/assets" && request.method === "GET") {
    const lib = await getAssetLibrary(env);
    return json({
      published: resolveLiveAssets(lib),
      publishedAt: lib.publishedAt,
    });
  }

  // Admin: full asset library
  if (url.pathname === "/api/admin/assets" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const lib = await getAssetLibrary(env);
    return json({
      ...lib,
      live: resolveLiveAssets(lib),
      dirty: JSON.stringify(lib.draft) !== JSON.stringify(lib.published),
    });
  }

  // Admin: update one asset (favorite / category / delete / restore)
  if (url.pathname === "/api/admin/assets/item" && request.method === "PATCH") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const id = body && typeof body.id === "string" ? body.id : "";
    const lib = await getAssetLibrary(env);
    const item = lib.items.find((i) => i.id === id);
    if (!item) return json({ error: "not found" }, 404);
    if (typeof body.favorite === "boolean") item.favorite = body.favorite;
    if (typeof body.category === "string" && body.category.trim()) {
      const cat = body.category.trim().slice(0, 40);
      if (!lib.categories.includes(cat)) lib.categories.push(cat);
      item.category = cat;
    }
    if (typeof body.deleted === "boolean") {
      item.deleted = body.deleted;
      if (body.deleted) {
        lib.draft = lib.draft.filter((x) => x !== id);
        lib.published = lib.published.filter((x) => x !== id);
      }
    }
    await saveAssetLibrary(env, lib);
    return json({ ok: true, item, dirty: JSON.stringify(lib.draft) !== JSON.stringify(lib.published) });
  }

  // Admin: set draft live selection (order = rotator order)
  if (url.pathname === "/api/admin/assets/draft" && request.method === "PUT") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const lib = await getAssetLibrary(env);
    const byId = Object.fromEntries(lib.items.map((i) => [i.id, i]));
    const draft = [];
    for (const id of Array.isArray(body?.draft) ? body.draft : []) {
      if (typeof id !== "string" || !byId[id] || byId[id].deleted) continue;
      if (draft.includes(id)) continue;
      draft.push(id);
    }
    lib.draft = draft;
    await saveAssetLibrary(env, lib);
    return json({ ok: true, draft: lib.draft, dirty: JSON.stringify(lib.draft) !== JSON.stringify(lib.published) });
  }

  // Admin: create category
  if (url.pathname === "/api/admin/assets/category" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!name) return json({ error: "name required" }, 400);
    const lib = await getAssetLibrary(env);
    if (!lib.categories.includes(name)) lib.categories.push(name);
    await saveAssetLibrary(env, lib);
    return json({ ok: true, categories: lib.categories });
  }


  // Admin: bulk update (multi-select delete / restore / favorite)
  if (url.pathname === "/api/admin/assets/bulk" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (!ids.length) return json({ error: "ids required" }, 400);
    const lib = await getAssetLibrary(env);
    const byId = Object.fromEntries(lib.items.map((i) => [i.id, i]));
    let changed = 0;
    for (const id of ids) {
      const item = byId[id];
      if (!item) continue;
      changed += 1;
      if (typeof body.favorite === "boolean") item.favorite = body.favorite;
      if (typeof body.deleted === "boolean") {
        item.deleted = body.deleted;
        if (body.deleted) {
          lib.draft = lib.draft.filter((x) => x !== id);
          lib.published = lib.published.filter((x) => x !== id);
        }
      }
      if (typeof body.category === "string" && body.category.trim()) {
        const cat = body.category.trim().slice(0, 40);
        if (!lib.categories.includes(cat)) lib.categories.push(cat);
        item.category = cat;
      }
    }
    await saveAssetLibrary(env, lib);
    return json({
      ok: true,
      changed,
      dirty: JSON.stringify(lib.draft) !== JSON.stringify(lib.published),
    });
  }

  // Admin: publish draft → live storefront
  if (url.pathname === "/api/admin/assets/publish" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const lib = await getAssetLibrary(env);
    if (!lib.draft.length) return json({ error: "select at least one image" }, 400);
    lib.published = lib.draft.slice();
    lib.publishedAt = new Date().toISOString();
    await saveAssetLibrary(env, lib);
    return json({
      ok: true,
      published: lib.published,
      publishedAt: lib.publishedAt,
      live: resolveLiveAssets(lib),
      dirty: false,
    });
  }


  // Public: flyer / QR / campaign pageview tracking
  if (url.pathname === "/api/visit" && request.method === "POST") {
    if (!isAllowedOrigin(request)) return json({ error: "forbidden", code: "origin" }, 403);
    const ip = clientIp(request);
    const rlOk = await allowRate(env, `visit:${ip || "na"}`, 40, 600);
    if (!rlOk) return json({ ok: true, throttled: true });

    const body = await request.json().catch(() => ({}));
    const ua = String(request.headers.get("User-Agent") || body?.ua || "").slice(0, 300);
    const parsed = parseUa(ua);
    const geo = enrichCfGeo(request);
    const visitorId = cleanVisitId(body?.visitorId) || ("anon_" + Math.random().toString(36).slice(2, 12));
    const sessionId = cleanVisitId(body?.sessionId);
    const src = String(body?.src || body?.utm_source || "").trim().slice(0, 40) || "direct";
    const now = new Date();
    const id = `visit:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;

    const visit = {
      id,
      createdAt: now.toISOString(),
      visitorId,
      sessionId,
      src,
      utm: {
        source: String(body?.utm_source || "").slice(0, 40) || null,
        medium: String(body?.utm_medium || "").slice(0, 40) || null,
        campaign: String(body?.utm_campaign || "").slice(0, 60) || null,
        content: String(body?.utm_content || "").slice(0, 60) || null,
        term: String(body?.utm_term || "").slice(0, 60) || null,
      },
      path: String(body?.path || "/").slice(0, 200),
      referrer: String(body?.referrer || request.headers.get("Referer") || "").slice(0, 300) || null,
      landing: String(body?.landing || "").slice(0, 300) || null,
      ip: ip || null,
      ...geo,
      ua: ua || null,
      os: parsed.os,
      browser: parsed.browser,
      deviceType: parsed.deviceType,
      language: String(body?.language || "").slice(0, 32) || null,
      languages: Array.isArray(body?.languages) ? body.languages.map((x) => String(x).slice(0, 24)).slice(0, 8) : null,
      tz: String(body?.tz || "").slice(0, 64) || null,
      screen: {
        w: Number(body?.screenW) || null,
        h: Number(body?.screenH) || null,
        dpr: Number(body?.dpr) || null,
      },
      viewport: {
        w: Number(body?.viewportW) || null,
        h: Number(body?.viewportH) || null,
      },
      platform: String(body?.platform || "").slice(0, 64) || null,
      touch: Boolean(body?.touch),
      connection: String(body?.connection || "").slice(0, 32) || null,
      colorScheme: String(body?.colorScheme || "").slice(0, 16) || null,
      deviceMemory: Number(body?.deviceMemory) || null,
      cores: Number(body?.cores) || null,
      gender: null,
      name: null,
      hardwareDeviceId: null,
    };

    await env.DATA.put(id, JSON.stringify(visit), { expirationTtl: 90 * 24 * 3600 });
    await pushVisitIndex(env, id);
    return json({ ok: true, id, visitorId });
  }

  // Admin: list tracked visits (flyer / QR / ads)
  if (url.pathname === "/api/visits" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const srcFilter = String(url.searchParams.get("src") || "").trim().toLowerCase();
    const ids = await getVisitIndex(env);
    const rows = await Promise.all(ids.slice(0, 400).map((id) => env.DATA.get(id, "json")));
    let visits = rows.filter(Boolean);
    if (srcFilter) {
      visits = visits.filter((v) => {
        const s = String(v.src || "").toLowerCase();
        const us = String(v.utm?.source || "").toLowerCase();
        const med = String(v.utm?.medium || "").toLowerCase();
        if (srcFilter === "flyer") {
          return s === "flyer" || us === "flyer" || med === "qr" || s === "qr";
        }
        return s === srcFilter || us === srcFilter;
      });
    }
    visits.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    const unique = new Set(visits.map((v) => v.visitorId).filter(Boolean));
    const byDevice = {};
    const byCity = {};
    const bySrc = {};
    for (const v of visits) {
      const d = v.deviceType || "unknown";
      byDevice[d] = (byDevice[d] || 0) + 1;
      const city = [v.city, v.region, v.country].filter(Boolean).join(", ") || "Unknown";
      byCity[city] = (byCity[city] || 0) + 1;
      const s = v.src || "direct";
      bySrc[s] = (bySrc[s] || 0) + 1;
    }

    return json({
      visits,
      summary: {
        total: visits.length,
        uniqueVisitors: unique.size,
        byDevice,
        byCity,
        bySrc,
      },
      note: "Browsers never send gender, real name, or hardware device IDs (IMEI). Name appears when the same visitor places an order.",
    });
  }

  // Admin > Competitors: competitor egg prices, typed-in prices and recent changes, in one answer.
  if (url.pathname === "/api/price-watch" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    return json({ ...(await priceWatchView(env)), mine: await myPrices(env) });
  }

  // Admin: check every shop now (the Check now button). A second tap within a minute is free.
  if (url.pathname === "/api/price-watch/poll" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const result = await runPoll(env);
    return json({ ...(await priceWatchView(env)), mine: await myPrices(env), ran: result.ran, changeCount: result.changeCount || 0 });
  }

  // Admin: add, change or remove a typed-in price (Costco and Woolworths block automatic checks).
  if (url.pathname === "/api/price-watch/typed" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => ({}));
    const result = await saveTyped(env, body);
    if (result.error) return json(result, 400);
    return json(result);
  }

  // Admin > News: Australian egg news, the NSW bird flu advice and how each source is doing.
  if (url.pathname === "/api/news" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    return json(await newsView(env));
  }

  // Admin: read every news source now (the Refresh button). A second tap within a minute is free.
  if (url.pathname === "/api/news/poll" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const result = await runNewsPoll(env);
    return json({ ...(await newsView(env)), ran: result.ran, added: result.added || 0, failed: result.failed || 0 });
  }

  // Admin: add or remove a pasted news feed, such as a Google Alerts RSS link.
  if (url.pathname === "/api/news/feeds" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => ({}));
    const result = await saveNewsFeed(env, body);
    if (result.error) return json(result, 400);
    return json({ ...(await newsView(env)), ...result });
  }

  // GitHub Actions (news-relay.yml) posts the Google News feeds here, since Google answers
  // Cloudflare with 503. Signed by GitHub's OIDC token for this repo's main branch, no secret.
  if (url.pathname === "/api/news/relay" && request.method === "POST") {
    if (!(await isGithubRelay(request))) return json({ error: "unauthorised" }, 401);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 8_000_000) return json({ error: "too big" }, 413);
    const body = await request.json().catch(() => null);
    const result = await takeNewsRelay(env, body);
    if (result.error) return json(result, 400);
    return json(result);
  }

  // Admin > Growers: Australian egg farms with each Farm Transparency link's latest status.
  if (url.pathname === "/api/growers" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    return json(await growersView(env));
  }

  // Admin: re-read every state's Farm Transparency list now (at most every 10 minutes).
  if (url.pathname === "/api/growers/check" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const result = await runGrowersCheck(env, { force: true });
    return json({ ...(await growersView(env)), ran: result.ran, read: result.read, failed: result.failed });
  }

  return json({ error: "not found" }, 404);
}

export default {
  // Every cron tick: Meta stock sync, competitor prices (checked once every 6 hours), egg news,
  // the monthly Farm Transparency re-check for Admin > Growers, the missed-payment safety net
  // and, on Thursdays, reorder reminders.
  async scheduled(_event, env, ctx) {
    const settings = await getSettings(env);
    ctx.waitUntil(syncMetaAdsForStock(env, settings.traysAvailable));
    ctx.waitUntil(
      runScheduledPoll(env).catch((err) => {
        console.log("price-watch poll failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      runScheduledNews(env).catch((err) => {
        console.log("news poll failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      runScheduledGrowers(env).catch((err) => {
        console.log("growers check failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      reconcileOrders(env).catch((err) => {
        console.log("order reconcile failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      runReminders(env).catch((err) => {
        console.log("reminders failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      runReferralBackfill(env).catch((err) => {
        console.log("referral backfill failed", String(err?.message || err));
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Canonical: force https and apex host in production, but keep
    // `wrangler dev` usable over its local HTTP server.
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal && (url.protocol === "http:" || url.hostname.startsWith("www."))) {
      url.protocol = "https:";
      if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // Flyer QR short link → tracked landing
    if (url.pathname === "/f" || url.pathname === "/flyer" || url.pathname === "/f/" || url.pathname === "/flyer/") {
      const dest = new URL(url.origin + "/");
      dest.searchParams.set("src", "flyer");
      dest.searchParams.set("utm_source", "flyer");
      dest.searchParams.set("utm_medium", "qr");
      dest.searchParams.set("utm_campaign", url.searchParams.get("c") || "letterbox");
      return Response.redirect(dest.toString(), 302);
    }

    // A customer's share link → the shop, with their code for the free delivery.
    const refPath = /^\/r\/([A-Za-z0-9]{6})\/?$/.exec(url.pathname);
    // An app reading a share link to draw its card gets the "first delivery is free" card.
    const shared = refPath ? refPath[1] : url.pathname === "/" ? url.searchParams.get("ref") : null;
    if (shared && (request.method === "GET" || request.method === "HEAD")) {
      const card = await shareLinkCard(request, env, shared).catch(() => null);
      if (card) return card;
    }
    if (refPath) {
      const dest = new URL(url.origin + "/");
      const code = cleanRefCode(refPath[1]);
      if (code) {
        dest.searchParams.set("ref", code);
        dest.searchParams.set("utm_source", "referral");
        dest.searchParams.set("utm_medium", url.searchParams.get("m") === "card" ? "card" : "share");
      }
      return Response.redirect(dest.toString(), 302);
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(ADMIN_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex",
          "Cache-Control": "no-store, max-age=0",
          "X-Yolko-Admin": "120",
        },
      });
    }

    if (url.pathname === "/admin/assets" || url.pathname === "/admin/assets/") {
      return Response.redirect(url.origin + "/admin#assets", 302);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, ctx);
    }

    // One canonical URL per page for search engines: /index.html -> /,
    // /page.html -> /page, /page/ -> /page. Single 301, query string kept.
    if (request.method === "GET" || request.method === "HEAD") {
      let clean = url.pathname.replace(/\/+$/, "") || "/";
      if (clean.endsWith(".html")) clean = clean.slice(0, -5);
      if (clean === "/index") clean = "/";
      if (clean !== url.pathname) {
        url.pathname = clean;
        return Response.redirect(url.toString(), 301);
      }
    }

    let path = url.pathname;
    if (path === "/" || path === "") path = "/index.html";
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "html";
    if (!path.includes(".")) path += ".html";

    const live = ext === "html" || ext === "css" || ext === "js";
    const chalkPath = path.startsWith("/assets/chalk-tray/");
    const upstreamBase = chalkPath ? UPSTREAM_CHALK : live ? UPSTREAM_LIVE : UPSTREAM_ASSETS;
    // Upstream URLs are pinned to a commit SHA, so their content never changes:
    // cache successful responses at the edge instead of hitting GitHub per request.
    const upstreamInit = {
      headers: { "User-Agent": "yolko-edge" },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 31536000, "404": 0, "500-599": 0 } },
    };
    let upstreamResp = await fetch(upstreamBase + path, upstreamInit);

    if (!upstreamResp.ok && chalkPath) {
      upstreamResp = await fetch(UPSTREAM_ASSETS + path, upstreamInit);
    }

    if (!upstreamResp.ok) {
      if (ext === "html") {
        const notFound = await fetch(UPSTREAM_LIVE + "/404.html", upstreamInit);
        if (notFound.ok) {
          return new Response(notFound.body, {
            status: 404,
            headers: { "Content-Type": MIME.html, "Cache-Control": browserCacheControl("html", url) },
          });
        }
      }
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }

    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": browserCacheControl(ext, url),
      "X-Yolko-Build": "245",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000",
    };
    // The supermarket price page is built with empty tables; fill them from the latest check.
    if (path === `${PRICES_PATH}.html`) {
      const html = await pricesPageHtml(await upstreamResp.text(), env);
      return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
    }
    // In the sitemap that page's date is when one of its prices last changed.
    if (path === "/sitemap.xml") {
      const xml = await upstreamResp.text();
      const changed = await lastPriceChange(env).catch(() => null);
      return new Response(request.method === "HEAD" ? null : sitemapWithPriceChange(xml, changed), { status: 200, headers });
    }
    // The order email loads the site font from here, and mail apps fetch it cross-origin.
    if (url.pathname.startsWith("/assets/fonts/")) headers["Access-Control-Allow-Origin"] = "*";
    // Let browsers revalidate expired files with a cheap 304 instead of a full download.
    const etag = upstreamResp.headers.get("ETag");
    if (etag && ext !== "html") {
      headers.ETag = etag;
      const weak = (tag) => String(tag || "").replace(/^W\//, "");
      if (weak(request.headers.get("If-None-Match")) === weak(etag)) {
        return new Response(null, { status: 304, headers });
      }
    }

    return new Response(upstreamResp.body, { status: path === "/404.html" ? 404 : 200, headers });
  },
};
