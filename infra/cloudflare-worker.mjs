import { checkDeliveryAddress, SITE_DELIVERY_FEE, MAX_DELIVERY_KM } from "./delivery-zones.mjs";
import { ingestSnapshot, getLatest, getEvents, runScheduledPoll } from "./price-watch.mjs";

// Pin to commit SHA so GitHub raw serves the exact deploy (update on each push).
const DEPLOY_SHA = "ad29bba3936e88167fa95ce1eaebe5137b6ae217";
// Chalk-tray heroes must not 404 when the storefront pin drifts (this caused the
// black hero / “broken ratios” look after a later Worker deploy from main).
const CHALK_ASSETS_SHA = "ad29bba3936e88167fa95ce1eaebe5137b6ae217";
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
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  json: "application/json",
  md: "text/plain; charset=utf-8",
};

const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DOZENS_PER_CASE = 15;
const BUNDLE_KEYS = [
  "tray1", "tray2", "box",
  "cage600", "cage700", "cage800", "fr600", "fr700", "fr800",
  "cage600case", "cage700case", "cage800case", "fr600case", "fr700case", "fr800case",
];
const DOZEN_KEYS = ["cage600", "cage700", "cage800", "fr600", "fr700", "fr800"];
const CASE_KEYS = ["cage600case", "cage700case", "cage800case", "fr600case", "fr700case", "fr800case"];
const TRAY_KEYS = ["tray1", "tray2", "box"];
const CASE_UNIT = {
  cage600case: "cage600", cage700case: "cage700", cage800case: "cage800",
  fr600case: "fr600", fr700case: "fr700", fr800case: "fr800",
};

const DEFAULT_SETTINGS = {
  prices: {
    tray1: 13, tray2: 25, box: 72,
    cage600: 6, cage700: 7, cage800: 8,
    fr600: 8, fr700: 9, fr800: 10,
    cage600case: 90, cage700case: 105, cage800case: 120,
    fr600case: 120, fr700case: 135, fr800case: 150,
  },
  traysAvailable: 24,
  dozensAvailable: 0, // 0 = hide dozen packs on the public website
  trayWeight: "1.75",
  boxCost: 55,
  // Wholesale case cost (15 dozen packs) per product. each SKU is independent
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
const STRIPE_SUPPORT_EMAIL = "getyolkonow@gmail.com";
const STRIPE_SUPPORT_PHONE = "+61433975055";
const STRIPE_BRAND_FLAG = "stripe:branded:yolko";

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
  await env.DATA.put(STRIPE_BRAND_FLAG, "1", { expirationTtl: 30 * 24 * 3600 }).catch(() => null);
  return {
    ok: true,
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

const BUNDLE_CHECKOUT_LABELS = {
  tray1: "Egg tray (30 eggs)",
  tray2: "2 egg trays (60 eggs)",
  box: "Full box (180 eggs)",
  cage600: "Cage dozen 600g (12 eggs)",
  cage700: "Cage dozen 700g (12 eggs)",
  cage800: "Cage dozen 800g (12 eggs)",
  fr600: "Free range dozen 600g (12 eggs)",
  fr700: "Free range dozen 700g (12 eggs)",
  fr800: "Free range dozen 800g (12 eggs)",
  cage600case: "Cage case 600g (15 dozens)",
  cage700case: "Cage case 700g (15 dozens)",
  cage800case: "Cage case 800g (15 dozens)",
  fr600case: "Free range case 600g (15 dozens)",
  fr700case: "Free range case 700g (15 dozens)",
  fr800case: "Free range case 800g (15 dozens)",
};

/** Build Stripe Checkout Session for an order using live admin prices. */
async function createCheckoutForOrder(env, order, settings, ctx) {
  const quantity = Math.min(20, Math.max(1, Math.floor(Number(order.quantity)) || 1));
  const bundle = BUNDLE_KEYS.includes(order.bundle) ? order.bundle : null;
  if (!bundle || !Number.isFinite(Number(settings.prices[bundle]))) {
    return { error: "invalid order bundle", status: 400 };
  }

  const unitPrice = Number(settings.prices[bundle]);
  const subtotal = unitPrice * quantity;
  const isDelivery = order.fulfillment === "delivery";
  const deliveryFee = isDelivery
    ? (Number(order.deliveryFee) > 0 ? Number(order.deliveryFee) : SITE_DELIVERY_FEE)
    : 0;
  const total = subtotal + deliveryFee;
  const unitAmount = Math.round(unitPrice * 100);

  order.quantity = quantity;
  order.subtotal = subtotal;
  order.deliveryFee = deliveryFee;
  order.price = total;

  const fulfillDesc = isDelivery
    ? `Saturday ${order.pickupDate || ""} delivery · ${order.deliveryAddress || "Sydney area"}`.trim()
    : `Pickup ${order.pickupDay}${order.pickupDate ? " " + order.pickupDate : ""} at Paddy's Markets Flemington`;

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "aud",
    "line_items[0][price_data][product_data][name]": BUNDLE_CHECKOUT_LABELS[bundle] || "Eggs",
    "line_items[0][price_data][product_data][description]": fulfillDesc,
    "line_items[0][price_data][unit_amount]": String(unitAmount),
    "line_items[0][quantity]": String(quantity),
    "metadata[orderId]": order.id,
    "metadata[bundle]": bundle,
    "metadata[quantity]": String(quantity),
    "metadata[subtotal]": String(subtotal),
    "metadata[deliveryFee]": String(deliveryFee),
    success_url: "https://getyolko.com/?paid={CHECKOUT_SESSION_ID}",
    cancel_url: "https://getyolko.com/#order",
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
    fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }).then((r) => r.json()),
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
  if (!(qty >= 1) || !BUNDLE_KEYS.includes(md.bundle)) return order;
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
    const held = order.stockHeld || { trays: traysFor(order), dozens: dozensFor(order) };
    alignOrderWithSession(order, session);
    // Stock already held (admin confirmed first) for other items: move it.
    if (order.stockTaken && (held.trays !== traysFor(order) || held.dozens !== dozensFor(order))) {
      const settings = await getSettings(env);
      settings.traysAvailable = Math.max(0, settings.traysAvailable + held.trays - traysFor(order));
      settings.dozensAvailable = Math.max(0, (settings.dozensAvailable || 0) + held.dozens - dozensFor(order));
      await env.DATA.put("settings", JSON.stringify(settings));
      order.stockHeld = { trays: traysFor(order), dozens: dozensFor(order) };
    }
    order.paymentStatus = "paid";
    order.stripe = { ...(order.stripe || {}), ...stripeDetailsFromSession(session) };
    // Paid customers jump the queue: auto-confirm and allocate trays.
    if (order.status === "new" || order.status === "cancelled") order.status = "confirmed";
    await syncStock(env, order, order.status);
    await env.DATA.put(order.id, JSON.stringify(order));
    if (order.phone) await clearOpenOrder(env, order.phone, order.id);
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

function buildOrderEmail(order) {
  const first = String(order.name || "").split(/\s+/)[0] || "there";
  const item = BUNDLE_CHECKOUT_LABELS[order.bundle] || "Eggs";
  const qty = Math.max(1, Number(order.quantity) || 1);
  const total = order.stripe?.amountTotal != null ? order.stripe.amountTotal : order.price;
  const when = `Saturday${order.pickupDate ? " " + order.pickupDate : ""}`;
  const where = order.deliveryAddress || "Your delivery address";
  const ref = orderRef(order);
  const receipt = order.stripe?.receiptUrl || "";
  const wa = `https://wa.me/${STRIPE_SUPPORT_PHONE.replace(/\D/g, "")}`;
  const subject = `Your YOLKO order is confirmed (#${ref})`;

  const row = (label, value) =>
    `<tr><td style="padding:6px 0;color:#6b6257">${htmlEscape(label)}</td><td style="padding:6px 0;text-align:right;color:#1f1a14">${htmlEscape(value)}</td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#faf6ef;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf6ef;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td style="font-size:22px;font-weight:700;color:#1f1a14;letter-spacing:0.5px">YOLKO</td></tr>
<tr><td style="padding-top:18px;font-size:18px;color:#1f1a14">Thanks ${htmlEscape(first)}, your eggs are booked.</td></tr>
<tr><td style="padding-top:8px;font-size:15px;line-height:1.5;color:#4a4238">We have your payment and your order is confirmed. We deliver on ${htmlEscape(when)}.</td></tr>
<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;border-top:1px solid #eee5d8">
${row("Order", "#" + ref)}
${row("Item", `${qty} x ${item}`)}
${order.subtotal != null ? row("Subtotal", money(order.subtotal)) : ""}
${Number(order.deliveryFee) > 0 ? row("Delivery", money(order.deliveryFee)) : ""}
<tr><td style="padding:10px 0;border-top:1px solid #eee5d8;font-weight:700;color:#1f1a14">Total paid</td><td style="padding:10px 0;border-top:1px solid #eee5d8;text-align:right;font-weight:700;color:#1f1a14">${htmlEscape(money(total))} AUD</td></tr>
</table></td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.5;color:#4a4238"><strong style="color:#1f1a14">Delivery</strong><br>${htmlEscape(when)}<br>${htmlEscape(where)}</td></tr>
${receipt ? `<tr><td style="padding-top:20px"><a href="${htmlEscape(receipt)}" style="display:inline-block;background:#f2a516;color:#1f1a14;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">View receipt</a></td></tr>` : ""}
<tr><td style="padding-top:22px;font-size:14px;line-height:1.5;color:#6b6257">Questions or need to change something? Reply to this email or message us on <a href="${wa}" style="color:#b9770e">WhatsApp</a>.</td></tr>
</table>
<p style="font-size:12px;color:#9a8f80;margin-top:14px">YOLKO · Fresh eggs delivered in Sydney · <a href="https://getyolko.com" style="color:#9a8f80">getyolko.com</a></p>
</td></tr></table></body></html>`;

  const text = [
    `Thanks ${first}, your eggs are booked.`,
    "",
    `Order #${ref}`,
    `${qty} x ${item}`,
    order.subtotal != null ? `Subtotal: ${money(order.subtotal)}` : null,
    Number(order.deliveryFee) > 0 ? `Delivery: ${money(order.deliveryFee)}` : null,
    `Total paid: ${money(total)} AUD`,
    "",
    `Delivery: ${when}`,
    where,
    receipt ? `\nReceipt: ${receipt}` : null,
    "",
    `Questions? Reply to this email or WhatsApp us: ${wa}`,
    "YOLKO · getyolko.com",
  ].filter((l) => l !== null).join("\n");

  return { subject, html, text };
}

/** Send the confirmation via ZeptoMail. Returns { ok, skipped?, error? }. */
async function sendOrderConfirmationEmail(env, order) {
  const token = String(env.ZEPTOMAIL_TOKEN || "").trim();
  const from = String(env.ORDER_EMAIL_FROM || "").trim();
  const to = String(order.stripe?.email || order.email || "").trim();
  if (!token || !from) return { ok: false, skipped: true, reason: "email not configured" };
  if (!to) return { ok: false, skipped: true, reason: "no customer email" };

  const { subject, html, text } = buildOrderEmail(order);
  const payload = {
    from: { address: from, name: STRIPE_BRAND },
    to: [{ email_address: { address: to, name: order.name || "" } }],
    reply_to: [{ address: STRIPE_SUPPORT_EMAIL, name: STRIPE_BRAND }],
    subject,
    htmlbody: html,
    textbody: text,
  };
  const notify = String(env.ORDER_NOTIFY_EMAIL || "").trim();
  if (notify && notify.toLowerCase() !== to.toLowerCase()) {
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

/**
 * Cron safety net (every 15 min). Both checks only touch payments at least
 * WEBHOOK_GRACE_SEC old, so they never race the live webhook.
 * 1. Paid Checkout Sessions (last 26 h) whose order is still unpaid: the
 *    webhook was missed (wrong secret, outage) and so was the success page.
 * 2. Recent paid orders with no confirmation email yet: retried a few times.
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
}

// How many physical trays an order consumes (dozen packs do not use tray stock)
function traysFor(order) {
  const b = order.bundle;
  if (DOZEN_KEYS.includes(b) || CASE_KEYS.includes(b)) return 0;
  const perUnit = b === "box" ? 6 : b === "tray2" ? 2 : 1;
  return perUnit * (order.quantity || 1);
}

// How many dozen cartons an order consumes
function dozensFor(order) {
  const b = order.bundle;
  if (CASE_KEYS.includes(b)) return DOZENS_PER_CASE * (order.quantity || 1);
  if (DOZEN_KEYS.includes(b)) return order.quantity || 1;
  return 0;
}

// Reserve or release stock as an order moves through statuses.
// Paid customers always hold trays (unless cancelled). Confirmed/done also hold.
async function syncStock(env, order, newStatus) {
  const paid = order.paymentStatus === "paid";
  const holds = newStatus !== "cancelled" && (paid || ["confirmed", "done"].includes(newStatus));
  let trayDelta = 0;
  let dozenDelta = 0;

  if (holds && !order.stockTaken) {
    trayDelta = -traysFor(order);
    dozenDelta = -dozensFor(order);
    order.stockTaken = true;
    order.stockHeld = { trays: traysFor(order), dozens: dozensFor(order) };
  } else if (!holds && order.stockTaken) {
    // Release what was taken, even if the order's items were edited since.
    trayDelta = order.stockHeld ? order.stockHeld.trays : traysFor(order);
    dozenDelta = order.stockHeld ? order.stockHeld.dozens : dozensFor(order);
    order.stockTaken = false;
    delete order.stockHeld;
  }

  if (trayDelta !== 0 || dozenDelta !== 0) {
    const settings = await getSettings(env);
    if (trayDelta !== 0) {
      settings.traysAvailable = Math.max(0, settings.traysAvailable + trayDelta);
    }
    if (dozenDelta !== 0) {
      settings.dozensAvailable = Math.max(0, (settings.dozensAvailable || 0) + dozenDelta);
    }
    await env.DATA.put("settings", JSON.stringify(settings));
    if (trayDelta !== 0) {
      // Fire-and-forget: pause Meta ads at 0 trays, resume when restocked.
      syncMetaAdsForStock(env, settings.traysAvailable).catch(() => {});
    }
    return {
      delta: trayDelta,
      dozenDelta,
      traysAvailable: settings.traysAvailable,
      dozensAvailable: settings.dozensAvailable,
    };
  }
  const s = await getSettings(env);
  return {
    delta: 0,
    dozenDelta: 0,
    traysAvailable: s.traysAvailable,
    dozensAvailable: s.dozensAvailable || 0,
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

/** Public Meta Pixel ID (Events Manager → YOLKO). Override with env.META_PIXEL_ID. */
const DEFAULT_META_PIXEL_ID = "797932266678792";

function metaPixelId(env) {
  return String(env.META_PIXEL_ID || DEFAULT_META_PIXEL_ID).trim();
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
    order.bundle === "tray2" ? "2 egg trays (60 eggs)"
      : order.bundle === "box" ? "Full box (180 eggs)"
      : order.bundle === "tray1" ? "Egg tray (30 eggs)"
      : String(order.bundle || "eggs");

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
    } else {
      out[key] = defaults[key];
    }
  }
  return out;
}

/** Suggested whole-dollar sell for one dozen from its case cost (15 packs). */
function suggestDozenSell(caseCost) {
  const per = Number(caseCost) / DOZENS_PER_CASE;
  if (!Number.isFinite(per) || per < 0) return 1;
  return Math.max(1, Math.round(per + 1));
}

async function getSettings(env) {
  const stored = (await env.DATA.get("settings", "json")) || {};
  const prices = { ...DEFAULT_SETTINGS.prices, ...(stored.prices || {}) };
  // When single tray is $13, full box is $72
  if (Number(prices.tray1) === 13) prices.box = 72;
  // Fill missing case sell prices from matching dozen × 15
  for (const caseKey of CASE_KEYS) {
    const unitKey = CASE_UNIT[caseKey];
    if (!Number.isFinite(Number(prices[caseKey])) || Number(prices[caseKey]) <= 0) {
      const unit = Number(prices[unitKey]);
      if (Number.isFinite(unit) && unit > 0) prices[caseKey] = Math.round(unit * DOZENS_PER_CASE);
    }
  }
  const dozenCosts = normalizeDozenCosts(stored);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    prices,
    dozenCosts,
    pickup: Object.fromEntries(
      WEEK_DAYS.map((d) => [d, cleanPickupDay((stored.pickup || {})[d], DEFAULT_SETTINGS.pickup[d])])
    ),
  };
}

async function handleApi(request, env, url, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Public: current prices and stock
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return json(await getSettings(env));
  }

  // Admin: update prices and stock
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "bad json" }, 400);

    const current = await getSettings(env);
    const prices = { ...current.prices };
    for (const key of BUNDLE_KEYS) {
      const n = Number(body?.prices?.[key]);
      if (Number.isFinite(n) && n > 0) prices[key] = Math.round(n);
    }
    // When single tray is $13, full box is $72
    if (Number(prices.tray1) === 13) prices.box = 72;
    const dozenCosts = { ...current.dozenCosts };
    if (body?.dozenCosts && typeof body.dozenCosts === "object") {
      for (const key of DOZEN_KEYS) {
        const n = Number(body.dozenCosts[key]);
        if (Number.isFinite(n) && n >= 0) dozenCosts[key] = Math.round(n * 100) / 100;
      }
    }
    const next = {
      prices,
      traysAvailable: Number.isFinite(Number(body?.traysAvailable))
        ? Math.max(0, Math.floor(Number(body.traysAvailable)))
        : current.traysAvailable,
      dozensAvailable: Number.isFinite(Number(body?.dozensAvailable))
        ? Math.max(0, Math.floor(Number(body.dozensAvailable)))
        : (current.dozensAvailable ?? 0),
      trayWeight: ["1.5", "1.75", "fr-700", "fr-600"].includes(body?.trayWeight)
        ? body.trayWeight
        : current.trayWeight,
      boxCost: Number.isFinite(Number(body?.boxCost))
        ? Math.max(0, Number(body.boxCost))
        : (current.boxCost ?? 55),
      dozenCosts,
      pickup: Object.fromEntries(
        WEEK_DAYS.map((d) => [d, cleanPickupDay((body?.pickup || {})[d], current.pickup[d])])
      ),
    };
    await env.DATA.put("settings", JSON.stringify(next));
    if (next.traysAvailable !== current.traysAvailable) {
      syncMetaAdsForStock(env, next.traysAvailable).catch(() => {});
    }
    return json(next);
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

    // Dozen / case products only when admin has stocked them (dozensAvailable > 0)
    const needDozens = dozensFor({ bundle, quantity });
    if (needDozens > 0) {
      const left = Number(settings.dozensAvailable) || 0;
      if (left <= 0) {
        return json({ error: "dozen packs not available this week", code: "dozen_off" }, 400);
      }
      if (needDozens > left) {
        return json({ error: "not enough dozen packs left", code: "dozen_stock" }, 400);
      }
    }

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
      // Keep pending so checkout can mint a fresh session after cancel.
      if (existingOpen.paymentStatus !== "paid") existingOpen.paymentStatus = existingOpen.paymentStatus || "new";
      if (existingOpen.status === "cancelled") existingOpen.status = "new";
      await env.DATA.put(existingOpen.id, JSON.stringify(existingOpen));
      await rememberOpenOrder(env, phone, existingOpen.id);
      return json({
        ok: true,
        id: existingOpen.id,
        price: existingOpen.price,
        deliveryFee,
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
    };
    await env.DATA.put(id, JSON.stringify(order));
    await pushOrderIndex(env, id);
    await rememberOpenOrder(env, phone, id);
    return json({
      ok: true,
      id,
      price: order.price,
      deliveryFee,
      deliveryKm: order.deliveryKm,
      deliveryAddress: order.deliveryAddress,
    });
  }

  // Admin: auth check only (no KV list. free tier list() has a daily cap)
  if (url.pathname === "/api/admin/ping" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    return json({ ok: true });
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

    const settings = await getSettings(env);
    const result = await createCheckoutForOrder(env, order, settings, ctx);
    if (result.error) return json({ error: result.error, detail: result.detail || null }, result.status || 502);
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
    if (result.error) return json({ error: result.error, detail: result.detail || null }, result.status || 502);
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
          contentName:
            order.bundle === "tray2" ? "2 egg trays (60 eggs)"
              : order.bundle === "box" ? "Full box (180 eggs)"
              : order.bundle === "tray1" ? "Egg tray (30 eggs)"
              : String(order.bundle || "eggs"),
          numItems: Math.max(1, Number(order.quantity) || 1),
        };
      }
    }
    return json({
      paid,
      purchase,
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
      "metadata[orderId]": id,
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
        order.paymentStatus = "refunded";
        order.status = "cancelled";
        const stock = await syncStock(env, order, "cancelled");
        await env.DATA.put(id, JSON.stringify(order));
        return json({
          ok: true,
          already: true,
          traysAvailable: stock.traysAvailable,
          stockDelta: stock.delta,
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

    return json({
      ok: true,
      refundId: refund.id,
      amount: order.stripe.refundAmount,
      currency: order.stripe.refundCurrency,
      status: refund.status,
      email: order.stripe.email || null,
      traysAvailable: stock.traysAvailable,
      stockDelta: stock.delta,
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
    const stock = await syncStock(env, order, status);
    order.status = status;
    await env.DATA.put(id, JSON.stringify(order));
    return json({ ok: true, trays: traysFor(order), stockDelta: stock.delta, traysAvailable: stock.traysAvailable });
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

  // Public: latest competitor egg prices (reactive watch snapshot)
  if (url.pathname === "/api/price-watch" && request.method === "GET") {
    const latest = await getLatest(env);
    if (!latest) {
      return json({
        ok: true,
        updatedAt: null,
        offers: [],
        summary: null,
        note: "No snapshot yet. Wait for cron poll or POST /api/price-watch/ingest",
      });
    }
    return json({
      ok: true,
      updatedAt: latest.updatedAt,
      source: latest.source,
      summary: latest.summary,
      offers: latest.offers,
      last_changes: latest.last_changes || [],
    });
  }

  // Admin: change event stream (price/stock flips)
  if (url.pathname === "/api/price-watch/events" && request.method === "GET") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const events = (await getEvents(env)).slice(0, limit);
    return json({ ok: true, count: events.length, events });
  }

  // Admin: ingest a full scout snapshot (GitHub Action / local scout --push)
  if (url.pathname === "/api/price-watch/ingest" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const body = await request.json().catch(() => ({}));
    const result = await ingestSnapshot(env, body, { source: body?.source || "ingest" });
    return json(result);
  }

  // Admin: force an immediate open-source poll (Umall + Gourmet Grocer)
  if (url.pathname === "/api/price-watch/poll" && request.method === "POST") {
    if (!isAdmin(request, env)) return json({ error: "unauthorised" }, 401);
    const result = await runScheduledPoll(env);
    return json(result);
  }

  return json({ error: "not found" }, 404);
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#ffd32a">
<title>YOLKO Admin</title>
<link rel="stylesheet" href="/assets/fonts.css?v=76">
<style>
:root {
  --canvas:#f2f0ea; --paper:#fffefb; --ink:#171714; --muted:#6d6b64;
  --line:rgba(23,23,20,.16); --yellow:#ffd32a; --orange:#f6532f;
  --green:#15734c; --green-soft:#e8f3ed; --blue:#1d4f91; --blue-soft:#e2ecf9;
  --red:#b32323; --red-soft:#f7e0dd; --warn:#fff3b0;
  --display:"Bricolage Grotesque","Arial Black",sans-serif;
  --body:"Plus Jakarta Sans",system-ui,sans-serif;
}
*,*::before,*::after { box-sizing:border-box; -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
body { margin:0; font-family:var(--body); background:var(--canvas); color:var(--ink); font-size:15px; line-height:1.45; -webkit-font-smoothing:antialiased; }
.wrap { max-width:640px; margin:0 auto; padding:18px 14px 70px; }

@media (min-width:760px) {
  .wrap { max-width:920px; padding:26px 24px 80px; }
  #orders { display:flex; flex-direction:column; gap:0; }
  .stat b { font-size:26px; }
  .card { padding:26px 24px; }
}
@media (min-width:1024px) {
  .wrap { max-width:1200px; padding:32px 28px 90px; }
  .cols { display:grid; grid-template-columns:1.55fr 1fr; gap:18px; align-items:start; }
  .cols > .card { margin-bottom:0; }
  .cols > .card:last-child { position:sticky; top:18px; }
  #orders { display:flex; flex-direction:column; gap:0; }
  .top .brand-name { font-size:28px; }
  h2 { font-size:22px; }
}

.top { display:flex; align-items:center; gap:12px; margin-bottom:22px; padding-bottom:16px; border-bottom:1px solid var(--line); }
.brand { display:inline-flex; align-items:center; gap:10px; text-decoration:none; color:inherit; }
.brand-dot { width:14px; height:14px; border-radius:50%; background:var(--yellow); box-shadow:3px 3px 0 var(--ink); }
.brand-name { font-family:var(--display); font-size:22px; font-weight:800; letter-spacing:-.04em; line-height:1; text-transform:uppercase; }
.top small { display:block; font-size:10px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--orange); margin-top:4px; }
.top .out { margin-left:auto; }

.card { background:var(--paper); border:1px solid var(--ink); border-radius:0; padding:20px 18px; margin-bottom:16px; box-shadow:6px 6px 0 var(--yellow); }
h2 { font-family:var(--display); font-size:20px; font-weight:800; margin:0 0 14px; letter-spacing:-.03em; text-transform:uppercase; }
.topline { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:4px; }
.topline h2 { margin-bottom:14px; }

.stats { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:16px; }
@media (max-width:640px){ .stats { grid-template-columns:repeat(3,1fr); } }
.stat { background:var(--paper); border:1px solid var(--line); border-radius:0; padding:12px 8px; text-align:center; }
.stat.highlight { background:var(--yellow); border-color:var(--ink); }
.stat.highlight b { color:var(--ink); }
.stat b { display:block; font-family:var(--display); font-size:22px; font-weight:800; letter-spacing:-.03em; }
.stat span { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }

.toast { position:fixed; left:50%; bottom:22px; transform:translate(-50%,16px); z-index:300; max-width:90vw; padding:12px 18px; background:var(--ink); color:var(--paper); font-weight:700; font-size:13.5px; border-radius:0; box-shadow:6px 6px 0 var(--yellow); opacity:0; transition:opacity .3s ease, transform .3s ease; }
.toast.show { opacity:1; transform:translate(-50%,0); }

.orders-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 12px; }
.filter-chip {
  min-height:34px; padding:0 11px; border:1px solid var(--line); background:var(--paper); color:var(--muted);
  font:inherit; font-weight:800; font-size:11px; text-transform:uppercase; letter-spacing:.04em; cursor:pointer;
}
.filter-chip b { font-family:var(--display); margin-left:6px; color:var(--ink); }
.filter-chip.on { background:var(--ink); border-color:var(--ink); color:var(--paper); }
.filter-chip.on b { color:var(--yellow); }
.orders-hint { width:100%; margin:0; font-size:12px; color:var(--muted); }

#orders { display:grid; grid-template-columns:1fr 1fr; gap:14px; border-top:0; align-items:start; }
@media (max-width:900px) { #orders { grid-template-columns:1fr; } }

.lane {
  border:1px solid rgba(23,23,20,.12); background:var(--paper); min-height:120px;
  border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(23,23,20,.04);
}
.lane-head {
  display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  padding:12px 14px; border-bottom:1px solid rgba(23,23,20,.08); background:var(--canvas);
}
.lane-head h3 {
  margin:0; font-family:var(--display); font-size:14px; font-weight:800;
  letter-spacing:-.02em; text-transform:uppercase;
}
.lane-head span { font-size:11px; font-weight:800; color:var(--muted); }
.lane.waiting .lane-head { background:var(--yellow); }
.lane.waiting .lane-head span { color:var(--ink); }
.lane-body {
  padding:0;
  max-height: min(420px, 52vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--ink) var(--canvas);
}
.lane-body::-webkit-scrollbar { width: 8px; }
.lane-body::-webkit-scrollbar-thumb { background: var(--ink); }
.lane-body::-webkit-scrollbar-track { background: var(--canvas); }
.lane-empty { padding:18px 12px; color:var(--muted); font-size:13px; }

.day-group { border-bottom:1px solid var(--line); }
.day-group:last-child { border-bottom:0; }
.day-head {
  display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  padding:8px 12px 4px; font-size:11px; font-weight:800; letter-spacing:.06em;
  text-transform:uppercase; color:var(--muted); background:var(--canvas);
}
.day-head b { color:var(--ink); font-family:var(--display); letter-spacing:-.02em; text-transform:none; font-size:13px; }

.order {
  display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 12px; align-items:center;
  padding:12px 14px; border-bottom:1px solid rgba(23,23,20,.06); border-left:3px solid transparent;
  cursor:pointer; background:transparent; transition:background .15s ease;
}
.order:last-child { border-bottom:0; }
.order:hover { background:rgba(23,23,20,.03); }
.order.open { background:linear-gradient(90deg, rgba(255,211,42,.22), rgba(255,211,42,.08)); }
.order.st-new { border-left-color:var(--yellow); }
.order.st-confirmed { border-left-color:var(--green); }
.order.st-done { border-left-color:var(--line); opacity:.7; }
.order.st-cancelled { border-left-color:var(--red); opacity:.55; }
.order.prio { box-shadow:inset 0 0 0 1px rgba(23,23,20,.12); }
.order.sus { background:rgba(246,83,47,.05); }

.o-name { font-weight:800; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; letter-spacing:-.01em; }
.o-sub { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.o-right { text-align:right; }
.o-price { display:block; font-family:var(--display); font-weight:800; font-size:16px; color:var(--orange); letter-spacing:-.03em; line-height:1.1; }
.o-flag { display:block; font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-top:2px; }
.o-flag.warn { color:var(--orange); }
.o-name-row { display:flex; align-items:center; gap:8px; min-width:0; }
.o-name-row .o-name { min-width:0; }
.badge-paid {
  flex-shrink:0; padding:3px 8px; border-radius:999px; background:var(--ink); color:var(--yellow);
  font-size:9px; font-weight:800; letter-spacing:.06em; text-transform:uppercase;
}
.badge-refunded {
  flex-shrink:0; padding:3px 8px; border-radius:999px; background:var(--red-soft); color:var(--red);
  font-size:9px; font-weight:800; letter-spacing:.06em; text-transform:uppercase;
}

.o-detail {
  display:none; grid-column:1 / -1; gap:0; padding:10px 0 6px;
  margin-top:4px;
}
.order.open .o-detail { display:block; }

.sale-card {
  margin-top:4px; padding:14px 14px 12px;
  border:1px solid rgba(23,23,20,.12); border-radius:12px; background:#fff;
}
.sale-name {
  margin:0 0 12px; font-family:var(--display); font-weight:800; font-size:18px;
  letter-spacing:-.03em; line-height:1.2;
}
.sale-chip {
  display:inline-block; margin-left:8px; padding:3px 8px; border-radius:999px; vertical-align:middle;
  background:var(--ink); color:var(--yellow); font-size:9px; font-weight:800;
  letter-spacing:.06em; text-transform:uppercase; position:relative; top:-2px;
}
.sale-chip.refunded { background:var(--red-soft); color:var(--red); }
.sale-contacts { display:grid; gap:10px; }
.sale-row, a.sale-row {
  display:block; text-decoration:none; color:inherit;
}
.sale-k {
  display:block; margin:0 0 2px; font-size:10px; font-weight:700;
  letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
}
.sale-v {
  display:block; margin:0; font-size:14px; font-weight:600; line-height:1.4;
  word-break:break-word; white-space:pre-line; color:var(--ink);
}
.sale-v.muted { color:var(--muted); }
a.sale-row:hover .sale-v { color:var(--orange); }
.sale-tools {
  display:flex; align-items:center; gap:8px; margin-top:14px; padding-top:12px;
  border-top:1px solid rgba(23,23,20,.1); flex-wrap:wrap;
}
.icon-btn {
  width:36px; height:36px; min-width:36px; min-height:36px;
  padding:0; display:inline-flex; align-items:center; justify-content:center; overflow:hidden;
  border:1px solid rgba(23,23,20,.16); border-radius:8px; background:#fff; color:var(--ink);
  cursor:pointer; text-decoration:none; box-shadow:none; flex:0 0 36px;
}
.icon-btn:hover { background:var(--ink); color:#fff; border-color:var(--ink); }
.icon-btn.danger { color:var(--red); border-color:rgba(179,35,35,.3); }
.icon-btn.danger:hover { background:var(--red); color:#fff; border-color:var(--red); }
.icon-btn svg { width:16px; height:16px; display:block; }
.sale-status { display:flex; flex-wrap:wrap; gap:8px; margin-left:auto; }
.sale-status button {
  min-height:36px; padding:6px 12px; font-size:12px; border-radius:8px; box-shadow:none;
}
.o-actions { display:none; }
.callbtn { background:var(--yellow); color:var(--ink); }

.archive {
  margin-top:14px; border-top:1px solid var(--line); padding-top:10px;
}
.archive summary {
  cursor:pointer; font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
  list-style:none;
}
.archive summary::-webkit-details-marker { display:none; }
.archive summary::before { content:"+ "; color:var(--ink); }
.archive[open] summary::before { content:"– "; }
.archive .lane { margin-top:8px; }

.pill { display:inline-block; padding:2px 7px; font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
.pill.new { background:var(--yellow); color:var(--ink); }
.pill.confirmed { background:var(--green-soft); color:var(--green); }
.pill.done { background:var(--canvas); color:var(--muted); }
.pill.cancelled { background:var(--red-soft); color:var(--red); }
.pill.paid { background:var(--ink); color:var(--paper); }
.pill.warn { background:var(--warn); color:var(--ink); }


button, .callbtn {
  display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:10px 14px;
  border:1px solid var(--ink); border-radius:0; font:inherit; font-weight:800; font-size:13.5px;
  white-space:nowrap; cursor:pointer; background:var(--ink); color:var(--paper); text-decoration:none;
  transition:transform .15s ease, background .15s ease, color .15s ease;
}
button:active, .callbtn:active { transform:translate(1px,1px); }
button.ghost { background:var(--paper); color:var(--ink); }
button.danger { background:var(--red-soft); color:var(--red); border-color:var(--red); }
.callbtn { background:var(--yellow); color:var(--ink); }
button:not(.ghost):not(.danger):not(.icon-btn):hover { background:var(--orange); border-color:var(--orange); color:#fff; }
.callbtn:hover { background:var(--ink); color:var(--paper); }

label { display:block; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:6px; }
input, select {
  width:100%; min-height:48px; padding:10px 13px; border:1px solid var(--ink); border-radius:0;
  font:inherit; font-size:16px; font-weight:600; background:var(--paper); color:var(--ink);
  transition:border-color .15s ease, box-shadow .15s ease;
}
select {
  appearance:none; -webkit-appearance:none; padding-right:40px; cursor:pointer;
  background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="9" viewBox="0 0 14 9"><path d="M1 1.5 7 7.5 13 1.5" fill="none" stroke="%23171714" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter"/></svg>');
  background-repeat:no-repeat; background-position:right 14px center;
}
input[type="time"] { cursor:pointer; }
input:hover, select:hover { border-color:var(--orange); }
input:focus, select:focus { outline:none; border-color:var(--orange); box-shadow:3px 3px 0 var(--yellow); }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px; }
.grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:12px; }
@media (max-width:720px) { .grid3 { grid-template-columns:1fr 1fr; } }
.ps-block { margin:18px 0 8px; padding-top:14px; border-top:1px solid var(--line); }
.ps-block:first-of-type { margin-top:8px; padding-top:0; border-top:0; }
.ps-title { font-size:15px; margin:0 0 6px; }
.ps-sub { margin:0 0 12px; font-size:12.5px; color:var(--muted); }
.dozen-row {
  display:grid; grid-template-columns:1.2fr 1fr 1fr auto; gap:8px; align-items:end;
  padding:10px 0; border-bottom:1px solid var(--line);
}
.dozen-row:last-child { border-bottom:0; }
.dozen-row .d-name { font-weight:800; font-size:13.5px; padding-bottom:10px; }
.dozen-row .d-profit {
  min-width:72px; text-align:right; font-weight:800; font-size:13px; padding-bottom:12px;
}
@media (max-width:720px) {
  .dozen-row { grid-template-columns:1fr 1fr; }
  .dozen-row .d-name { grid-column:1 / -1; padding-bottom:0; }
  .dozen-row .d-profit { grid-column:1 / -1; text-align:left; padding-bottom:0; }
}
.hint { margin:-6px 0 10px; font-size:12.5px; color:var(--muted); }
.day-chips { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-bottom:14px; }
.chip {
  min-height:44px; padding:0; border:1px solid var(--line); border-radius:0; background:var(--paper);
  color:var(--muted); font:inherit; font-weight:800; font-size:13px; cursor:pointer; transition:all .15s ease;
}
.chip:hover { border-color:var(--ink); color:var(--ink); }
.chip.on { background:var(--ink); border-color:var(--ink); color:var(--paper); box-shadow:3px 3px 0 var(--yellow); }
.hours-row { display:grid; grid-template-columns:44px 1fr 26px 1fr; gap:8px; align-items:center; margin-bottom:10px; }
.hours-row b { font-size:13.5px; color:var(--orange); }
.hours-row span { text-align:center; font-size:12.5px; color:var(--muted); }
.hours-row select { min-height:44px; }
.hours-empty { margin:4px 0 10px; font-size:13.5px; color:var(--muted); }
.b-sum { font-size:12.5px; font-weight:700; color:var(--muted); }
#buyers { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:10px; }
.buyer-card { border:1px solid var(--line); border-radius:0; padding:14px 14px 12px; background:var(--paper); }
.bc-top { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.b-rank { flex-shrink:0; width:26px; height:26px; display:grid; place-items:center; background:var(--canvas); border:1px solid var(--line); border-radius:0; font-weight:800; font-size:12px; color:var(--muted); }
.b-rank.top { background:var(--yellow); color:var(--ink); border-color:var(--ink); }
.bc-name { flex:1; min-width:0; }
.bc-name b { display:block; font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.b-spend { font-family:var(--display); font-weight:800; font-size:18px; color:var(--orange); }
.bb { display:inline-block; margin-right:4px; padding:2px 7px; border-radius:0; font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
.bb.gold { background:var(--yellow); color:var(--ink); }
.bb.green { background:var(--green-soft); color:var(--green); }
.bb.blue { background:var(--blue-soft); color:var(--blue); }
.spark { display:block; width:100%; height:38px; margin-bottom:10px; }
.bc-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-bottom:10px; }
.bc-grid > div { background:var(--canvas); border:1px solid var(--line); border-radius:0; padding:7px 4px; text-align:center; }
.bc-grid b { display:block; font-size:13.5px; }
.bc-grid span { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
.bc-foot { display:flex; align-items:center; gap:8px; }
.b-insight { flex:1; font-size:11.5px; font-weight:700; padding:6px 9px; border-radius:0; }
.b-insight.warn { background:var(--warn); color:var(--ink); }
.b-insight.due { background:var(--blue-soft); color:var(--blue); }
.b-insight.good { background:var(--green-soft); color:var(--green); }
.b-insight.soft { background:var(--canvas); color:var(--muted); }
.bc-call { flex-shrink:0; padding:6px 14px; background:var(--ink); color:var(--paper); border-radius:0; font-size:12px; font-weight:700; text-decoration:none; border:1px solid var(--ink); }
.dayrow { display:grid; grid-template-columns:96px 1fr 1fr; gap:10px; align-items:end; margin-bottom:12px; }
.chk { display:flex; align-items:center; gap:8px; font-size:14.5px; font-weight:800; text-transform:none; letter-spacing:0; color:var(--ink); padding-bottom:12px; }
.chk input { width:20px; height:20px; min-height:0; accent-color:var(--orange); }
.msg { font-size:13.5px; font-weight:700; margin-left:10px; }
.msg.ok { color:var(--green); } .msg.err { color:var(--red); }
.note { font-size:12.5px; color:var(--muted); margin:12px 0 0; }
.empty { color:var(--muted); text-align:center; padding:24px 0; }
.refresh { width:100%; margin-top:4px; }
.login { max-width:420px; margin:40px auto 0; }
.login h2 { margin-bottom:8px; }
.login-lead { margin:0 0 16px; color:var(--muted); font-size:14px; }


.visit-card { border:1px solid var(--line); padding:12px; margin:0 0 10px; background:var(--canvas); }
.visit-card .v-top { display:flex; justify-content:space-between; gap:8px; align-items:baseline; margin-bottom:6px; }
.visit-card .v-src { font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--orange); }
.visit-card .v-time { font-size:12px; color:var(--muted); font-weight:700; }
.visit-card .v-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 12px; font-size:12.5px; }
.visit-card .v-grid b { display:block; font-size:11px; color:var(--muted); font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
.visit-note { font-size:12.5px; color:var(--muted); margin:0 0 12px; line-height:1.4; }
.v-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:14px; }
.v-stats .stat { padding:10px; border:1px solid var(--line); background:var(--paper); }
.v-stats .stat b { display:block; font-family:var(--display); font-size:22px; }
.v-stats .stat span { font-size:11px; font-weight:800; text-transform:uppercase; color:var(--muted); }

.pw-table { width:100%; border-collapse:collapse; font-size:13px; margin:0 0 16px; }
.pw-table th, .pw-table td { border-bottom:1px solid var(--line); padding:8px 6px; text-align:left; vertical-align:top; }
.pw-table th { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:800; }
.pw-table td.num { font-family:var(--display); font-weight:800; white-space:nowrap; }
.pw-table a { color:var(--blue); font-weight:700; word-break:break-all; }
.pw-pill { display:inline-block; padding:2px 7px; font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; border:1px solid var(--line); }
.pw-pill.in_stock, .pw-pill.sell { background:var(--green-soft); color:var(--green); border-color:transparent; }
.pw-pill.out_of_stock { background:var(--red-soft); color:var(--red); border-color:transparent; }
.pw-event { border:1px solid var(--line); padding:10px 12px; margin:0 0 8px; background:var(--canvas); font-size:13px; }
.pw-event b { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--orange); }
.pw-actions { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 12px; }

.admin-tabs { display:flex; gap:8px; margin:0 0 16px; flex-wrap:wrap; }
.admin-tabs button {
  min-height:40px; padding:0 16px; border:1px solid var(--ink); background:var(--paper); color:var(--ink);
  font:inherit; font-weight:800; font-size:12px; letter-spacing:.06em; text-transform:uppercase; cursor:pointer;
  box-shadow:none;
}
.admin-tabs button.on { background:var(--ink); color:var(--paper); }
.view[hidden] { display:none !important; }
.asset-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 14px; }
.asset-toolbar select, .asset-toolbar input[type=text] {
  min-height:36px; border:1px solid var(--line); background:var(--paper); padding:0 10px; font:inherit; font-size:13px;
}
.asset-publish {
  display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between;
  padding:12px 14px; margin:0 0 14px; border:1px solid var(--ink); background:var(--yellow);
}
.asset-publish p { margin:0; font-size:13px; font-weight:700; }
.asset-publish .muted { color:var(--muted); font-weight:600; }
.draft-row { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 16px; min-height:44px; align-items:center; }
.draft-chip {
  display:inline-flex; align-items:center; gap:8px; padding:6px 8px 6px 6px; border:1px solid var(--ink);
  background:var(--paper); font-size:12px; font-weight:700;
}
.draft-chip img { width:36px; height:36px; object-fit:cover; border:1px solid var(--line); }
.draft-chip button { min-height:28px; padding:0 8px; font-size:11px; box-shadow:none; }
.asset-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
.asset-card {
  border:1px solid var(--ink); background:var(--paper); display:flex; flex-direction:column; overflow:hidden;
}
.asset-card.fav { outline:2px solid var(--orange); outline-offset:-2px; }
.asset-card.in-draft { box-shadow:4px 4px 0 var(--yellow); }
.asset-card.deleted { opacity:.45; }
.asset-card .thumb { aspect-ratio:1; background:#111; position:relative; }
.asset-card .thumb img { width:100%; height:100%; object-fit:cover; display:block; cursor:zoom-in; }
.asset-card .badges { position:absolute; top:8px; left:8px; display:flex; gap:4px; flex-wrap:wrap; }
.asset-lightbox {
  position:fixed; inset:0; z-index:500; display:flex; align-items:center; justify-content:center;
  padding:18px; background:rgba(17,17,14,.88); backdrop-filter:blur(6px);
}
.asset-lightbox[hidden] { display:none !important; }
.asset-lightbox-inner {
  position:relative; max-width:min(960px, 100%); max-height:100%;
  display:flex; flex-direction:column; gap:10px; align-items:center;
}
.asset-lightbox img {
  display:block; max-width:100%; max-height:min(82vh, 900px); object-fit:contain;
  background:#000; border:1px solid rgba(255,255,255,.2);
}
.asset-lightbox .lb-cap { color:#f3f1ea; font-size:13px; font-weight:700; text-align:center; }
.asset-lightbox .lb-close {
  position:absolute; top:-6px; right:-6px; min-height:40px; min-width:40px; padding:0 12px;
  background:var(--paper); color:var(--ink); border:1px solid var(--ink); font-weight:800; cursor:pointer;
  box-shadow:3px 3px 0 var(--yellow);
}
.asset-card .badge {
  padding:2px 6px; font-size:9px; font-weight:800; letter-spacing:.04em; text-transform:uppercase;
  background:var(--ink); color:var(--paper);
}
.asset-card .badge.live { background:var(--green); }
.asset-card .badge.fav { background:var(--orange); }
.asset-card .meta { padding:10px; display:flex; flex-direction:column; gap:8px; flex:1; }
.asset-card .meta strong { font-size:12px; line-height:1.25; word-break:break-word; }
.asset-card .meta select { width:100%; min-height:32px; font-size:12px; border:1px solid var(--line); }
.asset-card .actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.asset-card .actions button { min-height:32px; padding:0 6px; font-size:11px; box-shadow:none; }
.asset-empty { padding:28px 12px; text-align:center; color:var(--muted); }

.asset-bulk {
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:10px 12px; margin:0 0 12px; border:1px solid var(--line); background:var(--canvas);
}
.asset-bulk .count { font-size:12.5px; font-weight:800; margin-right:auto; }
.asset-bulk label.chk-all {
  display:inline-flex; align-items:center; gap:8px; font-size:12.5px; font-weight:800;
  text-transform:none; letter-spacing:0; padding:0; color:var(--ink); cursor:pointer;
}
.asset-bulk label.chk-all input { width:18px; height:18px; min-height:0; accent-color:var(--orange); }
.asset-card.selected { box-shadow:4px 4px 0 var(--orange); }
.asset-card .pick {
  position:absolute; top:8px; right:8px; z-index:2;
  width:22px; height:22px; accent-color:var(--orange); cursor:pointer;
}
</style>

</head>
<body>
<div class="wrap">
  <div class="top">
    <a class="brand" href="/" aria-label="YOLKO home">
      <span class="brand-dot" aria-hidden="true"></span>
      <span class="brand-name">YOLKO</span>
    </a>
    <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
      <small>Admin</small>
      <button class="ghost out" id="signout" onclick="logout()" style="display:none">Sign out</button>
    </div>
  </div>

  <div class="card login" id="login-card">
    <h2>Sign in</h2>
    <p class="login-lead">Paste your admin key to manage orders, stock, and delivery settings.</p>
    <label>Admin key</label>
    <input id="key" type="password" placeholder="Paste your admin key" style="margin-bottom:12px" autocomplete="current-password">
    <button type="button" id="signin-btn" onclick="saveKey()" style="width:100%">Sign in</button>
    <p class="msg err" id="login-msg" style="margin:10px 0 0; display:block; text-align:center"></p>
  </div>

  <div id="panel" style="display:none">
    <div class="admin-tabs" role="tablist">
      <button type="button" class="on" id="tab-shop" onclick="showAdminView('shop')">Orders &amp; stock</button>
      <button type="button" id="tab-prices" onclick="showAdminView('prices')">Competitor prices</button>
      <button type="button" id="tab-visits" onclick="showAdminView('visits')">QR / Flyer</button>
      <button type="button" id="tab-assets" onclick="showAdminView('assets')">Assets</button>
    </div>

    <div id="view-shop" class="view">
    <div class="stats" id="stats"></div>

    <div class="cols">
    <div class="col-left">
    <div class="card">
      <div class="topline">
        <h2>Orders</h2>
        <button class="ghost" onclick="loadOrders()" style="min-height:36px;padding:6px 12px;font-size:12px">Refresh</button>
      </div>
      <div id="orders"></div>
      <div id="orders-archive" class="archive"></div>
      <p class="empty" id="empty" style="display:none">No open orders.</p>
    </div>

    <div class="card">
      <div class="topline">
        <h2>Buyers</h2>
        <span class="b-sum" id="buyer-sum"></span>
      </div>
      <div id="buyers"></div>
    </div>
    </div>

    <div class="card">
      <h2>Prices &amp; stock</h2>

      <div class="ps-block">
        <h3 class="ps-title">Stock this week</h3>
        <p class="ps-sub">Dozen packs stay off the website while stock is 0.</p>
        <div class="grid2">
          <div><label>Trays left</label><input id="stock" type="number" min="0" step="1"></div>
          <div><label>Dozen packs left</label><input id="dozen-stock" type="number" min="0" step="1" value="0"></div>
          <div style="grid-column:1/-1"><label>Featured tray on homepage</label>
            <select id="tray-weight">
              <option value="1.75">Cage · 1.75kg (Extra Large)</option>
              <option value="1.5">Cage · 1.5kg (Large)</option>
              <option value="fr-700">Free range · 700g</option>
              <option value="fr-600">Free range · 600g</option>
            </select>
          </div>
        </div>
      </div>

      <div class="ps-block">
        <h3 class="ps-title">Tray prices</h3>
        <p class="ps-sub">Change one price and the others follow. $13 tray locks the box at $72.</p>
        <div class="grid3">
          <div><label>1 tray</label><input id="p1" type="number" min="1" step="1"></div>
          <div><label>2 trays</label><input id="p2" type="number" min="1" step="1"></div>
          <div><label>Full box</label><input id="p3" type="number" min="1" step="1"></div>
        </div>
        <div class="grid2">
          <div><label>What you pay for a box</label><input id="box-cost" type="number" min="0" step="1" value="55"></div>
        </div>
        <p class="hint" id="price-hint"></p>
      </div>

      <div class="ps-block">
        <h3 class="ps-title">Dozen packs</h3>
        <p class="ps-sub">Enter what you pay for a case of 15. We suggest a sell price for that product only.</p>
        <div id="dozen-list"></div>
        <p class="hint" id="dozen-hint"></p>
        <div style="display:none" aria-hidden="true">
          <input id="p-cage600" type="number"><input id="p-cage700" type="number"><input id="p-cage800" type="number">
          <input id="p-fr600" type="number"><input id="p-fr700" type="number"><input id="p-fr800" type="number">
          <input id="p-cage600case" type="number"><input id="p-cage700case" type="number"><input id="p-cage800case" type="number">
          <input id="p-fr600case" type="number"><input id="p-fr700case" type="number"><input id="p-fr800case" type="number">
          <input id="c-cage600" type="number"><input id="c-cage700" type="number"><input id="c-cage800" type="number">
          <input id="c-fr600" type="number"><input id="c-fr700" type="number"><input id="c-fr800" type="number">
        </div>
      </div>

      <div class="ps-block">
        <h3 class="ps-title">Pickup days</h3>
        <p class="ps-sub">Tap a day to open or close it.</p>
        <div class="day-chips" id="day-chips"></div>
        <div id="day-hours"></div>
      </div>

      <button onclick="saveSettings()" style="width:100%">Save changes</button><span class="msg" id="save-msg"></span>
      <p class="note">Saved changes show on the website within seconds.</p>
    </div>
    </div>
    </div>

    <div id="view-prices" class="view" hidden>
      <div class="card">
        <div class="topline">
          <h2>Competitor prices</h2>
          <button class="ghost" onclick="loadPriceWatch()" style="min-height:36px;padding:6px 12px;font-size:12px">Refresh</button>
        </div>
        <p class="visit-note">Live caged egg watch (700g dozens + 30-packs). Worker polls every 15 minutes and records changes. Your own sell prices stay under <b>Orders &amp; stock</b>.</p>
        <div class="pw-actions">
          <button type="button" class="ghost" onclick="pollPriceWatchNow()">Check prices now</button>
          <span class="msg" id="pw-msg"></span>
        </div>
        <div class="v-stats" id="pw-stats"></div>
        <p class="muted" id="pw-meta" style="margin:0 0 14px;font-size:12.5px;color:var(--muted);font-weight:700"></p>

        <h3 class="ps-title">Caged 700g (dozen)</h3>
        <div id="pw-700"></div>

        <h3 class="ps-title">Caged 30-packs <span style="font-weight:600;color:var(--muted);text-transform:none;letter-spacing:0">(not 700g. usually 1.5–1.75kg)</span></h3>
        <div id="pw-30"></div>

        <h3 class="ps-title">Recent changes</h3>
        <div id="pw-events"></div>
        <p class="empty" id="pw-empty" style="display:none">No price snapshots yet. Tap <b>Check prices now</b>.</p>
      </div>
    </div>

    <div id="view-visits" class="view" hidden>
      <div class="card">
        <div class="topline">
          <h2>QR / Flyer visits</h2>
          <button class="ghost" onclick="loadVisits()" style="min-height:36px;padding:6px 12px;font-size:12px">Refresh</button>
        </div>
        <p class="visit-note" id="visit-note">Tracks scans that land via <code>/f</code> or <code>?src=flyer</code>. Browsers cannot send gender, real name, or hardware device IDs. Those stay blank until someone orders.</p>
        <div class="v-stats" id="visit-stats"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button type="button" class="ghost" id="visit-filter-flyer" onclick="loadVisits('flyer')">Flyer / QR only</button>
          <button type="button" class="ghost" id="visit-filter-all" onclick="loadVisits('')">All sources</button>
        </div>
        <div id="visits"></div>
        <p class="empty" id="visits-empty" style="display:none">No tracked visits yet. Scan the flyer QR (must open getyolko.com/f).</p>
      </div>
    </div>

    <div id="view-assets" class="view" hidden>
      <div class="card">
        <div class="topline">
          <h2>Assets</h2>
          <button class="ghost" onclick="loadAssets()" style="min-height:36px;padding:6px 12px;font-size:12px">Refresh</button>
        </div>
        <p class="orders-hint">Favourite images, pick which ones rotate on the website, organise categories, then publish to go live. Delete hides an image from admin and live (files stay in the repo).</p>

        <div class="asset-publish">
          <div>
            <p id="publish-status">Loading…</p>
            <p class="muted" id="publish-meta"></p>
          </div>
          <button type="button" id="publish-btn" onclick="publishAssets()">Publish to live</button>
        </div>

        <h3 class="ps-title">Live rotator (draft)</h3>
        <p class="ps-sub">Order = slideshow order on the homepage. Tap Use on a card to add/remove.</p>
        <div class="draft-row" id="draft-row"></div>

        <div class="asset-toolbar">
          <select id="asset-filter-cat" onchange="renderAssets()"></select>
          <select id="asset-filter-view" onchange="renderAssets()">
            <option value="active">Active</option>
            <option value="favorites">Favorites</option>
            <option value="draft">In draft</option>
            <option value="deleted">Deleted</option>
            <option value="all">All</option>
          </select>
          <input id="asset-filter-q" type="text" placeholder="Search…" oninput="renderAssets()" style="flex:1;min-width:140px">
          <input id="new-cat-name" type="text" placeholder="New category" style="width:140px">
          <button type="button" class="ghost" onclick="createCategory()">Add category</button>
        </div>
        <div class="asset-bulk" id="asset-bulk">
          <label class="chk-all"><input type="checkbox" id="asset-select-all" onchange="toggleSelectAll(this.checked)"> Select all</label>
          <span class="count" id="asset-selected-count">0 selected</span>
          <button type="button" class="ghost" onclick="clearAssetSelection()">Clear</button>
          <button type="button" class="ghost" onclick="bulkFavorite(true)">Favorite</button>
          <button type="button" class="ghost" onclick="bulkFavorite(false)">Unfav</button>
          <button type="button" class="danger" id="bulk-delete-btn" onclick="bulkDeleteSelected()">Delete selected</button>
          <button type="button" class="ghost" id="bulk-restore-btn" onclick="bulkRestoreSelected()" hidden>Restore selected</button>
        </div>
        <div class="asset-grid" id="asset-grid"></div>
        <p class="asset-empty" id="asset-empty" hidden>No images match.</p>
      </div>
    </div>
  </div>
</div>

<div class="asset-lightbox" id="asset-lightbox" hidden onclick="if(event.target===this)closeAssetLightbox()">
  <div class="asset-lightbox-inner" role="dialog" aria-modal="true" aria-label="Image preview">
    <button type="button" class="lb-close" onclick="closeAssetLightbox()" aria-label="Close">✕</button>
    <img id="asset-lightbox-img" src="" alt="">
    <div class="lb-cap" id="asset-lightbox-cap"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let KEY = localStorage.getItem("yolko_admin_key") || "";

const BUNDLE_META = {
  tray1: { eggs: 30, kind: "tray" },
  tray2: { eggs: 60, kind: "tray" },
  box: { eggs: 180, kind: "tray" },
  cage600: { eggs: 12, kind: "dozen", label: "Cage dozen 600g" },
  cage700: { eggs: 12, kind: "dozen", label: "Cage dozen 700g" },
  cage800: { eggs: 12, kind: "dozen", label: "Cage dozen 800g" },
  fr600: { eggs: 12, kind: "dozen", label: "Free range dozen 600g" },
  fr700: { eggs: 12, kind: "dozen", label: "Free range dozen 700g" },
  fr800: { eggs: 12, kind: "dozen", label: "Free range dozen 800g" },
  cage600case: { eggs: 180, kind: "case", label: "Cage case 600g" },
  cage700case: { eggs: 180, kind: "case", label: "Cage case 700g" },
  cage800case: { eggs: 180, kind: "case", label: "Cage case 800g" },
  fr600case: { eggs: 180, kind: "case", label: "Free range case 600g" },
  fr700case: { eggs: 180, kind: "case", label: "Free range case 700g" },
  fr800case: { eggs: 180, kind: "case", label: "Free range case 800g" },
};

function describeOrder(bundle, qty) {
  qty = qty || 1;
  const meta = BUNDLE_META[bundle] || BUNDLE_META.tray1;
  const eggs = (meta.eggs * qty).toLocaleString();
  if (meta.kind === "dozen") {
    return qty === 1 ? meta.label + " (12 eggs)" : qty + "× " + meta.label + " (" + eggs + " eggs)";
  }
  if (meta.kind === "case") {
    return qty === 1 ? meta.label + " (15 dozens)" : qty + "× " + meta.label + " (" + eggs + " eggs)";
  }
  if (bundle === "box") return qty === 1 ? "1 box (180 eggs)" : qty + " boxes (" + eggs + " eggs)";
  const trays = (bundle === "tray2" ? 2 : 1) * qty;
  return trays === 1 ? "1 tray (30 eggs)" : trays + " trays (" + eggs + " eggs)";
}

const WEEK_DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

function timeOptions(selected) {
  let out = "";
  for (let h = 5; h <= 21; h++) {
    for (const m of [0, 30]) {
      const val = String(h).padStart(2, "0") + ":" + (m ? "30" : "00");
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const label = h12 + (m ? ":30 " : ":00 ") + (h >= 12 ? "PM" : "AM");
      out += '<option value="' + val + '"' + (val === selected ? " selected" : "") + ">" + label + "</option>";
    }
  }
  return out;
}

let PICKUP = {};

function renderDays() {
  $("day-chips").innerHTML = WEEK_DAYS.map(function(day) {
    const on = PICKUP[day] && PICKUP[day].enabled;
    return '<button type="button" class="chip' + (on ? " on" : "") + '" data-day="' + day + '">' + day.slice(0,3) + '</button>';
  }).join("");

  const open = WEEK_DAYS.filter(function(d) { return PICKUP[d] && PICKUP[d].enabled; });
  $("day-hours").innerHTML = open.length
    ? open.map(function(day) {
        const p = PICKUP[day];
        return '<div class="hours-row">' +
          '<b>' + day.slice(0,3) + '</b>' +
          '<select data-day="' + day + '" data-k="open">' + timeOptions(p.open) + '</select>' +
          '<span>to</span>' +
          '<select data-day="' + day + '" data-k="close">' + timeOptions(p.close) + '</select>' +
        '</div>';
      }).join("")
    : '<p class="hours-empty">No pickup days open. Tap a day above.</p>';
}

$("day-chips") && document.addEventListener("click", function(e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const day = chip.dataset.day;
  PICKUP[day] = PICKUP[day] || { enabled: false, open: "09:00", close: "14:00" };
  PICKUP[day].enabled = !PICKUP[day].enabled;
  renderDays();
});

document.addEventListener("change", function(e) {
  const sel = e.target.closest("#day-hours select");
  if (!sel) return;
  PICKUP[sel.dataset.day][sel.dataset.k] = sel.value;
});

function collectDayRows() {
  return PICKUP;
}

function traysFor(o) {
  const kind = BUNDLE_META[o.bundle] && BUNDLE_META[o.bundle].kind;
  if (kind === "dozen" || kind === "case") return 0;
  return (o.bundle === "box" ? 6 : o.bundle === "tray2" ? 2 : 1) * (o.quantity || 1);
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 350); }, 3200);
}

function authHeaders() { return { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" }; }

async function saveKey() {
  const input = $("key");
  KEY = (input && input.value ? input.value : "").trim();
  if (!KEY) {
    $("login-msg").textContent = "Paste your admin key first";
    return;
  }
  $("login-msg").textContent = "Checking…";
  let res;
  try {
    res = await fetch("/api/admin/ping", { headers: authHeaders() });
  } catch (e) {
    $("login-msg").textContent = "Network error. Try again";
    return;
  }
  if (res.ok) {
    localStorage.setItem("yolko_admin_key", KEY);
    $("login-msg").textContent = "";
    boot();
  } else if (res.status === 401) {
    $("login-msg").textContent = "Wrong key, try again";
  } else {
    $("login-msg").textContent = "Sign-in failed (" + res.status + ")";
  }
}

function logout() { localStorage.removeItem("yolko_admin_key"); location.reload(); }

function fmtTime(iso) {
  return new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function fmtPhone(p) { return p.replace(/(\\d{4})(\\d{3})(\\d{3})/, "$1 $2 $3"); }

let ALL_ORDERS = [];
let OPEN_ORDER_ID = null;

async function loadOrders() {
  const scrolls = saveLaneScrolls();
  const res = await fetch("/api/orders", { headers: authHeaders() });
  if (!res.ok) return;
  const { orders } = await res.json();

  orders.sort((a, b) => {
    const day = (o) => (o.pickupDate || "") + " " + (o.pickupDay || "");
    const rank = (o) => (o.status === "cancelled" ? 4 : o.status === "done" ? 3 : o.status === "confirmed" ? 1 : 0);
    return rank(a) - rank(b) || day(a).localeCompare(day(b)) || b.createdAt.localeCompare(a.createdAt);
  });
  ALL_ORDERS = orders;

  const active = orders.filter(o => o.status !== "cancelled");
  const revenue = active.filter(o => o.status !== "new").reduce((s, o) => s + (o.price || 0), 0);
  const paidOnline = active.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + (o.price || 0), 0);
  const pending = orders.filter(o => o.status === "new").length;
  $("stats").innerHTML =
    '<div class="stat"><b>' + orders.length + '</b><span>orders</span></div>' +
    '<div class="stat"><b>' + pending + '</b><span>waiting</span></div>' +
    '<div class="stat highlight"><b id="stat-stock">' + (window.TRAYS_LEFT ?? "–") + '</b><span>trays left</span></div>' +
    '<div class="stat"><b>$' + revenue + '</b><span>confirmed</span></div>' +
    '<div class="stat"><b>$' + paidOnline + '</b><span>paid online</span></div>';

  renderOrderBoard();
  restoreLaneScrolls(scrolls);
  renderBuyers(orders);
}

function pickupKey(o) {
  const kind = o.fulfillment === "delivery" ? "delivery" : "pickup";
  return kind + "|" + (o.pickupDay || "TBD") + "|" + (o.pickupDate || "");
}

function pickupLabel(o) {
  const day = o.pickupDate ? (o.pickupDay + " " + o.pickupDate) : (o.pickupDay || "TBD");
  if (o.fulfillment === "delivery") return "🚚 Delivery " + day;
  return day || "Pickup TBD";
}

function isPaid(o) {
  return o.paymentStatus === "paid" && o.status !== "cancelled";
}

function isRefunded(o) {
  return o.paymentStatus === "refunded";
}

function sortPaidFirst(a, b) {
  const ap = isPaid(a) ? 0 : 1;
  const bp = isPaid(b) ? 0 : 1;
  return ap - bp || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

// Queue line numbers per pickup day: paid first, then other confirmed, in booking order.
function assignLineNumbers(allOrders) {
  const byDay = {};
  allOrders.forEach(function(o) {
    if (o.status === "cancelled" || o.status === "done") return;
    if (!isPaid(o) && o.status !== "confirmed") return;
    const k = pickupKey(o);
    (byDay[k] = byDay[k] || []).push(o);
  });
  const lines = {};
  Object.keys(byDay).forEach(function(k) {
    byDay[k].sort(sortPaidFirst);
    byDay[k].forEach(function(o, i) { lines[o.id] = i + 1; });
  });
  return lines;
}

function groupByPickup(list) {
  const map = {};
  list.forEach(function(o) {
    const k = pickupKey(o);
    (map[k] = map[k] || { key: k, label: pickupLabel(o), orders: [], trays: 0, paid: 0 }).orders.push(o);
    map[k].trays += traysFor(o);
    if (isPaid(o)) map[k].paid += 1;
  });
  return Object.keys(map).sort().map(function(k) {
    map[k].orders.sort(sortPaidFirst);
    return map[k];
  });
}

function shortBundle(o) {
  const meta = BUNDLE_META[o.bundle];
  if (meta && meta.kind === "dozen") {
    const n = o.quantity || 1;
    return n + "× " + (meta.label || o.bundle).replace(" dozen", "");
  }
  if (meta && meta.kind === "case") {
    const n = o.quantity || 1;
    return n + "× " + (meta.label || o.bundle) + " (15pk)";
  }
  if (o.bundle === "box") return ((o.quantity || 1) * 6) + "tr box";
  const trays = traysFor(o);
  return trays + (trays === 1 ? " tray" : " trays");
}

function formatDeliveryAddress(o) {
  const parts = [o.deliveryStreet, o.deliverySuburb, o.deliveryCity, o.deliveryPostcode]
    .map(function(p) { return String(p || "").trim(); })
    .filter(Boolean);
  if (parts.length) return parts.join("\\n");
  return String(o.deliveryAddress || "").trim();
}

function orderEmail(o) {
  return (o.stripe && o.stripe.email) ? String(o.stripe.email) : "";
}

function iconSvg(kind) {
  // Hard width/height on the <svg>. CSS alone was letting icons explode to full lane size.
  const base = 'xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="width:18px;height:18px;display:block"';
  if (kind === "receipt") {
    return '<svg ' + base + '><path d="M7 3.5h10v17l-1.8-1.1-1.7 1.1-1.7-1.1-1.7 1.1-1.7-1.1-1.7 1.1-1.7-1.1V3.5z"/><path d="M10 8h6M10 12h6M10 16h3.5"/></svg>';
  }
  // refund. clean return arrow (reads clearly at 18px)
  return '<svg ' + base + '><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>';
}

function contactRow(label, value, href) {
  const val = value
    ? '<div class="sale-v">' + escapeHtml(value) + '</div>'
    : '<div class="sale-v muted">-</div>';
  const inner = '<div class="sale-k">' + escapeHtml(label) + '</div>' + val;
  if (href && value) {
    return '<a class="sale-row" href="' + escapeHtml(href) + '">' + inner + '</a>';
  }
  return '<div class="sale-row">' + inner + '</div>';
}

function saleCardHtml(o) {
  const email = orderEmail(o);
  const phone = o.phone ? fmtPhone(o.phone) : "";
  const isDelivery = o.fulfillment === "delivery";
  const addr = isDelivery
    ? formatDeliveryAddress(o)
    : "Paddy\\'s Markets Flemington";
  const canRefund = o.paymentStatus === "paid" && !isRefunded(o);
  const canReceipt = isPaid(o) || Boolean(o.sessionId);
  const receiptUrl = o.stripe && o.stripe.receiptUrl ? o.stripe.receiptUrl : "";
  const chip = isRefunded(o)
    ? '<span class="sale-chip refunded">Refunded</span>'
    : (isPaid(o)
      ? '<span class="sale-chip">Paid</span>'
      : (o.sessionId ? '<span class="sale-chip" style="background:#eee;color:var(--muted)">Checkout open</span>' : ''));

  let receiptBtn = "";
  // Receipt only when Stripe has actually charged (paid + receipt URL or paid status).
  if (isPaid(o)) {
    if (receiptUrl) {
      receiptBtn = '<a class="icon-btn" href="' + escapeHtml(receiptUrl) + '" target="_blank" rel="noopener" title="Receipt" aria-label="Receipt">' + iconSvg("receipt") + '</a>';
    } else {
      receiptBtn = '<button type="button" class="icon-btn" title="Check Stripe" aria-label="Check Stripe" onclick="openReceipt(\\'' + o.id + '\\')">' + iconSvg("receipt") + '</button>';
    }
  } else if (o.sessionId) {
    receiptBtn = '<button type="button" class="icon-btn" title="Refresh payment status" aria-label="Refresh payment" onclick="hydrateStripeReceipt(\\'' + o.id + '\\')">' + iconSvg("receipt") + '</button>';
  }
  const refundBtn = canRefund
    ? '<button type="button" class="icon-btn danger" title="Refund" aria-label="Refund" onclick="refundOrder(\\'' + o.id + '\\')">' + iconSvg("refund") + '</button>'
    : "";

  return '<div class="sale-card" data-sale-id="' + escapeHtml(o.id) + '">' +
    '<h4 class="sale-name">' + escapeHtml(o.name || "-") + chip + '</h4>' +
    '<div class="sale-contacts">' +
      contactRow("Email", email || (canReceipt ? "…" : ""), email ? ("mailto:" + email) : "") +
      contactRow("Phone", phone, o.phone ? ("tel:" + o.phone) : "") +
      contactRow(isDelivery ? "Address" : "Pickup", addr, "") +
    '</div>' +
    '<div class="sale-tools">' +
      receiptBtn +
      refundBtn +
      '<div class="sale-status">' + statusButtons(o) + '</div>' +
    '</div>' +
  '</div>';
}

function orderRow(o, lineNo) {
  const signals = orderSignals(o, ALL_ORDERS);
  const prio = isPaid(o);
  const open = OPEN_ORDER_ID === o.id;
  const badges =
    (isRefunded(o) ? '<span class="badge-refunded">Refunded</span>' : '') +
    (prio ? '<span class="badge-paid">Paid</span>' : '');
  const place = o.fulfillment === "delivery"
    ? ([o.deliverySuburb, o.deliveryPostcode].filter(Boolean).join(" ") || "delivery")
    : "pickup";

  return '<div class="order st-' + o.status + (prio ? ' prio' : '') + (signals.suspicious ? ' sus' : '') +
    (open ? ' open' : '') + '" data-id="' + escapeHtml(o.id) + '">' +
    '<div class="o-main">' +
      '<div class="o-name-row">' + badges + '<div class="o-name">' + escapeHtml(o.name) + '</div></div>' +
      '<div class="o-sub">' + shortBundle(o) + ' · ' + escapeHtml(place) + '</div>' +
    '</div>' +
    '<div class="o-right"><span class="o-price">$' + o.price + '</span></div>' +
    '<div class="o-detail" onclick="event.stopPropagation()">' +
      saleCardHtml(o) +
    '</div>' +
  '</div>';
}

function laneHtml(title, cls, list, lineMap) {
  const groups = groupByPickup(list);
  const trays = list.reduce(function(s, o) { return s + traysFor(o); }, 0);
  const paidN = list.filter(isPaid).length;
  const body = groups.length
    ? groups.map(function(g) {
        const paidLabel = g.paid ? (g.paid + ' paid · ') : '';
        return '<div class="day-group">' +
          '<div class="day-head"><b>' + escapeHtml(g.label) + '</b><span>' + paidLabel + g.trays + (g.trays === 1 ? ' tray' : ' trays') + ' · ' + g.orders.length + '</span></div>' +
          g.orders.map(function(o) { return orderRow(o, lineMap[o.id]); }).join('') +
        '</div>';
      }).join('')
    : '<p class="lane-empty">Nothing here.</p>';
  const headMeta = list.length + ' · ' + trays + ' trays' + (paidN ? ' · ' + paidN + ' paid' : '');
  return '<section class="lane ' + cls + '">' +
    '<div class="lane-head"><h3>' + title + '</h3><span>' + headMeta + '</span></div>' +
    '<div class="lane-body">' + body + '</div></section>';
}

function renderOrderBoard() {
  const lineMap = assignLineNumbers(ALL_ORDERS);
  const waiting = ALL_ORDERS.filter(o => o.status === "new").sort(sortPaidFirst);
  const confirmed = ALL_ORDERS.filter(o => o.status === "confirmed").sort(sortPaidFirst);
  const archived = ALL_ORDERS.filter(o => o.status === "done" || o.status === "cancelled");
  const archiveWasOpen = !!(document.querySelector("#orders-archive details.archive") && document.querySelector("#orders-archive details.archive").open);
  const openIsArchived = !!(OPEN_ORDER_ID && archived.some(function(o) { return o.id === OPEN_ORDER_ID; }));

  $("orders").innerHTML = laneHtml("Waiting", "waiting", waiting, lineMap) + laneHtml("Confirmed", "confirmed", confirmed, lineMap);
  $("empty").style.display = (waiting.length || confirmed.length) ? "none" : "block";

  if (archived.length) {
    $("orders-archive").innerHTML =
      '<details class="archive"' + (archiveWasOpen || openIsArchived ? " open" : "") + '><summary>Done &amp; cancelled · ' + archived.length + '</summary>' +
      laneHtml("Archive", "archive-lane", archived, {}) + '</details>';
  } else {
    $("orders-archive").innerHTML = "";
  }
}

function saveLaneScrolls() {
  const out = {};
  document.querySelectorAll(".lane-body").forEach(function(el, i) { out[i] = el.scrollTop; });
  return out;
}

function restoreLaneScrolls(map) {
  if (!map) return;
  document.querySelectorAll(".lane-body").forEach(function(el, i) {
    if (typeof map[i] === "number") el.scrollTop = map[i];
  });
}

function renderOrderBoardPreservingScroll() {
  const scrolls = saveLaneScrolls();
  renderOrderBoard();
  restoreLaneScrolls(scrolls);
}

document.addEventListener("click", function(e) {
  const row = e.target.closest("#orders .order, #orders-archive .order");
  if (!row) return;
  if (e.target.closest(".o-detail")) return;
  // Capture-phase + stopPropagation so <details class="archive"> does not toggle.
  e.preventDefault();
  e.stopPropagation();
  const id = row.dataset.id;
  const closing = OPEN_ORDER_ID === id;
  document.querySelectorAll(".order.open").forEach(function(el) { el.classList.remove("open"); });
  OPEN_ORDER_ID = closing ? null : id;
  const archive = row.closest("details.archive");
  if (archive) archive.open = true;
  if (!closing) {
    row.classList.add("open");
    hydrateStripeReceipt(id);
  }
}, true);

async function fetchStripeDetails(orderId) {
  const order = ALL_ORDERS.find(function(o) { return o.id === orderId; });
  if (!order || (!isPaid(order) && !order.sessionId)) return null;
  if (order.stripe && order.stripe.receiptUrl && order.stripe.email && isPaid(order)) return order.stripe;
  try {
    const res = await fetch("/api/stripe-receipt?id=" + encodeURIComponent(orderId), { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok || !data.stripe) return null;
    order.stripe = data.stripe;
    // Trust Stripe payment_status from the API. Never mark paid just because stripe{} exists.
    if (data.paid === true || data.paymentStatus === "paid") {
      order.paymentStatus = "paid";
      if (order.status === "new") order.status = "confirmed";
    } else if (data.paymentStatus) {
      order.paymentStatus = data.paymentStatus;
    }
    return data.stripe;
  } catch (err) {
    return null;
  }
}

function refreshSaleCard(orderId) {
  const order = ALL_ORDERS.find(function(o) { return o.id === orderId; });
  const card = document.querySelector('.sale-card[data-sale-id="' + CSS.escape(orderId) + '"]');
  if (!order || !card) return;
  card.outerHTML = saleCardHtml(order);
}

async function hydrateStripeReceipt(orderId) {
  const beforePaid = (() => {
    const o = ALL_ORDERS.find((x) => x.id === orderId);
    return o ? isPaid(o) : false;
  })();
  const stripe = await fetchStripeDetails(orderId);
  if (!stripe) return;
  refreshSaleCard(orderId);
  const afterPaid = (() => {
    const o = ALL_ORDERS.find((x) => x.id === orderId);
    return o ? isPaid(o) : false;
  })();
  // Re-draw board when payment badge should change.
  if (beforePaid !== afterPaid) renderOrderBoardPreservingScroll();
}

async function openReceipt(orderId) {
  const order = ALL_ORDERS.find(function(o) { return o.id === orderId; });
  if (!order) return;
  let url = order.stripe && order.stripe.receiptUrl;
  if (!url) {
    toast("Opening receipt…");
    const stripe = await fetchStripeDetails(orderId);
    url = stripe && stripe.receiptUrl;
    refreshSaleCard(orderId);
  }
  if (!url) {
    toast("Receipt not ready yet");
    return;
  }
  window.open(url, "_blank", "noopener");
}

const TEST_PHONES = { "0412345678": 1, "0498765432": 1 };
const HOSTING_RE = /amazon|aws|google\s*(cloud|llc)|microsoft|azure|digitalocean|ovh|hetzner|linode|vultr|hosting|datacenter|data centre|\bvps\b|colocation|dedicated server/i;

function orderSignals(o, orders) {
  const tags = [];
  let suspicious = false;
  if (o.country && o.country !== "AU") {
    tags.push({ cls: "warn", text: o.country + " IP" });
    suspicious = true;
  }
  if (TEST_PHONES[o.phone]) {
    tags.push({ cls: "warn", text: "test phone?" });
    suspicious = true;
  }
  if (o.asnOrg && HOSTING_RE.test(o.asnOrg)) {
    tags.push({ cls: "warn", text: "datacenter IP" });
    suspicious = true;
  }
  if (o.ip) {
    const same = orders.filter(function(x) {
      return x.ip === o.ip && x.id !== o.id && x.status !== "cancelled";
    }).length;
    if (same > 0) {
      tags.push({ cls: "warn", text: same + " more same IP" });
      suspicious = true;
    }
  }
  const metaParts = [];
  if (o.country) metaParts.push(o.country);
  if (o.ip) metaParts.push(o.ip);
  if (o.asnOrg) metaParts.push(o.asnOrg);
  return { tags: tags, suspicious: suspicious, metaLine: metaParts.join(" · ") };
}

function daysAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
}

function sparkline(history, maxV) {
  // history: [{t, v}] sorted by time; renders an SVG line of purchases
  const W = 100, H = 34, PAD = 5;
  if (!history.length) return "";
  const t0 = history[0].t, t1 = history[history.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const pts = history.map(function(p) {
    const x = history.length === 1 ? W / 2 : PAD + ((p.t - t0) / span) * (W - PAD * 2);
    const y = H - PAD - (p.v / maxV) * (H - PAD * 2);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  const line = pts.map(function(p) { return p[0] + "," + p[1]; }).join(" ");
  const area = "M" + pts[0][0] + "," + (H - 2) + " L" + pts.map(function(p) { return p[0] + "," + p[1]; }).join(" L") + " L" + pts[pts.length - 1][0] + "," + (H - 2) + " Z";
  const dots = pts.map(function(p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.4" fill="#f6532f"/>'; }).join("");
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="' + area + '" fill="rgba(255,211,42,.35)"/>' +
    (pts.length > 1 ? '<polyline points="' + line + '" fill="none" stroke="#f6532f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '') +
    dots + '</svg>';
}

function renderBuyers(orders) {
  const active = orders.filter(function(o) { return o.status !== "cancelled"; });
  const map = {};
  active.forEach(function(o) {
    const b = map[o.phone] = map[o.phone] || { name: o.name, phone: o.phone, orders: 0, trays: 0, spend: 0, paid: 0, history: [], bundles: {}, days: {} };
    b.orders++;
    b.trays += traysFor(o);
    b.spend += o.price || 0;
    if (o.paymentStatus === "paid") b.paid++;
    b.history.push({ t: new Date(o.createdAt).getTime(), v: o.price || 0 });
    b.bundles[o.bundle] = (b.bundles[o.bundle] || 0) + 1;
    b.days[o.pickupDay] = (b.days[o.pickupDay] || 0) + 1;
  });

  const buyers = Object.values(map).sort(function(a, b) { return b.spend - a.spend; });
  const repeat = buyers.filter(function(b) { return b.orders > 1; }).length;
  $("buyer-sum").textContent = buyers.length
    ? buyers.length + (buyers.length === 1 ? " buyer" : " buyers") + " · " + repeat + " repeat"
    : "";

  if (!buyers.length) {
    $("buyers").innerHTML = '<p class="empty">No buyers yet. They appear with their first order.</p>';
    return;
  }

  const BUNDLE_WORD = { tray1: "single trays", tray2: "2-tray packs", box: "full boxes", cage600: "cage 600g", cage700: "cage 700g", cage800: "cage 800g", fr600: "FR 600g", fr700: "FR 700g", fr800: "FR 800g", cage600case: "cage cases", cage700case: "cage cases", cage800case: "cage cases", fr600case: "FR cases", fr700case: "FR cases", fr800case: "FR cases" };

  $("buyers").innerHTML = buyers.map(function(b, i) {
    b.history.sort(function(x, y) { return x.t - y.t; });
    const maxOrderV = Math.max.apply(null, b.history.map(function(p) { return p.v; })) || 1;
    const newest = b.history[b.history.length - 1].t;
    const daysSince = Math.max(0, Math.floor((Date.now() - newest) / 86400000));

    const favBundle = Object.keys(b.bundles).sort(function(x, y) { return b.bundles[y] - b.bundles[x]; })[0];
    const favDay = Object.keys(b.days).sort(function(x, y) { return b.days[y] - b.days[x]; })[0];

    let badges = "";
    if (i === 0 && buyers.length > 1) badges += '<span class="bb gold">top</span>';
    if (b.orders >= 3) badges += '<span class="bb green">regular</span>';
    if (b.paid === b.orders && b.orders > 0) badges += '<span class="bb green">prepays</span>';
    if (b.orders === 1 && daysSince <= 10) badges += '<span class="bb blue">new</span>';

    let insight = "", insightClass = "soft";
    if (b.orders > 1) {
      const spanDays = (newest - b.history[0].t) / 86400000;
      const gap = Math.max(1, Math.round(spanDays / (b.orders - 1)));
      const ratio = daysSince / gap;
      if (ratio >= 1.4) { insight = "Overdue " + (daysSince - gap) + "d. Worth a WhatsApp"; insightClass = "warn"; }
      else if (ratio >= 0.75) { insight = "Due about now, every ~" + gap + " days"; insightClass = "due"; }
      else { const next = Math.max(1, gap - daysSince); insight = "Next likely in ~" + next + (next === 1 ? " day" : " days"); insightClass = "good"; }
    } else if (daysSince <= 10) { insight = "New. Follow up to keep them"; insightClass = "due"; }
    else { insight = "Quiet " + daysSince + "d. Send a comeback"; insightClass = "soft"; }

    return '<div class="buyer-card">' +
      '<div class="bc-top">' +
        '<span class="b-rank' + (i === 0 ? " top" : "") + '">' + (i + 1) + '</span>' +
        '<div class="bc-name"><b>' + escapeHtml(b.name) + '</b><div>' + badges + '</div></div>' +
        '<span class="b-spend">$' + b.spend + '</span>' +
      '</div>' +
      sparkline(b.history, maxOrderV) +
      '<div class="bc-grid">' +
        '<div><b>' + b.orders + '</b><span>' + (b.orders === 1 ? "order" : "orders") + '</span></div>' +
        '<div><b>' + b.trays + '</b><span>' + (b.trays === 1 ? "tray" : "trays") + '</span></div>' +
        '<div><b>' + favDay.slice(0, 3) + '</b><span>usual day</span></div>' +
        '<div><b>' + (BUNDLE_WORD[favBundle] || favBundle).split(" ")[0].replace("single", "trays").replace("2-tray", "2-packs") + '</b><span>usually</span></div>' +
      '</div>' +
      '<div class="bc-foot">' +
        '<span class="b-insight ' + insightClass + '">' + insight + '</span>' +
        '<a class="bc-call" href="tel:' + b.phone + '" title="' + fmtPhone(b.phone) + '">Call</a>' +
      '</div>' +
    '</div>';
  }).join("");
}

function statusButtons(o) {
  const btn = (status, label, cls) => '<button class="' + cls + '" onclick="setStatus(\\'' + o.id + '\\',\\'' + status + '\\')">' + label + '</button>';
  if (o.status === "new") return btn("confirmed", "Confirm", "") + btn("cancelled", "Cancel", "ghost");
  if (o.status === "confirmed") return btn("done", "Done", "") + btn("cancelled", "Cancel", "ghost");
  if (o.status === "done") return btn("confirmed", "Undo", "ghost");
  return btn("new", "Reopen", "ghost");
}

async function refundOrder(id) {
  const order = ALL_ORDERS.find(function(o) { return o.id === id; });
  if (!order) return;
  const who = order.name || "customer";
  const amt = order.stripe && order.stripe.amountTotal != null ? order.stripe.amountTotal : order.price;
  const email = (order.stripe && order.stripe.email) ? (" (" + order.stripe.email + ")") : "";
  if (!confirm("Refund $" + amt + " to " + who + "?")) return;
  toast("Refunding via Stripe…");
  try {
    const res = await fetch("/api/refund", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id }),
    });
    const d = await res.json().catch(function() { return {}; });
    if (!res.ok) {
      toast(d.error || "Refund failed");
      return;
    }
    if (typeof d.traysAvailable === "number") {
      window.TRAYS_LEFT = d.traysAvailable;
      $("stock").value = d.traysAvailable;
      const stat = $("stat-stock");
      if (stat) stat.textContent = d.traysAvailable;
    }
    const back = d.amount != null ? ("$" + d.amount) : ("$" + amt);
    toast(d.already ? ("Already refunded · " + back) : ("Refunded " + back + " to " + who));
    await loadOrders();
  } catch (err) {
    toast("Refund failed");
  }
}

async function setStatus(id, status) {
  const res = await fetch("/api/order-status", { method: "POST", headers: authHeaders(), body: JSON.stringify({ id, status }) });
  if (res.ok) {
    const d = await res.json();
    if (typeof d.traysAvailable === "number") {
      window.TRAYS_LEFT = d.traysAvailable;
      $("stock").value = d.traysAvailable;
      const stat = $("stat-stock");
      if (stat) stat.textContent = d.traysAvailable;
      if (d.stockDelta < 0) toast(d.trays + (d.trays === 1 ? " tray" : " trays") + " allocated · " + d.traysAvailable + " left");
      if (d.stockDelta > 0) toast(d.stockDelta + (d.stockDelta === 1 ? " tray" : " trays") + " returned · " + d.traysAvailable + " left");
    }
  }
  await loadOrders();
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const s = await res.json();
  $("p1").value = s.prices.tray1;
  $("p2").value = s.prices.tray2;
  $("p3").value = s.prices.box;
  DOZEN_KEYS.forEach(function(k) {
    const el = $("p-" + k);
    if (el && s.prices[k] != null) el.value = s.prices[k];
    const cel = $("p-" + k + "case");
    if (cel) cel.value = s.prices[k + "case"] != null ? s.prices[k + "case"] : Math.round(Number(s.prices[k] || 0) * DOZENS_IN_CASE);
    const costEl = $("c-" + k);
    const cost = s.dozenCosts && s.dozenCosts[k] != null ? s.dozenCosts[k] : (DOZEN_COST_DEFAULTS[k] || 75);
    if (costEl) costEl.value = cost;
  });
  $("stock").value = s.traysAvailable;
  window.TRAYS_LEFT = s.traysAvailable;
  const stat = $("stat-stock");
  if (stat) stat.textContent = s.traysAvailable;
  $("tray-weight").value = s.trayWeight || "1.75";
  if (s.boxCost != null && $("box-cost")) $("box-cost").value = s.boxCost;
  if ($("dozen-stock")) $("dozen-stock").value = s.dozensAvailable != null ? s.dozensAvailable : 0;
  PICKUP = s.pickup || {};
  renderDays();
  updatePriceHint();
  renderDozenCostTable();
}

// Trays: 12 : 23 : 66 from $55 box cost. Dozens: each SKU has its own case cost.
const PRICE_RATIO = { tray1: 12, tray2: 23, box: 66 };
const DOZEN_KEYS = ["cage600", "cage700", "cage800", "fr600", "fr700", "fr800"];
const DOZEN_LABELS = {
  cage600: "Cage 600g", cage700: "Cage 700g", cage800: "Cage 800g",
  fr600: "Free range 600g", fr700: "Free range 700g", fr800: "Free range 800g",
};
const DOZEN_COST_DEFAULTS = {
  cage600: 75, cage700: 75, cage800: 75,
  fr600: 90, fr700: 90, fr800: 90,
};
const BASE_BOX_COST = 55;
const DOZENS_IN_CASE = 15;
let SYNCING_PRICES = false;

function roundMoney(n) {
  return Math.max(1, Math.round(Number(n)));
}

function money(n) {
  if (!Number.isFinite(n)) return "–";
  const r = Math.round(n * 100) / 100;
  return "$" + (r % 1 ? r.toFixed(2) : String(r));
}

/** Suggested sell for one dozen from that product's case cost only. */
function suggestDozenSell(caseCost) {
  const per = Number(caseCost) / DOZENS_IN_CASE;
  if (!Number.isFinite(per) || per < 0) return 1;
  return Math.max(1, Math.round(per + 1));
}

function pricesFromTrayAnchor(which, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || !PRICE_RATIO[which]) return null;
  const scale = v / PRICE_RATIO[which];
  return applyTrayExceptions({
    tray1: roundMoney(PRICE_RATIO.tray1 * scale),
    tray2: roundMoney(PRICE_RATIO.tray2 * scale),
    box: roundMoney(PRICE_RATIO.box * scale),
  });
}

function pricesFromBoxCost(cost) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c < 0) return null;
  const scale = c / BASE_BOX_COST;
  return applyTrayExceptions({
    tray1: roundMoney(PRICE_RATIO.tray1 * scale),
    tray2: roundMoney(PRICE_RATIO.tray2 * scale),
    box: roundMoney(PRICE_RATIO.box * scale),
  });
}

/** When single tray is $13, full box is $72. */
function applyTrayExceptions(prices) {
  if (!prices) return prices;
  if (Number(prices.tray1) === 13) {
    return Object.assign({}, prices, { box: 72 });
  }
  return prices;
}

function applyTrayPrices(next) {
  if (!next) return;
  SYNCING_PRICES = true;
  $("p1").value = next.tray1;
  $("p2").value = next.tray2;
  $("p3").value = next.box;
  SYNCING_PRICES = false;
  updatePriceHint();
}

function updatePriceHint() {
  const el = $("price-hint");
  if (!el) return;
  const p1 = +$("p1").value, p2 = +$("p2").value, p3 = +$("p3").value;
  const cost = +(($("box-cost") && $("box-cost").value) || BASE_BOX_COST);
  const c1 = cost / 6;
  if (!(p1 > 0)) {
    el.textContent = "";
    return;
  }
  el.innerHTML =
    "Profit after box cost: 1 tray <b>" + money(p1 - c1) + "</b> · 2 trays <b>" +
    money(p2 - c1 * 2) + "</b> · box <b>" + money(p3 - cost) + "</b>";
}

function syncHiddenDozenFields(key) {
  const sell = +(($("p-" + key) && $("p-" + key).value) || 0);
  const caseEl = $("p-" + key + "case");
  if (caseEl && sell > 0) caseEl.value = String(Math.round(sell * DOZENS_IN_CASE));
}

function updateDozenRow(key) {
  const cost = +(($("c-" + key) && $("c-" + key).value) || 0);
  const sell = +(($("p-" + key) && $("p-" + key).value) || 0);
  const per = cost / DOZENS_IN_CASE;
  const profitEl = $("profit-" + key);
  if (profitEl) {
    const profit = sell - per;
    profitEl.textContent = (profit >= 0 ? "+" : "") + money(profit);
    profitEl.style.color = profit >= 0 ? "var(--green)" : "#b42318";
    profitEl.title = "Cost " + money(per) + " each";
  }
  syncHiddenDozenFields(key);
  updateDozenHint();
}

function onDozenCostInput(key) {
  if (SYNCING_PRICES) return;
  const cost = +(($("c-" + key) && $("c-" + key).value) || 0);
  const suggested = suggestDozenSell(cost);
  SYNCING_PRICES = true;
  if ($("p-" + key)) $("p-" + key).value = String(suggested);
  const sellInput = document.querySelector('input[data-dozen-sell="' + key + '"]');
  if (sellInput) sellInput.value = String(suggested);
  SYNCING_PRICES = false;
  updateDozenRow(key);
}

function onDozenSellInput(key, value) {
  if (SYNCING_PRICES) return;
  const sell = Math.max(1, Math.round(Number(value) || 0));
  if ($("p-" + key)) $("p-" + key).value = String(sell);
  updateDozenRow(key);
}

function renderDozenCostTable() {
  const list = $("dozen-list");
  if (!list) return;
  list.innerHTML = DOZEN_KEYS.map(function(key) {
    const cost = +(($("c-" + key) && $("c-" + key).value) || DOZEN_COST_DEFAULTS[key] || 75);
    const sell = +(($("p-" + key) && $("p-" + key).value) || suggestDozenSell(cost));
    if ($("c-" + key)) $("c-" + key).value = cost;
    if ($("p-" + key)) $("p-" + key).value = sell;
    syncHiddenDozenFields(key);
    const per = cost / DOZENS_IN_CASE;
    const profit = sell - per;
    return (
      '<div class="dozen-row" data-dozen-row="' + key + '">' +
        '<div class="d-name">' + DOZEN_LABELS[key] + '</div>' +
        '<div><label>Case cost</label><input data-dozen-cost="' + key + '" type="number" min="0" step="1" value="' + cost + '"></div>' +
        '<div><label>Sell each</label><input data-dozen-sell="' + key + '" type="number" min="1" step="1" value="' + sell + '"></div>' +
        '<div class="d-profit" id="profit-' + key + '" title="Cost ' + money(per) + ' each" style="color:' +
          (profit >= 0 ? "var(--green)" : "#b42318") + '">' +
          (profit >= 0 ? "+" : "") + money(profit) +
        '</div>' +
      '</div>'
    );
  }).join("");

  list.querySelectorAll("[data-dozen-cost]").forEach(function(input) {
    const key = input.getAttribute("data-dozen-cost");
    input.addEventListener("input", function() {
      if ($("c-" + key)) $("c-" + key).value = input.value;
      onDozenCostInput(key);
    });
  });
  list.querySelectorAll("[data-dozen-sell]").forEach(function(input) {
    const key = input.getAttribute("data-dozen-sell");
    input.addEventListener("input", function() {
      onDozenSellInput(key, input.value);
    });
  });
  updateDozenHint();
}

function updateDozenHint() {
  const el = $("dozen-hint");
  if (!el) return;
  const stock = +(($("dozen-stock") && $("dozen-stock").value) || 0);
  el.innerHTML = stock > 0
    ? '<b style="color:var(--green)">On the website · ' + stock + ' packs left</b>'
    : '<b style="color:var(--muted)">Hidden on website · set dozen stock above 0 to show</b>';
}

function onTrayPriceInput(which) {
  if (SYNCING_PRICES) return;
  const val = which === "tray1" ? $("p1").value : which === "tray2" ? $("p2").value : $("p3").value;
  applyTrayPrices(pricesFromTrayAnchor(which, val));
}

$("p1") && $("p1").addEventListener("input", function() { onTrayPriceInput("tray1"); });
$("p2") && $("p2").addEventListener("input", function() { onTrayPriceInput("tray2"); });
$("p3") && $("p3").addEventListener("input", function() { onTrayPriceInput("box"); });
$("box-cost") && $("box-cost").addEventListener("input", function() {
  if (SYNCING_PRICES) return;
  applyTrayPrices(pricesFromBoxCost($("box-cost").value));
});
$("dozen-stock") && $("dozen-stock").addEventListener("input", updateDozenHint);

async function saveSettings() {
  const dozenCosts = {};
  DOZEN_KEYS.forEach(function(k) {
    dozenCosts[k] = +(($("c-" + k) && $("c-" + k).value) || 0);
    syncHiddenDozenFields(k);
  });
  const body = {
    prices: {
      tray1: +$("p1").value, tray2: +$("p2").value, box: +$("p3").value,
      cage600: +$("p-cage600").value, cage700: +$("p-cage700").value, cage800: +$("p-cage800").value,
      fr600: +$("p-fr600").value, fr700: +$("p-fr700").value, fr800: +$("p-fr800").value,
      cage600case: +$("p-cage600case").value, cage700case: +$("p-cage700case").value, cage800case: +$("p-cage800case").value,
      fr600case: +$("p-fr600case").value, fr700case: +$("p-fr700case").value, fr800case: +$("p-fr800case").value,
    },
    traysAvailable: +$("stock").value,
    trayWeight: $("tray-weight").value,
    boxCost: +(($("box-cost") && $("box-cost").value) || BASE_BOX_COST),
    dozenCosts: dozenCosts,
    dozensAvailable: +(($("dozen-stock") && $("dozen-stock").value) || 0),
    pickup: collectDayRows(),
  };
  const res = await fetch("/api/settings", { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  const el = $("save-msg");
  el.textContent = res.ok ? "Saved, live now" : "Failed";
  el.className = "msg " + (res.ok ? "ok" : "err");
  setTimeout(() => { el.textContent = ""; }, 2500);
}

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
function qid(id) {
  // Safe single-quoted JS string for inline onclick handlers (avoids template-literal \\' bugs).
  return "'" + String(id).replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'") + "'";
}


let ASSET_LIB = null;
let ASSET_SELECTED = {};
let ASSET_VISIBLE_IDS = [];

function showAdminView(name) {
  const view = name === "assets" ? "assets"
    : name === "visits" ? "visits"
    : name === "prices" ? "prices"
    : "shop";
  $("view-shop").hidden = view !== "shop";
  $("view-assets").hidden = view !== "assets";
  $("view-visits").hidden = view !== "visits";
  $("view-prices").hidden = view !== "prices";
  $("tab-shop").classList.toggle("on", view === "shop");
  $("tab-assets").classList.toggle("on", view === "assets");
  $("tab-visits").classList.toggle("on", view === "visits");
  $("tab-prices").classList.toggle("on", view === "prices");
  if (view === "assets") loadAssets();
  if (view === "visits") loadVisits(window.VISIT_FILTER || "flyer");
  if (view === "prices") loadPriceWatch();
  try {
    const hash = view === "shop" ? "/admin"
      : view === "assets" ? "/admin#assets"
      : view === "visits" ? "/admin#visits"
      : "/admin#prices";
    history.replaceState(null, "", hash);
  } catch (e) {}
}

function pwMoney(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) return "-";
  return "$" + Number(n).toFixed(2);
}
function pwPerEgg(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) return "-";
  return (Number(n) * 100).toFixed(1) + "¢";
}
function pwStockPill(stock) {
  const s = String(stock || "unknown");
  return '<span class="pw-pill ' + escapeHtml(s) + '">' + escapeHtml(s.replace(/_/g, " ")) + '</span>';
}
function renderPriceTable(rows) {
  if (!rows.length) return '<p class="empty" style="display:block;padding:12px 0">None found in latest snapshot.</p>';
  const sorted = rows.slice().sort(function(a, b) {
    const ap = a.per_egg_aud == null ? 999 : a.per_egg_aud;
    const bp = b.per_egg_aud == null ? 999 : b.per_egg_aud;
    return ap - bp;
  });
  return '<table class="pw-table"><thead><tr>' +
    '<th>Retailer</th><th>Price</th><th>Per egg</th><th>Pack</th><th>Stock</th><th>Link</th>' +
    '</tr></thead><tbody>' +
    sorted.map(function(o) {
      const pack = (o.pack_eggs || "?") + " · " + (o.pack_weight_g ? (o.pack_weight_g + "g") : "?");
      return '<tr>' +
        '<td><b>' + escapeHtml(o.retailer || "") + '</b><div style="color:var(--muted);font-size:12px;margin-top:2px">' + escapeHtml(o.title || "") + '</div></td>' +
        '<td class="num">' + pwMoney(o.price_aud) + '</td>' +
        '<td class="num">' + pwPerEgg(o.per_egg_aud) + '</td>' +
        '<td>' + escapeHtml(pack) + '</td>' +
        '<td>' + pwStockPill(o.stock) + '</td>' +
        '<td>' + (o.url ? ('<a href="' + escapeHtml(o.url) + '" target="_blank" rel="noopener">Open</a>') : "-") + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table>';
}

async function loadPriceWatch() {
  const empty = $("pw-empty");
  try {
    const [snapRes, evRes] = await Promise.all([
      fetch("/api/price-watch"),
      fetch("/api/price-watch/events?limit=30", { headers: authHeaders() }),
    ]);
    if (!snapRes.ok) {
      $("pw-700").innerHTML = "";
      $("pw-30").innerHTML = "";
      $("pw-stats").innerHTML = "";
      $("pw-meta").textContent = "Could not load price watch (" + snapRes.status + ")";
      empty.style.display = "block";
      return;
    }
    const data = await snapRes.json();
    const offers = data.offers || [];
    const c700 = offers.filter(function(o) { return o.category === "caged_700g"; });
    const c30 = offers.filter(function(o) { return o.category === "caged_30pack"; });
    const s = data.summary || {};
    const cheap700 = s.cheapest_700g_in_stock;
    const cheap30 = s.cheapest_30pack_in_stock;
    $("pw-stats").innerHTML =
      '<div class="stat"><b>' + (cheap700 ? pwPerEgg(cheap700.per_egg_aud) : "-") + '</b><span>cheapest 700g / egg</span></div>' +
      '<div class="stat"><b>' + (cheap30 ? pwPerEgg(cheap30.per_egg_aud) : "-") + '</b><span>cheapest 30pk / egg</span></div>' +
      '<div class="stat"><b>' + offers.length + '</b><span>tracked SKUs</span></div>';
    $("pw-meta").textContent = data.updatedAt
      ? ("Updated " + fmtTime(data.updatedAt) + (data.source ? (" · source " + data.source) : ""))
      : "No snapshot yet";
    $("pw-700").innerHTML = renderPriceTable(c700);
    $("pw-30").innerHTML = renderPriceTable(c30);

    let events = [];
    if (evRes.ok) {
      const evData = await evRes.json();
      events = evData.events || [];
    }
    if (!events.length && Array.isArray(data.last_changes)) events = data.last_changes;
    $("pw-events").innerHTML = events.length ? events.map(function(ch) {
      const delta = ch.delta_aud != null ? (" · Δ " + (ch.delta_aud > 0 ? "+" : "") + pwMoney(ch.delta_aud)) : "";
      const fromP = ch.from ? pwMoney(ch.from.price_aud) + " / " + escapeHtml(ch.from.stock || "?") : "-";
      const toP = ch.to ? pwMoney(ch.to.price_aud) + " / " + escapeHtml(ch.to.stock || "?") : "-";
      return '<div class="pw-event">' +
        '<b>' + escapeHtml(ch.type || "change") + '</b> · ' + escapeHtml(ch.retailer || "") +
        '<div style="margin-top:4px">' + escapeHtml(ch.title || "") + delta + '</div>' +
        '<div style="margin-top:4px;color:var(--muted)">' + fromP + ' → ' + toP +
        (ch.at ? (' · ' + fmtTime(ch.at)) : '') + '</div>' +
      '</div>';
    }).join("") : '<p class="empty" style="display:block;padding:8px 0">No changes recorded yet.</p>';

    empty.style.display = offers.length ? "none" : "block";
  } catch (e) {
    $("pw-meta").textContent = "Load failed";
    empty.style.display = "block";
  }
}

async function pollPriceWatchNow() {
  const el = $("pw-msg");
  el.textContent = "Checking…";
  el.className = "msg";
  try {
    const res = await fetch("/api/price-watch/poll", { method: "POST", headers: authHeaders() });
    const data = await res.json().catch(function() { return {}; });
    if (!res.ok) {
      el.textContent = data.error || "Poll failed";
      el.className = "msg err";
      return;
    }
    el.textContent = "Done · " + (data.changeCount || 0) + " change(s)";
    el.className = "msg ok";
    await loadPriceWatch();
    setTimeout(function() { el.textContent = ""; }, 3000);
  } catch (e) {
    el.textContent = "Poll failed";
    el.className = "msg err";
  }
}

async function loadVisits(filter) {
  if (typeof filter === "string") window.VISIT_FILTER = filter;
  const src = window.VISIT_FILTER || "flyer";
  const qs = src ? ("?src=" + encodeURIComponent(src)) : "";
  const res = await fetch("/api/visits" + qs, { headers: authHeaders() });
  if (!res.ok) {
    $("visits").innerHTML = '<p class="empty">Could not load visits</p>';
    return;
  }
  const data = await res.json();
  const s = data.summary || {};
  $("visit-stats").innerHTML =
    '<div class="stat"><b>' + (s.total || 0) + '</b><span>scans</span></div>' +
    '<div class="stat"><b>' + (s.uniqueVisitors || 0) + '</b><span>unique</span></div>' +
    '<div class="stat"><b>' + Object.keys(s.byCity || {}).length + '</b><span>cities</span></div>';
  if (data.note) $("visit-note").textContent = data.note;

  const visits = data.visits || [];
  $("visits-empty").style.display = visits.length ? "none" : "block";
  $("visits").innerHTML = visits.map(function(v) {
    const loc = [v.city, v.region, v.country].filter(Boolean).join(", ") || "-";
    const screen = (v.screen && v.screen.w) ? (v.screen.w + "×" + v.screen.h + (v.screen.dpr ? " @" + v.screen.dpr + "x" : "")) : "-";
    const utm = v.utm ? [v.utm.source, v.utm.medium, v.utm.campaign].filter(Boolean).join(" / ") : "-";
    return '<div class="visit-card">' +
      '<div class="v-top"><span class="v-src">' + escapeHtml(v.src || "direct") + '</span><span class="v-time">' + fmtTime(v.createdAt) + '</span></div>' +
      '<div class="v-grid">' +
        '<div><b>Location</b>' + escapeHtml(loc) + '</div>' +
        '<div><b>IP</b>' + escapeHtml(v.ip || "-") + '</div>' +
        '<div><b>Device</b>' + escapeHtml((v.deviceType || "?") + " · " + (v.os || "?") + " · " + (v.browser || "?")) + '</div>' +
        '<div><b>Visitor id</b><span style="word-break:break-all">' + escapeHtml(v.visitorId || "-") + '</span></div>' +
        '<div><b>Language</b>' + escapeHtml(v.language || "-") + '</div>' +
        '<div><b>Timezone</b>' + escapeHtml(v.tz || v.timezone || "-") + '</div>' +
        '<div><b>Screen</b>' + escapeHtml(screen) + '</div>' +
        '<div><b>Network</b>' + escapeHtml(v.connection || v.asnOrg || "-") + '</div>' +
        '<div><b>UTM</b>' + escapeHtml(utm) + '</div>' +
        '<div><b>Path</b>' + escapeHtml(v.path || "/") + '</div>' +
        '<div><b>Gender</b>not available from browser</div>' +
        '<div><b>Name</b>only after they order</div>' +
        '<div><b>Hardware device id</b>not available from browser</div>' +
        '<div><b>Platform</b>' + escapeHtml(v.platform || "-") + '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}


async function loadAssets() {
  const res = await fetch("/api/admin/assets", { headers: authHeaders() });
  if (!res.ok) {
    $("publish-status").textContent = "Could not load assets";
    return;
  }
  ASSET_LIB = await res.json();
  const sel = $("asset-filter-cat");
  const cur = sel.value || "all";
  sel.innerHTML = '<option value="all">All categories</option>' + ASSET_LIB.categories.map(function(c) {
    return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
  }).join("");
  sel.value = ASSET_LIB.categories.includes(cur) || cur === "all" ? cur : "all";
  // Drop selections for ids that no longer exist
  const valid = {};
  ASSET_LIB.items.forEach(function(it) { valid[it.id] = true; });
  Object.keys(ASSET_SELECTED).forEach(function(id) {
    if (!valid[id]) delete ASSET_SELECTED[id];
  });
  renderAssets();
}

function draftItems() {
  if (!ASSET_LIB) return [];
  const byId = {};
  ASSET_LIB.items.forEach(function(i) { byId[i.id] = i; });
  return ASSET_LIB.draft.map(function(id) { return byId[id]; }).filter(Boolean);
}

function selectedIds() {
  return Object.keys(ASSET_SELECTED).filter(function(id) { return ASSET_SELECTED[id]; });
}

function updateBulkBar() {
  const ids = selectedIds();
  const countEl = $("asset-selected-count");
  if (countEl) countEl.textContent = ids.length + " selected";
  const allBox = $("asset-select-all");
  if (allBox) {
    const visible = ASSET_VISIBLE_IDS;
    const allOn = visible.length > 0 && visible.every(function(id) { return ASSET_SELECTED[id]; });
    const someOn = visible.some(function(id) { return ASSET_SELECTED[id]; });
    allBox.checked = allOn;
    allBox.indeterminate = someOn && !allOn;
  }
  const view = $("asset-filter-view") && $("asset-filter-view").value;
  const delBtn = $("bulk-delete-btn");
  const restoreBtn = $("bulk-restore-btn");
  if (delBtn) delBtn.hidden = view === "deleted";
  if (restoreBtn) restoreBtn.hidden = view !== "deleted";
}

function toggleAssetSelected(id, on) {
  if (on) ASSET_SELECTED[id] = true;
  else delete ASSET_SELECTED[id];
  const card = document.querySelector('.asset-card[data-id="' + CSS.escape(id) + '"]');
  if (card) card.classList.toggle("selected", !!on);
  updateBulkBar();
}

function toggleSelectAll(on) {
  ASSET_VISIBLE_IDS.forEach(function(id) {
    if (on) ASSET_SELECTED[id] = true;
    else delete ASSET_SELECTED[id];
  });
  renderAssets();
}

function clearAssetSelection() {
  ASSET_SELECTED = {};
  renderAssets();
}

function filteredAssetList() {
  if (!ASSET_LIB) return [];
  const draftSet = {};
  ASSET_LIB.draft.forEach(function(id) { draftSet[id] = true; });
  const cat = $("asset-filter-cat").value;
  const view = $("asset-filter-view").value;
  const q = ($("asset-filter-q").value || "").trim().toLowerCase();
  return ASSET_LIB.items.filter(function(it) {
    if (cat !== "all" && it.category !== cat) return false;
    if (view === "active" && it.deleted) return false;
    if (view === "favorites" && (!it.favorite || it.deleted)) return false;
    if (view === "draft" && !draftSet[it.id]) return false;
    if (view === "deleted" && !it.deleted) return false;
    if (q && it.id.toLowerCase().indexOf(q) < 0 && it.label.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

function renderAssets() {
  if (!ASSET_LIB) return;
  const draftSet = {};
  ASSET_LIB.draft.forEach(function(id) { draftSet[id] = true; });
  const publishedSet = {};
  ASSET_LIB.published.forEach(function(id) { publishedSet[id] = true; });

  const dirty = ASSET_LIB.dirty || (JSON.stringify(ASSET_LIB.draft) !== JSON.stringify(ASSET_LIB.published));
  $("publish-status").textContent = dirty
    ? "Draft differs from live. Publish to update the website"
    : "Live site matches this draft";
  $("publish-meta").textContent = ASSET_LIB.publishedAt
    ? ("Last published " + new Date(ASSET_LIB.publishedAt).toLocaleString())
    : "Not published yet. Using defaults until you publish";
  $("publish-btn").disabled = !ASSET_LIB.draft.length;

  const row = $("draft-row");
  const drafts = draftItems();
  row.innerHTML = drafts.length ? drafts.map(function(it, idx) {
    return '<span class="draft-chip" data-id="' + escapeHtml(it.id) + '">'
      + '<img src="' + escapeHtml(it.preview) + '" alt="">'
      + '<span>' + (idx + 1) + '. ' + escapeHtml(it.label) + '</span>'
      + '<button type="button" class="ghost" onclick="moveDraft(' + qid(it.id) + ',-1)">↑</button>'
      + '<button type="button" class="ghost" onclick="moveDraft(' + qid(it.id) + ',1)">↓</button>'
      + '<button type="button" class="danger" onclick="toggleDraft(' + qid(it.id) + ')">Remove</button>'
      + '</span>';
  }).join("") : '<span class="muted">No images selected for the rotator yet.</span>';

  const list = filteredAssetList();
  ASSET_VISIBLE_IDS = list.map(function(it) { return it.id; });

  $("asset-empty").hidden = list.length > 0;
  $("asset-grid").innerHTML = list.map(function(it) {
    const cats = ASSET_LIB.categories.map(function(c) {
      return '<option value="' + escapeHtml(c) + '"' + (c === it.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }).join("");
    const cls = ["asset-card"];
    if (it.favorite) cls.push("fav");
    if (draftSet[it.id]) cls.push("in-draft");
    if (it.deleted) cls.push("deleted");
    if (ASSET_SELECTED[it.id]) cls.push("selected");
    const badges = [];
    if (draftSet[it.id]) badges.push('<span class="badge">Draft</span>');
    if (publishedSet[it.id]) badges.push('<span class="badge live">Live</span>');
    if (it.favorite) badges.push('<span class="badge fav">Fav</span>');
    const useLabel = draftSet[it.id] ? "Remove" : "Use";
    const delBtn = it.deleted
      ? '<button type="button" class="ghost" onclick="setDeleted(' + qid(it.id) + ',false)">Restore</button>'
      : '<button type="button" class="danger" onclick="setDeleted(' + qid(it.id) + ',true)">Delete</button>';
    const checked = ASSET_SELECTED[it.id] ? " checked" : "";
    return '<article class="' + cls.join(" ") + '" data-id="' + escapeHtml(it.id) + '">'
      + '<div class="thumb">'
      + '<input class="pick" type="checkbox" aria-label="Select ' + escapeHtml(it.label) + '"' + checked + ' onchange="toggleAssetSelected(' + qid(it.id) + ', this.checked)">'
      + '<img src="' + escapeHtml(it.preview) + '" alt="' + escapeHtml(it.label) + '" loading="lazy" onclick="openAssetLightbox(' + qid(it.id) + ')">'
      + '<div class="badges">' + badges.join("") + '</div></div>'
      + '<div class="meta"><strong>' + escapeHtml(it.label) + '</strong>'
      + '<select onchange="setCategory(' + qid(it.id) + ', this.value)">' + cats + '</select>'
      + '<div class="actions">'
      + '<button type="button" class="ghost" onclick="toggleFavorite(' + qid(it.id) + ')">' + (it.favorite ? "Unfav" : "Favorite") + '</button>'
      + '<button type="button" onclick="toggleDraft(' + qid(it.id) + ')">' + useLabel + '</button>'
      + delBtn
      + '</div></div></article>';
  }).join("");
  updateBulkBar();
}

async function patchAssetItem(body) {
  const res = await fetch("/api/admin/assets/item", {
    method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) { toast("Update failed"); return null; }
  return res.json();
}

async function bulkPatch(body) {
  const res = await fetch("/api/admin/assets/bulk", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(function() { return null; });
    toast((data && data.error) || "Bulk update failed");
    return null;
  }
  return res.json();
}

async function bulkDeleteSelected() {
  const ids = selectedIds();
  if (!ids.length) { toast("Select images first"); return; }
  if (!confirm("Hide " + ids.length + " image" + (ids.length === 1 ? "" : "s") + " from admin and live selections?")) return;
  const data = await bulkPatch({ ids: ids, deleted: true });
  if (!data) return;
  ASSET_SELECTED = {};
  toast("Deleted " + data.changed + " image" + (data.changed === 1 ? "" : "s"));
  await loadAssets();
}

async function bulkRestoreSelected() {
  const ids = selectedIds();
  if (!ids.length) { toast("Select images first"); return; }
  const data = await bulkPatch({ ids: ids, deleted: false });
  if (!data) return;
  ASSET_SELECTED = {};
  toast("Restored " + data.changed);
  await loadAssets();
}

async function bulkFavorite(on) {
  const ids = selectedIds();
  if (!ids.length) { toast("Select images first"); return; }
  const data = await bulkPatch({ ids: ids, favorite: !!on });
  if (!data) return;
  toast((on ? "Favorited " : "Unfavorited ") + data.changed);
  await loadAssets();
}

function assetPreviewUrl(it) {
  if (!it) return "";
  const h = it.hero || {};
  return h.jpg928 || h.jpg1080 || h.jpg1400 || h.jpg700 || h.jpg640 || (it.square && it.square.jpg) || it.preview || "";
}

function openAssetLightbox(id) {
  if (!ASSET_LIB) return;
  const it = ASSET_LIB.items.find(function(x) { return x.id === id; });
  if (!it) return;
  const box = $("asset-lightbox");
  const img = $("asset-lightbox-img");
  const cap = $("asset-lightbox-cap");
  img.src = assetPreviewUrl(it);
  img.alt = it.label || "";
  cap.textContent = it.label || id;
  box.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeAssetLightbox() {
  const box = $("asset-lightbox");
  if (!box || box.hidden) return;
  box.hidden = true;
  $("asset-lightbox-img").src = "";
  document.body.style.overflow = "";
}

document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") closeAssetLightbox();
});

async function toggleFavorite(id) {
  const it = ASSET_LIB.items.find(function(x) { return x.id === id; });
  if (!it) return;
  const data = await patchAssetItem({ id: id, favorite: !it.favorite });
  if (!data) return;
  it.favorite = data.item.favorite;
  ASSET_LIB.dirty = data.dirty;
  renderAssets();
}

async function setCategory(id, category) {
  const data = await patchAssetItem({ id: id, category: category });
  if (!data) return;
  const it = ASSET_LIB.items.find(function(x) { return x.id === id; });
  if (it) it.category = data.item.category;
  renderAssets();
}

async function setDeleted(id, deleted) {
  if (deleted && !confirm("Hide this image from admin and live selections?")) return;
  const data = await patchAssetItem({ id: id, deleted: deleted });
  if (!data) return;
  delete ASSET_SELECTED[id];
  await loadAssets();
}


async function saveDraft(draft) {
  const res = await fetch("/api/admin/assets/draft", {
    method: "PUT", headers: authHeaders(), body: JSON.stringify({ draft: draft }),
  });
  if (!res.ok) { toast("Could not save selection"); return; }
  const data = await res.json();
  ASSET_LIB.draft = data.draft;
  ASSET_LIB.dirty = data.dirty;
  renderAssets();
}

async function toggleDraft(id) {
  if (!ASSET_LIB) return;
  const draft = ASSET_LIB.draft.slice();
  const idx = draft.indexOf(id);
  if (idx >= 0) draft.splice(idx, 1);
  else draft.push(id);
  await saveDraft(draft);
}

async function moveDraft(id, dir) {
  const draft = ASSET_LIB.draft.slice();
  const idx = draft.indexOf(id);
  if (idx < 0) return;
  const next = idx + dir;
  if (next < 0 || next >= draft.length) return;
  const tmp = draft[idx]; draft[idx] = draft[next]; draft[next] = tmp;
  await saveDraft(draft);
}

async function createCategory() {
  const name = ($("new-cat-name").value || "").trim();
  if (!name) return;
  const res = await fetch("/api/admin/assets/category", {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ name: name }),
  });
  if (!res.ok) { toast("Could not add category"); return; }
  $("new-cat-name").value = "";
  await loadAssets();
  $("asset-filter-cat").value = name;
  renderAssets();
}

async function publishAssets() {
  if (!confirm("Publish this rotator to the live website?")) return;
  const res = await fetch("/api/admin/assets/publish", { method: "POST", headers: authHeaders() });
  const data = await res.json().catch(function() { return null; });
  if (!res.ok) { toast((data && data.error) || "Publish failed"); return; }
  ASSET_LIB.published = data.published;
  ASSET_LIB.publishedAt = data.publishedAt;
  ASSET_LIB.dirty = false;
  ASSET_LIB.live = data.live;
  renderAssets();
  toast("Published to live site");
}


async function boot() {
  const res = await fetch("/api/admin/ping", { headers: authHeaders() });
  if (!res.ok) {
    // Stale / wrong cached key. force a clean sign-in.
    localStorage.removeItem("yolko_admin_key");
    KEY = "";
    const msg = $("login-msg");
    if (msg) msg.textContent = "Session expired. Sign in again";
    return;
  }
  $("login-card").style.display = "none";
  $("panel").style.display = "block";
  $("signout").style.display = "inline-flex";
  loadSettings();
  loadOrders();
  setInterval(loadOrders, 30000);
  if (location.hash === "#assets") showAdminView("assets");
  if (location.hash === "#visits") showAdminView("visits");
  if (location.hash === "#prices") showAdminView("prices");
}

$("key") && $("key").addEventListener("keydown", function(e) {
  if (e.key === "Enter") { e.preventDefault(); saveKey(); }
});

if (KEY) boot();
</script>
</body>
</html>`;

export default {
  // Every cron tick: Meta stock sync + competitor price poll (diff → events/webhook).
  async scheduled(_event, env, ctx) {
    const settings = await getSettings(env);
    ctx.waitUntil(syncMetaAdsForStock(env, settings.traysAvailable));
    ctx.waitUntil(
      runScheduledPoll(env).catch((err) => {
        console.log("price-watch poll failed", String(err?.message || err));
      })
    );
    ctx.waitUntil(
      reconcileOrders(env).catch((err) => {
        console.log("order reconcile failed", String(err?.message || err));
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

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(ADMIN_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex",
          "Cache-Control": "no-store, max-age=0",
          "X-Yolko-Admin": "113",
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
      "X-Yolko-Build": "186",
    };
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
