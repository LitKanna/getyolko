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

### Admin page design (Apple HIG, Oct 2026)
`infra/admin.html` follows Apple's Human Interface Guidelines. Keep: 44 x 44 pt touch targets
under `(pointer:coarse)`, 4.5:1 text contrast, dark mode that follows the system, 16px inputs on
phones (no iOS zoom), safe-area padding. Prefer an Undo toast over a confirm dialog; dialogs say
Cancel, and a destructive button is never the default. Sheets have a grabber and swipe down to
close. The phone tab bar (Orders, Run, Stock, Emails, More) is navigation only, so everything else
lives on the More page. Buttons show a spinner while working. The stock page hides pickup days
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
