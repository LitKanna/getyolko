# YOLKO Saturday Flyer — Photoshop handoff

Editable web/vector source: `yolko-saturday-card.html`  
Print/export PNG: `exports/yolko-saturday-card-1080x1620.png` (generated)  
Product photo: `assets/tray-multicolor.png`  
QR: `assets/qr-getyolko.png` → https://getyolko.com/

## Canvas
- **Size:** 1080 × 1620 px (portrait card / IG-friendly)
- **For print @ 300 dpi:** scale to 9 × 13.5 cm, or rebuild at 2550 × 3825 px
- **Background:** `#FFF6DC`

## Brand colors
| Token | Hex |
|-------|-----|
| Red | `#E31B23` |
| Yellow | `#FFD200` |
| Blue | `#0057B8` |
| Green | `#008A3C` |
| Deep green (footer/pill) | `#0A6B38` |
| Cream | `#FFF6DC` |

## Typography (closest free matches)
| Role | Use in Photoshop | Notes |
|------|------------------|-------|
| Logo + big headlines | **Outfit Black / ExtraBold** | Rounded geometric sans |
| Body / labels | **Nunito ExtraBold** | Soft rounded |

If you have licensed fonts closer to the original (Gotham Rounded / Fredoka One), swap them on the type layers.

## Suggested Photoshop layer stack (bottom → top)
1. `BG` — solid cream
2. `Waves` — group of shape layers (TL green, TR yellow, mid red/green left, mid yellow/blue right)
3. `Hen icon` — white line art (top left)
4. `Decor` — dots + diagonal dashes
5. `Logo Yolko` — per-letter color; final `o` = yellow + white yolk circle + 3 rays
6. `Tagline` — deep green + yellow rule lines
7. `30 FRESH EGGS` — 30 red / FRESH EGGS blue
8. `Pill` — deep green rounded rect + white `30 PACK | CAGE EGGS`
9. `Product photo` — smart object (`tray-multicolor.png`)
10. `Service icons` — Homes / Cafes / Restaurants + vertical rules
11. `CTA box` — green stroked rounded rect
12. `Truck badge` + delivery type
13. `QR` smart object + `SCAN ME` pill + URL
14. `Footer bar` — deep green + dots + nest mark + YOLKO lockup

## Quick import path
1. Open the exported PNG as a visual reference (locked bottom layer).
2. File → Place Linked for `tray-multicolor.png` and `qr-getyolko.png`.
3. Rebuild type and shapes on top (do not rasterize type).
4. Export: File → Export → Export As → PNG, and PDF (Preserve Text) for print.

## JSX starter (optional)
Open the PNG reference, then create a 1080×1620 doc and place assets:

```jsx
// File > Scripts > Browse…  (run in Photoshop)
#target photoshop
app.documents.add(1080, 1620, 72, "YOLKO Saturday Card", NewDocumentMode.RGB);
alert("Place tray + QR from flyers/assets, then rebuild type using PHOTOSHOP-HANDOFF.md");
```
