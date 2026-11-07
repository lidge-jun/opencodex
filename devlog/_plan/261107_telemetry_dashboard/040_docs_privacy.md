# 040 — Telemetry guide and configuration reference

Stack layer 5. Lands before the dashboard (050) because the dashboard links to this guide and the
docs build rejects links to missing pages.

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

