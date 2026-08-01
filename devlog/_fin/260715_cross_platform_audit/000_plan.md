# 000 — Cross-platform compatibility audit + remediation plan

Session: 019f6514-4b84-7b11-ba6d-cc8ecae37767 · Goalplan: `fix-the-windows-skill-elision-path-bug-in-openco`
Date: 2026-07-15 · Class: C3 (cross-module, user-facing Windows behavior, tests exist)

## Objective

A Windows user reported (DC gallery post, 2026-07-15) that blocked-skill document elision
silently fails on Windows: `maybeElideSkillText` extracts the skill directory basename with
`dir.split("/")`, which cannot split `C:\Users\...\claude-api`, so a ~790K-char (~840KB)
skill bundle rode through to routed models (usage.jsonl showed ~297K-token inputs to
gpt-5.6-sol). Fix that defect, then audit and remediate the whole repo for the same family
of cross-platform hazards.

## Constraints / scope boundary

- IN: `src/`, `tests/`, this devlog unit. Local commits per DEV-GIT-COMMIT-01.
- OUT: git push, npm release, native Anthropic passthrough behavior (`claude-messages.ts`
  passthrough intentionally does not elide), unrelated refactors, `scripts/` dev-only files.
- Verifier: `bun test --isolate ./tests/` + `bun x tsc --noEmit` (package.json scripts).

## Evidence base

1. User bug report with exact anchors (inbound.ts:131 DEFAULT_BLOCKED_SKILLS, :182-183 split).
   Verified against tree: `src/claude/inbound.ts:183` is byte-identical to the report.
2. Read-only survey by sol explorer subagent (agent 019f6516-fd7b-72f3-b60e-068274fcc6d0),
   6 hazard classes, full report in `001_hazard_inventory.md`.
3. Main-session spot-checks: all DEFECT anchors verified verbatim; two survey claims
   REFUTED empirically (see 001 §Rebuttals): CRLF parsing in `project-config-warnings.ts`
   and `features.ts` is safe because JS `\s`/`\s*$` absorbs trailing `\r` (bun eval, all
   6 probes matched); `child.kill("SIGKILL")` is valid on Windows Node/Bun (TerminateProcess).

## Confirmed defects (after rebuttals)

| ID | File:line | Class | Severity | Phase |
|----|-----------|-------|----------|-------|
| D1 | `src/claude/inbound.ts:183` | path separator | high | 010 |
| D2 (P4-1) | `src/cli/claude.ts:179` | spawn `.cmd` | high | 020 |
| D3 (P4-2) | `src/cli/v2.ts:27` + `src/server/management-api.ts:613` | spawn `.cmd` | high | 020 |
| D4 (P4-3) | `src/adapters/cursor/native-exec-desktop.ts:128` | `sh -c` on Windows | medium | 020 |
| D5 (P1-1) | `src/codex/project-config-warnings.ts:226` | home-prefix boundary | low | 030 |

## Audit round 1 synthesis (reviewer 019f651c-5dc7, VERDICT: FAIL, 4 blockers — all ACCEPTED)

1. (High) `codexExecInvocation()` is NOT generally reusable: bare `claude`/`codex` return
   `shell:false` (still ENOENT for npm `.cmd` shims), and `shell:true` + args array has no
   argument escaping — unacceptable for `ocx claude`'s arbitrary user args. → 020 now
   specifies a real Windows launcher (`src/lib/win-exec.ts`): PATH+PATHEXT candidate
   resolution, cross-spawn-style `cmd.exe /d /s /c` invocation with
   `windowsVerbatimArguments: true` and per-arg CMD escaping for `.cmd`/`.bat` targets;
   plain `shell:false` spawn for `.exe`.
2. (Med) D4's `cmd /d /s /c` needs a defined contract. → `desktopExecutor` commands are
   platform-native shell syntax (CMD on Windows, sh elsewhere); command string passed
   VERBATIM in content but wrapped in the OUTER quotes `/s` requires (cross-spawn
   convention, `node_modules/cross-spawn/lib/parse.js:51-59`): final argv is
   `[ComSpec, "/d", "/s", "/c", `"${command}"`]` with `windowsVerbatimArguments: true`,
   so `"C:\Program Files\executor.exe" --json` becomes
   `cmd.exe /d /s /c ""C:\Program Files\executor.exe" --json"`. Round-2 audit blocker
   folded: injected-spawn tests assert this EXACT final argv; tests cover quoted exe
   paths + metacharacters for BOTH configured commands.
3. (Med) 030 containment predicate incomplete. → containment =
   `rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !pathApi.isAbsolute(rel))`
   via injected `pathApi` (`path.win32` fixtures on POSIX hosts); case semantics come from
   the platform `relative()` itself, not manual `toLowerCase()`.
4. (Med) Activation scenarios must map 1:1 to owning tests. → each decade doc names the
   scenario→test table (see docs 010/020/030).

Residuals folded: 010 adopts the repo-precedent normalization `dir.replace(/\\/g, "/")`
(matches `src/codex/inject.ts:311`; reviewer preference) instead of `split(/[\\/]/)`;
drive-relative `C:claude-api` is documented out-of-contract with a test pinning
pass-through behavior. Real-Windows smoke testing is impossible from this macOS host:
all win32 behavior is verified via injected `platform`/`spawn`/`pathApi` seams, and a
manual Windows smoke test is recorded as a follow-up in the D summary (honest residual).

## Work-phase map (dependency-ordered, one decade doc = one PABCD cycle)

- **010 — skill-elision separator fix (wp1):** normalize separators with
  `dir.replace(/\\/g, "/")` before splitting in `maybeElideSkillText` (repo precedent
  `src/codex/inject.ts:311`); regression tests: Windows path elided, POSIX unchanged,
  non-blocked passthrough, drive-relative `C:claude-api` pinned as pass-through.
  Independent of everything else; ships the user's reported bug first.
- **020 — Windows spawn hygiene (wp2):** new `src/lib/win-exec.ts` launcher —
  PATH/PATHEXT candidate resolution for bare commands, `.exe` → plain `shell:false`
  spawn, `.cmd`/`.bat` → `ComSpec cmd.exe /d /s /c` with `windowsVerbatimArguments: true`
  and cross-spawn-style per-arg escaping (arg-boundary preserving, metachar-safe).
  Apply to D2 (`src/cli/claude.ts`), D3 (`src/cli/v2.ts`, `src/server/management-api.ts`
  — may keep `codexCommandCandidates()`+`codexExecInvocation()` for fixed-token args
  where already proven, but bare-name resolution must go through the launcher), and
  D4 (`native-exec-desktop.ts` platform shell, verbatim command string). Foundation
  (launcher) precedes call-site adoption, hence one phase.
- **030 — home-prefix display fix (wp3):** `relPath()` via injected `pathApi.relative`
  with full containment predicate (`""` | not `".."` | not `..${sep}` prefix | not
  absolute); `path.win32` fixtures. Display-only; last.

Docs 010/020/030 are written to diff-level in this cycle (DIFFLEVEL-ROADMAP-01); each
implementation cycle's P re-verifies its doc against the then-current tree before building.

## Accept criteria (goalplan c1-c4)

- c1: Windows-path elision regression test passes; POSIX tests unchanged (010).
- c2: this unit contains 000/001 research + 010/020/030 diff-level docs; every path:line
  claim verified against the tree.
- c3: every confirmed defect fixed with a test where testable; refuted findings recorded
  with rebuttal evidence, not silently dropped.
- c4: `bun x tsc --noEmit` and `bun test --isolate ./tests/` pass with fresh output after
  each build phase.

Activation scenarios (C-ACTIVATION-GROUNDING-01), one owning test per conditional path:

| Scenario | Owning test |
|----------|-------------|
| 010 Windows base-dir elided | tests/claude-inbound.test.ts new: text-block carrier with `C:\Users\...\claude-api` |
| 010 POSIX unchanged / non-blocked / drive-relative | existing carrier tests + 2 new cases |
| 020 D2 `ocx claude` win32 `.cmd` resolution | tests/claude-cli.test.ts: injected spawn+platform, asserts cmd.exe argv |
| 020 D2 arg preservation (spaces/quotes/metachars) | tests/claude-cli.test.ts: escaping case |
| 020 D3 `ocx v2 on/off` win32 | new/extended v2 CLI test: invocation shape |
| 020 D3 management-api feature toggle win32 | tests/claude-management-api.test.ts (or equivalent): injected exec |
| 020 D4 computerUseCommand win32 + quoted path + metachars | tests/cursor-desktop-exec.test.ts: injected spawn |
| 020 D4 recordScreenCommand win32 | tests/cursor-desktop-exec.test.ts: second command case |
| 020 `.cmd` vs `.exe` vs explicit `CODEX_CLI_PATH` | win-exec unit tests |
| 030 boundary `bob` vs `bob2`, exact-home, parent, cross-drive | project-config-warnings test: path.win32 fixtures |

## Closeout (D, 2026-07-15) — outcome: DONE

All three implementation cycles landed, each as one full PABCD cycle:

| Phase | Commit | Gates |
|-------|--------|-------|
| 010 skill-elision fix (D1) | fe1a5ea2 | 2515 pass / tsc clean |
| 020 spawn hygiene (D2-D4) | 9eaff979 | 2540 pass / tsc clean; escaping byte-verified vs installed cross-spawn |
| 030 relPath containment (D5) | 05b0ec81 | 2545 pass, 0 fail / tsc clean |

Refuted survey findings recorded in 001 (CRLF parsing, SIGKILL portability) — no code
change needed, empirical probes on file. Doc nit: live relPath range was 226-232 at
build time (doc said 225-231).

**Honest residual (follow-up):** every win32 behavior is proven at invocation-shape /
pure-function level via injected platform/env/exists seams from this macOS host.
A real-Windows smoke test (`ocx claude`, `ocx v2 on/off`, blocked-skill elision under
Claude Code on Windows, desktopExecutor command) remains the one verification this
environment cannot produce. Bun's Windows honoring of `windowsVerbatimArguments` is
documented but not locally provable.

Not pushed — commits are local only (DEV-GIT-PUSH-01; push needs explicit user approval).
