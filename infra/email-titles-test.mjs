// Checks the email heading pictures: every heading a customer email uses has its picture on disk,
// at the size the email asks for. Run: npm run test:email-titles
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMAIL_TITLES, EMAIL_TITLE_W, EMAIL_TITLE_PAD, emailTitlePicture } from "./email-titles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (ok, what) => {
  if (!ok) {
    failed++;
    console.error("FAIL " + what);
  }
};

const files = new Set();
for (const t of EMAIL_TITLES) {
  check(t.lines.join(" ") === t.title, `lines spell the heading: ${t.title}`);
  check(t.title.includes(t.mark), `the marked word is in the heading: ${t.title}`);
  check(/^title-[a-z]+-\d+\.png$/.test(t.file), `file name ends in a number to bump: ${t.file}`);
  check(!files.has(t.file), `one file per heading: ${t.file}`);
  files.add(t.file);
  const pic = emailTitlePicture(t.title, t.mark);
  check(pic && pic.width === EMAIL_TITLE_W && pic.height > 2 * EMAIL_TITLE_PAD, `picture size is known: ${t.title}`);
  const file = path.join(root, "assets/brand/email", t.file);
  if (!fs.existsSync(file)) {
    check(false, `picture is on disk: ${t.file} (run node infra/build-email-titles.mjs)`);
    continue;
  }
  const png = fs.readFileSync(file);
  check(png.subarray(1, 4).toString("latin1") === "PNG", `${t.file} is a PNG`);
  // Drawn at 3x: the PNG is three times the size the email gives it.
  check(png.readUInt32BE(16) === pic.width * 3 && png.readUInt32BE(20) === pic.height * 3, `${t.file} is ${pic.width * 3} x ${pic.height * 3}`);
  check(png.length < 60000, `${t.file} is under 60 KB`);
}

check(emailTitlePicture("Something else") === null, "a heading without a picture falls back to text");
check(emailTitlePicture("Eggs this Saturday?", "Eggs") === null, "the marked word has to match too");

// Every heading the Worker sends has a picture.
const worker = fs.readFileSync(path.join(root, "infra/cloudflare-worker.mjs"), "utf8");
const sent = [...worker.matchAll(/\btitle: "([^"]+)",\s*\n\s*mark: "([^"]*)"/g)].map((m) => [m[1], m[2]]);
check(sent.length >= 3, `found the Worker's email headings (${sent.length})`);
for (const [title, mark] of sent) check(emailTitlePicture(title, mark) !== null, `the Worker's heading has a picture: ${title}`);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("email heading pictures: all checks passed");
