/**
 * YOLKO's phone line: 0480 093 935, a Telnyx number (Kanna, 13 Nov 2026).
 *
 * Kanna's own mobile used to be on the site, in the emails and on Stripe. It must not show
 * anywhere now: the line is the only public number. Telnyx asks the Worker what to do with
 * each call (`/api/line/voice/<key>`) and hands over each text (`/api/line/sms/<key>`).
 *
 * A call rings the phone saved in KV (`line:config`: { key, forwardTo }) and shows the line's
 * own number as the caller, so a shop call can be told from a private one. The saved phone is
 * private: it lives only in KV, never in this repo, and the answer that names it is given only
 * to the address that carries the key. With no phone saved, callers hear a short message.
 * A text becomes an email in the shop mailbox, so it shows in Admin > Emails with the rest.
 * A call leaves a note there too ("Call from 04.."), because the phone it rings on only ever
 * shows the line's number: the note is where the caller's own number is, to ring them back.
 *
 * Screening (Kanna, 16 Nov 2026: "can we know who is that what they want before forward to
 * me"): with `screen: true` in `line:config`, the caller is first asked for their name and
 * what they are calling about. Then the saved phone rings; whoever picks up hears the caller's
 * number and those recorded words, and presses 1 to take the call. Without the 1 (a hang-up,
 * or the mobile's own voicemail picking up) the caller hears the message instead, so a caller
 * never lands in a private voicemail. What the caller said is written down and emailed too.
 *
 * This file is not in the deploy workflow's path list: bump X-Yolko-Build in the Worker when
 * it changes, so the change deploys.
 */

export const LINE_NUMBER = "+61480093935";
export const LINE_CONFIG_KEY = "line:config";
export const LINE_LOG_KEY = "line:log";

const xml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "+61480093935" reads "0480 093 935", "+61291234567" reads "(02) 9123 4567"; others as they came. */
export function prettyAuNumber(number) {
  const n = String(number || "").replace(/[^\d+]/g, "");
  const mobile = /^\+?61(4\d{2})(\d{3})(\d{3})$/.exec(n);
  if (mobile) return `0${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  const land = /^\+?61([2378])(\d{4})(\d{4})$/.exec(n);
  if (land) return `(0${land[1]}) ${land[2]} ${land[3]}`;
  return String(number || "").slice(0, 32);
}

/** Calls only ever go on to an Australian phone, written +61... */
export function validForwardTo(number) {
  return /^\+61[2-478]\d{8}$/.test(String(number || ""));
}

/** Same text, compared without stopping at the first difference. */
export function sameText(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const SORRY =
  "Thanks for calling YOLKO. We can't take your call right now. Please email orders at get yolko dot com, or order on the website, get yolko dot com.";
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const sorry = () => `${HEAD}<Response><Say language="en-AU">${xml(SORRY)}</Say><Hangup/></Response>`;

/* ---------- Screening: ask the caller first, tell the shop before the two are joined ---------- */

// An Australian voice for everything the screened line says.
const VOICE = "Polly.Olivia-Neural";
const say = (words) => `<Say voice="${VOICE}">${xml(words)}</Say>`;

export const ASK = "Thanks for calling YOLKO. After the tone, please say your name and what you are calling about.";
const THROUGH = "Thank you. Putting you through now.";
const SORRY_SCREENED =
  "Sorry, we can't take your call right now. We have your message. You can also email orders at get yolko dot com, or order on the website, get yolko dot com.";
const TRANSCRIBE = 'transcription="true" transcriptionEngine="Deepgram" transcriptionModel="deepgram/nova-3" transcriptionLanguage="en-AU"';

/** The sorry message a screened caller hears: their words were kept, so it says so. */
export const sorryScreened = () => `${HEAD}<Response>${say(SORRY_SCREENED)}<Hangup/></Response>`;

/** "+61481000111" is read out "0 4 8 1, 0 0 0, 1 1 1", one digit at a time. */
export function spokenNumber(number) {
  const digits = String(number || "").replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 6) return "a private number";
  return prettyAuNumber(digits)
    .replace(/[()]/g, "")
    .trim()
    .split(/\s+/)
    .map((group) => group.split("").map((c) => (c === "+" ? "plus" : c)).join(" "))
    .join(", ");
}

/** Only a recording Telnyx itself made is ever played back to the shop. */
export function recordingUrlOk(u) {
  try {
    const url = new URL(String(u || ""));
    return url.protocol === "https:" && /(^|\.)(telnyx\.com|telnyx\.eu|amazonaws\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Step 1, to the caller: ask who they are and what they want, and record up to 20 seconds.
 * `saidUrl` is asked when they stop talking (or say nothing); `wordsUrl` gets the written words.
 */
export function screenAsk(saidUrl, wordsUrl) {
  const quiet = `${saidUrl}${saidUrl.includes("?") ? "&" : "?"}quiet=1`;
  return `${HEAD}<Response>${say(ASK)}<Record action="${xml(saidUrl)}" method="POST" maxLength="20" timeout="3" finishOnKey="#" playBeep="true" channels="single" ${TRANSCRIBE} transcriptionCallback="${xml(wordsUrl)}"/><Redirect method="POST">${xml(quiet)}</Redirect></Response>`;
}

/**
 * Step 2, to the caller: ring the shop. `screenUrl` is asked when the shop picks up, before
 * the two are joined; `afterUrl` once the ring ends.
 */
export function screenDial(forwardTo, screenUrl, afterUrl) {
  if (!validForwardTo(forwardTo)) return sorryScreened();
  return `${HEAD}<Response>${say(THROUGH)}<Dial callerId="${LINE_NUMBER}" timeout="25" ringTone="au" action="${xml(afterUrl)}" method="POST"><Number url="${xml(screenUrl)}" method="POST">${xml(forwardTo)}</Number></Dial></Response>`;
}

/**
 * Step 3, to whoever picked up the shop phone, before the caller can hear them: the caller's
 * number, the caller's own recorded words, and "press 1". No 1 within a few seconds ends this
 * leg, and the caller hears the message.
 */
export function screenWhisper(from, recording, acceptUrl) {
  const words = recordingUrlOk(recording) ? `<Play>${xml(recording)}</Play>` : say("They did not leave a message.");
  return `${HEAD}<Response><Gather action="${xml(acceptUrl)}" method="POST" numDigits="1" timeout="8">${say(`YOLKO call from ${spokenNumber(from)}.`)}${words}${say("Press 1 to take the call.")}</Gather><Hangup/></Response>`;
}

/** Step 4: a 1 joins the two. Anything else ends the shop's leg. */
export function screenAccept(digits) {
  return String(digits || "").trim() === "1" ? `${HEAD}<Response></Response>` : `${HEAD}<Response><Hangup/></Response>`;
}

/** After a screened ring: an accepted call just ends, every other caller hears the message. */
export function screenAfter(accepted) {
  return accepted ? `${HEAD}<Response><Hangup/></Response>` : sorryScreened();
}

/** The written words of a recording, wherever the webhook carries them (form fields or JSON). */
export function wordsFromWebhook(fields) {
  const seen = new Set();
  const look = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
    seen.add(value);
    for (const key of ["TranscriptionText", "transcription_text", "Transcript", "transcript", "transcription", "text"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    for (const inner of Object.values(value)) {
      const found = look(inner, depth + 1);
      if (found) return found;
    }
    return "";
  };
  return look(fields, 0).slice(0, 1000);
}

/** The second note a screened call leaves: what the caller said, written down. */
export function wordsEmail(call) {
  const number = String(call?.from || "").replace(/[^\d+]/g, "");
  const known = number.replace(/\D/g, "").length >= 6;
  const who = known ? prettyAuNumber(number) : "a private number";
  const words = String(call?.text || "").trim();
  const last = known ? `To ring back, call ${who}. A reply to this email does not reach them.` : "The caller hid their number, so there is no number to ring back.";
  return {
    subject: `Call from ${who}`,
    text: `When the YOLKO line asked who was calling, ${known ? who : "the caller"} said:\n\n"${words}"\n\nThe words were written down by a machine, so a name can come out wrong. ${last}`,
  };
}

/* ---------- A full test call that never rings the shop phone ----------
 * The line rings itself (through the Telnyx API) while `line:test` in KV says a test is on:
 * { at, until, mode }. The first call from the line's own number plays the caller, a later one
 * plays the shop: it listens, then presses 1 ("accept"), waits ("decline") or is busy ("busy").
 * Outside a test, a call from the line's own number only ever hears the message.
 */
export function testRole(test, now = Date.now()) {
  const at = Number(test?.at) || 0;
  const until = Number(test?.until) || 0;
  if (!at || !until || until - at > 5 * 60 * 1000 || now < at - 5000 || now >= until) return "";
  return now < at + 9000 ? "caller" : "shop";
}

/** What the pretend shop does when its phone "rings" in a test. */
export function testShop(mode, nextUrl, wordsUrl) {
  if (mode === "busy") return `${HEAD}<Response><Reject reason="busy"/></Response>`;
  if (mode === "decline") return `${HEAD}<Response><Pause length="30"/><Hangup/></Response>`;
  return `${HEAD}<Response><Record action="${xml(nextUrl)}" method="POST" maxLength="13" timeout="13" playBeep="false" channels="single" ${TRANSCRIBE} transcriptionCallback="${xml(wordsUrl)}"/><Redirect method="POST">${xml(nextUrl)}</Redirect></Response>`;
}

/** The pretend shop presses 1, says hello and hangs up. */
export const testShopAccept = () =>
  `${HEAD}<Response><Play digits="1"/><Pause length="2"/>${say("Hello, this is the shop speaking.")}<Pause length="6"/><Hangup/></Response>`;

/**
 * What Telnyx should do with a call that just arrived (TeXML). `afterUrl` is asked once the
 * ring ends, so a caller nobody picked up for hears the message and one who was answered does
 * not. answerOnBridge keeps the caller on the ringing tone until the shop picks up, so a
 * recorded caller (a sign-up code call, say) starts from its first word.
 */
export function voiceAnswer(config, afterUrl) {
  if (!validForwardTo(config?.forwardTo)) return sorry();
  return `${HEAD}<Response><Dial callerId="${LINE_NUMBER}" timeout="25" answerOnBridge="true" ringTone="au" action="${xml(afterUrl)}" method="POST"><Number>${xml(config.forwardTo)}</Number></Dial></Response>`;
}

/** What to do once the ring ended: nothing more if the shop answered, the message if not. */
export function voiceAfter(dialStatus) {
  const status = String(dialStatus || "").toLowerCase();
  if (status === "completed" || status === "answered") return `${HEAD}<Response><Hangup/></Response>`;
  return sorry();
}

/** The sender and words of a text from a Telnyx message webhook; null when it is not a text to the line. */
export function textFromWebhook(body) {
  const data = body?.data;
  if (!data || data.event_type !== "message.received") return null;
  const p = data.payload || {};
  const from = String(p.from?.phone_number || "").replace(/[^\d+A-Za-z ]/g, "").slice(0, 32);
  const id = String(p.id || data.id || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 80);
  if (!from || !id) return null;
  return {
    id,
    from,
    text: String(p.text || "").slice(0, 2000),
    pictures: Array.isArray(p.media) ? p.media.length : 0,
    at: String(p.received_at || data.occurred_at || "").slice(0, 40) || null,
  };
}

/** "2:56pm on Monday 16 November", Sydney time. */
export function sydneyWhen(at) {
  const d = new Date(at || Date.now());
  const zone = { timeZone: "Australia/Sydney" };
  const time = new Intl.DateTimeFormat("en-AU", { ...zone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .replace(/\s+/g, "")
    .toLowerCase();
  const day = new Intl.DateTimeFormat("en-AU", { ...zone, weekday: "long", day: "numeric", month: "long" }).format(d).replace(/,/g, "");
  return `${time} on ${day}`;
}

/**
 * The note a call leaves in the shop mailbox. The phone a call rings on shows the line as the
 * caller, so this note is the only place the caller's own number can be read to ring them back.
 * `rang` is false when no phone is saved and the caller only heard the message.
 */
export function callEmail(call) {
  const number = String(call?.from || "").replace(/[^\d+]/g, "");
  const known = number.replace(/\D/g, "").length >= 6;
  const who = known ? prettyAuNumber(number) : "a private number";
  const line = prettyAuNumber(LINE_NUMBER);
  const first = `${known ? who : "A private number"} rang the YOLKO line, ${line}, at ${sydneyWhen(call?.at)}.`;
  const second = call?.rang === false
    ? "No phone is saved for the line, so the caller heard the message asking them to email or order on the website."
    : "The call rang your phone and showed the shop number as the caller.";
  const last = known
    ? `To ring back, call ${who}. A reply to this email does not reach them.`
    : "The caller hid their number, so there is no number to ring back.";
  return { subject: `Call from ${who}`, text: `${first}\n\n${second} ${last}` };
}

/** The email a text turns into, for the shop mailbox. */
export function textEmail(msg) {
  const from = prettyAuNumber(msg.from);
  const words = msg.text.trim() || (msg.pictures ? "(A picture with no words.)" : "(No words.)");
  return {
    subject: `Text from ${from}`,
    text: `${words}\n\nSent as a text to the YOLKO line, ${prettyAuNumber(LINE_NUMBER)}. To answer, text or call ${from}. A reply to this email does not reach them.`,
  };
}
