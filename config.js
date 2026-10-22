// Fill these in to activate WhatsApp booking.
// Online payments use dynamic Stripe Checkout from live admin prices
// (Worker POST /api/checkout); do NOT paste fixed Payment Links here.
// Old buy.stripe.com links freeze prices ($12/$23/$66) and ignore delivery.

const SITE_CONFIG = {
  // Bump when site assets change, to force browsers to fetch fresh files.
  assetVersion: "82",

  // Your WhatsApp number in international format, digits only.
  // Example for an Australian mobile 0412 345 678: "61412345678"
  whatsappNumber: "61433975055",

  // Deprecated: fixed Stripe Payment Links. Left empty on purpose.
  // Buy now / Pay online always call /api/checkout with live tray/box prices
  // (+ $5 delivery when the order is Saturday delivery).
  stripeLinks: {
    tray1: "",
    tray2: "",
    box: "",
  },
};
