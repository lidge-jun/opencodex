# 010 — Work-phase plan

## wp1 — audit (this cycle, docs and evidence only)

Parallel read-only design audits, one per surface, each returning findings with
severity, `path:line`, and screenshot path:

1. Sidebar IA and foot controls (#6579, #6593 rows): routes, active state, collapse,
   drawer, keyboard order, aria, desktop UA variants, zoom, widths (including the
   759/760/761px drawer boundary and short window heights, where the foot must stay
   reachable per `gui/design-system/components.md`), contrast, reduced motion, locales.
   Filled selection applies to the theme switch only; nav icons stay outline.
2. Connect tabs and the one-page Claude Code settings (#6593, #6596): tab strip,
   Save bar states (dirty draft across tab hops, refresh and remount, the immediate
   switches, in-flight edits, failed save, Revert, sticky bar overlap with content),
   empty/error states, disabled controls, console errors, widths, themes, locales.
3. Section switcher, legacy redirects and deep links (#6593): Usage & Logs, Remote Link,
   `#claude/account` landing on Anthropic's Accounts tab while plain Providers keeps the
   whole workspace, `#claude/settings`, protocol deep links, focus recovery when Remote
   Workspace drops out of the switcher.
4. Locale completeness and truncation for every key these PRs added or changed
   (static diff of the eleven catalogs plus render in long locales), including #6522.
5a. DSH (#6522): rendered integration panel, `integration-api.ts` plan-path allowlist
   accepting the profile patch path and the legacy path, and the semantics text.
5. Claude Desktop (#6596): report-only, for lane R3.
6. Docs-site pages these PRs changed versus the shipped UI.

Main synthesizes findings into `020_findings.md` (P0–P3, evidence), deduplicated and
verified against the source before any fix.

## wp2 — fixes

P0–P2 findings outside R3's files and outside #6597's files are fixed on
`codex/r4-gui-audit` (or split by surface if they are independent), with before/after
screenshots from the same sandbox. Static gates: `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, `bun scripts/file-size-ratchet.ts`, `bun run structure:check`,
`bun run privacy:scan`. Merge evidence is hosted CI plus a full-matrix dispatch at the
exact head. Locale catalogs only gain keys (coordinator rule for this train): a clipped label is
fixed by layout or by a new, shorter key; a wrong existing translation is reported
rather than edited. P3s and R3 findings are reported to the
coordinator.
