# 090 - Outcome

Terminal outcome: **DONE** (wp1 NOOP by user instruction; every other work-phase
closed with evidence).

## What landed on `dev`

| PR | merge | subject | exact-head ci |
|---|---|---|---|
| #3500 | 5df664cda | layout map, mover/verifier tooling, repo-root helper, basename-anchored CI exclusions | 33907899776 on 73c6dc4c2 |
| #3501 | 4cacdfbb6 | macOS 2-way shard, `macos-control` on dispatch, `lane` input | 33904330976 on 4d4e9b46f; control dispatch 33904336284 (windows skipped) |
| #3509 | 8f02f24d5 | windows, service, update | 33909679589 on 23ca0f2db |
| #3510 | 3aab264e3 | lib, config, clients, usage, vision, web-search | 33911446464 on 1b0232315 |
| #3511 | 5424ad465 | cli, oauth, routing, claude-integration | 33914563430 on 66fb811ec |
| #3513 | b20af6668 | adapters (+google/anthropic/openai), responses, lab, gui | 33916124576 on 3c622803e |
| #3516 | 8b6e4542a | providers (+cursor/kiro/xai/ollama/github-copilot), codex-integration | 33918631876 on a6d6e138c |
| #3518 | 79e03643d | server, storage, ci-workflows | 33922053451 on 33ffae2d7 |

Every merge was an admin squash after `ci` succeeded on the exact PR head, and
`git merge-base --is-ancestor <merge> origin/dev` held for each. Tracking issue:
#3497.

After #3518, `git ls-tree origin/dev tests` shows exactly two `*.test.ts` at the
root (the layout guards); 1045 files moved with `git mv` into 25 domain
directories, plus the three that were already nested.

## What the tooling had to learn on the way

Each slice surfaced a shape the design in 030 did not have, and each became a
rule plus a test in `tests/test-layout-tooling.test.ts`:

- `mock.module("../src/x")` is a module specifier (8 files; silently stopped
  intercepting when left alone).
- `join(import.meta.dir, "fixtures/x")` (17 sites) -> `fixturePath()`.
- A file that binds its own `const repoRoot` is rebound through
  `import { repoRoot as resolveRepoRoot }`, and every other escape in that
  file then calls the alias.
- `new URL("..", import.meta.url)` without the trailing slash; `new URL(<variable>, import.meta.url)`.
- The helper import goes into the leading import block even when the file
  ends with a stray import.
- The serial-lane rewrite touches only the `SERIAL_FULL_SUITE_FILES` array,
  never the basename-keyed timeout table.
- The literal sweep uses `git grep` (CI runners have no `rg`) and skips
  `devlog/` (59 historical documents per slice, nothing reads them).
- `.gitignore` needed `tests/**/.tmp-*` for nested scratch directories.

Three `dev` changes landed mid-cascade and had to be folded (#3507 preload
guard, #3523/#3526/#3530 the quorum-cache test's placement, #3527 duplicate
basename guard); the layout guard caught every one on the exact PR head.

## CI

003 §1 baseline: wall mean 15.4 min, macOS 14.9. After #3501 (041): macOS shard
job 7.6 min each, unqueued wall 9.4 min. Linux stays at 4 shards.
`platform-windows` is untouched apart from the `lane` skip condition.

## Reviews

Plan: six rounds with one gpt-5.6-sol reviewer (000 §"Roadmap audit record").
Tooling: two rounds (030 §"Implementation notes"). Slice PRs: automated Codex /
CodeRabbit / grok-bot reviews on each, folded before merge.

## Not done here

- Linux shard count (measured as no wall gain while macOS is the critical path).
- Windows product or CI repair (owned elsewhere; 010).
- Any test deleted or assertion weakened: none.

