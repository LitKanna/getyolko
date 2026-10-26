#!/usr/bin/env node
/**
 * Build the secondary storefront pages from one template, so every page shares
 * the same header, footer, meta tags and structured data.
 *
 *   egg-delivery-<suburb>.html  (one per entry in SUBURB_PAGES)
 *   egg-delivery-sydney.html, bulk-eggs-sydney.html, egg-delivery-areas.html, 404.html
 *   sitemap.xml
 *   index.html: only the JSON-LD block and the FAQ list (between markers)
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://getyolko.com";
const TODAY = new Date().toISOString().slice(0, 10);

// Bump when the files change so browsers fetch fresh copies.
const CSS_V = "149";
const FONTS_V = "77";
const IMG_V = "112";

const PHONE = "+61433975055";
const PHONE_DISPLAY = "+61 433 975 055";
const WHATSAPP = "https://wa.me/61433975055";
const EMAIL = "orders@getyolko.com";
const PRICE = { tray1: 13, tray2: 25, box: 72, delivery: 5 };

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

const HERO_SIZES = "(max-width: 900px) min(100vw - 32px, 420px), 420px";
const heroSrcset = (ext) =>
  [640, 928, 1536].map((w) => `assets/chalk-tray/${PRICE.tray1}-${w}.${ext}?v=${IMG_V} ${w}w`).join(", ");

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

const NAV = [
  ["Delivery", "/egg-delivery-sydney"],
  ["Areas", "/egg-delivery-areas"],
  ["Bulk eggs", "/bulk-eggs-sydney"],
  ["FAQ", "#faq"],
];

function header(path) {
  const links = NAV.map(([label, href]) => {
    // The 404 page has no FAQ of its own.
    if (href === "#faq" && path === "/404") href = "/#faq";
    const current = href === path ? ' aria-current="page"' : "";
    return `        <a href="${href}"${current}>${label}</a>`;
  }).join("\n");
  return `  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="/" aria-label="YOLKO home">
        <span class="brand-dot" aria-hidden="true"></span>
        <span class="brand-name">YOLKO</span>
      </a>
      <nav class="topnav" aria-label="Main navigation">
${links}
      </nav>
      <a class="btn btn-solid btn-small" href="/#order">Order now</a>
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

function heroSection({ trail, kicker, h1, sub, cta = "Order now", alt = HERO_ALT }) {
  return `    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
${crumbsNav(trail)}
          <p class="hero-kicker">${kicker}</p>
          <h1>${h1}</h1>
          <p class="hero-sub">${sub}</p>
          <div class="hero-cta">
            <a class="btn btn-solid" href="/#order">${cta}</a>
          </div>
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

function stepsSection(lastStep) {
  const steps = [
    ["Order by Friday night", "Choose a tray, two trays or a 180-egg box."],
    ["Pay by card", "Secure checkout with Stripe."],
    lastStep,
  ];
  return `    <section class="local-band">
      <div class="wrap">
        <header class="section-head left">
          <h2>How it works</h2>
        </header>
        <ol class="local-model">
${steps.map(([t, d]) => `          <li><strong>${t}</strong><span>${d}</span></li>`).join("\n")}
        </ol>
      </div>
    </section>`;
}

function faqSection(title, faqs) {
  const items = faqs.map(([q, a], i) => `          <details${i === 0 ? " open" : ""}>
            <summary>${q}</summary>
            <p>${a}</p>
          </details>`);
  return `    <section id="faq" class="faq">
      <div class="wrap">
        <header class="section-head">
          <h2>${title}</h2>
        </header>
        <div class="faq-grid">
${items.join("\n")}
        </div>
      </div>
    </section>`;
}

function ctaBand(title, text, secondary) {
  return `    <section class="local-cta-band">
      <div class="wrap">
        <h2>${title}</h2>
        <p>${text}</p>
        <div class="hero-cta">
          <a class="btn btn-solid" href="/#order">Order now</a>${secondary ? `
          <a class="btn btn-ghost" href="${secondary[1]}">${secondary[0]}</a>` : ""}
        </div>
      </div>
    </section>`;
}

function chips(items, current) {
  return items
    .map(([label, href]) => {
      if (!href) return `          <li>${label}</li>`;
      const cur = href === current ? ' aria-current="page"' : "";
      return `          <li><a href="${href}"${cur}>${label}</a></li>`;
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
          <p class="foot-tag">Fresh Pace Farm eggs, delivered in Sydney.</p>
          <address class="foot-nap">
            Saturday delivery across Sydney<br>
            Within 45&nbsp;km of Flemington
          </address>
        </div>
        <nav class="foot-col" aria-label="Shop">
          <p class="foot-h">Shop</p>
          <a href="/#order">Order now</a>
          <a href="/bulk-eggs-sydney"${cur("/bulk-eggs-sydney")}>Bulk eggs</a>
        </nav>
        <nav class="foot-col" aria-label="Delivery">
          <p class="foot-h">Delivery</p>
          <a href="/egg-delivery-sydney"${cur("/egg-delivery-sydney")}>Egg delivery Sydney</a>
          <a href="/egg-delivery-areas"${cur("/egg-delivery-areas")}>Suburbs we cover</a>
          <a href="/#faq">FAQ</a>
        </nav>
        <nav class="foot-col" aria-label="Contact">
          <p class="foot-h">Contact</p>
          <a href="tel:${PHONE}">${PHONE_DISPLAY}</a>
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

function mobileCta(line) {
  return `  <div class="mobile-cta show">
    <div class="mobile-cta-text">
      <strong>30 eggs · $${PRICE.tray1}</strong>
      <span>${line}</span>
    </div>
    <a class="btn btn-small" href="/#order">Order</a>
  </div>`;
}

const TOPBAR_SCRIPT = `  <script>
  (function () {
    var bar = document.querySelector(".topbar");
    if (!bar) return;
    function sync() { bar.classList.toggle("scrolled", window.scrollY > 8); }
    sync();
    window.addEventListener("scroll", sync, { passive: true });
  })();
  </script>`;

function page({ path, title, description, graph, index, hero, body, mobile, scripts = "" }) {
  return `${head({ path, title, description, graph, index, hero })}
<body class="local">
${header(path)}
${body}

${mobile ? mobileCta(mobile) + "\n\n" : ""}${footer(path)}

${scripts}${TOPBAR_SCRIPT}
</body>
</html>
`;
}

/* ---------- Pages ---------- */

const PRICE_FAQ = `<strong>$${PRICE.tray1}</strong> for a 30-egg tray, <strong>$${PRICE.tray2}</strong> for two, <strong>$${PRICE.box}</strong> for a 180-egg box. Delivery is a flat <strong>$${PRICE.delivery}</strong>.`;
const EGGS_FAQ = "Pace Farm extra-large cage eggs, 30 to a 1.75&nbsp;kg tray. The same supermarket brand, for less.";

function suburbPage(s) {
  const path = suburbPath(s);
  const title = `Egg Delivery ${s.name} ${s.postcode} | 30 Eggs $${PRICE.tray1} | YOLKO`;
  const description = `Cheap, fresh Pace Farm eggs delivered to ${s.name} ${s.postcode} every Saturday morning. 30-egg tray $${PRICE.tray1}, flat $${PRICE.delivery} delivery. Order by Friday night.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", "/egg-delivery-sydney"], [s.name, path]];
  const near = nearestCovered(s);
  const faqs = [
    [`Do you deliver eggs to ${s.name}?`, `Yes. ${s.name} ${s.postcode} is inside our Saturday delivery area, and so are ${s.nearby[0]} and ${s.nearby[1]}. Checkout confirms your address.`],
    ["When will my eggs arrive?", "Saturday, 6am to 12pm. Order by Friday night."],
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
  const body = `  <main>
${heroSection({
    trail,
    kicker: `${s.name} ${s.postcode} · ${s.region}`,
    h1: `Egg delivery<br>in ${s.name}`,
    sub: `30 Pace Farm eggs for <strong>$${PRICE.tray1}</strong>, delivered Saturday morning. Flat <strong>$${PRICE.delivery}</strong> delivery.`,
    alt: `${HERO_ALT}. Delivered to ${s.name}`,
  })}

${stepsSection(["Saturday morning delivery", `To your door in ${s.name}, flat $${PRICE.delivery}.`])}

    <section class="local-band">
      <div class="wrap">
        <header class="section-head left">
          <h2>Delivering in ${s.name}</h2>
        </header>
        <div class="local-prose">
          <p>${s.local}</p>
        </div>
      </div>
    </section>

    <section class="local-band">
      <div class="wrap">
        <header class="section-head left">
          <h2>Suburbs near ${s.name}</h2>
          <p>The ${near.length} closest suburbs we cover, with postcodes. Same Saturday delivery and the same $${PRICE.delivery} fee.</p>
        </header>
        <ul class="areas-list">
${near.map((x) => {
    const own = SUBURB_PAGES.find((o) => o.name === x.name);
    const label = `${x.name} <small>${x.postcodes.join(", ")}</small>`;
    return `          <li>${own ? `<a href="${suburbPath(own)}">${label}</a>` : label}</li>`;
  }).join("\n")}
${chips([["All suburbs", "/egg-delivery-areas"]])}
        </ul>
        <p class="local-nearby-label">More delivery pages</p>
        <ul class="local-siblings">
${chips([["Sydney", "/egg-delivery-sydney"], ...DELIVERY_PAGES.slice(0, -1).filter(([, h]) => h !== path)])}
        </ul>
      </div>
    </section>

${faqSection(`${s.name} delivery questions`, faqs)}

${ctaBand(`Eggs in ${s.name} this Saturday`, `Order by Friday night. Flat $${PRICE.delivery} delivery.`)}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery to ${s.name}` });
}

function sydneyPage() {
  const path = "/egg-delivery-sydney";
  const title = `Egg Delivery Sydney | Saturday Trays from $${PRICE.tray1} | YOLKO`;
  const description = `Cheap, fresh Pace Farm eggs delivered across Sydney every Saturday morning. 30-egg tray $${PRICE.tray1}, flat $${PRICE.delivery} delivery within 45 km. Order online with YOLKO.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", path]];
  const faqs = [
    ["When is egg delivery in Sydney?", "Saturday, 6am to 12pm. Order by Friday night."],
    ["How far do you deliver?", `About 45&nbsp;km by road. That covers most of Sydney: the inner west, Parramatta, Ryde, Bankstown, Liverpool, Hornsby, Chatswood and Hurstville. Search <a href="/egg-delivery-areas">every suburb we cover</a>, and checkout confirms your address.`],
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
          </li>`).join("\n");
  const body = `  <main>
${heroSection({
    trail,
    kicker: "Sydney-wide",
    h1: "Egg delivery<br>across Sydney",
    sub: `30 Pace Farm eggs for <strong>$${PRICE.tray1}</strong>, delivered Saturday morning anywhere within 45&nbsp;km. Flat <strong>$${PRICE.delivery}</strong> delivery.`,
  })}

${stepsSection(["Saturday morning delivery", `To your door, flat $${PRICE.delivery}.`])}

    <section class="local-band" id="suburbs">
      <div class="wrap">
        <header class="section-head">
          <h2>Suburb pages</h2>
          <p>Nearly 700 suburbs are covered. <a href="/egg-delivery-areas">Find yours</a>.</p>
        </header>
        <ul class="local-suburbs">
${cards}
        </ul>
      </div>
    </section>

${faqSection("Sydney delivery questions", faqs)}

${ctaBand("Eggs this Saturday", `Order by Friday night. Flat $${PRICE.delivery} delivery.`, ["All suburbs", "/egg-delivery-areas"])}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery · $${PRICE.delivery}` });
}

function bulkPage() {
  const path = "/bulk-eggs-sydney";
  const title = `Bulk Eggs Sydney | 180-Egg Box $${PRICE.box}, Saturday Delivery | YOLKO`;
  const description = `Buy eggs in bulk in Sydney. A full box of 180 Pace Farm XL cage eggs is $${PRICE.box} (40¢ an egg), up to 10 boxes per order. Saturday delivery for cafés, bakers and big families.`;
  const trail = [["Home", "/"], ["Bulk eggs Sydney", path]];
  const faqs = [
    ["How much is a bulk box of eggs?", `A full box is 180 Pace Farm XL cage eggs (six 30-egg trays) for <strong>$${PRICE.box}</strong>, about 40¢ an egg. Delivery is a flat <strong>$${PRICE.delivery}</strong>.`],
    ["How many boxes can I order?", `Up to 10 boxes (1,800 eggs) in one order. For more, <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a>.`],
    ["Do you supply cafés and restaurants?", "Yes. Cafés, restaurants, bakeries and caterers order full boxes for Saturday delivery, and many set up a weekly standing order."],
    ["Which eggs are in the box?", "Pace Farm XL cage eggs, 30 to a 1.75&nbsp;kg tray, six trays to a box."],
    ["When is bulk delivery?", "Saturday, 6am to 12pm, with the tray orders. Order by Friday night. Stock is limited each week, so order early for big quantities."],
    ["How should I store 180 eggs?", "In the fridge, in their trays, stacked flat. Use them by the best-before date on the pack."],
  ];
  const graph = [webPage(path, "Bulk eggs in Sydney", description), breadcrumbs(path, trail), PRODUCT_BOX, RETURNS, faqPage(path, faqs), BUSINESS_REF];
  const perEgg = (price, eggs) => Math.round((price / eggs) * 100);
  const rows = [
    ["1 tray", 30, PRICE.tray1],
    ["2 trays", 60, PRICE.tray2],
    ["Full box", 180, PRICE.box],
    ["10 boxes", 1800, PRICE.box * 10],
  ];
  const body = `  <main>
${heroSection({
    trail,
    kicker: "Full box · 180 eggs",
    h1: "Bulk eggs<br>in Sydney",
    sub: `180 Pace Farm eggs for <strong>$${PRICE.box}</strong>, about 40¢ an egg. Delivered Saturday morning, flat <strong>$${PRICE.delivery}</strong>.`,
    cta: "Order a box",
    alt: `${HERO_ALT}. Six trays make a 180-egg box`,
  })}

    <section class="local-band">
      <div class="wrap">
        <header class="section-head">
          <h2>Price per egg</h2>
          <p>Same eggs in every pack, one flat $${PRICE.delivery} delivery.</p>
        </header>
        <table class="price-table">
          <thead><tr><th scope="col">Pack</th><th scope="col">Eggs</th><th scope="col">Price</th><th scope="col">Per egg</th></tr></thead>
          <tbody>
${rows.map(([name, eggs, price]) => `            <tr><th scope="row">${name}</th><td>${eggs.toLocaleString("en-AU")}</td><td>$${price.toLocaleString("en-AU")}</td><td>${perEgg(price, eggs)}¢</td></tr>`).join("\n")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="local-band">
      <div class="wrap">
        <header class="section-head">
          <h2>Weekly standing orders</h2>
          <p>For cafés, bakers, caterers and big families.</p>
        </header>
        <div class="local-prose">
          <p><a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">Send us a WhatsApp</a> with your name, address and how many boxes you need each week. We set them aside for every Saturday delivery.</p>
        </div>
      </div>
    </section>

${faqSection("Bulk order questions", faqs)}

${ctaBand("A box this Saturday", `180 eggs for $${PRICE.box}. Order up to 10 boxes online.`, ["WhatsApp us", WHATSAPP])}
  </main>`;
  return page({ path, title, description, graph, body, mobile: `Full box, 180 eggs · $${PRICE.box}` });
}

function areasPage(existingHtml) {
  const path = "/egg-delivery-areas";
  const title = "Egg Delivery Areas Sydney | Nearly 700 Suburbs We Cover | YOLKO";
  const description = `Every Sydney suburb YOLKO delivers eggs to, with postcodes. Nearly 700 suburbs within about 45 km get Saturday morning delivery for a flat $${PRICE.delivery}.`;
  const trail = [["Home", "/"], ["Egg delivery Sydney", "/egg-delivery-sydney"], ["Delivery areas", path]];
  const faqs = [
    ["Is my suburb covered?", "If it is on this page, yes. Checkout confirms your exact street and postcode before you pay."],
    ["My suburb is not on the list. Can I still order?", `Try the <a href="/#order">order form</a> anyway, or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a>. Some places have unusual names in the postcode data.`],
    ["Does delivery cost more further out?", `No. It is a flat <strong>$${PRICE.delivery}</strong> anywhere in the delivery area.`],
    ["When do you deliver?", "Saturday, 6am to 12pm. Order by Friday night."],
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
    kicker: "Sydney · 45 km",
    h1: "Every suburb<br>we deliver to",
    sub: `Nearly 700 Sydney suburbs get Saturday morning egg delivery for a flat <strong>$${PRICE.delivery}</strong>.`,
  })}

    <section id="suburbs" class="faq areas-finder">
      <div class="wrap">
        <header class="section-head">
          <h2>Find your suburb</h2>
          <p>Type a suburb or postcode. Checkout confirms your exact address.</p>
        </header>
        <div class="field area-search">
          <label for="area-q">Suburb or postcode</label>
          <input id="area-q" type="search" inputmode="search" autocomplete="off" placeholder="e.g. Marrickville or 2204">
          <p class="area-status" id="area-status" aria-live="polite"></p>
        </div>
${list}
      </div>
    </section>

${faqSection("Delivery area questions", faqs)}

${ctaBand("Found it?", `Tray $${PRICE.tray1}, two trays $${PRICE.tray2}, or a 180-egg box for $${PRICE.box}. Delivery is $${PRICE.delivery} anywhere on this page.`, ["Bulk eggs", "/bulk-eggs-sydney"])}
  </main>`;
  const scripts = `  <script>
  (function () {
    var q = document.getElementById("area-q");
    var status = document.getElementById("area-status");
    var bands = Array.prototype.slice.call(document.querySelectorAll(".area-band"));
    if (!q || !bands.length) return;
    function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
    var items = Array.prototype.slice.call(document.querySelectorAll(".area-band li")).map(function (li) {
      return { li: li, text: norm(li.textContent) };
    });
    function run() {
      var term = norm(q.value);
      var shown = 0;
      items.forEach(function (it) {
        var hit = !term || it.text.indexOf(term) !== -1;
        it.li.hidden = !hit;
        if (hit) shown++;
      });
      bands.forEach(function (band) {
        var any = band.querySelector("li:not([hidden])");
        band.hidden = !any;
        band.open = !!term && !!any;
      });
      if (!term) { status.textContent = ""; return; }
      status.innerHTML = shown
        ? shown + (shown === 1 ? " match. You're in the delivery area." : " matches. You're in the delivery area.")
        : 'No match. <a href="/#order">Try checkout</a> or <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">WhatsApp us</a> to check.';
    }
    q.addEventListener("input", run);
  })();

`;
  return page({ path, title, description, graph, body, mobile: `Saturday delivery · $${PRICE.delivery}`, scripts });
}

function notFoundPage() {
  const path = "/404";
  const body = `  <main>
    <section class="local-band">
      <div class="wrap">
        <header class="section-head left">
          <h1>Page not found</h1>
          <p>The link may be old or mistyped.</p>
        </header>
        <div class="hero-cta">
          <a class="btn btn-solid" href="/#order">Order eggs</a>
          <a class="btn btn-ghost" href="/">Home</a>
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

/* ---------- Homepage: structured data and FAQ only ---------- */

const HOME_FAQ = [
  ["When do you deliver?", `Saturday, 6am to 12pm. Order by Friday night. Delivery is a flat $${PRICE.delivery} within 45&nbsp;km.`],
  ["Which suburbs do you cover?", `Most of Sydney within 45&nbsp;km of Flemington, from Parramatta and Liverpool to Hornsby, Chatswood and Hurstville. <a href="/egg-delivery-areas">Search every suburb</a>. Checkout confirms your address.`],
  ["How much are the eggs?", `<strong>$${PRICE.tray1}</strong> for a 30-egg tray (about 43¢ an egg), <strong>$${PRICE.tray2}</strong> for two, <strong>$${PRICE.box}</strong> for a 180-egg box. Delivery is a flat $${PRICE.delivery}.`],
  ["How do I pay?", "By card when you order. Checkout is handled by Stripe."],
  ["Can delivery be free?", "Yes. After you pay you get a share link. A friend's first delivery through it is free, and so is your next one. When neighbours in the same building order for the same Saturday, the later orders ship free and the first gets free delivery next time."],
  ["What eggs are they?", EGGS_FAQ],
  ["Can I order in bulk?", `Yes. Order up to 10 boxes of 180 eggs. Cafés can <a href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">message us</a> for a weekly standing order. More on <a href="/bulk-eggs-sydney">bulk eggs</a>.`],
];

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
  html = html.replace(
    /(<!-- faq:start[^>]*-->\n)[\s\S]*?(\n\s*<!-- faq:end -->)/,
    (_, a, b) => a + faqHtml + b
  );
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
writeFileSync(join(ROOT, "sitemap.xml"), sitemap());
updateHome();
console.log(`Built ${SUBURB_PAGES.length} suburb pages, Sydney, bulk, areas, 404, sitemap and homepage data`);
