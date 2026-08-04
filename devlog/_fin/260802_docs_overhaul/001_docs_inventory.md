# 001 — docs-site inventory (research, no diffs)

Read-only inventory of `docs-site/` (Astro 7 + Starlight 0.41.1), branch `dev`,
2026-08-02. Source: explorer lane + direct reads.

## Build and config facts

- Sidebar is configured in `docs-site/astro.config.mjs` (`sidebar:` array); five
  sections today: Getting Started (3), Guides (12), Benchmarks (6, collapsed),
  Reference (4), Troubleshooting (1, collapsed), plus top-level Contributing.
- Locales: `root`=en, `ko`, `zh-cn`, `ru`, `ja`; `defaultLocale: "root"`. Starlight
  renders missing locale pages from the English source (confirmed by baseline
  build: `/ko/guides/grok-build/` etc. exist in `dist/`).
- Validation contract (`docs-site/AGENTS.md`): `cd docs-site && bun install
  --frozen-lockfile && bun run build` must pass; English is canonical and
  translations must not contradict it.
- Content collection: plain `docsLoader()` + `docsSchema()`, no custom frontmatter.

## English page inventory (30 pages)

Words = `wc -w`; date = last git change.

| Path | Words | Modified |
|---|---:|---|
| reference/configuration.md | 7,387 | 2026-08-01 |
| reference/cli.md | 4,509 | 2026-08-02 |
| guides/claude-code.md | 3,789 | 2026-07-30 |
| guides/providers.md | 3,073 | 2026-08-01 |
| guides/codex-integration.md | 2,592 | 2026-08-01 |
| guides/web-dashboard.md | 2,029 | 2026-08-01 |
| guides/sub-agent-surface.md | 1,601 | 2026-07-28 |
| reference/adapters.md | 1,573 | 2026-07-28 |
| contributing.md | 1,517 | 2026-08-01 |
| reference/architecture.md | 1,409 | 2026-07-26 |
| guides/codex-app-models.md | 1,276 | 2026-07-28 |
| guides/grok-build.md | 936 | 2026-07-26 |
| guides/sidecars.md | 894 | 2026-07-24 |
| troubleshooting/windows-memory.md | 887 | 2026-08-01 |
| getting-started/how-it-works.mdx | 861 | 2026-07-28 |
| guides/opencode.md | 859 | 2026-08-02 |
| guides/model-ordering.md | 793 | 2026-07-23 |
| guides/image-bridge.md | 732 | 2026-07-28 |
| guides/pi.md | 704 | 2026-08-02 |
| guides/model-routing.md | 618 | 2026-07-24 |
| getting-started/installation.md | 584 | 2026-07-24 |
| guides/video-bridge.md | 559 | 2026-07-29 |
| getting-started/quickstart.md | 530 | 2026-07-31 |
| index.mdx + benchmarks/* (7 pages) | <150 each | component-driven |

## Staleness register

- `getting-started/quickstart.md:29` — "Stable v2.7.1" (package is 2.8.0).
- `guides/codex-app-models.md:88` — "Model coverage in v2.7.1".
- `guides/providers.md:313` — "v2.7.1 fallback seed".
- `guides/sub-agent-surface.md:9` — "Since v2.7.2".
- `reference/configuration.md:9` — "Since v2.7.41".
- External-client pins to verify at rewrite time: `guides/grok-build.md:101`
  (0.2.101), `reference/cli.md:252` (Codex 0.145.0), `guides/claude-code.md:172`
  (Claude Code 2.1.129+ — still matches `src/cli/claude.ts:126`),
  `troubleshooting/windows-memory.md:13` (Bun 1.3.14 — still current).

## Overlap map (dedupe ownership decided in `040`)

- Catalog injection/sync/picker explained in BOTH `guides/codex-integration.md`
  and `guides/codex-app-models.md`.
- Sub-agent selection/effort/v1-vs-v2 explained across those two AND
  `guides/sub-agent-surface.md`.
- Provider types/auth/endpoints repeated across `guides/providers.md`,
  `reference/configuration.md`, `reference/adapters.md`.
- `guides/image-bridge.md` / `guides/video-bridge.md` share an identical skeleton.

## Navigation gaps

- `guides/image-bridge.md` and `guides/video-bridge.md` are absent from the
  `astro.config.mjs` sidebar (orphan pages).
- `src/components/Header.astro` (666 lines) and `src/components/Landing.astro`
  (368 lines) keep separate hand-written nav maps that already disagree with the
  sidebar; Header locale switching builds locale URLs without checking the target
  exists (Starlight fallback covers content, but the UX lands on untranslated
  pages silently).

## Locale parity

Each locale tree (ko/ja/ru/zh-cn) carries 24 of 30 English pages. Missing from all
four: `guides/grok-build.md`, `guides/image-bridge.md`, `guides/opencode.md`,
`guides/pi.md`, `guides/video-bridge.md`, `troubleshooting/windows-memory.md`.
The sidebar advertises those slugs in every language regardless.

## Data/component notes

- `src/data/README-frontier.md` documents a three-locale sync while the site ships
  five locales (fix in `050`).
- Benchmark leaf pages and the home page are thin MDX wrappers over
  `FrontierBoards.astro` / `Landing.astro`; no content rewrite needed there.
