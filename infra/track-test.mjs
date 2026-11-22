// CHROMIUM_PATH=/path/to/chromium node infra/track-test.mjs : track.js in a real browser.
// The page is served to Chromium as getyolko.com from the files in this repo, nothing leaves the
// machine, and the shop's two addresses (/api/visit, /api/visit/ping) are played by this file.
// The browser's clock is driven by hand, so "30 seconds on the page" takes no time to test.
import { readFileSync } from "node:fs";
import { chromium, devices } from "playwright";

const ROOT = new URL("../", import.meta.url);
const file = (name) => readFileSync(new URL(name, ROOT), "utf8");
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };
const ID = "visit:2026-11-22T01:00:00.000Z:abc123";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">
  <a id="cta" href="#order">Order</a>
  <a id="tel" href="tel:0480093935" onclick="return false">Call</a>
  <a id="wa" href="https://wa.me/61480093935" onclick="return false">WhatsApp</a>
  <div style="height:3000px"></div>
  <section id="order" style="height:600px">
    <form id="order-form" onsubmit="return false">
      <fieldset id="tray-picker"><label id="two"><input type="radio" name="bundle" value="tray2"> 2 trays</label></fieldset>
      <input id="name" name="name" type="text">
      <button id="buynow-btn" type="submit">Buy now</button>
    </form>
  </section>
  <div style="height:1400px"></div>
  <script src="track.js?v=1"></script>
</body></html>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** One page view. `shop` decides how the pretend shop answers; returns what it was sent. */
async function open({ url = "https://getyolko.com/", visitDelayMs = 0, visitAnswer = { ok: true, id: ID }, context } = {}) {
  const ctx = context || (await browser.newContext({ ...devices["iPhone 13"] }));
  const page = await ctx.newPage();
  const seen = { visits: [], pings: [], other: [] };
  // The page's clock only moves when this file moves it, so every total below is exact.
  await page.clock.install({ time: new Date("2026-11-22T00:59:59Z") });
  await page.clock.pauseAt(new Date("2026-11-22T01:00:00Z"));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname !== "getyolko.com") { seen.other.push(req.url()); return route.abort(); }
    if (u.pathname === "/track.js") return route.fulfill({ contentType: "application/javascript", body: file("track.js") });
    if (u.pathname === "/api/visit") {
      seen.visits.push(JSON.parse(req.postData() || "{}"));
      if (visitDelayMs) await new Promise((r) => setTimeout(r, visitDelayMs));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(visitAnswer) });
    }
    if (u.pathname === "/api/visit/ping") {
      seen.pings.push({ ...JSON.parse(req.postData() || "{}"), _type: req.resourceType(), _ct: req.headers()["content-type"] || "" });
      return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    }
    return route.fulfill({ contentType: "text/html", body: PAGE });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.YOLKO_TRACK && window.YOLKO_TRACK.visitorId);
  return { ctx, page, seen };
}
const settle = (page) => page.waitForTimeout(150);
/** Move the page's own clock on, then let the browser finish what that set off. */
const pass = async (page, ms) => { await page.clock.runFor(ms); await settle(page); };
const leave = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(page);
};
const comeBack = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(page);
};
const last = (seen) => seen.pings[seen.pings.length - 1];

try {
  // 1. The page view is logged once, with the ad that brought the visitor and nothing personal.
  let { ctx, page, seen } = await open({ url: "https://getyolko.com/?ref=FRESH5&utm_source=facebook&utm_medium=paid&utm_campaign=surry-hills-test" });
  await settle(page);
  ok(seen.visits.length === 1, "one page view, one row");
  const first = seen.visits[0];
  ok(first.trk === 2 && first.pageN === 1 && first.src === "facebook" && first.utm_medium === "paid" && first.utm_campaign === "surry-hills-test", "the row is marked as a track.js row and carries the campaign");
  ok(/^[a-z0-9]{8,64}$/i.test(first.visitorId) && first.sessionId && first.path.startsWith("/?ref=FRESH5"), "it carries the anonymous visitor and session ids and the page");
  ok(seen.pings.length === 0, "nothing more is sent in the first moments");

  // 2. Seconds on screen go out at the marks, as running totals.
  await pass(page, 3100);
  ok(seen.pings.length === 1 && last(seen).secs === 3 && last(seen).id === ID && last(seen).v === first.visitorId, "at 3 seconds the first total goes out, naming the row and the visitor");
  ok(last(seen).scrolled === false && last(seen).order === false && last(seen).scroll > 0 && last(seen).scroll < 40 && Object.keys(last(seen).taps).length === 0, "no scroll and no taps yet; the first screen counts as seen");
  await pass(page, 12000);
  ok(seen.pings.length === 2 && last(seen).secs === 15, "at 15 seconds the next");

  // 3. A real scroll, the order section, and taps on the controls.
  await page.mouse.wheel(0, 3100);
  await pass(page, 600);
  await page.locator("#two").tap();
  await page.locator("#name").tap();
  await page.locator("#name").fill("Sam Example");
  await page.locator("#buynow-btn").tap();
  await page.locator("#two").tap();
  await pass(page, 1600);
  let t = last(seen);
  ok(t.scrolled === true && t.order === true && t.scroll > 50, "a scroll by the visitor is recorded, and the order section was reached");
  ok(t.taps.tray === 2 && t.taps.buy === 1 && t.taps.form === 1, "tray switch twice, Buy now once, the form entered once");
  ok(!JSON.stringify(seen.pings).includes("Sam") && !JSON.stringify(seen.visits).includes("Sam"), "what was typed is never sent");
  const sentSoFar = seen.pings.length;
  ok(sentSoFar === 3, "a burst of taps goes out as one send");

  // 4. Checkout cannot wait: it goes at once, as a beacon.
  await page.evaluate(() => window.YOLKO_TRACK.mark("checkout"));
  await settle(page);
  t = last(seen);
  ok(seen.pings.length === sentSoFar + 1 && t.taps.checkout === 1 && t._type === "ping", "checkout is sent the moment it starts, by sendBeacon");

  // 5. Time away does not count, and leaving sends the last total once.
  await pass(page, 4000);
  await leave(page);
  const atLeave = last(seen).secs;
  ok(atLeave === 21 && last(seen)._type === "ping", "leaving sends the total by sendBeacon");
  const n = seen.pings.length;
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await settle(page);
  ok(seen.pings.length === n, "pagehide after hidden does not send the same total again");
  await pass(page, 60000);
  ok(seen.pings.length === n, "a hidden page sends nothing and counts no time");
  await comeBack(page);
  await pass(page, 8500);
  ok(seen.pings.length === n, "8 more seconds on screen is 29 in all: nothing due yet");
  await pass(page, 1000);
  ok(seen.pings.length === n + 1 && last(seen).secs === 30, "back on screen it carries on from where it stopped: the 30 second mark, not 90");
  ok(seen.pings.every((x, i) => i === 0 || x.secs >= seen.pings[i - 1].secs), "totals only ever go up");

  // 6. Tel and WhatsApp links, and the Order link.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#tel").tap();
  await page.locator("#wa").tap();
  await page.locator("#cta").tap();
  await pass(page, 1600);
  t = last(seen);
  ok(t.taps.phone === 1 && t.taps.whatsapp === 1 && t.taps.cta === 1, "phone, WhatsApp and the Order link are counted");

  // 7. A second page in the same session says so and keeps the ad's name.
  await page.goto("https://getyolko.com/egg-delivery-rhodes");
  await page.waitForFunction(() => window.YOLKO_TRACK && window.YOLKO_TRACK.visitorId);
  await settle(page);
  const next = seen.visits[1] || {};
  ok(seen.visits.length === 2 && next.pageN === 2 && next.sessionId === first.sessionId && next.visitorId === first.visitorId, "the second page is page 2 of the same session");
  ok(next.src === "facebook" && next.utm_campaign === "surry-hills-test" && next.path === "/egg-delivery-rhodes", "and still knows the ad that brought the visitor");
  ok(seen.other.length === 0, "nothing is sent anywhere but the shop");
  await ctx.close();

  // 8. A link that jumps to the order form is not a scroll by the visitor.
  ({ ctx, page, seen } = await open({ url: "https://getyolko.com/?b=box#order" }));
  await pass(page, 3100);
  ok(last(seen).secs === 3 && last(seen).order === true && last(seen).scrolled === false, "arriving at #order: the order section was seen, but nobody scrolled");
  await ctx.close();

  // 9. Gone in a second: one send on the way out, with what little there was.
  ({ ctx, page, seen } = await open());
  await pass(page, 900);
  await leave(page);
  ok(seen.pings.length === 1 && seen.pings[0].secs === 0 && seen.pings[0].scrolled === false, "a bounce is one send of zero seconds");
  await ctx.close();

  // 10. The shop answers slowly: the visitor has left before the row has an id. The totals still go.
  ({ ctx, page, seen } = await open({ visitDelayMs: 1200 }));
  await page.clock.runFor(2000);
  await leave(page);
  ok(seen.pings.length === 0, "no row yet, so nothing to send to");
  await page.waitForTimeout(1500);
  ok(seen.pings.length === 1 && seen.pings[0].secs === 2 && seen.pings[0].id === ID, "once the row exists the totals from before are sent");
  await ctx.close();

  // 11. The shop gives no row (throttled): the page stays quiet for good.
  ({ ctx, page, seen } = await open({ visitAnswer: { ok: true, throttled: true } }));
  await pass(page, 20000);
  await leave(page);
  ok(seen.visits.length === 1 && seen.pings.length === 0, "no row, no pings");
  await ctx.close();

  // 12. A long stay stops sending: the marks run out and a page view has a ceiling.
  ({ ctx, page, seen } = await open());
  await pass(page, 700000);
  ok(seen.pings.map((x) => x.secs).join(",") === "3,15,30,60,180,600", "the marks are 3, 15, 30, 60, 180 and 600 seconds");
  for (let i = 0; i < 12; i++) { await leave(page); await comeBack(page); await pass(page, 2000); }
  ok(seen.pings.length === 12, "one page view sends at most 12 times");
  await ctx.close();
} finally {
  await browser.close();
}

if (!process.exitCode) console.log("track.js: all checks passed");
