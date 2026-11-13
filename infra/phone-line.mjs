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

/** The email a text turns into, for the shop mailbox. */
export function textEmail(msg) {
  const from = prettyAuNumber(msg.from);
  const words = msg.text.trim() || (msg.pictures ? "(A picture with no words.)" : "(No words.)");
  return {
    subject: `Text from ${from}`,
    text: `${words}\n\nSent as a text to the YOLKO line, ${prettyAuNumber(LINE_NUMBER)}. To answer, text or call ${from}. A reply to this email does not reach them.`,
  };
}
