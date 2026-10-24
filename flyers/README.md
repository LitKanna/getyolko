# YOLKO flyer card (Saturday delivery)

Professional recreation of the Yolko promotional card — editable source + print PNG + Photoshop handoff.

| File | Purpose |
|------|---------|
| `yolko-saturday-card.html` | Vector/type source (open in browser, tweak CSS) |
| `exports/yolko-saturday-card-1080x1620.png` | Print/social export |
| `assets/tray-multicolor.png` | Product photo plate |
| `assets/qr-getyolko.png` | QR → https://getyolko.com/ |
| `PHOTOSHOP-HANDOFF.md` | Layer stack, colors, fonts for Photoshop on your PC |

## Preview
```bash
python3 -m http.server 8090 --directory flyers
# open http://localhost:8090/yolko-saturday-card.html
```

## Re-export PNG
```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/local/bin/google-chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1200, height: 1800 } });
  await p.goto('http://127.0.0.1:8090/yolko-saturday-card.html?export=1', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
  await p.locator('#flyer').screenshot({ path: 'flyers/exports/yolko-saturday-card-1080x1620.png' });
  await b.close();
})();
"
```

## Photoshop on your PC
1. Open the PNG as a locked reference.
2. Follow `PHOTOSHOP-HANDOFF.md` — rebuild type/shapes as layers.
3. Place Linked the tray + QR from `assets/`.
