// node infra/visit-engagement-test.mjs : what a visitor did on a page is kept on the visit row
// as the highest value of each total, never counted twice, never ahead of the clock, and the
// real or suspect label follows what they did and the network they came over.
import {
  cleanPing, mergeEngagement, netKind, visitVerdict, applyVisitPing, pagesBySession, sayTime,
  PING_MAX_WRITES, PING_MAX_AGE_MS,
} from "./visit-engagement.mjs";

const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };
const T0 = Date.parse("2026-11-22T01:00:00.000Z");
const at = (secs) => T0 + secs * 1000;

// ---- a ping is cut down to numbers, whatever the page sent ----
let p = cleanPing({ secs: "41.9", scroll: 250, scrolled: true, order: 1, taps: { buy: 2, nonsense: 9, tray: -3, phone: "x", checkout: 400 }, name: "Sam" });
ok(p.secs === 41 && p.scroll === 100 && p.scrolled === true && p.order === false, "numbers are clamped, and only a true is a yes");
ok(JSON.stringify(p.taps) === JSON.stringify({ buy: 2, checkout: 99 }) && !("name" in p), "only known taps are kept, nothing else rides along");
p = cleanPing(null);
ok(p.secs === 0 && p.scroll === 0 && !p.scrolled && !p.order && Object.keys(p.taps).length === 0, "an empty ping is all zeros");
ok(cleanPing({ secs: 99999 }).secs === 3600, "an hour is the most a page view can hold");

// ---- the row keeps the highest of each total ----
let m = mergeEngagement(null, cleanPing({ secs: 3, scroll: 12 }), { createdAtMs: T0, nowMs: at(3) });
ok(m.changed && m.eng.secs === 3 && m.eng.scroll === 12 && m.eng.n === 1 && m.eng.at === "2026-11-22T01:00:03.000Z", "the first ping always lands");
let m2 = mergeEngagement(m.eng, cleanPing({ secs: 15, scroll: 40, scrolled: true, taps: { tray: 1 } }), { createdAtMs: T0, nowMs: at(15) });
ok(m2.changed && m2.eng.secs === 15 && m2.eng.scroll === 40 && m2.eng.scrolled && m2.eng.taps.tray === 1 && m2.eng.n === 2, "a later ping raises the totals");
// the same ping again, and an older one arriving late: nothing moves, nothing is counted twice
let m3 = mergeEngagement(m2.eng, cleanPing({ secs: 15, scroll: 40, scrolled: true, taps: { tray: 1 } }), { createdAtMs: T0, nowMs: at(16) });
ok(!m3.changed && m3.eng.n === 2 && m3.eng.taps.tray === 1, "a repeat send changes nothing");
m3 = mergeEngagement(m2.eng, cleanPing({ secs: 3, scroll: 12 }), { createdAtMs: T0, nowMs: at(17) });
ok(!m3.changed && m3.eng.secs === 15 && m3.eng.scroll === 40 && m3.eng.scrolled && m3.eng.taps.tray === 1, "a late older ping cannot pull a total down");
m3 = mergeEngagement(m2.eng, cleanPing({ secs: 15, scroll: 40, order: true }), { createdAtMs: T0, nowMs: at(18) });
ok(m3.changed && m3.eng.order && m3.eng.scrolled && m3.eng.taps.tray === 1, "one new fact is a change, and the rest stays");
// seconds cannot run ahead of the clock
m = mergeEngagement(null, cleanPing({ secs: 600 }), { createdAtMs: T0, nowMs: at(10) });
ok(m.eng.secs === 15, "a page opened 10 seconds ago cannot have 10 minutes on screen");

// ---- the kind of network ----
ok(netKind("Facebook, Inc.") === "meta" && netKind("Meta Platforms Ireland") === "meta", "Meta's network");
ok(netKind("Google LLC") === "google", "Google's network");
for (const n of ["Amazon.com, Inc.", "AMAZON-02", "Microsoft Corporation", "DigitalOcean, LLC", "Akamai Connected Cloud", "Cloudflare, Inc.", "OVH SAS", "Hetzner Online GmbH", "Servers Australia Pty. Ltd", "Apple Inc.", "M247 Europe SRL", "Anthropic, PBC", "OpenAI, LLC"]) {
  ok(netKind(n) === "datacentre", `${n} is a data centre`);
}
for (const n of ["Telstra Limited", "Singtel Optus Pty Limited", "TPG Internet Pty Ltd", "Vodafone Australia Pty Ltd", "Aussie Broadband", "Superloop", "Vocus Connect International Backbone", "Exetel Pty Ltd"]) {
  ok(netKind(n) === "isp", `${n} is an ordinary provider`);
}
ok(netKind("") === "unknown" && netKind(null) === "unknown", "no name, no guess");

// ---- real or suspect ----
const row = (extra) => ({ trk: 2, createdAt: new Date(T0).toISOString(), visitorId: "v".repeat(32), asnOrg: "Telstra Limited", net: "isp", ...extra });
const eng = (e) => ({ secs: 0, scroll: 10, scrolled: false, order: false, taps: {}, n: 1, ...e });
const v = (r, secs = 300) => visitVerdict(r, at(secs)).label;
ok(v({ createdAt: "2026-11-01T00:00:00.000Z" }) === "" && visitVerdict(null).label === "", "a row from before track.js gets no label");
ok(v(row({}), 30) === "new", "a page opened seconds ago is not judged yet");
ok(v(row({}), 300) === "suspect", "nothing ever came back: not counted as a person");
ok(v(row({ eng: eng({ secs: 1 }) })) === "suspect", "shut in under 3 seconds with no scroll");
ok(v(row({ eng: eng({ secs: 4 }) })) === "real", "4 seconds on an ordinary network is a person");
ok(v(row({ eng: eng({ secs: 1, scrolled: true, scroll: 30 }) })) === "real", "a quick scroll on an ordinary network is a person");
ok(v(row({ eng: eng({ secs: 0, taps: { phone: 1 } }) })) === "real", "a tap is a person");
const meta = { asnOrg: "Facebook, Inc.", net: "meta" };
ok(v(row({ ...meta })) === "suspect" && v(row({ ...meta }), 10) === "suspect", "Meta's checker is suspect from the start");
ok(v(row({ ...meta, eng: eng({ secs: 40 }) })) === "suspect", "sitting on the page from Meta's network is still a checker");
ok(v(row({ asnOrg: "Akamai International B.V.", net: "datacentre", eng: eng({ secs: 12, scrolled: true, scroll: 55 }) })) === "real", "an iPhone on Private Relay that scrolls is a person");
ok(v(row({ asnOrg: "Akamai International B.V.", net: "datacentre", eng: eng({ secs: 2, scrolled: true }) })) === "suspect", "a data centre needs more than a flick");
ok(v(row({ asnOrg: "Amazon.com, Inc.", net: undefined, eng: eng({ secs: 30 }) })) === "suspect", "an older row with no net field is read from its network name");
ok(v(row({ asnOrg: "Anthropic, PBC", net: "isp", eng: eng({ secs: 40 }) })) === "suspect", "a row stored as an ordinary network is re-read once its name is known to be a robot's");
ok(v(row({ asnOrg: "", net: "meta", eng: eng({ secs: 40 }) })) === "suspect", "with no name on the row, the stored kind stands");
ok(/Meta's own network/.test(visitVerdict(row({ ...meta }), at(300)).why), "the reason names the network");
ok(visitVerdict(row({ eng: eng({ secs: 83, scrolled: true, scroll: 61, taps: { tray: 2, buy: 1 } }) }), at(300)).why === "on the page 1m 23s, scrolled to 61%, 3 taps", "the reason says what they did");
ok(sayTime(8) === "8s" && sayTime(72) === "1m 12s", "seconds read as people say them");

// ---- one ping against the log ----
const ID = "visit:2026-11-22T01:00:00.000Z:abc123";
const VID = "f".repeat(32);
const fakeKv = (rows) => {
  const kv = { rows, puts: [], gets: 0 };
  kv.get = async (k) => { kv.gets += 1; return k in kv.rows ? JSON.parse(JSON.stringify(kv.rows[k])) : null; };
  kv.put = async (k, val, opts) => { kv.puts.push({ k, opts }); kv.rows[k] = JSON.parse(val); };
  return kv;
};
const fresh = () => fakeKv({ [ID]: { id: ID, createdAt: new Date(T0).toISOString(), visitorId: VID, sessionId: "s1", trk: 2, city: "Sydney" } });
const ping = (extra) => ({ id: ID, v: VID, secs: 3, scroll: 14, scrolled: false, order: false, taps: {}, ...extra });

let kv = fresh();
let r = await applyVisitPing(kv, ping(), { now: at(3) });
ok(r.ok && r.wrote && kv.puts.length === 1 && kv.rows[ID].eng.secs === 3 && kv.rows[ID].city === "Sydney", "a ping is written onto its own row, and the row keeps the rest");
ok(kv.puts[0].opts.expirationTtl === 90 * 24 * 3600, "the row still lapses after 90 days");
r = await applyVisitPing(kv, ping(), { now: at(4) });
ok(r.ok && !r.wrote && r.reason === "same" && kv.puts.length === 1, "the same ping again costs no write");
r = await applyVisitPing(kv, ping({ secs: 21, scroll: 63, scrolled: true, order: true, taps: { tray: 2, buy: 1 } }), { now: at(21) });
ok(r.wrote && kv.rows[ID].eng.secs === 21 && kv.rows[ID].eng.order && kv.rows[ID].eng.taps.buy === 1 && kv.rows[ID].eng.n === 2, "the next one raises the totals");

// only the browser that opened the page can add to it
kv = fresh();
r = await applyVisitPing(kv, ping({ v: "someone-else-entirely-0000000000" }), { now: at(3) });
ok(!r.ok && r.reason === "visitor" && kv.puts.length === 0, "another visitor id is refused");
r = await applyVisitPing(kv, ping({ v: "" }), { now: at(3) });
ok(!r.ok && kv.puts.length === 0, "no visitor id is refused");
for (const bad of ["order:2026-11-19T01:27:22.482Z:88fgp6", "settings", "visits:index", "visit:../settings", "", null, 7]) {
  r = await applyVisitPing(kv, ping({ id: bad }), { now: at(3) });
  ok(!r.ok && r.reason === "id", `${JSON.stringify(bad)} is not a visit row`);
}
ok(kv.gets === 2 && kv.puts.length === 0, "a bad id never reaches the store");
r = await applyVisitPing(kv, ping({ id: "visit:2026-11-22T01:00:00.000Z:zzzzzz" }), { now: at(3) });
ok(!r.ok && r.reason === "gone" && kv.puts.length === 0, "a row that does not exist is not created");
r = await applyVisitPing(kv, ping(), { now: T0 + PING_MAX_AGE_MS + 1000 });
ok(!r.ok && r.reason === "old" && kv.puts.length === 0, "a page view from this morning takes no more updates");

// the cap on writes for one page view, with room left for the taps that matter
kv = fresh();
for (let i = 1; i <= PING_MAX_WRITES + 5; i++) await applyVisitPing(kv, ping({ secs: i * 5, scroll: 20 + i }), { now: at(i * 5) });
ok(kv.puts.length === PING_MAX_WRITES && kv.rows[ID].eng.n === PING_MAX_WRITES, `one page view costs at most ${PING_MAX_WRITES} writes`);
r = await applyVisitPing(kv, ping({ secs: 200, scroll: 90, taps: { checkout: 1 } }), { now: at(200) });
ok(r.wrote && kv.rows[ID].eng.taps.checkout === 1, "a checkout tap still gets through a full row");
for (let i = 2; i <= 9; i++) await applyVisitPing(kv, ping({ secs: 200 + i, taps: { checkout: 1, buy: i } }), { now: at(200 + i) });
ok(kv.puts.length === PING_MAX_WRITES + 4, "and even those stop");

// the day's allowance
kv = fresh();
let asked = 0;
r = await applyVisitPing(kv, ping(), { now: at(3), budget: async () => { asked += 1; return false; } });
ok(r.ok && !r.wrote && r.reason === "budget" && kv.puts.length === 0 && asked === 1, "a spent allowance means no write, and no error for the page");
await applyVisitPing(kv, ping(), { now: at(3), budget: async () => { asked += 1; return true; } });
await applyVisitPing(kv, ping(), { now: at(4), budget: async () => { asked += 1; return true; } });
ok(asked === 2 && kv.puts.length === 1, "the allowance is only asked when there is something to write");

// ---- pages in a session ----
const pages = pagesBySession([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "a" }, { sessionId: null }, null, { sessionId: "a" }]);
ok(pages.a === 3 && pages.b === 1 && Object.keys(pages).length === 2, "pages are counted per browser session");

if (!process.exitCode) console.log("visit engagement: all checks passed");
