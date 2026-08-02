# 000 — docs overhaul: docs-site expansion + README compact rewrite

Unit status: **docs-only roadmap cycle**. No production code changes in this unit's
first cycle. Implementation starts at the NEXT loop run, one work-phase per decade
doc (`010`–`060`).

## Objective

The docs-site developer documentation is stale (version pins at v2.7.1/v2.7.2 while
the package is at 2.8.0), several pages are too long to navigate
(`reference/configuration.md` 7,387 words, `reference/cli.md` 4,509 words), and
headline features — combos, the sub-agent v1/base/v2 surface, the proxy wire
formats — have no dedicated beginner-friendly deep documentation. This unit records,
at diff-level precision, the full expansion plan so each later cycle executes one
decade doc without re-doing the research.

User-visible outcome:

1. A compact README whose quick start has two explicit paths — human
   (`ocx start` or `ocx service`, then configure at `http://localhost:10100`) and
   agent (`ocx start` or `ocx service`, then `ocx init`) — plus a mandatory
   star-prompt consent note for agents.
2. A restructured docs-site with new detailed pages: `getting-started/for-agents`,
   `guides/combos`, `reference/proxy-formats`, `reference/management-api`, split
   configuration and CLI references, and a beginner-restructured sub-agent guide.
3. Locale trees (ko, ja, ru, zh-cn) synced so no translated page contradicts the
   English source.

## Evidence base

Three parallel read-only explorer lanes plus direct reads, all against branch `dev`
(clean except pre-existing untracked `devlog/_fin/260724_release_v2_7_39/` and
`devlog/_plan/260724_gpt_live_hotfix/`, which this unit does not touch):

- `001` — docs-site inventory (30 English pages, staleness, locale parity, nav gaps).
- `002` — feature-surface inventory from `src/**` with path:line anchors (combos,
  sub-agent surfaces, wire formats, management API, CLI, star-prompt contract).
- `003` — README audit (per-section keep/compress/drop/move judgments + CLI ground
  truth).

Direct verification performed in this cycle:

- `package.json:3` — version `2.8.0` (docs pins at v2.7.1/v2.7.2 are stale).
- `package.json:40-42` — `test`, `typecheck`, `privacy:scan` scripts exist.
- Baseline docs build: `cd docs-site && bun install --frozen-lockfile && bun run
  build` → exit 0, 151 pages (2026-08-02). Missing locale sources are rendered by
  Starlight's fallback as English content under the locale route (e.g.
  `/ko/guides/grok-build/`), so locale gaps are a content-quality issue, not a build
  break.
- Bare `bun` is not on this Mac's PATH; use the checkout's `node_modules/.bin/bun`
  for every docs-site and root gate.

## Headline findings

1. `reference/configuration.md` (7,387 words) and `reference/cli.md` (4,509 words)
   are the two monoliths; both split into domain subpages with the original page
   kept as an overview hub (slugs stay stable — Starlight emits no redirects).
2. Three overlapping catalog/sub-agent explanations live in
   `guides/codex-integration.md`, `guides/codex-app-models.md`, and
   `guides/sub-agent-surface.md`; the rewrite assigns each a single owner topic and
   cross-links instead of repeating.
3. `guides/image-bridge.md` and `guides/video-bridge.md` exist but are absent from
   the configured sidebar; `Header.astro` and `Landing.astro` maintain divergent
   hand-written nav maps.
4. All four locale trees miss the same six pages; `docs-site/src/data/README-frontier.md`
   still says "three locales" while the site ships five.
5. README is 573 lines and re-explains reference material the docs site owns; the
   quick start lacks the agent path and the star-prompt consent note.

## Scope

IN: `docs-site/**` (content, sidebar config, Header/Landing nav), `README.md`,
`readme/README.{ko,zh-CN,ru,ja}.md` (changed-section sync only), `devlog/` records.

OUT: `src/`, `gui/`, `tests/` runtime changes; new dependencies; pushing to any
remote; release automation; benchmark data refresh (`frontier-benchmarks.json` is a
hand-maintained dataset with its own procedure — out of scope).

## Interpretation note

The request's "3d proxy 형식" has no literal counterpart in the codebase (searched
`3d proxy`, `proxy format`, `proxy 형식`). It is interpreted as the proxy's API
**wire formats** — `/v1/responses` (JSON/SSE/WebSocket), `/v1/chat/completions`,
`/v1/messages`, `/v1/models` flavors, `/v1/live` + realtime sideband,
`/v1/responses/compact` — which get the new `reference/proxy-formats.md` deep doc.

## Work-phase map (dependency-ordered, one decade doc per phase)

| Decade | Work-phase | Depends on | Summary |
|--------|-----------|------------|---------|
| `010` | WP2 README compact rewrite | — | Compact README with human/agent/star-prompt quick start |
| `020` | WP3 docs-site IA foundation | — | Sidebar/nav restructure, new nav slots, orphan fix |
| `030` | WP4 new feature docs (English) | `020` | for-agents, combos, proxy-formats, management-api |
| `040` | WP5 restructure & splits (English) | `020` | config + CLI splits, sub-agent restructure, dedupe, pin refresh |
| `050` | WP6 locale sync | `030`, `040` | ko/ja/ru/zh-cn ports, README translations, frontier README fix |
| `060` | WP7 verification & close-out | `030`–`050` | All gates fresh, render smoke, D summary |

Ordering is structural, not effort-based: `020` creates the navigation slots every
new page needs; `030`/`040` fill them in parallel-safe disjoint file sets; `050`
translates only settled English; `060` gates everything last.

## Verification commands (proven to exist and read the target)

| Gate | Command | Proof it reads the target |
|------|---------|---------------------------|
| Docs build | `cd docs-site && bun run build` | Baseline run exit 0, builds every page under `docs-site/src/content/docs/` (151 pages) |
| Typecheck | `bun run typecheck` | `package.json:41`; repo TS gate |
| Privacy scan | `bun run privacy:scan` | `package.json:42`; reads devlog/ and docs per AGENTS.md |
| Repo tests | `bun run test` | `package.json:40`; `tests/repo-hygiene.test.ts` guards devlog/gitlink invariants this unit touches |

Docs-only cycles substitute docs consistency checks for code gates where a gate
does not read prose; `060` runs the full set fresh.

## Resource bounds (HOTL)

Local file edits only inside the IN scope; no network writes; no push; subagents
run `gpt-5.6-sol` with `reasoning_effort: medium`, max 3 concurrent; disjoint write
scopes per lane; wall-clock bounded by the host session.

## Terminal outcomes

`DONE` — all decade docs executed, gates green. `NOOP` / `BLOCKED` / `UNSAFE` /
`NEEDS_HUMAN` / `BUDGET_EXHAUSTED` reported with evidence if reached instead.
