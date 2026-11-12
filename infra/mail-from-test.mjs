// node infra/mail-from-test.mjs : mailbox emails go out under the shop's name, and the name
// can never stop an email. Pulls zohoMailSend out of the Worker and runs it against a pretend Zoho.
import fs from "node:fs";
const src = fs.readFileSync(new URL("./cloudflare-worker.mjs", import.meta.url), "utf8");
const i = src.indexOf("async function zohoMailSend(");
const j = src.indexOf("\n}\n", i);
if (i < 0 || j < 0) throw new Error("zohoMailSend is missing from the Worker");
const make = (zoho) =>
  new Function("zohoMailFetch", `const STRIPE_BRAND = "YOLKO"; let zohoPlainFromOnly = false;\n${src.slice(i, j + 2)}\nreturn zohoMailSend;`)(zoho);
const fail = (status, extra = {}) => Object.assign(new Error("Zoho Mail said HTTP " + status), status ? { status } : {}, extra);
const mail = { fromAddress: "orders@getyolko.com", toAddress: "a@example.com", subject: "Hi", content: "<p>Hi</p>", mailFormat: "html" };
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };
let calls;
const run = async (answer) => {
  calls = [];
  const send = make(async (env, auth, path, opts) => { calls.push(opts.body); return answer(opts.body, calls.length); });
  return { send, first: await send({}, {}, "/accounts/1/messages", mail).then((data) => ({ data }), (err) => ({ err })) };
};

// 1. Zoho takes the name: one request, From carries YOLKO, the rest of the email is untouched
let r = await run(() => ({ data: { messageId: "1" } }));
ok(r.first.data && calls.length === 1 && calls[0].fromAddress === "YOLKO <orders@getyolko.com>", "named sender sent in one request");
ok(calls[0].toAddress === mail.toAddress && calls[0].subject === mail.subject && calls[0].content === mail.content && mail.fromAddress === "orders@getyolko.com", "email unchanged apart from the sender name");

// 2. Zoho refuses the name: the same email goes again with the plain address, and later sends skip the name
r = await run((body) => { if (body.fromAddress.includes("<")) throw fail(400); return { data: { messageId: "2" } }; });
ok(r.first.data?.data?.messageId === "2" && calls.length === 2 && calls[1].fromAddress === "orders@getyolko.com", "name refused: sent with the plain address");
await r.send({}, {}, "/accounts/1/messages", mail);
ok(calls.length === 3 && calls[2].fromAddress === "orders@getyolko.com", "after a refusal the next email goes plain straight away");

// 3. A server error on the named form is retried plain too
r = await run((body) => { if (body.fromAddress.includes("<")) throw fail(500); return { data: {} }; });
ok(r.first.data && calls.length === 2, "server error on the name: retried plain");

// 4. Zoho refuses the email itself: the error comes back and the name is still tried next time
r = await run(() => { throw fail(400); });
ok(r.first.err?.status === 400 && calls.length === 2, "email refused either way: error returned after two tries");
await r.send({}, {}, "/accounts/1/messages", mail).catch(() => null);
ok(calls[2].fromAddress === "YOLKO <orders@getyolko.com>", "no false note that the name was the problem");

// 5. Sign-in trouble, a rate limit or a timeout is never sent twice
for (const [label, e] of [["sign-in", fail(401, { signin: true })], ["rate limit", fail(429)], ["timeout", fail(0)], ["reconnect", fail(0, { reconnect: true })]]) {
  r = await run(() => { throw e; });
  ok(r.first.err === e && calls.length === 1, `${label}: one request, error returned`);
}

// 6. A reply keeps its action
calls = [];
const send = make(async (env, auth, path, opts) => { calls.push([path, opts.body]); return {}; });
await send({}, {}, "/accounts/1/messages/99", { ...mail, action: "reply" });
ok(calls[0][0] === "/accounts/1/messages/99" && calls[0][1].action === "reply" && calls[0][1].fromAddress.startsWith("YOLKO <"), "reply sent under the name");

if (!process.exitCode) console.log("mail sender name tests passed");
