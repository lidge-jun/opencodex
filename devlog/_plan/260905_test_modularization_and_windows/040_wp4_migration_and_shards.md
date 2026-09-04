# 040 - wp4: migration slices and the macOS shard

## Class call

C3 per slice; mechanical moves driven by `scripts/test-layout/move.ts` from wp3.
One PR per slice, merged in order, each on a fresh branch from the then-current
`dev`. Slices are sized so a reviewer can read the non-mechanical rewrites
(the `MANUAL` lines) in one sitting.

## 1. Slice order and contents

Ordered by risk: smallest and most self-contained first, the two domains with
the most path-literal hazards (ci-workflows, storage) last so the tooling is
proven before it touches the oracles that pin CI.

| PR | slice | domains | files | known hazards (from 001 §3-4) |
|---|---|---|---:|---|
| 1 | `layout/windows-service-update` | windows, service, update | 49 | `windows-tray.test.ts:403` copies a child helper; `update-stop-first.test.ts` is a serial lane; winsw/tray source-oracles |
| 2 | `layout/lib-config-clients-usage-vision-websearch` | lib, config, clients, usage, vision, web-search | 109 | `config-save-boundary`, `config-rebase-provenance-writers` oracles; `sync-client-integrations`; `api-usage.test.ts` isolated-job path (ci.yml, release.ts, zz-ci-api-usage oracle) |
| 3 | `layout/cli-oauth-routing-claude` | cli, oauth, routing, claude-integration | 138 | `cli-account` spawns two children by `new URL`; `chatgpt-oauth` cwd-relative `Bun.file` (leave); `cli-ready` six oracle reads |
| 4 | `layout/adapters-responses-lab-gui` | adapters (+3 children), responses, lab, gui | 233 | GUI `Bun.file("gui/src/...")` cwd-relative (leave); `relay-eager`, `passive-route-linker` oracles; `responses-state` spawns two children; `openai-provider-option-e2e` serial lane and `scripts/openai-provider-option-final-gates.ts:45-95` literals |
| 5 | `layout/providers-codex` | providers (+5 children), codex-integration | 376 | `codex-composed-acceptance`, `codex-write-lock`, `codex-inject-write-lock` child spawns; `native-*` children; `cursor-images` six `new URL` fixture reads; `codex-shim`, `cursor-native-exec-shell` serial lanes |
| 6 | `layout/server-storage-ci` | server, storage, ci-workflows | 140 | storage three-way edit (ci.yml, release.ts, zz-ci-storage oracle); `ci-workflows.test.ts` 22 literals; `loopback-listener-integration:837` `process.cwd()` child spawn; `release-helper`, `issue-452-empty-503` serial lanes; `dev-version-bump.yml` explicit path; `.github/scripts/pr-hygiene.cjs` `TEST_PREFIXES` (prefix only, unchanged) |
| 7 | `ci/macos-2way-shard` | ci.yml only | 0 | `ci-workflows.test.ts:219-245,301-306,491` pin the macOS step |

Total moved: all 1045 root `*.test.ts` files across slices 1-6 (the slice counts
above sum to 1045 and exclude the 16 already-nested image/video/e2e files; the
authoritative per-PR list is `plan.ts --domain` output). Root keeps `preload.ts`,
`fake-codex-server.ts`, `tsconfig.doctor-service-memory-contract.json`, and the
new `test-layout.test.ts`; `images/ videos/ e2e-style/` stay where they are.

## 2. Per-slice procedure (identical for PRs 1-6)

```bash
git switch -c codex/layout-<slice> origin/dev
bun scripts/test-layout/move.ts --domain <a> --domain <b> ...   # one invocation per slice; preflights all, moves all, appends migrated, verifies; exits 2 on MANUAL lines
# hand-edit every MANUAL <file>:<line>; re-run verify
bun scripts/test-layout/verify.ts --domain <a> --domain <b> ...
bun test tests/test-layout.test.ts <the domain dirs>   # test-runner.test.ts is inside ci-workflows/ from PR 6 on; before that name it explicitly
bun x tsc --noEmit
bun run test:changed          # on macmini-cf if the slice is large
bun run privacy:scan
git add -A && git commit -m "test(layout): move <domains> into tests/<domain>/ (#<issue>)"
gh pr create --base dev ...   # Summary / Verification / Checklist filled
```

Serial lanes: when a slice moves one of the six `SERIAL_FULL_SUITE_FILES`, the
entry in `scripts/test.ts` becomes `"<domain>/<basename>"`. Lane `label`, the
`--path-ignore-patterns **/<x>` glob, and the `SERIAL_LANE_TIMEOUT_MS` lookup all
use `basename(file)`; only the lane argv uses the full `./tests/${file}`.
`tests/test-runner.test.ts:176-185` is rewritten to assert those two forms
separately (`**/${basename(file)}` in the parallel lane, `./tests/${file}` in
the serial lane, `label === basename(file)`). Same commit as the move:

```diff
 export const SERIAL_FULL_SUITE_FILES = [
-  "codex-shim.test.ts",
+  "codex-integration/codex-shim.test.ts",
-  "cursor-native-exec-shell.test.ts",
+  "providers/cursor/cursor-native-exec-shell.test.ts",
   "issue-452-empty-503.test.ts",            // -> server/ in PR 6
-  "openai-provider-option-e2e.test.ts",
+  "adapters/openai/openai-provider-option-e2e.test.ts",
   "release-helper.test.ts",                 // -> ci-workflows/ in PR 6
-  "update-stop-first.test.ts",
+  "update/update-stop-first.test.ts",
 ] as const;
```

Child helpers: the mover rewrites the join to `helperPath("x-child.ts")`; the
helper files themselves do not move. `windows-tray.test.ts:403` copies the
child into a temp dir first, which still works with `helperPath` as the source.

Cwd-relative `Bun.file("src/...")` and `Bun.file("gui/src/...")` are left alone: the
runner cwd is the repo root in every invocation (`scripts/test.ts`, the batch
script, the macOS step, `bun test <file>` from root).

## 3. Isolated-job path edits

`api-usage.test.ts` moves with the usage slice (PR 2):

```diff
       - name: Test api usage API
-        run: bun test --isolate ./tests/api-usage.test.ts
+        run: bun test --isolate ./tests/usage/api-usage.test.ts
```

with `tests/zz-ci-api-usage-isolation.test.ts:40` ->
`toBe("bun test --isolate ./tests/usage/api-usage.test.ts")` and the
`./tests/api-usage.test.ts` line of `scripts/release.ts` `ISOLATED_TEST_FILES`.

The storage family moves in PR 6:

```diff
       - name: Test storage policy API
         run: |
           bun test --isolate \
-            ./tests/api-storage-policy-already-running.test.ts \
-            ./tests/api-storage-policy-mutation-busy.test.ts \
-            ./tests/api-storage-policy-put-race.test.ts \
-            ./tests/api-storage-policy-run.test.ts \
-            ./tests/api-storage-policy.test.ts \
-            ./tests/api-storage.test.ts
+            ./tests/storage/api-storage-policy-already-running.test.ts \
+            ./tests/storage/api-storage-policy-mutation-busy.test.ts \
+            ./tests/storage/api-storage-policy-put-race.test.ts \
+            ./tests/storage/api-storage-policy-run.test.ts \
+            ./tests/storage/api-storage-policy.test.ts \
+            ./tests/storage/api-storage.test.ts
```

with `dedicatedFiles` in `tests/zz-ci-storage-policy-isolation.test.ts` and the six
storage lines of `scripts/release.ts`. The batch-script exclusion is basename-anchored
after wp3 and needs no edit in either PR.

`.github/workflows/dev-version-bump.yml:5,101,177,187`:
`bun test tests/release-version-line.test.ts` -> `bun test tests/ci-workflows/release-version-line.test.ts`
(PR 6, with the `ci-workflows.test.ts` expectations that quote it).

## 4. PR 7: macOS 2-way shard

From 003 §6: macOS is the critical path (14.9 min mean, Linux max 4.7); 2-way
halves the wall (~7.7 min) for +0.6 macOS minutes per run; Linux 6/8 saves
nothing while macOS is unsharded. The unsharded-control property moves to
`workflow_dispatch` so it is not paid on every push.

```diff
   platform-macos:
-    name: macos
+    name: macos ${{ matrix.shard }}/2
     needs: changes
     if: github.event_name != 'pull_request' || needs.changes.outputs.ci == 'true'
     runs-on: macos-latest
-    # The unsharded control for the sharded Linux lane: the only place the whole
-    # suite runs in one pool, so it is the place that catches what sharding
-    # hides. The flakes it keeps surfacing are timing, not logic, and the fix
-    # is the tests, not a fourth lane.
-    timeout-minutes: 30
+    # Two shards. Unsharded, this job was the critical path on every green dev
+    # push (mean 14.9 min against a 4.7 min Linux maximum; devlog
+    # 260905_test_modularization_and_windows/003). Two halves finish in ~7.7 and
+    # cost 0.6 extra macOS minutes of setup per run. The whole-pool control that
+    # the single job used to provide lives in macos-control below, on dispatch.
+    timeout-minutes: 20
+    strategy:
+      fail-fast: false
+      matrix:
+        shard: [1, 2]
```

and in the Test step:

```diff
-            bun test --isolate --timeout 60000 tests 2>&1 | tee "$suite_log"
+            bun test --isolate --timeout 60000 tests --shard=${{ matrix.shard }}/2 2>&1 | tee "$suite_log"
```

New job `macos-control`: a copy of the pre-change `platform-macos` job with
`name: macos control`, no matrix, unchanged 30-minute budget and the unsharded
`bun test ... tests` line. Added to the `ci` aggregate `needs` list (a skipped
result passes the allowlist).

Dispatch inputs. Today `workflow_dispatch` runs everything including
`platform-windows`, so a dispatch on a PR head whose Windows shards are red
(someone else's burn-down) produces a red `ci` on that SHA. The workflow gains
one choice input:

```diff
-  workflow_dispatch:
+  workflow_dispatch:
+    inputs:
+      lane:
+        description: "all (default) or macos-control"
+        type: choice
+        default: all
+        options: [all, macos-control]
```

`macos-control.if`: `github.event_name == 'workflow_dispatch'`.
`platform-windows.if` becomes
`github.event_name == 'workflow_dispatch' && (github.event.inputs.lane == '' || github.event.inputs.lane == 'all')`
so a `lane=macos-control` dispatch skips Windows (skipped passes the aggregate)
while a plain dispatch behaves exactly as today. `tests/ci-workflows.test.ts`
asserts the input block and both `if` strings.

`tests/ci-workflows.test.ts` edits, same commit (line numbers at `9c0e3ca80`):
- `:100-106` timeout ownership: `platform-macos` 20, `macos-control` 30.
- `:169-173` and `:317-329` ("every root-suite job" fetch-tags and GUI-build
  invariants): the iterated job list gains `macos-control`; both jobs must keep
  `fetch-tags: true` and the `Build GUI` step.
- `:188-192` aggregate: `ci.needs` must contain `macos-control` (it would fail
  otherwise, which is the right signal).
- `:216-246` sharded-versus-control: `platform-macos` steps contain
  `--shard=${{ matrix.shard }}/2` and `strategy.matrix.shard` equals `[1, 2]`;
  `macos-control` steps contain the unsharded `bun test --isolate --timeout 60000 tests`
  line and no `--shard`. `platform-macos.needs === "changes"` and its `if`
  stay; `macos-control.if === "github.event_name == 'workflow_dispatch'"`.
- `:291-304` crash-signature consumers run over both jobs' Test steps.
- `:490-495` is the list of jobs that must carry the PR/push scoped `if`;
  `macos-control` is dispatch-only and is asserted in its own block, NOT added
  to this list.

PR 7 merge gate: because this PR replaces the whole-pool control that today
runs on every push, ordinary exact-head `ci` is not enough. Before merge, push
the PR head to an immutable `codex/ci-dispatch-<sha>` ref and run
`gh workflow run ci.yml --ref <that ref> -f lane=macos-control`; the run must
show `macos 1/2`, `macos 2/2`, `macos control` green and `windows */4` skipped,
so the aggregate `ci` on that SHA is green rather than red on someone else's
Windows burn-down. The branch is only immutable by convention: immediately
before merge, `gh run view <id> --json headSha` must equal
`gh pr view <n> --json headRefOid`, and both must equal the SHA being merged. Record the
run id in `041`. Delete the ref afterwards.

Stale comment at `ci.yml:450-452` ("5m23s, cheapest") is deleted in the same PR.

## 5. Measurement

Before: 003 §1 table (10 runs, macos mean 14.87, wall mean 15.38).
After PR 7 merges: the next 5 `dev` push runs, same `gh run view --json jobs`
extraction, recorded in `041_shard_measurement.md`. Criterion c-4 is met when
the mean wall drops below 10 min with both macOS shards green.

## 6. Verification per PR

As in 030 §4 plus, for each move PR, the exact-head `ci` run must show
`test 1/4..4/4`, `storage policy`, `api usage`, `macos` green, which is the
proof that discovery, the batch script and the isolated jobs all still find
the moved files.

