# 020 — polish round (wp4): ima2 field assets, fonts, pill header, frosted blur, SVG, motion

## User steering

- ima2로 에셋 생성해서 투입, 헤더 필 좌우 동적 조정, 블러 높여 "가짜 글래스" 프로스트
  느낌, SVG 아이콘 적극 사용, 스크롤 박스 모션 증량, 폰트 교체. cxc-loop 유지.
- Session note: original session file vanished after D close; CLI suggested and we
  switched to `--session cli` for this and later cycles.

## Done

- ima2 gen (gpt image, high, 2048x1152, n=2 per theme): soft-focus daylight sky +
  dusk variants; picked f358b72d_1 (light, sun glow upper-left) and d6ce6d88_1
  (dark, balanced amber horizon). Copied to src/assets/hero-field-{light,dark}.png,
  rendered as astro:assets layer inside .lp-hero-field (light/dark toggled by
  data-theme), CSS gradients kept as loading fallback.
- Fonts: @fontsource-variable/geist + pretendard (variable dynamic subset) via
  starlight customCss module ids; --sl-font = Geist Variable, Pretendard Variable.
- Pill header: outer bar transparent, inner .header glass pill max-width 78rem
  margin-inline auto (fluid side margins), blur raised to saturate(1.5) blur(40px),
  rail alpha 0.55 for the frosted fake-glass look.
- SVG: Lucide-path stroke icons inline in bento cell h3 (plug/key/users/picker/
  bot/search) + sitemap group heads (rocket/book/code/folder), currentColor.
- Motion: alternating ocx-slide-left/right on bento cells (odd/even), quick-copy
  from left, terminal from right, stage settle scale+translate — all view()
  timeline inside prefers-reduced-motion: no-preference.

## Evidence

- build 49 pages OK; screenshots 1783608281975 (light), 1783608327963 (dark),
  1783608330015 (ko); computed dark .lp-btn-primary = rgb(244,244,244).
