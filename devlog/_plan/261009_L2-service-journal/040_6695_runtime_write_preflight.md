# wp4 — #6695 selected-runtime write preflight (refuse, no discovery)

## Problem

Under a Windows WDAC or app-sandbox policy, the same Bun bytes can write the profile from one path and get EPERM from another. A durable launcher (Task Scheduler wrapper, WinSW, Codex shim) that bakes the denied path crash-loops; about 4,700 restarts were observed. #6695 write-probes the bundled Bun and auto-selects another runtime from PATH or install locations. Maintainer review held it because auto-discovery and persistence change the runtime trust contract. The accepted shape is a preflight of the selected runtime that refuses with guidance.

## Decisions (architect 01a11e35-f578 → disposition)

- **D1 — ACCEPT.** New `src/lib/bun-runtime-preflight.ts` exports `assertSelectedRuntimeWritable(runtime, configDir, deps?)`, which throws `code: "OCX_RUNTIME_PREFLIGHT_FAILED"` with a reason of `spawn | timeout | create | remove | protocol`. Selection in `bun-runtime.ts` is unchanged, including the pre-dotenv rationale. `cliEntry()` stays I/O-free.
- **D2 — ACCEPT, amended.** Execute the selected lexical path with argv `-e <script>`, no shell, a hidden window, and a 5,000 ms timeout. The child runs `mkdirSync` and `rmdirSync` on `.ocx-runtime-probe-<uuid>` under the probe directory and acknowledges a nonce. There is no memoization and no recursive delete.
  - **Amendment (root absence):** the preflight never creates the config root. The probe directory is the config dir when it exists, otherwise its nearest existing ancestor. This leaves the fresh-install ownership semantics of `orchestration.ts:344-361` and `windows-ops.ts:553` untouched, while still exercising the selected executable's write policy.
- **D3 — ACCEPT.** Gate `installServiceSafely`, `installFreshWindowsSchedulerSafely`, `installWindows`, `installWindowsNative`, `repairService`, and shim install/refresh before their first disruptive action. Thread the one selected runtime through rendering and state writes. Non-Windows returns without spawning. Shim auto-restore on startup returns `deferred` with guidance and does not block startup.
- **D4 — ACCEPT** the message in the proposal, naming `OPENCODEX_BUN_PATH` (the existing env override) and an npm-global reinstall.
- **D5 standalone (compiled ocx) — AMEND to "refuse, documented gap closed later".** When the selected runtime is standalone, `bun -e` is unavailable. Instead of a new hidden internal command (scope growth, recursion risk, and overlap with L1's standalone/Desktop work), the preflight for standalone selection runs the same create/remove in-process. That process is the selected executable itself, so the policy being tested is the right one. Record this in 040 and the PR. A standalone selection on Windows is the Desktop-bundled case owned by L1; coordinate if L1 changes standalone selection.

## File change map

- New: `src/lib/bun-runtime-preflight.ts`.
- Changed: `src/service/orchestration.ts`, `windows-ops.ts`, `repair.ts`, `state.ts` (parameter threading only), `src/lib/winsw.ts`, `src/codex/shim.ts` (53 lines headroom; move helpers out if needed), `src/cli/codex-shim-autorestore.ts`.
- Docs: `structure/runtime.md` (at 600; trim elsewhere or reference a sibling doc), `structure/ops/service-and-sidecars.md`, `docs-site/.../troubleshooting/windows-memory.md`.
- Tests: new `tests/lib/bun-runtime-preflight.test.ts`, `tests/service/service-runtime-preflight.test.ts`, `tests/codex-integration/codex-shim-runtime-preflight.test.ts` (registered in both layout files; layout has 23 lines of headroom). Reuse #6695's blocker-file fixture. `tests/service/service.test.ts` (4089/4106) is not enlarged.

## Acceptance (activation scenarios)

1. Injected Windows platform with a child that fails create, fails remove, times out, or sends a bad nonce: install and repair refuse before any stop, staging, removal, download, token, XML, or state write, with exit 1 and the guidance message.
2. Success: the baked path and source equal the selection exactly; no discovery calls are made.
3. Non-Windows: zero spawns and zero filesystem mutations.
4. Shim auto-restore with a refused preflight: `deferred`, and startup continues.
5. A real child script run against a temp dir on all hosts passes (the protocol works with the real `bun`).
6. Existing `tests/ci-workflows/bun-runtime.test.ts` and `tests/service/winsw.test.ts` stay unchanged and green.

Co-author: `Co-authored-by: ismell0992-afk <ismell0992@gmail.com>`.

## A-audit dispositions (auditor 01a11e3f)

- **B4 absent root — FIX (supersedes reflection item 1).** Bare `ocx` does not create the config dir, so guidance alone cannot recover. `assertSelectedRuntimeWritable` instead takes `{ rootWasAbsent }`, which the caller captures before any write. When the root is absent, the preflight creates exactly the config root with mode 0700, the same as the existing `mkdirSync` at `windows-ops.ts:112` and `:754`, and probes inside it. On refusal it removes that root only if the root is still an empty directory with the identity it had at creation. On success the empty root stays. The fresh scheduler path (`orchestration.ts:344`) already captures `configRootWasAbsent` before staging, and ownership claiming requires an empty root, which still holds after the probe cleans up. The preflight runs after the absence capture and before `stage()`. Tests use an absent temp home: a denied run refuses and leaves no root, and an allowed run leaves an empty root while the fresh install records ownership.
- **Selection freezing — ADD.** An integration test changes the runtime selection between the preflight and rendering, then asserts that rendering and `writeServiceInstallState` use the frozen, preflighted selection.
- **B4 re-audit — cleanup custody.** Root creation is exclusive: a non-recursive `mkdirSync(root, 0o700)` under an existing parent. If the parent is missing, the preflight refuses with guidance. Cleanup custody is granted only when that call itself succeeded, and is recorded as the created directory's `dev`/`ino`. `EEXIST` grants no custody: the probe runs inside the concurrent directory and never removes it. On refusal, the root is removed with a non-recursive `rmdirSync` only if it still lstat-matches the recorded identity and is empty. Deterministic tests:
  - another invocation creates the root first → it and its contents survive
  - the created root becomes nonempty before cleanup → it survives
  - the root pathname is replaced by another empty directory → the replacement survives
- **Superseded wording.** In "Reflection dispositions" below, item 1 (refuse when absent) and the absent-root case in item 5 are superseded by B4 above. Absent roots are created and probed under custody rules.
- **Code-review disposition (C, wp4 review 01a11e65-ceb5).** Pathname-based root cleanup cannot keep custody across a concurrent rename-and-replace. The preflight therefore never deletes the config root. When it creates an absent root and the probe then refuses, the empty root is left in place. The aborted fresh install is unaffected, and an empty root stays claimable (`windows-ops.ts` claims empty roots). This supersedes the cleanup half of the B4 re-audit; the tests now assert preservation. Also, an orchestrated install admits the runtime once, before `prepareServiceInstall`, and calls internal commit functions with the frozen runtime. Direct public installer calls keep their own admission, so no second preflight can refuse after a stop.

## Reflection dispositions (architect 01a11e35-f578, MISALIGNED → folded)

1. **Ancestor probing is not admission evidence — FIX (supersedes the D2 root-absence amendment).** When the config dir is absent, the preflight refuses with guidance ("run `ocx` once so the config directory exists, then retry"). It never probes an ancestor and never creates the root. In practice, every `ocx service`/shim path already runs after config loading creates the directory, so refusal only triggers in genuinely unusual states.
2. **Existing-root validation — FIX.** The config dir must `lstat` as a real directory. A file, a symlink or junction that does not resolve to a directory, or EACCES refuses.
3. **D5 contradiction — RESOLVED as admission with a documented limit.** For `source: "standalone"` where the selected executable is exactly `process.execPath` (`bun-runtime.ts:169-170`), the create/remove probe runs in-process; the running process is the selected executable, so the right path policy is exercised. Limitation: there is no child isolation or timeout, and a synchronous filesystem call can block. This is documented in the PR and `structure/runtime.md`. A standalone selection that is not `process.execPath` refuses.
4. **Standalone ownership — corrected.** `standalone` describes executable packaging, not Desktop ownership. The L1 note is now only a coordination reminder.
5. **Acceptance negatives — ADD.** Tests cover an absent root (refuses, no mutation), a non-directory or dangling root, standalone create/remove failure with cleanup, and standalone identity mismatch (refuses). Non-Windows paths make zero filesystem mutations and zero spawns. Existing behavior stays covered: spawn failure, leftover entries, concurrent nonces, and zero probes for healthy or disabled shims.
