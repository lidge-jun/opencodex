# 040 — wp4: bounded fixes for open bug issues (one PR each, independent)

Source: `004_lane_bug_issues.md` (lane D), dispositions in `006_dispositions.md` Family 4.
Base: `origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9` (`Merge pull request #4037 from lidge-jun/codex/prs-stack-record`),
version line 2.49.0. Research worktree `/tmp/ocx-249.xGQnxl/wt` (detached, read-only). Verification ran
in a throwaway scratch worktree detached at the same SHA with `node_modules` symlinked from the main
checkout; it has been removed, and everything needed to reproduce it is in this document.
`origin/dev` was re-fetched immediately before this document was written and is still `7dc7dc99e`,
so every line number below is live.

## Objective

Land four independently revertible fixes for open bug issues that lane D proved are real defects on
`dev` with no owning PR. Each is one PR, one issue, one source concern, and each carries its own
regression test. They are file-disjoint from each other and from wp1/wp2/wp3, so they can run in
parallel worktrees; the stack order below exists to make a red lane attributable, not because any pair
conflicts.

Every diff in this document was applied in the scratch worktree and verified: the named focused test was
run RED before the fix and GREEN after, and `bun x tsc --noEmit` exits 0 with all four applied together.
Counts are pasted verbatim from those runs.

**One finding changes the shape of item 4.** #3807's reported reproduction — the Codex desktop sub-agent
seed with no `call_id` field — **already works on current `dev`**. Lane D read the guard at
`core.ts:6092-6106` and confirmed it unchanged since #3471, which is true, but the guard is no longer
reached for that shape: `a73bb160f` (2026-09-06, released in **v2.44.0**) added
`externalTaskInputContent()`, which admits a complete task-input envelope as user text before the guard
runs. I verified this by calling the real function rather than reading it. What remains broken is
narrower and is what this PR fixes. Details and the probe output are in the item-4 section; the maintainer
should read that before approving, because it changes the issue's closing comment.

## Preconditions

- Head SHA to branch from: `7dc7dc99e`. Re-verify with `git fetch origin dev` before each branch; if
  `dev` has moved, rebase and re-run the item's focused test before pushing.
- **CI approval gate.** Lanes B and C found that contributor PRs carry **no `ci.yml` run at head** (fork
  approval gate, `action_required`), so their green marks are hygiene gates only. wp4 is not affected by
  that specific gate — every PR here is maintainer-authored on a branch in the main repository, so
  `ci.yml` starts automatically. The rule that still binds: **a check rollup is evidence only when it is
  bound to the exact head SHA**, and `SKIPPED`/`CANCELLED` is never a pass. Each procedure below
  dispatches or watches CI at the exact head before merging.
- Merge authority: `MAINTAINERS.md` permits a maintainer with `maintain`/`admin` to integrate their own
  PR into `dev` without a second approval, recording the decision and exact-head CI evidence. That is what
  `--admin` is doing in each procedure; it is not a bypass of CI.
- Hooks: every mutating Git command uses `git -c core.hooksPath=/dev/null`. The repository's `postmerge`
  hook installs dependencies and runs typecheck, which is out of scope for this cycle.
- Pushes use `--no-verify` per the unit's constraint. No local product suite is run beyond the named
  focused tests and `tsc`.
- `Closes #N` in a PR body **does not auto-close** these issues: GitHub only auto-closes on merge into the
  default branch (`main`), and these PRs target `dev`. Each procedure therefore ends with an explicit
  `gh issue close` step after the merge is proven on `dev`.
- None of these four issues has an author to co-credit: all four are maintainer-authored fixes for
  third-party **reports**, not carries of contributor **commits**, so no `Co-authored-by` trailer is
  required. Reporters are `tizerluo` (#4032), `h-dot-seo` (#4035), `tommy1616` (#4023),
  `DaveW001` (#3807); thank them in the closing comment, not in a trailer.

## Stack order and conflict map

Order: **#4032 → #4035 → #4023 → #3807**, descending by confidence and ascending by blast radius. They
are fully independent; this is a serialization preference, not a dependency chain.

| # | Issue | Source files | Test files | Why here |
|---|-------|--------------|------------|----------|
| 1 | #4032 | `src/codex/catalog/provider-fetch.ts` | new `tests/codex-integration/catalog-hub-context-window.test.ts` + 2 layout registries | One argument added to an existing list; smallest possible blast radius |
| 2 | #4035 | `src/codex/runtime.ts` | `tests/codex-integration/codex-runtime.test.ts` | Adds a delete path; bounded by three conditions |
| 3 | #4023 | `src/service.ts`, `src/server/management-api.ts` | `tests/service/stop-deferred-teardown.test.ts` | Two source files, one of them large and frequently edited |
| 4 | #3807 | `src/responses/task-input.ts` | `tests/responses/responses-compaction-routing.test.ts` | Changes an admission contract and **edits two landed #3735 assertions**; needs the most reviewer attention |

Conflicts with other work-phases: **none**. 006's conflict map assigns `provider-fetch.ts`,
`runtime.ts`, `management-api.ts`, `service.ts` and `responses/core.ts` to wp4 only. Two
refinements from building the fixes:

- Item 4 touches `src/responses/task-input.ts`, **not** `src/server/responses/core.ts`. The guard in
  `core.ts` is left byte-identical, which is why this fix does not weaken #3259 (see item 4).
- Item 1 adds a test file, so it touches `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json` — the two registries 006 shares with #3920 (wp2) and
  #3914/#3915 (wp3). Both are one-line insertions into a sorted map. **Regenerate on rebase; never
  hand-merge.** Land item 1 before or after that group, not concurrently in the same rebase window.

## Per-item procedure

Common preamble for every item (`$OCX_MAIN` is the main checkout; pick any scratch parent):

```bash
OCX_MAIN=/Users/jun/Developer/new/700_projects/opencodex
OCX_WP4_DIR=$(mktemp -d)
git -C "$OCX_MAIN" fetch origin dev
git -C "$OCX_MAIN" rev-parse origin/dev   # expect 7dc7dc99e65268bc8764e19840952256b030bce9
```

---

### Item 1 — #4032: chained clients drop per-model context windows

**Branch:** `codex/260909-fix-4032` · **Base:** `dev` · **Disposition:** REIMPLEMENT (C1)

**Defect.** `catalogHintsFromModelsApiItem` reads the capability record for output tokens
(`provider-fetch.ts:1420`) but never for the context window, so a hub serving
`capabilities.context_length: 922000` produces a window-less row and materialization applies the 128k
floor at `parsing.ts:566`. Lane D's line citations were to `src/codex/catalog/provider-fetch.ts`
(006 abbreviates the path to `src/providers/provider-fetch.ts`; the file is under `src/codex/catalog/`).

**Fix (verified).** One argument appended to the existing `positiveSafeInteger` list, last, so no provider
that already resolves a window changes behavior.

```diff
diff --git a/src/codex/catalog/provider-fetch.ts b/src/codex/catalog/provider-fetch.ts
index dab45af38..54a43c823 100644
--- a/src/codex/catalog/provider-fetch.ts
+++ b/src/codex/catalog/provider-fetch.ts
@@ -1414,6 +1414,13 @@ export function catalogHintsFromModelsApiItem(providerName: string, item: Provid
       // supplying a recognized field changes behavior (#1797).
       plainRecord(item.meta)?.n_ctx,
       plainRecord(item.meta)?.n_ctx_train,
+      // A chained OpenCodex hub (and other re-serving gateways) reports the per-model
+      // window on the same capability record this function already reads for
+      // `max_output_tokens` below (#4032). Without it every routed row fell through to
+      // the 128k compatibility floor in parsing.ts while local forward rows kept their
+      // real values. Appended after the recognized fields for the same reason as the
+      // llama.cpp entries above: no provider that already resolves changes behavior.
+      capabilityRecord?.context_length,
     );
   const maxInputTokens = positiveSafeInteger(limits?.max_input_tokens, item.max_input_tokens);
   const maxOutputTokens = positiveSafeInteger(
```

**Regression test (new file).** `tests/codex-integration/catalog-hub-context-window.test.ts`, 71 lines,
6 tests. It pins the fix (hub shape resolves 922000, both at `item.capabilities` and
`metadata.capabilities`), the ordering contract (a recognized `context_length` and Copilot's
`max_context_window_tokens` both still win), and the type boundary (0, negative, and string are ignored).
Domain `codex-integration` matches its siblings `catalog-llamacpp-capabilities.test.ts` and
`catalog-input-modality-enum.test.ts`. The full verbatim body is in **Appendix A1** of this document.

**Layout registration (required — the file name matches no regex seed).** One line in each, in sorted
position:

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ -268,4 +268,5 @@
     "catalog-go-exact-efforts.test.ts": "codex-integration",
     "catalog-input-modality-enum.test.ts": "codex-integration",
+    "catalog-hub-context-window.test.ts": "codex-integration",
     "catalog-llamacpp-capabilities.test.ts": "codex-integration",
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ -103,4 +103,5 @@
   "catalog-go-exact-efforts.test.ts": "codex-integration",
   "catalog-input-modality-enum.test.ts": "codex-integration",
+  "catalog-hub-context-window.test.ts": "codex-integration",
   "catalog-llamacpp-capabilities.test.ts": "codex-integration",
```

**Measured focused results.**

| Check | Before fix | After fix |
|---|---|---|
| `bun test tests/codex-integration/catalog-hub-context-window.test.ts` | **4 pass / 2 fail** (6 tests, 8 expect) | **6 pass / 0 fail** (8 expect) |
| Layout + neighbours (5 files, below) | — | **96 pass / 0 fail** (926 expect) |

Neighbour set run together: `tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`,
`tests/codex-integration/catalog-llamacpp-capabilities.test.ts`,
`tests/codex-integration/catalog-input-modality-enum.test.ts`,
`tests/providers/provider-model-discovery-contract.test.ts`.

**Commands.**

```bash
cd "$OCX_MAIN"
git -c core.hooksPath=/dev/null worktree add -b codex/260909-fix-4032 "$OCX_WP4_DIR/4032" origin/dev
cd "$OCX_WP4_DIR/4032"
[ -d node_modules ] || ln -s "$OCX_MAIN/node_modules" node_modules

# apply the source hunk + the two registry lines, then add the new test file
# (verbatim body: Appendix A1 of this document)

bun test tests/codex-integration/catalog-hub-context-window.test.ts          # expect 6 pass / 0 fail
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts \
  tests/codex-integration/catalog-llamacpp-capabilities.test.ts \
  tests/codex-integration/catalog-input-modality-enum.test.ts \
  tests/providers/provider-model-discovery-contract.test.ts                  # expect 96 pass / 0 fail
bun x tsc --noEmit                                                           # expect exit 0

git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null commit -m "fix(catalog): read the hub capability context window (#4032)"
git -c core.hooksPath=/dev/null push --no-verify -u origin codex/260909-fix-4032

cat > /tmp/ocx-pr-4032.md <<'BODY'
## Summary

A chained client (a provider hub re-serving an upstream catalog) reports each model's context window
under `capabilities.context_length`. `catalogHintsFromModelsApiItem` already read that same capability
record for `max_output_tokens`, but never for the context window, so every routed row arrived
window-less and materialization applied the 128k compatibility floor
(`src/codex/catalog/parsing.ts:566`) while local forward rows kept their real values.

Trigger: a hub serving `capabilities.context_length: 922000` produced `context_window: 128000` on
every chained row. After this change the same catalog resolves 922000.

The capability field is appended LAST in the `positiveSafeInteger` list, after the recognized
metadata/limits fields and after the Copilot-specific `capabilities.limits.max_context_window_tokens`,
so no provider that already resolved a window changes behaviour. That ordering is asserted by the new
tests, not just intended.

Closes #4032

## Verification

- `bun test tests/codex-integration/catalog-hub-context-window.test.ts` — new file: 4 pass / 2 fail
  before the fix, 6 pass / 0 fail after.
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/codex-integration/catalog-llamacpp-capabilities.test.ts tests/codex-integration/catalog-input-modality-enum.test.ts tests/providers/provider-model-discovery-contract.test.ts` — 96 pass / 0 fail.
- `bun x tsc --noEmit` — exit 0.
- Full local suite NOT run (maintainer directive for this cycle); hosted CI at the exact head is the gate.

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed. (No user-facing surface change; a previously
      dropped upstream value is now read.)
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults. (Catalog
      metadata parsing only; no auth, credential, or workflow surface.)
BODY

gh pr create --repo lidge-jun/opencodex --base dev --head codex/260909-fix-4032 --draft=false \
  --title "fix(catalog): read the hub capability context window (#4032)" \
  --body-file /tmp/ocx-pr-4032.md
```

**CI, merge, close.** This block is the template for all four items; only the numbers change.

```bash
PR=<number>
HEAD_SHA=$(gh pr view $PR --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)
gh pr checks $PR --repo lidge-jun/opencodex --watch

# Bind the rollup to the EXACT head; SKIPPED/CANCELLED is not a pass.
gh api repos/lidge-jun/opencodex/commits/$HEAD_SHA/check-runs \
  --jq '.check_runs[] | "\(.conclusion)\t\(.name)"' | sort
# If a lane is missing at head, dispatch it and re-check:
# gh workflow run ci.yml --repo lidge-jun/opencodex --ref codex/260909-fix-4032 -f lane=all

gh pr merge $PR --repo lidge-jun/opencodex --squash --admin

git -C "$OCX_MAIN" fetch origin dev
MERGED=$(gh pr view $PR --repo lidge-jun/opencodex --json mergeCommit --jq .mergeCommit.oid)
git -C "$OCX_MAIN" merge-base --is-ancestor "$MERGED" origin/dev && echo "landed on dev"

# `Closes #4032` only auto-closes on merges into `main`; this PR targeted `dev`, so close manually.
gh issue close 4032 --repo lidge-jun/opencodex --comment "$(cat /tmp/ocx-close-4032.md)"
```

Closing comment for #4032 (write to `/tmp/ocx-close-4032.md` first, so the backticks survive):

> Fixed on `dev` via #<PR> (<merge-sha>). `catalogHintsFromModelsApiItem` now reads
> `capabilities.context_length` from the same capability record it already used for
> `max_output_tokens`, so a chained hub's per-model window survives instead of falling through to the
> 128k floor. Regression coverage: `tests/codex-integration/catalog-hub-context-window.test.ts`, which
> also pins that a recognized `context_length` and Copilot's `max_context_window_tokens` still take
> precedence, so no provider that already resolved a window changes behaviour.
>
> Thanks for locating the exact asymmetry between the two reads — that is what made this a
> one-argument fix. Out of scope and still open for discussion: consuming `GET /v1/catalog` in the
> provider sync path, and the single- vs multi-slash id normalization.

---

### Item 2 — #4035: dead `codex-runtime.json` pin is never retired

**Branch:** `codex/260909-fix-4035` · **Base:** `dev` · **Disposition:** REIMPLEMENT (C2)

**Defect.** A Codex App update replaces the hashed plugin directory the pin names. The probe correctly
rejects the vanished path (`runtime.ts:293` on dev, `:312` after the patch), nothing else resolves, and
the selection degrades to `fallback` — which the persist guard at `runtime.ts:647` (`:664` after)
declines to write. The dead entry survives forever and every later resolve re-probes a path that cannot
exist.

**Fix (verified).** Retire the pin instead of merely skipping the write, bounded by three conditions: the
degraded result is `fallback`, the failure names the persisted command, and the rejection reason is
exactly `path does not exist`. A present-but-unusable binary is left alone for the operator.

```diff
diff --git a/src/codex/runtime.ts b/src/codex/runtime.ts
index 51150e6aa..4c1914cbf 100644
--- a/src/codex/runtime.ts
+++ b/src/codex/runtime.ts
@@ -86,6 +86,8 @@ export interface PersistedCodexRuntimeState {
 
 const PERSIST_FILE = "codex-runtime.json";
 const CLAMP_PERSIST_FILE = "codex-runtime-clamp.json";
+/** Probe rejection for an absolute candidate whose file is gone. Matched when retiring a dead pin (#4035). */
+const PATH_MISSING_REASON = "path does not exist";
 
 function cloneAndDeepFreeze<T>(value: T): DeepReadonly<T> {
   const clone = (current: unknown): unknown => {
@@ -283,6 +285,23 @@ export function persistCodexRuntime(
   atomicWriteFile(codexRuntimeStatePath(configDir), `${JSON.stringify(payload, null, 2)}\n`);
 }
 
+/**
+ * Delete `codex-runtime.json`. Used to retire a pin whose path no longer exists, so a
+ * later resolve stops re-probing it (#4035).
+ *
+ * Invalidates the process resolve memo the same way `persistCodexRuntime` does: the memo
+ * folds the persisted `updatedAt` into its key, and a removed file has no stamp to fold.
+ */
+export function clearPersistedCodexRuntime(deps: ResolveCodexRuntimeDeps = {}): void {
+  const configDir = deps.configDir ?? getConfigDir();
+  clearCodexRuntimeResolveCache();
+  try {
+    unlinkSync(codexRuntimeStatePath(configDir));
+  } catch {
+    // Already gone, or not ours to remove. Either way the pin is not authoritative.
+  }
+}
+
 function probeVersion(
   command: string,
   deps: ResolveCodexRuntimeDeps,
@@ -290,7 +309,7 @@ function probeVersion(
   const platform = deps.platform ?? process.platform;
   if (command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command)) {
     const exists = deps.existsSync ?? existsSync;
-    if (!exists(command)) return { ok: false, reason: "path does not exist" };
+    if (!exists(command)) return { ok: false, reason: PATH_MISSING_REASON };
     if (!isSpawnableCodexCandidate(command, platform)) {
       return { ok: false, reason: "not a spawnable Codex launcher on this platform" };
     }
@@ -654,6 +673,20 @@ export function resolveAndPersistCodexRuntime(
       return cloneAndDeepFreeze({ ...result, persistError });
     }
   }
+  // A pin whose path has vanished must be RETIRED, not merely skipped. A Codex App update
+  // replaces the hashed plugin directory the pin names, the probe rejects it with
+  // "path does not exist", nothing else resolves, and the selection degrades to `fallback` —
+  // which the write guard above declines. The dead entry then survived every later resolve
+  // and each one re-probed a path that cannot exist (#4035). Bound narrowly: only when the
+  // degraded result is `fallback`, only for the persisted command, and only for the
+  // path-does-not-exist rejection, so a present-but-unusable binary is left for the operator.
+  else if (result.runtime.source === "fallback" && persistedRuntime?.command) {
+    const pinVanished = result.failures.some(
+      failure => sameRuntimeCommand(failure.command, persistedRuntime.command)
+        && failure.reason === PATH_MISSING_REASON,
+    );
+    if (pinVanished) clearPersistedCodexRuntime(deps);
+  }
   return result;
 }
```

**Regression test.** 71 lines appended to `tests/codex-integration/codex-runtime.test.ts` as
`describe("dead configured pin recovery (#4035)")`, 4 tests: the dead pin is removed after one resolve
with an empty `PATH`; a fallback resolve with no pin writes nothing; a **live** pin is not cleared when
the resolve succeeds; and a pin rejected for `unrecognized --version output` is left in place. The last
two are what make the bound real rather than asserted. No layout registration needed — existing file.

**Measured focused results.**

| Check | Before fix | After fix |
|---|---|---|
| `bun test tests/codex-integration/codex-runtime.test.ts` | **36 pass / 1 fail** (37 tests, 135 expect) | **37 pass / 0 fail** (136 expect) |

The single RED failure was exactly the intended one:
`dead configured pin recovery (#4035) > a dead configured pin is cleared when resolution degrades to fallback`,
`Expected: false, Received: true` on the file's existence. The other three passed before the fix, which is
what proves they are bound-checks and not restatements of the change.

**Commands.**

```bash
cd "$OCX_MAIN"
git -c core.hooksPath=/dev/null worktree add -b codex/260909-fix-4035 "$OCX_WP4_DIR/4035" origin/dev
cd "$OCX_WP4_DIR/4035"
[ -d node_modules ] || ln -s "$OCX_MAIN/node_modules" node_modules
# apply the two hunks above, append the test block

bun test tests/codex-integration/codex-runtime.test.ts   # expect 37 pass / 0 fail
bun x tsc --noEmit                                       # expect exit 0

git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null commit -m "fix(codex): retire a codex-runtime.json pin whose path is gone (#4035)"
git -c core.hooksPath=/dev/null push --no-verify -u origin codex/260909-fix-4035
gh pr create --repo lidge-jun/opencodex --base dev --head codex/260909-fix-4035 --draft=false \
  --title "fix(codex): retire a codex-runtime.json pin whose path is gone (#4035)" \
  --body-file /tmp/ocx-pr-4035.md
```

PR body — Summary section (Verification and Checklist follow item 1's shape, substituting the counts
from the table above and keeping the "Full local suite NOT run" line):

> A persisted `codex-runtime.json` pin whose path no longer exists was never removed. When a Codex App
> update replaces the hashed plugin directory the pin names, the probe rejects the vanished path, no
> other candidate resolves, and the selection degrades to `fallback` — which the persist guard declines
> to write. The dead entry survived every later resolve, and each one paid a failing probe against a
> path that cannot exist.
>
> `resolveAndPersistCodexRuntime` now deletes the file in exactly that case. The condition is narrow on
> purpose: the resolved source must be `fallback`, a failure must name the persisted command, and its
> reason must be `path does not exist`. A pin that is present but unusable (for example
> `unrecognized --version output`) is left alone, since that is an operator's problem to see rather than
> state to silently discard.
>
> Out of scope, as the issue thread notes: adding the stable Codex App plugin location as a discovery
> candidate, and refreshing `selectedVersion` on drift. Both need a product decision.
>
> Closes #4035

Then run the shared CI/merge/close block with `PR=<number>` and
`gh issue close 4035`. The closing comment should name the three bound conditions, state that
`ocx doctor --fix-codex-runtime` remains the manual escape hatch, and say that the discovery-candidate
half stays open for a separate decision.

---

### Item 3 — #4023: macOS Stop unloads launchd before native teardown

**Branch:** `codex/260909-fix-4023` · **Base:** `dev` · **Disposition:** REIMPLEMENT (C2)

**Defect.** `management-api.ts:315` calls `stopServiceIfInstalledDetailed()`, which on darwin is
`launchctl unload` against the plist that owns **this** process (`service.ts:3931` → `:2351`). The
shared teardown that restores the native Codex keys does not run until `:348`. The guard that prevents
exactly this on Windows returns early for every other platform (`service.ts:3866`), so the
`respawnable_service` 409 can never fire on macOS and the unload can kill the handler mid-route —
matching the reporter's residue of `openai_base_url`, `experimental_realtime_ws_base_url` and
`model_catalog_json`.

**Which option, and why.** Lane D offered (a) reorder teardown before the manager stop, or (b) extend the
risk probe and refuse like Windows. **Take (b).** Option (a) is not available:
`tests/providers/xai/grok-lifecycle.test.ts:448` asserts `if (serviceStop === "failed")` precedes
`await performStopTeardown`, which is the landed #3008 contract — tearing down shared config while a
manager that refused to stop is still alive is the harm that assertion exists to prevent. Reordering
would reintroduce it on macOS to fix a different race. Option (b) is smaller, strictly safer, and reuses
the refusal shape already in the route.

**Discriminator.** The risk is not "a service is installed" but "this process **is** the managed job".
`OCX_SERVICE=1` is set by the plist (`service.ts:510`) and the Windows wrapper (`:1752`) and by
nothing else, so it distinguishes a self-unload from a manually started proxy that merely has a service
installed. Both that and the definition file's existence are checked.

**Fix (verified), file 1 of 2.**

```diff
diff --git a/src/service.ts b/src/service.ts
index fa8770ec5..687bce2c2 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -3860,10 +3860,28 @@ export async function installFreshWindowsSchedulerSafely(
 export function installedServiceRespawnRisk(
   probe: () => WindowsSchedulerTaskProbe = probeWindowsSchedulerTask,
   platform: NodeJS.Platform = process.platform,
-): "none" | "respawnable" | "unknown" {
+  io: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
+): "none" | "respawnable" | "unknown" | "self-unload" {
   // launchd, systemd and WinSW are down when they report stopped; only the Task Scheduler
   // wrapper survives its task ending (#764).
-  if (platform !== "win32") return "none";
+  //
+  // "Down when they report stopped" answers the RESPAWN question but not the SELF-UNLOAD
+  // one (#4023). When the proxy is itself the managed job, `launchctl unload` /
+  // `systemctl stop` terminate this very process, so the manager stop can kill the request
+  // handler before the shared teardown restores the native Codex config keys — leaving
+  // `openai_base_url`, `experimental_realtime_ws_base_url` and `model_catalog_json`
+  // pointed at a proxy that is gone. Reordering teardown ahead of the manager stop is not
+  // available here: the #3008 contract requires the manager to be proven stopped first.
+  // So refuse, exactly as Windows does, and send the operator to `ocx stop`, which stops
+  // the proxy from the outside and owns the teardown through its receipt.
+  if (platform !== "win32") {
+    const env = io.env ?? process.env;
+    if (env.OCX_SERVICE !== "1") return "none";
+    const exists = io.exists ?? existsSync;
+    if (platform === "darwin") return exists(plistPath()) ? "self-unload" : "none";
+    if (platform === "linux") return exists(unitPath()) ? "self-unload" : "none";
+    return "none";
+  }
   try {
```

**Fix (verified), file 2 of 2.** Inserted between the `respawnable` and `unknown` branches, so the
refusal still happens before `stopServiceIfInstalledDetailed()` is reached.

```diff
diff --git a/src/server/management-api.ts b/src/server/management-api.ts
index c703a33e0..118afd5ff 100644
--- a/src/server/management-api.ts
+++ b/src/server/management-api.ts
@@ -300,6 +300,20 @@ export async function handleManagementAPI(
         message: "This proxy is managed by a Task Scheduler wrapper that can respawn it, so the stop must be run by `ocx stop`, which verifies the respawn window. Nothing was changed.",
       }, 409, req, config);
     }
+    if (respawnRisk === "self-unload") {
+      // This proxy IS the launchd/systemd job, so stopping the manager below would
+      // terminate the handler before the shared teardown at the end of this route restores
+      // the native Codex keys — the dashboard Stop button left `openai_base_url`,
+      // `experimental_realtime_ws_base_url` and `model_catalog_json` pointed at a dead
+      // proxy (#4023). Refuse before touching anything, like the Windows branch above.
+      // `ocx stop` is safe because it runs outside this process and owns the teardown
+      // through its receipt, which is why the receipt-backed caller never reaches here.
+      return jsonResponse({
+        success: false,
+        code: "self_unload_service",
+        message: "This proxy is running as the installed service, so stopping the manager from inside it would end this process before native Codex is restored. Run `ocx stop`, which stops the service from outside and completes the restore. Nothing was changed.",
+      }, 409, req, config);
+    }
     if (respawnRisk === "unknown") {
```

**Linux is answered in the same PR**, as lane D asked: `:3866` exempted systemd identically, and the
systemd branch (`service.ts:3963`) is the same self-stop, so it gets the same verdict and its own test.

**`ocx stop` is unaffected.** It claims a receipt (`src/cli/index.ts:853`) and the route computes
`holdsReceipt ? "none" : installedServiceRespawnRisk()`, so the receipt-backed caller never reaches the
new branch. A test pins that.

**Regression test.** 72 lines appended to `tests/service/stop-deferred-teardown.test.ts` as
`describe("self-unloading manager refusal (#4023)")`, 7 tests: darwin and linux managed jobs both report
`self-unload`; a manually started proxy with a service installed reports `none`; a managed job with no
definition file reports `none`; Windows classification is unchanged; the route refuses before touching
the manager; and the `ocx stop` deferral path is intact. Two imports are prepended to the file
(`readFileSync` from `node:fs`, `repoPath` from `../helpers/repo-root`) for the route
source-oracle assertion. No layout registration needed.

**Measured focused results.**

| Check | Before fix | After fix |
|---|---|---|
| `bun test tests/service/stop-deferred-teardown.test.ts` | **30 pass / 3 fail** (33 tests, 102 expect) | **33 pass / 0 fail** (105 expect) |
| `bun test tests/providers/xai/grok-lifecycle.test.ts` (#3008 contract) | — | **32 pass / 0 fail** (248 expect) |

The three RED failures were the darwin risk, the linux risk, and the route refusal. The
`grok-lifecycle` run is the important one: it proves the added branch did not disturb the landed #3008
ordering assertions, including `a respawnable backend is refused BEFORE the manager is touched`.

**Commands.**

```bash
cd "$OCX_MAIN"
git -c core.hooksPath=/dev/null worktree add -b codex/260909-fix-4023 "$OCX_WP4_DIR/4023" origin/dev
cd "$OCX_WP4_DIR/4023"
[ -d node_modules ] || ln -s "$OCX_MAIN/node_modules" node_modules
# apply both hunks, append the test block and its two imports

bun test tests/service/stop-deferred-teardown.test.ts      # expect 33 pass / 0 fail
bun test tests/providers/xai/grok-lifecycle.test.ts        # expect 32 pass / 0 fail
bun x tsc --noEmit                                         # expect exit 0

git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null commit -m "fix(service): refuse a stop that would self-unload the manager (#4023)"
git -c core.hooksPath=/dev/null push --no-verify -u origin codex/260909-fix-4023
gh pr create --repo lidge-jun/opencodex --base dev --head codex/260909-fix-4023 --draft=false \
  --title "fix(service): refuse a stop that would self-unload the manager (#4023)" \
  --body-file /tmp/ocx-pr-4023.md
```

The PR body Summary must state the behaviour change plainly: **the dashboard Stop button now returns
409 `self_unload_service` instead of stopping, when the proxy is running as the installed
launchd/systemd service.** That is a deliberate, user-visible change — the previous behaviour appeared
to work while sometimes leaving client config pointed at a dead proxy. The message names `ocx stop`.
Include `Closes #4023`.

**Title trap.** This PR touches no GUI files, so no screenshot is required — but `enforce-target` demands
a screenshot from any PR whose **title or description** mentions `gui`. Write "dashboard Stop button",
never the three letters, in both title and body.

Check whether the management API's stop endpoint is documented under `docs-site/` before opening; if it
is, document the new 409 code in the same PR and tick the docs checklist honestly either way.

Then run the shared CI/merge/close block with `gh issue close 4023`. The closing comment should name
the new 409, state that Linux systemd was fixed in the same change, and note that `ocx stop` is the
supported path because it stops the service from outside and owns the teardown receipt.

---

### Item 4 — #3807: unpaired-tool-result guard and the sub-agent seed

**Branch:** `codex/260909-fix-3807` · **Base:** `dev` · **Disposition:** REIMPLEMENT (C2), **rescoped**

**Read this before approving.** Lane D's verdict rested on the guard at `core.ts:6092-6106` being
unchanged since #3471 and on `9cde6e735` having landed only tests. Both facts are true. The conclusion
that the reported failure is still live is **not**, and I verified that by executing the admission
function rather than reading it:

```
reporter curl probe (bare)           REJECTED-> guard 400
seed with id+name+namespace          ADMITTED as user text
seed WITHOUT namespace               REJECTED-> guard 400
seed with explicit null call_id      REJECTED-> guard 400
seed with empty-string call_id       REJECTED-> guard 400
seed with object output              REJECTED-> guard 400
```

`a73bb160f` (2026-09-06, `fix(responses): preserve complete external task-input envelopes`, first
released in **v2.44.0**) added `externalTaskInputContent()`, called from `src/responses/parser.ts:156`,
which turns a complete task-input envelope into a user message **before** the guard runs. The issue was
filed against 2.43.0. So the seed shape the issue describes — `id` + `name` + `namespace` +
`output`, no `call_id` field — already works on `dev` and has since v2.44.0. Note that the
reporter's bare `curl` probe stays 400: it carries no `id`/`name`/`namespace`, so it is an
incomplete envelope rather than the desktop seed, and #3735's completeness requirement still rejects it.

**What is still broken, and what this PR fixes.** The admission test is `"call_id" in item` — presence of
the **field**, not presence of a **key**. A client that emits `"call_id": null` or `"call_id": ""`
rather than omitting the field carries the identical seed with no pairing key, and is still answered
400. Neither value can ever pair with a `function_call`, so classifying it as a paired tool result is
wrong regardless of #3259.

This is a narrower fix than lane D proposed, and it is better in one specific way: it **does not touch
the guard**. Lane D's "synthesize a `call_`-prefixed id and continue" would fabricate a pairing that
matches no `tool_use`, which is exactly the anthropic-path question lane D flagged as the one judgment
call. Classifying an unpairable seed as task input instead means `core.ts` stays byte-identical, #3259's
protection is untouched, and **the anthropic tolerance question does not arise** — no synthesized id is
ever produced.

**Fix (verified).**

```diff
diff --git a/src/responses/task-input.ts b/src/responses/task-input.ts
index e72973ab9..44c636b6c 100644
--- a/src/responses/task-input.ts
+++ b/src/responses/task-input.ts
@@ -20,9 +20,29 @@ function supportedBlock(value: unknown): value is TaskInputBlock {
   return value.detail === undefined || (typeof value.detail === "string" && imageDetails.has(value.detail));
 }
 
+/**
+ * Does this item carry a pairing key? A tool result is paired by `call_id`; a seed is not.
+ *
+ * Presence of the FIELD is not presence of a KEY (#3807). Codex desktop seeds a sub-agent
+ * thread with a lone `function_call_output` that some client builds emit with an explicit
+ * `call_id: null` or `""` rather than omitting it. Those values can never pair with a
+ * `function_call`, so treating them as a paired result sent the item to the guard in
+ * core.ts and answered 400 for a turn that is really external task input.
+ *
+ * A wrong-typed key (number, object) is NOT relaxed: that is malformed input rather than
+ * the absent-pairing seed shape, and it keeps the #3259 rejection.
+ */
+function hasPairingKey(item: Record<string, unknown>): boolean {
+  if (!("call_id" in item)) return false;
+  const callId = item.call_id;
+  if (callId === null) return false;
+  if (typeof callId === "string") return callId.trim().length > 0;
+  return true;
+}
+
 /** Recognize Codex external task input without repairing ordinary orphaned tool results. */
 export function externalTaskInputContent(item: unknown): string | OcxContentPart[] | undefined {
-  if (!isObj(item) || item.type !== "function_call_output" || "call_id" in item) return undefined;
+  if (!isObj(item) || item.type !== "function_call_output" || hasPairingKey(item)) return undefined;
   if (!nonBlank(item.id) || !nonBlank(item.name) || !nonBlank(item.namespace)) return undefined;
   const output = item.output;
   if (typeof output === "string") return nonBlank(output) ? output : undefined;
```

**This edits two landed #3735 assertions — the reviewer's main decision.** `empty call id` and
`null call id` were rows in the `invalid` table at
`tests/responses/responses-compaction-routing.test.ts:2414`, asserting a 400. Those two rows are removed
and replaced by a positive test asserting 200 plus correct user-text translation. Everything else in
that table (`numeric call id`, `incomplete metadata`, `custom output`, `blank output`,
`empty output array`, `opaque output`, `mixed opaque output`, `malformed image`) is untouched
and still passes. Deliberately inverting a landed assertion belongs in the PR description rather than
buried in a diff, so put it in the Summary.

```diff
--- a/tests/responses/responses-compaction-routing.test.ts
+++ b/tests/responses/responses-compaction-routing.test.ts
@@ -2393,6 +2414,4 @@ describe("external task-input envelopes (#3735)", () => {
 
   const invalid: Array<[string, Record<string, unknown>]> = [
-    ["empty call id", { ...external(), call_id: "" }],
-    ["null call id", { ...external(), call_id: null }],
     ["numeric call id", { ...external(), call_id: 42 }],
     ["incomplete metadata", { ...external(), namespace: "" }],
```

**Regression test.** Two additions to `tests/responses/responses-compaction-routing.test.ts`
(67 added / 2 removed):

1. Inside the existing `external task-input envelopes (#3735)` block, an end-to-end test driving
   `handleResponses` with `call_id: null` and `call_id: ""` through a translating
   `openai-chat` provider, asserting HTTP 200 and outbound
   `[{ role: "user", content: "seeded task" }]`.
2. A new `unusable-call_id task-input seed (#3807)` block, 6 unit tests on
   `externalTaskInputContent`: `null` admitted; `""` and whitespace admitted; the absent-field
   form still admitted (no regression on `a73bb160f`); a **real** `call_id` still rejected as task
   input; wrong-typed keys still rejected; and every other #3735 validation still enforced with an
   unusable `call_id` present.

No layout registration needed. The `unpaired tool result boundary (#3259)` block is untouched and still
passes, including `the same unpaired body on a passthrough route stays 200 and self-degrades`.

**Measured focused results.**

| Check | Before fix | After fix |
|---|---|---|
| `bun test tests/responses/responses-compaction-routing.test.ts` | **120 pass / 2 fail** (122 tests, 629 expect) | **121 pass / 0 fail** (121 tests, 626 expect) |

Test count drops by one because two table rows were replaced by one positive test. The intermediate
state is worth recording: with the source fix applied but the `invalid` table not yet updated, the run
was 120 pass / 2 fail with the failures being exactly `rejects empty call id before upstream work` and
`rejects null call id before upstream work` — the two landed assertions this change intentionally
inverts. Nothing else moved.

**A-phase reviewer checks (both must be answered before merge).**

1. **Is the rescope right?** The reporter's end-to-end symptom may already be fixed by `a73bb160f` in
   v2.44.0. Confirm with the reporter, who offered to re-test against a live proxy, before closing #3807
   as fixed by this PR. If they still reproduce on 2.44.0 or later, capture the exact item shape — this
   fix covers the `null`/`""` variants and nothing beyond them.
2. **The anthropic tolerance question lane D raised is now moot — verify that claim.** It applied to
   lane D's synthesize-an-id approach. This fix produces no synthesized id and does not modify
   `core.ts`, so no `tool_result` with a fabricated `tool_use_id` can reach
   `src/adapters/anthropic.ts`; what reaches it instead is an ordinary user message. Confirm by running
   `git diff origin/dev -- src/server/responses/core.ts` on the branch and seeing it empty.

**Commands.**

```bash
cd "$OCX_MAIN"
git -c core.hooksPath=/dev/null worktree add -b codex/260909-fix-3807 "$OCX_WP4_DIR/3807" origin/dev
cd "$OCX_WP4_DIR/3807"
[ -d node_modules ] || ln -s "$OCX_MAIN/node_modules" node_modules
# apply the task-input hunk, remove the two invalid rows, add both test blocks

bun test tests/responses/responses-compaction-routing.test.ts   # expect 121 pass / 0 fail
git diff origin/dev -- src/server/responses/core.ts             # expect EMPTY (guard untouched)
bun x tsc --noEmit                                              # expect exit 0

git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null commit -m "fix(responses): admit a task-input seed with an unusable call_id (#3807)"
git -c core.hooksPath=/dev/null push --no-verify -u origin codex/260909-fix-3807
gh pr create --repo lidge-jun/opencodex --base dev --head codex/260909-fix-3807 --draft=false \
  --title "fix(responses): admit a task-input seed with an unusable call_id (#3807)" \
  --body-file /tmp/ocx-pr-3807.md
```

PR body Summary must contain, in this order: the `null`/`""` defect and its 400; that the guard in
`core.ts` is deliberately unmodified so #3259 keeps its protection; that two assertions from #3735 are
intentionally inverted and why; and that the issue's originally reported shape was already fixed by
`a73bb160f` in v2.44.0. Include `Closes #3807`. Tick the security checklist with a real reason
(request-translation admission only; no auth, credential, or workflow surface).

The closing comment on #3807 must be honest about the rescope: the reported shape was fixed in v2.44.0
by `a73bb160f`, this PR fixes the residual `null`/`""` variants, and the reporter is invited to
reopen with an exact item capture if a current build still reproduces.

## Verification gates

Applied to every item, in order. A gate that did not run is recorded as NOT RUN, never as passing.

1. **RED before GREEN.** Run the named focused test before applying the source fix and paste the failing
   count. A test that passes before the fix is not covering the fix — three of item 2's four tests pass
   before it by design, because they are bound-checks; the item says which one is the RED one.
2. **Focused GREEN after.** Counts must match the tables above. A different count means the branch is
   not at `7dc7dc99e` or the diff was altered.
3. **Neighbour suites.** Item 1: layout + catalog neighbours (96 pass). Item 3: `grok-lifecycle`
   (32 pass) — this is the #3008 contract and is not optional. Items 2 and 4: the touched file is itself
   the neighbour suite.
4. **`bun x tsc --noEmit` exit 0** in the branch worktree.
5. **Exact-head hosted CI.** `gh pr checks <n> --watch`, then bind the rollup to the head SHA with
   `gh api repos/lidge-jun/opencodex/commits/$HEAD_SHA/check-runs`. `SKIPPED` and `CANCELLED` are
   not passes. If a lane is missing at head, dispatch it:
   `gh workflow run ci.yml --repo lidge-jun/opencodex --ref codex/260909-fix-<issue> -f lane=all`.
6. **Landing proof.** `git fetch origin dev && git merge-base --is-ancestor <merge-sha> origin/dev`.
7. **Issue closed manually** with an evidence-bearing comment, because `Closes` does not fire on `dev`.

**What was NOT RUN for this document.** Stated plainly so no reader over-reads the evidence:

- `bun run test` (full ~850-file suite) — **NOT RUN**, forbidden by this cycle's constraint and by this
  task's scope.
- `bun run test:changed` — **NOT RUN**. Item 3's route assertion reads `management-api.ts` as source
  text, which the import graph cannot see, so it would not have been selected anyway; that file is named
  explicitly instead.
- `bun run lint:gui`, `bun run build:gui` — **NOT RUN**. No GUI file is touched.
- `bun run privacy:scan` — **NOT RUN** here; required on the devlog commit and on each PR.
- Hosted CI — **NOT RUN**. No branch was pushed and no PR was opened by this task (read-only scope).
  Every CI claim in this document is a procedure to execute, not evidence obtained.
- Runtime behaviour on macOS/Linux for item 3 was **not** exercised against a real launchd/systemd job;
  the tests inject `env` and `exists`. A manual smoke on a machine with the service installed is
  worth doing before merge, and is the one gap in item 3's evidence.
- Item 4's rescope rests on executing `externalTaskInputContent` directly, **not** on an end-to-end Codex
  desktop reproduction. The reporter's confirmation is the missing half.
- `bun x tsc --noEmit` was verified to be a real check, not a no-op: injecting a deliberate type error
  into `src/` produced `error TS2322` and exit 1, and the file was removed afterwards.

All four diffs were applied together in a scratch worktree with tsc clean
(`308 insertions, 6 deletions` across 10 files + 1 new test file), which has since been removed. Every
diff hunk and test body needed to reproduce that state is reproduced verbatim in this document
(per-item sections plus Appendices A1–A4), so nothing depends on a temporary path surviving.

## Ledger rows

Append to `060` (execution ledger) on completion of each item, and roll up into `070`. One row per
item; fill `PR`, `Head SHA`, `CI`, `Merge SHA`, `Closed` at execution time.

```
| WP | Item | Type | Branch | PR | Head SHA | CI at head | Merge SHA | dev ancestor | Issue closed | Focused test evidence |
|----|------|------|--------|----|---------|-----------|-----------|--------------|--------------|----------------------|
| wp4 | #4032 | REIMPLEMENT C1 | codex/260909-fix-4032 | #____ | ________ | ____ | ________ | yes/no | #4032 ____ | catalog-hub-context-window RED 4/2 -> GREEN 6/0; neighbours 96/0; tsc 0 |
| wp4 | #4035 | REIMPLEMENT C2 | codex/260909-fix-4035 | #____ | ________ | ____ | ________ | yes/no | #4035 ____ | codex-runtime RED 36/1 -> GREEN 37/0; tsc 0 |
| wp4 | #4023 | REIMPLEMENT C2 | codex/260909-fix-4023 | #____ | ________ | ____ | ________ | yes/no | #4023 ____ | stop-deferred-teardown RED 30/3 -> GREEN 33/0; grok-lifecycle 32/0; tsc 0 |
| wp4 | #3807 | REIMPLEMENT C2 (rescoped) | codex/260909-fix-3807 | #____ | ________ | ____ | ________ | yes/no | #3807 ____ | responses-compaction-routing RED 120/2 -> GREEN 121/0; core.ts diff empty; tsc 0 |
```

Coverage contribution to the unit's 25–30 target: **4 issues removed**, 4 PRs opened and merged. 006
counts wp4 as surplus above the wp1+wp2+wp5 floor of 35, so any item may be dropped without endangering
the goal — drop from the bottom of the stack (#3807 first, since it needs reporter confirmation).

## Rollback

Each PR is one squash commit touching one concern, so each reverts independently.

```bash
git -C "$OCX_MAIN" fetch origin dev
git -c core.hooksPath=/dev/null revert --no-edit <merge-sha>     # on a branch, PR into dev
```

Per-item risk if a revert is needed:

- **#4032** — reverting restores the 128k floor on chained rows. No state is written and no migration
  runs, so the revert is free.
- **#4035** — reverting stops the pin from being retired. The only side effect the fix has is deleting a
  `codex-runtime.json` that names a nonexistent path; the next resolve rebuilds it from a valid
  candidate, so a revert leaves no corrupt state.
- **#4023** — reverting restores the dashboard Stop button's ability to stop a self-managed proxy, along
  with the teardown race. If the 409 proves too broad in the field (for example an environment that sets
  `OCX_SERVICE=1` outside the service), narrow the discriminator rather than reverting, since a revert
  reinstates the config residue this fix prevents.
- **#3807** — reverting re-rejects `call_id: null`/`""` seeds with 400 and restores the two #3735
  assertions. Because the fix touches only an admission predicate and writes no state, the revert is
  clean. If a *new* shape turns out to be wrongly admitted, narrow `hasPairingKey` instead, so the
  `null` seed stays fixed.

If `dev` advances between a branch's CI and its merge, do not merge on the older evidence: rebase,
re-run the item's focused test, and re-dispatch CI at the new head. Old CI is stale the moment `dev`
moves.

## Appendix — verbatim test bodies

These are the exact files/blocks verified in the scratch worktree. Copy them literally; the counts in
the tables above are only reproducible with these bodies.

### A1 — new file: `tests/codex-integration/catalog-hub-context-window.test.ts` (item 1)

```ts
import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";

/**
 * Regression coverage for #4032 (chained clients / provider hub).
 *
 * A hub that re-serves an upstream catalog reports the per-model window under
 * `capabilities.context_length`. `catalogHintsFromModelsApiItem` already read that
 * same record for `max_output_tokens`, but never for the context window, so every
 * routed row fell through to the 128k compatibility floor in parsing.ts while local
 * forward rows kept their real values.
 *
 * The capability field is appended AFTER the recognized metadata/limits fields and
 * after the Copilot-specific `capabilities.limits.max_context_window_tokens`, so no
 * provider that already resolved a window changes behaviour.
 */

const HUB_MODELS_ITEM = {
  id: "anthropic/claude-opus-5",
  object: "model" as const,
  owned_by: "opencodex-hub",
  capabilities: {
    context_length: 922000,
    max_output_tokens: 64000,
  },
};

describe("provider-hub capabilities.context_length (#4032)", () => {
  test("absorbs capabilities.context_length from a hub-shaped /v1/models item", () => {
    const hints = catalogHintsFromModelsApiItem("hub", HUB_MODELS_ITEM);
    expect(hints.contextWindow).toBe(922000);
  });

  test("the same record still yields max_output_tokens (asymmetry is gone)", () => {
    const hints = catalogHintsFromModelsApiItem("hub", HUB_MODELS_ITEM);
    expect(hints.maxOutputTokens).toBe(64000);
  });

  test("reads the capability record from metadata.capabilities too", () => {
    const hints = catalogHintsFromModelsApiItem("hub", {
      id: "meta-shaped",
      metadata: { capabilities: { context_length: 400000 } },
    });
    expect(hints.contextWindow).toBe(400000);
  });

  test("a recognized context field still wins over the capability record", () => {
    // Contested on purpose: the capability field is appended last so no provider
    // already supplying a recognized field changes behaviour.
    const hints = catalogHintsFromModelsApiItem("hub", {
      id: "both",
      context_length: 32768,
      capabilities: { context_length: 922000 },
    });
    expect(hints.contextWindow).toBe(32768);
  });

  test("Copilot's max_context_window_tokens still wins over the capability record", () => {
    const hints = catalogHintsFromModelsApiItem("copilot", {
      id: "gpt-5.6-sol",
      capabilities: { context_length: 922000, limits: { max_context_window_tokens: 128000 } },
    });
    expect(hints.contextWindow).toBe(128000);
  });

  test("a non-positive or non-integer capability window is ignored", () => {
    expect(catalogHintsFromModelsApiItem("hub", { id: "zero", capabilities: { context_length: 0 } }).contextWindow).toBeUndefined();
    expect(catalogHintsFromModelsApiItem("hub", { id: "neg", capabilities: { context_length: -1 } }).contextWindow).toBeUndefined();
    expect(catalogHintsFromModelsApiItem("hub", { id: "str", capabilities: { context_length: "922000" } }).contextWindow).toBeUndefined();
  });
});
```

### A2 — appended to `tests/codex-integration/codex-runtime.test.ts` (item 2)

```ts

describe("dead configured pin recovery (#4035)", () => {
  test("a dead configured pin is cleared when resolution degrades to fallback", () => {
    // A Codex App update deletes the hashed plugin directory the pin names. The probe
    // rejects the vanished absolute path ("path does not exist"), no PATH candidate
    // exists, and resolution degrades to `fallback` — which the persist guard skipped,
    // so the dead pin survived forever and every later resolve re-probed a path that
    // cannot exist.
    const configDir = tempConfigDir();
    const dead = join(configDir, "gone", "codex");
    persistCodexRuntime({ command: dead, version: "0.153.0", source: "configured" }, { configDir });
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(dead);

    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: (path) => !String(path).includes("gone"),
      execFileSync: () => { throw new Error("ENOENT"); },
    });

    expect(result.runtime.source).toBe("fallback");
    expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(false);
    expect(loadPersistedCodexRuntime({ configDir })).toBeNull();
  });

  test("a fallback resolve with no persisted pin writes nothing", () => {
    const configDir = tempConfigDir();
    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => false,
      execFileSync: () => { throw new Error("ENOENT"); },
    });
    expect(result.runtime.source).toBe("fallback");
    expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(false);
  });

  test("a live configured pin is NOT cleared when the resolve succeeds", () => {
    // The clear is bound to a dead pin, not to every fallback-shaped result.
    const configDir = tempConfigDir();
    const live = join(configDir, "bin", "codex");
    persistCodexRuntime({ command: live, version: "0.153.0", source: "configured" }, { configDir });
    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.153.0",
    });
    expect(result.runtime.source).toBe("configured");
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(live);
  });

  test("a pin rejected for a NON-path reason is left alone", () => {
    // "unrecognized --version output" means the file is present but unusable; that is a
    // different failure than a vanished path and is not this issue's recovery case.
    const configDir = tempConfigDir();
    const weird = join(configDir, "weird", "codex");
    persistCodexRuntime({ command: weird, version: "0.153.0", source: "configured" }, { configDir });
    resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => true,
      execFileSync: () => "not a codex binary",
    });
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(weird);
  });
});
```

### A3 — appended to `tests/service/stop-deferred-teardown.test.ts` (item 3; the two imports go at the top of the file, the describe block at the end)

```ts
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

describe("self-unloading manager refusal (#4023)", () => {
  test("a darwin proxy running AS the launchd job reports a self-unload risk", async () => {
    // `stopServiceIfInstalledDetailed()` calls `launchctl unload` on the plist that owns
    // THIS process, so the manager stop can terminate the request handler before the
    // shared teardown two statements later restores native Codex. The Windows guard that
    // prevents exactly this returned early for every non-Windows platform.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("linux systemd is exempted identically and gets the same answer", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "linux", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("a manually started proxy is unaffected, even with a service installed", async () => {
    // OCX_SERVICE is set by the plist/unit only. Without it this process is not the
    // managed job, so no unload can reach it and the inline stop stays available.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: {},
      exists: () => true,
    })).toBe("none");
  });

  test("the managed job with no service definition on disk is not at risk", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1" },
      exists: () => false,
    })).toBe("none");
  });

  test("Windows classification is untouched by the new branch", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "win32", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("respawnable");
    expect(installedServiceRespawnRisk(() => ({ status: "unknown" }) as never, "win32")).toBe("unknown");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "win32")).toBe("none");
  });

  test("the route refuses a self-unload before the manager is touched", () => {
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    const from = source.indexOf('"/api/stop"');
    const handler = source.slice(from, source.indexOf("/api/codex-auth/", from));
    expect(handler).toContain('code: "self_unload_service"');
    // Same invariant the Windows guard carries: refuse BEFORE acting, and say so.
    expect(handler.indexOf('code: "self_unload_service"'))
      .toBeLessThan(handler.indexOf("stopServiceIfInstalledDetailed()"));
    const branch = handler.slice(handler.indexOf('code: "self_unload_service"'), handler.indexOf('code: "self_unload_service"') + 600);
    expect(branch).toContain("Nothing was changed.");
    expect(branch).toContain("ocx stop");
  });

  test("a receipt-backed ocx stop keeps its deferral path", () => {
    // `ocx stop` claims a receipt, defers the teardown, and performs it itself once the
    // proxy is proven down — so it must not be refused by the new branch.
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    expect(source).toContain('const respawnRisk = holdsReceipt ? "none" : installedServiceRespawnRisk();');
  });
});
```

### A4 — added lines in `tests/responses/responses-compaction-routing.test.ts` (item 4; the import goes at the top, the 200-test inside the #3735 describe, the new describe at the end)

```ts
import { externalTaskInputContent } from "../../src/responses/task-input";
  test("an empty or null call_id is task input, not a rejection (#3807 supersedes)", async () => {
    // These two shapes were in the invalid list above until #3807 showed they are the same
    // seed as the absent-field form: neither value can pair with a `function_call`, and a
    // Codex desktop sub-agent seed emitted with an explicit `call_id: null` was answered
    // 400 for a turn that is really external task input. A wrong-TYPED key stays rejected.
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_seed", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    for (const callId of [null, ""]) {
      captured.length = 0;
      const res = await handleResponses(compactionRequest(body({ ...external("seeded task"), call_id: callId })),
        keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
      expect(res.status).toBe(200);
      await res.text();
      expect(captured[0]!.messages).toEqual([{ role: "user", content: "seeded task" }]);
    }
  });


describe("unusable-call_id task-input seed (#3807)", () => {
  const seed = (extra: Record<string, unknown>) => ({
    type: "function_call_output", id: "fc_seed", name: "create_thread", namespace: "codex",
    output: "<codex_delegation>continue</codex_delegation>", ...extra,
  });

  test("a seed carrying call_id: null is admitted as task input", () => {
    // `null` is not a pairing key, so the item is the same external seed the absent-field
    // form already carries. Rejecting it produced the reported 400 on clients that emit
    // the field explicitly.
    expect(externalTaskInputContent(seed({ call_id: null }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a seed carrying an empty-string call_id is admitted identically", () => {
    expect(externalTaskInputContent(seed({ call_id: "" }))).toBe("<codex_delegation>continue</codex_delegation>");
    expect(externalTaskInputContent(seed({ call_id: "   " }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("the absent-field form still works (no regression on a73bb160f)", () => {
    expect(externalTaskInputContent(seed({}))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a REAL call_id is still a paired tool result, never task input", () => {
    // The pairing key is what separates a tool result from a seed. Admitting a paired
    // result as user text would silently drop a real tool round-trip.
    expect(externalTaskInputContent(seed({ call_id: "call_1" }))).toBeUndefined();
  });

  test("a non-string, non-null call_id stays rejected", () => {
    // A numeric id is malformed input, not the absent-pairing seed shape; it keeps the
    // #3259 rejection so a wrong-typed key cannot reach a translating adapter.
    expect(externalTaskInputContent(seed({ call_id: 42 }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: {} }))).toBeUndefined();
  });

  test("every other #3735 validation still holds with an unusable call_id", () => {
    // The relaxation is ONLY about the pairing key. Envelope completeness, blank output,
    // and opaque ciphertext keep their existing rejections.
    expect(externalTaskInputContent({ type: "function_call_output", call_id: null, output: "x" })).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, namespace: "" }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: "   " }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [] }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [{ type: "input_image", image_url: 42 }] }))).toBeUndefined();
  });
});
```
