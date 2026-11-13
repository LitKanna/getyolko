#!/usr/bin/env node
/** Checks for YOLKO's phone line (infra/phone-line.mjs). Run: npm run test:phone-line */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LINE_NUMBER,
  prettyAuNumber,
  validForwardTo,
  sameText,
  voiceAnswer,
  voiceAfter,
  textFromWebhook,
  textEmail,
} from "./phone-line.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Numbers read the way people say them.
assert.equal(prettyAuNumber(LINE_NUMBER), "0480 093 935");
assert.equal(prettyAuNumber("+61291234567"), "(02) 9123 4567");
assert.equal(prettyAuNumber("WhatsApp"), "WhatsApp");

// Calls only go on to an Australian number written +61.
assert.equal(validForwardTo("+61412345678"), true);
assert.equal(validForwardTo("0412345678"), false);
assert.equal(validForwardTo("+14155550100"), false);
assert.equal(validForwardTo(""), false);

assert.equal(sameText("abc", "abc"), true);
assert.equal(sameText("abc", "abd"), false);
assert.equal(sameText("abc", "abcd"), false);
assert.equal(sameText(undefined, ""), true);

// With a phone saved, a call rings it and shows the line as the caller.
const after = "https://getyolko.com/api/line/voice/k?after=1";
const ring = voiceAnswer({ forwardTo: "+61412345678" }, after);
assert.match(ring, /<Dial [^>]*callerId="\+61480093935"/);
assert.match(ring, /answerOnBridge="true"/);
assert.match(ring, /action="https:\/\/getyolko\.com\/api\/line\/voice\/k\?after=1"/);
assert.match(ring, /<Number>\+61412345678<\/Number>/);
assert.doesNotMatch(ring, /<Say/);

// With none, or a number that is not Australian, the caller hears the message and nothing is dialled.
for (const config of [null, {}, { forwardTo: "+14155550100" }, { forwardTo: "<Number>" }]) {
  const out = voiceAnswer(config, after);
  assert.match(out, /<Say language="en-AU">/);
  assert.doesNotMatch(out, /<Dial/);
}

// After the ring: answered calls just end, the rest hear the message.
assert.doesNotMatch(voiceAfter("completed"), /<Say/);
assert.doesNotMatch(voiceAfter("answered"), /<Say/);
for (const status of ["no-answer", "busy", "failed", "canceled", "", undefined]) assert.match(voiceAfter(status), /<Say/);

// A text from Telnyx.
const hook = {
  data: {
    event_type: "message.received",
    id: "evt-1",
    occurred_at: "2026-11-13T07:00:00Z",
    payload: { id: "msg-1", from: { phone_number: "+61412345678" }, to: [{ phone_number: LINE_NUMBER }], text: "Do you deliver to Rhodes?", media: [] },
  },
};
const msg = textFromWebhook(hook);
assert.deepEqual(msg, { id: "msg-1", from: "+61412345678", text: "Do you deliver to Rhodes?", pictures: 0, at: "2026-11-13T07:00:00Z" });
assert.equal(textFromWebhook({ data: { event_type: "message.sent", payload: hook.data.payload } }), null);
assert.equal(textFromWebhook({ data: { event_type: "message.received", payload: { from: {}, id: "x" } } }), null);
assert.equal(textFromWebhook(null), null);

const mail = textEmail(msg);
assert.equal(mail.subject, "Text from 0412 345 678");
assert.match(mail.text, /^Do you deliver to Rhodes\?/);
assert.match(mail.text, /0480 093 935/);
assert.match(textEmail({ ...msg, text: "", pictures: 1 }).text, /^\(A picture with no words\.\)/);

// The old mobile must not come back anywhere a customer, a search engine or Stripe could read it.
const OLD = /0433[ -]?975[ -]?055|61[ -]?433[ -]?975[ -]?055/;
const files = [
  ...readdirSync(ROOT).filter((f) => /\.(html|js|xml|txt|webmanifest)$/.test(f)).map((f) => join(ROOT, f)),
  ...readdirSync(join(ROOT, "infra")).filter((f) => /\.(mjs|html|json)$/.test(f) && f !== "phone-line-test.mjs").map((f) => join(ROOT, "infra", f)),
];
for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), OLD, `${file} still shows the old mobile`);

console.log("phone line: ok");
