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
`egg-delivery-areas.html`, `404.html`, `sitemap.xml`, and the JSON-LD and FAQ blocks inside
`index.html` are generated. Edit `infra/build-pages.mjs` (copy, prices, `CSS_V`, structured data)
or `infra/build-areas-page.mjs` (the A to Z suburb list), then run
`node infra/build-pages.mjs && node infra/build-areas-page.mjs`. Never put the Sydney Markets
address or its 2129 postcode on any page: YOLKO is a home-based, service-area business.

### Look (Kanna's choice, Oct 2026)
"Quiet local shop": one font (Plus Jakarta Sans), black text on an ivory page, normal-size
sentence-case headings with no trailing full stop, no orange. Yolk yellow only on the logo
dot and the Order / Buy buttons (`.btn-solid`); selected options get a black outline, not a
fill. Never change, swap or re-crop the site images.

### Viewport fit (non-obvious)
`index.html` measures `visualViewport` (Chrome / Safari / iOS browser chrome) into
`--vvh` / `--app-height` before paint. Hero/showcase CSS uses `--frame-h` from that,
not raw `svh`/`dvh` alone. Chalk-tray heroes are **1:1**. keep `aspect-ratio: 1 / 1`
on `.showcase-card` (do not revert to `3/4`). After Worker deploys, bump
`X-Yolko-Build` and keep `CHALK_ASSETS_SHA` so the hero does not 404 black.

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

Order payments and emails: `POST /api/stripe-webhook` (Stripe events `checkout.session.completed`
and `checkout.session.async_payment_succeeded`) marks orders paid and sends the confirmation
email through Zoho ZeptoMail. Secrets: `STRIPE_WEBHOOK_SECRET`, `ZEPTOMAIL_TOKEN`,
`ORDER_EMAIL_FROM`; optional `ORDER_NOTIFY_EMAIL` (shop copy) and `ZEPTOMAIL_API_URL`
(defaults to Zoho CPaaS `https://cpaas.zoho.com/v1.1/email`; same API as ZeptoMail). Without them the webhook
returns 503 and emails are skipped; `/api/confirm-payment` still marks orders paid and also
sends the email if the webhook has not. Admins can resend with `POST /api/admin/order-email {id}`.
The admin Emails page uses `GET /api/admin/emails`, `GET /api/admin/email-preview?id=` and
`POST /api/admin/test-email {to}`. All shop email is orders@getyolko.com on Zoho (order emails
reply to it too); getyolkonow@gmail.com is only for Google sign-ins, never for mail.

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
Delivery status (delivered, opened, clicked, bounced, spam) comes from the Zoho CPaaS webhook
`POST /api/zoho/email-events` (set in CPaaS > Agents > agent_1 > Webhooks). Zoho webhooks carry no
credentials, so there is no token: an event only counts when its request id matches an
`email:req:<requestId>` key written when the Worker sent that email.

Thursday reorder reminders: the order form's "Email me a reminder each Thursday" box sends
`remind: true`; the order carries `remindOptIn`, and `markOrderPaid` signs the Stripe email up
(`remind:sub:<sha256(email) prefix>`, list in `remind:index`, link token in `remind:tok:<token>`).
The cron sends from Thursday 10am to Friday 10am Sydney time, 4 per tick, through the Zoho Mail
mailbox (never the CPaaS order sender, which forbids marketing). It skips sold-out weeks, people
who already ordered for that Saturday, and everything while `remind:off` is set (admin Pause).
"Order again" links to `/#reorder=<token>`: `index.html` lifts the token out of the URL before the
visit log or Meta pixel can read it, and `app.js` fills the form from `GET /api/reorder?t=`.
Unsubscribe is `/api/reminders/stop?t=` (GET asks, POST stops, so mail scanners can't unsubscribe).

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

### No lint / test / build tooling
There is no ESLint/Prettier/Ruff or test framework configured. `npm test` is a placeholder
that intentionally fails (`echo "Error: no test specified" && exit 1`). do not treat that as
a real failure. `.github/workflows/` handles GitHub Pages + Worker deploys only.

### Other tooling (optional, ops-only)
- `infra/*.py` image generators need `pip install -r requirements.txt` (opencv, Pillow).
- `infra/meta-*.mjs` Meta ad automation uses Playwright (installed via `npm install`) and
  requires `npx playwright install chromium` plus a `META_ACCESS_TOKEN`.
