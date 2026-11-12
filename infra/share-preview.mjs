/**
 * How a YOLKO link looks when someone shares it (Facebook, Messenger, WhatsApp, iMessage).
 *
 * The picture: WhatsApp only draws a link picture under 600 KB, and the 1536 px chalkboard
 * photo is just over that. So every page points og:image at the 928 px copy of the same
 * photo (about 260 KB), which Facebook still shows as a large card.
 *
 * Share links: getyolko.com/r/CODE and ?ref=CODE give a new customer free delivery, but they
 * land on the homepage, whose card says delivery is $5. The apps that read a link only to
 * draw its card get a small page that says the first delivery is free. People, and search
 * engines, always get the shop itself.
 */
export const SHARE_IMG_PX = 928;
export const SHARE_IMG_MAX_BYTES = 600 * 1024;
// Same number as IMG_V in build-pages.mjs: bump both when the photo files change.
export const SHARE_IMG_V = "112";

const SITE = "https://getyolko.com";

export function shareImage(trayPrice) {
  return `${SITE}/assets/chalk-tray/${trayPrice}-${SHARE_IMG_PX}.jpg?v=${SHARE_IMG_V}`;
}

// Apps that fetch a link only to draw its card. iMessage calls itself both of the first two.
const PREVIEW_AGENTS =
  /facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|skypeuripreview|pinterest|viber|snapchat|redditbot/i;

export function isLinkPreviewAgent(userAgent) {
  return PREVIEW_AGENTS.test(String(userAgent || ""));
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The card for a share link: what it says, and the page a link-reading app is given. */
export function referralCard({ code, trayPrice, deliveryFee }) {
  const title = "Your first egg delivery is free | YOLKO";
  const description =
    `With this link the $${deliveryFee} delivery is free on your first order. ` +
    `A tray of 30 Pace Farm cage eggs is $${trayPrice}, delivered across Sydney on Saturday morning. ` +
    "Order by Thursday night.";
  const url = `${SITE}/r/${code}`;
  const image = shareImage(trayPrice);
  const alt = `Stacked trays of Pace Farm eggs under a chalkboard sign: fresh eggs, $${trayPrice} a tray`;
  const html = `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="noindex">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="YOLKO">
  <meta property="og:locale" content="en_AU">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="${SHARE_IMG_PX}">
  <meta property="og:image:height" content="${SHARE_IMG_PX}">
  <meta property="og:image:alt" content="${esc(alt)}">
  <meta property="og:url" content="${esc(url)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <meta name="twitter:image:alt" content="${esc(alt)}">
</head>
<body>
  <p>${esc(description)}</p>
  <p><a href="${SITE}/?ref=${esc(code)}">Order eggs from YOLKO</a></p>
</body>
</html>
`;
  return { title, description, url, image, html };
}
