# Meta ads — launch status

Last run: 4 Jul 2026

## What's done (via API)

| Item | Status | ID |
|---|---|---|
| Ad account **yolko** | Ready, billing linked (Mastercard) | `act_1230148938407162` |
| Facebook Page **Yolko** | Connected | `1208071762387787` |
| Ad image uploaded | Done | hash `b2bcac98c3e840b89706c8cc5c3e3b02` |
| Campaign **YOLKO — Flemington pickup** | Created (paused) | `120256182964900197` |
| Ad set **Flemington 8km — Fri/Sat pickup** | Created (paused), $10/day | `120256182965760197` |

**Targeting:** Flemington + 8 km, ages 25–65, cooking/baking/markets/family interests, Facebook + Instagram feed/stories/reels.

## One step left — switch app to Live

Creative creation was blocked because the Meta Developer app **Yolko** is in **Development** mode.

1. Open [Yolko app settings](https://developers.facebook.com/apps/2531670010617110/settings/basic/)
2. At the top, toggle **App Mode** from **Development** to **Live**
3. If asked, set Privacy Policy URL to `https://getyolko.com/` (or add a privacy page first)

Then re-run (token via env, never commit it):

```bash
META_ACCESS_TOKEN='your-token' node infra/meta-launch.mjs
META_ACCESS_TOKEN='your-token' META_ACTIVATE=1 node infra/meta-launch.mjs
```

The script reuses the existing campaign and ad set, creates 3 ads from `facebook-instagram-ads.md`, then optionally activates them.

## Or finish in Ads Manager (2 minutes)

Open the ad set directly:

https://adsmanager.facebook.com/adsmanager/manage/adsets?act=1230148938407162&selected_adset_ids=120256182965760197

Click **Create ad**, paste copy from `facebook-instagram-ads.md`, use `assets/social-eggs-1080.jpg`, destination `https://getyolko.com/`, then turn the campaign **On**.

## Security note

Do not paste access tokens into chat again. Add `META_ACCESS_TOKEN` under Cursor → Cloud Agents → Secrets and say “launch meta ads” — the agent will read it from there.
