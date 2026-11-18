# 040 — Telemetry guide and configuration reference

Stack layer 5. Lands before the dashboard (050) because the dashboard links to this guide and the
docs build rejects links to missing pages.

## Privacy statement (lands in layer 2, not here)

The project's published privacy statement must stop saying that nothing is sent before the first
layer that can send merges, so these files change in layer 2 (060 D12) and layer 5 only links them to
the guide:

- `README.md` (Code signing policy → Privacy) and the same line in `readme/README.fr.md`,
  `README.ja.md`, `README.ko.md`, `README.ru.md`, `README.tr.md`, `README.zh-CN.md` and
  `README.zh-TW.md`, with `readme/i18n-manifest.json` refreshed.
- `docs-site/src/content/docs/reference/code-signing.md` and its Turkish copy
  `docs-site/src/content/docs/tr/reference/code-signing.md` (the Privacy section, including the
  "carry none of your … usage data" sentence).
- `SPONSORS.md` ("opencodex does not collect any" telemetry).

The statement replaces SignPath's "will not transfer any information …" sentence, which SignPath
allows only as an alternative to linking a privacy policy. How the stack meets SignPath's
install-time conditions is recorded in 060 ("SignPath conditions", D21); layer 2b adds the Windows
installer option to these files.

## Public docs

- `docs-site/src/content/docs/guides/telemetry.md` (English source): what is collected, what is never
  collected, default-on with "nothing is sent until a person has seen the notice", agent-driven starts
  never enable it, how to turn it off (GUI popup, Proxy details toggle, `ocx telemetry disable`,
  `OCX_TELEMETRY=0`, `DO_NOT_TRACK=1`), how to see the exact payload (`ocx telemetry status --json`,
  "What is sent"), storage and retention (daily aggregates, install hash rotates daily, no IPs), and
  the collector source location. No link to `/dashboard` yet (050 adds it).
- `docs-site/astro.config.mjs`: add `guides/telemetry` to the Guides sidebar.
- `docs-site/src/content/docs/reference/configuration/server.md`: `telemetry` config block and the
  two environment variables.
- `guides/web-dashboard.md`: one line pointing to the Proxy details telemetry toggle.
- Translated locales follow the docs-site locale rule (translated or absent with English fallback);
  nothing may contradict the English page.

## Maintainer docs

`structure/telemetry.md` (from 010) gains the collector location (`services/telemetry-collector/`,
now present) and the guide path.

## Verification

docs-site build (`cd docs-site && bun install --frozen-lockfile && bun run build`),
`tests/ci-workflows/docs-link-targets.test.ts` and the other `docs-*` claim guards,
`bun run structure:check`, `bun run privacy:scan`.

