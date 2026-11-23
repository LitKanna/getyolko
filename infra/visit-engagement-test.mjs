// node infra/visit-engagement-test.mjs : what a visitor did on a page is kept on the visit row
// as the highest value of each total, never counted twice, never ahead of the clock, and the
// real or suspect label follows what they did and the network they came over.
import {
  cleanPing, mergeEngagement, netKind, visitVerdict, applyVisitPing, pagesBySession, sayTime,
  takeVisitPing, highestTotals,
  PING_MAX_WRITES, PING_MAX_AGE_MS, PING_QUIET_MS,
  OWN_KEY,
  cleanOwnList,
  isOwnVisit,
  isOwnAutomation,
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

// ---- reports every 3 seconds, held at the edge, written when it matters ----
// A pretend edge: the store, the clock, and the waits that would run later in the Worker.
const edgeOf = (kvx, { working = true } = {}) => {
  const e = { now: T0, held: {}, waits: [], gets: 0, puts: 0, asked: 0 };
  e.store = {
    get: async (id) => { e.gets += 1; if (!working) return null; return id in e.held ? JSON.parse(JSON.stringify(e.held[id])) : null; },
    put: async (id, st) => { e.puts += 1; if (working) e.held[id] = JSON.parse(JSON.stringify(st)); },
  };
  e.opts = { clock: () => e.now, defer: (ms, fn) => e.waits.push({ due: e.now + ms, fn }), budget: async () => { e.asked += 1; return true; } };
  // The page reports its totals at `secs` seconds; waits that fall due before then run first.
  e.until = async (secs) => {
    const t = at(secs);
    for (;;) {
      const next = e.waits.filter((w) => w.due <= t).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      e.waits.splice(e.waits.indexOf(next), 1);
      e.now = next.due;
      await next.fn();
    }
    e.now = t;
  };
  e.report = async (secs, extra) => { await e.until(secs); return takeVisitPing(kvx, e.store, ping({ secs, ...extra }), e.opts); };
  return e;
};

// Kanna's test: 25 seconds on the page, then the tab is closed with no warning at all.
kv = fresh();
let e = edgeOf(kv);
r = await e.report(3);
ok(r.ok && r.wrote && kv.puts.length === 1 && kv.rows[ID].eng.secs === 3, "the first report is written at once, so the row shows a person is there");
for (const sec of [6, 9, 12]) r = await e.report(sec);
ok(r.ok && !r.wrote && r.held && r.edge && kv.puts.length === 1, "the next ones wait at the edge: no write");
ok(e.held[ID].eng.secs === 12 && kv.rows[ID].eng.secs === 3, "the edge has the newest totals, the row the last written");
ok(kv.gets === 2, "and the row is not even read while the edge has the page view (once to start, once to write)");
r = await e.report(15);
ok(r.wrote && kv.puts.length === 2 && kv.rows[ID].eng.secs === 15, "15 seconds is one of the marks that is always written");
for (const sec of [18, 21, 24]) r = await e.report(sec);
ok(!r.wrote && kv.puts.length === 2, "then it waits again");
await e.until(24 + PING_QUIET_MS / 1000 - 1);
ok(kv.puts.length === 2, "6 seconds of silence is not yet the end");
await e.until(24 + PING_QUIET_MS / 1000);
ok(kv.puts.length === 3 && kv.rows[ID].eng.secs === 24 && kv.rows[ID].eng.n === 3, "7 seconds after the last report the row gets the final total: 24 seconds, in 3 writes");
await e.until(600);
ok(kv.puts.length === 3 && e.waits.length === 0, "the waits of the earlier reports found a newer one and wrote nothing");

// taps: a new kind is written at once, more of the same waits, Buy now and checkout never wait
kv = fresh(); e = edgeOf(kv);
await e.report(3);
r = await e.report(6, { taps: { tray: 1 } });
ok(r.wrote && kv.rows[ID].eng.taps.tray === 1, "the first tray switch is written at once");
r = await e.report(9, { taps: { tray: 3, form: 1 } });
ok(r.wrote && kv.rows[ID].eng.taps.form === 1 && kv.rows[ID].eng.taps.tray === 3, "the first box of the form too, and it carries the tray count");
r = await e.report(12, { taps: { tray: 3, form: 4 } });
ok(!r.wrote && kv.rows[ID].eng.taps.form === 1, "more boxes wait at the edge");
r = await e.report(13, { taps: { tray: 3, form: 5, buy: 1 } });
ok(r.wrote && kv.rows[ID].eng.taps.buy === 1 && kv.rows[ID].eng.taps.form === 5, "Buy now is written at once and brings the boxes with it");
r = await e.report(14, { taps: { tray: 3, form: 5, buy: 2, checkout: 1 } });
ok(r.wrote && kv.rows[ID].eng.taps.checkout === 1 && kv.rows[ID].eng.taps.buy === 2, "so is every later Buy now and the checkout");
const writesSoFar = kv.puts.length;
await e.until(600);
ok(kv.puts.length === writesSoFar, "nothing left to write once the page is quiet");

// the same report twice, a late one, an old one
kv = fresh(); e = edgeOf(kv);
await e.report(3); await e.report(6);
r = await takeVisitPing(kv, e.store, ping({ secs: 6 }), e.opts);
ok(r.ok && !r.wrote && r.reason === "same", "the same report again changes nothing");
r = await takeVisitPing(kv, e.store, ping({ secs: 3 }), e.opts);
ok(r.ok && r.reason === "same" && e.held[ID].eng.secs === 6, "a late one never lowers a total");
await e.until(6 + PING_QUIET_MS / 1000);
ok(kv.rows[ID].eng.secs === 6 && kv.puts.length === 2, "and the quiet write still happens once");

// only the browser that opened the page view, from the edge or from the row
kv = fresh(); e = edgeOf(kv);
r = await takeVisitPing(kv, e.store, ping({ v: "someone-else-entirely-0000000000" }), e.opts);
ok(!r.ok && r.reason === "visitor" && kv.puts.length === 0 && !(ID in e.held), "another visitor id is refused before anything is held");
await e.report(3);
const getsBefore = kv.gets;
r = await takeVisitPing(kv, e.store, ping({ v: "someone-else-entirely-0000000000", secs: 500, taps: { checkout: 9 } }), e.opts);
ok(!r.ok && r.reason === "visitor" && kv.gets === getsBefore && e.held[ID].eng.secs === 3, "and refused from the edge too, without touching the row or what is held");
for (const bad of ["settings", "visits:index", "order:2026-11-19T01:27:22.482Z:88fgp6", "", null]) {
  r = await takeVisitPing(kv, e.store, ping({ id: bad }), e.opts);
  ok(!r.ok && r.reason === "id", `${JSON.stringify(bad)} is not a visit row`);
}
r = await takeVisitPing(kv, e.store, ping({ id: "visit:2026-11-22T01:00:00.000Z:zzzzzz" }), e.opts);
ok(!r.ok && r.reason === "gone", "a row that does not exist is not created");
e.now = T0 + PING_MAX_AGE_MS + 1000;
r = await takeVisitPing(kv, e.store, ping({ secs: 900 }), e.opts);
ok(!r.ok && r.reason === "old", "a page view from this morning takes no more reports");

// a long stay costs few writes: 3 minutes of reports every 3 seconds
kv = fresh(); e = edgeOf(kv);
for (let sec = 3; sec <= 180; sec += 3) await e.report(sec, { scroll: 40, scrolled: true });
await e.until(1000);
ok(kv.rows[ID].eng.secs === 180 && kv.puts.length === 5, "3 minutes on the page, 60 reports, 5 writes (first, 15, 30, 60 and 180 seconds): " + kv.puts.length);
ok(e.asked === kv.puts.length, "and the day's allowance is asked once per write, not per report");

// a pause in the middle (the visitor looks away, then comes back) is written, and so is the end
kv = fresh(); e = edgeOf(kv);
for (const sec of [3, 6, 9]) await e.report(sec);
await e.until(40);
ok(kv.rows[ID].eng.secs === 9 && kv.puts.length === 2, "the pause is written");
e.now = at(100);
for (const sec of [12, 15, 18, 21]) { r = await takeVisitPing(kv, e.store, ping({ secs: sec }), e.opts); e.now += 3000; }
await e.until(200);
ok(kv.rows[ID].eng.secs === 21 && kv.puts.length === 4, "back again: the 15 second mark and the new end, 4 writes in all");

// the edge loses the page view (another data centre takes the next report): nothing is lost
kv = fresh(); e = edgeOf(kv);
for (const sec of [3, 6, 9]) await e.report(sec);
delete e.held[ID];
r = await e.report(12, { taps: { tray: 1 } });
ok(r.ok && !r.edge && kv.rows[ID].eng.secs === 12 && kv.rows[ID].eng.taps.tray === 1, "it starts again from the row and the report's own totals");
await e.until(600);
ok(kv.rows[ID].eng.secs === 12, "and the row ends on the newest totals");

// no edge store at all: every report is still written, late, and the limits hold
kv = fresh(); e = edgeOf(kv, { working: false });
for (let sec = 3; sec <= 120; sec += 3) await e.report(sec);
await e.until(1000);
ok(kv.rows[ID].eng.secs >= 60 && kv.puts.length === PING_MAX_WRITES, `without the edge a page view still stops at ${PING_MAX_WRITES} writes: ` + kv.puts.length);

// the day's allowance spent: reports are still taken, nothing is written, nothing breaks
kv = fresh(); e = edgeOf(kv);
e.opts.budget = async () => false;
for (const sec of [3, 6, 9, 15]) r = await e.report(sec);
await e.until(600);
ok(r.ok && kv.puts.length === 0 && e.held[ID].eng.secs === 15, "a spent allowance: held at the edge, no write, no error for the page");

// a store that throws is treated as no store
kv = fresh(); e = edgeOf(kv);
e.store.get = async () => { throw new Error("cache down"); };
e.store.put = async () => { throw new Error("cache down"); };
r = await e.report(3);
ok(r.ok && r.wrote && kv.rows[ID].eng.secs === 3, "a broken edge store never breaks a report");

// what the admin shows for a page that is open now: the higher of the row and the edge
let hi = highestTotals({ secs: 15, scroll: 40, scrolled: true, order: false, taps: { tray: 2 } }, { secs: 24, scroll: 35, scrolled: false, order: true, taps: { tray: 1, form: 3 } });
ok(hi.secs === 24 && hi.scroll === 40 && hi.scrolled && hi.order && hi.taps.tray === 2 && hi.taps.form === 3, "field by field, the highest of each");
ok(highestTotals(null, { secs: 6, taps: {} }).secs === 6 && highestTotals(undefined, null) === null, "one side missing is the other; both missing is nothing");

// the shop's own devices: never logged, never shown
{
  const own = cleanOwnList({ ips: [" 203.0.113.50 ", "203.0.113.50", "", null, 7], ids: ["a1b2c3d4e5f6a7b8", "a1b2c3d4e5f6a7b8", "x"], extra: true });
  ok(own.ips.length === 1 && own.ips[0] === "203.0.113.50" && own.ids.length === 1, "the list is trimmed, deduplicated and junk is dropped: " + JSON.stringify(own));
  ok(isOwnVisit(own, { ip: "203.0.113.50", visitorId: "someoneelse0001" }), "a visit from the home connection is the shop's own, whatever the browser");
  ok(isOwnVisit(own, { ip: "198.51.100.7", visitorId: "a1b2c3d4e5f6a7b8" }), "a known device is the shop's own on any connection");
  ok(!isOwnVisit(own, { ip: "198.51.100.7", visitorId: "someoneelse0001" }), "anyone else is a visitor");
  ok(!isOwnVisit(own, { ip: "203.0.113.5", visitorId: "a1b2c3d4e5f6a7b" }), "a near match is not a match");
  ok(!isOwnVisit(own, {}) && !isOwnVisit(own, { ip: null, visitorId: null }) && !isOwnVisit(null, { ip: "203.0.113.50" }), "nothing to go on, or no list: a visitor");
  const empty = cleanOwnList(null);
  ok(empty.ips.length === 0 && empty.ids.length === 0 && !isOwnVisit(empty, { ip: "203.0.113.50", visitorId: "a1b2c3d4e5f6a7b8" }), "no list in the store: everyone is a visitor");
  ok(cleanOwnList("nonsense").ips.length === 0 && cleanOwnList({ ips: "203.0.113.50" }).ips.length === 0, "a damaged list hides nobody");
  ok(isOwnVisit(own, { ip: "203.0.113.50", visitorId: "zzz", createdAt: "2026-11-23T02:19:00.000Z", path: "/" }), "a stored row is checked the same way");
  ok(OWN_KEY === "visits:own", "the list lives under one key in the store");
}

// our own checks of the site: never logged, never shown
ok(isOwnAutomation({ asnOrg: "Anthropic, PBC" }) && isOwnAutomation({ asnOrg: "ANTHROPIC" }), "a check run from Anthropic's network is ours");
ok(isOwnAutomation({ asnOrg: "Telstra Limited", src: "mr-yolko-check" }) && isOwnAutomation({ src: " Mr-Yolko-Check " }), "a named test visit is ours on any network");
ok(isOwnAutomation({ id: "visit:x", asnOrg: "Anthropic, PBC", src: "direct", ua: "HeadlessChrome" }), "a stored row is checked the same way");
for (const org of ["Telstra Limited", "Google LLC", "Meta Platforms Ireland Limited", "Amazon.com, Inc.", "Microsoft Corporation", "OPTUS INTERNET - RETAIL", "Philanthropic Networks Pty Ltd", "", null, undefined]) {
  ok(!isOwnAutomation({ asnOrg: org, src: "facebook" }), `not ours: ${org}`);
}
ok(!isOwnAutomation({ asnOrg: "Telstra Limited", src: "direct" }) && !isOwnAutomation({ src: "mr-yolko-checkout" }) && !isOwnAutomation({}) && !isOwnAutomation(), "ordinary sources and near names are visitors");

if (!process.exitCode) console.log("visit engagement: all checks passed");
