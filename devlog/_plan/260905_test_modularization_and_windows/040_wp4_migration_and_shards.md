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

Total moved: 1045 root files minus 3 kept at root = 1042 across slices 1-6;
the existing `images/ videos/ e2e-style/` stay.

## 2. Per-slice procedure (identical for PRs 1-6)

```bash
git switch -c codex/layout-<slice> origin/dev
for d in <domains>; do bun scripts/test-layout/move.ts --domain $d; done   # exits 2 on MANUAL lines
# hand-edit every MANUAL <file>:<line>; re-run verify
bun scripts/test-layout/verify.ts --domain <each>
# append the domains to layout.migrated in scripts/test-layout/layout.json
bun test tests/test-layout.test.ts tests/test-runner.test.ts <the domain dirs>
bun x tsc --noEmit
bun run test:changed          # on macmini-cf if the slice is large
bun run privacy:scan
git add -A && git commit -m "test(layout): move <domains> into tests/<domain>/ (#<issue>)"
gh pr create --base dev ...   # Summary / Verification / Checklist filled
```

Serial lanes: when a slice moves one of the six `SERIAL_FULL_SUITE_FILES`, the
entry in `scripts/test.ts` becomes `"<domain>/<basename>"` and the matching
`tests/test-runner.test.ts` expectations change in the same commit:

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
`name: macos control`, `if: github.event_name == 'workflow_dispatch'`, no
matrix, unchanged 30-minute budget and the unsharded `bun test ... tests` line.
Added to the `ci` aggregate `needs` list (a skipped result passes the allowlist).

`tests/ci-workflows.test.ts` edits, same commit:
- line 103: `timeout-minutes` 30 -> 20 for `platform-macos`; add a 30 assertion for `macos-control`.
- lines 222-223: the shard-free assertion moves to `macos-control`; `platform-macos` asserts the `--shard=` argument and `matrix.shard` `[1, 2]`.
- the crash-signature loop (301-306) runs for both jobs.
- line 491 list gains `macos-control`.
- the `ci` needs assertion gains `macos-control`.

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

