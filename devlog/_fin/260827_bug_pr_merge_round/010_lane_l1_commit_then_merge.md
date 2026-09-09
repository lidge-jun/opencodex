# L1 — commit-then-merge

Members: #2672, #2674, #2671, #2684. Each lands on its own head branch and merges to dev.

## Order and dependency

```
#2672 (base dev)  ->  #2674 (base = #2672 head)  ->  #2671  ->  #2684
```

#2674 is a declared stacked child. `enforce-target` skips the wrong-base gate for such
children, so it is legitimate; after #2672 merges, retarget #2674 to `dev` before
merging it.

## #2672 — canonical forward prompt envelope

Full CI matrix green (ci, macos, all 4 test shards, keyring x3, npm-global x3, gates,
storage policy, api usage, react-doctor). No change needed. The implementation folds
text-only `system` input messages into top-level `instructions` and strips
`truncation`, both scoped to `isCanonicalOpenAiForwardProvider`. The fold is atomic: a
single multimodal system block aborts the whole rewrite, so nothing is silently
dropped. Compatibility manifest bumped 1.0.0 -> 1.1.0 with new fixture assertions, and
both `adapters.md` and `proxy-formats.md` document the destination scoping.

Action: merge as-is.

## #2674 — Posit tool continuations

Full CI matrix green. Adds `stripPromptCacheBreakpoints` with an explicit depth cap
(64) and node budget (100k) that aborts atomically rather than returning a partially
rewritten subtree, plus `item_reference` removal gated on `store: false`. Docs updated
in the same two reference pages.

Action: after #2672 merges, retarget base to `dev`, confirm CI re-runs green, merge.

## #2671 — Muse Spark image input

Five lines in `src/providers/registry.ts` adding
`"muse-spark-1.2-contributor": ["text", "image"]` to the opencode-go
`modelInputModalities` map, plus four focused tests. CodeRabbit found nothing. The
maintainer review recommends merge with one addition: a test proving the configured
value still wins when the live discovery row advertises only `["text"]`.

Action: add that test on the head branch, then merge.

Open questions the reviewer raised and this round does NOT resolve (they are not
blockers): whether Zen Go also serves the non-contributor `muse-spark-1.2` id, and
whether Muse should carry a context window like its neighbours.

## #2684 — Azure Model Router function schemas

92/5 across two files. `isAzureOpenAiChatTarget` matches four Azure hostname suffixes;
`sanitizeAzureChatToolParameters` reuses the existing `ensureZenRootObjectSchema`
flattening, then deletes the six forbidden root keys and drops `strict`. The second
test asserts a non-Azure base URL is left completely untouched, which is the
containment proof this kind of change needs.

Blockers to clear before merge: `enforce-target` FAIL and `label` FAIL. Both are
hygiene, not code — the PR is a draft with an incomplete description checklist. Verify
what each check actually demands, fix the PR body, and re-run.

## Gate before any L1 merge

`bun run typecheck` plus the focused tests for each touched subsystem. #2672 and #2674
touch `src/adapters/openai-responses.ts`, which is shared runtime, so the full suite
must be green at the merge commit — but both already carry a green full matrix at their
own heads, so re-running the full suite is only required if a rebase changes the tree.
