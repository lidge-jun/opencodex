Provider logo assets for the dashboard.

Sources:

- Existing baseline copied from `../cli-jaw/public/assets/providers`.
- Additional candidates copied from `devlog/_plan/260705_provider-quota-dashboard/svg-candidates`.

License/source notes for the additional candidates are recorded in
`devlog/_fin/260705_provider-quota-dashboard/21_svg_candidates.md` and its
`svg-candidates/manifest.json` (that unit has since closed, so the path is under
`_fin/` rather than `_plan/`).

Export-client marks (used by the API tab's connect rows, not the provider list):

- `pi.svg` — fetched 2026-08-02 from `https://pi.dev/favicon.svg`, the Pi
  project's own favicon, unmodified. Pi is `earendil-works/pi`
  (formerly `badlogic/pi-mono`).
- `opencode.svg` — part of the existing baseline above; the API tab reuses it as
  the OpenCode export-client mark.
- `oh-my-pi.svg` — fetched 2026-08-31 from `https://omp.sh/favicon.svg`, the Oh My Pi
  project's own favicon, unmodified. Oh My Pi is `can1357/oh-my-pi`.
- `openclaw.svg` — fetched 2026-08-31 from
  `https://raw.githubusercontent.com/openclaw/openclaw/main/ui/public/favicon.svg`,
  the OpenClaw project's own favicon, unmodified. OpenClaw is `openclaw/openclaw`.
- `deepseek-harness.svg` — fetched 2026-08-31 from
  `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/website/public/favicon.svg`,
  unmodified. DSH is first-party DeepSeek: they publish
  `deepseek-ai/deepseek-harness` and scope its packages `@deepseek-ai/dsh-*`. This is
  the harness's own mark, deliberately not the `deepseek-color.svg` provider logo.
- `prime-agent.svg` — fetched 2026-08-31 from
  `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/assets/brand/prime-butterfly.svg`,
  unmodified (it carries its authoring editor's metadata). Prime Agent is
  `PrimeIntellect-ai/prime-agent`. It has its own mark, so `pi.svg` is not reused for
  it even though Prime reads Pi's config contract.
- `zcode.svg` — fetched 2026-08-31 from
  `https://z-cdn.chatglm.cn/z-ai/static/logo.svg`, Z.ai's own logo, unmodified (it
  carries its authoring tool's generator comment).
- `kimi-color.svg` — already in the baseline as a provider icon; the API tab reuses
  it for the Kimi Code client, which is the same Moonshot AI brand.
- `aside.svg` — extracted 2026-08-31 from the installed Aside application, module
  `Contents/Frameworks/Aside Framework.framework/Versions/1.0.825.1/Libraries/AsideAgentManager/assets/official-brand-symbol-*.js`.
  It is Aside's own brand symbol, named as such by the vendor and rendered by
  Aside's onboarding, permission, and settings surfaces. The module is a compiled
  React component rather than a file, so the single 24x24 `evenodd` path was
  lifted verbatim into a standalone SVG with its original `viewBox` and its
  `currentColor` fill; no path data was redrawn. Aside does not publish this mark
  on the web (`aside.com/favicon.svg` is a 404), so the shipping application is
  the first-party source.

- `minimax.svg` — fetched 2026-08-31 from
  `https://raw.githubusercontent.com/MiniMax-AI/MiniMax-01/main/figures/minimax.svg`,
  MiniMax's own symbol as committed in their own model repository. The API-docs
  asset (`mintcdn.com/minimax-zh/.../logo/light.svg`) is the 129x32 horizontal
  lockup and was rejected: a wordmark in a 20px square is unreadable. This is the
  publisher's mark — MiniMax Code ships none of its own — used for the `mcode`
  client. Path data is verbatim; the Chinese-language `<title>` and layer-name
  metadata the authoring tool left behind are removed, and the gradient id
  `未命名的渐变_6` ("unnamed gradient 6") is renamed `minimax-wave` because a
  non-ASCII id collides awkwardly across inlined documents.

Two marks are TRACED rather than fetched. Their vendors publish no usable
vector, and a trace that follows the source pixels is a truer mark than a
monogram. What is still refused either way: a horizontal wordmark squeezed into
this square slot, and a full-frame silhouette plate that renders as a filled box
at 20px.

- `hermes-agent.svg` — traced 2026-08-31 from
  `NousResearch/hermes-agent` `apps/desktop/assets/icon.png` (574273 bytes,
  1024x1024 RGBA), the icon the Hermes desktop application itself ships, so this
  is the product's own mark. Two earlier candidates were rejected:
  `website/static/img/favicon.svg` is 113 bytes and its entire body is one
  `<text>` element with no path data, and `nousresearch.com/safari-pinned-tab.svg`
  opens with the full 512-unit frame as its first path, so it renders as a black
  square. Traced with
  `potrace -s --flat --turdsize 8 --alphamax 1.0 --opttolerance 0.2` over the
  mask `alpha > 128 AND mean(rgb) < 110`, which keeps the black artwork and
  discards the light plate behind it. One path, `currentColor`, squared to
  `viewBox="0 0 823 823"` by centering the 823x806 trace. Named
  `hermes-agent` rather than `hermes` because Hermes is also a provider name
  and this directory is one flat namespace.
- `gajae-code.svg` — traced 2026-08-31 from `Yeachan-Heo/gajae-code`
  `assets/character.png` (3190496 bytes, 1550x2048 RGBA), the mascot. No SVG
  exists upstream: `assets/` and `docs/` hold only raster, `public/` is a 404,
  the five plausible `logo.svg`/`favicon.svg` paths all 404, no published
  `@gajae-code/*` tarball at 0.15.6 contains one, and `docs/brand-assets.md`
  lists the marks as PNG. The source is a vertical lockup, so only the mascot is
  traced — rows 1650-1682 are fully transparent, which is the seam the crop uses,
  and the `gajae-code` wordmark below it is discarded. The artwork is upscaled
  pixel art, so tracing at source resolution followed every staircase and gave a
  1.3 MB file; downsampling to a 128px box (Lanczos, then a 0.6px Gaussian)
  first gives ~31 KB. Seven color layers, k-means++ seeded at 3 so the
  quantization is deterministic, painted largest-area first. The smallest layer
  is 292 px and a fixed area floor would have dropped it — it is the visor
  green, which is the feature that makes the character recognizable, so the
  floor is a fraction of the opaque area instead.

## How a mark is painted

Provenance is not the only fact that has to survive a handoff. Every mark is
drawn one of two ways, and picking wrong makes a logo vanish rather than look
slightly off:

- **image** — the `<svg>` is rendered as-is, keeping its own colors. Correct for
  anything multi-color, and for a single ink that *is* the brand.
- **mask** — the file is used as a shape and filled with the surrounding text
  color, so it follows the theme. Correct for a neutral silhouette, which would
  otherwise be invisible against one of the two surfaces.

The set lives in `gui/src/components/integration-marks.ts`. It is derived from
`MONOCHROME_CLIENT_MARKS` for export clients, plus `MASKED_NATIVE_MARKS` for rows
that have no export client to be keyed by.

Decisions that are not obvious from looking at the file:

- `grok.svg` **is masked.** One `#000000` fill on transparency measured about
  1.9:1 on the dark card surface (`rgb(48,48,48)`) — effectively gone. Masking
  does not modify xAI's file; it reads it as a shape, which is how xAI renders it
  on their own dark surfaces. 11.17:1 dark and 17.67:1 light afterwards.
- `openai.svg` **is not masked**, despite also being a single fill. That fill is
  #10A37F, OpenAI's brand green, and repainting it discards information a reader
  uses to identify the mark. Neutrality is the test, not ink count.
- `deepseek-harness.svg` **is not masked** for the same reason: #4d6bfe is
  DeepSeek blue. Its dark-theme contrast is adequate; if it ever is not, the fix
  is a surface change, not a repaint.
- `hermes-agent.svg` **is masked.** The trace is one near-black path, so it is
  invisible on `#0d1117` untinted. Nothing about the Hermes brand is carried by
  that particular black.
- `minimax.svg` and `gajae-code.svg` **are not masked.** A gradient wave and a
  seven-layer mascot respectively; masking would flatten both to one ink.
- `prime-agent.svg` **is masked.** White on transparency, so as an image it was
  invisible in light mode. This one shipped broken.
- `opencode.svg` (#211E1E) and `kimi-color.svg` (#1A1A1A) **are masked.** Both
  near-black single inks, invisible in dark mode as images. Both shipped broken
  too, which is what established the rule.
- `aside.svg` **is masked.** It already paints with `currentColor`, so it would
  follow the theme either way; masking keeps it consistent with the other
  silhouettes rather than depending on inherited color.

Both directions are enforced in `gui/tests/integration-marks.test.ts`, including a
luminance check that fails any single-ink near-neutral mark left as an image. That
direction was missing until it caught `grok`; the same class of defect had already
shipped once for `prime`, `opencode` and `kimi`.
