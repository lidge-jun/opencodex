# 020 Verification (wp2): local regression before the only push

All commands run in a detached verification worktree at `/private/tmp/rt2710-verify` pinned to the
integration head. The coordinator's managed worktree lives under `~/.codex`, and
src/lib/test-home-guard.ts:232-237 refuses to delete any path inside the real Codex home from a test
process: a first full run inside the managed worktree at dev 37ad7e771b failed 1210 cases, every
sampled one with "refusing to remove a path inside the real Codex home". That run is discarded as
environment noise. Each result is recorded with exit code in the wp2 C attest and receipt. A
failure is classified by rerunning the same file in a second /private/tmp worktree at dev
37ad7e771b; identical failure there = pre-existing, otherwise it is ours.

| Gate | Command | Reads the change because |
|---|---|---|
| deps | `bun install && (cd gui && bun install)` | lockfiles unchanged; ensures gui types |
| types | `bun run typecheck` | tsconfig includes src/ and tests/ (all six PRs' TS) |
| GUI types/lint | `bun run lint:gui` | gui/src (#6094, #5905 pages, i18n) |
| GUI build | `bun run build:gui` | bundles gui/src incl. new i18n keys |
| full suite | `bun run test` | tests/ incl. every new/changed test file below |
| layout | `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | new test files registered in both rosters |
| structure | `bun run structure:check` | structure/*.md edits (#6201, #6209, #5905, #6198) |
| skill surface | `bun run skill:surface:check` | src/cli/capabilities.ts + skills/ocx (#5905) |
| privacy | `bun run privacy:scan` | devlog + docs + src text |
| GUI tests | `cd gui && bun test tests` | gui/tests/provider-settings-request-pacing.test.tsx, cursor-integration-page.test.tsx |

Focused files (run first, then inside the full suite):

- #6201: tests/claude-integration/claude-picker-ca.test.ts, claude-desktop-cli.test.ts
- #6209: tests/windows/windows-process-priority.test.ts (real-Windows case skips on macOS; covered by
  CI windows shards), tests/cli/cli-start-*.test.ts
- #6094: gui/tests/provider-settings-request-pacing.test.tsx
- #5905: tests/providers/cursor/cursor-local-installer.test.ts, cursor-integration-status.test.ts,
  gui/tests/cursor-integration-page.test.tsx
- #6198: tests/cli/sibling-home-client-sync.test.ts, tests/server/proxy-liveness-package-tree-fence.test.ts,
  tests/cli/cli-dispatch.test.ts
- flake fix: tests/codex-integration/native-profile-manager.test.ts

Activation checks for the conditional paths the fixes touch:

- #6209 opt-out and non-win32 skip: covered by injected-platform unit cases in
  windows-process-priority.test.ts (observable return value "skipped").
- Budget change: the ablation still fails — the assertions (32 profiles, INVALID_REQUEST on 33,
  vault bytes unchanged) do not depend on the budget; the budget only bounds a hang.

Independent review: a Kimi reviewer reads `git diff canon/dev...HEAD` and the ten commit
messages; REVIEW-SYNTHESIS records accept/rebut before C.

Exit: every gate exit 0, or a failure proven identical in the baseline log (named test, same
error) and unrelated to touched files.

Baseline at dev 37ad7e771b in /private/tmp/rt2710-base (`bun run test`, 13m44s, load avg ~6 from
unrelated desktop processes): 9 failures, all timeouts in spawned-CLI cases — `CLI subcommand
help` x4 (40s), `ocx launcher graceful shutdown` x3 (20s), `ocx models` x2 (15s). None of these
files is touched by the six PRs. They are the classification reference for wp2.
