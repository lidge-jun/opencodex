# 010 wp2 — link integrity

Two layers, because CI reaches the two kinds of source through different jobs. The `ci` change filter
(`.github/workflows/ci.yml:225-243`) matches `README.md`, `src/**`, `gui/**`, `tests/**` but not
`docs-site/**`; a docs-only pull request runs only the `docs` job, which builds the Astro site
(`ci.yml:261-274,993-1014`). A Bun test alone would never see a docs-only PR, so the docs-site check lives
inside the Astro build, and the Bun test covers the URLs other surfaces hard-code.

## Link repairs

MODIFY `docs-site/src/content/docs/guides/desktop-app.md:104`

```diff
-[macOS Menu Bar App guide](/opencodex/guides/macos-menu-bar/) for widget setup and the
+[macOS Menu Bar App guide](/guides/macos-menu-bar/) for widget setup and the
```

MODIFY `docs-site/src/content/docs/reference/configuration/server.md:717-719`: the three
`../../guides/codex-integration.md#<frag>` links become `/guides/codex-integration/#<frag>`, same fragments
(headings at `guides/codex-integration.md:968,1092,1129`). Same rewrite in any locale copy carrying the
`.md` form (grep `codex-integration.md#` under `docs-site/src/content/docs`), with that locale's prefix.

Any further break the new build check reports on the current corpus is fixed in the same commit and
listed in the commit body.

## Layer A: build-time check (docs-site)

NEW `docs-site/src/integrations/internal-links.mjs` (plain ESM, no dependency): an Astro integration with an
`astro:build:done` hook that receives `dir` (the output URL).

- Walk every `*.html` under the output dir. For each page collect `id="…"` values and every
  `href="…"` / `src="…"`. Resolve each with `new URL(value, pageUrl)`, where `pageUrl` is
  `https://opencodex.me/<page dir>/` (the URL Starlight's own nav and sitemap use). The result is internal
  when its host is `opencodex.me`, or `lidge-jun.github.io` with a leading `/opencodex` segment, which is
  stripped once for that host only (GitHub's redirect does the same). Skip other hosts, `mailto:`,
  `data:`, `/_astro/`, `/pagefind/`. Relative links and fragment-only `#frag` (same page) are checked.
- On the generated `404.html` only, skip unresolvable links whose path is `/<locale>/404/`: Starlight's
  language picker there points at locale 404 pages it never builds (measured: 14 such links on dev
  a4bdc03054). Every other link on the 404 page, and picker links on ordinary pages, stay checked.
- Resolve a path: strip query; decode; if the path names an existing file in dist, it resolves;
  else try `<path>/index.html` (with or without the trailing slash, matching `trailingSlash: "ignore"` at
  `astro.config.mjs:18`), else `<path>.html`. No match is a broken link.
- Fragment: when the link carries `#frag` and resolves to an HTML page, `frag` (decoded) must be one of
  that page's ids. These are the rendered Starlight heading ids, so no slugger is reimplemented.
- Report as `page → href` lines. Broken routes and broken fragments both throw and fail the build.
  There is no global fragment switch and no allowlist.

## Pre-existing failures (measured, see [001](001_existing_link_failures.md))

A scratch scan of the current build found 106 unique failures (the 404-page picker excluded): 5 route
breaks and 11 fragment breaks in English sources, about 90 fragment breaks in locale sources. Most come
from the configuration reference split into subpages (`/reference/configuration/#remote-access` now lives
on `/reference/configuration/server/`) and translated headings whose slugs changed. All are fixed in this
commit so Layer A can throw on the first build:

- English sources (`guides/{claude-code,codex-integration,desktop-app,opencode,pi,providers,sidecars}.md`,
  `reference/cli/agents.md`, `reference/configuration/{providers,server}.md`): main fixes each by finding
  the heading's current page and slug in the rendered build.
- Each locale's rows: one gpt-6-sol worker per locale, write scope = the listed source files in
  `docs-site/src/content/docs/<locale>/`, rule = point the link at the rendered id that now carries that
  heading (in the same locale when the target page exists there, else the fallback page's English id);
  never delete a link to silence it. When the fragment names prose with no heading (for example
  `guides/claude-code.md` `#mcp-tool-schemas-fill-the-context-on-turn-one` points at bold text), link the
  nearest enclosing heading's id. Workers run no builds; main rebuilds once after all return.
- Link ledger (audit round 3): before and after the repair, main's scratch script records per edited source
  file the ordered list of Markdown link texts and the count of links; the two lists must be equal, only
  hrefs may differ, and every row of 001 must map to a changed href whose new target resolves in the rebuilt
  dist. A shrunken list fails the phase.
- `.github/ISSUE_TEMPLATE/documentation.yml:31` placeholder `https://opencodex.me/providers/` is broken. Open PR
  #5593 changes that line to
  `"https://opencodex.me/guides/providers/ or docs-site/src/content/docs/guides/providers.md"`; this commit
  makes the byte-identical change so either merge order is clean, and Layer B scans
  `.github/ISSUE_TEMPLATE/`.
- Export the pure resolver (`resolveInternalLink(distFiles, idsByPage, fromPage, href)`) so the Bun test
  can exercise it with fixtures without building.

MODIFY `docs-site/astro.config.mjs`: import the integration and append it to `integrations` after
`starlight(...)`.

Bypass record (PLAN-BYPASS-NAMED-01): tier E8 (out-of-band build gate). Executing surface: the Astro
build, run by the CI `docs` job on every pull request touching `docs-site/**` and by `deploy-docs.yml`
before publishing. Known bypasses: links assembled by client-side JavaScript, links to other hosts, a
maintainer merging over a red `docs` check, and editing the integration out of `astro.config.mjs`.
Residual risk: broken external links and client-rendered links. Wording: "checked at build time" for
hrefs and srcs present in the generated HTML, not "every link". Final layer: the Deploy Docs build,
which refuses to publish a site with a broken internal link.

## Layer B: Bun test (hard-coded URLs elsewhere)

NEW `tests/ci-workflows/docs-link-targets.test.ts` (target under 300 lines; new-file threshold 2000):

- Route table from `docs-site/src/content/docs/**/*.md[x]`: path minus extension, `index` collapses to its
  directory, lowercased. Locale keys parsed from the `locales: {…}` block of `docs-site/astro.config.mjs`
  (root excluded). `<locale>/<rest>` with `<rest>` in the table resolves as a Starlight fallback page.
  For `lidge-jun.github.io` the leading `/opencodex` project segment is stripped once (redirect
  semantics); on `opencodex.me` a leading `opencodex/` is never stripped. Files under `docs-site/public`
  resolve as assets.
- URL surfaces: `README.md`, `readme/*.md`, root `*.md`, `package.json`, `src/**`, `gui/src/**`,
  `skills/**`, `docs-site/src/components/**`, for `https://opencodex.me/<path>` and
  `https://lidge-jun.github.io/opencodex/<path>`. Template-literal paths and sitemap/robots/image URLs are
  skipped.
- Fragments on these URLs are not checked here: only the rendered pages carry the real ids. C runs a
  one-off scratch audit of every such `#frag` against `docs-site/dist` and fixes what it finds; after
  that, a fragment-only regression in a README is not guarded (stated limit).
- Tests: (1) every URL resolves, failure lists `file:line url`; (2) fixtures for the Layer A resolver
  imported from `docs-site/src/integrations/internal-links.mjs`: `/opencodex/guides/macos-menu-bar/`
  broken, `/guides/macos-menu-bar/` and `/guides/macos-menu-bar` resolve, `/guides/x/#missing` broken
  fragment, same-page `#missing` broken, relative `../../guides/codex-integration.md` from
  `/reference/configuration/server/` broken, `https://opencodex.me/guides/macos-menu-bar/` internal and
  resolving, `/favicon.png` asset; (3) route-table fixtures: `/ko/guides/desktop-app/` resolves (file or
  fallback), `https://opencodex.me/opencodex/guides/x/` broken,
  `https://lidge-jun.github.io/opencodex/guides/cursor-private-inference/` resolves; (4) sanity: the scan
  finds more than 20 URLs so an empty extractor fails.

Layer B bypass record: tier E8 (CI suite). Executing surface: the Bun test shards, which the `ci` filter
starts for `README.md`, `src/**`, `gui/**`, `tests/**`, `package.json`. Known bypasses: `readme/**` and
`skills/**` are not in that filter, so a PR touching only those skips it; fragments are not checked.
Residual risk: a broken URL in a locale README or skill lands and is caught on the next run that does
start the suite. Wording: "guarded in the CI suite". Final layer: none beyond the suite.

MODIFY `scripts/test-layout/layout.json` explicit map and `tests/fixtures/test-layout-expected.json`: add
`"docs-link-targets.test.ts": "ci-workflows"` beside `docs-readme-translation-parity.test.ts`.

## Structure doc

MODIFY `structure/ops/docs-and-release.md` "Public docs": the locale sentence lists all seven locales (adds
French `/fr` and Turkish `/tr`, matching `astro.config.mjs:61-72`); one paragraph names both layers and
their limits. No manifest or `INV-*` binding is added (`structure/AGENTS.md:98-102` owns that mechanism
and this unit makes no invariant claim).

## Acceptance

- `cd docs-site && bun run build` exit 0 with the integration active, and it reports the number of pages
  and links checked.
- Driven red, Layer A: revert desktop-app.md:104 locally; the build fails naming
  `/guides/desktop-app/ → /opencodex/guides/macos-menu-bar/`; restore.
- Driven red, Layer B: add `https://opencodex.me/opencodex/guides/x/` to a scratch copy path the scanner
  reads (temporary edit to README.md, reverted); test (1) fails; restore.
- `bun test tests/ci-workflows/docs-link-targets.test.ts` run alone exits 0 and its output lists at
  least four `(pass)` lines from this file; then
  `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` and `bun run structure:check` exit 0.
- Driven red, fragment: a scratch edit adding `[x](#does-not-exist)` to one English page fails the build;
  reverted.
- Commit: `docs: repair stale docs links and check every internal link at build time`.
