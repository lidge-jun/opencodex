# 010 — full redesign to aside.com grammar + audits (wp1/wp2)

## User steering (260709)

1. "ui 디자인 자체를 싹다 갈아엎어" — token remap alone rejected; full redesign.
2. aside.com opened as the live reference: rounded organic-field hero, left type,
   black pill CTA, white pill chips, product screenshot rising inside the field,
   blue chevron eyebrow links, generous white sections.
3. "상단바도 pill 형태" — floating detached glass pill header (outer fixed bar
   transparent, inner .header is the pill; nav flattened to avoid pill-in-pill).
4. "스크롤 모션도 많이" — scroll-driven reveals via @supports (animation-timeline:
   view()): bento cells, quickstart copy/terminal, section titles, sitemap band,
   disclaimer, stage settle (translateY+scale). All inside prefers-reduced-motion:
   no-preference.

## Shipped structure

- `src/components/Landing.astro` — shared 3-locale landing (t() dict): hero field
  (.lp-hero-field CSS sky wash light/dusk dark), copy/CTA/chips inside field,
  dashboard stage in-field (.lp-stage-in), quickstart band (copy + custom
  terminal panel), feature bento (grid-template-areas, dominant prov cell with
  demo.gif, picker cell with codex-app-picker.png), docs sitemap band (.lp-next,
  full coverage incl. mobile path), quiet disclaimer.
- `src/components/Header.astro` — floating glass pill; desktop >=72rem hover +
  focus-within + click-toggle dropdowns (aria-expanded/aria-controls, Esc/outside
  close); mobile keeps Starlight hamburger on docs pages.
- `src/components/PageTitle.astro` — skips stock h1 on splash pages; Landing owns
  h1#_top (skip-link target preserved).
- `src/assets/dashboard.png` — refreshed from live GUI v2.6.32 (agbrowse capture).
- SEO: landing frontmatter og:locale en_US/ko_KR/zh_CN + offer-form titles;
  robots.txt, JSON-LD WebSite+SoftwareApplication, theme-color (wp1).

## Audit ledger (wp2, gpt-5.5 explorers)

- Planck (design/a11y) FAIL -> fixed: skip-link target, mobile landing nav
  coverage (sitemap band), terminal role=img flattening, dropdown popup
  semantics. 768/1024/1152/1280 checked, no overflow; light-dark()/data-theme
  confirmed supported.
- Franklin (SEO/build) FAIL -> fixed og:locale + titles; PASS on canonical/OG/
  twitter/JSON-LD/robots/sitemap(48 URLs)/locale pages/fallbacks; eager
  dashboard img 97KB w/h attrs, demo.gif lazy webp 888KB (bento, lazy).
- Non-landing pages keep Starlight-default og:locale (en/ko/zh-CN) — accepted
  as upstream behavior, P3.
