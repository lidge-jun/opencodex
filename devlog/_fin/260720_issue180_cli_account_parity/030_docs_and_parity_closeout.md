# 030 — Phase 3: docs updates + parity closeout (diff-level design)

The issue asks for CLI-reference and Providers docs to document the new
commands. This phase lands the docs and closes the loop's evidence ledger.

## Outcome

`ocx account` is documented everywhere the repo documents CLI commands, in all
three locales, and the parity matrix in `004` is marked with the delivered
state.

## Scope boundary

IN: docs-site reference + guides below, this devlog unit, goalplan/ledger.
OUT: code changes, README rewrites beyond the check below, release notes.

## File change map (P re-verifies each target's current shape)

### MODIFY `docs-site/src/content/docs/reference/cli.md` (+ `ko/`, `zh-cn/`)

- Add an `ocx account` section after the `ocx provider`/`ocx models` entries
  (exact anchor re-verified at P): subcommands list/current/use (010) and
  refresh/auto-switch/remove/add-key (020), each with usage, behavior, exit
  codes, `--json` shapes, and the codex "new sessions only" note.
- Mirror structure of the existing `ocx provider` section; keep the locale
  files structurally identical (headings translated, commands verbatim).

### MODIFY `docs-site/src/content/docs/guides/providers.md` (+ `ko/`, `zh-cn/`)

- Add a short "Switching accounts from the terminal" pointer block naming the
  three commands and linking the CLI reference (the guides already describe
  multi-account GUI flows — cross-link instead of duplicating).

### CHECK (modify only if the convention holds)

- `README.md` / `README.ko.md` / `README.zh-CN.md`: if they carry a CLI command
  table/list, add the one `ocx account` row; if they only deep-link the docs
  site, leave untouched and record the decision here.
- SoT sync (SOT-SYNC-01): check `structure/` and `docs/` for a CLI-surface or
  architecture doc that enumerates commands; patch it or record its absence.

### MODIFY this unit

- `004_parity_matrix.md`: flip delivered rows from "gap" to "full (010/020)"
  with the verifying command evidence paths.
- `999_closeout.md` (new, next free index): final D summary across work-phases
  — delivered surface, evidence pointers, residual candidates (browser add/
  reauth flows, reset-credit consume, failover threshold, args-helper dedupe).

## Accept criteria

1. `rg -n "ocx account" docs-site/src/content/docs/reference/cli.md
   docs-site/src/content/docs/ko/reference/cli.md
   docs-site/src/content/docs/zh-cn/reference/cli.md` hits in all three.
2. Docs-site content builds (repo-standard check, e.g. astro build or the
   docs lint the repo already runs — re-verify the exact script at P).
3. `004` matrix shows no "gap" rows left in the issue #180 account domain
   (candidate rows remain marked OUT by design).
4. Goalplan criteria `c-docs-updated` and `c-survey-matrix` carry fresh
   capturedEvidence; `cxc loop validate` passes E8 for the whole plan.
