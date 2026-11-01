#!/usr/bin/env node
/**
 * Build the secondary storefront pages from one template, so every page shares
 * the same header, footer, meta tags and structured data.
 *
 *   egg-delivery-<suburb>.html  (one per entry in SUBURB_PAGES)
 *   egg-delivery-sydney.html, bulk-eggs-sydney.html, egg-delivery-areas.html, 404.html
 *   assets/coverage-map.svg (the delivery map, from the same zone data checkout uses)
 *   sitemap.xml
 *   index.html: only the JSON-LD block, the FAQ list, the map and the
 *   next-delivery script (each between markers)
 *
 * Usage: node infra/build-pages.mjs && node infra/build-areas-page.mjs
 * (the areas page keeps its generated suburb list; build-areas-page refills it).
 *
 * Copy rules: no em dashes, never name Sydney Markets or a street address.
 * YOLKO is a home-based service-area business; only "Sydney NSW" is public.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUBURBS, quoteDelivery, haversineKm } from "./delivery-zones.mjs";
import { buildCoverageMap } from "./coverage-map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://getyolko.com";
const TODAY = new Date().toISOString().slice(0, 10);

// Bump when the files change so browsers fetch fresh copies.
const CSS_V = "151";
const FONTS_V = "77";
const IMG_V = "112";
const MAP_V = "1";

const PHONE = "+61433975055";
const PHONE_LOCAL = "0433 975 055";
const WHATSAPP = "https://wa.me/61433975055";
const EMAIL = "orders@getyolko.com";
const PRICE = { tray1: 13, tray2: 25, box: 72, delivery: 5 };
const PACKS = {
  tray1: { name: "1 tray", label: "1 tray · 30 eggs", eggs: 30, price: PRICE.tray1 },
  tray2: { name: "2 trays", label: "2 trays · 60 eggs", eggs: 60, price: PRICE.tray2 },
  box: { name: "Full box", label: "Full box · 180 eggs", eggs: 180, price: PRICE.box },
};
const MAP = buildCoverageMap();

const HERO_IMG = `${SITE}/assets/chalk-tray/${PRICE.tray1}-1536.jpg?v=${IMG_V}`;
const HERO_ALT = `Stacked trays of Pace Farm eggs under a chalkboard sign: fresh eggs, $${PRICE.tray1} a tray`;
const LOGO = `${SITE}/assets/yolko-app-icon-1024.png`;

// Suburb landing pages. `local`, `nearby` and `faq` keep each page specific to its area.
const SUBURB_PAGES = [
  {
    slug: "strathfield", name: "Strathfield", postcode: "2135", region: "Inner west",
    nearby: ["Homebush", "North Strathfield", "Strathfield South", "Enfield", "Burwood"],
    faq: ["Is North Strathfield covered?", "Yes. North Strathfield, Strathfield South and Enfield are all inside the Saturday delivery area."],
    local: `Strathfield has apartment blocks around the station and family homes on the quieter streets further out. The Korean restaurants and grocers near the station can order 180-egg boxes for the week. In the blocks, neighbours who order for the same Saturday share one trip, so every order after the first ships free.`,
  },
  {
    slug: "homebush", name: "Homebush", postcode: "2140", region: "Inner west",
    nearby: ["Homebush West", "North Strathfield", "Strathfield", "Sydney Olympic Park", "Liberty Grove"],
    faq: ["Can Olympic Park or Homebush West order?", "Yes. Both are inside the Saturday delivery area. For an apartment, put your unit number in the street address."],
    local: `Many homes around Homebush station and in Sydney Olympic Park are apartments, often several towers to one address. Put your unit and building in the street address. When two or more people in the same building order for the same Saturday, every order after the first ships free, so it is worth sharing in your building chat.`,
  },
  {
    slug: "lidcombe", name: "Lidcombe", postcode: "2141", region: "Cumberland",
    nearby: ["Berala", "Rookwood", "Lidcombe North", "Regents Park", "Auburn"],
    faq: ["Is Berala or Regents Park covered?", "Yes. Both are next to Lidcombe and inside the Saturday delivery area."],
    local: `Lidcombe has apartments close to the station and houses towards Berala and Regents Park. The restaurants around the station can order 180-egg boxes, up to 10 at a time, and families who bake or cook in bulk often take two trays for $${PRICE.tray2}.`,
  },
  {
    slug: "burwood", name: "Burwood", postcode: "2134", region: "Inner west",
    nearby: ["Burwood Heights", "Croydon", "Enfield", "Strathfield", "Ashfield"],
    faq: ["Can bakers in Burwood order extra trays?", `Yes. Two trays are $${PRICE.tray2} and a 180-egg box is $${PRICE.box}. You can order up to 10 boxes at once.`],
    local: `Burwood's apartment towers sit around the station and Westfield, with houses on the streets further out. Burwood Chinatown on Deane Street and the restaurants along Burwood Road go through a lot of eggs: a 180-egg box is $${PRICE.box}, and you can order up to 10 at once.`,
  },
  {
    slug: "concord", name: "Concord", postcode: "2137", region: "Canada Bay",
    nearby: ["Mortlake", "Breakfast Point", "Cabarita", "Concord West", "North Strathfield"],
    faq: ["Can a café on Majors Bay Road get a weekly box?", `Yes. Order the $${PRICE.box} box (180 eggs) online, or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a> to set up a weekly standing order.`],
    local: `Concord is mostly houses, with a strip of cafés along Majors Bay Road. A café can order a 180-egg box online each week, or message us on WhatsApp to set up a standing order. Homes in Breakfast Point and Cabarita get the same Saturday delivery and the same $${PRICE.delivery} fee.`,
  },
  {
    slug: "auburn", name: "Auburn", postcode: "2144", region: "Cumberland",
    nearby: ["Lidcombe", "Silverwater", "Berala", "Clyde", "Newington"],
    faq: ["Can I order from Lidcombe or Silverwater?", "Yes. Both are next to Auburn and inside the Saturday delivery area."],
    local: `Auburn has apartment blocks near the station and houses on the streets around them. The Turkish and Lebanese bakeries and sweet shops along Auburn Road can order 180-egg boxes for $${PRICE.box} each. Apartments in Newington and Silverwater are covered too: put your unit number in the street address.`,
  },
  {
    slug: "rhodes", name: "Rhodes", postcode: "2138", region: "Canada Bay",
    nearby: ["Liberty Grove", "Concord West", "Wentworth Point", "Meadowbank", "Putney"],
    faq: ["Can you deliver to my apartment building?", "Yes. Put your unit number in the street address. If we need access on the day, we message you on WhatsApp."],
    local: `Rhodes is almost all apartment towers, and so is Wentworth Point across the Bennelong Bridge. Put your unit number in the street address, and we message you on WhatsApp if we need access on the day. When neighbours in the same building order for the same Saturday, every order after the first ships free.`,
  },
  {
    slug: "ashfield", name: "Ashfield", postcode: "2131", region: "Inner west",
    nearby: ["Summer Hill", "Croydon", "Haberfield", "Ashbury", "Dulwich Hill"],
    faq: ["Do restaurants in Ashfield order boxes?", `Yes. A box is 180 eggs for $${PRICE.box}, up to 10 boxes an order. <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a> for a weekly standing order.`],
    local: `Ashfield mixes apartment blocks near the station with older houses on the side streets. The Shanghainese and other Chinese restaurants along Liverpool Road can order 180-egg boxes, up to 10 at a time, or message us on WhatsApp for a weekly standing order.`,
  },
  {
    slug: "ryde", name: "Ryde", postcode: "2112", region: "Northern Sydney",
    nearby: ["West Ryde", "Putney", "Meadowbank", "Denistone", "Tennyson Point"],
    faq: ["Do you charge more to cross the river?", `No. Delivery is a flat $${PRICE.delivery} anywhere in the delivery area, Ryde included.`],
    local: `Ryde is mostly houses, with apartments around Top Ryde and the stations at West Ryde and Meadowbank. Ryde is across the Parramatta River from most of our area, and delivery is still a flat $${PRICE.delivery}. In an apartment, put your unit number in the street address.`,
  },
  {
    slug: "bankstown", name: "Bankstown", postcode: "2200", region: "South-west",
    nearby: ["Yagoona", "Punchbowl", "Condell Park", "Bass Hill", "Greenacre"],
    faq: ["Can bakeries and sweet shops order in bulk?", `Yes. Order up to 10 boxes of 180 eggs ($${PRICE.box} each), or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a> for a weekly standing order.`],
    local: `Bankstown has apartments around the station and plenty of family homes in Yagoona, Condell Park and Greenacre. The Vietnamese bakeries and Lebanese sweet shops in Bankstown can order 180-egg boxes for $${PRICE.box} each, up to 10 at a time.`,
  },
  {
    slug: "parramatta", name: "Parramatta", postcode: "2150", region: "Western Sydney",
    nearby: ["Harris Park", "Westmead", "North Parramatta", "Rosehill", "Granville"],
    faq: ["Is Harris Park or Westmead covered?", "Yes. Both are inside the Saturday delivery area, and there is no extra charge for Parramatta."],
    local: `Central Parramatta is mostly apartment towers, and North Parramatta and Rosehill have more houses. In a tower, add your unit number, and we message you on WhatsApp if the building needs letting in. Harris Park, Sydney's Little India, is next door, and its sweet shops and restaurants can order 180-egg boxes.`,
  },
];

// Covered suburbs closest to a suburb page, with postcodes, from the same zone data checkout uses.
// 2129 (Sydney Markets) is never shown, and neither is Flemington.
const HIDDEN_POSTCODES = new Set(["2129"]);
const NOT_A_SUBURB = /\b(dc|bc|mc|milpo|lpo|centre|university|westfield|square|plaza|mall|aerodrome|metro)\b/i;
const NEARBY_SKIP = new Set(["Flemington", "Wentworth Port", "Sydney South"]);

function nearestCovered(s, count = 12) {
  const home = SUBURBS.find((x) => x.name === s.name);
  if (!home) throw new Error(`No zone data for ${s.name}`);
  return SUBURBS
    .filter((x) => x.name !== s.name && !NEARBY_SKIP.has(x.name) && !NOT_A_SUBURB.test(x.name))
    .map((x) => ({ ...x, postcodes: (x.postcodes || []).filter((p) => !HIDDEN_POSTCODES.has(p)) }))
    .filter((x) => x.postcodes.length && quoteDelivery({ lat: x.lat, lng: x.lng, name: x.name, crossing: x.crossing }).deliver)
    .map((x) => ({ ...x, km: haversineKm(home.lat, home.lng, x.lat, x.lng) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}

// Matches the Google Business Profile service areas (Google allows 20).
const SERVICE_AREAS = [
  "Ryde", "Auburn", "Rhodes", "Burwood", "Concord", "Ashfield", "Homebush", "Lidcombe",
  "Bankstown", "Five Dock", "Granville", "Parramatta", "Strathfield", "Blacktown",
  "Liverpool", "Fairfield", "Hornsby", "Chatswood", "Hurstville",
];

const pageUrl = (path) => (path === "/" ? `${SITE}/` : `${SITE}${path}`);
const suburbPath = (s) => `/egg-delivery-${s.slug}`;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Visible FAQ answers may hold links; structured data gets the plain text.
function plain(html) {
  return String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- Structured data ---------- */

const SHIPPING = {
  "@type": "OfferShippingDetails",
  shippingRate: { "@type": "MonetaryAmount", value: PRICE.delivery.toFixed(2), currency: "AUD" },
  shippingDestination: { "@type": "DefinedRegion", addressCountry: "AU", addressRegion: ["NSW"] },
  deliveryTime: {
    "@type": "ShippingDeliveryTime",
    // Orders wait for the next Saturday run, then arrive that morning.
    handlingTime: { "@type": "QuantitativeValue", minValue: 0, maxValue: 6, unitCode: "DAY" },
    transitTime: { "@type": "QuantitativeValue", minValue: 0, maxValue: 1, unitCode: "DAY" },
  },
};

function product({ id, sku, name, description, price, maxQty }) {
  const offer = {
    "@type": "Offer",
    price: price.toFixed(2),
    priceCurrency: "AUD",
    availability: "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    url: `${SITE}/#order`,
    // Google's merchant listings report asks for both ends of the price window.
    validFrom: "2026-07-01",
    priceValidUntil: "2027-06-30",
    seller: { "@id": `${SITE}/#business` },
    shippingDetails: SHIPPING,
    hasMerchantReturnPolicy: { "@id": `${SITE}/#returns` },
  };
  if (maxQty) {
    offer.eligibleQuantity = { "@type": "QuantitativeValue", minValue: 1, maxValue: maxQty, unitText: "box" };
  }
  return {
    "@type": "Product",
    "@id": id,
    sku,
    name,
    description,
    image: [HERO_IMG],
    brand: { "@type": "Brand", name: "Pace Farm" },
    category: "Eggs",
    offers: offer,
  };
}

const PRODUCT_TRAY = product({
  id: `${SITE}/#product-tray`, sku: "YOLKO-TRAY-30", name: "Fresh Egg Tray (30 eggs)",
  description: `30 fresh Pace Farm eggs for $${PRICE.tray1}. Delivered Saturday mornings in Sydney.`,
  price: PRICE.tray1,
});
const PRODUCT_TRAY2 = product({
  id: `${SITE}/#product-tray2`, sku: "YOLKO-TRAY-60", name: "Double Egg Tray (60 eggs)",
  description: `Two 30-egg Pace Farm trays for $${PRICE.tray2}. Delivered Saturday mornings in Sydney.`,
  price: PRICE.tray2,
});
const PRODUCT_BOX = product({
  id: `${SITE}/bulk-eggs-sydney#product-box`, sku: "YOLKO-BOX-180", name: "Full Box of Eggs (180 eggs)",
  description: `Six 30-egg Pace Farm XL cage trays, 180 eggs, for $${PRICE.box}. Saturday delivery across Sydney.`,
  price: PRICE.box, maxQty: 10,
});

const RETURNS = {
  "@type": "MerchantReturnPolicy",
  "@id": `${SITE}/#returns`,
  applicableCountry: "AU",
  returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
  merchantReturnLink: `${SITE}/terms`,
};

const BUSINESS = {
  "@type": ["GroceryStore", "OnlineStore"],
  "@id": `${SITE}/#business`,
  name: "YOLKO",
  alternateName: ["YOLKO Eggs", "YOLKO Sydney"],
  description: `Fresh Pace Farm egg trays delivered to homes and cafés across Sydney on Saturday mornings. 30 eggs for $${PRICE.tray1}, flat $${PRICE.delivery} delivery within 45 km.`,
  url: `${SITE}/`,
  telephone: PHONE,
  email: EMAIL,
  logo: { "@type": "ImageObject", url: LOGO, width: 1024, height: 1024 },
  image: [HERO_IMG],
  priceRange: `$${PRICE.tray1}-$${PRICE.box}`,
  currenciesAccepted: "AUD",
  paymentAccepted: "Credit Card, Debit Card",
  address: { "@type": "PostalAddress", addressLocality: "Sydney", addressRegion: "NSW", addressCountry: "AU" },
  areaServed: [
    { "@type": "City", name: "Sydney", containedInPlace: { "@type": "State", name: "New South Wales" } },
    ...SERVICE_AREAS.map((name) => ({ "@type": "Place", name: `${name} NSW` })),
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer service",
    telephone: PHONE,
    email: EMAIL,
    areaServed: "AU",
    availableLanguage: ["en"],
  },
  openingHoursSpecification: [
    { "@type": "OpeningHoursSpecification", dayOfWeek: "Saturday", opens: "06:00", closes: "12:00" },
  ],
  hasMerchantReturnPolicy: { "@id": `${SITE}/#returns` },
  hasOfferCatalog: {
    "@type": "OfferCatalog",
    name: "Egg trays and boxes",
    itemListElement: [PRODUCT_TRAY, PRODUCT_TRAY2, PRODUCT_BOX].map((p) => ({
      "@type": "Offer",
      itemOffered: { "@id": p["@id"] },
    })),
  },
};

// Other pages repeat only the essentials and point at the full node by @id.
const BUSINESS_REF = {
  "@type": BUSINESS["@type"],
  "@id": BUSINESS["@id"],
  name: BUSINESS.name,
  url: BUSINESS.url,
  telephone: PHONE,
  logo: BUSINESS.logo,
  image: BUSINESS.image,
  priceRange: BUSINESS.priceRange,
  address: BUSINESS.address,
};

const WEBSITE = {
  "@type": "WebSite",
  "@id": `${SITE}/#website`,
  url: `${SITE}/`,
  name: "YOLKO",
  alternateName: "YOLKO Eggs",
  description: "Fresh Pace Farm egg trays, delivered in Sydney.",
  publisher: { "@id": `${SITE}/#business` },
  inLanguage: "en-AU",
};

function webPage(path, name, description) {
  return {
    "@type": "WebPage",
    "@id": `${pageUrl(path)}#page`,
    url: pageUrl(path),
    name,
    description,
    isPartOf: { "@id": `${SITE}/#website` },
    about: { "@id": `${SITE}/#business` },
    primaryImageOfPage: { "@type": "ImageObject", url: HERO_IMG, width: 1536, height: 1536 },
    inLanguage: "en-AU",
    ...(path === "/" ? {} : { breadcrumb: { "@id": `${pageUrl(path)}#crumbs` } }),
  };
}

function breadcrumbs(path, trail) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageUrl(path)}#crumbs`,
    itemListElement: trail.map(([name, p], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: pageUrl(p),
    })),
  };
}

function faqPage(path, faqs) {
  return {
    "@type": "FAQPage",
    "@id": `${pageUrl(path)}#faq`,
    mainEntity: faqs.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: plain(a) },
    })),
  };
}

function jsonLd(graph, indent = "  ") {
  const body = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2)
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
  return body;
}

/* ---------- Shared markup ---------- */

const HERO_SIZES = "(max-width: 900px) calc(100vw - 40px), 560px";
const heroSrcset = (ext) =>
  [640, 928, 1536].map((w) => `assets/chalk-tray/${PRICE.tray1}-${w}.${ext}?v=${IMG_V} ${w}w`).join(", ");
const perEgg = (price, eggs) => Math.round((price / eggs) * 100);

const META_PIXEL = `  <script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window,document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '797932266678792');
  fbq('track', 'PageView');
  </script>
  <noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=797932266678792&ev=PageView&noscript=1"
  alt="" /></noscript>`;

function head({ path, title, description, graph, index = true, hero = true }) {
  const url = pageUrl(path);
  const robots = index
    ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
    : "noindex, follow";
  // 404.html is served at any missing path, so its assets need absolute URLs.
  const a = (p) => (index ? p : `/${p}`);
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="format-detection" content="telephone=no">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="${robots}">
  <meta name="theme-color" content="#faf7f0">
  <meta name="geo.region" content="AU-NSW">
  <meta name="geo.placename" content="Sydney">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="YOLKO">
  <meta property="og:locale" content="en_AU">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${HERO_IMG}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1536">
  <meta property="og:image:height" content="1536">
  <meta property="og:image:alt" content="${esc(HERO_ALT)}">
  <meta property="og:url" content="${url}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${HERO_IMG}">
  <meta name="twitter:image:alt" content="${esc(HERO_ALT)}">
${index ? `\n  <link rel="canonical" href="${url}">` : ""}
  <link rel="sitemap" type="application/xml" href="/sitemap.xml">
  <link rel="icon" type="image/svg+xml" href="${a("assets/favicon.svg")}">
  <link rel="apple-touch-icon" href="${a("assets/yolko-app-icon-1024.png")}">
  <link rel="preload" as="font" type="font/woff2" href="${a("assets/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2")}" crossorigin>${hero ? `
  <link rel="preload" as="image" type="image/webp" imagesrcset="${heroSrcset("webp")}" imagesizes="${HERO_SIZES}" fetchpriority="high">` : ""}
  <link rel="stylesheet" href="${a(`assets/fonts.css?v=${FONTS_V}`)}">
  <link rel="stylesheet" href="${a(`styles-modern.css?v=${CSS_V}`)}">

  <script type="application/ld+json">
${jsonLd(graph)}
  </script>

${META_PIXEL}
</head>`;
}

// Fills in the coming Saturday (Sydney time). Without JS the bar still says "Saturday delivery".
const NEXT_RUN_SCRIPT = `  <script>
  (function () {
    var el = document.querySelector("[data-next-run]");
    if (!el || !window.Intl) return;
    try {
      var parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date());
      var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; };
      var dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
      var ahead = (6 - dow + 7) % 7 || 7;
      var d = new Date(Date.UTC(+get("year"), +get("month") - 1, +get("day")) + ahead * 864e5);
      var mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
      el.innerHTML = "Next delivery <b>Saturday " + d.getUTCDate() + " " + mon + ", 6am to 12pm</b>.";
    } catch (e) {}
  })();
  </script>`;

const ANNOUNCE = `  <div class="announce">
    <p><span class="announce-dot" aria-hidden="true"></span><span data-next-run>Saturday delivery, <b>6am to 12pm</b>.</span><span class="announce-more"> Order by Friday night.</span></p>
  </div>
${NEXT_RUN_SCRIPT}`;

const NAV = [
  ["Delivery", "/egg-delivery-sydney"],
  ["Suburbs", "/egg-delivery-areas"],
  ["Bulk eggs", "/bulk-eggs-sydney"],
  ["Questions", "#faq"],
];

function header(path) {
  const links = NAV.map(([label, href]) => {
    // The 404 page has no FAQ of its own.
    if (href === "#faq" && path === "/404") href = "/#faq";
    const current = href === path ? ' aria-current="page"' : "";
    return `        <a href="${href}"${current}>${label}</a>`;
  }).join("\n");
  return `${ANNOUNCE}

  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="/" aria-label="YOLKO home">
        <span class="brand-dot" aria-hidden="true"></span>
        <span class="brand-name">YOLKO</span>
      </a>
      <nav class="topnav" aria-label="Main navigation">
${links}
      </nav>
      <div class="topbar-actions">
        <a class="btn btn-solid btn-small" href="/#order">Order now</a>
      </div>
    </div>
  </header>`;
}

function crumbsNav(trail) {
  const parts = trail.map(([name, p], i) =>
    i === trail.length - 1
      ? `            <span aria-current="page">${name}</span>`
      : `            <a href="${p}">${name}</a>\n            <span class="crumbs-sep" aria-hidden="true">/</span>`
  );
  return `          <nav class="crumbs" aria-label="Breadcrumb">
${parts.join("\n")}
          </nav>`;
}

const HERO_FACTS = `          <ul class="hero-facts">
            <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>Saturday 6am to 12pm</li>
            <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 6.5h11v10h-11zM13.5 10h4l3.5 3.5v3h-7.5z"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/></svg>$${PRICE.delivery} flat delivery</li>
            <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M2.5 10h19M6.5 15h4"/></svg>Pay by card</li>
          </ul>`;

function heroSection({ trail, h1, sub, cta = "Order now", ctaHref = "/#order", secondary, alt = HERO_ALT }) {
  return `    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
${crumbsNav(trail)}
          <h1>${h1}</h1>
          <p class="hero-sub">${sub}</p>
          <div class="hero-cta">
            <a class="btn btn-solid btn-lg" href="${ctaHref}">${cta}</a>${secondary ? `
            <a class="btn btn-ghost btn-lg" href="${secondary[1]}"${secondary[1].startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${secondary[0]}</a>` : ""}
          </div>
${HERO_FACTS}
        </div>
        <div class="hero-showcase">
          <div class="showcase-card">
            <picture class="showcase-photo is-active">
              <source type="image/webp" srcset="${heroSrcset("webp")}" sizes="${HERO_SIZES}">
              <img src="assets/chalk-tray/${PRICE.tray1}-1536.jpg?v=${IMG_V}" srcset="${heroSrcset("jpg")}" sizes="${HERO_SIZES}" width="1536" height="1536" fetchpriority="high" decoding="async" alt="${esc(alt)}">
            </picture>
          </div>
        </div>
      </div>
    </section>`;
}

function sectionHead(title, sub, id) {
  return `        <header class="section-head">
          <h2${id ? ` id="${id}"` : ""}>${title}</h2>${sub ? `
          <p>${sub}</p>` : ""}
        </header>`;
}

// Suburb pages leave this out: the hero facts say the same, and less shared text keeps each page its own.
function timeline(title, steps, sub = "One delivery run a week keeps the price low. Here is how it goes.") {
  return `    <section id="how" class="how" aria-labelledby="how-title">
      <div class="wrap">
${sectionHead(title, sub, "how-title")}
        <ol class="timeline">
${steps.map(([when, t, d]) => `          <li>
            <span class="tl-when">${when}</span>
            <h3>${t}</h3>
            <p>${d}</p>
          </li>`).join("\n")}
        </ol>
      </div>
    </section>`;
}

const STEPS = (last) => [
  ["By Friday night", "Order online", "Choose a tray, two trays or a 180-egg box, and pay by card."],
  ["Straight away", "Get your receipt", "We email your order and receipt as soon as you pay."],
  ["Saturday, 6am to 12pm", "Eggs at your door", last],
];

function priceCards(title, sub = `Same eggs in every pack. Delivery is $${PRICE.delivery} flat.`) {
  const cards = ["tray1", "tray2", "box"].map((k) => {
    const p = PACKS[k];
    return `          <li>
            <h3>${p.name}</h3>
            <p class="pc-meta">${p.eggs} eggs · ${perEgg(p.price, p.eggs)}¢ an egg</p>
            <div class="pc-row">
              <span class="pc-price">$${p.price}</span>
              <a class="btn btn-solid btn-small" href="/?b=${k}#order" aria-label="Order ${p.name.toLowerCase()}">Order</a>
            </div>
          </li>`;
  }).join("\n");
  return `    <section class="band" aria-labelledby="prices-title">
      <div class="wrap">
${sectionHead(title, sub, "prices-title")}
        <ul class="price-cards">
${cards}
        </ul>
      </div>
    </section>`;
}

function mapFigure() {
  const labels = MAP.labels
    .map((l) => `              <span class="map-label" style="left:${l.x}%;top:${l.y}%">${l.name}</span>`)
    .join("\n");
  return `          <figure class="coverage-map">
            <div class="map-frame" aria-hidden="true">
              <img src="/assets/coverage-map.svg?v=${MAP_V}" width="${MAP.width}" height="${MAP.height}" loading="lazy" decoding="async" alt="">
${labels}
            </div>
            <figcaption><span class="map-key">We deliver</span><span class="map-key off">Too far for now</span></figcaption>
          </figure>`;
}

function suburbCheck(id) {
  return `            <form class="suburb-check" action="/egg-delivery-areas" method="get" role="search">
              <label class="sr-only" for="${id}">Suburb or postcode</label>
              <input id="${id}" name="q" type="search" inputmode="search" autocomplete="off" placeholder="Suburb or postcode">
              <button class="btn btn-ink" type="submit">Check</button>
            </form>`;
}

function mapPanel(title, text, extra = "") {
  return `    <section class="areas" aria-labelledby="map-title">
      <div class="wrap">
        <div class="areas-panel">
          <div class="areas-copy">
            <h2 id="map-title">${title}</h2>
            <p>${text}</p>
${extra}
          </div>
${mapFigure()}
        </div>
      </div>
    </section>`;
}

const CONTACT_ROW = `          <div class="contact-row">
            <a class="btn btn-ink btn-small" href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">WhatsApp us</a>
            <a class="btn btn-ghost btn-small" href="mailto:${EMAIL}">Email</a>
          </div>`;

function faqSection(title, faqs) {
  const items = faqs.map(([q, a], i) => `          <details${i === 0 ? " open" : ""}>
            <summary>${q}</summary>
            <p>${a}</p>
          </details>`);
  return `    <section id="faq" class="faq" aria-labelledby="faq-title">
      <div class="wrap faq-layout">
        <div class="faq-intro">
          <h2 id="faq-title">${title}</h2>
          <p>Can't find your answer? Message us and a real person will reply.</p>
${CONTACT_ROW}
        </div>
        <div class="faq-grid">
${items.join("\n")}
        </div>
      </div>
    </section>`;
}

function ctaBand(title, text, secondary) {
  return `    <section class="cta-band">
      <div class="wrap">
        <div class="cta-panel">
          <div>
            <h2>${title}</h2>
            <p>${text}</p>
          </div>
          <div class="hero-cta">
            <a class="btn btn-ink btn-lg" href="/#order">Order now</a>${secondary ? `
            <a class="btn btn-ghost btn-lg" href="${secondary[1]}"${secondary[1].startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${secondary[0]}</a>` : ""}
          </div>
        </div>
      </div>
    </section>`;
}

function chips(items, current) {
  return items
    .map(([label, href, cls]) => {
      const c = cls ? ` class="${cls}"` : "";
      if (!href) return `          <li${c}>${label}</li>`;
      const cur = href === current ? ' aria-current="page"' : "";
      return `          <li${c}><a href="${href}"${cur}>${label}</a></li>`;
    })
    .join("\n");
}

const DELIVERY_PAGES = [
  ...SUBURB_PAGES.map((s) => [s.name, suburbPath(s)]),
  ["All suburbs", "/egg-delivery-areas"],
];

function footer(path) {
  const cur = (href) => (href === path ? ' aria-current="page"' : "");
  return `  <footer class="foot">
    <div class="wrap">
      <div class="foot-grid">
        <div class="foot-brand-col">
          <a class="foot-brand" href="/" aria-label="YOLKO home">
            <span class="brand-dot" aria-hidden="true"></span>
            <span>YOLKO</span>
          </a>
          <p class="foot-tag">Fresh Pace Farm eggs, delivered across Sydney every Saturday morning.</p>
        </div>
        <nav class="foot-col" aria-label="Shop">
          <p class="foot-h">Shop</p>
          <a href="/#order">Order eggs</a>
          <a href="/bulk-eggs-sydney"${cur("/bulk-eggs-sydney")}>Bulk eggs</a>
          <a href="/#faq">Questions</a>
        </nav>
        <nav class="foot-col" aria-label="Delivery">
          <p class="foot-h">Delivery</p>
          <a href="/egg-delivery-sydney"${cur("/egg-delivery-sydney")}>Egg delivery Sydney</a>
          <a href="/egg-delivery-areas"${cur("/egg-delivery-areas")}>All suburbs</a>
          <a href="/egg-delivery-strathfield"${cur("/egg-delivery-strathfield")}>Strathfield</a>
          <a href="/egg-delivery-homebush"${cur("/egg-delivery-homebush")}>Homebush</a>
          <a href="/egg-delivery-parramatta"${cur("/egg-delivery-parramatta")}>Parramatta</a>
        </nav>
        <nav class="foot-col" aria-label="Contact">
          <p class="foot-h">Contact</p>
          <a href="tel:${PHONE}">${PHONE_LOCAL}</a>
          <a href="mailto:${EMAIL}">${EMAIL}</a>
          <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
        </nav>
      </div>
      <div class="foot-bottom">
        <p>&copy; 2026 YOLKO · Sydney NSW</p>
        <nav class="foot-legal" aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </div>
    </div>
  </footer>`;
}

function mobileCta(line, pack = "tray1") {
  const p = PACKS[pack];
  return `  <div class="mobile-cta show">
    <div class="mobile-cta-text">
      <strong>${p.eggs} eggs · $${p.price}</strong>
      <span>${line}</span>
    </div>
    <a class="btn btn-solid btn-small" href="/${pack === "tray1" ? "" : `?b=${pack}`}#order">Order</a>
  </div>`;
}

// Shades the header once the page scrolls, and slides the phone order bar in
// after the hero's own Order button has scrolled away (without JS it always shows).
const TOPBAR_SCRIPT = `  <script>
  (function () {
    var bar = document.querySelector(".topbar");
    var cta = document.querySelector(".mobile-cta");
    var heroCta = document.querySelector(".hero .hero-cta");
    function sync() {
      if (bar) bar.classList.toggle("scrolled", window.scrollY > 8);
      if (cta && heroCta) {
        var show = heroCta.getBoundingClientRect().bottom < 0;
        cta.classList.toggle("show", show);
        cta.inert = !show;
      }
    }
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
  })();
  </script>`;

function page({ path, title, description, graph, index, hero, body, mobile, pack, scripts = "" }) {
  return `${head({ path, title, description, graph, index, hero })}
<body class="local">
${header(path)}
${body}

${mobile ? mobileCta(mobile, pack) + "\n\n" : ""}${footer(path)}

${scripts}${TOPBAR_SCRIPT}
</body>
</html>
`;
}

/* ---------- Pages ---------- */

const PRICE_FAQ = `<strong>$${PRICE.tray1}</strong> for a tray of 30, <strong>$${PRICE.tray2}</strong> for two trays, <strong>$${PRICE.box}</strong> for a box of 180. Delivery is <strong>$${PRICE.delivery}</strong> flat.`;
const EGGS_FAQ = "Pace Farm extra-large eggs (cage), 30 to a 1.75&nbsp;kg tray. The same brand as the supermarket, for less.";

function suburbPage(s) {
  const path = suburbPath(s);
  const title = `Egg Delivery ${s.name} ${s.postcode} | 30 Eggs $${PRICE.tray1} | YOLKO`;
  const description = `Cheap, fresh Pace Farm eggs delivered to ${s.name} ${s.postcode} every Saturday morning. 30-egg tray $${PRICE.tray1}, flat $${PRICE.delivery} delivery. Order by Friday night.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", "/egg-delivery-sydney"], [s.name, path]];
  const near = nearestCovered(s);
  const faqs = [
    [`Do you deliver eggs to ${s.name}?`, `Yes. ${s.name} ${s.postcode} is in our Saturday delivery area, and so are ${s.nearby[0]} and ${s.nearby[1]}. We check your address before you pay.`],
    ["When will my eggs arrive?", "Saturday, between 6am and 12pm. Order by Friday night."],
    ["How much does it cost?", PRICE_FAQ],
    s.faq,
    ["What eggs are they?", EGGS_FAQ],
  ];
  const service = {
    "@type": "Service",
    "@id": `${pageUrl(path)}#service`,
    name: `Egg delivery in ${s.name}`,
    serviceType: "Egg delivery",
    provider: { "@id": `${SITE}/#business` },
    areaServed: {
      "@type": "Place",
      name: `${s.name} NSW ${s.postcode}`,
      address: { "@type": "PostalAddress", addressLocality: s.name, postalCode: s.postcode, addressRegion: "NSW", addressCountry: "AU" },
    },
    offers: { "@type": "Offer", price: PRICE.delivery.toFixed(2), priceCurrency: "AUD", description: "Flat Saturday delivery fee" },
  };
  const graph = [
    webPage(path, `Egg delivery in ${s.name}`, description),
    breadcrumbs(path, trail),
    service,
    faqPage(path, faqs),
    BUSINESS_REF,
  ];
  const nearList = near.map((x) => {
    const own = SUBURB_PAGES.find((o) => o.name === x.name);
    const label = `${x.name} <small>${x.postcodes.join(", ")}</small>`;
    return `            <li>${own ? `<a href="${suburbPath(own)}">${label}</a>` : label}</li>`;
  }).join("\n");
  const body = `  <main>
${heroSection({
    trail,
    h1: `Egg delivery in ${s.name}`,
    sub: `A tray of 30 Pace Farm eggs for <strong>$${PRICE.tray1}</strong>, at your door in ${s.name} on Saturday morning. Delivery is $${PRICE.delivery} flat.`,
    secondary: [`Suburbs near ${s.name}`, "#nearby"],
    alt: `${HERO_ALT}. Delivered to ${s.name}`,
  })}

    <section class="band band-first">
      <div class="wrap local-row">
        <div class="panel">
          <h2>Delivering in ${s.name}</h2>
          <p>${s.local}</p>
        </div>
        <div class="panel" id="nearby">
          <h2>Suburbs near ${s.name}</h2>
          <p>The ${near.length} closest suburbs we cover. Same Saturday delivery, same $${PRICE.delivery} fee.</p>
          <ul class="areas-list">
${nearList}
            <li class="chip-strong"><a href="/egg-delivery-areas">All suburbs</a></li>
          </ul>
        </div>
      </div>
      <div class="wrap">
        <p class="local-nearby-label">More delivery pages</p>
        <ul class="local-siblings">
${chips([["Sydney", "/egg-delivery-sydney"], ...DELIVERY_PAGES.slice(0, -1).filter(([, h]) => h !== path)])}
        </ul>
      </div>
    </section>

${priceCards(`Egg prices in ${s.name}`, `Same eggs in every pack. Delivery to ${s.name} is $${PRICE.delivery} flat.`)}

${faqSection(`${s.name} delivery questions`, faqs)}

${ctaBand(`Eggs in ${s.name} this Saturday`, `Order by Friday night. Delivery is $${PRICE.delivery} flat.`)}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery to ${s.name}` });
}

function sydneyPage() {
  const path = "/egg-delivery-sydney";
  const title = `Egg Delivery Sydney | Saturday Trays from $${PRICE.tray1} | YOLKO`;
  const description = `Cheap, fresh Pace Farm eggs delivered across Sydney every Saturday morning. 30-egg tray $${PRICE.tray1}, flat $${PRICE.delivery} delivery within 45 km. Order online with YOLKO.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", path]];
  const faqs = [
    ["When is egg delivery in Sydney?", "Saturday, between 6am and 12pm. Order by Friday night."],
    ["How far do you deliver?", `Most of Sydney: the inner west, Parramatta, Ryde, Bankstown, Liverpool, Hornsby, Chatswood, Hurstville, Bondi and Cronulla. <a href="/egg-delivery-areas">Find your suburb</a>. We check your address before you pay.`],
    ["How much are the eggs and delivery?", PRICE_FAQ],
    ["How do I order?", `Use the <a href="/#order">order form</a> and pay by card. We deliver the next Saturday morning.`],
  ];
  const list = {
    "@type": "ItemList",
    "@id": `${pageUrl(path)}#suburbs`,
    name: "Suburb egg delivery pages",
    itemListElement: SUBURB_PAGES.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `Egg delivery ${s.name}`,
      url: pageUrl(suburbPath(s)),
    })),
  };
  const graph = [webPage(path, "Egg delivery in Sydney", description), breadcrumbs(path, trail), list, faqPage(path, faqs), BUSINESS_REF];
  const cards = SUBURB_PAGES.map((s) => `          <li>
            <a href="${suburbPath(s)}">
              <strong>${s.name}</strong>
              <span>${s.postcode} · ${s.region}</span>
            </a>
          </li>`).join("\n") + `
          <li class="all">
            <a href="/egg-delivery-areas">
              <strong>All suburbs</strong>
              <span>Nearly 700, A to Z</span>
            </a>
          </li>`;
  const body = `  <main>
${heroSection({
    trail,
    h1: "Egg delivery across Sydney",
    sub: `A tray of 30 Pace Farm eggs for <strong>$${PRICE.tray1}</strong>, delivered on Saturday morning to nearly 700 suburbs. Delivery is $${PRICE.delivery} flat.`,
    secondary: ["Check your suburb", "#map-title"],
  })}

${timeline("How Saturday delivery works", STEPS(`To your door, $${PRICE.delivery} flat, anywhere in the delivery area.`))}

${mapPanel("We deliver to nearly 700 Sydney suburbs", `From Parramatta and Liverpool to Hornsby, Chatswood, Bondi and Cronulla. Same Saturday run, same $${PRICE.delivery} delivery.`, suburbCheck("map-q"))}

    <section class="band" id="suburbs" aria-labelledby="suburbs-title">
      <div class="wrap">
${sectionHead("Popular suburbs", `Local pages for the suburbs we deliver to most. <a href="/egg-delivery-areas">See all suburbs</a>.`, "suburbs-title")}
        <ul class="local-suburbs">
${cards}
        </ul>
      </div>
    </section>

${priceCards("Prices")}

${faqSection("Sydney delivery questions", faqs)}

${ctaBand("Fresh eggs this Saturday", `Order by Friday night. Delivery is $${PRICE.delivery} flat.`, ["All suburbs", "/egg-delivery-areas"])}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery · $${PRICE.delivery}` });
}

function bulkPage() {
  const path = "/bulk-eggs-sydney";
  const title = `Bulk Eggs Sydney | 180-Egg Box $${PRICE.box}, Saturday Delivery | YOLKO`;
  const description = `Buy eggs in bulk in Sydney. A full box of 180 Pace Farm XL cage eggs is $${PRICE.box} (40¢ an egg), up to 10 boxes per order. Saturday delivery for cafés, bakers and big families.`;
  const trail = [["Home", "/"], ["Bulk eggs Sydney", path]];
  const faqs = [
    ["How much is a bulk box of eggs?", `A full box is 180 Pace Farm extra-large eggs (six trays of 30) for <strong>$${PRICE.box}</strong>, about ${perEgg(PRICE.box, 180)}¢ an egg. Delivery is <strong>$${PRICE.delivery}</strong> flat.`],
    ["How many boxes can I order?", `Up to 10 boxes (1,800 eggs) in one order. For more, <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a>.`],
    ["Do you supply cafés and restaurants?", "Yes. Cafés, restaurants, bakeries and caterers order full boxes for Saturday delivery, and many set up a weekly standing order."],
    ["Which eggs are in the box?", "Pace Farm extra-large eggs (cage), 30 to a 1.75&nbsp;kg tray, six trays to a box."],
    ["When is bulk delivery?", "Saturday, between 6am and 12pm, with the tray orders. Order by Friday night. Stock is limited each week, so order early for big amounts."],
    ["How should I store 180 eggs?", "In the fridge, in their trays, stacked flat. Use them by the best-before date on the pack."],
  ];
  const graph = [webPage(path, "Bulk eggs in Sydney", description), breadcrumbs(path, trail), PRODUCT_BOX, RETURNS, faqPage(path, faqs), BUSINESS_REF];
  const rows = [
    ["1 tray", 30, PRICE.tray1],
    ["2 trays", 60, PRICE.tray2],
    ["Full box", 180, PRICE.box, true],
    ["10 boxes", 1800, PRICE.box * 10],
  ];
  const body = `  <main>
${heroSection({
    trail,
    h1: "Bulk eggs in Sydney",
    sub: `180 Pace Farm eggs for <strong>$${PRICE.box}</strong>, about ${perEgg(PRICE.box, 180)}¢ an egg. Delivered on Saturday morning, $${PRICE.delivery} flat.`,
    cta: "Order a box",
    ctaHref: "/?b=box#order",
    secondary: ["WhatsApp us", WHATSAPP],
    alt: `${HERO_ALT}. Six trays make a 180-egg box`,
  })}

    <section class="band" aria-labelledby="per-egg-title">
      <div class="wrap">
${sectionHead("Price per egg", `Same eggs in every pack, and one $${PRICE.delivery} delivery fee.`, "per-egg-title")}
        <table class="price-table">
          <thead><tr><th scope="col">Pack</th><th scope="col">Eggs</th><th scope="col">Price</th><th scope="col">Per egg</th></tr></thead>
          <tbody>
${rows.map(([name, eggs, price, best]) => `            <tr${best ? ' class="best"' : ""}><th scope="row">${name}</th><td>${eggs.toLocaleString("en-AU")}</td><td>$${price.toLocaleString("en-AU")}</td><td>${perEgg(price, eggs)}¢</td></tr>`).join("\n")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="band">
      <div class="wrap local-row">
        <div class="panel">
          <h2>Weekly standing orders</h2>
          <p>For cafés, bakers, caterers and big families. Send us your name, address and how many boxes you need each week, and we set them aside for every Saturday delivery.</p>
          <div class="hero-cta">
            <a class="btn btn-ink" href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">WhatsApp us</a>
          </div>
        </div>
        <div class="panel">
          <h2>Order online</h2>
          <p>Pick the full box at checkout and choose how many, up to 10. Pay by card, and we deliver on Saturday morning.</p>
          <div class="hero-cta">
            <a class="btn btn-solid" href="/?b=box#order">Order a box</a>
          </div>
        </div>
      </div>
    </section>

${faqSection("Bulk order questions", faqs)}

${ctaBand("A box this Saturday", `180 eggs for $${PRICE.box}. Order up to 10 boxes online.`, ["WhatsApp us", WHATSAPP])}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery · $${PRICE.delivery}`, pack: "box" });
}

function areasPage(existingHtml) {
  const path = "/egg-delivery-areas";
  const title = "Egg Delivery Areas Sydney | Nearly 700 Suburbs We Cover | YOLKO";
  const description = `Every Sydney suburb YOLKO delivers eggs to, with postcodes. Nearly 700 suburbs within about 45 km get Saturday morning delivery for a flat $${PRICE.delivery}.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", "/egg-delivery-sydney"], ["Delivery areas", path]];
  const faqs = [
    ["Is my suburb covered?", "If the search on this page finds it, yes. We check your exact street and postcode before you pay."],
    ["My suburb doesn't come up. Can I still order?", `Try the <a href="/#order">order form</a> anyway, or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a>. Some places have unusual names in the postcode data.`],
    ["Does delivery cost more further out?", `No. It is <strong>$${PRICE.delivery}</strong> flat anywhere in the delivery area.`],
    ["When do you deliver?", "Saturday, between 6am and 12pm. Order by Friday night."],
  ];
  const service = {
    "@type": "Service",
    "@id": `${pageUrl(path)}#service`,
    name: "Egg delivery in Sydney",
    serviceType: "Egg delivery",
    provider: { "@id": `${SITE}/#business` },
    areaServed: { "@type": "City", name: "Sydney", containedInPlace: { "@type": "State", name: "New South Wales" } },
    offers: { "@type": "Offer", price: PRICE.delivery.toFixed(2), priceCurrency: "AUD", description: "Flat Saturday delivery fee" },
  };
  const graph = [webPage(path, "Egg delivery areas in Sydney", description), breadcrumbs(path, trail), service, faqPage(path, faqs), BUSINESS_REF];

  // Keep the suburb list that build-areas-page.mjs generated.
  const start = existingHtml.indexOf("        <!-- areas:start");
  const endMarker = "<!-- areas:end -->";
  const end = existingHtml.indexOf(endMarker);
  if (start === -1 || end === -1) throw new Error("areas markers not found in egg-delivery-areas.html");
  const list = existingHtml.slice(start, end + endMarker.length);

  const body = `  <main>
${heroSection({
    trail,
    h1: "Every suburb we deliver to",
    sub: `Saturday morning egg delivery to nearly 700 Sydney suburbs, $${PRICE.delivery} flat. Type yours below to check.`,
    secondary: ["Find your suburb", "#suburbs"],
  })}

    <section id="suburbs" class="band areas-finder" aria-labelledby="finder-title">
      <div class="wrap">
        <div class="panel">
          <h2 id="finder-title">Find your suburb</h2>
          <p>Type a suburb or postcode. We check your exact address before you pay.</p>
          <div class="suburb-check" role="search">
            <label class="sr-only" for="area-q">Suburb or postcode</label>
            <input id="area-q" type="search" inputmode="search" autocomplete="off" placeholder="e.g. Marrickville or 2204">
          </div>
          <p class="area-status" id="area-status" aria-live="polite"></p>
          <ul class="areas-list area-results" id="area-results" hidden></ul>
        </div>
      </div>
    </section>

${mapPanel("Our Saturday delivery area", `From Hornsby to Campbelltown and from Blacktown to Bondi. Dark dots are suburbs we deliver to.`)}

${faqSection("Delivery area questions", faqs)}

${ctaBand("Found your suburb?", `A tray is $${PRICE.tray1}, two trays $${PRICE.tray2}, and a box of 180 is $${PRICE.box}. Delivery is $${PRICE.delivery} anywhere on this page.`, ["Bulk eggs", "/bulk-eggs-sydney"])}

    <section class="band az" aria-label="All suburbs we deliver to">
      <div class="wrap">
        <details class="az-all">
          <summary>See all suburbs we deliver to, A to Z</summary>
          <div class="az-list">
${list}
          </div>
        </details>
      </div>
    </section>
  </main>`;
  // The search reads the A to Z list at the bottom of the page and shows matches under the box.
  const scripts = `  <script>
  (function () {
    var q = document.getElementById("area-q");
    var status = document.getElementById("area-status");
    var results = document.getElementById("area-results");
    var all = Array.prototype.slice.call(document.querySelectorAll(".az-list li"));
    if (!q || !results || !all.length) return;
    function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
    var items = all.map(function (li) { return { li: li, text: norm(li.textContent), name: norm((li.firstChild && li.firstChild.textContent) || li.textContent) }; });
    var MAX = 40;
    function run() {
      var term = norm(q.value);
      results.innerHTML = "";
      if (!term) { results.hidden = true; status.textContent = ""; return; }
      var hits = items.filter(function (it) { return it.text.indexOf(term) !== -1; });
      // Suburbs whose name starts with what was typed come first.
      hits.sort(function (a, b) { return (b.name.indexOf(term) === 0) - (a.name.indexOf(term) === 0); });
      hits.slice(0, MAX).forEach(function (it) { results.appendChild(it.li.cloneNode(true)); });
      results.hidden = !hits.length;
      if (!hits.length) {
        status.innerHTML = 'No match. <a href="/#order">Try the order form</a> or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">WhatsApp us</a> to check.';
      } else if (hits.length === 1) {
        status.textContent = "Yes, we deliver there.";
      } else {
        status.textContent = hits.length + " matches. We deliver to all of them." + (hits.length > MAX ? " Keep typing to narrow it down." : "");
      }
    }
    q.addEventListener("input", run);
    // The suburb check on other pages sends people here with ?q=
    var start = new URLSearchParams(location.search).get("q");
    if (start) {
      q.value = start;
      run();
      document.getElementById("suburbs").scrollIntoView();
    }
  })();
  </script>

`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery · $${PRICE.delivery}`, scripts });
}

function notFoundPage() {
  const path = "/404";
  const body = `  <main>
    <section class="notfound">
      <div class="wrap">
        <h1>Page not found</h1>
        <p>The link may be old or mistyped. Here are some good places to start.</p>
        <div class="hero-cta">
          <a class="btn btn-solid btn-lg" href="/#order">Order eggs</a>
          <a class="btn btn-ghost btn-lg" href="/">Home</a>
        </div>
        <p class="local-nearby-label">Delivery pages</p>
        <ul class="local-siblings">
${chips([["Sydney", "/egg-delivery-sydney"], ...DELIVERY_PAGES, ["Bulk eggs", "/bulk-eggs-sydney"]])}
        </ul>
      </div>
    </section>
  </main>`;
  return page({
    path,
    title: "Page not found | YOLKO",
    description: "This page does not exist. Order fresh Pace Farm eggs for Saturday delivery in Sydney.",
    graph: [WEBSITE],
    index: false,
    hero: false,
    body,
  });
}

/* ---------- Homepage: structured data, FAQ, map and next delivery date ---------- */

const HOME_FAQ = [
  ["When do you deliver?", `Saturday, between 6am and 12pm. Order by Friday night. Delivery is $${PRICE.delivery} flat.`],
  ["Which suburbs do you cover?", `Nearly 700 suburbs across Sydney, from Parramatta and Liverpool to Hornsby, Chatswood, Bondi and Cronulla. <a href="/egg-delivery-areas">Find your suburb</a>. We check your address before you pay.`],
  ["How much are the eggs?", `<strong>$${PRICE.tray1}</strong> for a tray of 30 (about ${perEgg(PRICE.tray1, 30)}¢ an egg), <strong>$${PRICE.tray2}</strong> for two trays, <strong>$${PRICE.box}</strong> for a box of 180. Delivery is $${PRICE.delivery} flat.`],
  ["How do I pay?", "By card when you order. Payment is handled by Stripe, so we never see your card number."],
  ["Can delivery be free?", "Yes. After you order you get a share link. A friend's first delivery through it is free, and so is your next one. When neighbours in the same building order for the same Saturday, every order after the first ships free."],
  ["What eggs are they?", EGGS_FAQ],
  ["Can I order in bulk?", `Yes. Order up to 10 boxes of 180 eggs. Cafés can <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us</a> for a weekly standing order. More on <a href="/bulk-eggs-sydney">bulk eggs</a>.`],
];

function fillMarker(html, name, content) {
  const re = new RegExp(`(<!-- ${name}:start[^>]*-->)[\\s\\S]*?(\\n[ \\t]*<!-- ${name}:end -->)`);
  if (!re.test(html)) throw new Error(`${name} markers not found in index.html`);
  return html.replace(re, (_, a, b) => `${a}\n${content}${b}`);
}

function updateHome() {
  const file = join(ROOT, "index.html");
  let html = readFileSync(file, "utf8");
  const description = `Cheap, fresh Pace Farm eggs delivered across Sydney every Saturday. 30-egg tray $${PRICE.tray1}, two trays $${PRICE.tray2}, 180-egg box $${PRICE.box}. Flat $${PRICE.delivery} delivery within 45 km.`;
  const graph = [
    WEBSITE,
    webPage("/", `Fresh Eggs Delivered in Sydney | 30 for $${PRICE.tray1} | YOLKO`, description),
    BUSINESS,
    PRODUCT_TRAY,
    PRODUCT_TRAY2,
    PRODUCT_BOX,
    RETURNS,
    faqPage("/", HOME_FAQ),
  ];
  html = html.replace(
    /(<script id="yolko-jsonld" type="application\/ld\+json">\n)[\s\S]*?(\n  <\/script>)/,
    (_, a, b) => a + jsonLd(graph) + b
  );
  // The FAQ text on the page shows answers; app.js swaps #faq-eggs for the live product.
  const faqHtml = HOME_FAQ.map(([q, a], i) => `          <details${i === 0 ? " open" : ""}>
            <summary>${q}</summary>
            <p${q === "What eggs are they?" ? ' id="faq-eggs"' : ""}>${a}</p>
          </details>`).join("\n");
  html = fillMarker(html, "faq", faqHtml);
  html = fillMarker(html, "map", mapFigure());
  html = fillMarker(html, "next-run", NEXT_RUN_SCRIPT);
  writeFileSync(file, html);
}

/* ---------- Sitemap ---------- */

function sitemap() {
  const entries = [
    ["/", "1.0"],
    ["/egg-delivery-sydney", "0.9"],
    ["/bulk-eggs-sydney", "0.9"],
    ["/egg-delivery-areas", "0.8"],
    ...SUBURB_PAGES.map((s) => [suburbPath(s), "0.7"]),
  ];
  const urls = entries.map(([p, priority]) => `  <url>
    <loc>${pageUrl(p)}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
    <image:image>
      <image:loc>${HERO_IMG.replace(/&/g, "&amp;")}</image:loc>
    </image:image>
  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join("\n")}
</urlset>
`;
}

/* ---------- Write ---------- */

for (const s of SUBURB_PAGES) writeFileSync(join(ROOT, `egg-delivery-${s.slug}.html`), suburbPage(s));
writeFileSync(join(ROOT, "egg-delivery-sydney.html"), sydneyPage());
writeFileSync(join(ROOT, "bulk-eggs-sydney.html"), bulkPage());
const areasFile = join(ROOT, "egg-delivery-areas.html");
writeFileSync(areasFile, areasPage(readFileSync(areasFile, "utf8")));
writeFileSync(join(ROOT, "404.html"), notFoundPage());
writeFileSync(join(ROOT, "assets", "coverage-map.svg"), MAP.svg);
writeFileSync(join(ROOT, "sitemap.xml"), sitemap());
updateHome();
console.log(`Built ${SUBURB_PAGES.length} suburb pages, Sydney, bulk, areas, 404, sitemap, map (${MAP.count} suburbs) and homepage data`);
