// Checks the Farm Transparency reader and the Admin > Growers view: node infra/growers-test.mjs
import assert from "node:assert/strict";
import { parseFtList, ftCounts, isGrowerRow, runGrowersCheck, growersView, STATES } from "./growers.mjs";
import DATA from "./growers-data.json" with { type: "json" };

const row = (slug, name, type, town, state, status) =>
  `<tr class="odd"><td><a href="/facilities/${slug}" class="facility-name">${name}</a></td>` +
  `<td class="mobile-hide">${type}</td><td class="mobile-hide">Chickens</td><td class="mobile-hide">${town}</td>` +
  `<td class="mobile-hide">${state}</td><td class="mobile-hide">Australia</td><td class="mobile-hide">${status}</td>` +
  `<td class="mobile-hide">1</td><td class="mobile-hide">x</td></tr>`;
const page = (rows, n) => `<p>(${n} results)</p><p>Page 1 of 1</p><table>${rows.join("")}</table>`;

// One row: names and towns decoded, counts read off the page.
const one = page([row("abc12-smith-s-farm", "Smith&#39;s Free Range &amp; Co", "Farm (eggs)", "Mudgee", "NSW", "Open")], 1);
const [f] = parseFtList(one);
assert.deepEqual(f, { slug: "abc12-smith-s-farm", name: "Smith's Free Range & Co", type: "Farm (eggs)", species: "Chickens", town: "Mudgee", state: "NSW", status: "Open" });
assert.deepEqual(ftCounts(one), { results: 1, pages: 1 });
assert.deepEqual(ftCounts("<p>No facilities found</p>"), { results: 0, pages: 1 });
assert.deepEqual(ftCounts("<p>Something else</p>"), { results: null, pages: 1 });

// Which rows count as a grower.
assert.equal(isGrowerRow(f), true);
assert.equal(isGrowerRow({ ...f, status: "Closed" }), false);
assert.equal(isGrowerRow({ ...f, name: "Smith Hatchery" }), false);
assert.equal(isGrowerRow({ ...f, type: "Farm (eggs) (unconfirmed)" }), false);
assert.equal(isGrowerRow({ ...f, type: "Farm (eggs) Hatchery" }), false);
assert.equal(isGrowerRow({ ...f, name: "Egg farm" }), false);
assert.equal(isGrowerRow({ ...f, name: "John Smith" }), false);

// The saved list is sound: unique ids, a source on every row, contacts only on rows with a website.
const ids = new Set();
for (const g of DATA.growers) {
  assert.ok(!ids.has(g.id), "duplicate id " + g.id);
  ids.add(g.id);
  assert.ok(STATES.includes(g.state), g.id + " state");
  assert.ok(g.sources.length > 0, g.id + " has no source");
  if (g.email || g.contactForm || g.address) assert.ok(g.website, g.id + " has contacts but no website");
  if (g.email) assert.match(g.email, /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, g.id + " email");
  for (const s of g.sources) assert.match(s.url, /^https?:\/\/[^\s]+$/, g.id + " source link");
}

// A check reads the states, then the view marks closed and removed farms and adds new ones.
const kv = new Map();
const env = { DATA: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) } };
const withFt = DATA.growers.find((g) => g.state === "NSW" && g.sources.filter((s) => s.kind === "ft").length === 1 && !g.flag);
const slug = withFt.sources.find((s) => s.kind === "ft").url.split("/facilities/")[1];
const pages = {
  NSW: page([row(slug, withFt.name, "Farm (eggs)", "Town", "NSW", "Closed"), row("zz999-brand-new-free-range-egg-farm", "Brand New Free Range Egg Farm", "Farm (eggs)", "Dubbo", "NSW", "Open")], 2),
  NT: "<p>No facilities found</p>",
};
const fetcher = async (url) => {
  const st = new URL(url).searchParams.get("state");
  return new Response(pages[st] ?? page([], 0), { status: 200 });
};
const now = Date.parse("2026-12-01T00:00:00Z");
let res = await runGrowersCheck(env, { force: true, now, fetcher });
assert.deepEqual(res, { ran: true, read: 8, failed: 0 });
res = await runGrowersCheck(env, { force: true, now: now + 60000, fetcher });
assert.equal(res.ran, false, "a second forced check inside 10 minutes waits");
res = await runGrowersCheck(env, { now: now + 60000, fetcher });
assert.equal(res.ran, false, "nothing is due a minute later");
const view = await growersView(env);
const mine = view.growers.find((g) => g.id === withFt.id);
assert.equal(mine.flag, "Farm Transparency says closed");
assert.equal(mine.sources.find((s) => s.kind === "ft").status, "Closed");
const fresh = view.growers.find((g) => g.name === "Brand New Free Range Egg Farm");
assert.ok(fresh && fresh.isNew && !fresh.confirmed && fresh.eggs === "Free range");
assert.equal(view.added, 1);
const removed = view.growers.find((g) => g.state === "VIC" && g.sources.some((s) => s.kind === "ft") && g.sources.every((s) => s.kind === "ft"));
assert.equal(removed.flag, "No longer on Farm Transparency");
assert.equal(view.states.find((s) => s.state === "NT").count, 0);

// A page that reads short is an error, and the last good read is kept.
pages.NSW = page([row(slug, withFt.name, "Farm (eggs)", "Town", "NSW", "Open")], 5);
res = await runGrowersCheck(env, { force: true, now: now + 11 * 60000, fetcher });
assert.equal(res.failed, 1);
const nsw = (await growersView(env)).states.find((s) => s.state === "NSW");
assert.equal(nsw.ok, false);
assert.equal(nsw.error, "Read 1 of 5 farms");
assert.equal(nsw.count, 2);

console.log("growers tests passed");
