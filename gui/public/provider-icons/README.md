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

Three export clients deliberately have NO mark and render a monogram instead,
because the rule is that a client without a real first-party asset gets a
monogram rather than a borrowed or unreliable one:

- `gajae` — Gajae Code (`Yeachan-Heo/gajae-code`) publishes only raster marks: a
  mascot PNG, a vertical logo PNG, and a base64 PNG favicon. Every asset here is
  SVG and a lone raster would not hold up at 20px across densities.
- `hermes` — the favicon at `NousResearch/hermes-agent` is a 113-byte SVG whose
  entire body is a `<text>` element rendering one unicode glyph. It has no path
  data, so it renders differently per machine and blank where the glyph is
  missing. It passes an automated SVG check and is still not a brand mark.
- `aside` — `aside.com/favicon.svg` is a 404 and only `favicon.ico` exists; the app
  bundle ships `app.icns`, a local macOS resource rather than a web asset.
