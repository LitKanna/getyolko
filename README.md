# getyolko - YOLKO

One-page marketing site for selling fresh egg trays with **Friday** and **Saturday** pickup at Paddy's Markets Flemington.

## Bundles

| Bundle | Eggs | Price |
|---|---|---:|
| 1 tray | 30 | $12 |
| 2 trays | 60 | $23 |
| Full box | 180 | $66 |

## Configure (config.js)

- `whatsappNumber` — enables a one-tap WhatsApp booking button
- `stripeLinks` — Stripe Payment Links enable "Pay online now" buttons
- `traysAvailableThisWeek` — limited-stock note under prices

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

## Pickup schedule

| Day | Hours | Location |
|-----|-------|----------|
| **Friday** | 10:00 AM – 4:30 PM | Paddy's Markets Flemington, Building D |
| **Saturday** | 6:00 AM – 2:00 PM | Paddy's Markets Flemington, Building D |

## Pricing

- 30-egg tray: **$12**
- Payment on pickup (cash or card)

## How to share it

- Google: use words like "eggs Flemington" and "fresh eggs near me"
- Facebook: share in Flemington, Homebush, Strathfield, Lidcombe, and Auburn groups
- Instagram: post weekly stock photos and pickup times
