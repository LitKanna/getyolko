# getyolko - YOLKO

Online store for fresh Pace Farm egg trays, delivered across Sydney on Saturday mornings
(flat $5, within 45 km of Flemington). Prices are set live from the `/admin` dashboard.

## Configure (config.js)

After editing `config.js`, `app.js` or `styles-modern.css`, bump its `?v=` in `index.html`
(and the `egg-delivery-*.html` pages for the stylesheet) so browsers fetch the new file.

- `whatsappNumber` — enables a one-tap WhatsApp booking button
- Payments use Stripe Checkout via the Worker (`/api/checkout`); stock and prices come from `/admin`

See `ads/setup-guide.md` for step-by-step setup, and `ads/` for
ready-to-paste Facebook, Instagram, and Google ad campaigns.

Growth system (free guide, weekly standing orders, partner peel, truth copy,
split-test order): see `growth-playbook.md` and `LAUNCH.md`.

## Preview locally (on your computer only)

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

**Note:** `localhost` only works on the same device running the server. It will **not** work on your phone — use the live URL below instead.

## Live website

**https://getyolko.com/**

## How to share it

- Google: use words like "eggs Flemington" and "fresh eggs near me"
- Facebook: share in Flemington, Homebush, Strathfield, Lidcombe, and Auburn groups
- Instagram: post weekly stock photos and pickup times
