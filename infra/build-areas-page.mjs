#!/usr/bin/env node
/**
 * Fill the suburb list on egg-delivery-areas.html from the delivery zone data,
 * so the SEO coverage page always matches what checkout accepts.
 *
 * Usage: node infra/build-areas-page.mjs
 * Rewrites only the block between <!-- areas:start ... --> and <!-- areas:end -->.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUBURBS, quoteDelivery } from "./delivery-zones.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "egg-delivery-areas.html");

// Suburbs with their own landing page get a link instead of a plain chip.
const SUBURB_PAGES = [
  "Strathfield", "Homebush", "Lidcombe", "Burwood", "Concord", "Auburn",
  "Rhodes", "Ashfield", "Ryde", "Bankstown", "Parramatta",
];

// Postcode-dataset rows that are mail centres, malls, or bad data, not places people live.
const NOT_A_SUBURB = /\b(dc|bc|mc|milpo|lpo|centre|university|westfield|square|plaza|mall|aerodrome|metro)\b/i;
const SKIP_NAMES = new Set(["Wentworth Port", "Sydney South"]);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const rows = SUBURBS
  .filter((s) => !NOT_A_SUBURB.test(s.name) && !SKIP_NAMES.has(s.name))
  .map((s) => ({ ...s, q: quoteDelivery({ lat: s.lat, lng: s.lng, name: s.name, crossing: s.crossing }) }))
  .filter((s) => s.q.deliver);

// A to Z, one collapsed group per letter: people look for their suburb by name,
// and the search box above the list opens the groups that match.
const letters = [...new Set(rows.map((s) => s.name[0].toUpperCase()))].sort();
const blocks = letters.map((letter) => {
  const inGroup = rows
    .filter((s) => s.name[0].toUpperCase() === letter)
    .sort((a, b) => a.name.localeCompare(b.name));
  const items = inGroup.map((s) => {
    const pc = s.postcodes && s.postcodes.length ? ` <small>${esc(s.postcodes.join(", "))}</small>` : "";
    if (SUBURB_PAGES.includes(s.name)) {
      const slug = s.name.toLowerCase().replace(/[^a-z]+/g, "-");
      return `            <li><a href="/egg-delivery-${slug}">${esc(s.name)}${pc}</a></li>`;
    }
    return `            <li>${esc(s.name)}${pc}</li>`;
  });
  return [
    `        <details class="area-band">`,
    `          <summary>${letter} <span>${inGroup.length} ${inGroup.length === 1 ? "suburb" : "suburbs"}</span></summary>`,
    `          <ul class="areas-list">`,
    ...items,
    `          </ul>`,
    `        </details>`,
  ].join("\n");
});

const html = readFileSync(PAGE, "utf8");
const start = html.indexOf("<!-- areas:start");
const endMarker = "<!-- areas:end -->";
const end = html.indexOf(endMarker);
if (start === -1 || end === -1) throw new Error("areas markers not found in egg-delivery-areas.html");
const startLineEnd = html.indexOf("-->", start) + 3;

const out =
  html.slice(0, startLineEnd) +
  "\n" + blocks.join("\n") + "\n        " +
  html.slice(end);

writeFileSync(PAGE, out);
console.log(`egg-delivery-areas.html: ${rows.length} suburbs in ${letters.length} letter groups`);
