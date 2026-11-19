// node infra/order-email-backup-test.mjs : an order email the order sender (Zoho CPaaS) will not
// take goes out from the shop's mailbox instead, and is never sent twice. Pulls sendFromMailbox
// and sendCustomerEmail out of the Worker and runs them against a pretend CPaaS and mailbox.
import fs from "node:fs";
const src = fs.readFileSync(new URL("./cloudflare-worker.mjs", import.meta.url), "utf8");
const cut = (name) => {
  const i = src.indexOf(`async function ${name}(`);
  const j = src.indexOf("\n}\n", i);
  if (i < 0 || j < 0) throw new Error(`${name} is missing from the Worker`);
  return src.slice(i, j + 2);
};
const body = `const STRIPE_BRAND = "YOLKO"; const SHOP_EMAIL = "orders@getyolko.com"; const ZEPTOMAIL_DEFAULT_URL = "https://cpaas.test/v1.1/email";
const testSubject = (s) => "[Test] " + s;
${cut("sendFromMailbox")}
${cut("sendCustomerEmail")}
return sendCustomerEmail;`;

const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };
const env = { ZEPTOMAIL_TOKEN: "key", ORDER_EMAIL_FROM: "orders@getyolko.com" };
const order = { name: "Sam", email: "sam@example.com" };
const mail = { subject: "Your YOLKO order is confirmed", html: "<p>Thanks</p>", text: "Thanks" };

let cpaasCalls, mailboxCalls;
/** cpaas: a function giving { status, json } or throwing; mailbox: "ok", "off" (not connected) or "down". */
const make = (cpaas, mailbox = "ok") => {
  cpaasCalls = [];
  mailboxCalls = [];
  const fetch = async (url, opts) => {
    cpaasCalls.push(JSON.parse(opts.body));
    const r = cpaas();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  const zohoAuth = async () => (mailbox === "off" ? null : { refreshToken: "x" });
  const zohoMailAccount = async () => ({ accountId: "77", address: "orders@getyolko.com" });
  const zohoMailSend = async (e, auth, path, m) => {
    mailboxCalls.push({ path, ...m });
    if (mailbox === "down") throw new Error("Zoho Mail said HTTP 500");
    return { data: {} };
  };
  return new Function("fetch", "zohoAuth", "zohoMailAccount", "zohoMailSend", body)(fetch, zohoAuth, zohoMailAccount, zohoMailSend);
};
const noCredit = () => ({ status: 403, json: { error: { message: "Access Denied", details: [{ message: "Credits expired" }] } } });

// 1. CPaaS takes the email: one request, the mailbox is never touched
let r = await make(() => ({ status: 201, json: { request_id: "req1" } }))(env, order, mail);
ok(r.ok && r.requestId === "req1" && !r.via && cpaasCalls.length === 1 && mailboxCalls.length === 0, "CPaaS took it: sent once, no mailbox");

// 2. CPaaS says no (the credit lapsed): the same email goes from the mailbox, once
r = await make(noCredit)(env, order, mail);
ok(r.ok && r.via === "mailbox" && r.requestId === null && r.cpaasError === "Credits expired", "CPaaS said no: sent from the mailbox");
ok(cpaasCalls.length === 1 && mailboxCalls.length === 1, "one try each, nothing twice");
ok(mailboxCalls[0].toAddress === "sam@example.com" && mailboxCalls[0].subject === mail.subject && mailboxCalls[0].content === mail.html && mailboxCalls[0].mailFormat === "html", "the mailbox copy is the same email");
ok(mailboxCalls[0].fromAddress === "orders@getyolko.com" && mailboxCalls[0].path === "/accounts/77/messages" && !("bccAddress" in mailboxCalls[0]), "it goes from the shop's address, with no copy line unless one is set");

// 3. A server error is also an answer of no: the mailbox takes it
r = await make(() => ({ status: 503, json: null }))(env, order, mail);
ok(r.ok && r.via === "mailbox" && r.cpaasError === "HTTP 503", "CPaaS server error: sent from the mailbox");

// 4. CPaaS says no and the mailbox is not connected: the failure comes back with both reasons
r = await make(noCredit, "off")(env, order, mail);
ok(!r.ok && r.error === "Credits expired" && r.mailboxError === "mailbox not connected" && r.transient === false && mailboxCalls.length === 0, "no mailbox: failure with both reasons");

// 5. CPaaS says no and the mailbox fails too
r = await make(noCredit, "down")(env, order, mail);
ok(!r.ok && r.error === "Credits expired" && /HTTP 500/.test(r.mailboxError) && mailboxCalls.length === 1, "both refused: failure, one mailbox try");
r = await make(() => ({ status: 429, json: null }), "down")(env, order, mail);
ok(!r.ok && r.transient === true, "a limit that the mailbox could not cover is still tried again later");

// 6. No answer from CPaaS (a timeout): that try may have gone, so the mailbox must not send a second copy
r = await make(() => { throw new Error("The operation timed out"); })(env, order, mail);
ok(!r.ok && r.transient === true && mailboxCalls.length === 0, "no answer: left to the retry, no mailbox copy");

// 7. A caller with its own second path can switch the backup off
r = await make(noCredit)(env, order, mail, { backup: false });
ok(!r.ok && r.error === "Credits expired" && mailboxCalls.length === 0 && !("mailboxError" in r), "backup off: plain failure");

// 8. An admin sample keeps its [Test] mark on the mailbox copy
r = await make(noCredit)(env, order, mail, { test: true });
ok(r.ok && mailboxCalls[0].subject === "[Test] " + mail.subject, "a sample stays marked as a test");

// 9. The shop's copy line, when one is set, rides along on the mailbox copy
r = await make(noCredit)({ ...env, ORDER_NOTIFY_EMAIL: "shop@example.com" }, order, mail);
ok(r.ok && mailboxCalls[0].bccAddress === "shop@example.com", "the shop's copy goes with the mailbox email");

// 10. Nothing to send to, or sending not set up: no request anywhere
r = await make(noCredit)(env, { name: "Sam" }, mail);
ok(!r.ok && r.skipped && cpaasCalls.length === 0 && mailboxCalls.length === 0, "no customer address: skipped");
r = await make(noCredit)({}, order, mail);
ok(!r.ok && r.skipped && cpaasCalls.length === 0 && mailboxCalls.length === 0, "sending not set up: skipped");

if (!process.exitCode) console.log("order email backup: all checks passed");
