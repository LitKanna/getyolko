/* YOLKO visit log, loaded on every page.
   One row per page view (POST /api/visit), then what happened on that page (POST
   /api/visit/ping): seconds it was actually on screen, how far it was scrolled, whether the
   order section came into view, and taps on the order controls and the phone and WhatsApp
   links. The page sends running totals and the shop keeps the highest of each, so a repeat send
   never counts twice. Nothing typed is read, and no name or contact detail is sent.

   Phones and the Facebook and Instagram browsers often close a page without telling it, so the
   totals also go out every 3 seconds while the page is on screen, not only when it is left. */
(function () {
  "use strict";
  if (window.YOLKO_TRACK) return;
  var track = (window.YOLKO_TRACK = { mark: function () {} });
  try {
    var doc = document;
    var nav = navigator;
    var API = /(^|\.)getyolko\.com$/.test(location.hostname) ? "" : "https://getyolko.com";
    /* The totals are sent every 3 seconds the page is on screen. A phone often closes a page
       with no warning at all (a closed tab, an app's own browser), and then the last report that
       got out is all the shop ever learns, so the gap is kept to 3 seconds. After 3 minutes it
       eases to every 15 seconds, and it stops at 15 minutes. */
    var STEP = 3;
    var SLOW_AFTER = 180;
    var SLOW_STEP = 15;
    var STOP_AFTER = 900;
    var MAX_SENDS = 150;
    function nextMark(s) {
      if (s >= STOP_AFTER) return null;
      var step = s < SLOW_AFTER ? STEP : SLOW_STEP;
      return (Math.floor((s + 0.05) / step) + 1) * step;
    }

    var memory = {};
    function read(store, key) {
      try { return store.getItem(key); } catch (_) { return memory[key] || null; }
    }
    function write(store, key, value) {
      try { store.setItem(key, value); } catch (_) { memory[key] = value; }
    }
    function rid() {
      try {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
      } catch (_) {}
      return "v" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    var visitorId = read(localStorage, "yolko_vid");
    if (!visitorId || visitorId.length < 8) {
      visitorId = rid();
      write(localStorage, "yolko_vid", visitorId);
    }
    window.YOLKO_VISITOR_ID = visitorId;
    track.visitorId = visitorId;

    var sessionId = read(sessionStorage, "yolko_sid");
    if (!sessionId) {
      sessionId = rid().slice(0, 24);
      write(sessionStorage, "yolko_sid", sessionId);
    }
    var pageN = (parseInt(read(sessionStorage, "yolko_pn"), 10) || 0) + 1;
    write(sessionStorage, "yolko_pn", String(pageN));

    /* Where the visitor came from is kept for the whole session, so a second page still knows
       the ad or flyer that brought them. */
    var params = new URLSearchParams(location.search);
    var incoming = {
      src: params.get("src") || params.get("utm_source") || "",
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
      utm_term: params.get("utm_term") || "",
      landing: location.href.slice(0, 300),
    };
    var attr = null;
    try { attr = JSON.parse(read(sessionStorage, "yolko_attr") || "null"); } catch (_) {}
    if (incoming.src || incoming.utm_source) {
      attr = incoming;
      write(sessionStorage, "yolko_attr", JSON.stringify(attr));
    }
    attr = attr || incoming;

    /* ---- what happens on the page ---- */
    var id = null;
    var visibleMs = 0;
    var since = null;
    var maxScroll = 0;
    var scrolled = false;
    var sawOrder = false;
    var inputAt = null;
    var restY = 0;
    var taps = {};
    var sends = 0;
    var lastSent = "";
    var markTimer = null;
    var tapTimer = null;
    var scrollTimer = null;
    var orderEl = doc.getElementById("order");

    function clock() {
      return window.performance && performance.now ? performance.now() : Date.now();
    }
    function onScreen() {
      return (visibleMs + (since != null ? clock() - since : 0)) / 1000;
    }
    function pageY() {
      return window.pageYOffset || doc.documentElement.scrollTop || 0;
    }
    function measure() {
      var body = doc.body;
      var height = Math.max(doc.documentElement.scrollHeight, body ? body.scrollHeight : 0, 1);
      var y = pageY();
      var seen = Math.min(100, Math.round(((y + (window.innerHeight || 0)) / height) * 100));
      if (seen > maxScroll) maxScroll = seen;
      /* Only a move the visitor made counts as scrolling: the page must have moved within two
         seconds of a finger, wheel or key. A link that opens the page at the order form does not. */
      if (inputAt != null && clock() - inputAt < 2000) {
        if (Math.abs(y - restY) > 40) scrolled = true;
      } else {
        restY = y;
      }
      if (!sawOrder && orderEl) {
        var r = orderEl.getBoundingClientRect();
        if (r.top < (window.innerHeight || 0) * 0.8 && r.bottom > 0) sawOrder = true;
      }
    }

    function send(leaving) {
      if (!id || sends >= MAX_SENDS) return;
      measure();
      var body = JSON.stringify({
        id: id,
        v: visitorId,
        secs: Math.floor(onScreen()),
        scroll: maxScroll,
        scrolled: scrolled,
        order: sawOrder,
        taps: taps,
      });
      if (body === lastSent) return;
      lastSent = body;
      sends += 1;
      var url = API + "/api/visit/ping";
      if (leaving && nav.sendBeacon) {
        try { if (nav.sendBeacon(url, body)) return; } catch (_) {}
      }
      try {
        fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true, credentials: "omit" }).catch(function () {});
      } catch (_) {}
    }

    function arm() {
      clearTimeout(markTimer);
      if (since == null) return;
      var s = onScreen();
      var next = nextMark(s);
      if (next == null) return;
      markTimer = setTimeout(function () { send(false); arm(); }, Math.ceil((next - s) * 1000) + 40);
    }
    function show() {
      if (since != null || doc.visibilityState === "hidden") return;
      since = clock();
      arm();
    }
    function hide() {
      if (since != null) {
        visibleMs += clock() - since;
        since = null;
      }
      clearTimeout(markTimer);
      send(true);
    }

    function bump(kind) {
      taps[kind] = Math.min(99, (taps[kind] || 0) + 1);
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { send(false); }, 1500);
    }
    track.mark = function (kind) {
      bump(String(kind));
      /* Checkout leaves for the payment page at once, so this one cannot wait. */
      if (kind === "checkout") { clearTimeout(tapTimer); send(true); }
    };

    function input() {
      inputAt = clock();
    }
    ["touchstart", "touchmove", "wheel", "keydown", "mousedown"].forEach(function (name) {
      window.addEventListener(name, input, { passive: true, capture: true });
    });
    window.addEventListener("scroll", function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () { scrollTimer = null; measure(); }, 200);
    }, { passive: true });

    doc.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('a[href^="tel:"]')) bump("phone");
      else if (t.closest('a[href*="wa.me"], a[href*="whatsapp"]')) bump("whatsapp");
      else if (t.closest("#buynow-btn")) bump("buy");
      else if (t.closest("#tray-picker, #tray-kinds, #dozen-pickers, #often-picker, #qty-minus, #qty-plus")) bump("tray");
      else if (t.closest('a[href*="#order"]')) bump("cta");
    }, true);
    /* How many boxes of the order form were entered or filled, each counted once: the number
       only, never which box and never what is typed. A phone that fills the form from its saved
       contact card never enters most boxes, so a box that changes counts as well. */
    var boxes = [];
    function box(e) {
      var t = e.target;
      if (!t || !t.closest || !t.closest("#order-form")) return;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || /^(radio|checkbox|hidden|submit|button)$/.test(t.type || "")) return;
      /* The box no person can reach is there to catch robots; filling it is not a visitor's act. */
      if (t.tabIndex < 0) return;
      if (boxes.indexOf(t) >= 0) return;
      boxes.push(t);
      bump("form");
    }
    doc.addEventListener("focusin", box, true);
    doc.addEventListener("input", box, true);

    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "hidden") hide(); else show();
    });
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", function (e) { if (e.persisted) show(); });
    measure();
    show();

    /* ---- the page view itself ---- */
    var conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    var visit = {
      trk: 2,
      pageN: pageN,
      visitorId: visitorId,
      sessionId: sessionId,
      src: attr.src || "direct",
      utm_source: attr.utm_source || "",
      utm_medium: attr.utm_medium || "",
      utm_campaign: attr.utm_campaign || "",
      utm_content: attr.utm_content || "",
      utm_term: attr.utm_term || "",
      path: location.pathname + location.search,
      landing: attr.landing || location.href.slice(0, 300),
      referrer: doc.referrer || "",
      language: nav.language || "",
      languages: Array.isArray(nav.languages) ? nav.languages.slice(0, 8) : [],
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      screenW: screen.width || null,
      screenH: screen.height || null,
      dpr: window.devicePixelRatio || null,
      viewportW: window.innerWidth || null,
      viewportH: window.innerHeight || null,
      platform: nav.platform || "",
      touch: nav.maxTouchPoints > 0 || "ontouchstart" in window,
      connection: conn ? conn.effectiveType || conn.type || "" : "",
      colorScheme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      deviceMemory: nav.deviceMemory || null,
      cores: nav.hardwareConcurrency || null,
      ua: nav.userAgent || "",
    };
    fetch(API + "/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visit),
      keepalive: true,
      credentials: "omit",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.id) return;
        id = d.id;
        /* The row can arrive after the first mark has passed, or after the visitor has gone. */
        if (since == null) send(true);
        else if (onScreen() >= STEP) send(false);
      })
      .catch(function () {});
  } catch (_) {}
})();
