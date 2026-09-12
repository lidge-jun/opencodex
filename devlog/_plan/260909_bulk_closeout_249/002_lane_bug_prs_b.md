# Lane B — bug/compat PRs by other authors (READ-ONLY review)

Research worktree: `/tmp/ocx-249.xGQnxl/wt` detached at `origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9`
Remote: `https://github.com/lidge-jun/opencodex.git`
Index re-read immediately before verdict: `git status --porcelain` empty, `git rev-parse HEAD` = `7dc7dc99e65268bc8764e19840952256b030bce9`.
Focused tests were run in a scratch `git worktree` (`mktemp -d` + `worktree add --detach`), removed afterwards. No full suite. Bun 1.4.0.

## Summary table

| item | verdict | one-line reason | head SHA | CI at head | conflicts |
| --- | --- | --- | --- | --- | --- |
| PR #4018 | LAND_AS_IS | Spark 5h window really is dropped by `parseUsageQuota`; fix is label-set scoped and focused tests pass | `d7387478be84e1740fbbca296574187620f86cf1` | enforce-target FAIL, hygiene FAIL (draft/template only); no `ci.yml` run at head | none vs dev; shares `src/codex/quota.ts` with #4008 (disjoint hunks, verified stackable) |
| PR #4016 | CLOSE | Superseded duplicate of #3954 from the same author on the same file; reverts two landed dev commits and fails `tsc` with TS1117 | `3cd59118a35455952f45a4f0075559a5464031b4` | all 5 hygiene checks pass; no `ci.yml` run at head | textually merges, but semantically reverts `5cd71ec91` and `89b69a00a` |
| PR #4008 | LAND_AS_IS | `mergeAccountQuota` drops `customWindows` on partial header updates; one-line else-branch matches the file's existing retention idiom | `522e438f5b95fde16fdcf806e02281663d2d1b30` | all 5 hygiene checks pass; no `ci.yml` run at head | none; shares `src/codex/quota.ts` with #4018 |
| PR #3981 | LAND_AS_IS | Catalog/models-cache writes leave a stale app-server observation cached; invalidation added at the two write sites plus sync | `9f666b33a5070f37f80108d45a9563e13dd3bff2` | all 5 hygiene checks pass; no `ci.yml` run at head | none |
| PR #3979 | LAND_AS_IS | Inactivity timer stays armed after a terminal event, so the drain guard races a false timeout; one `clearInactivity()` call | `b8c92f2e58774603ef0b9e2c108da8efd684507c` | all 5 hygiene checks pass; no `ci.yml` run at head | none |
| PR #3964 | LAND_AS_IS | Direct Meta 400s `search_content_types`; adds one URL to the existing strict set, no new mechanism | `8488a47c862047cb3077b6183bafbf7bdeef5867` | all 5 hygiene checks pass; no `ci.yml` run at head | none |
| PR #3954 | REIMPLEMENT | Session-header defect is plausible but the branch reverts two landed dev commits, fails `tsc` (TS1117), duplicates 4 tests and fails 6 of its own | `8b90fbfbb957b42a04747d15137c54f2568e2770` | all 5 hygiene checks pass; no `ci.yml` run at head | textually merges, but semantically reverts `5cd71ec91` and `89b69a00a` |
| PR #3920 | LAND_AS_IS | Adds `ocx recover-history --ocx-compaction`; new module is additive, CLI registry/skill-map guard and layout guards pass | `3c3ca0aaccd7f4a12b586df25c1e402e433b5773` | all 5 hygiene checks pass; no `ci.yml` run at head | none; sole toucher of `scripts/test-layout/layout.json` + `tests/fixtures/test-layout-expected.json` in this lane |
| PR #3863 | LAND_AS_IS | The `landed-via-maintainer` label covers only the startup-health portion (`9d8d11abd`); combo-capability and storage-skip parts are still absent from dev | `51e544ad9452d56d9d0fd21c187a3efdae4c46cf` | all 5 hygiene checks pass; no `ci.yml` run at head | none |
| PR #3848 | DEFER | Conflicts with dev on `src/codex/auth-api.ts`; 1122/127-line auth-area change needing the explicit policy revision the maintainer flagged as open product judgment | `cb28a097f60134a0d408d4042addcc221bfc0f6a` | enforce-target FAIL, hygiene FAIL; no `ci.yml` run at head | CONFLICTING (`mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`) |
| Issue #4017 | CLOSE (on #4018 merge) | Resolved exactly by #4018, which carries `Closes #4017` | — | — | — |
| Issue #4007 | CLOSE (on #4008 merge) | Resolved exactly by #4008, which carries `Closes #4007` | — | — | — |
| Issue #3916 | CLOSE (on #3920 merge) | Resolved by #3920, which carries `Closes #3916` | — | — | — |
| Issue #3846 | DEFER | Maintainer comment already states this is a policy revision needing product judgment, and recommends keeping it open | — | — | — |

Note on "CI at head": no item in this lane has a `ci.yml` (product test) run at its head SHA. The three most recent `ci.yml` runs on the repo are all `action_required` (fork PRs awaiting maintainer approval). The green checks listed above are hygiene gates only — `enforce-target`, `hygiene`, `label`, `resolve-pr`, `CodeRabbit`. Per `MAINTAINERS.md` practice these are **not** substitutes for product CI; every LAND verdict below still needs a final-head `ci.yml` dispatch on the maintainer integration branch.

---

## PR #4018 — fix(codex): keep Spark five-hour quota model-scoped — LAND_AS_IS

Author cb8010d6. Head `d7387478be84e1740fbbca296574187620f86cf1`. Base `dev`. Draft, `REVIEW_REQUIRED`, labels `bug`, `intake: hygiene-blocked`. +50/-22 across 5 files.

**Defect is real on dev.** `parseUsageQuota` collects both Spark windows but only ever searches for the weekly one, so a Pro payload whose Spark primary is a five-hour window loses it entirely:

`/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:796-797`
```
  const sparkWindows = [spark?.rate_limit?.primary_window, spark?.rate_limit?.secondary_window]
    .filter((window): window is WhamUsageWindow => !!window);
```
The next statement is `const sparkWeekly = sparkWindows.find(...)` gated on `!isExplicitShortWindow(window)` and `seconds >= WEEKLY_WINDOW_MIN_SECONDS`, and the only write is `quota.customWindows = [sparkWindow]` built from `sparkWeekly`. A Spark five-hour window matches neither branch and is silently discarded — exactly what #4017 reports.

**Fix is correct and minimal.** It turns the single-label constant into a two-label `Set` and iterates the `[label, window]` pairs. The visibility filter changes from equality to set membership at `src/codex/auth-api.ts:270`, preserving the load-bearing property the surrounding comment describes — matching on the exact label rather than on "is a custom window", so Cursor/Anthropic/Antigravity/Kimi meters stay untouched. The dev comment that makes this load-bearing:

`/tmp/ocx-249.xGQnxl/wt/src/codex/auth-api.ts:244-249` — "Matching on the label rather than on 'is a custom window' is load-bearing: the same array carries Cursor's First-party models / API usage, Anthropic's Fable / Opus / Sonnet, Antigravity's Gem / Cla, Kimi's subscription credits and a dozen dynamic provider meters."

**Focused tests (scratch worktree, merged onto `7dc7dc99e`):**
`bun test tests/codex-integration/codex-spark-visibility.test.ts tests/codex-integration/codex-routing.test.ts tests/codex-integration/codex-quota-parser-parity.test.ts` → **189 pass / 1 skip / 0 fail**, 6694 assertions, 190 tests across 3 files.

**Conflicts:** `git merge-tree --write-tree` against `7dc7dc99e65268bc8764e19840952256b030bce9` → exit 0, tree `20c1f6f4f0f796f989d4c47eb3636345816cf17e`. Clean.

**Blocking-gate note:** `enforce-target` and `hygiene` are red at head, but that is the draft/PR-template gate rather than a code failure — the PR is `isDraft: true` with label `intake: hygiene-blocked`. A maintainer carry branch with a compliant description clears both.

---

## PR #4008 — fix(codex): retain Spark quota on partial header updates — LAND_AS_IS

Author cb8010d6. Head `522e438f5b95fde16fdcf806e02281663d2d1b30`. Draft, `REVIEW_REQUIRED`, label `bug`. +47/-1 across 2 files (3 source lines, rest test).

**Defect is real on dev.** `mergeAccountQuota` retains every other partial field but replaces `customWindows` unconditionally:

`/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:338`
```
  if (snapshotHasCustom(quota)) next.customWindows = quota.customWindows;
```
There is no `else` branch. Compare the two neighbours, which both have one — `src/codex/quota.ts:340-341` for `resetCredits` and `src/codex/quota.ts:301-304` for `weeklyPercent`. An ordinary response header update carries no model-specific WHAM windows, so `snapshotHasCustom` is false and the stored Spark window is erased. That is #4007 verbatim.

**Fix is correct.** The added `else if (existing?.customWindows !== undefined) next.customWindows = existing.customWindows;` matches the file's own retention idiom exactly, and the accompanying tests pin all three edges: retain on omission, replace on explicit supply including `[]`, and do not survive `clearAccountQuota`.

**Focused tests:** `bun test tests/codex-integration/codex-quota-parser-parity.test.ts` → **11 pass / 0 fail**.

**Stack interaction with #4018 (both touch `src/codex/quota.ts`):** merged both onto `7dc7dc99e` in order #4008 → #4018; both merges applied without conflict (`2 files changed` then `5 files changed`) and the combined run `bun test tests/codex-integration/codex-quota-parser-parity.test.ts tests/codex-integration/codex-spark-visibility.test.ts` → **17 pass / 0 fail**. The hunks are disjoint: #4008 edits `mergeAccountQuota` (~line 338), #4018 edits `parseUsageQuota` (~line 795+).

**Conflicts:** merge-tree exit 0, tree `b280fd4134c149ab824bc7c8ce901e9d053df61d`. Clean.

---

## PR #3981 — fix(codex): invalidate app-server observations at catalog boundaries — LAND_AS_IS

Author yansigit. Head `9f666b33a5070f37f80108d45a9563e13dd3bff2`. Draft, `REVIEW_REQUIRED`, label `bug`. +70/-2 across 4 files.

**Defect is real on dev.** The reset function exists and is already called from one place inside the module, but neither catalog writer calls it:

`/tmp/ocx-249.xGQnxl/wt/src/codex/app-server-processes.ts:1061` — `export function resetCodexAppServerCatalogStateCache(): void {`
`/tmp/ocx-249.xGQnxl/wt/src/codex/app-server-processes.ts:954` — the comment describing it: "…`resetCodexAppServerCatalogStateCache`, which advances the generation and drops…"

`grep -n "resetCodexAppServerCatalogStateCache" src/codex/internal/catalog-writer.ts src/codex/sync.ts` on dev returns nothing. So `replaceActiveCodexCatalog` and `replaceCodexModelsCache` publish new bytes while a stale "not running" observation stays cached, and native-default guidance can report a state that predates the write.

**Fix is correct.** Three call sites, each immediately after the atomic write or before async discovery. The added import is intra-`src/codex` (`../app-server-processes`), so it does not cross the `src/lab/` boundary that `tests/lab/core-lab-boundary.test.ts` guards — this file is not on the core request path list (`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`).

**Focused tests:** `bun test tests/codex-integration/codex-models-cache-invalidate.test.ts` → **11 pass / 0 fail**, including the two new cases "sync invalidates a cached not-running observation before a catalog write" and "sync invalidates cached process state even when catalog refresh is a no-op". Note the test also adds `flushConfigDirHardening` to `afterEach`, which is the correct hygiene for the Windows ACL path.

**Conflicts:** merge-tree exit 0, tree `dbfef7c7bd234dd556404808711da085c2fd777a`. Clean.

---

## PR #3979 — fix(web-search): stop inactivity timing after terminal events — LAND_AS_IS

Author yansigit. Head `b8c92f2e58774603ef0b9e2c108da8efd684507c`. Draft, `REVIEW_REQUIRED`, label `bug`. +9/-2, one source line.

**Defect is real on dev.** Two independent timers can both be armed after a terminal event. The terminal event is held without disarming inactivity:

`/tmp/ocx-249.xGQnxl/wt/src/web-search/progress-stream.ts:303-306`
```
        if (event.type === "done" || event.type === "incomplete") {
          heldTerminal = event;
          continue;
        }
```
On the next loop iteration the `heldTerminal` branch installs its own bounded drain guard at `src/web-search/progress-stream.ts:262-265` (`adapter did not return within ${postTerminalDrainTimeoutMs}ms`). Meanwhile the inactivity timer armed at `src/web-search/progress-stream.ts:205-206` is still live, and it fires `RoutedModelInactivityError` from response-byte silence — but after a terminal event there are legitimately no more response bytes. Whichever timer is shorter wins, so a slow-returning adapter iterator can surface an inactivity error instead of the drain error that actually describes the condition. `clearInactivity()` is only called on the success path at `src/web-search/progress-stream.ts:282`, after `result.done`.

**Fix is correct.** One `clearInactivity()` at the hold point, handing ownership of the bounded wait to the drain guard that already exists. The test change is honest about what it proves: it drops `inactivityTimeoutMs` to 10 ms and raises `postTerminalDrainTimeoutMs` to 100 ms with a 30 ms adapter delay, so the assertion fails on unpatched code and passes patched.

**Focused tests:** `bun test tests/web-search/web-search-progress-stream.test.ts` → **21 pass / 0 fail**, 51 assertions. Both neighbouring guards still pass: "done followed by an iterator that never returns hits the separate drain guard" and "continuous raw-byte silence raises the exact typed inactivity error".

**Conflicts:** merge-tree exit 0, tree `a6429d2a8d957a7b75ce4f13e93c94497bfb60c6`. Clean.

---

## PR #3964 — fix(responses): strip Muse web_search fields on direct Meta — LAND_AS_IS

Author ildunari. Head `8488a47c862047cb3077b6183bafbf7bdeef5867`. **Not draft**, `REVIEW_REQUIRED`, labels `bug`, `review-ready`. +45/-9 across 3 files (one is a PR-asset screenshot).

**Defect is real on dev.** The strict-URL set omits direct Meta:

`/tmp/ocx-249.xGQnxl/wt/src/adapters/openai-responses.ts:2134-2137`
```
const MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS = new Set([
  "https://opencode.ai/zen/v1/responses",
  "https://opencode.ai/zen/go/v1/responses",
]);
```
`stripMuseSparkUnsupportedWebSearchFields` returns the body unchanged when the destination is not in that set (`src/adapters/openai-responses.ts:2168`), while the model-id set at `src/adapters/openai-responses.ts:2127-2132` already contains `muse-spark-1.3-contributor`. So the same model on the same wire keeps `search_content_types` when reached directly at `api.meta.ai` and 400s. The PR attaches a live 2026-09-07 capture as `.github/pr-assets/muse-spark-meta-search-content-types-400.jpg`.

**Fix is correct.** One URL added to the existing set — no new mechanism, no new branch. The URL-normalization guard at `src/adapters/openai-responses.ts:2161-2167` (reject username/password/search/hash, strip trailing slashes, lowercase origin) already covers the new destination, which is why the added "split Meta baseUrl and responsesPath" test passes without further change. `web_search_preview` preservation is retested explicitly.

The PR also correctly inverts a prior test that asserted the opposite ("direct Meta preserves its web_search fields") and documents why in a comment naming #3456 as the origin of the wrong assumption. That is the right way to retire a stale assertion.

**Focused tests:** `bun test tests/providers/muse-spark-web-search-compat.test.ts` → **16 pass / 0 fail**, 65 assertions.

**Conflicts:** merge-tree exit 0, tree `eac8c8b9b46698862459d07cf52540a10e258e89`. Clean.

This is the strongest LAND candidate in the lane: not a draft, already `review-ready`, smallest real source delta, live evidence attached.

---

## PR #3954 — fix: add X-Session-ID header for OpenCode free-tier models — REIMPLEMENT

Author omarjson. Head `8b90fbfbb957b42a04747d15137c54f2568e2770`. Not draft, **`CHANGES_REQUESTED`**, labels `bug`, `review-ready`. +128/-8 across 2 files.

**The review request is NOT resolved on the current head.** Reviewer Ingwannu raised two distinct blockers on 2026-09-07:

1. *Empty `Authorization` regression* (the `CHANGES_REQUESTED` review, citing `src/providers/derive.ts:229` and `src/adapters/openai-chat.ts:97-98`). This one **is** fixed at the current head — I merged `refs/remotes/pr/3954` onto `7dc7dc99e` and grepped the `opencode-free` `staticHeaders` block: it now contains only the `X-Session-ID` line, no `Authorization` entry.
2. *Provider-policy / session-lifetime evidence* (the earlier COMMENTED review): "The quoted upstream error explicitly says the free tier can only be used in OpenCode… Please provide authoritative provider documentation or explicit authorization for this use, plus the intended session lifetime." No such evidence was supplied. The PR's own in-code comment cites only "community reports confirm the header is accepted from third-party clients (see PR #3954 discussion)" — i.e. it cites its own discussion thread as its authority. That is circular and leaves the reviewer's question open.

**Three further defects I confirmed independently, none of them mentioned in the review threads:**

**(a) It fails `bun x tsc --noEmit`.** Merged onto `7dc7dc99e`:
```
src/providers/registry.ts(3044,5): error TS1117: An object literal cannot have multiple properties with the same name.
src/providers/registry.ts(3047,5): error TS1117: An object literal cannot have multiple properties with the same name.
```
The PR adds empty `modelContextWindows: {}` and `modelInputModalities: {}` keys to the `opencode-free` entry while dev already declares both further down the same object literal at `/tmp/ocx-249.xGQnxl/wt/src/providers/registry.ts:3018` and `:3021`. `bun run typecheck` is a required PR-ready gate per `AGENTS.md`.

**(b) It reverts two commits already on dev.** The diff removes the Nous catalog bound and the OpenCode Go stateless policy:
- `maxResponseBytes: 1_048_576` → `262_144` at the Nous entry. Dev has `1_048_576` at `/tmp/ocx-249.xGQnxl/wt/src/providers/registry.ts:1560` with the comment at `:1557-1558` "Nous returns a mixed paid/free catalog whose JSON can exceed 256 KiB; keep the provider-specific limit below the process-wide 4 MiB ceiling." Landed as `5cd71ec91 fix(providers): admit larger Nous catalogs within native limits`.
- Deletes `statelessResponses: true` from `opencode-go`. Dev has it at `/tmp/ocx-249.xGQnxl/wt/src/providers/registry.ts:1696` with the comment at `:1694-1695` "Go rejects reasoning.encrypted_content with previous_response_id (#3838)." Landed as `89b69a00a fix(opencode-go): normalize tool catalogs and stateless continuation`.

Git merges these cleanly (merge-tree exit 0, tree `92c55707c7f6a5c46f5e4c61dc1a02cb1ee3199e`) because the branch is simply based on an older `dev` and the surrounding lines did not move — so **the conflict-free merge is misleading here**. I verified the reversion by grepping the merged tree: `262_144` appears at both `:1410` and `:1568`, and `statelessResponses: true` no longer appears at the `opencode-go` entry. Merging this PR silently regresses two shipped bug fixes.

**(c) Its own tests fail, and four are literal duplicates.** `bun test tests/providers/opencode-free-provider.test.ts` on the merged tree → **22 pass / 6 fail**. The six failures are three distinct tests, each declared twice with identical bodies ("muse-spark free models declare a 1M context window and image support", "…expose the Meta reasoning ladder", "…are preserved for reasoning content"). They fail because of the same TS1117 duplicate keys — the later empty literal wins at runtime, so `modelContextWindows` is empty.

**Verdict rationale.** The underlying report (Zen 400 `MissingSessionID` for keyless access) may well be real, and the Responses-wire routing for the free Muse models is a plausible companion fix. But this branch cannot be landed or carried as-is: it fails typecheck, regresses two landed commits, ships duplicated failing tests, and its central compatibility claim rests on a citation to its own thread. REIMPLEMENT on current dev — a maintainer-authored branch that adds only the `X-Session-ID` static header (plus the wire defaults if desired), touching nothing else in `registry.ts`, with `Co-authored-by: omarjson` per `AGENTS.md`. That reimplementation should still not land until Ingwannu's provider-authorization question is answered, since that is a policy question about third-party keyless use rather than a code question.

---

## PR #4016 — fix: route muse-spark free models to Responses API — CLOSE

Author omarjson. Head `3cd59118a35455952f45a4f0075559a5464031b4`. Draft, `CHANGES_REQUESTED`, label `bug`. +46/-9 across 2 files.

**This is a near-duplicate of #3954 by the same author on the same file**, opened 12 hours later. It carries the identical `OPENCODE_SESSION_ID` block, the identical `X-Session-ID` static header, the identical Nous `262_144` reversion, and the identical `statelessResponses` deletion. The only difference is that #4016 fills in the model-metadata maps that #3954 left empty — while still declaring them twice.

**It fails typecheck for the same reason.** Merged onto `7dc7dc99e`:
```
src/providers/registry.ts(3048,5): error TS1117: An object literal cannot have multiple properties with the same name.
src/providers/registry.ts(3051,5): error TS1117: An object literal cannot have multiple properties with the same name.
```
CodeRabbit flagged exactly this on 2026-09-08 ("Merge the duplicate `modelContextWindows` and `modelInputModalities` declarations into the existing maps") and it was not addressed.

**It carries the same two reversions.** Verified on the merged tree: `maxResponseBytes: 262_144` at `:1410` and `:1568` (dev has `1_048_576` at `:1560`), and `statelessResponses: true` absent from `opencode-go` (dev has it at `:1696`).

**Conflicts:** merge-tree exit 0, tree `880e5553277cf7dca0759b415c05a733e1e8f1e7` — clean textually, semantically a revert, same trap as #3954.

**Closing evidence:** duplicate of #3954 (same author, same file, same session-ID mechanism, same two reversions), fails `bun run typecheck` with TS1117, and its unaddressed CodeRabbit finding is the cause. Keeping one of the two open is enough; #3954 is the further-along one (not a draft, `review-ready`, has the human review thread).

**Suggested closing comment:**
> Closing as a duplicate of #3954, which carries the same `X-Session-ID` mechanism on the same file and has the active review thread. Two blockers apply to both and are worth carrying forward to whichever branch continues: (1) the new `modelContextWindows` and `modelInputModalities` keys duplicate declarations that already exist later in the same `opencode-free` object literal, so `bun run typecheck` fails with `TS1117` at `src/providers/registry.ts:3048` and `:3051` — this is the CodeRabbit finding from 2026-09-08; (2) the branch is based on an older `dev` and reverts two landed fixes: the Nous catalog bound from `5cd71ec91` (`maxResponseBytes` back to `262_144`; dev is `1_048_576` at `src/providers/registry.ts:1560`) and the OpenCode Go `statelessResponses: true` policy from `89b69a00a` (dev has it at `src/providers/registry.ts:1696`, added for #3838). Git merges both cleanly because the branch is simply stale, so the reversion is silent. Please rebase onto current `dev` before continuing on #3954. Thanks for the report — the underlying `MissingSessionID` behaviour is worth fixing.

---

## PR #3920 — fix(codex): recover ocx1-compacted threads for native replay — LAND_AS_IS

Author cb8010d6. Head `3c3ca0aaccd7f4a12b586df25c1e402e433b5773`. Draft, `REVIEW_REQUIRED`, label `bug`. +459/-9 across 22 files — the largest LAND candidate here, but 334 of those lines are the new module plus its new test file.

**Defect is real on dev and matches issue #3916.** After OpenCodeX writes a routed remote-compaction V2 item, the persisted `encrypted_content` begins with `ocx1:`. The proxy only lowers that envelope while its Responses adapter is in the request path, so `ocx restore` returns Codex to native ChatGPT while leaving the thread unreplayable — ChatGPT rejects with HTTP 400 `invalid_encrypted_content`. On dev the CLI offers only the legacy-OpenAI recovery mode:

`/tmp/ocx-249.xGQnxl/wt/src/cli/registry.ts:38-40`
```
    name: "recover-history",
    usage: "ocx recover-history --legacy-openai --yes",
    summary: "Force all user-message opencodex rows to OpenAI for legacy recovery.",
```
There is no path that repairs a persisted `ocx1:` compaction, which is the "no supported recovery path" the issue describes.

**Fix is correct and well-shaped.** New module `src/codex/ocx-compaction-history.ts` (226 lines) lowers only proxy-owned compactions inside `compacted.payload.replacement_history`, requires explicit confirmation, backs up before writing, and repairs one explicitly named thread rather than sweeping the database. The CLI entry becomes `ocx recover-history (--legacy-openai | --ocx-compaction <thread-id>) --yes`. Destructive-verb-behind-`--yes` is exactly what the skill-surface guard expects.

**Repository-guard compliance verified**, which matters because this PR adds a test file and a CLI command:
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` → pass. The PR correctly adds the new test to **both** `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`, as `AGENTS.md` requires.
- `bun test tests/ci-workflows/skill-ocx.test.ts` → **16 pass / 0 fail**, including "destructive verbs are documented as requiring `--yes`". So the committed surface map does not drift from `src/cli/capabilities.ts`.

**Focused tests:** `bun test tests/codex-integration/history-ocx-compaction-recovery.test.ts tests/cli/cli-help.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` → **37 pass / 0 fail**, 764 assertions. The three new recovery tests cover the lowering, byte-stability when nothing is repairable, and the atomic backup-and-replace path.

**Conflicts:** merge-tree exit 0, tree `8adbee6fdebe25ec5a783eade6315e9538740365`. Clean. It is the only item in this lane touching the two test-layout files, so it will not race the luvs01 fixture train there — but see the stack-order section.

**Caveat for the maintainer:** this is a history-mutating CLI command. It is gated behind an explicit thread id plus `--yes` and backs up first, which is the right shape, but it deserves a real read of `src/codex/ocx-compaction-history.ts` before merge rather than trust in the green tests. That is a review-depth note, not a defect I found.

---

## PR #3863 — fix: preserve combo capabilities and skip referenced archives — LAND_AS_IS

Author x3M3x. Head `51e544ad9452d56d9d0fd21c187a3efdae4c46cf`. Not draft, `REVIEW_REQUIRED`, labels `bug`, `review-ready`, **`landed-via-maintainer`**. +208/-64 across 16 files.

**The `landed-via-maintainer` label is misleading and this PR should NOT be closed.** Only a path-filtered slice of it landed. The carry commit is explicit about that:

```
9d8d11abd fix(service): carry startup-health cache portion of #3863 [skip ci]
    Path-filtered source commit: 960621616c439e69b967981c290f2377ba9465fa.
    Config-route wiring excluded under lane ownership.
    Co-authored-by: x3M3x <98298256+x3M3x@users.noreply.github.com>
 src/server/startup-health-cache.ts     | 16 ++++++++++++++
 tests/service/autostart-health.test.ts | 39 +++++++++++++++++++++++++++++++++-
```
Merged via `686cb127c Merge pull request #3875: unblock settings load from the Windows health probe (carry #3863)`. Two files. The PR touches sixteen.

**The remaining two fixes are still absent from dev, verified by grep:**

1. *Combo capability fallback.* `vendorMetadataComboFallback` still returns `undefined` for any provider without a metadata alias:
   `/tmp/ocx-249.xGQnxl/wt/src/codex/catalog/provider-fetch.ts:956-958`
   ```
     const metadataProvider = resolveMetadataProvider(target.provider);
     const metadata = metadataProvider ? comboMemberVendorMetadata(metadataProvider, target.model) : undefined;
     if (!metadata) return undefined;
   ```
   The PR's change — falling back to `comboMemberVendorMetadata("openai", target.model)` for the effort ladder only, while gating context/modality rows on `metadataProvider` so they stay provider-owned — is not present. Nor is the vision-sidecar hint application in `resolveComboCatalogMember`: `grep -n "isModelVisionSidecarConsumer" src/codex/catalog/provider-fetch.ts` on dev returns only `:36` (import), `:792`, and `:2571` — none of them in `resolveComboCatalogMember`.
2. *Storage cleanup skip-referenced.* `grep -n "skippedReferencedPaths|skippedReferenced" src/storage/cleanup.ts src/server/management/logs-usage-routes.ts gui/src/i18n/en.ts` on dev returns nothing. The i18n key `storage.cleanup.skippedReferenced` does not exist in any of the nine locale files.

**Focused tests:** `bun test tests/storage/storage-cleanup.test.ts tests/codex-integration/codex-catalog.test.ts` → **384 pass / 0 fail**, 1959 assertions.

**Conflicts:** merge-tree exit 0, tree `268f4f9e52b33330cee82c67224e9341c47f27bc`. Clean — the already-landed slice touched different files (`src/server/startup-health-cache.ts`), so there is no double-apply risk.

**Recommendation on the label:** remove `landed-via-maintainer` from #3863, or the next triage pass will close a PR whose main content never shipped. If the maintainer prefers the carry pattern, the two remaining fixes are cleanly separable — combo capabilities (`src/codex/catalog/provider-fetch.ts` + `tests/codex-integration/codex-catalog.test.ts`) and storage skip-referenced (`src/storage/cleanup.ts`, `src/server/management/logs-usage-routes.ts`, `gui/`, `tests/storage/`) share no files, so they can be two independent carries under the one-bug-per-PR convention. Either way `Co-authored-by: x3M3x <98298256+x3M3x@users.noreply.github.com>` must be preserved.

Note this PR touches `gui/` (`gui/src/pages/Storage.tsx` and nine i18n files) and its description includes `.github/pr-assets/3863-storage-skip-referenced.png`, satisfying the `enforce-target` GUI-screenshot requirement.

---

## PR #3848 — fix(codex): defer validation for quota-exhausted account registration — DEFER

Author shaun0927. Head `cb28a097f60134a0d408d4042addcc221bfc0f6a`. Draft, `REVIEW_REQUIRED`, labels `bug`, `intake: hygiene-blocked`. **`mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`.** +1122/-127 across 62 files.

**Conflicts on dev.** `git merge-tree --write-tree 7dc7dc99e65268bc8764e19840952256b030bce9 refs/remotes/pr/3848` → **exit 1**, conflicting paths:
```
skills/ocx/references/01_management_surface.md
src/codex/auth-api.ts
```
`src/codex/auth-api.ts` has moved since the branch was cut — dev has `534d6d8ce fix(codex): fence reset usage publication and refresh lineage`, `3c38b9529`, `6222d64b3`, `3955e1040` on that file. The PR's own +91/-17 in the same file collides.

**It needs product judgment that the maintainer has explicitly reserved.** The linked issue #3846 already carries a maintainer review that names the decision points and recommends keeping the issue open. Quoting the decision list verbatim from that comment:
> 메인테이너의 판단이 필요한 지점
> - 2026-07 warmup 정책을 "저장 ≠ 추론 준비"로 개정할지, 아니면 exhausted 계정은 계속 등록 거절이 맞다고 둘지
> - 쿼터 제한으로 저장할 때 표현을 기존 needsReauth/quota cache/pause 중 무엇으로 할지…

and the recommendation:
> 라벨(`bug`, `account-pool`)은 유지하고 이슈는 **열어 둔다.**

The comment also confirms the gate is intentional design, citing `devlog/_fin/260705_codex-auth-warmup-refresh/00_plan.md`. So this is a policy revision, not a defect repair.

**Additional gating factors.** It is an authentication-area change, which per `AGENTS.md` and `MAINTAINERS.md` requires explicit security review — the diff touches `src/oauth/token-guardian.ts`, `src/oauth/health.ts`, `src/codex/auth-api.ts`, and `src/server/management/route-registry.ts`. It also adds a new consent boundary (validation POST requiring the authenticated GUI-session principal). `enforce-target` and `hygiene` are both red at head.

**Credit where due:** the author's evidence package is unusually strong — a full 26-job cross-platform CI run on their fork (`shaun0927/opencodex` run 34118665420), 21,295 local tests, and dashboard captures. None of that is at issue. The blockers are the conflict, the unmade policy decision, and the required security review. DEFER is about sequencing, not quality.

**Issue #3846 verdict: DEFER**, keep open with labels `bug` and `account-pool`, per the maintainer's own recorded recommendation.

---

## Issues

### #4017 — Pro Spark five-hour quota shown as a generic account window — CLOSE on #4018 merge
PR #4018 body contains `Closes #4017`. The defect is confirmed at `/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:796-797` (see the #4018 section). Since PRs target `dev` and GitHub auto-closes only on merge to `main`, close manually once #4018 lands on `dev`.
Suggested comment: *Fixed on `dev` by #4018. `parseUsageQuota` now emits both `GPT-5.3-Codex-Spark 5h` and `GPT-5.3-Codex-Spark Weekly`, and the visibility filter hides or reveals both together.*

### #4007 — Spark quota disappears after partial response-header updates — CLOSE on #4008 merge
PR #4008 body contains `Closes #4007`. The defect is confirmed at `/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:338` — `if (snapshotHasCustom(quota)) next.customWindows = quota.customWindows;` with no `else` branch, unlike every neighbouring field. The issue's expected behaviour (retain on omission, replace on explicit supply including `[]`, clear on cache clear) is exactly what #4008's three tests pin. Close manually once #4008 lands on `dev`.

### #3916 — Codex restore leaves ocx1-compacted threads unreplayable — CLOSE on #3920 merge
PR #3920 body contains `Closes #3916`, and it is the only open PR referencing the issue (`gh pr list --search "3916 in:body"` returns only 3920). The issue asks for "a safe, explicit migration for an affected thread or… the required recovery step"; #3920 supplies `ocx recover-history --ocx-compaction <thread-id> --yes` with backup-and-atomic-replace. Close manually once #3920 lands on `dev`.
Caveat: #3920 provides a **recovery command**, not an automatic migration during `ocx restore`. If the maintainer reads #3916 as requiring the restore path itself to migrate or warn, then #3920 is a partial fix and the issue should stay open with a narrowed scope. My reading is that the issue's own expected-behaviour clause admits either, so CLOSE is defensible — flagging it because it is a judgment call.

### #3846 — Codex pool registration couples account persistence to warmup success — DEFER
See the #3848 section. The maintainer has already reviewed and recorded that this is a policy revision requiring their decision, and explicitly recommended keeping it open.

---

## Shared files / stack order

**Within Lane B, only one file is shared by two LAND candidates:**

| file | items | resolution |
| --- | --- | --- |
| `src/codex/quota.ts` | #4008 (`mergeAccountQuota`, ~line 338) and #4018 (`parseUsageQuota`, ~line 795+) | Disjoint hunks. Verified stackable: merged #4008 then #4018 onto `7dc7dc99e` with no conflict, combined focused run 17 pass / 0 fail. Land #4008 first (smaller, 3 source lines). |
| `src/providers/registry.ts` | #4016 and #3954 | Both CLOSE/REIMPLEMENT — no stack needed. |
| `src/codex/auth-api.ts` | #4018 (1 line, label-set membership) and #3848 (+91/-17) | #3848 is DEFER and already conflicting; #4018 must not wait on it. |

**Overlap with the luvs01 fixture train (#4004 #4012 #4014 #4015 #4039 #4034 #4041 #4036 #4043 #4025 #4006 #3997):** I did not inspect those PRs (outside my assignment), so I can only report Lane B's footprint for the main session to intersect. Lane B's LAND candidates touch:

- `src/codex/quota.ts`, `src/codex/auth-api.ts`, `src/types/config.ts` — #4018
- `src/codex/quota.ts` — #4008
- `src/codex/internal/catalog-writer.ts`, `src/codex/sync.ts`, `docs-site/src/content/docs/guides/codex-app-models.md` — #3981
- `src/web-search/progress-stream.ts` — #3979
- `src/adapters/openai-responses.ts` — #3964
- `src/cli/dispatch.ts`, `src/cli/help.ts`, `src/cli/index.ts`, `src/cli/registry.ts`, `src/codex/ocx-compaction-history.ts`, `src/responses/compaction.ts`, `src/server/management/native-integration-routes.ts`, `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`, 8 `docs-site` lifecycle pages — #3920
- `src/codex/catalog/provider-fetch.ts`, `src/storage/cleanup.ts`, `src/server/management/logs-usage-routes.ts`, `gui/src/pages/Storage.tsx`, 9 `gui/src/i18n/*.ts` — #3863

Test files touched: `tests/codex-integration/{codex-routing,codex-spark-visibility,codex-quota-parser-parity,codex-models-cache-invalidate,codex-composed-acceptance,history-ocx-compaction-recovery,codex-catalog}.test.ts`, `tests/web-search/web-search-progress-stream.test.ts`, `tests/providers/muse-spark-web-search-compat.test.ts`, `tests/cli/{cli-help,cli-restore-back}.test.ts`, `tests/storage/storage-cleanup.test.ts`.

**Two coordination points the main session should check against the fixture train:**

1. **`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`** (#3920). Any fixture-train PR adding a test file must edit these same two files, and both are single-line-insert-into-a-sorted-list, which is the classic silent-conflict shape. Sequence #3920 and any layout-touching fixture PR rather than stacking them in parallel.
2. **`tests/codex-integration/codex-composed-acceptance.test.ts`** (#3920, +4/-2). A broad acceptance file that a fixture-determinism train is likely to touch.

**Recommended Lane B stack order** (all onto current `dev`, each needing a final-head `ci.yml` dispatch before merge):

1. #3964 — smallest, not a draft, already `review-ready`, no shared files.
2. #3979 — one source line, no shared files.
3. #4008 — three source lines, first toucher of `quota.ts`.
4. #4018 — second toucher of `quota.ts`, verified stackable on #4008.
5. #3981 — no shared files.
6. #3863 — no shared files, but needs the `landed-via-maintainer` label removed and `Co-authored-by: x3M3x` preserved.
7. #3920 — largest and the only layout-file toucher; sequence last so a fixture-train layout edit can be reconciled once.

Items 1–5 have no file overlap with each other except the verified `quota.ts` pair, so they can be carried onto separate maintainer branches in parallel and merged in any order.

**Drafts:** #4018, #4008, #3981, #3979, #3920 are all `isDraft: true` with `REVIEW_REQUIRED`. Per `AGENTS.md`, contributor PRs open in draft and the four-box readiness checklist gates them; a maintainer carry branch with a compliant Summary/Verification/Checklist description is the shortest path for each, preserving each author in a `Co-authored-by` trailer.

---

## Method and limits

- Every `path:line` quote is from `/tmp/ocx-249.xGQnxl/wt` at `7dc7dc99e65268bc8764e19840952256b030bce9`. Index re-read immediately before writing this verdict: `git status --porcelain` empty, HEAD unchanged.
- Conflict checks used `git merge-tree --write-tree` against dev; the research worktree index was never touched.
- Focused tests and typechecks ran in a scratch `git worktree` under `mktemp -d`, with `node_modules` symlinked from the main checkout. The scratch worktree was removed and pruned; `git worktree list` confirms it is gone.
- **No full suite was run.** `bun x tsc --noEmit` was run only for #3954 and #4016, where a duplicate-key regression was suspected from reading the diff.
- **No product CI exists at any head in this lane.** All green marks above are hygiene gates. Every LAND verdict is conditional on a final-head `ci.yml` dispatch.
- I did not inspect the luvs01 fixture-train PRs; the overlap section reports Lane B's footprint only.
- Read-only throughout: no push, comment, merge, close, or edit to `src/`, `tests/`, or `gui/` in either checkout. This document is the only file written.
