# AGENTS.md

## Cursor Cloud specific instructions

### Copy style (hard rule)
Never use em dashes (`-`) anywhere on the website or in storefront/admin UI copy.
Prefer a period, comma, colon, or hyphen (`-`) instead. Same for docs you add to this repo
when they are user-facing; avoid reintroducing `-` in `index.html`, `app.js`, or the admin
page `infra/admin.html` (served by the Worker at `/admin`).

### What this repo is
YOLKO (`getyolko`) is a single **static, one-page marketing/ordering website** for selling
fresh egg trays. The core files are `index.html`, `styles-modern.css`, `app.js`, and `config.js`.
There is **no framework and no build step**. The files are served as-is.

### Run the site (the main product)
From the repo root:

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080. No install is required just to view/use the site.

### Generated pages (non-obvious)
The suburb pages (`egg-delivery-*.html`), `egg-delivery-sydney.html`, `bulk-eggs-sydney.html`,
`egg-delivery-areas.html`, `404.html`, `sitemap.xml`, `assets/coverage-map.svg`, and the
JSON-LD, FAQ, delivery map and next-delivery-date blocks inside `index.html` (between
`<!-- name:start -->` / `<!-- name:end -->` markers) are generated. Edit `infra/build-pages.mjs`
(copy, prices, `CSS_V`, structured data), `infra/coverage-map.mjs` (the dot map, drawn from the
same zone data checkout uses) or `infra/build-areas-page.mjs` (the A to Z suburb list), then run
`node infra/build-pages.mjs && node infra/build-areas-page.mjs`. Never put the Sydney Markets
address or its 2129 postcode on any page: YOLKO is a home-based, service-area business.

### Look (redesign, 31 Oct 2026; Figma file "YOLKO Website 2026")
Bold modern shop, replacing the earlier "Quiet local shop" look. One font (Plus Jakarta Sans):
big ExtraBold headings (hero up to 80px, tight letter spacing), sentence case, no trailing full
stop. Colours are tokens in `:root` of `styles-modern.css`: cream page `#faf7f0`, white cards,
ink `#14120e`, muted `#6b675e`, yolk `#ffd32a`, green `#1f7a4d` only for the stock dot. Yolk
yellow is for the logo dot, Order / Buy buttons (`.btn-solid`), price highlights, the timeline
dots and the closing band; no orange. Rounded cards and pill buttons, a black announcement bar
with the next Saturday date, and a black footer. Plain, short copy with no jargon. Never change,
swap or re-crop the site images (the chalk-tray hero and order photos stay exactly as they are).

### Viewport fit (non-obvious)
`index.html` measures `visualViewport` (Chrome / Safari / iOS browser chrome) into
`--vvh` / `--app-height` before paint. Hero/showcase CSS uses `--frame-h` from that,
not raw `svh`/`dvh` alone. Chalk-tray heroes are **1:1**. keep `aspect-ratio: 1 / 1`
on `.showcase-card` (do not revert to `3/4`). After Worker deploys, bump
`X-Yolko-Build` and keep `CHALK_ASSETS_SHA` so the hero does not 404 black.

### Order cutoff (Kanna, 3 Nov 2026)
Orders close Thursday night, Sydney time. An order placed Sunday to Thursday is for that week's
Saturday run (6am to 12pm); from Friday it goes to the Saturday after. `deliverySaturday()` in the
Worker sets every order's `pickupDate` (the client's date is ignored), `nextPickupDate("Saturday")`
in `app.js` shows the same date on the form, and the announcement bar script in
`infra/build-pages.mjs` (`NEXT_RUN_SCRIPT`) uses the same rule. An unpaid order reopened at
`/api/checkout` after the cutoff moves to the next Saturday. All copy says "Order by Thursday night".

### Ordering flow works fully client-side (non-obvious)
`app.js` sets `API_BASE` to `https://getyolko.com` whenever the site is **not** served from a
`getyolko.com` host (i.e. always in local dev). The `/api/*` calls (`settings`, `orders`,
`checkout`) therefore hit production and fail silently in local dev. The booking flow
(fill form → **Reserve** → confirmation receipt with WhatsApp link) degrades gracefully and
works end-to-end locally **without** any backend. Use the "Reserve" button (not "Buy now") to
demonstrate the flow without needing Stripe.

### Optional backend (not needed to run/demo the site)
`infra/cloudflare-worker.mjs` is a Cloudflare Worker (config in `wrangler.toml`) providing
`/api/*` and an `/admin` dashboard. Run with `npx wrangler dev` (defaults to port 8787). It
needs a KV namespace bound as `DATA` (wrangler dev provides a local simulation) plus
`ADMIN_KEY` and `STRIPE_KEY` secrets; Stripe endpoints return 503 when `STRIPE_KEY` is unset.
`wrangler` is intentionally not a declared dependency. invoke via `npx`.

Order payments and emails: `POST /api/stripe-webhook` (Stripe events `checkout.session.completed`,
`checkout.session.async_payment_succeeded` and `charge.refunded`) marks orders paid and sends the confirmation
email through Zoho ZeptoMail. Secrets: `STRIPE_WEBHOOK_SECRET`, `ZEPTOMAIL_TOKEN`,
`ORDER_EMAIL_FROM`; optional `ORDER_NOTIFY_EMAIL` (shop copy) and `ZEPTOMAIL_API_URL`
(defaults to Zoho CPaaS `https://cpaas.zoho.com/v1.1/email`; same API as ZeptoMail). Without them the webhook
returns 503 and emails are skipped; `/api/confirm-payment` still marks orders paid and also
sends the email if the webhook has not. Admins can resend with `POST /api/admin/order-email {id}`.
Refunds email the customer once per refund (`email:refund:<refundId>` marker). The admin Refund
button sends for refunds it creates (tagged `metadata.orderId`); the webhook's `charge.refunded`
event (also on the live endpoint) records and emails refunds made in the Stripe dashboard after
`REFUND_EMAIL_LAUNCH`. A failed admin refund email is retried by the cron (it lists the
`email:refund:try:<refundId>` keys); a failed dashboard one
answers 502 so Stripe redelivers. For `WEBHOOK_GRACE_SEC` after a dashboard full refund,
`/api/refund` and `/api/order-status` leave the order to the webhook, so a stale KV copy never
returns stock twice. The confirmation and refund emails share `emailFrame()`.
The admin Emails page uses `GET /api/admin/emails`, `GET /api/admin/email-preview?id=` and
`POST /api/admin/test-email {to, kind?}` (`kind: "refund"` sends the refund sample). All shop email is orders@getyolko.com on Zoho (order emails
reply to it too); getyolkonow@gmail.com is only for Google sign-ins, never for mail.

An order row is written when the customer opens Stripe Checkout, so a row with status `new`, a
`sessionId` and no payment is not an order yet. The admin keeps these out of Upcoming, Waiting, the
widgets, the nav count, alerts, the delivery run and Customers, and lists them under Not paid for a
week ("Checkout open" for the first 24 hours, then "Didn't pay"). `markOrderPaid` writes
`orders:lastpaid`, which `GET /api/admin/orders-head` returns, so a checkout paid later still rings.

Zoho Mail (the admin Inbox, Sent, reply and compose) is an OAuth connection, not a pasted token.
Secrets `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` come from a Server-based app in
api-console.zoho.com (redirect `https://getyolko.com/api/zoho/callback`, scopes
`ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.ALL`). "Connect Zoho Mail" in the
admin calls `POST /api/admin/zoho/connect`, and the callback stores the refresh token in KV
(`zoho:mail:auth`) sealed with AES-GCM under a key derived from the client secret.
`POST /api/admin/zoho/disconnect` removes it. Mailbox endpoints: `GET /api/admin/mail?folder=inbox|sent`,
`GET /api/admin/mail/unread`, `GET /api/admin/mail/message?folderId=&messageId=&markRead=1`,
`GET /api/admin/mail/attachment`, `POST /api/admin/mail/flag {messageId, read}`,
`POST /api/admin/mail/send {to, subject, text, replyTo?, quote?}`. Optional `ZOHO_ACCOUNTS_URL` /
`ZOHO_MAIL_URL` override the Zoho hosts (used for local tests against a fake Zoho).
Pictures and attachments in the mailbox (Nov 2026): Zoho's message HTML points inline pictures at
its own web app (`/mail/ImageDisplay?...&cid=`), which 404s on getyolko.com. `/api/admin/mail/message`
rewrites every picture (`<img src/srcset>`, `background=`, `url()` in styles) to the site:
`/api/admin/mail/inline` (from the Zoho API by Content-ID, then by attachment id) and
`/api/admin/mail/image` (a proxy for web pictures: no cookies or Referer, edge cached a day). Each
attachment comes with signed `url` / `download` links to `/api/admin/mail/file`: pictures, PDFs, text and
media open in the browser, anything else downloads with its real name. `<img>` can't send the Bearer
key, so these links carry an HMAC under a key derived from `ADMIN_KEY` (mailbox files expire after
about a week). Files are served with `nosniff` and, for pictures and text, a sandbox CSP, so nothing
runs as a page on getyolko.com. The admin shows attachments at the end of the message like Mail
(pictures as tiles that open in the lightbox, files as chips), tries a web picture straight from its
host if the proxy can't get it, and hides a picture that still won't load unless it has alt text.
Speed: every Zoho call crosses the Pacific, so a message's Zoho answers, its inline pictures and its
attachments (up to 25 MB) are kept in the Cloudflare Cache API for 30 days under signed keys
(messages don't change), and opening one again takes about 10 ms. Inline pictures up to 400 KB (2 MB
a message) come inside the message as `data:` URLs, so they show with the text; the message waits at
most 2 s for them, then sends links. The admin starts loading a message when the mouse rests on its
row or a finger presses it, reads the newest six ahead when the Inbox opens, and preloads web
pictures and photo tiles; marking read happens separately so the read-ahead doesn't mark anything.
Delivery status (delivered, opened, clicked, bounced, spam) comes from the Zoho CPaaS webhook
`POST /api/zoho/email-events` (set in CPaaS > Agents > agent_1 > Webhooks). Zoho webhooks carry no
credentials, so there is no token: an event only counts when its request id matches an
`email:req:<requestId>` key written when the Worker sent that email.

Thursday reorder reminders: the order form's "Email me a reminder each Thursday" box sends
`remind: true`; the order carries `remindOptIn`, and `markOrderPaid` signs the Stripe email up
(`remind:sub:<sha256(email) prefix>`, list in `remind:index`, link token in `remind:tok:<token>`).
The cron sends on Thursday (the last day to order) from 10am to 8pm Sydney time, 4 per tick, and the
email says orders close tonight. It goes through the Zoho Mail
mailbox (never the CPaaS order sender, which forbids marketing). It skips sold-out weeks, people
who already ordered for that Saturday, and everything while `remind:off` is set (admin Pause).
"Order again" links to `/#reorder=<token>`: `index.html` lifts the token out of the URL before the
visit log or Meta pixel can read it, and `app.js` fills the form from `GET /api/reorder?t=`.
Unsubscribe is `/api/reminders/stop?t=` (GET asks, POST stops, so mail scanners can't unsubscribe).

Tray prices are fixed (Kanna, Nov 2026: $13 one tray, $25 two trays, $72 full box). Admin > Stock &
prices saves exactly what is typed in each field. Nothing derives one tray price from another or from
"A box of 6 costs you" (that field only changes the profit lines), and the Worker has no special cases
that rewrite them. Shop, checkout, Stripe and emails all read `settings.prices` from KV.

Free delivery (referrals and same building, Kanna's choice Oct 2026): each customer's share link
is `/r/<CODE>` (6 characters, `ref:code:<CODE>` -> phone and first name, `ref:mine:<phone>` -> code),
made on the paid screen (`/api/confirm-payment` returns `share`) and in reminder emails. It lands on
`/?ref=CODE`; `app.js` keeps the code 60 days and sends `ref` with the order. At order time
`deliveryPerk()` sets `deliveryFee` 0 for: another paid order to the same building that Saturday
(`bldg:<pickupDate>:<hash of street number + street + postcode, unit stripped>`), a friend's code on
a first order, or an earned credit (`ref:cust:<phone>`). `noteReferralOrder` (on paid) counts the
order, uses a credit, and gives one credit to the friend and to everyone who paid for delivery to a
shared building. A cron backfill (`ref:backfill`) counts orders paid before this existed.
Box cards: Admin > Delivery run > "Print box cards" calls `POST /api/admin/ref-cards {ids}`, which
makes a share code for each customer still to deliver and returns a QR code as SVG (built in the
Worker with the `qrcode-generator` package) for `/r/<CODE>?m=card`. The admin prints four A6 cards
per A4 sheet with print CSS; the `?m=card` tag shows card scans as `utm_medium=card`.

### Competitor egg prices (Admin > Competitors, Nov 2026)
No Australian supermarket has a price API. `infra/price-watch.mjs` reads public pages that the
shops' robots.txt allows, with an honest `YolkoPriceCheck` user agent: Coles
`/browse/dairy-eggs-fridge/eggs` (Next.js `__NEXT_DATA__`, every egg on one page), Aldi
`/products/dairy-eggs-fridge/eggs/k/1111111162` (server-rendered product tiles), one IGA product
page (JSON-LD) and Umall (Shopify `/products/<handle>.js`). Gourmet Grocer was dropped on 6 Nov 2026:
its domain gourmetgroceronline.com.au no longer exists (NXDOMAIN). Never read Coles
`/search/` or Aldi `/results` (robots.txt disallows them). Every egg is filed like YOLKO's own
catalogue (`groupOf`: dozen or tray, then cage / free range / cage free, then weight class; barn
laid is cage free), and from Coles and Aldi it keeps the cheapest egg in each group. The cron asks every 15
minutes but the shops are only read once every 6 hours. A shop that failed is read once more, on
its own, 30 minutes later (Umall's Shopify sometimes answers 429, Coles sometimes a bot check), then
waits for the next 6-hourly read. Never re-read every shop on every retry: that most likely got Coles to
bot-check us on 6 Nov while a dead shop kept the old rule retrying every 30 minutes (`pricewatch:v2:latest`); Check now in the
admin reads them at once (at most once a minute). A shop that fails keeps its last prices, marked
stale, and the page says so under the heading. Changes go to `pricewatch:v2:events`.
Woolworths blocks every automated request (Akamai 403, even robots.txt, from Cloudflare and from
cloud servers) and Costco only sells eggs through DoorDash, which blocks bots and bans scraping, so
their prices are typed in from the admin (`pricewatch:v2:typed`, `POST /api/price-watch/typed`);
Costco starts with what Kanna saw on 3 Nov 2026 ($14.79, members $12.99), weight not shown. The
page has Trays and Dozens tabs; each group ranks the real pack prices with YOLKO's price for the
same variety (1 tray, 1 dozen) slotted in. This is comparison only: nothing here may ever
change YOLKO's own prices. Routes: `GET /api/price-watch`, `POST /api/price-watch/poll`, both
admin only.

### Egg news (Admin > News, Nov 2026)
`infra/news-feed.mjs` gathers Australian egg news from public feeds: two Google News searches
(egg prices, supply and farms; bird flu on poultry farms), the ABC "Poultry and egg production"
(`/news/feed/2276/rss.xml`) and "Bird flu" (`/news/feed/1676/rss.xml`) topic feeds, NSW DPIRD's
bird flu updates (extensionAUS feed), Australian Eggs, Egg Farmers of Australia, Inside FMCG (egg
stories only), Reddit search (r/sydney, r/australia, r/AusFinance, posts with "eggs" in the
title, "nest egg" and Easter eggs left out) and the general feeds of 7NEWS, The Guardian
Australia, the SMH, SBS News and Farm Online (filter `egg-local`: egg headlines, overseas ones only
if they also name Australia). The NSW bird flu page has no feed, so the Worker reads its "Latest
advice" box for the case count and whether NSW farms are clear, and adds a story when it changes.
The owner can paste more feeds (Google Alerts set to "Deliver to: RSS feed") in the Sources sheet
(`news:v1:custom`, up to 10). The cron asks every 15 minutes and reads at most 12 due sources a
tick (ABC every 15 minutes, others every 30 or 60); Refresh reads them all (at most once a minute).
Google News answers Cloudflare with HTTP 503, so `.github/workflows/news-relay.yml` (every 15
minutes, `node infra/news-relay.mjs`) reads the two `relay: true` sources from GitHub and posts
them to `POST /api/news/relay`. That route needs no secret: the Worker checks the GitHub Actions
OIDC token (issuer token.actions.githubusercontent.com, audience https://getyolko.com, repository
LitKanna/getyolko, `job_workflow_ref` news-relay.yml on refs/heads/main) against GitHub's keys.
While the relay is fresh (90 minutes) the Worker doesn't try Google itself. Stories are kept 90
days, 500 at most, one row per headline (an outlet's own copy replaces the Google News one), all in
one KV key `news:v1`, written only when something changed or every half hour. Admin routes:
`GET /api/news`, `POST /api/news/poll`, `POST /api/news/feeds {url}` or `{id, remove: true}`. Run
`npm run test:news` after changing the parser. Nothing here is shown on the shop.

### Egg varieties, stock and prices (Nov 2026)
`infra/catalogue.mjs` is the one list of everything YOLKO can sell, as Kanna set it out: trays
(cage 1.75kg, which is the main tray, cage 1.5kg, cage 1kg, cage 1kg 18 pack, free range and cage
free at 1.5kg and 1.75kg) and dozens (cage and free range 500 to 800g, cage free 600 to 800g).
Barn laid is cage free. Keys: the main tray keeps `tray1` / `tray2` / `box` and its stock stays
`traysAvailable`; other trays are `<id>-1`, `<id>-2`, `<id>-box` (e.g. `fr1500-2`); dozens are
`<id>` and `<id>case` (15 dozens). Every other variety's stock is `settings.stock[<id>]` and its
cost `trayCosts` (box of 6) or `dozenCosts` (case of 15). A price of 0 means that option isn't
sold. A variety shows on the shop only with stock and a price (`shopView`, sent as `shop` in
`GET /api/settings`); the order and checkout routes refuse anything else (`stockProblem`). The
main tray keeps its old rule: always orderable, the shop says when it's sold out. Paid orders take
stock from their own variety (`stockHeld: { variety, units }`; older `{ trays, dozens }` holds
still release). Admin > Stock & prices lists every variety under Trays or Dozens, then kind; stock
is typed in the row and saved from the save bar, prices open in a sheet that saves at once. Prices
never move by themselves (Kanna, 3 Nov 2026: $13 / $25 / $72 for the main tray, fixed).

### Admin page design (Apple HIG, Oct 2026)
`infra/admin.html` follows Apple's Human Interface Guidelines. Keep: 44 x 44 pt touch targets
under `(pointer:coarse)`, 4.5:1 text contrast, dark mode that follows the system, 16px inputs on
phones (no iOS zoom), safe-area padding. Prefer an Undo toast over a confirm dialog; dialogs say
Cancel, and a destructive button is never the default. Sheets have a grabber and swipe down to
close. The phone tab bar (Orders, Run, Stock, Emails, More) is navigation only, so everything else
lives on the More page. Buttons show a spinner while working. Page headings have no description
line (Kanna: it "sounds like ai"); the line under a heading only shows a live fact such as the next
delivery or a stop count, or a problem. On the Emails page the Zoho status (sending, delivery status,
mailbox, Thursday reminders) lives in the Settings sheet, never as a row on the page; only a
problem shows, as one line under the heading. The open email is a single scroll with the email
frame sized to its content (fitted as soon as it is parsed, and wide newsletters shrink to fit), so
there is no box inside a box. Reply always stays in reach: the subject row is pinned on wide
screens and the top bar holds it on phones. Under the subject, an open email shows one person row
like Mail (initials, name, address, time; order emails add their status chip) and the customer's
order as one button: no From/To/Received labels or raw headers. The stock page hides pickup days
while the shop is delivery only. Before calling an admin change live, look at full-page
screenshots at desktop and phone sizes in light and dark.

The look is iOS 27 (Figma file "YOLKO Admin", page "iOS 27 admin") in black, white and greys
only. Kanna's rule (Oct 2026): no colour at all, so never add hues, tinted glows or coloured icon
tiles; status shows by fill, weight and words (what needs you is solid black, white in dark mode).
Kanna also asked for it to be modern and creative, not plain kit defaults. All colours, radii, glass
and spring curves are tokens in `:root` (dark ones in `:root.dk`). The page is a flat grey; the
sidebar, tab bar, toolbar buttons and save bar are Liquid Glass; cards are crisp white with a
hairline shadow (`--card-shadow`); the chosen sidebar item and tab are a solid capsule that glides
(`glide()`); toasts are black capsules in both appearances. Emphasis uses `--sel`/`--on-sel` (black
in light, a mid grey in dark) so dark mode never shows big white blocks; the main action button is
the only white solid in dark. Kanna's polish rules (29 Oct 2026): every panel and the last card of a
page end on the sidebar's bottom line, 16px (`--edge`) from the screen edges; one type scale (page
titles 30, stat numbers 28, order total 40, card titles 17, body 15, labels 13, all sentence case);
check iPad sizes too (Kanna mostly uses an iPad Pro in dark). Appearance is Light, Dark or Auto from
the switch in the sidebar (More on phones), kept in `localStorage` (`yolko_theme`); the script in the
head puts `.dk` on `<html>` before the first paint. Plain customer emails read light on dark in Dark.
On screens under 820px tall the sidebar drops the week card so nothing squashes. Customer cards are
one quiet line under the name, a row of four facts and the next step, with no chips. Only the order
tabs that need you (Upcoming, Waiting, Not paid) show a count, so the tabs fit an iPad. An order reads
like a Wallet pass: big name and total, a progress track whose truck drives to the order's step, round
contact buttons, then the delivery as a ticket with a perforated tear line. Motion uses the spring
tokens (`--spring`, `--spring-bouncy`, `--spring-snappy` with `--t-*` durations): orders and emails
open out of their row on phones, sheets spring up and follow the finger, widgets roll changed
numbers, and the phone large title folds into a frosted top bar. Everything respects reduced
motion. Apple devices get SF Pro; others get the self-hosted Inter.

### No lint / test / build tooling
There is no ESLint/Prettier/Ruff or test framework configured. `npm test` is a placeholder
that intentionally fails (`echo "Error: no test specified" && exit 1`). do not treat that as
a real failure. `.github/workflows/` handles GitHub Pages + Worker deploys only.

### Other tooling (optional, ops-only)
- `infra/*.py` image generators need `pip install -r requirements.txt` (opencv, Pillow).
- `infra/meta-*.mjs` Meta ad automation uses Playwright (installed via `npm install`) and
  requires `npx playwright install chromium` plus a `META_ACCESS_TOKEN`.
