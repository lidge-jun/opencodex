# 000 — docs-site liquid-glass design refactor (design read + plan)

Session: 019f46e2-0902-7190-9dac-7815a139b99c / goalplan: docs-site-liquid-glass-design-refactor-hover-men

## Brief (user, 260709)

- docs-site (Astro Starlight) 전면 디자인 리팩토링: 리퀴드 글래스, "OpenAI aside" 감성
- 상단 호버 메뉴바 (데스크톱 드롭다운)
- 문서 페이지도 같은 감성
- 프로덕션 SEO + 모션
- 서브에이전트는 gpt-5.5 무제한 (리서치/감사) — 미적 판단/패치는 메인이 직접

## Design Read

Reading as: developer docs for an infra proxy (opencodex), audience = Codex power
users. Language: the GUI's OpenAI product grammar — white/near-black monochrome,
hairline borders, pill controls, glass ONLY on chrome (header / sidebar rail /
dropdowns / search modal), solid content, single ambient tri-radial wash per
viewport refracted by the glass layers.

- DESIGN_VARIANCE 4, MOTION_INTENSITY 4, density D5 (docs reading surface)
- Do: mono for model ids/code; monochrome accent (black on light / white on dark)
- Don't: glass on content cards, purple/colored Starlight card tints, emoji icons,
  negative letter-spacing, >1 ambient wash

## Token bridge (gui/src/styles.css -> Starlight --sl-*)

| GUI | Starlight target |
| --- | --- |
| --bg #ffffff / #212121 | --sl-color-black (bg base) via html; body transparent + wash |
| --text #0d0d0d / #ececec | --sl-color-white / gray-1 |
| --border #e6e6e6 / #3d3d3d | --sl-color-gray-5 (hairline) |
| --glass-rail rgba 0.66/0.62 + blur(22px) saturate(1.6) | header/.sidebar-pane bg + backdrop-filter |
| --radius 12 / pill 999 | cards 12px, buttons+nav pills 999px |
| mono accent light-dark(#0d0d0d,#ececec) | --sl-color-accent + text-accent |

Starlight pins `data-theme` (light/dark) so tokens are authored per-theme block,
not light-dark().

## Audit trail (A gate, reviewer Volta gpt-5.5)

FAIL round 1 -> 4 findings folded in:
1. import per-file `@astrojs/starlight/components/*.astro` (exports map allows), no virtual: imports
2. nav prefix = `locale ? BASE_URL+locale+'/' : BASE_URL` (root locale is undefined)
3. add ko translation of guides/sub-agent-surface; zh-cn uses Starlight fallback
   routes (verified: routing/index.ts:52 pushes isFallback pages)
4. drop og:type/og:site_name (Starlight emits both); keep theme-color + JSON-LD
Re-verdict: PASS.

## Build plan (WP1)

1. `src/styles/custom.css` — token remap, glass chrome, pill hero actions,
   card polish, motion (all `prefers-reduced-motion` gated; scroll reveal via
   `@supports (animation-timeline: view())` progressive enhancement)
2. `src/components/Header.astro` — default structure (SiteTitle/Search/Social/
   Theme/Language) + centered desktop hover-dropdown nav, hidden <72rem so the
   mobile hamburger flow is untouched; CSS hover + :focus-within keyboard path
3. SEO — public/robots.txt (sitemap pointer), JSON-LD WebSite+SoftwareApplication
   in head, theme-color meta; canonical/og/sitemap already emitted by Starlight
4. Verify — bun run build, dist checks (sitemap/robots/JSON-LD/zh-cn fallback),
   screenshots 1440/390 light/dark en/ko
5. WP2 audits (gpt-5.5 design+SEO), main patches; WP3 ship dev->main->Pages
