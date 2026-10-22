const DOZENS_PER_CASE = 15;

const BUNDLES = {
  tray1: { label: "1 tray (30 eggs)", price: 13, eggs: 30, kind: "tray" },
  tray2: { label: "2 trays (60 eggs)", price: 25, eggs: 60, kind: "tray" },
  box: { label: "Full box (6 trays, 180 eggs)", price: 72, eggs: 180, kind: "tray" },
  cage600: { label: "Cage dozen 600g", price: 6, eggs: 12, kind: "dozen", housing: "cage", weight: "600g" },
  cage700: { label: "Cage dozen 700g", price: 7, eggs: 12, kind: "dozen", housing: "cage", weight: "700g" },
  cage800: { label: "Cage dozen 800g", price: 8, eggs: 12, kind: "dozen", housing: "cage", weight: "800g" },
  fr600: { label: "Free range dozen 600g", price: 8, eggs: 12, kind: "dozen", housing: "free range", weight: "600g" },
  fr700: { label: "Free range dozen 700g", price: 9, eggs: 12, kind: "dozen", housing: "free range", weight: "700g" },
  fr800: { label: "Free range dozen 800g", price: 10, eggs: 12, kind: "dozen", housing: "free range", weight: "800g" },
  cage600case: { label: "Cage case 600g (15 dozens)", price: 90, eggs: 180, kind: "case", housing: "cage", weight: "600g", unitKey: "cage600" },
  cage700case: { label: "Cage case 700g (15 dozens)", price: 105, eggs: 180, kind: "case", housing: "cage", weight: "700g", unitKey: "cage700" },
  cage800case: { label: "Cage case 800g (15 dozens)", price: 120, eggs: 180, kind: "case", housing: "cage", weight: "800g", unitKey: "cage800" },
  fr600case: { label: "Free range case 600g (15 dozens)", price: 120, eggs: 180, kind: "case", housing: "free range", weight: "600g", unitKey: "fr600" },
  fr700case: { label: "Free range case 700g (15 dozens)", price: 135, eggs: 180, kind: "case", housing: "free range", weight: "700g", unitKey: "fr700" },
  fr800case: { label: "Free range case 800g (15 dozens)", price: 150, eggs: 180, kind: "case", housing: "free range", weight: "800g", unitKey: "fr800" },
};

const BUNDLE_KEYS = Object.keys(BUNDLES);

const config = typeof SITE_CONFIG === "object" && SITE_CONFIG !== null ? SITE_CONFIG : {};

const form = document.getElementById("order-form");
const doneSection = document.getElementById("done");
const doneSummary = document.getElementById("done-summary");
const whatsappLink = document.getElementById("whatsapp-send");
const stripeLink = document.getElementById("stripe-pay");
const copyButton = document.getElementById("copy-message");
const againButton = document.getElementById("again");
const orderSection = document.getElementById("order");
const stockNote = document.getElementById("stock-note");
const receipt = {
  name: document.getElementById("r-name"),
  phone: document.getElementById("r-phone"),
  order: document.getElementById("r-order"),
  pickup: document.getElementById("r-pickup"),
  total: document.getElementById("r-total"),
};

let lastOrderMessage = "";
let lastOrderId = null;

const OPEN_CHECKOUT_KEY = "yolko_open_checkout";

function bookingFingerprint(b) {
  return [
    b.phoneDigits,
    b.bundleKey,
    b.quantity,
    b.fulfillment,
    b.deliveryPostcode || "",
    b.deliverySuburb || "",
    b.pickupDay,
  ].join("|");
}

function saveOpenCheckout(orderId, b) {
  if (!orderId) return;
  try {
    sessionStorage.setItem(
      OPEN_CHECKOUT_KEY,
      JSON.stringify({ orderId, fp: bookingFingerprint(b), at: Date.now() })
    );
  } catch {
    /* private mode */
  }
}

function loadMatchingCheckout(b) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(OPEN_CHECKOUT_KEY) || "null");
    if (!raw || !raw.orderId) return null;
    if (Date.now() - Number(raw.at || 0) > 6 * 3600 * 1000) return null;
    if (raw.fp !== bookingFingerprint(b)) return null;
    return raw.orderId;
  } catch {
    return null;
  }
}

function clearOpenCheckout() {
  try {
    sessionStorage.removeItem(OPEN_CHECKOUT_KEY);
  } catch {
    /* ignore */
  }
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Hero / order tray image auto-rotate ---------- */
const rotatorTimers = [];
const HERO_SIZES = "(max-width: 900px) min(100vw - 24px, 480px), min(50vw, 560px)";
const ASSET_CACHE_VER = "112";

function clearImageRotators() {
  while (rotatorTimers.length) {
    const t = rotatorTimers.pop();
    window.clearTimeout(t.timeoutId);
    window.clearInterval(t.intervalId);
  }
}

function initImageRotators() {
  clearImageRotators();
  if (reducedMotion) return;

  document.querySelectorAll("[data-rotator]").forEach((root) => {
    const slides = [...root.querySelectorAll(".showcase-photo, .order-tray-photo")];
    if (slides.length < 2) return;

    let index = slides.findIndex((slide) => slide.classList.contains("is-active"));
    if (index < 0) {
      index = 0;
      slides[0].classList.add("is-active");
    }

    const intervalMs = root.dataset.rotator === "order" ? 14000 : 12000;
    const offsetMs = root.dataset.rotator === "order" ? 3500 : 0;
    const fadeMs = 900;
    const state = { timeoutId: 0, intervalId: 0 };

    state.timeoutId = window.setTimeout(() => {
      state.intervalId = window.setInterval(() => {
        const prev = slides[index];
        index = (index + 1) % slides.length;
        const next = slides[index];

        // Keep outgoing slide under the incoming one until fade finishes
        // so the frame never flashes empty mid-transition.
        prev.classList.add("is-leaving");
        prev.classList.remove("is-active");
        next.classList.add("is-active");

        window.setTimeout(() => {
          prev.classList.remove("is-leaving");
        }, fadeMs);
      }, intervalMs);
    }, offsetMs);

    rotatorTimers.push(state);
  });
}

initImageRotators();

/* Chalkboard hero swaps to match live tray1 price ($1-$30); dozens unchanged */
const CHALK_PRICES = Array.from({ length: 30 }, (_, i) => i + 1);
const CHALK_ASSET_VER = "112";
const TRAY1_PRICE_CACHE_KEY = "yolko.tray1Price";

function chalkPriceKey(price) {
  const n = Math.round(Number(price));
  if (CHALK_PRICES.includes(n)) return n;
  if (!Number.isFinite(n)) return 14;
  if (n < 1) return 1;
  if (n > 30) return 30;
  return 14;
}

function readCachedTray1Price() {
  try {
    const n = Math.round(Number(localStorage.getItem(TRAY1_PRICE_CACHE_KEY)));
    if (CHALK_PRICES.includes(n)) return n;
  } catch (_) {}
  const boot = Math.round(Number(window.__YOLKO_TRAY1));
  if (CHALK_PRICES.includes(boot)) return boot;
  return null;
}

function cacheTray1Price(price) {
  try {
    localStorage.setItem(TRAY1_PRICE_CACHE_KEY, String(chalkPriceKey(price)));
  } catch (_) {}
}

const cachedTray1 = readCachedTray1Price();
if (cachedTray1 != null) BUNDLES.tray1.price = cachedTray1;

function withVer(path) {
  if (!path) return "";
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `${clean}${clean.includes("?") ? "&" : "?"}v=${ASSET_CACHE_VER}`;
}

function chalkHeroUrls(p) {
  return {
    primary: `assets/chalk-tray/${p}-1536.jpg?v=${CHALK_ASSET_VER}`,
    imgSrcset: `assets/chalk-tray/${p}-640.jpg?v=${CHALK_ASSET_VER} 640w, assets/chalk-tray/${p}-928.jpg?v=${CHALK_ASSET_VER} 928w, assets/chalk-tray/${p}-1536.jpg?v=${CHALK_ASSET_VER} 1536w, assets/chalk-tray/${p}-2048.jpg?v=${CHALK_ASSET_VER} 2048w`,
    webpSrcset: `assets/chalk-tray/${p}-640.webp?v=${CHALK_ASSET_VER} 640w, assets/chalk-tray/${p}-928.webp?v=${CHALK_ASSET_VER} 928w, assets/chalk-tray/${p}-1536.webp?v=${CHALK_ASSET_VER} 1536w, assets/chalk-tray/${p}-2048.webp?v=${CHALK_ASSET_VER} 2048w`,
    alt: `Fresh eggs · $${p}/tray at the YOLKO stall`,
  };
}

function chalkOrderUrls(p) {
  return {
    primary: `assets/chalk-tray/${p}-square-560.jpg?v=${CHALK_ASSET_VER}`,
    webpSrcset: `assets/chalk-tray/${p}-square-560.webp?v=${CHALK_ASSET_VER}`,
    alt: `Fresh eggs · $${p}/tray`,
  };
}

function preloadImage(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(); return; }
    const im = new Image();
    im.decoding = "async";
    im.onload = () => {
      if (im.decode) im.decode().then(resolve, resolve);
      else resolve();
    };
    im.onerror = () => resolve();
    im.src = url;
  });
}

function waitMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

let chalkSwapToken = 0;

async function swapChalkPicture(pic, p) {
  const kind = pic.getAttribute("data-chalk-price");
  const source = pic.querySelector("source:not([data-chalk-hold])");
  const img = pic.querySelector("img:not([data-chalk-hold])");
  if (!img) return;

  if (img.dataset.chalkShowing === String(p)) return;

  const urls = kind === "hero" ? chalkHeroUrls(p) : chalkOrderUrls(p);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  await preloadImage(urls.primary);

  // If a newer swap started, bail.
  if (pic.dataset.chalkSwapPending && pic.dataset.chalkSwapPending !== String(p)) return;

  // Hold the current frame on top while the main img swaps underneath.
  pic.querySelectorAll("[data-chalk-hold]").forEach((el) => el.remove());
  const hold = img.cloneNode(true);
  hold.removeAttribute("id");
  hold.setAttribute("data-chalk-hold", "1");
  hold.setAttribute("aria-hidden", "true");
  hold.classList.add("chalk-hold");
  pic.appendChild(hold);

  if (kind === "hero") {
    if (source) {
      source.srcset = urls.webpSrcset;
      source.sizes = HERO_SIZES;
    }
    img.src = urls.primary;
    img.srcset = urls.imgSrcset;
    img.sizes = HERO_SIZES;
    img.width = 1536;
    img.height = 1536;
  } else {
    if (source) source.srcset = urls.webpSrcset;
    img.src = urls.primary;
    img.removeAttribute("srcset");
  }
  img.alt = urls.alt;
  img.dataset.chalkShowing = String(p);

  try { await img.decode(); } catch (_) {}

  if (reduceMotion) {
    hold.remove();
    return;
  }

  // Force paint of hold, then fade it away over the already-decoded new frame.
  hold.getBoundingClientRect();
  await waitMs(16);
  hold.classList.add("is-fading");
  await waitMs(560);
  if (hold.parentNode === pic) hold.remove();
}

function applyChalkPriceImage(trayPrice) {
  const p = chalkPriceKey(trayPrice);
  const token = ++chalkSwapToken;
  const pics = [...document.querySelectorAll("picture[data-chalk-price]")];
  pics.forEach((pic) => { pic.dataset.chalkSwapPending = String(p); });

  // Fire-and-forget async crossfades; never blank the frame while loading.
  Promise.all(pics.map((pic) => {
    if (token !== chalkSwapToken) return null;
    return swapChalkPicture(pic, p);
  })).catch(() => {});
}

function heroSrcset(item) {
  const h = item.hero || {};
  if (h.webp640 && h.webp928) {
    return {
      webp: `${withVer(h.webp640)} 640w, ${withVer(h.webp928)} 928w`,
      jpg: `${withVer(h.jpg640 || h.jpg928)} 640w, ${withVer(h.jpg928 || h.jpg640)} 928w`,
      src: withVer(h.jpg928 || h.jpg640 || h.jpg1080 || h.jpg1400),
    };
  }
  const jpg = h.jpg1080 || h.jpg1400 || h.jpg700 || h.jpg540 || (item.square && item.square.jpg) || item.preview;
  const webp = h.webp1080 || h.webp640 || (item.square && item.square.webp);
  return {
    webp: webp ? `${withVer(webp)} 1080w` : "",
    jpg: jpg ? `${withVer(jpg)} 1080w` : "",
    src: withVer(jpg),
  };
}

function buildHeroPicture(item, index) {
  const isChalk = item.kind === "chalk";
  const active = index === 0 ? " is-active" : "";
  const chalkAttr = isChalk ? ' data-chalk-price="hero"' : "";
  const idAttr = index === 0 ? ' id="hero-tray-img"' : "";
  const loading = index === 0 ? ' fetchpriority="high"' : ' loading="lazy"';
  if (isChalk) {
    // Always use live tray1 price; asset chalkPrice is only the registry id (e.g. chalk-tray/12).
    const p = chalkPriceKey(BUNDLES.tray1.price);
    return `<picture class="showcase-photo${active}"${chalkAttr}>
      <source type="image/webp" srcset="assets/chalk-tray/${p}-640.webp?v=${CHALK_ASSET_VER} 640w, assets/chalk-tray/${p}-928.webp?v=${CHALK_ASSET_VER} 928w, assets/chalk-tray/${p}-1536.webp?v=${CHALK_ASSET_VER} 1536w, assets/chalk-tray/${p}-2048.webp?v=${CHALK_ASSET_VER} 2048w" sizes="${HERO_SIZES}">
      <img${idAttr} src="assets/chalk-tray/${p}-1536.jpg?v=${CHALK_ASSET_VER}" srcset="assets/chalk-tray/${p}-640.jpg?v=${CHALK_ASSET_VER} 640w, assets/chalk-tray/${p}-928.jpg?v=${CHALK_ASSET_VER} 928w, assets/chalk-tray/${p}-1536.jpg?v=${CHALK_ASSET_VER} 1536w, assets/chalk-tray/${p}-2048.jpg?v=${CHALK_ASSET_VER} 2048w" sizes="${HERO_SIZES}" alt="Fresh eggs · $${p}/tray at the YOLKO stall" width="1536" height="1536" data-chalk-showing="${p}"${loading} decoding="async">
    </picture>`;
  }
  const src = heroSrcset(item);
  const source = src.webp
    ? `<source type="image/webp" srcset="${src.webp}" sizes="${HERO_SIZES}">`
    : "";
  return `<picture class="showcase-photo${active}">
      ${source}
      <img${idAttr} src="${src.src}" ${src.jpg ? `srcset="${src.jpg}"` : ""} sizes="${HERO_SIZES}" alt="${item.label || "YOLKO eggs"}" width="928" height="1242"${loading} decoding="async">
    </picture>`;
}

function buildOrderPicture(item, index) {
  const isChalk = item.kind === "chalk";
  const active = index === 0 ? " is-active" : "";
  const chalkAttr = isChalk ? ' data-chalk-price="order"' : "";
  const idAttr = index === 0 ? ' id="order-tray-img"' : "";
  if (isChalk) {
    const p = chalkPriceKey(item.chalkPrice || BUNDLES.tray1.price);
    return `<picture class="order-tray-photo${active}"${chalkAttr}>
      <source type="image/webp" srcset="assets/chalk-tray/${p}-square-560.webp?v=${CHALK_ASSET_VER}">
      <img${idAttr} src="assets/chalk-tray/${p}-square-560.jpg?v=${CHALK_ASSET_VER}" alt="Fresh eggs · $${p}/tray" width="560" height="560" data-chalk-showing="${p}" loading="lazy" decoding="async">
    </picture>`;
  }
  const sq = item.square || {};
  const jpg = withVer(sq.jpg || item.preview);
  const webp = sq.webp ? withVer(sq.webp) : "";
  return `<picture class="order-tray-photo${active}">
      ${webp ? `<source type="image/webp" srcset="${webp}">` : ""}
      <img${idAttr} src="${jpg}" alt="" width="560" height="560" loading="lazy" decoding="async">
    </picture>`;
}

async function applyPublishedAssets(apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/assets`, { credentials: "omit" });
    if (!res.ok) return;
    const data = await res.json();
    const published = Array.isArray(data.published) ? data.published : [];
    if (!published.length) return;

    const heroRoot = document.querySelector('.showcase-rotator[data-rotator="hero"]');
    const orderRoot = document.querySelector('.order-tray-rotator[data-rotator="order"]');
    if (heroRoot) heroRoot.innerHTML = published.map(buildHeroPicture).join("");
    if (orderRoot) orderRoot.innerHTML = published.map(buildOrderPicture).join("");
    applyChalkPriceImage(BUNDLES.tray1.price);
    initImageRotators();
  } catch (_) {
    // Keep HTML defaults if the asset API is unavailable.
  }
}

applyChalkPriceImage(BUNDLES.tray1.price);

/* ---------- Ticker: always covers the screen, loops seamlessly ---------- */
const TICKER_ITEMS = [
  "Fresh eggs every week",
  "30 eggs for $13",
  "Pace Farm trays",
  "Book online",
];

function renderTicker() {
  const track = document.getElementById("ticker-track");
  if (!track) return;

  const dot = '<i>\u2B24</i>';
  const base = TICKER_ITEMS.map((t) => `<span>${t}</span>${dot}`).join("");

  // Measure one copy, then repeat until each half is wider than the screen,
  // so the tail never leaves an empty gap before the loop restarts.
  track.innerHTML = `<div class="ticker-half">${base}</div>`;
  const half = track.firstElementChild;
  const copies = Math.max(1, Math.ceil(window.innerWidth / Math.max(1, half.scrollWidth)));
  const filled = base.repeat(copies);
  track.innerHTML = `<div class="ticker-half">${filled}</div><div class="ticker-half">${filled}</div>`;

  // Constant scroll speed regardless of content length
  const speed = 65; // px per second
  track.style.animationDuration = `${Math.round(track.firstElementChild.scrollWidth / speed)}s`;
}

renderTicker();

let tickerResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(tickerResizeTimer);
  tickerResizeTimer = setTimeout(renderTicker, 250);
});

/* ---------- Scroll effects, throttled to one update per frame ---------- */
const topbar = document.querySelector(".topbar");
let scrollTicking = false;

function onScrollFrame() {
  topbar.classList.toggle("scrolled", window.scrollY > 8);
  updateMobileCta();
  scrollTicking = false;
}

window.addEventListener("scroll", () => {
  if (!scrollTicking) {
    scrollTicking = true;
    requestAnimationFrame(onScrollFrame);
  }
}, { passive: true });

/* ---------- Scroll reveal ---------- */
const revealTargets = document.querySelectorAll(
  ".section-head, .price-card, .day-card, .steps, .trust-row p, .order-copy, .order-form, .faq details, .stock-note"
);

revealTargets.forEach((el, i) => {
  el.classList.add("reveal");
  el.style.setProperty("--reveal-delay", `${(i % 4) * 70}ms`);
});

if (!reducedMotion && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

  revealTargets.forEach((el) => io.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("in"));
}

/* ---------- Cursor-following glow on price cards ---------- */
if (!reducedMotion && window.matchMedia("(hover: hover)").matches) {
  document.querySelectorAll(".price-card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      card.style.setProperty("--my", `${e.clientY - rect.top}px`);
    });
  });
}

/* ---------- Sticky mobile booking bar ---------- */
const mobileCta = document.getElementById("mobile-cta");
const heroSection = document.querySelector(".hero");

function updateMobileCta() {
  const pastHero = window.scrollY > heroSection.offsetHeight * 0.7;
  const orderRect = orderSection.getBoundingClientRect();
  const doneVisible = !doneSection.hidden;
  const orderOnScreen = orderRect.top < window.innerHeight && orderRect.bottom > 0;
  const show = pastHero && !orderOnScreen && !doneVisible;
  mobileCta.classList.toggle("show", show);
  // Keep the off-screen bar out of the tab order / a11y tree until it slides in.
  mobileCta.inert = !show;
}

/* ---------- Booking controls ---------- */
const quantityInput = document.getElementById("quantity");
const qtyValue = document.getElementById("qty-value");

function currentBundle() {
  const checked = document.querySelector('input[name="bundle"]:checked');
  return checked ? checked.value : "tray2";
}

const DELIVERY_FEE = 5;

function currentFulfillment() {
  // Storefront is delivery-only (no market pickup).
  return "delivery";
}

function setBundle(key) {
  const radio = document.querySelector(`input[name="bundle"][value="${key}"]`);
  if (radio) {
    radio.checked = true;
    refreshSubmitPrice();
  }
}

function currentPickupDay() {
  if (currentFulfillment() === "delivery") return "Saturday";
  const checked = document.querySelector('input[name="pickupDay"]:checked');
  return checked ? checked.value : "Saturday";
}

function currentQuantity() {
  return Math.max(1, parseInt(quantityInput.value, 10) || 1);
}

function setQuantity(qty) {
  const next = Math.min(10, Math.max(1, qty));
  quantityInput.value = String(next);
  qtyValue.textContent = String(next);
  // Brief pop so the quantity change registers visually.
  qtyValue.classList.remove("bump");
  void qtyValue.offsetWidth;
  qtyValue.classList.add("bump");
  refreshSubmitPrice();
}

document.getElementById("qty-minus").addEventListener("click", () => setQuantity(currentQuantity() - 1));
document.getElementById("qty-plus").addEventListener("click", () => setQuantity(currentQuantity() + 1));

function eggCount(bundleKey) {
  const b = BUNDLES[bundleKey];
  return b && b.eggs ? b.eggs : 30;
}

// Human-clear order description
function describeOrder(bundleKey, qty) {
  const b = BUNDLES[bundleKey] || BUNDLES.tray1;
  const eggs = (eggCount(bundleKey) * qty).toLocaleString("en-AU");
  if (b.kind === "dozen") {
    const unit = `${b.housing === "cage" ? "Cage" : "Free range"} dozen ${b.weight}`;
    return qty === 1 ? `${unit} (12 eggs)` : `${qty}× ${unit} (${eggs} eggs)`;
  }
  if (b.kind === "case") {
    const unit = `${b.housing === "cage" ? "Cage" : "Free range"} case ${b.weight}`;
    return qty === 1
      ? `${unit} (15 dozens, 180 eggs)`
      : `${qty}× ${unit} (${eggs} eggs)`;
  }
  if (bundleKey === "box") {
    return qty === 1
      ? `Full box (6 trays, 180 eggs)`
      : `${qty} full boxes (${eggs} eggs)`;
  }
  const trays = (bundleKey === "tray2" ? 2 : 1) * qty;
  return trays === 1 ? `1 tray (30 eggs)` : `${trays} trays (${eggs} eggs)`;
}

function refreshSubmitPrice() {
  // Order summary strip removed. Buy now is the only CTA.
}

function syncFulfillmentUI() {
  const whenLabel = document.getElementById("when-label");
  const daySeg = document.getElementById("day-seg");
  const addrField = document.getElementById("delivery-address-field");
  const streetInput = document.getElementById("delivery-street");
  const suburbInput = document.getElementById("delivery-suburb");
  const postcodeInput = document.getElementById("delivery-postcode");
  const formNote = document.querySelector(".form-note");

  if (whenLabel) whenLabel.textContent = "Delivery day";
  if (addrField) addrField.hidden = false;
  if (streetInput) streetInput.required = true;
  if (suburbInput) suburbInput.required = true;
  if (postcodeInput) postcodeInput.required = true;

  if (daySeg) {
    const satDate = nextPickupDate("Saturday");
    // Display-only; hidden input name="pickupDay" stays the form value.
    daySeg.innerHTML = `<label class="seg-opt">
      <input type="radio" name="pickupDayDisplay" value="Saturday" checked disabled>
      <span class="seg-day">Saturday ${satDate}</span>
      <span class="seg-hours">Morning</span>
    </label>`;
  }

  if (formNote) {
    formNote.textContent = "Secure card payment by Stripe.";
  }
  refreshSubmitPrice();
}

document.querySelectorAll('input[name="bundle"]').forEach((radio) => {
  radio.addEventListener("change", refreshSubmitPrice);
});

// Day radios are re-rendered from settings, so listen on the container
const daySegEl = document.getElementById("day-seg");
if (daySegEl) daySegEl.addEventListener("change", refreshSubmitPrice);
const fulfillmentSeg = document.getElementById("fulfillment-seg");
if (fulfillmentSeg) fulfillmentSeg.addEventListener("change", syncFulfillmentUI);

async function refreshDeliveryZoneHint() {
  const hint = document.getElementById("delivery-zone-hint");
  if (!hint || currentFulfillment() !== "delivery") return;
  const suburb = String(document.getElementById("delivery-suburb")?.value || "").trim();
  const city = String(document.getElementById("delivery-city")?.value || "Sydney").trim();
  const postcode = String(document.getElementById("delivery-postcode")?.value || "").replace(/\D/g, "").slice(0, 4);
  if (!suburb && !postcode) {
    hint.hidden = true;
    hint.className = "field-hint";
    hint.textContent = "";
    hint.style.color = "";
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/delivery-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        street: document.getElementById("delivery-street")?.value || "Address check",
        suburb,
        city,
        postcode,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (d.deliver) {
      hint.hidden = false;
      hint.className = "field-hint field-hint-ok";
      hint.textContent = `✓ ${d.matchedSuburb || suburb} · ~${d.roadKmEstimate} km`;
      hint.style.color = "";
    } else if (d.code === "out_of_range") {
      hint.hidden = false;
      hint.className = "field-hint field-hint-out";
      hint.textContent = `✗ Outside 45 km (~${d.roadKmEstimate} km). We can't deliver there yet`;
      hint.style.color = "";
    } else if (d.code === "unknown_suburb") {
      hint.hidden = false;
      hint.className = "field-hint field-hint-unknown";
      const wa = String(config.whatsappNumber || "61433975055").replace(/\D/g, "") || "61433975055";
      hint.innerHTML =
        `We could not match that suburb or postcode. <a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">WhatsApp us</a> or email <a href="mailto:orders@getyolko.com">orders@getyolko.com</a> and we will check if we can deliver.`;
      hint.style.color = "";
    } else {
      hint.hidden = false;
      hint.className = "field-hint field-hint-out";
      hint.textContent = d.error || "Enter suburb and postcode to check delivery.";
      hint.style.color = "";
    }
  } catch {
    hint.hidden = true;
    hint.className = "field-hint";
    hint.textContent = "";
    hint.style.color = "";
  }
}

["delivery-suburb", "delivery-postcode", "delivery-city"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("blur", refreshDeliveryZoneHint);
    el.addEventListener("change", refreshDeliveryZoneHint);
  }
});

/* ---------- Australian mobile handling ---------- */
const phoneInput = document.getElementById("phone");
const phoneError = document.getElementById("phone-error");

// Normalise any way people type their number (+61 433..., 61433..., 0433..., 433...)
// down to local digits: 04XXXXXXXX
function normaliseAuMobile(raw) {
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0061")) digits = digits.slice(4);
  if (digits.startsWith("61") && digits.length >= 10) digits = digits.slice(2);
  if (digits.startsWith("4")) digits = "0" + digits;
  return digits.slice(0, 10);
}

function isValidAuMobile(digits) {
  return /^04\d{8}$/.test(digits);
}

function formatAuMobile(digits) {
  const parts = [digits.slice(0, 4), digits.slice(4, 7), digits.slice(7, 10)].filter(Boolean);
  return parts.join(" ");
}

phoneInput.addEventListener("input", () => {
  phoneInput.value = formatAuMobile(normaliseAuMobile(phoneInput.value));
  phoneError.hidden = true;
});

/* ---------- Field validation feedback ---------- */
function flagInvalid(input) {
  const field = input.closest(".field");
  field.classList.add("error", "shake");
  input.setAttribute("aria-invalid", "true");
  input.focus();
  field.addEventListener("animationend", () => field.classList.remove("shake"), { once: true });
  input.addEventListener("input", () => {
    field.classList.remove("error");
    input.removeAttribute("aria-invalid");
  }, { once: true });
}

/* ---------- Live prices and stock from the shop API ---------- */
const API_BASE = location.hostname.endsWith("getyolko.com") ? "" : "https://getyolko.com";
applyPublishedAssets(API_BASE);

/* ---------- Flyer / QR / campaign visit tracking ---------- */
(function trackYolkoVisit() {
  try {
    const params = new URLSearchParams(location.search);
    const KEY_VID = "yolko_vid";
    const KEY_SID = "yolko_sid";
    const KEY_ATTR = "yolko_attr";

    function rid() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
      return "v" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    let visitorId = localStorage.getItem(KEY_VID);
    if (!visitorId || visitorId.length < 8) {
      visitorId = rid();
      localStorage.setItem(KEY_VID, visitorId);
    }
    window.YOLKO_VISITOR_ID = visitorId;

    let sessionId = sessionStorage.getItem(KEY_SID);
    if (!sessionId) {
      sessionId = rid().slice(0, 24);
      sessionStorage.setItem(KEY_SID, sessionId);
    }

    const incoming = {
      src: params.get("src") || params.get("utm_source") || "",
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
      utm_term: params.get("utm_term") || "",
      landing: location.href.slice(0, 300),
    };
    let attr = null;
    try { attr = JSON.parse(sessionStorage.getItem(KEY_ATTR) || "null"); } catch (_) {}
    if (incoming.src || incoming.utm_source) {
      attr = incoming;
      sessionStorage.setItem(KEY_ATTR, JSON.stringify(attr));
    }
    attr = attr || incoming;

    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const payload = {
      visitorId,
      sessionId,
      src: attr.src || "direct",
      utm_source: attr.utm_source || "",
      utm_medium: attr.utm_medium || "",
      utm_campaign: attr.utm_campaign || "",
      utm_content: attr.utm_content || "",
      utm_term: attr.utm_term || "",
      path: location.pathname + location.search,
      landing: attr.landing || location.href.slice(0, 300),
      referrer: document.referrer || "",
      language: navigator.language || "",
      languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 8) : [],
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
      screenW: screen.width || null,
      screenH: screen.height || null,
      dpr: window.devicePixelRatio || null,
      viewportW: window.innerWidth || null,
      viewportH: window.innerHeight || null,
      platform: navigator.platform || "",
      touch: navigator.maxTouchPoints > 0 || "ontouchstart" in window,
      connection: conn ? (conn.effectiveType || conn.type || "") : "",
      colorScheme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      deviceMemory: navigator.deviceMemory || null,
      cores: navigator.hardwareConcurrency || null,
      ua: navigator.userAgent || "",
    };

    const body = JSON.stringify(payload);
    const url = `${API_BASE}/api/visit`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch (_) {}
})();



const DOZEN_PUBLIC_KEYS = ["cage600", "cage700", "cage800", "fr600", "fr700", "fr800"];

/** Dozen packs stay off the public site until admin sets stock > 0. */
function applyDozenVisibility(settings) {
  const live = Number(settings.dozensAvailable) > 0;
  const block = document.getElementById("dozen-block");
  if (block) block.hidden = !live;
  document.querySelectorAll("[data-dozen-picker]").forEach((el) => {
    el.hidden = !live;
  });
  // If dozens were selected but are now hidden, fall back to tray1
  if (!live) {
    const selected = form?.querySelector('input[name="bundle"]:checked');
    if (selected && DOZEN_PUBLIC_KEYS.includes(selected.value)) {
      const tray1 = form.querySelector('input[name="bundle"][value="tray1"]');
      if (tray1) {
        tray1.checked = true;
        tray1.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
}

function applySettings(settings) {
  const p = settings.prices || {};
  BUNDLE_KEYS.forEach((key) => {
    if (Number.isFinite(Number(p[key])) && Number(p[key]) > 0) {
      BUNDLES[key].price = Number(p[key]);
    }
  });

  const p1 = BUNDLES.tray1.price;
  const perEgg = Math.round((p1 / 30) * 100);

  cacheTray1Price(p1);
  applyChalkPriceImage(p1);
  // Warm nearby chalk frames so the next price tweak crossfades instantly.
  [p1 - 1, p1 + 1, p1 - 2, p1 + 2]
    .filter((n) => CHALK_PRICES.includes(n))
    .forEach((n) => {
      preloadImage(chalkHeroUrls(n).primary);
      preloadImage(chalkOrderUrls(n).primary);
    });

  // Hero
  const badge = document.querySelector(".badge-price");
  if (badge) badge.textContent = `$${p1}`;
  const stats = document.querySelectorAll(".hero-stats dt");
  if (stats[0]) stats[0].textContent = `$${p1}`;
  if (stats[1]) stats[1].innerHTML = `${perEgg}&cent;`;
  const leadStrong = document.querySelector(".hero-sub strong");
  if (leadStrong) leadStrong.textContent = `$${p1}`;

  // Ticker and mobile bar
  TICKER_ITEMS[1] = `30 eggs for $${p1}`;
  renderTicker();
  const ctaStrong = document.querySelector(".mobile-cta-text strong");
  if (ctaStrong) ctaStrong.textContent = `30 eggs · $${p1}`;

  // Price cards: trays only (dozen cards use #price-* ids)
  const trayCards = document.querySelectorAll(".price-grid:not(.dozen-grid) .price-big");
  const trayPers = document.querySelectorAll(".price-grid:not(.dozen-grid) .price-per");
  if (trayCards[0]) trayCards[0].textContent = `$${BUNDLES.tray1.price}`;
  if (trayCards[1]) trayCards[1].textContent = `$${BUNDLES.tray2.price}`;
  if (trayCards[2]) trayCards[2].textContent = `$${BUNDLES.box.price}`;
  const perEgg2 = Math.round((BUNDLES.tray2.price / 60) * 100);
  const perEggBox = Math.round((BUNDLES.box.price / 180) * 100);
  if (trayPers[0]) trayPers[0].innerHTML = `30 eggs · ${perEgg}&cent; each`;
  if (trayPers[1]) trayPers[1].innerHTML = `60 eggs · ${perEgg2}&cent; each`;
  if (trayPers[2]) trayPers[2].innerHTML = `180 eggs · ${perEggBox}&cent; each`;

  // Form options and submit chip
  const bpTray1 = document.getElementById("bp-tray1");
  const bpTray2 = document.getElementById("bp-tray2");
  const bpBox = document.getElementById("bp-box");
  if (bpTray1) bpTray1.textContent = `$${BUNDLES.tray1.price}`;
  if (bpTray2) bpTray2.textContent = `$${BUNDLES.tray2.price}`;
  if (bpBox) bpBox.textContent = `$${BUNDLES.box.price}`;
  BUNDLE_KEYS.forEach((key) => {
    const el = document.getElementById("bp-" + key);
    if (el) el.textContent = "$" + BUNDLES[key].price;
    const card = document.getElementById("price-" + key);
    if (card) card.textContent = "$" + BUNDLES[key].price;
  });
  refreshSubmitPrice();

  // Stock note
  const stock = Number(settings.traysAvailable);
  if (Number.isFinite(stock)) {
    if (stock > 0) {
      stockNote.textContent = `${stock} ${stock === 1 ? "tray" : "trays"} left this week.`;
      stockNote.hidden = false;
      stockNote.classList.add("in");
    } else {
      stockNote.textContent = "Sold out this week. Check back Wednesday.";
      stockNote.hidden = false;
      stockNote.classList.add("in");
    }
  }

  // Dozen packs: only on the public site when admin has stocked them
  applyDozenVisibility(settings);

  // Product type from admin (cage trays or free-range packs)
  applyProductType(settings.trayWeight);

  // Pickup days and hours
  if (settings.pickup) applyPickup(settings.pickup);

  // Keep SERP/social/JSON-LD in sync with live admin settings
  applySeoMeta(settings);
}

function setMetaContent(attr, key, value) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", value);
}

function applySeoMeta(settings) {
  const p1 = BUNDLES.tray1.price;
  const priceKey = chalkPriceKey(p1);
  const title = `YOLKO | 30 Eggs for $${p1} · Sydney`;
  const description = `30 Pace Farm eggs for $${p1}. Fresh trays, delivered in Sydney.`;
  const ogDescription = description;
  const image = `https://getyolko.com/assets/chalk-tray/${priceKey}-1536.jpg?v=${CHALK_ASSET_VER}`;
  const imageAlt = `Fresh Pace Farm egg trays · $${p1}/tray`;

  document.title = title;
  setMetaContent("name", "description", description);
  setMetaContent("property", "og:title", title);
  setMetaContent("property", "og:description", ogDescription);
  setMetaContent("property", "og:image", image);
  setMetaContent("property", "og:image:alt", imageAlt);
  setMetaContent("name", "twitter:title", title);
  setMetaContent("name", "twitter:description", ogDescription);
  setMetaContent("name", "twitter:image", image);
  setMetaContent("name", "twitter:image:alt", imageAlt);

  const script = document.getElementById("yolko-jsonld");
  if (!script) return;
  let data;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return;
  }
  const graph = Array.isArray(data["@graph"]) ? data["@graph"] : [];
  const business = graph.find((n) => n && n["@id"] === "https://getyolko.com/#business");
  const product = graph.find((n) => n && n["@id"] === "https://getyolko.com/#product-tray");

  if (business) {
    business.image = [image];
    business.description = `30 Pace Farm eggs for $${p1}. Fresh trays, delivered in Sydney.`;
    business.priceRange = `$${p1}-$${BUNDLES.box.price}`;
    business.openingHoursSpecification = [{
      "@type": "OpeningHoursSpecification",
      dayOfWeek: "Saturday",
      opens: "07:00",
      closes: "12:00",
    }];
  }

  if (product) {
    product.image = image;
    product.description = `30 fresh Pace Farm eggs for $${p1}. Delivered in Sydney.`;
    if (!product.offers || typeof product.offers !== "object") product.offers = { "@type": "Offer" };
    product.offers.price = Number(p1).toFixed(2);
    product.offers.priceCurrency = "AUD";
    product.offers.availability = "https://schema.org/InStock";
    product.offers.url = "https://getyolko.com/#order";
    product.offers.seller = { "@id": "https://getyolko.com/#business" };
  }

  script.textContent = JSON.stringify(data);
}

const PRODUCT_TYPES = {
  "1.75": {
    shortSpec: "Cage · Extra large · 1.75kg",
    faq: "Pace Farm cage eggs, 30 to a tray (1.75kg). The same supermarket brand, for less.",
    alt: "Cage eggs · 1.75kg tray",
  },
  "1.5": {
    shortSpec: "Cage · Large · 1.5kg",
    faq: "Pace Farm cage eggs, 30 to a tray (1.5kg). The same supermarket brand, for less.",
    alt: "Cage eggs · 1.5kg tray",
  },
  "fr-700": {
    shortSpec: "Free range · 700g",
    faq: "Pace Farm free range eggs, 700g pack. The same brand you'll find in the big supermarkets, for less.",
    alt: "Free range · 700g Pace Farm eggs",
  },
  "fr-600": {
    shortSpec: "Free range · 600g",
    faq: "Pace Farm free range eggs, 600g pack. The same brand you'll find in the big supermarkets, for less.",
    alt: "Free range · 600g Pace Farm eggs",
  },
};

function applyProductType(key) {
  const product = PRODUCT_TYPES[key] || PRODUCT_TYPES["1.75"];
  const traySpec = document.getElementById("tray-spec");
  if (traySpec) traySpec.textContent = product.shortSpec;
  // Price cards use quantity/audience copy (not product-weight lines).
  const faqEggs = document.getElementById("faq-eggs");
  if (faqEggs) faqEggs.textContent = product.faq;
  const heroImg = document.getElementById("hero-tray-img");
  if (heroImg) heroImg.alt = `${product.alt}, fresh Pace Farm tray`;
  const orderImg = document.getElementById("order-tray-img");
  if (orderImg) orderImg.alt = product.alt;
}

function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Next pickup date for a weekday, Sydney time, always at least tomorrow.
// Booking today for today isn't possible; orders roll to the next market day.
// Uses the Australia/Sydney zone directly so it stays correct across daylight
// saving (UTC+10 in winter, UTC+11 in summer) regardless of the viewer's zone.
function nextPickupDate(dayName) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "numeric", day: "numeric", weekday: "short",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const todayIdx = DAY_INDEX[{ Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" }[get("weekday")]];

  // Anchor on Sydney's calendar date as a UTC instant, then add whole days.
  // No fixed offset, so DST transitions never shift the result by a day.
  const base = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  let ahead = (DAY_INDEX[dayName] - todayIdx + 7) % 7;
  if (ahead === 0) ahead = 7;
  const d = new Date(base + ahead * 86400 * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
const DAY_BEFORE = {
  Monday: "Sunday", Tuesday: "Monday", Wednesday: "Tuesday", Thursday: "Wednesday",
  Friday: "Thursday", Saturday: "Friday", Sunday: "Saturday",
};
const SHORT_DAY = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

function applyPickupDaysOnly(pickup) {
  const enabledDays = WEEK_DAYS.filter((d) => pickup[d]?.enabled);
  const previousChoice = (() => {
    const checked = document.querySelector('input[name="pickupDay"]:checked');
    return checked ? checked.value : "Saturday";
  })();
  const seg = document.getElementById("day-seg");
  if (!seg) return;
  const pick = enabledDays.includes(previousChoice) ? previousChoice : enabledDays[enabledDays.length - 1];
  seg.innerHTML = enabledDays.map((day) => {
    const hours = `${formatTime(pickup[day].open)} to ${formatTime(pickup[day].close)}`;
    return `<label class="seg-opt">
      <input type="radio" name="pickupDay" value="${day}"${day === pick ? " checked" : ""}>
      <span class="seg-day">${day} ${nextPickupDate(day)}</span>
      <span class="seg-hours">${hours}</span>
    </label>`;
  }).join("");
}

function applyPickup(pickup) {
  window.__YOLKO_PICKUP = pickup;

  // Delivery section cards: keep policy details here only.
  const cardsBox = document.querySelector(".day-cards");
  if (cardsBox) {
    const satDate = nextPickupDate("Saturday");
    cardsBox.innerHTML = `
      <article class="day-card">
        <p class="day-name">Saturday ${satDate}</p>
        <p class="day-time">Morning delivery</p>
        <p class="day-note">Book by Friday night</p>
      </article>
      <article class="day-card">
        <p class="day-name">+$${DELIVERY_FEE}</p>
        <p class="day-time">Flat fee</p>
        <p class="day-note">Within 45&nbsp;km</p>
      </article>`;
  }

  const pickupTitle = document.getElementById("pickup-title");
  if (pickupTitle) {
    pickupTitle.innerHTML = "Saturday.<br>To your door.";
  }

  const stats = document.querySelectorAll(".hero-stats div");
  if (stats[2]) {
    stats[2].querySelector("dt").textContent = `+$${DELIVERY_FEE}`;
    stats[2].querySelector("dd").textContent = "Sat delivery";
  }

  TICKER_ITEMS[2] = "Pace Farm trays";
  renderTicker();

  const ctaSpan = document.querySelector(".mobile-cta-text span");
  if (ctaSpan) ctaSpan.textContent = "Saturday delivery";

  const buyBtn = document.getElementById("buynow-btn");
  if (buyBtn) buyBtn.disabled = false;
  syncFulfillmentUI();
}

syncFulfillmentUI();
fetch(`${API_BASE}/api/settings`)
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => { if (s) applySettings(s); })
  .catch(() => { syncFulfillmentUI(); });

/* ---------- Payment confirmation on return from Stripe ---------- */
function cookieValue(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function trackMetaPurchase(purchase) {
  if (!purchase || typeof fbq !== "function") return;
  try {
    fbq(
      "track",
      "Purchase",
      {
        value: Number(purchase.value) || 0,
        currency: purchase.currency || "AUD",
        content_name: purchase.contentName || "eggs",
        content_type: "product",
        num_items: Math.max(1, Number(purchase.numItems) || 1),
      },
      { eventID: String(purchase.eventId || "") }
    );
  } catch (_) { /* ignore pixel errors */ }
}

const paidSession = new URLSearchParams(location.search).get("paid");
if (paidSession && paidSession.startsWith("cs_")) {
  history.replaceState(null, "", location.pathname);
  const fbp = cookieValue("_fbp");
  const fbc = cookieValue("_fbc");
  const qs = new URLSearchParams({ session: paidSession });
  if (fbp) qs.set("fbp", fbp);
  if (fbc) qs.set("fbc", fbc);
  fetch(`${API_BASE}/api/confirm-payment?${qs}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.paid) {
        showToast("Payment received! Your eggs are locked in. See you at the market. 🥚");
        trackMetaPurchase(d.purchase);
      }
    })
    .catch(() => {});
}

function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

// Price-card buttons preselect the bundle in the form
document.querySelectorAll("[data-bundle]").forEach((link) => {
  link.addEventListener("click", () => {
    setBundle(link.dataset.bundle);
  });
});

// Validate the form and collect the booking; returns null after flagging errors
function collectBooking() {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const phoneDigits = normaliseAuMobile(data.get("phone") || "");
  const bundleKey = String(data.get("bundle") || "tray1");
  const fulfillment = currentFulfillment();
  const pickupDay = fulfillment === "delivery" ? "Saturday" : String(data.get("pickupDay") || "Saturday");
  const deliveryStreet = String(data.get("deliveryStreet") || "").trim();
  const deliverySuburb = String(data.get("deliverySuburb") || "").trim();
  const deliveryCity = String(data.get("deliveryCity") || "Sydney").trim() || "Sydney";
  const deliveryPostcode = String(data.get("deliveryPostcode") || "").replace(/\D/g, "").slice(0, 4);
  const bundle = BUNDLES[bundleKey] || BUNDLES.tray1;
  const quantity = currentQuantity();
  const deliveryFee = fulfillment === "delivery" ? DELIVERY_FEE : 0;

  if (!name) {
    flagInvalid(document.getElementById("name"));
    return null;
  }
  if (!isValidAuMobile(phoneDigits)) {
    phoneError.hidden = false;
    flagInvalid(phoneInput);
    return null;
  }
  if (fulfillment === "delivery") {
    if (deliveryStreet.length < 3) {
      flagInvalid(document.getElementById("delivery-street"));
      showToast("Add a street address for delivery.");
      return null;
    }
    if (!deliverySuburb) {
      flagInvalid(document.getElementById("delivery-suburb"));
      showToast("Add your suburb for delivery.");
      return null;
    }
    if (!/^2\d{3}$/.test(deliveryPostcode)) {
      flagInvalid(document.getElementById("delivery-postcode"));
      showToast("Enter a valid NSW postcode.");
      return null;
    }
  }

  const deliveryAddress =
    fulfillment === "delivery"
      ? [deliveryStreet, deliverySuburb, deliveryCity, deliveryPostcode].filter(Boolean).join(", ")
      : "";

  return {
    name,
    phoneDigits,
    phone: formatAuMobile(phoneDigits),
    bundleKey,
    fulfillment,
    deliveryStreet: fulfillment === "delivery" ? deliveryStreet : "",
    deliverySuburb: fulfillment === "delivery" ? deliverySuburb : "",
    deliveryCity: fulfillment === "delivery" ? deliveryCity : "",
    deliveryPostcode: fulfillment === "delivery" ? deliveryPostcode : "",
    deliveryAddress,
    deliveryFee,
    pickupDay,
    pickupDate: nextPickupDate(pickupDay),
    quantity,
    total: bundle.price * quantity + deliveryFee,
    orderLabel: describeOrder(bundleKey, quantity),
    company: String(data.get("yolko_hp") || data.get("company") || "").trim(),
  };
}

function createOrder(b) {
  return ensureOrderToken()
    .then((token) =>
      fetch(`${API_BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: b.name,
          phone: b.phoneDigits,
          bundle: b.bundleKey,
          pickupDay: b.pickupDay,
          pickupDate: b.pickupDate,
          quantity: b.quantity,
          fulfillment: b.fulfillment,
          deliveryStreet: b.deliveryStreet || "",
          deliverySuburb: b.deliverySuburb || "",
          deliveryCity: b.deliveryCity || "",
          deliveryPostcode: b.deliveryPostcode || "",
          deliveryAddress: b.deliveryAddress || "",
          yolko_hp: b.company || "",
          company: b.company || "",
          token: token || "",
          visitorId: window.YOLKO_VISITOR_ID || "",
        }),
      })
    )
    .then(async (r) => {
      orderToken = null;
      orderTokenAt = 0;
      if (r.status === 429) return { error: "rate" };
      if (r.status === 403) {
        const d = await r.json().catch(() => ({}));
        if (d.code === "geo") return { error: "geo" };
        return { error: "blocked" };
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        if (d.code === "delivery_day") return { error: "delivery_day" };
        if (d.code === "delivery_range") {
          return {
            error: "delivery_range",
            message: d.error || "Outside our 45 km delivery area.",
            roadKmEstimate: d.roadKmEstimate,
          };
        }
        if (d.code === "delivery_address") {
          return { error: "delivery_address", message: d.error || "Check your delivery address." };
        }
        return null;
      }
      return r.json();
    })
    .then((d) => {
      if (!d) return null;
      if (d.error) return d;
      if (d.deliveryAddress) b.deliveryAddress = d.deliveryAddress;
      if (d.deliveryKm != null) b.deliveryKm = d.deliveryKm;
      if (d.id) saveOpenCheckout(d.id, b);
      prefetchOrderToken();
      return d.id ? { id: d.id, price: d.price, deliveryFee: d.deliveryFee, deliveryKm: d.deliveryKm, deliveryAddress: d.deliveryAddress, reused: !!d.reused } : null;
    })
    .catch(() => {
      orderToken = null;
      orderTokenAt = 0;
      prefetchOrderToken();
      return null;
    });
}

let orderToken = null;
let orderTokenAt = 0;

function prefetchOrderToken() {
  fetch(`${API_BASE}/api/order-token`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.token) {
        orderToken = d.token;
        orderTokenAt = Date.now();
      }
    })
    .catch(() => {});
}

async function ensureOrderToken() {
  if (!orderToken || Date.now() - orderTokenAt > 8 * 60 * 1000) {
    try {
      const r = await fetch(`${API_BASE}/api/order-token`);
      const d = r.ok ? await r.json() : null;
      orderToken = d && d.token ? d.token : null;
      orderTokenAt = Date.now();
    } catch {
      orderToken = null;
      orderTokenAt = 0;
    }
  }
  return orderToken;
}

prefetchOrderToken();
document.getElementById("order")?.addEventListener("pointerdown", prefetchOrderToken, { once: true, passive: true });
document.getElementById("order")?.addEventListener("focusin", prefetchOrderToken, { once: true });

function goToCheckout(url) {
  if (!url) return false;
  try {
    window.location.replace(url);
  } catch {
    window.location.href = url;
  }
  // iOS sometimes ignores async redirects; force via tap-equivalent <a>.
  setTimeout(() => {
    if (document.visibilityState === "visible") {
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, 400);
  return true;
}

async function openCheckout(orderId) {
  try {
    if (!orderId) return { ok: false, error: "no order" };
    const res = await fetch(`${API_BASE}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.url) {
      return { ok: false, error: d.detail || d.error || "checkout failed" };
    }
    goToCheckout(d.url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "checkout failed" };
  }
}

/** Fast path: one request creates/reuses the order and returns a Stripe URL. */
async function buyNowCheckout(b) {
  // Prefer existing unpaid order → /api/checkout (no geo, one Stripe call).
  const reusedId = loadMatchingCheckout(b) || lastOrderId;
  if (reusedId) {
    const reuse = await openCheckout(reusedId);
    if (reuse.ok) return { ok: true };
    clearOpenCheckout();
    lastOrderId = null;
  }

  const token = (await ensureOrderToken()) || "";
  const res = await fetch(`${API_BASE}/api/buy-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
          visitorId: window.YOLKO_VISITOR_ID || "",
      name: b.name,
      phone: b.phoneDigits,
      bundle: b.bundleKey,
      pickupDay: b.pickupDay,
      pickupDate: b.pickupDate,
      quantity: b.quantity,
      fulfillment: b.fulfillment,
      deliveryStreet: b.deliveryStreet || "",
      deliverySuburb: b.deliverySuburb || "",
      deliveryCity: b.deliveryCity || "",
      deliveryPostcode: b.deliveryPostcode || "",
      deliveryAddress: b.deliveryAddress || "",
      yolko_hp: b.company || "",
      token,
    }),
  });
  orderToken = null;
  orderTokenAt = 0;
  prefetchOrderToken();
  const d = await res.json().catch(() => ({}));
  if (res.status === 403 && d.code === "geo") return { error: "geo" };
  if (res.status === 429) return { error: "rate" };
  if (!res.ok) {
    if (d.code === "delivery_day") return { error: "delivery_day" };
    if (d.code === "delivery_range") return { error: "delivery_range", message: d.error };
    if (d.code === "delivery_address") return { error: "delivery_address", message: d.error };
    return { error: "blocked", message: d.detail || d.error || "checkout failed" };
  }
  if (!d.url) return { error: "blocked", message: d.error || "checkout failed" };
  if (d.orderId || d.id) {
    lastOrderId = d.orderId || d.id;
    saveOpenCheckout(lastOrderId, b);
  }
  if (d.deliveryAddress) b.deliveryAddress = d.deliveryAddress;
  if (d.price != null) b.total = d.price;
  goToCheckout(d.url);
  return { ok: true, url: d.url };
}

function showConfirmation(b) {
  const isDelivery = b.fulfillment === "delivery";
  const message = [
    isDelivery
      ? "Hi! I'd like to book eggs for delivery."
      : "Hi! I'd like to book eggs.",
    `Name: ${b.name}`,
    `Phone: ${b.phone}`,
    `Order: ${b.orderLabel}`,
    isDelivery
      ? `Delivery: Saturday ${b.pickupDate}`
      : `Pickup: ${b.pickupDay} ${b.pickupDate}`,
    isDelivery ? `Address: ${b.deliveryAddress}` : null,
    isDelivery ? `Delivery fee: $${b.deliveryFee}` : null,
    `Total: $${b.total}`,
  ].filter(Boolean).join("\n");
  lastOrderMessage = message;

  doneSummary.textContent = isDelivery
    ? `Thanks ${b.name.split(" ")[0]}! Here are your order details.`
    : `Thanks ${b.name.split(" ")[0]}! Here are your pickup details.`;
  receipt.name.textContent = b.name;
  receipt.phone.textContent = b.phone;
  receipt.order.textContent = b.orderLabel;
  receipt.pickup.textContent = isDelivery
    ? `Saturday ${b.pickupDate} delivery · ${b.deliveryAddress}`
    : `${b.pickupDay} ${b.pickupDate} at Paddy's Markets Flemington`;
  receipt.total.textContent = `$${b.total}`;

  const hint = document.querySelector(".done-hint");
  if (hint) hint.textContent = "Keep this screen for your records.";

  const number = String(config.whatsappNumber || "").replace(/\D/g, "");
  if (number) {
    whatsappLink.href = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
    whatsappLink.hidden = false;
  } else {
    whatsappLink.hidden = true;
  }

  stripeLink.textContent = `Pay $${b.total} online for priority`;
  stripeLink.href = "#";
  stripeLink.hidden = false;
  document.getElementById("pay-perk").hidden = false;
  stripeLink.onclick = async (e) => {
    e.preventDefault();
    stripeLink.textContent = "Opening secure checkout…";
    const result = await openCheckout(lastOrderId);
    if (!result.ok) {
      stripeLink.textContent = isDelivery ? "Payment unavailable, pay on delivery" : "Payment unavailable, pay on pickup";
      showToast(result.error || "Couldn’t open payment. Try Buy now again.");
    }
  };

  orderSection.hidden = true;
  doneSection.hidden = false;
  mobileCta.classList.remove("show");
  mobileCta.inert = true;
  doneSection.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
}

// Buy now: only CTA. Create/reuse order + Stripe session.
const buynowBtn = document.getElementById("buynow-btn");
const buynowLabel = document.getElementById("buynow-label");

async function startBuyNow() {
  const booking = collectBooking();
  if (!booking) return;

  buynowBtn.disabled = true;
  buynowBtn.setAttribute("aria-busy", "true");
  buynowLabel.textContent = "Opening…";

  const failBuy = (msg) => {
    buynowBtn.disabled = false;
    buynowBtn.removeAttribute("aria-busy");
    buynowLabel.textContent = "Buy now";
    showToast(msg || "Couldn’t open payment. Try again.");
  };

  try {
    const result = await buyNowCheckout(booking);
    if (result?.ok) return;
    if (result?.error === "rate") {
      failBuy("Too many bookings from this phone or connection. Try again in a minute.");
      return;
    }
    if (result?.error === "geo") {
      failBuy("Bookings are for the Sydney area only.");
      return;
    }
    if (result?.error === "delivery_day") {
      failBuy("Delivery is Saturday only.");
      return;
    }
    if (result?.error === "delivery_range") {
      failBuy(result.message || "We only deliver within 45 km of our hub.");
      return;
    }
    if (result?.error === "delivery_address") {
      failBuy(result.message || "Check your delivery street, suburb, and postcode.");
      return;
    }
    failBuy(result?.message || "Couldn’t open Stripe checkout. Tap Buy now again.");
  } catch {
    failBuy("Couldn’t open payment. Check your connection and try again.");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await startBuyNow();
});

copyButton.addEventListener("click", async () => {
  if (!lastOrderMessage) return;

  try {
    await navigator.clipboard.writeText(lastOrderMessage);
    copyButton.textContent = "Copied!";
  } catch {
    copyButton.textContent = "Copy failed";
  }

  setTimeout(() => {
    copyButton.textContent = "Copy order";
  }, 1800);
});

againButton.addEventListener("click", () => {
  form.reset();
  syncFulfillmentUI();
  refreshSubmitPrice();
  doneSection.hidden = true;
  orderSection.hidden = false;
  orderSection.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
});

/* Re-measure after fonts/layout settle (iOS Safari chrome can shift post-load). */
if (typeof window.__yolkoFitViewport === "function") {
  requestAnimationFrame(() => window.__yolkoFitViewport());
  window.addEventListener("load", () => window.__yolkoFitViewport(), { once: true, passive: true });
}
