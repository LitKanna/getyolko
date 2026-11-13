// Fill these in to activate WhatsApp booking.
// Online payments use dynamic Stripe Checkout from live admin prices
// (Worker POST /api/checkout); do NOT paste fixed Payment Links here.
// Old buy.stripe.com links freeze prices ($12/$23/$66) and ignore delivery.

const SITE_CONFIG = {
  // Bump when site assets change, to force browsers to fetch fresh files.
  assetVersion: "82",

  // The shop's WhatsApp number in international format, digits only. Only ever YOLKO's own
  // line ("61480093935", WhatsApp Business since 13 Nov 2026), never a personal mobile.
  // Leave it empty and the shop shows no WhatsApp links and asks for an email.
  whatsappNumber: "61480093935",

  // Deprecated: fixed Stripe Payment Links. Left empty on purpose.
  // Buy now / Pay online always call /api/checkout with live tray/box prices
  // (+ $5 delivery when the order is Saturday delivery).
  stripeLinks: {
    tray1: "",
    tray2: "",
    box: "",
  },
};
