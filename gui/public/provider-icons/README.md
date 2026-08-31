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
