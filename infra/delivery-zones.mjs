// delivery-zones.mjs - YOLKO delivery zone check from Sydney Markets / Flemington.
//
// Owner rule (Jul 2026):
//   Within 45 km of Sydney Markets  -> +$5 flat delivery (Saturday only)
//   Beyond 45 km                    -> decline
//
// Same 45 km radius applies to Meta ads geo targeting.
//
// ASSUMPTIONS:
// - Hub is Paddy's Markets Flemington / Sydney Markets: -33.8667, 151.0694.
// - Suburb rows use locality centroids. Good enough for a 45 km gate.
// - Road distance ≈ haversine × ROAD_FACTOR (1.3). Harbour crossings use 1.5.
// - NSW centroids are bundled from the Matthew Proctor Australian postcodes
//   dataset (Delivery Area rows within 100 km of the hub). No runtime geocode API.
//
// Usage:
//   node infra/delivery-zones.mjs
//   node infra/delivery-zones.mjs --prove
//   node infra/delivery-zones.mjs --table
//   node infra/delivery-zones.mjs strathfield
//   node infra/delivery-zones.mjs --check "Padstow" "Sydney" "2211" "1 Padstow Pde"
//
// Exports: HUB, MAX_DELIVERY_KM, SITE_DELIVERY_FEE, ROAD_FACTOR, SUBURBS,
//   UNKNOWN_SUBURB_ERROR, haversineKm, needsHarbourCrossing, quoteDelivery,
//   checkDeliveryAddress, findSuburb

import NSW_CENTROIDS from "./nsw-suburb-centroids.mjs";

export const HUB = {
  name: "Paddy's Markets Flemington (Sydney Markets)",
  lat: -33.8667,
  lng: 151.0694,
};
export const ROAD_FACTOR = 1.3;
export const MAX_DELIVERY_KM = 45;
export const SITE_DELIVERY_FEE = 5;

export const UNKNOWN_SUBURB_ERROR =
  "We could not match that suburb or postcode. WhatsApp us or email orders@getyolko.com and we will check if we can deliver.";

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normPostcode(pc) {
  const digits = String(pc || "").replace(/\D/g, "");
  return digits.length === 4 ? digits : "";
}

// North of Sydney Harbour / east of Lane Cove typically needs a harbour bridge.
// Sutherland Shire south of the Georges River typically needs a river crossing.
export function needsHarbourCrossing(lat, lng) {
  const northShore = lat > -33.845 && lat < -33.55 && lng > 151.145;
  const laneCoveEast = lat > -33.83 && lat < -33.55 && lng > 151.13;
  const sutherland = lat < -34.01 && lat > -34.15 && lng > 150.97;
  return northShore || laneCoveEast || sutherland;
}

// Hand-tuned inner-Sydney rows: aliases, crossing flags, and hub-facing names
// that customers type (Flemington, Sydney CBD) which are not always official localities.
export const SUBURB_OVERRIDES = [
  { name: "Flemington", aliases: ["homebush west", "sydney markets"], lat: -33.871, lng: 151.07, postcodes: ["2129", "2140"] },
  { name: "Sydney Olympic Park", aliases: ["olympic park"], lat: -33.847, lng: 151.063, postcodes: ["2127"] },
  { name: "Homebush", lat: -33.865, lng: 151.084, postcodes: ["2140"] },
  { name: "Strathfield", lat: -33.879, lng: 151.082, postcodes: ["2135"] },
  { name: "North Strathfield", lat: -33.859, lng: 151.096, postcodes: ["2137"] },
  { name: "Lidcombe", lat: -33.864, lng: 151.045, postcodes: ["2141"] },
  { name: "Auburn", lat: -33.849, lng: 151.033, postcodes: ["2144"] },
  { name: "Silverwater", lat: -33.834, lng: 151.048, postcodes: ["2128"] },
  { name: "Newington", lat: -33.837, lng: 151.056, postcodes: ["2127"] },
  { name: "Wentworth Point", lat: -33.831, lng: 151.075, postcodes: ["2127"] },
  { name: "Rhodes", lat: -33.83, lng: 151.086, postcodes: ["2138"] },
  { name: "Concord", lat: -33.847, lng: 151.103, postcodes: ["2137"] },
  { name: "Concord West", lat: -33.84, lng: 151.086, postcodes: ["2138"] },
  { name: "Burwood", lat: -33.877, lng: 151.104, postcodes: ["2134"] },
  { name: "Croydon", lat: -33.883, lng: 151.115, postcodes: ["2132"] },
  { name: "Croydon Park", lat: -33.897, lng: 151.116, postcodes: ["2133"] },
  { name: "Ashfield", lat: -33.889, lng: 151.125, postcodes: ["2131"] },
  { name: "Summer Hill", lat: -33.892, lng: 151.138, postcodes: ["2130"] },
  { name: "Five Dock", lat: -33.867, lng: 151.128, postcodes: ["2046"] },
  { name: "Drummoyne", lat: -33.852, lng: 151.155, postcodes: ["2047"] },
  { name: "Leichhardt", lat: -33.884, lng: 151.157, postcodes: ["2040"] },
  { name: "Haberfield", lat: -33.88, lng: 151.139, postcodes: ["2045"] },
  { name: "Granville", lat: -33.833, lng: 151.011, postcodes: ["2142"] },
  { name: "Harris Park", lat: -33.823, lng: 151.008, postcodes: ["2150"] },
  { name: "Guildford", lat: -33.854, lng: 150.989, postcodes: ["2161"] },
  { name: "Merrylands", lat: -33.837, lng: 150.992, postcodes: ["2160"] },
  { name: "Parramatta", lat: -33.815, lng: 151.001, postcodes: ["2150"] },
  { name: "North Parramatta", lat: -33.795, lng: 151.01, postcodes: ["2151"] },
  { name: "Ermington", lat: -33.815, lng: 151.055, postcodes: ["2115"] },
  { name: "Rydalmere", lat: -33.812, lng: 151.03, postcodes: ["2116"] },
  { name: "West Ryde", lat: -33.807, lng: 151.089, postcodes: ["2114"] },
  { name: "Ryde", lat: -33.816, lng: 151.106, postcodes: ["2112"] },
  { name: "Eastwood", lat: -33.79, lng: 151.082, postcodes: ["2122"] },
  { name: "Epping", lat: -33.773, lng: 151.082, postcodes: ["2121"] },
  { name: "Carlingford", lat: -33.782, lng: 151.049, postcodes: ["2118"] },
  { name: "Bankstown", lat: -33.918, lng: 151.035, postcodes: ["2200"] },
  { name: "Punchbowl", lat: -33.929, lng: 151.052, postcodes: ["2196"] },
  { name: "Lakemba", lat: -33.92, lng: 151.076, postcodes: ["2195"] },
  { name: "Campsie", lat: -33.911, lng: 151.103, postcodes: ["2194"] },
  { name: "Canterbury", lat: -33.912, lng: 151.118, postcodes: ["2193"] },
  { name: "Earlwood", lat: -33.922, lng: 151.126, postcodes: ["2206"] },
  { name: "Marrickville", lat: -33.911, lng: 151.155, postcodes: ["2204"] },
  { name: "Dulwich Hill", lat: -33.905, lng: 151.139, postcodes: ["2203"] },
  { name: "Newtown", lat: -33.897, lng: 151.179, postcodes: ["2042"] },
  { name: "Enmore", lat: -33.899, lng: 151.172, postcodes: ["2042"] },
  { name: "Petersham", lat: -33.895, lng: 151.155, postcodes: ["2049"] },
  { name: "Stanmore", lat: -33.894, lng: 151.164, postcodes: ["2048"] },
  { name: "Annandale", lat: -33.882, lng: 151.17, postcodes: ["2038"] },
  { name: "Glebe", lat: -33.88, lng: 151.185, postcodes: ["2037"] },
  { name: "Ultimo", lat: -33.881, lng: 151.197, postcodes: ["2007"] },
  { name: "Pyrmont", lat: -33.87, lng: 151.195, postcodes: ["2009"] },
  { name: "Sydney CBD", aliases: ["sydney", "city", "cbd"], lat: -33.87, lng: 151.207, postcodes: ["2000"] },
  { name: "Surry Hills", lat: -33.884, lng: 151.212, postcodes: ["2010"] },
  { name: "Darlinghurst", lat: -33.879, lng: 151.22, postcodes: ["2010"] },
  { name: "Paddington", lat: -33.884, lng: 151.226, postcodes: ["2021"] },
  { name: "Bondi Junction", lat: -33.891, lng: 151.247, postcodes: ["2022"] },
  { name: "Bondi", aliases: ["bondi beach"], lat: -33.891, lng: 151.264, postcodes: ["2026"] },
  { name: "Coogee", lat: -33.921, lng: 151.255, postcodes: ["2034"] },
  { name: "Randwick", lat: -33.914, lng: 151.241, postcodes: ["2031"] },
  { name: "Kensington", lat: -33.909, lng: 151.222, postcodes: ["2033"] },
  { name: "Maroubra", lat: -33.95, lng: 151.244, postcodes: ["2035"] },
  { name: "Fairfield", lat: -33.873, lng: 150.956, postcodes: ["2165"] },
  { name: "Cabramatta", lat: -33.895, lng: 150.935, postcodes: ["2166"] },
  { name: "Liverpool", lat: -33.92, lng: 150.923, postcodes: ["2170"] },
  { name: "Bankstown Aerodrome", aliases: ["condell park"], lat: -33.928, lng: 151.005, postcodes: ["2200"] },
  { name: "Hurstville", lat: -33.967, lng: 151.103, postcodes: ["2220"] },
  { name: "Kogarah", lat: -33.968, lng: 151.134, postcodes: ["2217"] },
  { name: "Rockdale", lat: -33.952, lng: 151.137, postcodes: ["2216"] },
  { name: "Brighton-Le-Sands", aliases: ["brighton le sands"], lat: -33.96, lng: 151.155, postcodes: ["2216"] },
  { name: "Sans Souci", lat: -33.995, lng: 151.133, postcodes: ["2219"] },
  { name: "Beverly Hills", lat: -33.95, lng: 151.08, postcodes: ["2209"] },
  { name: "Roselands", lat: -33.934, lng: 151.072, postcodes: ["2196"] },
  { name: "Blacktown", lat: -33.771, lng: 150.906, postcodes: ["2148"] },
  { name: "Seven Hills", lat: -33.776, lng: 150.939, postcodes: ["2147"] },
  { name: "Toongabbie", lat: -33.788, lng: 150.952, postcodes: ["2146"] },
  { name: "Wentworthville", lat: -33.807, lng: 150.968, postcodes: ["2145"] },
  { name: "Westmead", lat: -33.808, lng: 150.988, postcodes: ["2145"] },
  { name: "Castle Hill", lat: -33.732, lng: 151.005, postcodes: ["2154"] },
  { name: "Baulkham Hills", lat: -33.759, lng: 150.993, postcodes: ["2153"] },
  { name: "Kellyville", lat: -33.71, lng: 150.955, postcodes: ["2155"] },
  { name: "Chatswood", lat: -33.797, lng: 151.183, postcodes: ["2067"], crossing: true },
  { name: "Willoughby", lat: -33.802, lng: 151.2, postcodes: ["2068"], crossing: true },
  { name: "North Sydney", lat: -33.84, lng: 151.207, postcodes: ["2060"], crossing: true },
  { name: "Neutral Bay", lat: -33.831, lng: 151.218, postcodes: ["2089"], crossing: true },
  { name: "Mosman", lat: -33.829, lng: 151.244, postcodes: ["2088"], crossing: true },
  { name: "Lane Cove", lat: -33.815, lng: 151.168, postcodes: ["2066"], crossing: true },
  { name: "Macquarie Park", lat: -33.777, lng: 151.124, postcodes: ["2113"] },
  { name: "Marsfield", lat: -33.778, lng: 151.103, postcodes: ["2122"] },
  { name: "Hornsby", lat: -33.704, lng: 151.099, postcodes: ["2077"] },
  { name: "Waitara", lat: -33.71, lng: 151.104, postcodes: ["2077"] },
  { name: "Gordon", lat: -33.756, lng: 151.152, postcodes: ["2072"], crossing: true },
  { name: "Manly", lat: -33.797, lng: 151.288, postcodes: ["2095"], crossing: true },
  { name: "Dee Why", lat: -33.753, lng: 151.288, postcodes: ["2099"], crossing: true },
  { name: "Brookvale", lat: -33.764, lng: 151.271, postcodes: ["2100"], crossing: true },
  { name: "Cronulla", lat: -34.058, lng: 151.152, postcodes: ["2230"], crossing: true },
  { name: "Sutherland", lat: -34.031, lng: 151.058, postcodes: ["2232"], crossing: true },
  { name: "Miranda", lat: -34.034, lng: 151.102, postcodes: ["2228"], crossing: true },
  { name: "Caringbah", lat: -34.043, lng: 151.122, postcodes: ["2229"], crossing: true },
  { name: "Penrith", lat: -33.751, lng: 150.694, postcodes: ["2750"] },
  { name: "St Marys", lat: -33.766, lng: 150.774, postcodes: ["2760"] },
  { name: "Campbelltown", lat: -34.065, lng: 150.814, postcodes: ["2560"] },
  { name: "Camden", lat: -34.054, lng: 150.696, postcodes: ["2570"] },
  { name: "Richmond", lat: -33.598, lng: 150.752, postcodes: ["2753"] },
  { name: "Windsor", lat: -33.606, lng: 150.814, postcodes: ["2756"] },
];

function rowFromCentroid(row) {
  const [name, lat, lng, ...postcodes] = row;
  return {
    name,
    lat,
    lng,
    postcodes: postcodes.map(String),
    crossing: needsHarbourCrossing(lat, lng),
    source: "dataset",
  };
}

function rowFromOverride(s) {
  return {
    name: s.name,
    aliases: s.aliases || [],
    lat: s.lat,
    lng: s.lng,
    postcodes: (s.postcodes || []).map(String),
    crossing: !!s.crossing,
    source: "override",
  };
}

function mergeSuburbLists() {
  const byKey = new Map();
  for (const raw of NSW_CENTROIDS) {
    const row = rowFromCentroid(raw);
    const key = normName(row.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  for (const raw of SUBURB_OVERRIDES) {
    const row = rowFromOverride(raw);
    const key = normName(row.name);
    // Overrides replace same-name dataset rows so existing quotes stay stable.
    byKey.set(key, [row]);
  }
  return [...byKey.values()].flat();
}

export const SUBURBS = mergeSuburbLists();

const byName = new Map();
const byPostcode = new Map();

function indexPush(map, key, suburb) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  if (!list.includes(suburb)) list.push(suburb);
}

for (const suburb of SUBURBS) {
  indexPush(byName, normName(suburb.name), suburb);
  for (const alias of suburb.aliases || []) indexPush(byName, normName(alias), suburb);
  for (const pc of suburb.postcodes || []) indexPush(byPostcode, pc, suburb);
}

function pickClosest(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return list.slice().sort((a, b) => {
    const da = haversineKm(HUB.lat, HUB.lng, a.lat, a.lng);
    const db = haversineKm(HUB.lat, HUB.lng, b.lat, b.lng);
    return da - db;
  })[0];
}

function namesOverlap(a, b) {
  return a.includes(b) || b.includes(a);
}

export function findSuburb({ suburb, city, postcode } = {}) {
  const pc = normPostcode(postcode);
  const suburbQ = normName(suburb);
  const cityQ = normName(city);

  if (suburbQ) {
    const exact = byName.get(suburbQ) || [];
    if (exact.length) {
      if (pc) {
        const withPc = exact.filter((s) => (s.postcodes || []).includes(pc));
        if (withPc.length) return pickClosest(withPc);
      }
      return pickClosest(exact);
    }

    if (pc) {
      const pcHits = byPostcode.get(pc) || [];
      const loose = pcHits.filter((s) => {
        const n = normName(s.name);
        const aliases = (s.aliases || []).map(normName);
        return namesOverlap(n, suburbQ) || aliases.some((a) => namesOverlap(a, suburbQ));
      });
      if (loose.length) return pickClosest(loose);
    }
  }

  if (pc) {
    const byPc = byPostcode.get(pc) || [];
    if (byPc.length === 1) return byPc[0];
    if (byPc.length > 1 && suburbQ) {
      const match = byPc.filter((s) => namesOverlap(normName(s.name), suburbQ));
      if (match.length) return pickClosest(match);
    }
    if (byPc.length > 1 && cityQ && cityQ !== "sydney" && cityQ !== "nsw") {
      const match = byPc.filter((s) => namesOverlap(normName(s.name), cityQ));
      if (match.length) return pickClosest(match);
    }
    if (byPc.length >= 1) return pickClosest(byPc);
  }

  if (cityQ && cityQ !== "sydney" && cityQ !== "nsw") {
    const byCity = byName.get(cityQ) || [];
    if (byCity.length) return pickClosest(byCity);
  }

  return null;
}

export function quoteDelivery(input) {
  let lat;
  let lng;
  let name;
  let crossing = false;
  let postcodes = [];
  if (typeof input === "string") {
    const hit = findSuburb({ suburb: input });
    if (!hit) return { ok: false, deliver: false, error: UNKNOWN_SUBURB_ERROR, code: "unknown_suburb" };
    ({ lat, lng, name } = hit);
    crossing = !!hit.crossing;
    postcodes = hit.postcodes || [];
  } else if (input && typeof input === "object" && (input.lat != null || input.suburb || input.postcode)) {
    if (input.lat != null && input.lng != null) {
      lat = Number(input.lat);
      lng = Number(input.lng);
      name = input.name || `${lat},${lng}`;
      crossing = input.crossing != null ? !!input.crossing : needsHarbourCrossing(lat, lng);
    } else {
      const hit = findSuburb(input);
      if (!hit) {
        return {
          ok: false,
          deliver: false,
          error: UNKNOWN_SUBURB_ERROR,
          code: "unknown_suburb",
        };
      }
      ({ lat, lng, name } = hit);
      crossing = !!hit.crossing;
      postcodes = hit.postcodes || [];
    }
  } else {
    return { ok: false, deliver: false, error: "Enter a suburb or postcode.", code: "missing_address" };
  }

  const straightKm = haversineKm(HUB.lat, HUB.lng, lat, lng);
  const factor = crossing ? 1.5 : ROAD_FACTOR;
  const roadKm = straightKm * factor;
  const deliver = roadKm <= MAX_DELIVERY_KM;
  return {
    ok: true,
    name,
    postcodes,
    straightKm: +straightKm.toFixed(1),
    roadKmEstimate: +roadKm.toFixed(1),
    maxKm: MAX_DELIVERY_KM,
    deliver,
    fee: deliver ? SITE_DELIVERY_FEE : null,
    band: deliver ? `<=${MAX_DELIVERY_KM}km` : `>${MAX_DELIVERY_KM}km`,
    note: deliver
      ? `Within ${MAX_DELIVERY_KM} km of Sydney Markets: +$${SITE_DELIVERY_FEE} Saturday delivery.`
      : `Outside ${MAX_DELIVERY_KM} km of Sydney Markets. We only deliver within this area.`,
  };
}

/** Validate structured delivery address for checkout / API. */
export function checkDeliveryAddress({ street, suburb, city, postcode } = {}) {
  const streetClean = String(street || "").trim().slice(0, 120);
  const suburbClean = String(suburb || "").trim().slice(0, 60);
  const cityClean = String(city || "").trim().slice(0, 60);
  const pc = normPostcode(postcode);

  if (streetClean.length < 3) {
    return { ok: false, deliver: false, code: "street", error: "Enter a street address." };
  }
  if (!suburbClean && !pc) {
    return { ok: false, deliver: false, code: "suburb", error: "Enter suburb and postcode." };
  }
  if (pc && !/^2\d{3}$/.test(pc)) {
    return { ok: false, deliver: false, code: "postcode", error: "Enter a valid NSW postcode." };
  }

  const quote = quoteDelivery({ suburb: suburbClean, city: cityClean, postcode: pc });
  if (!quote.ok) {
    return {
      ok: false,
      deliver: false,
      code: quote.code || "unknown_suburb",
      error: quote.error || UNKNOWN_SUBURB_ERROR,
      street: streetClean,
      suburb: suburbClean,
      city: cityClean,
      postcode: pc,
    };
  }

  const formatted = [streetClean, quote.name || suburbClean, cityClean || "NSW", pc].filter(Boolean).join(", ");

  if (!quote.deliver) {
    return {
      ok: false,
      deliver: false,
      code: "out_of_range",
      error: quote.note,
      fee: null,
      roadKmEstimate: quote.roadKmEstimate,
      maxKm: MAX_DELIVERY_KM,
      matchedSuburb: quote.name,
      formatted,
      street: streetClean,
      suburb: suburbClean,
      city: cityClean,
      postcode: pc,
    };
  }

  return {
    ok: true,
    deliver: true,
    fee: SITE_DELIVERY_FEE,
    roadKmEstimate: quote.roadKmEstimate,
    maxKm: MAX_DELIVERY_KM,
    matchedSuburb: quote.name,
    formatted,
    street: streetClean,
    suburb: suburbClean || quote.name,
    city: cityClean || "Sydney",
    postcode: pc,
    note: quote.note,
  };
}

export const PROVE_CASES = [
  { suburb: "Padstow", city: "Sydney", postcode: "2211", street: "1 Padstow Pde", expect: "deliver" },
  { suburb: "Revesby", city: "Sydney", postcode: "2212", street: "1 The River Rd", expect: "deliver" },
  { suburb: "Panania", city: "Sydney", postcode: "2213", street: "1 Tower St", expect: "deliver" },
  { suburb: "Bankstown", city: "Sydney", postcode: "2200", street: "1 Chapel Rd", expect: "deliver" },
  { suburb: "Liverpool", city: "Sydney", postcode: "2170", street: "1 Macquarie St", expect: "deliver" },
  { suburb: "Hurstville", city: "Sydney", postcode: "2220", street: "1 Forest Rd", expect: "deliver" },
  { suburb: "Penrith", city: "Sydney", postcode: "2750", street: "1 High St", expect: "decline" },
  { suburb: "Gosford", city: "Sydney", postcode: "2250", street: "1 Mann St", expect: "decline" },
  { suburb: "NotARealSuburb", city: "Sydney", postcode: "2999", street: "1 Mystery St", expect: "unknown" },
];

function pad(v, n) {
  return String(v).padEnd(n);
}

export function proveRows() {
  return PROVE_CASES.map((c) => {
    const result = checkDeliveryAddress(c);
    return { ...c, result };
  });
}

function printProve() {
  console.log(pad("Suburb", 22) + pad("PC", 8) + pad("Matched", 22) + pad("~road km", 10) + pad("OK?", 8) + "Code");
  for (const row of proveRows()) {
    const r = row.result;
    const ok = r.deliver ? "YES" : "NO";
    console.log(
      pad(row.suburb, 22) +
        pad(row.postcode, 8) +
        pad(r.matchedSuburb || "-", 22) +
        pad(r.roadKmEstimate ?? "-", 10) +
        pad(ok, 8) +
        (r.code || (r.deliver ? "in_range" : ""))
    );
  }
}

function printTable() {
  const rows = SUBURBS.map((s) => quoteDelivery({ suburb: s.name, postcode: s.postcodes?.[0] })).sort(
    (a, b) => (a.roadKmEstimate || 99) - (b.roadKmEstimate || 99)
  );
  console.log(pad("Suburb", 28) + pad("~road km", 10) + pad("OK?", 8) + "Fee");
  for (const r of rows) {
    if (!r.ok) continue;
    console.log(
      pad(r.name, 28) +
        pad(r.roadKmEstimate, 10) +
        pad(r.deliver ? "YES" : "NO", 8) +
        (r.deliver ? `$${r.fee}` : "DECLINE")
    );
  }
}

function runningAsCli() {
  try {
    return typeof process !== "undefined" && !!process.argv?.[1] &&
      import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--prove") {
    printProve();
  } else if (args[0] === "--table") {
    printTable();
  } else if (args[0] === "--check") {
    const [, suburb, city, postcode, ...streetParts] = args;
    const street = streetParts.length ? streetParts.join(" ") : "1 Test St";
    console.log(JSON.stringify(checkDeliveryAddress({ street, suburb, city, postcode }), null, 2));
  } else if (args.length === 2 && !isNaN(parseFloat(args[0]))) {
    console.log(JSON.stringify(quoteDelivery({ lat: parseFloat(args[0]), lng: parseFloat(args[1]) }), null, 2));
  } else {
    console.log(JSON.stringify(quoteDelivery(args.join(" ")), null, 2));
  }
}
