// Email headings as pictures. Gmail never loads a web font, so a heading written as text shows in
// the phone's own font there. Each customer email has one fixed heading, so it is drawn once in
// Plus Jakarta Sans ExtraBold (with the yolk brush stroke) by `node infra/build-email-titles.mjs`
// and sent as a picture; the words stay in the alt text. A heading that is not in this list is
// sent as text, as before.
//
// The picture is a white rounded plate with 12px of room on every side, like the logo's plate, so
// the heading still reads when a phone's dark mode recolours the email around it. Mail apps keep
// their copy of a picture for good: changed words or a changed look need a NEW file name.

/** Width of every heading picture in the email, plate included (CSS pixels). */
export const EMAIL_TITLE_W = 340;
/** Room inside the plate, on every side. */
export const EMAIL_TITLE_PAD = 12;
/** Height of one line of heading: 28px type on a 34px line, the same as the text heading. */
export const EMAIL_TITLE_LINE = 34;

/** `lines` are the heading as it is drawn; joined by spaces they must equal `title`. */
export const EMAIL_TITLES = [
  { title: "Your eggs are booked for Saturday", mark: "Saturday", lines: ["Your eggs are booked", "for Saturday"], file: "title-booked-1.png" },
  { title: "Your refund is on its way", mark: "refund", lines: ["Your refund", "is on its way"], file: "title-refund-1.png" },
  { title: "Eggs this Saturday?", mark: "Saturday", lines: ["Eggs this Saturday?"], file: "title-reminder-1.png" },
];

/** The picture for a heading: `{ file, width, height }`, or null when it has none. */
export function emailTitlePicture(title, mark = "") {
  const t = EMAIL_TITLES.find((x) => x.title === String(title) && x.mark === String(mark));
  if (!t) return null;
  return { file: t.file, width: EMAIL_TITLE_W, height: t.lines.length * EMAIL_TITLE_LINE + 2 * EMAIL_TITLE_PAD };
}
