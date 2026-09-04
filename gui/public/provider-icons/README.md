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

## Provider marks (2026-09-01)

Sourced for the providers that were rendering a coloured initial tile. Every
entry below was fetched from the vendor's own domain, taken from the registry's
`baseUrl`/`dashboardUrl` rather than guessed.

Published as SVG and committed with only comments, `<title>`/`<desc>` and
`data-name` attributes stripped:

- `digitalocean.svg` — `digitalocean.com` favicon, 32x32.
- `featherless.svg` — `featherless.ai/favicon.svg`, 256x256.
- `kilo.svg` — `kilo.ai/favicon/favicon.svg`, 32x32. Keeps its `oklch()` plate.
- `nanogpt.svg` — `nano-gpt.com/logo.svg`, 181x187, gradient.
- `nebius.svg` — `nebius.com/favicon/favicon.svg`, 96x96.
- `neuralwatt.svg` — the site's Webflow-hosted brand asset, 32x32.
- `parallel.svg` — `parallel.ai/icon.svg`, 96x96.
- `scaleway.svg` — `scaleway.com/favicon/website/favicon.svg`, 16x16.
- `synthetic.svg` — `synthetic.new/favicon.svg`, 54x54.
- `zai.svg` — `z-cdn.chatglm.cn/z-ai/static/logo.svg`, 30x30.
- `zenmux.svg` — the site's CDN-hosted brand mark, 160x160.

Traced from raster, because the vendor publishes no square SVG mark. Same
technique as `hermes-agent.svg` and `gajae-code.svg`: `potrace -s --flat` for a
single-ink silhouette, k-means colour layers (seeded at 3, largest area first)
for multi-colour art, downsampled to a 160px box first so the trace does not
follow every upscaled pixel edge.

- `cerebras.svg`, `novita.svg`, `siliconflow.svg`, `deepinfra.svg` — single-ink.
- `baseten.svg`, `hyperbolic.svg`, `sambanova.svg`, `umans.svg`, `venice.svg`,
  `vultr.svg`, `bizrouter.svg`, `orcarouter.svg` — colour-layered.
- `nous.svg` — traced from `nousresearch.com/apple-touch-icon.png` (180x180). This
  is the Nous Research company mark, distinct from `hermes-agent.svg`, which is
  the Hermes product's own icon. Attributing one to the other would be wrong even
  though the same organization ships both.

Found on a docs subdomain after the vendor's marketing site offered only a
wordmark:

- `together.svg` — `docs.together.ai/favicon.svg`, 1.07:1.
- `litellm.svg` — `docs.litellm.ai/img/logo.svg`, 1:1. The marketing site's SVGs
  are third-party model logos, not LiteLLM's own mark.

**The plate problem, recorded because the first pass shipped it.** A favicon is
usually a glyph on a filled rounded square. Tracing luminance alone captured the
square and produced a solid box: `baseten` came out 97.7% ink, `bizrouter` 89.3%.
The fix reads the border ring, takes its median colour as the plate when the ring
is uniform, and masks by distance from that colour instead of by darkness. It
found real plates behind `baseten` (#19e76e), `cerebras` (#ef5b27), `hyperbolic`
(#1a1a1a), `umans`/`bizrouter` (#000000) and `orcarouter` (#ffffff).

### Rejected, and why

- **`nousresearch.com/safari-pinned-tab.svg`** — opens with the full 512-unit
  frame as its first path, so it renders as a black square. This is the identical
  candidate the Hermes client mark rejected. The apple-touch-icon was used instead.
- **LiteLLM's marketing-site SVGs** — third-party model logos, and the favicon
  traces to a muddy blob with no legible silhouette at 19px. The docs logo was
  used instead.
- **Wordmarks refused** for `cerebras` (843x320 from Sanity CDN), `siliconflow`
  (188x28), `zhipu-bigmodel` (123x25), `vultr` (218x52), `baseten` (1001x151) and
  `chutes` (192x30). A lockup in the rail's 19px box is an illegible smear, so
  each was replaced by a traced square mark or left to the fallback.

### Still unmarked, and what was searched

Six ids keep the fallback tile. Each was probed at its registry `baseUrl` and
`dashboardUrl`, plus the vendor's docs subdomain and the conventional icon paths
(`/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`, `/logo.svg`, `/icon.svg`):

- `chutes` — `chutes.ai` and `docs.chutes.ai` serve only the 192x30 wordmark.
- `nscale` — `nscale.com` and `docs.nscale.com` returned no icon at any path.
- `volcengine`, `volcengine-coding-plan`, `volcengine-agent-plan` — the Ark
  console's SVGs are UI glyphs rather than a product mark.
- `tencent-coding-plan` — `cloud.tencent.com` serves a 32x32 favicon whose trace
  is unreadable at 19px.

These are recorded results, not skipped work. Inventing a mark, or borrowing a
neighbouring brand's, is a misattribution that outlives the commit.

`zhipu-bigmodel` and `zhipu-bigmodel-coding` share `zai.svg`: Z.AI and BigModel
are the same company, and the mainland console publishes only the wordmark.

## Meta (2026-09-03)

- `meta.svg` — the `aria-label="Meta symbol"` inline SVG that `dev.meta.ai`
  renders in its own navigation header, read 2026-09-03 through a signed-in
  browser session. Meta publishes no square vector at the conventional paths:
  `dev.meta.ai/favicon.svg`, `/icon.svg` and `/logo.svg` all 404, and the
  site's declared icon is a 32x32 `.ico` on `static.xx.fbcdn.net`. The rendered
  header mark is therefore the first-party vector, taken from the developer
  console the two providers actually belong to.

  Path data and gradient stops are verbatim. Three normalizations: React's
  generated gradient ids (`_r_d_`, `_r_e_`, `_r_f_`) become
  `meta-mark-a/-b/-c`, because a generated id collides when several marks are
  inlined into one document — the same reason `minimax.svg` renamed its
  `未命名的渐变_6`; the presentational `height`/`width`/`role`/`aria-label`
  are dropped in favour of the `viewBox`; and `xmlns` is added so the file
  stands alone.

  Wired to both `meta-model` (the direct Meta Model API provider) and
  `meta-muse` (the Muse Code credential import). One brand, two credentials —
  the same shape as the three Alibaba ids sharing `alibaba-color.svg`.
  **Not masked:** three linear gradients in Meta brand blue
  (#0064E0 -> #0278F1), and masking flattens a gradient to a single ink.
