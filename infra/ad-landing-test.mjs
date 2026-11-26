// node infra/ad-landing-test.mjs : the homepage heading for visitors from an ad.
// The two small scripts around the heading in index.html are lifted out and run here against a
// stand-in page, so each kind of arrival is tried without a browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkDeliveryAddress } from "./delivery-zones.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };

const HEADING = "Fresh eggs delivered across Sydney";
const SUB = 'A tray of 30 <b>Pace Farm</b> eggs for <strong>$13</strong>. We bring it to your door on Saturday morning, $5 flat.';
const found = html.match(/<h1 id="hero-title">([^<]*)<\/h1>\s*<script>([\s\S]*?)<\/script>\s*<p class="hero-sub">([\s\S]*?)<\/p>\s*<script>([\s\S]*?)<\/script>/);
ok(found, "the heading is followed at once by its script, then the line under it and its script, so the words are right before the page paints");
ok(found && found[1] === HEADING, "the heading everyone else reads is unchanged: " + (found && found[1]));
ok(found && found[3] === SUB, "the line under it is unchanged for everyone else");
ok((html.match(/<h1[\s>]/g) || []).length === 1, "one h1 on the homepage");
const headScript = found ? found[2] : "";
const subScript = found ? found[4] : "";

function arrive({ search = "", attr, brokenStorage = false } = {}) {
  const attrs = {};
  const title = { textContent: HEADING, setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
  const sub = { innerHTML: SUB };
  const rootAttrs = {};
  const context = {
    URLSearchParams,
    location: { search },
    document: {
      documentElement: { setAttribute: (k, v) => { rootAttrs[k] = String(v); } },
      getElementById: (id) => (id === "hero-title" ? title : null),
      querySelector: (sel) => (sel === ".hero-sub" ? sub : null),
    },
    sessionStorage: {
      getItem(key) {
        if (brokenStorage) throw new Error("storage is off");
        return key === "yolko_attr" && attr !== undefined ? (typeof attr === "string" ? attr : JSON.stringify(attr)) : null;
      },
    },
  };
  vm.runInNewContext(headScript, context);
  vm.runInNewContext(subScript, context);
  return { h: title.textContent, sub: sub.innerHTML, root: rootAttrs };
}
const head = (o) => arrive(o).h;

const SURRY = "Fresh eggs delivered to Surry Hills";
const WEEKLY = "Eggs at your door every Saturday";
const MORE = "1.75 kg of eggs for $13";
const ad = (c, extra = "") => `?ref=FRESH5&utm_source=facebook&utm_medium=paid&utm_campaign=${c}&utm_content=120212345${extra}`;

ok(head() === HEADING, "a plain visit reads the usual heading");
ok(head({ search: "?ref=FRESH5" }) === HEADING, "a referral link alone reads the usual heading");
ok(head({ search: "?utm_source=google&utm_medium=organic" }) === HEADING, "a visit from Google reads the usual heading");
ok(head({ search: "?utm_source=facebook&utm_medium=paid&utm_campaign=some-other-ad" }) === HEADING, "an ad with no landing of its own reads the usual heading");
ok(head({ search: ad("surry-hills-test") }) === SURRY, "the Surry Hills ad names Surry Hills");
ok(head({ search: ad("never-run-out", "&b=tray1&repeat=1") }) === WEEKLY, "the never run out ad: " + head({ search: ad("never-run-out") }));
ok(head({ search: ad("more-egg", "&b=tray1") }) === MORE, "the more egg ad: " + head({ search: ad("more-egg") }));
ok(head({ search: "?utm_campaign=Surry-Hills-Test" }) === SURRY && head({ search: "?utm_campaign=MORE-EGG" }) === MORE, "capital letters in the campaign name make no difference");
ok(head({ attr: { src: "facebook", utm_campaign: "never-run-out" } }) === WEEKLY, "back on the homepage later in the same visit, the ad's heading stays");
ok(head({ search: "?utm_source=google", attr: { src: "facebook", utm_campaign: "surry-hills-test" } }) === HEADING, "a new arrival from somewhere else drops the earlier ad");
ok(head({ search: "?src=flyer", attr: { src: "facebook", utm_campaign: "more-egg" } }) === HEADING, "so does a flyer scan");
ok(head({ attr: { src: "google", utm_campaign: "" } }) === HEADING, "a visit with no campaign reads the usual heading");
ok(head({ attr: "not json {" }) === HEADING, "a damaged note in the browser is ignored");
ok(head({ brokenStorage: true }) === HEADING, "a browser with storage switched off reads the usual heading");
ok(head({ search: ad("surry-hills-test"), brokenStorage: true }) === SURRY, "and still reads the ad's heading from the ad link");
ok(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"].every((c) => head({ search: "?utm_campaign=" + c }) === HEADING), "a made-up campaign name cannot put other words in the heading");

// The line under the heading changes only where the heading already says the price.
ok(arrive().sub === SUB && arrive({ search: ad("surry-hills-test") }).sub === SUB && arrive({ search: ad("never-run-out") }).sub === SUB, "the line under the heading is unchanged for a plain visit and for ads whose heading has no price");
const more = arrive({ search: ad("more-egg") }).sub;
ok(more !== SUB && !/\$13/.test(more) && /\$5 flat/.test(more) && /Pace Farm/.test(more) && /tray of 30/.test(more), "under the more egg heading the price is said once, and $5 delivery stays beside it: " + more);
ok(!/<strong>/.test(more), "no <strong> left for app.js to put a second price in");

// The order form starts on the pack the ad sells, with the ad's suburb as the example (app.js reads these).
const root = (o) => arrive(o).root;
const SURRY_ROOT = { "data-ad-bundle": "tray1", "data-ad-suburb": "Surry Hills", "data-ad-postcode": "2010" };
ok(JSON.stringify(root({ search: ad("surry-hills-test") })) === JSON.stringify(SURRY_ROOT), "a Surry Hills ad visitor starts on one tray with Surry Hills 2010 as the example: " + JSON.stringify(root({ search: ad("surry-hills-test") })));
ok(root({ search: ad("never-run-out") })["data-ad-bundle"] === "tray1" && root({ search: ad("more-egg") })["data-ad-bundle"] === "tray1", "so do visitors from the homes ads");
ok(root({ attr: { src: "facebook", utm_campaign: "surry-hills-test" } })["data-ad-bundle"] === "tray1", "and on coming back to the homepage in the same visit");
ok(Object.keys(root()).length === 0 && Object.keys(root({ search: "?utm_source=google" })).length === 0 && Object.keys(root({ search: "?utm_campaign=__proto__" })).length === 0, "everyone else gets nothing from this: the form starts as it always has");
ok(Object.keys(root({ search: "?src=flyer", attr: { src: "facebook", utm_campaign: "more-egg" } })).length === 0, "nor does a later arrival from a flyer");
const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
ok(appJs.includes('get("b") || document.documentElement.getAttribute("data-ad-bundle")'), "app.js: a b= in the link still wins over the ad's pack");
ok(appJs.includes("suburbInput.placeholder = suburb") && appJs.includes("postcodeInput.placeholder = postcode"), "app.js: the example suburb and postcode come from the ad");

// What the list holds.
const map = headScript.match(/AD_LANDINGS\s*=\s*(\{[\s\S]*?\n\s*\});/);
ok(map, "the list of campaigns is in the script");
const lands = map ? vm.runInNewContext("(" + map[1] + ")") : {};
ok(["surry-hills-test", "never-run-out", "more-egg"].every((c) => c in lands), "the three campaigns are on the list");
const tray1 = Number((SUB.match(/<strong>\$(\d+)<\/strong>/) || [])[1]);
for (const [campaign, land] of Object.entries(lands)) {
  ok(campaign === campaign.toLowerCase(), `${campaign}: campaign names are written in small letters`);
  ok(Boolean(land.suburb) !== Boolean(land.title), `${campaign}: a suburb or a heading, not both`);
  const words = land.suburb ? "Fresh eggs delivered to " + land.suburb : land.title;
  if (land.suburb) {
    const check = checkDeliveryAddress({ street: "1 Example Street", suburb: land.suburb, postcode: "" });
    ok(check.ok && check.deliver, `${land.suburb}: we deliver there (${check.code || "ok"})`);
    ok(land.suburb.length <= "across Sydney".length, `${land.suburb}: no longer than "across Sydney", so the heading keeps its three lines`);
  }
  // The real check is the browser's: three lines at most on a phone (photographed before each change).
  if (land.bundle) ok(["tray1", "tray2", "box"].includes(land.bundle), `${campaign}: starts on a pack the form has (${land.bundle})`);
  if (land.place) {
    const check = checkDeliveryAddress({ street: "1 Example Street", suburb: land.place[0], postcode: land.place[1] });
    ok(check.ok && check.deliver, `${campaign}: the example ${land.place.join(" ")} is a place we deliver to (${check.code || "ok"})`);
  }
  if (/\$\d/.test(words)) ok(land.bundle === "tray1", `${campaign}: a heading saying $${tray1} starts the form on that tray`);
  ok(words.length <= 36, `${campaign}: heading about as long as today's at most (${words.length} letters)`);
  for (const p of words.match(/\$\d+/g) || []) ok(Number(p.slice(1)) === tray1, `${campaign}: a price in the heading is the tray price on the page ($${tray1})`);
  if (/\$\d/.test(words)) ok(Boolean(land.sub) && !/\$\d/.test(land.sub.replace("$5 flat", "")), `${campaign}: a heading with a price says it once on the first screen`);
  ok(!/[‒-―!]/.test(words + (land.sub || "")), `${campaign}: no long dashes or exclamation marks`);
  ok(!/cheap/i.test(words + (land.sub || "")), `${campaign}: no cheapest or cheaper`);
}

if (!process.exitCode) console.log("ad landing: all checks passed");
