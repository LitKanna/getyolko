// node infra/subscriptions-test.mjs : weekly and fortnightly orders from the first payment to the
// Saturdays after, run through the whole Worker against a pretend Stripe, a pretend Zoho and a
// pretend clock. Nothing here reaches a real service. Run: npm run test:subscriptions
import { register } from "node:module";
import { createHmac } from "node:crypto";

// The Worker imports the admin page as text (wrangler does that); teach Node the same.
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith(".html")) {
    const { readFile } = await import("node:fs/promises");
    return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(await readFile(new URL(url), "utf8")) + ";" };
  }
  return nextLoad(url, context);
}`)
);

/* ---------- A clock the test sets (Sydney is UTC+11 in November and December) ---------- */
const RealDate = Date;
let nowMs = RealDate.parse("2026-11-18T10:00:00+11:00");
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(nowMs);
  }
  static now() {
    return nowMs;
  }
};
const at = (sydney) => {
  nowMs = RealDate.parse(`${sydney}:00+11:00`);
};

/* ---------- KV ---------- */
const store = new Map();
const DATA = {
  async get(key, type) {
    if (!store.has(key)) return null;
    const v = store.get(key);
    return type === "json" || type?.type === "json" ? JSON.parse(v) : v;
  },
  async put(key, value) {
    store.set(key, String(value));
  },
  async delete(key) {
    store.delete(key);
  },
  async list({ prefix = "" } = {}) {
    return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  },
};
const kv = (key) => {
  if (!store.has(key)) return null;
  try {
    return JSON.parse(store.get(key));
  } catch {
    return store.get(key);
  }
};

const env = {
  DATA,
  STRIPE_KEY: "sk_test_pretend",
  STRIPE_API_URL: "https://stripe.test",
  STRIPE_WEBHOOK_SECRET: "whsec_pretend",
  ADMIN_KEY: "admin-pretend",
  ZEPTOMAIL_TOKEN: "zepto-pretend",
  ZEPTOMAIL_API_URL: "https://cpaas.test/v1.1/email",
  ORDER_EMAIL_FROM: "orders@getyolko.com",
  ZOHO_CLIENT_ID: "zoho-client",
  ZOHO_CLIENT_SECRET: "zoho-secret-pretend",
  ZOHO_REFRESH_TOKEN: "zoho-refresh-pretend-token",
  ZOHO_ACCOUNTS_URL: "https://zoho-accounts.test",
  ZOHO_MAIL_URL: "https://zoho-mail.test",
  ZOHO_MAIL_ACCOUNT_ID: "1",
};
store.set("settings", JSON.stringify({ prices: { tray1: 13, tray2: 25, box: 72 }, traysAvailable: 60 }));
// The pay page look is already set: keeps the background branding job out of the way.
store.set("stripe:branded:yolko:4", "1");

/* ---------- Pretend Stripe, Zoho Mail and Zoho CPaaS ---------- */
const stripe = { calls: [], sessions: new Map(), charges: new Map(), idem: new Map(), detached: [], n: 0, charge: null };
const mailbox = []; // sent from the orders@ mailbox (Zoho Mail)
const orderMail = []; // sent through the order sender (Zoho CPaaS)
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fields = (params, name) => Object.fromEntries([...params].filter(([k]) => k.startsWith(`${name}[`)).map(([k, v]) => [k.slice(name.length + 1, -1), v]));

function pretendStripe(method, url, init) {
  const path = url.pathname.replace(/^\/v1\//, "");
  const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  const headers = new Headers(init?.headers || {});
  stripe.calls.push({ method, path, params, key: headers.get("Idempotency-Key") || "", query: url.searchParams });
  if (headers.get("Authorization") !== "Bearer sk_test_pretend") return reply({ error: { message: "bad key" } }, 401);

  if (method === "POST" && path === "checkout/sessions") {
    const id = `cs_test_${++stripe.n}`;
    const session = { id, url: `https://pay.test/${id}`, status: "open", payment_status: "unpaid", mode: params.get("mode"), metadata: fields(params, "metadata"), sent: params };
    stripe.sessions.set(id, session);
    return reply(session);
  }
  let m = /^checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/.exec(path);
  if (method === "POST" && m) return reply({ id: m[1], status: "expired" });
  m = /^checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (method === "GET" && m) return stripe.sessions.has(m[1]) ? reply(stripe.sessions.get(m[1])) : reply({ error: { code: "resource_missing", message: "No such session" } }, 404);
  if (method === "GET" && path === "checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    return reply({ data: pi ? [...stripe.sessions.values()].filter((s) => s.payment_intent?.id === pi) : [] });
  }
  if (method === "POST" && path === "payment_intents") {
    const key = headers.get("Idempotency-Key");
    if (key && stripe.idem.has(key)) return reply(...stripe.idem.get(key));
    const answer = stripe.charge ? stripe.charge(params) : null;
    let out;
    if (answer) out = [answer.body, answer.status];
    else {
      const n = ++stripe.n;
      const charge = { id: `ch_sub_${n}`, created: Math.floor(nowMs / 1000), receipt_url: `https://pay.test/receipt/${n}`, payment_intent: `pi_sub_${n}`, metadata: fields(params, "metadata"), payment_method_details: { card: { brand: "visa", last4: "4242" } } };
      stripe.charges.set(charge.id, charge);
      out = [{ id: `pi_sub_${n}`, status: "succeeded", amount: Number(params.get("amount")), amount_received: Number(params.get("amount")), currency: "aud", customer: params.get("customer"), payment_method: params.get("payment_method"), metadata: fields(params, "metadata"), latest_charge: charge }, 200];
    }
    if (key && out[1] < 500) stripe.idem.set(key, out);
    return reply(...out);
  }
  if (method === "POST" && /^payment_intents\/[^/]+\/cancel$/.test(path)) return reply({ status: "canceled" });
  m = /^payment_methods\/([^/]+)\/detach$/.exec(path);
  if (method === "POST" && m) {
    stripe.detached.push(m[1]);
    return reply({ id: m[1] });
  }
  m = /^charges\/([^/?]+)$/.exec(path);
  if (method === "GET" && m) return stripe.charges.has(m[1]) ? reply(stripe.charges.get(m[1])) : reply({ error: { message: "No such charge" } }, 404);
  return reply({ error: { message: `pretend Stripe has no ${method} ${path}` } }, 404);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method || "GET").toUpperCase();
  if (url.host === "stripe.test") return pretendStripe(method, url, init);
  if (url.host === "zoho-accounts.test") return reply({ access_token: "zoho-access", expires_in: 3600 });
  if (url.host === "zoho-mail.test") {
    if (method === "POST" && /\/messages$/.test(url.pathname)) {
      mailbox.push(JSON.parse(init.body));
      return reply({ data: { messageId: String(mailbox.length) } });
    }
    if (url.pathname === "/api/accounts") return reply({ data: [{ accountId: "1", primaryEmailAddress: "orders@getyolko.com" }] });
    return reply({ data: [] });
  }
  if (url.host === "cpaas.test") {
    const mail = JSON.parse(init.body);
    orderMail.push({ to: mail.to[0].email_address.address, subject: mail.subject, html: mail.htmlbody, text: mail.textbody });
    return reply({ request_id: `req_${orderMail.length}` }, 201);
  }
  // Supermarket pages, news feeds, Meta, GitHub: none of them matter here.
  return new Response("", { status: 503 });
};

const worker = (await import("./cloudflare-worker.mjs")).default;

let failed = 0;
const ok = (cond, what) => {
  if (!cond) {
    failed++;
    console.log("FAIL", what);
  }
};
let waiting = [];
const ctx = { waitUntil: (p) => waiting.push(Promise.resolve(p).catch(() => null)) };
const settle = async () => {
  while (waiting.length) await Promise.all(waiting.splice(0));
};
async function call(method, path, { body, form, headers = {} } = {}) {
  const init = { method, headers: { "CF-Connecting-IP": "203.0.113.9", ...headers }, redirect: "manual" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const resp = await worker.fetch(new Request(`https://getyolko.com${path}`, init), env, ctx);
  await settle();
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: resp.status, text, data, to: resp.headers.get("Location") || "" };
}
const cron = async () => {
  await worker.scheduled({}, env, ctx);
  await settle();
};
const admin = { Authorization: "Bearer admin-pretend" };
const shop = { Origin: "https://getyolko.com" };
const buy = (extra = {}) =>
  call("POST", "/api/buy-now", {
    headers: shop,
    body: { name: "Priya Nair", phone: "0412345678", bundle: "tray2", quantity: 1, fulfillment: "delivery", deliveryStreet: "Unit 4, 12 Smith Street", deliverySuburb: "Strathfield", deliveryCity: "Sydney", deliveryPostcode: "2135", ...extra },
  });
/** Stripe says the Checkout Session is paid, and tells the shop through the webhook. */
async function pay(sessionId, { email = "priya@example.com", customer = "cus_1", pm = "pm_1" } = {}) {
  const s = stripe.sessions.get(sessionId);
  const amount = [0, 1].reduce((sum, i) => sum + Number(s.sent.get(`line_items[${i}][price_data][unit_amount]`) || 0) * Number(s.sent.get(`line_items[${i}][quantity]`) || 0), 0);
  const charge = { id: `ch_${sessionId}`, created: Math.floor(nowMs / 1000), receipt_url: `https://pay.test/receipt/${sessionId}`, payment_method_details: { card: { brand: "visa", last4: "4242" } } };
  Object.assign(s, {
    status: "complete",
    payment_status: "paid",
    amount_total: amount,
    currency: "aud",
    customer: s.sent.get("customer_creation") === "always" ? customer : null,
    customer_details: { email },
    payment_intent: { id: `pi_${sessionId}`, payment_method: pm, latest_charge: charge },
  });
  const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: sessionId } } });
  const t = Math.floor(nowMs / 1000);
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return call("POST", "/api/stripe-webhook", { body: payload, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
}
const charges = () => stripe.calls.filter((c) => c.method === "POST" && c.path === "payment_intents");
const orders = () => kv("orders:index").map((id) => kv(id));
const subOf = (i = 0) => kv(`sub:${kv("sub:index")[i]}`);
const stock = () => kv("settings").traysAvailable;

/* ---------- 1. An ordinary order is untouched ---------- */
let r = await buy({ phone: "0498765432", name: "Sam Lee" });
let sent = stripe.sessions.get("cs_test_1").sent;
ok(r.status === 200 && r.data.price === 30 && r.data.deliveryFee === 5, "one-off order: $25 + $5 delivery");
ok(!sent.has("customer_creation") && !sent.has("payment_intent_data[setup_future_usage]") && !sent.has("custom_text[submit][message]"), "one-off order: no card is kept");
ok(sent.get("line_items[1][price_data][unit_amount]") === "500", "one-off order: the delivery line is there");

/* ---------- 2. A weekly order: first payment at Checkout ---------- */
r = await buy({ repeat: 1, remind: true });
sent = stripe.sessions.get("cs_test_2").sent;
ok(r.status === 200 && r.data.price === 25 && r.data.deliveryFee === 0, "weekly: same $25, delivery free");
ok(sent.get("customer_creation") === "always" && sent.get("payment_intent_data[setup_future_usage]") === "off_session" && sent.get("payment_method_types[0]") === "card", "weekly: Checkout is asked to keep the card");
ok(sent.get("metadata[repeat]") === "1" && sent.get("metadata[deliveryPerk]") === "subscriber" && sent.get("metadata[deliveryFee]") === "0", "weekly: the session says so");
ok(!sent.has("line_items[1][price_data][unit_amount]") && sent.get("line_items[0][price_data][unit_amount]") === "2500", "weekly: one line, no delivery fee, no discount");
ok(/pay today for Saturday 21 Nov/.test(sent.get("custom_text[submit][message]")) && /every Thursday night/.test(sent.get("custom_text[submit][message]")), "weekly: the pay page says when the card is charged next");
ok(/^Weekly, first delivery Saturday 21 Nov/.test(sent.get("line_items[0][price_data][product_data][description]")), "weekly: the line item names it");
ok(!kv("sub:index"), "weekly: nothing starts until it is paid");

r = await pay("cs_test_2");
let sub = subOf();
let first = orders().find((o) => o.sessionId === "cs_test_2");
ok(r.status === 200 && first.paymentStatus === "paid" && first.status === "confirmed" && first.deliveryPerk === "subscriber" && first.price === 25, "first order: paid, confirmed, free delivery");
ok(sub && sub.status === "active" && sub.every === 1 && sub.nextRun === "2026-11-28" && sub.lastRun === "2026-11-21", "repeat order started: next Saturday is the 28th");
ok(sub.stripeCustomer === "cus_1" && sub.paymentMethod === "pm_1" && sub.card.last4 === "4242" && sub.email === "priya@example.com", "repeat order keeps the customer, card and email");
ok(first.subId === sub.id && kv(`sub:tok:${sub.token}`) === sub.id && /^[a-f0-9]{32}$/.test(sub.token), "the order points at it, and its link token works");
ok(stock() === 58, "first order took 2 trays from stock");
let mail = orderMail.at(-1);
ok(mail && mail.to === "priya@example.com" && mail.html.includes(">Repeats<") && mail.html.includes("Every Saturday") && mail.html.includes(`subscription?t=${sub.token}`) && mail.html.includes("each Thursday night"), "confirmation email: Repeats row, when it is charged, the manage link");
ok(mail.text.includes("Repeats: every saturday") && mail.text.includes(`subscription?t=${sub.token}`), "confirmation email: the text version says the same");
await pay("cs_test_2");
ok(kv("sub:index").length === 1 && stock() === 58, "a second webhook for the same payment changes nothing");

r = await call("GET", "/api/confirm-payment?session=cs_test_2");
ok(r.data.paid && r.data.order.repeat === 1 && r.data.order.next === "28 Nov" && r.data.order.when === "Saturday 21 Nov", "paid screen: weekly, next eggs 28 Nov");

/* ---------- 3. Nothing happens outside Thursday and Friday morning ---------- */
await cron();
at("2026-11-21T08:00");
await cron();
at("2026-11-23T09:00");
await cron();
ok(charges().length === 0 && mailbox.length === 0, "no charge and no notice on other days");

/* ---------- 4. Thursday: the notice, once ---------- */
at("2026-11-26T09:45");
await cron();
ok(mailbox.length === 0, "Thursday before 10am: nothing yet");
at("2026-11-26T10:15");
await cron();
ok(mailbox.length === 1 && mailbox[0].toAddress === "priya@example.com" && mailbox[0].subject === "Your eggs come this Saturday, 28 Nov", "Thursday 10am: the notice goes from the shop's mailbox");
ok(mailbox[0].content.includes(`subscription?t=${sub.token}&amp;do=skip&amp;for=2026-11-28`) && mailbox[0].content.includes("Skip this week") && mailbox[0].content.includes("$25.00") && mailbox[0].content.includes("Charged tonight to Visa ending"), "notice: total, card, and a skip button for that Saturday");
ok(mailbox[0].content.includes("title-coming-1.png") && mailbox[0].fromAddress.includes("orders@getyolko.com"), "notice: heading picture, sent as the shop");
at("2026-11-26T10:30");
await cron();
at("2026-11-26T19:45");
await cron();
ok(mailbox.length === 1 && subOf().noticeFor === "2026-11-28", "the notice is sent once (and no Thursday reminder on top of it)");

/* ---------- 5. The customer's page: a link asks, a button acts ---------- */
const page = `/subscription?t=${sub.token}`;
r = await call("GET", page);
ok(r.status === 200 && r.text.includes("Next eggs Saturday 28 Nov") && r.text.includes("Skip Saturday 28 Nov") && r.text.includes("Charged Thursday night, 26 Nov") && r.text.includes("Visa ending"), "page: next delivery, total, card, skip button");
ok(r.text.includes("noindex") && !r.text.includes("cus_1") && !r.text.includes("pm_1"), "page: not indexed, no Stripe ids");
r = await call("GET", `${page}&do=skip&for=2026-11-28`);
ok(r.status === 200 && r.text.includes("Skip Saturday 28 Nov?") && r.text.includes("Saturday 5 Dec") && subOf().nextRun === "2026-11-28", "opening the email's skip link only asks");
r = await call("POST", `${page}&do=skip&for=2026-11-28`);
ok(r.status === 303 && r.to.endsWith("&ok=skipped") && subOf().nextRun === "2026-12-05" && subOf().skipped[0] === "2026-11-28", "the button skips that Saturday");
r = await call("GET", `${page}&ok=skipped`);
ok(r.text.includes("Next eggs Saturday 5 Dec") && r.text.includes("Skipped.") && r.text.includes("do=unskip&amp;for=2026-11-28"), "page after a skip: next is 5 Dec, with Undo");
r = await call("POST", `${page}&do=skip&for=2026-11-28`);
ok(r.to.endsWith("&ok=locked") && subOf().nextRun === "2026-12-05", "a second tap on an old skip button never skips a later Saturday");
r = await call("POST", `${page}&do=unskip&for=2026-11-28`);
ok(r.to.endsWith("&ok=unskipped") && subOf().nextRun === "2026-11-28" && subOf().skipped.length === 0, "Undo puts it back");
r = await call("GET", "/subscription?t=00000000000000000000000000000000");
ok(r.status === 404 && r.text.includes("This link has expired"), "a wrong token shows nothing");

/* ---------- 6. Friday, just after orders close: the charge ---------- */
at("2026-11-26T23:45");
await cron();
ok(charges().length === 0, "Thursday night before midnight: not charged yet");
at("2026-11-27T00:15");
await cron();
let ch = charges();
ok(ch.length === 1 && ch[0].params.get("amount") === "2500" && ch[0].params.get("currency") === "aud" && ch[0].params.get("customer") === "cus_1" && ch[0].params.get("payment_method") === "pm_1", "Friday 00:15: the saved card is charged $25");
ok(ch[0].params.get("off_session") === "true" && ch[0].params.get("confirm") === "true" && ch[0].params.get("payment_method_types[0]") === "card" && ch[0].key === `yolko-sub-${sub.id}-2026-11-28-0`, "charge: off-session, confirmed, with an idempotency key for that Saturday");
let second = orders()[0];
ok(second.subId === sub.id && second.repeat === 1 && second.paymentStatus === "paid" && second.status === "confirmed" && second.pickupDate === "28 Nov" && second.price === 25 && second.deliveryFee === 0 && second.deliveryPerk === "subscriber", "a normal paid order is written for Saturday 28 Nov");
ok(second.deliveryAddress.includes("12 Smith Street") && second.phone === "0412345678" && second.name === "Priya Nair" && second.stripe.paymentIntentId.startsWith("pi_sub_") && second.stripe.receiptUrl && second.stripe.email === "priya@example.com", "the order carries the address and the payment");
ok(ch[0].params.get("metadata[orderId]") === second.id && stock() === 56, "the charge names the order, and 2 more trays left stock");
mail = orderMail.at(-1);
ok(orderMail.length === 2 && mail.subject.startsWith("Your YOLKO order is confirmed") && mail.html.includes("Saturday 28 Nov") && mail.html.includes(">Repeats<"), "the customer gets the usual confirmation for it");
sub = subOf();
ok(sub.nextRun === "2026-12-05" && sub.lastRun === "2026-11-28" && sub.runs === 2 && sub.lastOrderId === second.id, "the repeat order moves on to 5 Dec");
at("2026-11-27T00:30");
await cron();
at("2026-11-27T11:45");
await cron();
ok(charges().length === 1 && orders().filter((o) => o.subId === sub.id).length === 2 && stock() === 56, "later ticks that morning charge nothing more");
r = await call("POST", `${page}&do=skip&for=2026-11-28`);
ok(r.to.endsWith("&ok=locked"), "the charged Saturday cannot be skipped afterwards");
r = await call("GET", `${page}&do=skip&for=2026-11-28`);
ok(r.text.includes("Orders for that Saturday have closed") && !r.text.includes("Skip Saturday 5 Dec?"), "an old email's skip link says it has closed, and never offers the next Saturday instead");

/* ---------- 7. The admin sees it, and the receipt and refund paths work without a Checkout Session ---------- */
r = await call("GET", "/api/admin/subscriptions");
ok(r.status === 401, "admin list needs the key");
at("2026-12-01T09:00");
r = await call("GET", "/api/admin/subscriptions", { headers: admin });
let row = r.data.subs[0];
ok(r.data.on && r.data.subs.length === 1 && row.status === "active" && row.next === "2026-12-05" && row.item === "2 egg trays (60 eggs)" && row.total === 25 && row.trays === 2 && row.runs === 2 && row.paidFor === "2026-11-28" && !("token" in row), "admin list: who, what, next Saturday, the last one paid for (never the link token)");
ok(r.data.week.sat === "2026-12-05" && r.data.week.due === 1 && r.data.week.trays === 2 && r.data.week.total === 25 && r.data.week.charge === "3 Dec", "admin: what Thursday night's run will take");
r = await call("GET", `/api/stripe-receipt?id=${encodeURIComponent(second.id)}`, { headers: admin });
ok(r.status === 200 && r.data.paid && r.data.stripe.receiptUrl, "admin receipt works for an order the cron charged");
// A refund made in the Stripe dashboard for that order.
const chargeId = [...stripe.charges.keys()][0];
Object.assign(stripe.charges.get(chargeId), { refunded: true, amount_refunded: 2500, currency: "aud", refunds: { data: [{ id: "re_1", status: "succeeded", amount: 2500, created: Math.floor(nowMs / 1000), metadata: {} }] } });
{
  const payload = JSON.stringify({ type: "charge.refunded", data: { object: { id: chargeId } } });
  const t = Math.floor(nowMs / 1000);
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  r = await call("POST", "/api/stripe-webhook", { body: payload, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
}
ok(r.status === 200 && kv(second.id).paymentStatus === "refunded" && kv(second.id).status === "cancelled" && stock() === 58, "a dashboard refund of a cron-charged order is recorded and its trays come back");
ok(orderMail.at(-1).subject.startsWith("Your YOLKO refund"), "and the refund email goes out");

/* ---------- 8. A declined card: no order, an email, and a second chance until Friday noon ---------- */
at("2026-12-03T10:15");
await cron();
ok(mailbox.length === 2 && mailbox[1].subject === "Your eggs come this Saturday, 5 Dec", "next Thursday: the next notice");
stripe.charge = () => ({ status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", payment_intent: { id: "pi_declined" } } } });
at("2026-12-04T00:15");
const before = orders().length;
await cron();
sub = subOf();
ok(charges().length === 2 && orders().length === before && stock() === 58, "declined: no order is written and no stock moves");
ok(sub.failures === 1 && sub.failedFor === "2026-12-05" && sub.status === "active" && sub.lastErrorCode === "insufficient_funds", "declined: noted on the repeat order");
mail = orderMail.at(-1);
ok(mail.subject === "Your card didn't go through for Saturday 5 Dec" && mail.html.includes(`subscription?t=${sub.token}&amp;do=card`) && mail.html.includes("Update card") && mail.html.includes("by 12pm Friday") && mail.html.includes("title-card-1.png"), "declined: the customer is told, with an Update card button");
at("2026-12-04T00:30");
await cron();
ok(charges().length === 2, "a declined card is not hammered every 15 minutes");
r = await call("GET", "/api/admin/subscriptions", { headers: admin });
ok(r.data.week.sat === "2026-12-05" && r.data.week.due === 0 && r.data.week.failed === 1 && r.data.week.charged === 0 && r.data.lastRun.declined === 1 && r.data.subs[0].cardFailed === true, "admin: Friday morning shows the card that failed");
r = await call("GET", page);
ok(r.text.includes("Your card didn’t go through") && r.text.includes("Update card") && r.text.includes("by 12pm Friday"), "page: says the card failed and how long there is");

// New card, while Saturday's run is still open: charged at once.
r = await call("GET", `${page}&do=card`);
ok(r.status === 200 && r.text.includes("Continue to Stripe") && r.text.includes("$25.00"), "update card: the link only asks");
r = await call("POST", `${page}&do=card`);
const setup = [...stripe.sessions.values()].at(-1);
ok(r.status === 303 && r.to === setup.url && setup.mode === "setup" && setup.sent.get("customer") === "cus_1" && setup.sent.get("metadata[subId]") === sub.id && setup.sent.get("success_url").includes(`t=${sub.token}&card={CHECKOUT_SESSION_ID}`), "update card: Stripe's own page, for this customer");
Object.assign(setup, { status: "complete", setup_intent: { id: "seti_1", payment_method: { id: "pm_2", card: { brand: "mastercard", last4: "4444" } } } });
stripe.charge = null;
at("2026-12-04T08:30");
r = await call("GET", `${page}&card=${setup.id}`);
sub = subOf();
ch = charges();
ok(r.status === 303 && r.to.endsWith("&ok=charged"), "back from Stripe: card updated and Saturday booked");
ok(ch.length === 3 && ch[2].params.get("payment_method") === "pm_2" && ch[2].key === `yolko-sub-${sub.id}-2026-12-05-1`, "the new card is charged, under a new idempotency key");
ok(sub.paymentMethod === "pm_2" && sub.card.last4 === "4444" && sub.failures === 0 && !sub.failedFor && sub.nextRun === "2026-12-12" && stripe.detached.includes("pm_1"), "the new card is kept, the old one let go, and the order moves on");
ok(orders()[0].pickupDate === "5 Dec" && orders()[0].paymentStatus === "paid" && stock() === 56, "Saturday 5 Dec is a paid order after all");
r = await call("GET", `${page}&card=${setup.id}`);
ok(charges().length === 3 && r.to.endsWith("&ok=card"), "reloading the return link charges nothing more");
r = await call("GET", "/api/admin/subscriptions", { headers: admin });
ok(r.data.week.failed === 0 && r.data.week.charged === 1 && r.data.week.chargedTrays === 2 && r.data.week.chargedTotal === 25 && r.data.lastRun.declined === 0 && r.data.lastRun.charged === 1, "admin: the fixed card counts as charged, not failed");

/* ---------- 9. Stripe is down: wait and try again, never a second order ---------- */
at("2026-12-10T10:15");
await cron();
stripe.charge = () => ({ status: 500, body: { error: { type: "api_error", message: "Something went wrong on Stripe's end" } } });
at("2026-12-11T00:15");
await cron();
sub = subOf();
ok(charges().length === 4 && sub.failures === 0 && !sub.failedFor && sub.nextRun === "2026-12-12", "Stripe error: nobody is blamed");
ok(kv("sub:lastrun").error.includes("Stripe's end") && mailbox.at(-1).toAddress === "orders@getyolko.com" && mailbox.at(-1).subject.includes("not charged yet"), "Stripe error: the shop is told, once");
const shopMails = mailbox.filter((m) => m.toAddress === "orders@getyolko.com").length;
stripe.charge = null;
at("2026-12-11T00:30");
await cron();
ok(charges().length === 5 && charges()[4].key === charges()[3].key && subOf().nextRun === "2026-12-19", "next tick: the same charge is tried again and goes through");
ok(orders().filter((o) => o.pickupDate === "12 Dec").length === 1 && mailbox.filter((m) => m.toAddress === "orders@getyolko.com").length === shopMails, "one order for 12 Dec, and no second alert");

/* ---------- 10. Pause, resume, change, cancel ---------- */
at("2026-12-14T12:00");
r = await call("POST", `${page}&do=pause`);
ok(r.to.endsWith("&ok=paused") && subOf().status === "paused" && subOf().pauseWhy === "customer", "pause");
r = await call("GET", page);
ok(r.text.includes("is paused") && r.text.includes("Start again from Saturday 19 Dec"), "paused page offers to start again");
at("2026-12-17T10:15");
await cron();
at("2026-12-18T00:15");
await cron();
ok(charges().length === 5 && !mailbox.some((m) => m.subject.includes("19 Dec")), "paused: no notice, no charge, and no \"order again\" reminder either");
at("2026-12-22T12:00");
r = await call("POST", `${page}&do=resume`);
ok(r.to.endsWith("&ok=resumed") && subOf().status === "active" && subOf().nextRun === "2026-12-26", "resume: back on from the next open Saturday");
r = await call("GET", `${page}&do=change`);
ok(r.text.includes('value="box"') && r.text.includes("Fortnightly"), "change page lists sizes and how often");
r = await call("POST", `${page}&do=change`, { form: { bundle: "box", every: "2" } });
sub = subOf();
ok(r.to.endsWith("&ok=changed") && sub.bundle === "box" && sub.every === 2 && sub.nextRun === "2026-12-26", "change: full box, fortnightly, next delivery stays");
r = await call("POST", `${page}&do=change`, { form: { bundle: "fr1500-1", every: "9" } });
ok(subOf().bundle === "box" && subOf().every === 2, "change: only the main tray sizes and the two rhythms are taken");
at("2026-12-25T00:15");
await cron();
ch = charges();
sub = subOf();
ok(ch.length === 6 && ch[5].params.get("amount") === "7200" && sub.nextRun === "2027-01-09" && orders()[0].bundle === "box" && orders()[0].pickupDate === "26 Dec", "fortnightly box: $72 charged, then two weeks to 9 Jan");
at("2026-12-31T10:15");
await cron();
at("2027-01-01T00:15");
await cron();
ok(charges().length === 6, "fortnightly: the week in between is left alone");
r = await call("GET", `${page}&do=cancel`);
ok(r.text.includes("Cancel your fortnightly order?") && subOf().status === "active", "cancel link only asks");
r = await call("POST", `${page}&do=cancel`);
ok(r.status === 303 && subOf().status === "cancelled" && stripe.detached.includes("pm_2"), "cancel: stopped, and the card is let go");
r = await call("GET", page);
ok(r.text.includes("is cancelled") && r.text.includes("Order eggs"), "cancelled page");
r = await call("POST", `${page}&do=resume`);
ok(subOf().status === "cancelled", "a cancelled order cannot be started again from an old link");
at("2027-01-07T10:15");
await cron();
at("2027-01-08T00:15");
await cron();
ok(charges().length === 6, "cancelled: never charged again");
ok(mailbox.at(-1).toAddress === "priya@example.com" && mailbox.at(-1).subject.startsWith("Eggs this Saturday, 9 Jan?"), "cancelled: the ordinary Thursday reminder they asked for comes back");

/* ---------- 11. Two failures in a row pause it; a new card starts it again ---------- */
at("2027-01-11T09:00");
r = await buy({ repeat: 2, phone: "0423456789", name: "Mai Tran", deliveryStreet: "8 Rose Avenue", bundle: "tray1" });
const cs = [...stripe.sessions.values()].at(-1);
ok(/every second Thursday night/.test(cs.sent.get("custom_text[submit][message]")) && r.data.price === 13, "fortnightly first order: $13, the pay page says every second Thursday");
await pay(cs.id, { email: "mai@example.com", customer: "cus_2", pm: "pm_9" });
let mai = subOf(0);
ok(mai.every === 2 && mai.nextRun === "2027-01-30" && mai.lastRun === "2027-01-16" && orderMail.at(-1).html.includes("Every second Saturday"), "fortnightly: next delivery two weeks after the first");
const maiPage = `/subscription?t=${mai.token}`;
stripe.charge = () => ({ status: 402, body: { error: { type: "card_error", code: "expired_card", message: "Your card has expired." } } });
at("2027-01-29T00:15");
await cron();
at("2027-02-12T00:15");
await cron();
mai = subOf(0);
ok(mai.failures === 2 && mai.status === "paused" && mai.pauseWhy === "card", "second failed charge in a row pauses the order");
ok(orderMail.at(-1).html.includes("is paused") && orderMail.at(-1).to === "mai@example.com", "and the email says it is paused");
r = await call("POST", `${maiPage}&do=resume`);
ok(subOf(0).status === "paused", "it cannot be resumed without a new card");
at("2027-02-15T10:00");
r = await call("POST", `${maiPage}&do=card`);
const setup2 = [...stripe.sessions.values()].at(-1);
Object.assign(setup2, { status: "complete", setup_intent: { id: "seti_2", payment_method: { id: "pm_10", card: { brand: "visa", last4: "1111" } } } });
stripe.charge = null;
const n = charges().length;
r = await call("GET", `${maiPage}&card=${setup2.id}`);
mai = subOf(0);
ok(r.to.endsWith("&ok=card") && mai.status === "active" && mai.paymentMethod === "pm_10" && mai.nextRun === "2027-02-20" && charges().length === n, "new card outside a run: active again from the next Saturday, nothing charged today");

/* ---------- 12. The shop's own controls ---------- */
r = await call("POST", "/api/admin/subscriptions", { headers: admin, body: { id: mai.id, action: "skip", for: "2027-02-20" } });
ok(r.status === 200 && r.data.did === "skipped" && subOf(0).nextRun === "2027-03-06", "admin: skip the next one (fortnightly moves two weeks)");
r = await call("POST", "/api/admin/subscriptions", { headers: admin, body: { id: mai.id, action: "unskip" } });
ok(r.data.did === "unskipped" && subOf(0).nextRun === "2027-02-20", "admin: undo the skip");
r = await call("POST", "/api/admin/subscriptions", { headers: admin, body: { on: false } });
ok(r.data.on === false, "admin: pause everyone");
at("2027-02-18T10:15");
await cron();
at("2027-02-19T00:15");
await cron();
ok(charges().length === n && subOf(0).status === "active", "paused for everyone: no notices, no charges, nobody is cancelled");
r = await call("POST", "/api/admin/subscriptions", { headers: admin, body: { on: true } });
at("2027-02-19T09:00");
await cron();
ok(charges().length === n + 1 && subOf(0).nextRun === "2027-03-06", "switched back on before Friday noon: the run still goes");
at("2027-02-19T12:15");
r = await call("GET", "/api/admin/subscriptions", { headers: admin });
ok(r.data.week.sat === "2027-02-27" && r.data.week.due === 0, "after Friday noon the admin looks at the following Saturday");
r = await call("POST", "/api/admin/subscriptions", { headers: admin, body: { id: mai.id, action: "cancel" } });
ok(r.data.did === "cancelled" && subOf(0).status === "cancelled" && subOf(0).cancelledBy === "shop", "admin: cancel");

/* ---------- 13. The Stripe self-check ---------- */
stripe.charge = () => ({ status: 400, body: { error: { type: "invalid_request_error", param: "amount", message: "Missing required param: amount." } } });
r = await call("POST", "/api/admin/subscriptions/check", { headers: admin });
ok(r.data.ok && r.data.saveCard === "ok" && r.data.chargeLater === "ok", "self-check: passes when Stripe takes both");
stripe.charge = () => ({ status: 403, body: { error: { type: "invalid_request_error", message: "The provided key does not have the required permissions" } } });
r = await call("POST", "/api/admin/subscriptions/check", { headers: admin });
ok(!r.data.ok && /permissions/.test(r.data.chargeLater), "self-check: says when the key may not charge");

if (failed) console.log(`${failed} check(s) failed`);
else console.log("repeat order tests passed");
process.exit(failed ? 1 : 0);
