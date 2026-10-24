---
name: modern-web-taste
description: Research-backed 2026 web taste, UX, and instant-loading playbook. Use when designing or redesigning landing pages, auditing AI-slop UI, choosing typography/color/layout, or optimizing LCP/INP/CLS. Forces a design read, kill-list check, and performance gate before shipping.
---

# Modern Web Taste Skill

Read the full guide first: `docs/MODERN-WEB-TASTE-GUIDE.md`.

## Mandatory pre-flight

1. Write a one-line **design read** (page kind · audience · vibe · aesthetic family).
2. Pick **one** aesthetic family and **one** signature element.
3. Lock tokens in `DESIGN.md` (colors, type, radius, shadow).
4. Run the **2026 kill list** from the guide; remove matches.
5. Ship only after taste + UX + performance checklists pass.

## Non-negotiables

- Clarity in under 3 seconds; one primary CTA intent/label.
- No Inter-default / blue-500 / three-equal-cards / cream+Fraunces / purple glow clusters unless the brief explicitly demands them.
- Cards only for interaction. Hero has no stats/logo walls/schedules.
- Motion only for hierarchy, storytelling, feedback, or state — honor `prefers-reduced-motion`.
- Performance is part of taste: LCP ≤ 2.5s (stretch ≤ 1.5s), INP ≤ 200ms, CLS ≤ 0.1, hero image usually < 200KB WebP.
- Screenshot at 1440 and 390 before calling done; verify live build headers after deploy.

## YOLKO specifics

- Job: book Fri/Sat Flemington tray pickup.
- Prices: $12 / $23 / $66. Eggs are large · 1.75kg.
- Bind price UI by bundle key, never DOM index.
- Preserve booking element IDs.

## Resources (short list)

Godly · Land-book · Mobbin · Refactoring UI · web.dev Vitamins · Sailop anti-AI patterns · Brainy landing principles.

Full URLs and procedures live in `docs/MODERN-WEB-TASTE-GUIDE.md`.
