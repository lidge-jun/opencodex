# 030 — Docs, review, CI and merge (wp3)

wp3 turns the two implementation phases into merged, documented behavior. It adds no product code of its own beyond review fixes. Its job is to prove the claims in 010 and 020 with evidence that observes them, get independent reviews, and land both PRs on `dev` in order.

## Scope

| IN | OUT |
|---|---|
| Final pass on docs written in wp1/wp2: desktop guide en/ko, installation pages, structure docs; a consistency sweep of the other locales | New locales or full translations of the new sections |
| Real-shell evidence for c-1/c-2 on macOS (zsh and bash) using a temporary `HOME` | Changing the maintainer's own shell files or PATH |
| Independent code review of PR 1 and PR 2; independent security review of the rc/PATH writes and the shim launch provenance (A11) | Maintainer human review (owner instruction: admin merge) |
| Exact-head hosted CI for both PRs, rerun of a failed job once when it is a known flake | Cancelling other contributors' runs |
| Admin squash merge of PR 1, retarget and rebase of PR 2, admin squash merge of PR 2, post-merge `dev` check | Release, version bump, deploy |

## Evidence plan per criterion

| Criterion | Evidence that observes it | Where it runs |
|---|---|---|
| c-1 app-only install gets `ocx` | Rust test drives `reconcile` against a temporary `HOME` with a fake stable bundle and asserts the shim, `path.sh` and rc blocks exist; a real `zsh -l -i -c 'command -v ocx'` and `bash -l -i -c 'command -v ocx'` with that `HOME` print the shim path. Windows: pure Path transform tests in CI; native registry write is not claimed as CI evidence. | `cargo test` locally on macOS and in the `desktop shell` job (Ubuntu, bash only); the real-shell check runs locally on macOS and is recorded in 039 |
| c-2 Desktop first ahead of npm | Same real-shell check with a fake npm `ocx` directory prepended earlier in `.zshrc`/`.bashrc` (written above the block, the way nvm/bun do); expect the shim to win. A second run appends an npm prepend *after* the block, then a Desktop relaunch (reconcile) moves the block back to the end; expect the shim to win again. | local macOS, recorded in 039 |
| c-3 launcher handoff | `tests/cli/ocx-launcher-desktop-handoff.test.ts` (020) | local focused run + hosted CI |
| c-4 refusal, idempotence, cleanup | Rust tests listed in 010; `tests/clients/desktop-cli-command-surface.test.ts` | `cargo test` + hosted CI |
| c-5 gates | `bun run typecheck`, the focused test files, `cargo fmt --check`/`clippy -D warnings`/`test`, `bun run structure:check`, `bun run privacy:scan`; exact-head Cross-platform CI including `desktop shell` | local + hosted |
| c-6 reviews | gpt-6.1-sol code review per PR (verdict PASS), gpt-6.1-sol security review of PR 1 (rc edits, PATH writes, record permissions, shim provenance) and of PR 2 (handoff exceptions, proof regeneration). Verdicts are pasted into the C>D attest of the owning phase. | subagents |
| c-7 merge | merge commit SHAs on `dev`, Co-authored-by not needed (no carried author), docs present in the merged tree | GitHub |

The real-shell check is the only native evidence this unit can produce without packaging the app. A packaged smoke (installing a built OpenCodex.app and opening Terminal) remains human QA for the release checklist and is listed as residual in the PR descriptions.

## Merge procedure

1. PR 1 (`codex/desktop-owned-path-cli` → `dev`) after its gates pass. Before merging, rebase onto the latest `dev`, run `git merge-tree` against `origin/dev`, and rerun the focused checks if any of today's merges touched the same files.
2. PR 2 is stacked on PR 1's branch. After PR 1 merges, retarget PR 2 to `dev`, rebase it onto `dev` so PR 1's commits drop out, push, and wait for exact-head CI.
3. If lane L1's #6802/#6809/#6807 land before PR 2, rebase PR 2 onto them and rerun `tests/cli/ocx-launcher-*.test.ts` and the diagnostics tests; anchors in 020 are by function name.
4. Admin squash merge with `--match-head-commit`. After merging, confirm the squash commit on `dev` and that the next `dev` push CI is green or, when the Actions queue is backed up, that it is at least not red at the time of the report.

## Docs checklist

- `docs-site/src/content/docs/guides/desktop-app.md` and `ko/guides/desktop-app.md`: "The `ocx` terminal command" section (what Desktop writes, how to turn it off or remove it, new-terminal note, Windows system-`Path` caveat, AppImage exclusion), and the uninstall section updated to "remove the terminal command in Desktop first".
- Other locales of the desktop guide: no new section required, but no sentence may contradict the new behavior (for example "the desktop app does not add `ocx` to PATH"). Check with `rg -n "PATH|ocx" docs-site/src/content/docs/*/guides/desktop-app.md`.
- `structure/desktop-shell.md` (wp1) and `structure/runtime.md` (wp2, equal line count under the 600-line cap).

## Done record

wp3 closes with `039_outcome.md`: PR numbers, head and merge SHAs, CI run ids, review verdicts, real-shell transcript summary, residuals (Windows native selection, packaged smoke, AppImage, open shells), and the criterion evidence written into the goalplan.


## Additions from the plan audit (003, AM-10..AM-13)

- **Dashboard entry check.** Besides the GUI unit test and source assertions, C records a real click-through: dashboard → "Terminal command" → `cli.html` → Back → dashboard. It needs a running Desktop build. When this unit cannot run a Desktop build locally, the check is listed as release QA in PR 1 and the GUI part is shown by the PR screenshot only; source assertions are never reported as this check.
- **A11 compiled check (AM-13).** Both runs use the same compiled host CLI. The control run starts from an environment without `OCX_NODE_LAUNCH_CONTEXT` and without any `--ocx-internal-launch-proof=` argument, so nothing from the shim run carries over. The dummy `ANTHROPIC_AUTH_TOKEN` value is a fixed non-secret string that does not match the proxy's own admission token format. Only variable names are printed.
- **Journal state table (AM-6, non-blocking item).** Rust tests cover install and remove × current digest equal to before / equal to after / different × operation wanted / not wanted, asserting that a different digest is never overwritten and that journal files are kept while any change is unresolved. The 64 KiB record cap stays separate from the raised `rcFiles ≤ 16` / `changes ≤ 32` limits.
- **Guard scope (AM-12).** The widened guard is used only by `return_to_dashboard`. The update commands keep `require_update_page`, and the four terminal-command commands keep the strict `require_cli_page`. Tests cover the `main` label, both allowed paths, and rejection of a foreign origin, another port and another path.

