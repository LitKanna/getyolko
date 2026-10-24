# Modern Web Taste Guide (2026)

**Purpose:** A practical, research-backed playbook for building landing pages that feel intentional, convert, and load instantly — not like AI templates.

**Built for:** YOLKO and similar local-commerce / DTC conversion pages.  
**Sources:** conversion research (Brainy Papers, Landdding, Digital Applied), anti-AI design analysis (Sailop, Rottoways, Shuffle), motion craft (Codrops, kinetic type guides), Core Web Vitals (web.dev), inspiration galleries (Godly, Land-book, Mobbin, Awwwards), and craft books (Refactoring UI).

---

## 0. One-line design read (always start here)

Before pixels:

> Reading this as: **\<page kind\>** for **\<audience\>**, with a **\<vibe\>** language, leaning toward **\<aesthetic family\>**.

Example for YOLKO:

> Reading this as: local-food conversion landing for Flemington shoppers, with a modern DTC / Pace Farm retail language, leaning toward clean product-hero + navy/blue trust system.

If you cannot write that sentence, you are guessing. Guessing produces Inter + blue-500 + three cards.

---

## 1. What “taste” actually means in 2026

Taste is not decoration. Taste is a stack of decisions:

1. **Clarity** — visitor understands offer in under 3 seconds  
2. **Specificity** — brand choices that could not belong to another product  
3. **Restraint** — one accent, one primary CTA, one hero job  
4. **Proof** — real product, real place, real price  
5. **Performance** — the page feels instant on mid-tier mobile  

Pretty without those five is costume design.

---

## 2. The 2026 kill list (do not ship these)

From conversion papers + AI-slop research:

| Pattern | Why it fails |
|---------|--------------|
| Inter / system-ui as “the brand font” | Default monoculture (~73% of AI frontends) |
| `#3B82F6` / indigo CTA | Tailwind blue = new Times New Roman |
| Centered hero + gradient mesh | Safest AI layout; zero brand memory |
| Three equal feature cards | Flattens hierarchy; nothing is important |
| Cream paper + terracotta + Fraunces | Premium-consumer AI cluster |
| Purple-on-white / purple glow | Classic AI fingerprint |
| Logo marquee with no names | Decorative trust, not proof |
| Four competing CTAs in hero | Decision paralysis |
| Autoplay hero video | Heavy, slow, often worse than static |
| `backdrop-blur` on everything | 2022 glass shorthand, now a tell |
| Em-dash poetry / “Quietly trusted by” | LLM copy fingerprint |
| Fake screenshots built from `<div>`s | Instant AI tell |
| Equal-weight pricing towers | No recommended path |
| Busy image placeholders waiting for “later” | Incomplete product |

**Rule:** if removing an element does not hurt understanding or conversion, remove it.

---

## 3. Unique thinking procedure (how to design, not decorate)

Use this sequence every time. Do not skip steps.

### Step A — Subject world
Name the subject’s materials, place, and vernacular.

- YOLKO: Pace Farm trays, Flemington market mornings, cash/card pickup, `$12` tray economics  
- Not: “farm vibes,” “organic wellness,” “AI food tech”

### Step B — One job
One page = one action.

- YOLKO job: **Book a tray for Fri/Sat pickup**  
- Everything else supports that job or dies

### Step C — Signature (one memorable thing)
Pick **one** signature element. Protect it. Keep everything else quiet.

Good signatures:

- Oversized real price next to real product  
- Full-bleed product plane with brand-first type  
- White retail card composition (Pace-style) with navy feature bar  

Bad signatures:

- Three competing signatures (giant brand + giant price + stamps + marquee)

### Step D — Token lock
Write 4–6 named colors, 1–2 typefaces, one radius system, one shadow language. Lock them in `DESIGN.md`. No off-token values.

### Step E — Hierarchy map
Eye order must be:

1. Brand or offer claim  
2. Price / proof  
3. Primary CTA  
4. Product visual  
5. Everything else  

Squint test: blur the page. If CTA and claim disappear, hierarchy failed.

### Step F — Section jobs
Each section gets **one purpose, one headline, one short support line**.

Suggested conversion spine:

1. Hero (claim + CTA + product)  
2. Proof strip (specific facts, not fluff)  
3. Bundles (interaction cards only)  
4. Pickup (when/where)  
5. Booking form (minimum fields)  
6. FAQ (objections)  

### Step G — Chanel pass
Before shipping: remove one accessory. Then remove one more.

### Step H — Performance pass
If LCP > 2.5s or hero image > 200KB, the design is unfinished.

---

## 4. Visual systems that feel modern (and how to choose)

### 4.1 Aesthetic families (pick one, commit)

| Family | When to use | Signature moves | Avoid |
|--------|-------------|-----------------|-------|
| **Quiet DTC** | Consumer product, local commerce | Cool neutrals, one accent, product photo hero | Cream craft, serif shout |
| **Retail card** | Brand-adjacent CPG look | White plane, navy/blue pills, feature bar, soft blobs | Outer colored frames, clutter stickers |
| **Editorial kinetic** | Brand manifesto / launch | Oversized type, scroll-tied motion | Motion without meaning |
| **Linear-clean SaaS** | Tools / B2B | Dense clarity, product UI proof | Fake dashboards |
| **Brutal / raw** | Agency / experimental | Hard edges, mono, asymmetry | Using it for grocery conversion |

For YOLKO, **Quiet DTC** or **Retail card** are the correct families. Not editorial craft, not carnival poster.

### 4.2 Typography rules

- Prefer **one strong sans** (Outfit, Plus Jakarta, Geist, Satoshi, Cabinet Grotesk) over Inter  
- Serif only when the brand is truly editorial/heritage — and never default to Fraunces / Instrument Serif  
- Display: tight tracking, controlled size (usually `clamp`, not screaming 8xl)  
- Body: 16px+, max ~65ch, `text-wrap: pretty`  
- Numbers: `tabular-nums` for prices  
- Emphasis: italic/bold of **same family**, not mixed-family stunts  

### 4.3 Color rules

- Max **one** accent used for action/price energy  
- Neutrals stay in one temperature family (cool or warm, not both)  
- CTA contrast must pass WCAG AA (4.5:1 body / 3:1 large)  
- Accent appears a few times, not everywhere (or it stops meaning “act”)  

### 4.4 Layout rules

- Anti-center bias for variance > 4: prefer split / asymmetric  
- Cards only when they contain interaction (pricing, form). Otherwise use space and rules  
- One corner-radius system (document it)  
- Max 1 eyebrow per 3 sections  
- No 3+ zigzag image/text sections in a row  
- Hero budget: brand/claim + one support line + CTA group + one dominant visual  

### 4.5 Motion rules

Motion must answer: hierarchy, storytelling, feedback, or state change.

Allowed defaults:

- Hero rise / price pop (once)  
- Scroll reveal on key sections (`IntersectionObserver` or CSS scroll-driven)  
- Button press (`scale(0.98)`)  
- Soft float on 1–2 decorative elements max  

Banned by default:

- Marquee spam  
- Autoplay video heroes  
- Scroll hijacks on conversion pages  
- Infinite loops on informational cards  
- Animating `top/left/width/height`  

Always honor `prefers-reduced-motion`.

---

## 5. UX that converts (not just looks nice)

### 5.1 Hero checklist

- [ ] Value clear in one sentence  
- [ ] CTA visible without scroll on mobile  
- [ ] Subtext ≤ ~20 words  
- [ ] One primary CTA label used consistently sitewide  
- [ ] Product visual proves the claim (real tray, not abstract gradient)  
- [ ] No trust logos / stats / schedules inside the hero  

### 5.2 Proof

Prefer specific over decorative:

- “Pace Farm large · 1.75kg”  
- “Fri 10:00–16:30 · Sat 06:00–14:00”  
- “Building D, Flemington NSW 2129”  

Avoid:

- “Trusted by thousands”  
- Gray logo walls with no names  

### 5.3 Pricing / bundles

- Recommended tier visually dominant  
- CTA pinned to bottom of each option  
- Prices bound by **bundle key**, never by DOM index  
- Copy matches math (single = 30 eggs / $12, double = 60 / $23, box = 180 / $66)  

### 5.4 Forms

- Minimum fields (name + AU mobile for YOLKO)  
- Labels above inputs  
- Inline errors, never `alert()`  
- Touch targets ≥ 44–48px  
- Sticky mobile CTA after hero, hidden when form is on screen  

### 5.5 Accessibility floor

- Visible `:focus-visible` rings  
- Semantic landmarks (`header`, `main`, `nav`, `footer`)  
- Skip link to booking  
- Alt text on meaningful images; empty alt on pure decoration  
- Contrast audited on CTAs and body text  

---

## 6. Performance = taste (instant loading playbook)

If it is slow, it feels cheap — regardless of fonts.

### 6.1 Targets (field, 75th percentile)

| Metric | Good | Stretch for conversion pages |
|--------|------|------------------------------|
| **LCP** | ≤ 2.5s | ≤ 1.5s (ideal ≤ 800ms first paint) |
| **INP** | ≤ 200ms | ≤ 100ms on primary CTA |
| **CLS** | ≤ 0.1 | ≤ 0.05 |
| Hero image | — | WebP/AVIF, usually **< 200KB** |

Source baseline: [web.dev Web Vitals](https://web.dev/articles/vitals).

### 6.2 Instant-loading recipe (static landing)

1. **One HTML document**, minimal critical CSS, deferred JS  
2. **Preload LCP image** (`rel=preload` + `fetchpriority="high"`)  
3. **Never lazy-load the hero image**  
4. **Width/height or `aspect-ratio`** on all media (CLS)  
5. **One font family**, subset weights you actually use, `display=swap`  
6. **No third-party scripts in critical path** (chat, heavy analytics)  
7. **Cache HTML short / assets hashed** (`?v=` or content hash)  
8. **CDN edge** for HTML+assets (Cloudflare Worker pattern)  
9. **Animate only `transform` + `opacity`**  
10. **Ship fallback HTML** at the edge so origin blips never blank the site  

### 6.3 Image strategy

Priority order:

1. Real product photo (compressed WebP + JPEG fallback)  
2. Generated studio product shot if real photo is noisy  
3. CSS shapes / SVG marks for decoration  
4. Never leave empty gray “image coming soon” blocks in the hero  

### 6.4 JS discipline

- One booking script, event-delegated where possible  
- Throttle scroll with `requestAnimationFrame`  
- No `window.onscroll` layout thrash  
- Settings fetch after first paint; hydrate prices without layout jump  

---

## 7. Best resources (curated)

### Inspiration (look)

- [Godly](https://godly.website/) — high-curation modern sites  
- [Land-book](https://land-book.com/) — landing page gallery  
- [Awwwards](https://www.awwwards.com/) — experimental craft (steal structure, not every effect)  
- [Lapa Ninja](https://www.lapa.ninja/) — landing references  
- [Minimal Gallery](https://minimal.gallery/) — restraint studies  

### Product UI patterns (use)

- [Mobbin](https://mobbin.com/) — real app/web flows  
- [Refero](https://refero.design/) — SaaS page components  
- [Page Flows](https://pageflows.com/) — recorded flows  

### Craft / systems (learn)

- [Refactoring UI](https://refactoringui.com/book) — practical visual tactics  
- [web.dev Vitamins / CWV](https://web.dev/articles/vitals) — performance truth  
- [Codrops](https://tympanus.net/codrops/) — advanced interaction case studies  

### Anti-slop / taste diagnostics (avoid defaults)

- [Sailop: Why AI sites look the same](https://sailop.com/blog/why-every-ai-generated-website-looks-the-same)  
- [Sailop: 90+ AI patterns to avoid](https://sailop.com/blog/90-plus-ai-design-patterns-to-avoid-definitive-list)  
- [Rottoways on AI monoculture](https://rottoways.com/blog/ai-generated-website-looks-generic)  

### Conversion principles (decide)

- [Landing page principles 2026 (Brainy)](https://brainy.ink/paper/landing-page-design-principles)  
- [What makes a landing page modern (Landdding)](https://landdding.com/blog/what-makes-a-landing-page-look-modern)  

### Reference brands to study (structure, not clone)

- Linear, Stripe, Vercel — clarity + performance  
- Glossier / Allbirds — DTC product calm  
- Pace Farm retail pages — CPG trust language for egg category  

---

## 8. Build checklist (ship gate)

### Taste

- [ ] Design read written  
- [ ] Aesthetic family chosen and not an AI cluster default  
- [ ] Tokens locked in `DESIGN.md`  
- [ ] One signature only  
- [ ] Kill-list items absent  
- [ ] Squint test passes  

### UX

- [ ] One primary CTA intent/label  
- [ ] Mobile CTA above fold  
- [ ] Bundle prices correct and selector-safe  
- [ ] Form minimum + errors inline  
- [ ] Focus rings + reduced motion  

### Performance

- [ ] LCP image preloaded, < ~200KB  
- [ ] CLS reserved for media  
- [ ] No critical third-party JS  
- [ ] Build/version headers verifiable on live  
- [ ] Hard-refresh verified on real mobile width (390px)  

---

## 9. YOLKO-specific application notes

When redesigning getyolko.com:

1. Keep booking IDs stable (`order-form`, bundle radios, qty, WhatsApp/Stripe hooks)  
2. Price truth: **1 tray $12 / 2 trays $23 / box $66**  
3. Eggs are **large**, tray **1.75kg**, pickup **Fri/Sat Flemington**  
4. Prefer product-proof heroes over abstract “farm mood”  
5. Prefer navy/ink CTAs or one yolk price accent — not three competing accents  
6. Never update `.price-big` by DOM index if featured card order differs from tray1→tray2→box  

---

## 10. How to use this guide with an AI coding agent

1. Paste the **design read** first  
2. Point the agent at this file + `DESIGN.md`  
3. Forbid the kill list explicitly  
4. Require screenshots at 1440 and 390 before “done”  
5. Require live header build tag verification after deploy  

Agents execute systems well. They invent taste poorly. **Hand them the system.**

---

## Appendix A — Research notes (what the sources agree on)

1. **Clarity beats decoration** for conversion in 2026.  
2. **Performance is a design decision**, not a later engineering chore.  
3. **AI monoculture is real** (Inter, blue-500, 3 cards, blur, centered heroes). Escape via constraints.  
4. **Motion must be motivated**; native CSS scroll-driven > heavy JS when possible.  
5. **Show the product**; do not illustrate an abstraction of it.  
6. **One primary CTA**; ladder secondary intents quietly.  
7. **Modular sections** make iteration and A/B testing sane.  

## Appendix B — Suggested weekly taste workout (30 minutes)

1. Save 5 Land-book/Godly references in the same aesthetic family  
2. Write why each works in one sentence  
3. Steal **one** structural idea (not the whole look)  
4. Apply it to one YOLKO section  
5. Measure LCP on mobile before/after  

---

*Last updated: 2026-07-09. Revisit quarterly; kill-list items age quickly.*
