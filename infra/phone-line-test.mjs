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
  sydneyWhen,
  callEmail,
  spokenNumber,
  recordingUrlOk,
  screenAsk,
  screenDial,
  screenWhisper,
  screenAccept,
  screenAfter,
  wordsFromWebhook,
  wordsEmail,
  testRole,
  testShop,
  testShopAccept,
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

// A call leaves a note in the shop mailbox with the caller's own number, in Sydney time.
assert.equal(sydneyWhen("2026-11-16T03:56:32Z"), "2:56pm on Monday 16 November");
assert.equal(sydneyWhen("2026-07-03T23:05:00Z"), "9:05am on Saturday 4 July");
const callNote = callEmail({ from: "+61412345678", at: "2026-11-16T03:56:32Z", rang: true });
assert.equal(callNote.subject, "Call from 0412 345 678");
assert.match(callNote.text, /^0412 345 678 rang the YOLKO line, 0480 093 935, at 2:56pm on Monday 16 November\./);
assert.match(callNote.text, /rang your phone and showed the shop number/);
assert.match(callNote.text, /To ring back, call 0412 345 678\./);
// With no phone saved, the note says the caller only heard the message.
assert.match(callEmail({ from: "+61412345678", at: "2026-11-16T03:56:32Z", rang: false }).text, /No phone is saved for the line/);
// A hidden number has nothing to ring back.
for (const from of ["", "anonymous", "+", undefined]) {
  const hidden = callEmail({ from, at: "2026-11-16T03:56:32Z", rang: true });
  assert.equal(hidden.subject, "Call from a private number");
  assert.match(hidden.text, /^A private number rang the YOLKO line/);
  assert.match(hidden.text, /no number to ring back/);
  assert.doesNotMatch(hidden.text, /To ring back, call/);
}
// A caller from overseas keeps the number as it came.
assert.equal(callEmail({ from: "+14155550100", at: "2026-11-16T03:56:32Z" }).subject, "Call from +14155550100");

// Screening. Step 1: the caller is asked who they are, and up to 20 seconds are recorded.
const said = "https://getyolko.com/api/line/voice/k?step=said&f=%2B61412345678";
const wordsUrl = "https://getyolko.com/api/line/voice/k?step=words&f=%2B61412345678";
const ask = screenAsk(said, wordsUrl);
assert.match(ask, /<Say voice="Polly\.Olivia-Neural">Thanks for calling YOLKO\. After the tone, please say your name and what you are calling about\.<\/Say>/);
assert.match(ask, /<Record action="https:\/\/getyolko\.com\/api\/line\/voice\/k\?step=said&amp;f=%2B61412345678" method="POST" maxLength="20"/);
assert.match(ask, /transcription="true"[^>]*transcriptionCallback="https:\/\/getyolko\.com\/api\/line\/voice\/k\?step=words&amp;f=%2B61412345678"/);
// A caller who says nothing still gets put through.
assert.match(ask, /<Redirect method="POST">[^<]*step=said&amp;f=%2B61412345678&amp;quiet=1<\/Redirect>/);
assert.doesNotMatch(ask, /<Dial/);

// Step 2: the shop phone rings, showing the line; what it hears first comes from the screen address.
const screenUrl = "https://getyolko.com/api/line/voice/k?step=screen&f=%2B61412345678&c=abc";
const dial = screenDial("+61412345678", screenUrl, after);
assert.match(dial, /<Dial callerId="\+61480093935" timeout="25"/);
assert.match(dial, /<Number url="https:\/\/getyolko\.com\/api\/line\/voice\/k\?step=screen&amp;f=%2B61412345678&amp;c=abc" method="POST">\+61412345678<\/Number>/);
assert.doesNotMatch(dial, /answerOnBridge/);
// No phone saved: the caller hears the message.
assert.doesNotMatch(screenDial("", screenUrl, after), /<Dial/);
assert.match(screenDial("", screenUrl, after), /We have your message/);

// Step 3: whoever picks up hears the caller's number digit by digit, the recording, and "press 1".
assert.equal(spokenNumber("+61481000111"), "0 4 8 1, 0 0 0, 1 1 1");
assert.equal(spokenNumber("+61291234567"), "0 2, 9 1 2 3, 4 5 6 7");
assert.equal(spokenNumber("+14155550100"), "plus 1 4 1 5 5 5 5 0 1 0 0");
assert.equal(spokenNumber(""), "a private number");
const recording = "https://s3.amazonaws.com/telephony-recorder-prod/x/y.mp3?X-Amz-Signature=abc&X-Amz-Date=1";
const whisper = screenWhisper("+61412345678", recording, "https://getyolko.com/api/line/voice/k?step=accept&c=abc");
assert.match(whisper, /^<\?xml[^>]*>\n<Response><Gather action="[^"]*step=accept&amp;c=abc" method="POST" numDigits="1" timeout="8">/);
assert.match(whisper, /YOLKO call from 0 4 1 2, 3 4 5, 6 7 8\.<\/Say><Play>https:\/\/s3\.amazonaws\.com\/[^<]*X-Amz-Signature=abc&amp;X-Amz-Date=1<\/Play>/);
assert.match(whisper, /Press 1 to take the call\.<\/Say><\/Gather><Hangup\/><\/Response>$/);
// Only a recording Telnyx made is played; anything else is left out.
assert.equal(recordingUrlOk(recording), true);
assert.equal(recordingUrlOk("https://api.telnyx.com/v2/recordings/1/actions/download"), true);
for (const bad of ["", "http://s3.amazonaws.com/x.mp3", "https://evil.example/x.mp3", "https://amazonaws.com.evil.example/x.mp3", "javascript:alert(1)"]) {
  assert.equal(recordingUrlOk(bad), false);
  assert.doesNotMatch(screenWhisper("+61412345678", bad, "https://x/accept"), /<Play>/);
}
assert.match(screenWhisper("", "", "https://x/accept"), /YOLKO call from a private number\..*They did not leave a message\./);

// Step 4: only a 1 joins the two.
assert.doesNotMatch(screenAccept("1"), /<Hangup/);
for (const digits of ["", "2", "11", "#", undefined]) assert.match(screenAccept(digits), /<Hangup\/>/);
// After the ring: an accepted call ends quietly, everyone else hears that the message was kept.
assert.doesNotMatch(screenAfter(true), /<Say/);
assert.match(screenAfter(false), /We have your message/);

// The written words, wherever the webhook puts them.
assert.equal(wordsFromWebhook({ TranscriptionText: " Sam from the cafe, a box please. " }), "Sam from the cafe, a box please.");
assert.equal(wordsFromWebhook({ data: { payload: { transcription_text: "Two trays for Saturday" } } }), "Two trays for Saturday");
assert.equal(wordsFromWebhook({ CallSid: "x", TranscriptionStatus: "failed" }), "");
assert.equal(wordsFromWebhook(null), "");
const wordsNote = wordsEmail({ from: "+61412345678", text: "Sam from the cafe, a box please." });
assert.equal(wordsNote.subject, "Call from 0412 345 678");
assert.match(wordsNote.text, /0412 345 678 said:\n\n"Sam from the cafe, a box please\."/);
assert.match(wordsNote.text, /To ring back, call 0412 345 678\./);
assert.match(wordsEmail({ from: "", text: "Hello" }).text, /the caller said:/);

// A test call: the first call from the line's own number is the caller, a later one the shop; no test, no part.
const t0 = Date.UTC(2026, 10, 16, 4, 0, 0);
const testOn = { at: t0, until: t0 + 4 * 60 * 1000, mode: "accept" };
assert.equal(testRole(testOn, t0 + 2000), "caller");
assert.equal(testRole(testOn, t0 + 20000), "shop");
assert.equal(testRole(testOn, t0 + 5 * 60 * 1000), "");
assert.equal(testRole(testOn, t0 - 60000), "");
assert.equal(testRole(null, t0), "");
assert.equal(testRole({ at: t0, until: t0 + 3600 * 1000 }, t0 + 1000), "", "a test can never stay on for an hour");
assert.match(testShop("accept", "https://x/shop2", "https://x/words"), /<Record action="https:\/\/x\/shop2"/);
assert.match(testShop("decline", "https://x/shop2", "https://x/words"), /<Pause length="30"\/><Hangup\/>/);
assert.match(testShop("busy", "https://x/shop2", "https://x/words"), /<Reject reason="busy"\/>/);
assert.match(testShopAccept(), /<Play digits="1"\/>/);

// The old mobile must not come back anywhere a customer, a search engine or Stripe could read it.
const OLD = /0433[ -]?975[ -]?055|61[ -]?433[ -]?975[ -]?055/;
const files = [
  ...readdirSync(ROOT).filter((f) => /\.(html|js|xml|txt|webmanifest)$/.test(f)).map((f) => join(ROOT, f)),
  ...readdirSync(join(ROOT, "infra")).filter((f) => /\.(mjs|html|json)$/.test(f) && f !== "phone-line-test.mjs").map((f) => join(ROOT, "infra", f)),
];
for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), OLD, `${file} still shows the old mobile`);

console.log("phone line: ok");
