# 020 — WP3: docs-site IA foundation (sidebar + nav)

Work-phase: `wp3-ia-foundation`. Depends on: nothing (but lands before `030`/`040`
because those need the nav slots). Execute as one full PABCD cycle.

## File change map

| Path | Action |
|------|--------|
| `docs-site/astro.config.mjs` | MODIFY — sidebar restructure |
| `docs-site/src/components/Header.astro` | MODIFY — sync nav map to sidebar |
| `docs-site/src/components/Landing.astro` | MODIFY — sync nav map to sidebar |

Slug policy (STRICT): every existing slug stays stable. New pages from `030`/`040`
get new slugs; nothing is renamed. Starlight emits no redirects, and edit links +
external bookmarks point at current slugs.

## Sidebar target structure

1. **Getting Started** — Installation, Quickstart, How It Works, **For Agents**
   (new slot `getting-started/for-agents`; page arrives in `030` — add the sidebar
   entry in THIS phase but only together with a minimal placeholder-free approach:
   add the entry in `030` alongside the page instead. THIS phase adds only slots
   whose pages already exist). Decision: sidebar entries land WITH their pages;
   `020` ships the restructure for existing pages only.
2. **Guides** — Providers, Model Routing, Model Ordering, Codex Integration,
   Codex App Model Picker, Claude Code, Grok Build, opencode, Pi,
   Sidecars: Web Search & Vision, **Image Bridge** (orphan fix), **Video Bridge**
   (orphan fix), Web Dashboard, Sub-agent Surface.
3. **Benchmarks** — unchanged (collapsed).
4. **Reference** — CLI, Configuration, Adapters, Architecture.
5. **Troubleshooting** — unchanged (collapsed).
6. **Contributing** — unchanged.

Every new label carries all four locale `translations` entries, matching the
existing pattern in `astro.config.mjs`.

## Header.astro / Landing.astro sync

- Header.astro: add the missing destinations to its hand-written nav (or trim it
  to the same top-level set as the sidebar — decide at build time by reading the
  component; the invariant is: no dead nav entry, no sidebar-advertised page
  missing from the header nav intent).
- Landing.astro: same sync for its nav map.
- No locale-switching logic change in this phase (the fallback guard is `050` —
  actually re-evaluated: locale fallback rendering works via Starlight, so no code
  change is needed anywhere; `050` drops that task and documents the decision).

## Acceptance criteria

- `rg -n "image-bridge|video-bridge" docs-site/astro.config.mjs` — both present.
- `cd docs-site && bun run build` exit 0; sidebar renders the two bridge pages
  under Guides.
- Header/Landing nav contains no href that 404s (spot-check with the build's
  route list).

## Verification

Fresh `cd docs-site && bun install --frozen-lockfile && bun run build` (baseline
proven exit 0 in `000`) + route-list diff showing the two new Guide routes.
