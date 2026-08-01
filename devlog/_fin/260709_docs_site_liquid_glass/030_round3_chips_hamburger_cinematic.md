# 030 — round 3: brand chips, splash hamburger, cinematic scroll (wp1-wp2)

## User steering (260710)

- 프로바이더 칩에 실제 브랜드 SVG / 헤더 필에 햄버거(스플래시에서 사라진 ☰) /
  "대시보드가 아니잖아" — 시네마틱 스크롤 모션 증량 / 데모 GIF 하단 포커스 크롭 /
  히어로 중앙정렬 + 라이트 웨이트(440) / 패널·버튼 불투명하게.

## Shipped

- simple-icons@16.25.0: siAnthropic/siGoogle/siMoonshotai(Kimi)/siOllama/
  siOpenrouter/siDeepseek inline marks; xAI/Groq/Azure/GLM text-only (library
  has no official mark — no generic substitutes).
- Header.astro: splash-only .lp-menu hamburger (<72rem) + glass panel with all
  docs groups, aria-expanded/controls, Esc/outside close; toggle script covers
  nav dropdowns + menu button.
- Cinematic motion: scroll(root) hero-away (0-90vh) + field photo zoom settle
  (0-130vh), terminal clip-path wipe, 38px alternating slides, 11-chip stagger,
  stage settle 46px/0.965 — all reduced-motion gated.
- Opacity pass: --ocx-glass-panel 0.96 both themes, ghost button solid white,
  chips 0.95/0.94.

## Bugs found by audits (Anscombe, gpt-5.5)

1. lightningcss merged animation-timeline into the `animation` shorthand
   (`animation:linear both ocx-hero-away scroll(root)`) — Chrome rejects the
   whole declaration; scroll-driven motion silently dead in dist. Fix:
   vite.build.cssMinify = "esbuild" in astro.config.mjs. Verified computed
   animationName/Timeline live.
2. translateX(38px) reveals widened the page at 773px (scrollWidth 780) —
   fix: .lp { overflow-x: clip }. Verified sw==cw, field zoom unaffected.

Final gate: fresh reviewer Plato (gpt-5.5) — pending at time of writing.
