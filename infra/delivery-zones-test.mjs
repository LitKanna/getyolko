// Quick delivery-zone checks. Run: node infra/delivery-zones-test.mjs
import {
  checkDeliveryAddress,
  quoteDelivery,
  SUBURB_OVERRIDES,
  UNKNOWN_SUBURB_ERROR,
  proveRows,
} from "./delivery-zones.mjs";

const failures = [];

function assert(cond, message) {
  if (!cond) failures.push(message);
}

function hasEmDash(s) {
  return /[\u2012\u2013\u2014\u2015]/.test(String(s || ""));
}

const prove = proveRows();
const bySuburb = Object.fromEntries(prove.map((row) => [row.suburb, row]));

for (const suburb of ["Padstow", "Revesby", "Panania", "Bankstown", "Liverpool", "Hurstville"]) {
  const row = bySuburb[suburb];
  assert(row, `missing prove row ${suburb}`);
  if (!row) continue;
  assert(row.result.ok && row.result.deliver, `${suburb} should be accepted`);
  assert(row.result.code !== "unknown_suburb", `${suburb} should not be unknown_suburb`);
  assert(row.result.code !== "out_of_range", `${suburb} should not be out_of_range`);
  assert(row.result.roadKmEstimate > 0 && row.result.roadKmEstimate <= 45, `${suburb} road km should be within 45`);
}

assert(bySuburb.Padstow.result.roadKmEstimate <= 25, `Padstow should be about 15 km, got ${bySuburb.Padstow.result.roadKmEstimate}`);
assert(bySuburb.Padstow.result.matchedSuburb === "Padstow", "Padstow should match Padstow");

for (const suburb of ["Penrith", "Gosford"]) {
  const row = bySuburb[suburb];
  assert(row.result.ok === false, `${suburb} should not be ok`);
  assert(row.result.deliver === false, `${suburb} should be declined`);
  assert(row.result.code === "out_of_range", `${suburb} should be out_of_range, got ${row.result.code}`);
  assert(row.result.roadKmEstimate > 45, `${suburb} road km should be over 45, got ${row.result.roadKmEstimate}`);
}

const unknown = bySuburb.NotARealSuburb.result;
assert(unknown.ok === false, "unknown should not be ok");
assert(unknown.deliver === false, "unknown should not deliver");
assert(unknown.code === "unknown_suburb", `unknown code should be unknown_suburb, got ${unknown.code}`);
assert(unknown.code !== "out_of_range", "unknown must not be reported as out of range");
assert(unknown.error === UNKNOWN_SUBURB_ERROR, "unknown should use the contact-us message");
assert(/orders@getyolko\.com/i.test(unknown.error), "unknown message should include orders@getyolko.com");
// WhatsApp Business is live on the shop's own line since 13 Nov 2026.
assert(/whatsapp/i.test(unknown.error), "unknown message should offer WhatsApp");

const padstowPcOnly = checkDeliveryAddress({ street: "1 Padstow Pde", suburb: "", city: "Sydney", postcode: "2211" });
assert(padstowPcOnly.deliver === true, "postcode 2211 alone should deliver");
assert(/padstow/i.test(padstowPcOnly.matchedSuburb || ""), `2211 should match Padstow, got ${padstowPcOnly.matchedSuburb}`);

const declineOverrides = new Set(["Penrith", "Windsor", "Camden", "Richmond"]);
for (const suburb of SUBURB_OVERRIDES) {
  const quote = quoteDelivery(suburb.name);
  assert(quote.ok, `override ${suburb.name} should still resolve`);
  if (declineOverrides.has(suburb.name)) {
    assert(quote.deliver === false, `override ${suburb.name} should still decline`);
  } else {
    assert(quote.deliver === true, `override ${suburb.name} should still be in range (${quote.roadKmEstimate} km)`);
  }
}

const userFacing = [
  UNKNOWN_SUBURB_ERROR,
  quoteDelivery("Padstow").note,
  quoteDelivery("Penrith").note,
  checkDeliveryAddress({ street: "x", suburb: "Padstow", postcode: "2211" }).error,
  checkDeliveryAddress({ street: "1 High St", suburb: "Penrith", postcode: "2750" }).error,
  checkDeliveryAddress({ street: "1 Mystery St", suburb: "NoSuchPlace", postcode: "2999" }).error,
];
for (const text of userFacing) {
  assert(!hasEmDash(text), `user-facing copy has an em dash: ${text}`);
}

if (failures.length) {
  console.error("FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("OK  delivery-zones tests passed");
for (const row of prove) {
  const r = row.result;
  console.log(
    `${row.suburb.padEnd(18)} ${String(r.matchedSuburb || "-").padEnd(18)} ${String(r.roadKmEstimate ?? "-").padStart(5)} km  ${r.deliver ? "YES" : "NO "}  ${r.code || "in_range"}`
  );
}
