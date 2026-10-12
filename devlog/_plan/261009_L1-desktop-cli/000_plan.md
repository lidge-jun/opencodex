# 261009 L1 — the CLI follows the Desktop sidecar

**Reader summary.** When OpenCodex Desktop starts its bundled runtime itself, the `ocx` CLI on PATH
does not know. On the reporting Mac, Desktop 2.81.0 runs `/Applications/OpenCodex.app/Contents/MacOS/ocx
start --port 10100` as its own child, yet `ocx status` says protection `none` and tells the user to run
`ocx service install`, which would install a second supervisor that competes with the app. `ocx update`
from npm would stop that runtime and refresh a service, and the PATH launchers either fail ("the `bun`
dependency is not installed") or are years old. This unit teaches the CLI to recognize live Desktop
supervision as its own fact, stops recommending or performing competing actions while it holds, lets the
package launcher fall back to a valid Bun, and records the Desktop PATH-install decision.

Evidence for the reproduction: `001_evidence.md`. Architect consultation and audit: `002_consultation.md`.
Locked contract (read first): `003_contract_index.md`.

## Loop spec

- **Loop archetype:** satisfy-spec, multi-cycle HOTL (cxc-loop), one work-phase per PABCD cycle.
- **Trigger:** user report in coordinator thread 01a11e2e: "opencodex desktop을 깔았을때 데스크탑 사이드카로
  실행되고 있으면 cli도 ocx 데스크탑 사이드카 기준으로 실행이되어야" — lane L1 delegation.
- **Goal:** with a live Desktop-supervised runtime, CLI status/doctor/resolve name Desktop as the live
  supervisor, never recommend `ocx service install`, and service/update/start/stop/restart neither compete
  with nor silently tear down that runtime (explicit `ocx stop` keeps working, because Desktop's own
  `runtime_stop.rs` calls `stop --json`; it gains a notice instead); the npm/link launcher no longer hard-fails
  when a usable Bun exists.
- **Non-goals:** synthesizing a durable ownership claim from parentage (consent stays the only path to
  ownership); deleting the stale service record automatically; silent whole-invocation delegation to the
  Desktop CLI; a Desktop PATH installer (decided in wp4); Windows process-parentage evidence (reported as
  `unsupported`, status quo); other lanes' areas (#6649/#6774/#6695 journal and service, compaction,
  admission, auth, lazycodex, CI infra). No full `bun run test`; no stopping/restarting the user's port-10100
  runtime; no edits to user PATH shims or `~/.opencodex`.
- **Verifier:** per work-phase focused Bun test files named in each decade doc (they import the changed
  modules directly), `bun run typecheck` (tsconfig includes src/ only), `bun run structure:check` when
  structure/ changes, `bun run privacy:scan`; exact-head hosted CI (Cross-platform CI, 4 test shards + Windows
  shards) is the broad gate. Read-only live probe: the Desktop-bundled `ocx status --json` is NOT a verifier
  for this change (it runs the installed 2.81.0); live proof uses the lane checkout's CLI
  (`bun run src/cli/index.ts status --json`) against the real home, read-only.
- **Stop condition:** PRs open against dev (PR B stacked on PR A's branch), exact-head CI green, independent
  gpt-6.1-sol review PASS, then stop at merge-ready. Merge, release, issue/PR comments on others' work are out
  of authority.
- **Memory artifact:** this unit; D summaries in `0x0`-range `*_done.md` notes per phase; goalplan
  `.codexclaw/goalplans/lane-l1-…` in the coordinator cwd.
- **Expected terminal outcomes:** DONE = three PRs merge-ready with evidence; NEEDS_HUMAN = a product decision
  (for example login-less protection semantics) the evidence cannot settle; BLOCKED = CI infrastructure or
  permission; UNSAFE = a fix that would require touching the live sidecar.
- **Escalation condition:** reviewer FAIL twice on the same packet → root-cause replan; a design that needs a
  Rust shell protocol change; any need to merge or to write to another contributor's PR.
- **Resource bounds:** tools = local shell in the lane worktrees, gh for this repo's own branches/PRs/CI;
  write scope = lane worktrees `.tmp/lanes/L1-desktop-cli*` only; no token/time budget was set by the user.

## Work-phase map (dependency order)

| Goalplan id | Doc | Slice | PR | Depends on |
|---|---|---|---|---|
| wp1 | this unit | docs-first roadmap | none | — |
| wp2 | `010_supervision_evidence_projection.md` | foundation: supervision evidence module + startup-health/status/doctor/resolve/GUI projection | PR A → dev | wp1 |
| wp5 | `020_command_guards.md` | command guards on top of the evidence: service install/repair/start/restart, update planner (Node launcher + Bun updater + dashboard restart veto), start/stop/restart wording | PR B → PR A's branch (stacked) | wp2 |
| wp3 | `030_launcher_bun_fallback.md` | launcher: validated PATH Bun fallback, Desktop CLI pointer in the failure text, version-skew notice on lifecycle commands | PR C → dev | wp1 |
| wp4 | `040_path_cli_decision_closeout.md` | Desktop PATH CLI decision record + lane closeout | docs in PR C or PR A | wp2, wp3 (and wp5) |

Execution order: wp1 → wp2 → wp5 → wp3 → wp4. wp5 was appended at wp1-P (LOOP-UNIT-CHAIN-01) because the
guards depend on wp2's module and make a reviewable PR on their own.

## Source-of-truth sync (SOT-SYNC-01)

`structure/desktop-shell.md` (Keeping the runtime alive / Runtime ownership from the app's side),
`structure/runtime.md#background-service-runtime-ownership`, `structure/ops/service-and-sidecars.md`
(desktop startup diagnostics paragraph, launcher/Bun paragraph), `structure/INDEX.md` via
`bun run structure:index` only if manifest ownership changes. User docs: `docs-site/src/content/docs/guides/desktop-app.md`
(+ ko locale) for the status/guidance change and the CLI-on-PATH note.
