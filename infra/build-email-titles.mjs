// Draws the email heading pictures listed in infra/email-titles.mjs into assets/brand/email/.
// Run: node infra/build-email-titles.mjs   (needs Playwright's Chromium, like the other ops tools;
// set CHROMIUM_PATH to use a Chromium that is already on the machine)
// The pictures are 3x, so they stay sharp on any phone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { EMAIL_TITLES, EMAIL_TITLE_W, EMAIL_TITLE_PAD, EMAIL_TITLE_LINE, emailTitlePicture } from "./email-titles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets/brand/email");
const b64 = (p) => fs.readFileSync(path.join(root, p)).toString("base64");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const font = b64("assets/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2");
const brush = b64("assets/brand/email/underline-1.png");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 3 });
for (const t of EMAIL_TITLES) {
  if (t.lines.join(" ") !== t.title) throw new Error(`lines do not spell the heading: ${t.title}`);
  if (!t.title.includes(t.mark)) throw new Error(`mark is not in the heading: ${t.title}`);
  const pic = emailTitlePicture(t.title, t.mark);
  const lines = t.lines
    .map((l) => {
      const i = l.indexOf(t.mark);
      const body = i < 0 ? esc(l) : `${esc(l.slice(0, i))}<span class="mark">${esc(t.mark)}</span>${esc(l.slice(i + t.mark.length))}`;
      return `<div class="line"><span class="words">${body}</span></div>`;
    })
    .join("");
  await page.setViewportSize({ width: pic.width, height: pic.height });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:400 800;src:url(data:font/woff2;base64,${font}) format("woff2")}
html,body{margin:0;background:transparent}
.plate{box-sizing:border-box;width:${pic.width}px;height:${pic.height}px;padding:${EMAIL_TITLE_PAD}px;background:#ffffff;border-radius:12px;font-family:"Plus Jakarta Sans";font-size:28px;line-height:${EMAIL_TITLE_LINE}px;font-weight:800;letter-spacing:-0.8px;color:#14120e;-webkit-font-smoothing:antialiased}
.line{height:${EMAIL_TITLE_LINE}px;white-space:nowrap}
.mark{background:url(data:image/png;base64,${brush}) no-repeat 50% 100%/100% 12px}
</style></head><body><div class="plate">${lines}</div></body></html>`);
  await page.evaluate(() => document.fonts.load('800 28px "Plus Jakarta Sans"'));
  await page.evaluate(() => document.fonts.ready);
  const widest = await page.evaluate(() => Math.max(...[...document.querySelectorAll(".words")].map((e) => e.getBoundingClientRect().width)));
  const room = EMAIL_TITLE_W - 2 * EMAIL_TITLE_PAD;
  if (widest > room) throw new Error(`"${t.title}" is ${Math.ceil(widest)}px wide, the plate holds ${room}px: break it into more lines`);
  await page.screenshot({ path: path.join(out, t.file), omitBackground: true });
  console.log(`${t.file}  ${pic.width} x ${pic.height}  widest line ${Math.ceil(widest)}px`);
}
await browser.close();
