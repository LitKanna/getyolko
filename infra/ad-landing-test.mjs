// node infra/ad-landing-test.mjs : the homepage heading for visitors from an ad shown in one suburb.
// The small script that sits right after #hero-title in index.html is lifted out and run here
// against a stand-in page, so each kind of arrival is tried without a browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkDeliveryAddress } from "./delivery-zones.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };

const HEADING = "Fresh eggs delivered across Sydney";
const found = html.match(/<h1 id="hero-title">([^<]*)<\/h1>\s*<script>([\s\S]*?)<\/script>/);
ok(found, "the heading is followed at once by its script, so the words are right before the page paints");
ok(found && found[1] === HEADING, "the heading everyone else reads is unchanged: " + (found && found[1]));
ok((html.match(/<h1[\s>]/g) || []).length === 1, "one h1 on the homepage");
const script = found ? found[2] : "";

function arrive({ search = "", attr, brokenStorage = false } = {}) {
  const title = { textContent: HEADING };
  const context = {
    URLSearchParams,
    location: { search },
    document: { getElementById: (id) => (id === "hero-title" ? title : null) },
    sessionStorage: {
      getItem(key) {
        if (brokenStorage) throw new Error("storage is off");
        return key === "yolko_attr" && attr !== undefined ? (typeof attr === "string" ? attr : JSON.stringify(attr)) : null;
      },
    },
  };
  vm.runInNewContext(script, context);
  return title.textContent;
}

const SURRY = "Fresh eggs delivered to Surry Hills";
const AD = "?ref=FRESH5&utm_source=facebook&utm_medium=paid&utm_campaign=surry-hills-test&utm_content=120212345";

ok(arrive() === HEADING, "a plain visit reads the usual heading");
ok(arrive({ search: "?ref=FRESH5" }) === HEADING, "a referral link alone reads the usual heading");
ok(arrive({ search: "?utm_source=google&utm_medium=organic" }) === HEADING, "a visit from Google reads the usual heading");
ok(arrive({ search: "?utm_source=facebook&utm_medium=paid&utm_campaign=some-other-ad" }) === HEADING, "an ad for somewhere else reads the usual heading");
ok(arrive({ search: AD }) === SURRY, "the Surry Hills ad link names Surry Hills: " + arrive({ search: AD }));
ok(arrive({ search: "?utm_campaign=Surry-Hills-Test" }) === SURRY, "capital letters in the campaign name make no difference");
ok(arrive({ attr: { src: "facebook", utm_campaign: "surry-hills-test" } }) === SURRY, "back on the homepage later in the same visit, the heading still names the suburb");
ok(arrive({ search: "?utm_source=google", attr: { src: "facebook", utm_campaign: "surry-hills-test" } }) === HEADING, "a new arrival from somewhere else drops the earlier ad");
ok(arrive({ search: "?src=flyer", attr: { src: "facebook", utm_campaign: "surry-hills-test" } }) === HEADING, "so does a flyer scan");
ok(arrive({ attr: { src: "google", utm_campaign: "" } }) === HEADING, "a visit with no campaign reads the usual heading");
ok(arrive({ attr: "not json {" }) === HEADING, "a damaged note in the browser is ignored");
ok(arrive({ brokenStorage: true }) === HEADING, "a browser with storage switched off reads the usual heading");
ok(arrive({ search: AD, brokenStorage: true }) === SURRY, "and still names the suburb from the ad link");
ok(arrive({ search: "?utm_campaign=__proto__" }) === HEADING && arrive({ search: "?utm_campaign=constructor" }) === HEADING && arrive({ search: "?utm_campaign=toString" }) === HEADING, "a made-up campaign name cannot put other words in the heading");

// Every suburb the heading may name is one we deliver to, and short enough to keep three lines on a phone.
const map = script.match(/AD_SUBURBS\s*=\s*(\{[^}]*\})/);
ok(map, "the list of campaigns and their suburbs is in the script");
const suburbs = map ? vm.runInNewContext("(" + map[1] + ")") : {};
ok(Object.keys(suburbs).length >= 1 && suburbs["surry-hills-test"] === "Surry Hills", "the Surry Hills test campaign is on the list");
for (const [campaign, suburb] of Object.entries(suburbs)) {
  ok(campaign === campaign.toLowerCase(), `${campaign}: campaign names are written in small letters`);
  const check = checkDeliveryAddress({ street: "1 Example Street", suburb, postcode: "" });
  ok(check.ok && check.deliver, `${suburb}: we deliver there (${check.code || "ok"})`);
  ok(suburb.length <= "across Sydney".length, `${suburb}: no longer than "across Sydney", so the heading keeps its three lines`);
}
ok(!/[‒-―!]/.test(script.replace(/!campaign|!q\./g, "")), "no long dashes or exclamation marks in the words");

if (!process.exitCode) console.log("ad landing: all checks passed");
