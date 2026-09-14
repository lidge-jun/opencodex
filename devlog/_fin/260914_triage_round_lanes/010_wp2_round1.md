# 010 — wp2: Round 1

Bottom layers plus the clean half of the merge track. Target: five PRs merged into
`dev` in one CI generation, closed by a post-merge `dev` run.

Every source fact below was read live on 2026-09-14 by read-only recon agents.
Re-verify line numbers before editing; `dev` moves.

## Round 1 contents

| # | Branch or PR | Owner | Deliverable |
|---|---|---|---|
| 1 | `codex/260914-l1-bridge-backend-model` | L1 | sidecar model bound to the bridge backend |
| 2 | `codex/260914-l2-devin-catalog-supports-images` | L2 | catalog parser preserves field 5 as true/false/unknown |
| 3 | `codex/260914-l3-cursor-spare-budget` | L3 | spare-budget restoration of recent invocations |
| 4 | #4511 (`maoxin1234:fix/vision-native-model-capabilities`) | main | merge as-is |
| 5 | #4512 (`maoxin1234:fix/audio-outcome-accounting`) | main | merge as-is |

## L1 bottom — bridge backend/model agreement

File: `src/web-search/passthrough-bridge.ts`.

`sidecarSettingsForBridge` (677-705) takes `sidecar.model` from the global
`config.webSearchSidecar` blob without checking that the global backend equals the
bridge backend, and `core.ts:6290-6296` passes that blob whole. A global
`{backend:"openai", model:"gpt-5.6-luna"}` therefore reaches
`runAnthropicWebSearch` when a provider sets `webSearchBridge.backend: "anthropic"`.
Credentials do not leak — `resolvePassthroughWebSearchBridgeAuth` (155-181)
inspects only the named backend — so this is a model and settings defect, not a key
defect, and the PR body must say exactly that.

```diff
-  sidecar?: Pick<OcxWebSearchSidecarConfig, "model" | "reasoning" | "xSearch">;
+  sidecar?: Pick<OcxWebSearchSidecarConfig, "backend" | "model" | "reasoning" | "xSearch">;

-  const model = backend === "anthropic" ? sidecar.model ?? DEFAULT_ANTHROPIC_BRIDGE_MODEL
-    : backend === "xai" ? sidecar.model ?? DEFAULT_XAI_BRIDGE_MODEL
-    : backend === "gemini" ? sidecar.model ?? DEFAULT_GEMINI_BRIDGE_MODEL
-    : sidecar.model ?? DEFAULT_OPENAI_BRIDGE_MODEL;
+  const model = modelForBridgeBackend(backend, sidecar);
```

`modelForBridgeBackend` applies `sidecar.model` only when
`resolveSidecarBackend(sidecar.backend) === backend`, and otherwise returns the
backend default. Reuse `resolveSidecarBackend` from `src/web-search/index.ts`; do
not invent a second resolver. `planWebSearch` (index.ts:112-208) already pins the
backend first and is the precedent to follow.

Tests go in `tests/web-search/web-search-passthrough-bridge.test.ts`: a global
openai model with an anthropic bridge yields `claude-sonnet-5`; a matching backend
keeps the override; repeat the matrix for xai and gemini. Structure owner is
`structure/runtime.md`, hosted-search bridge contract at L238-247.

Destination policy stays out of this layer. That is L1 top.

## L2 bottom — Devin catalog preserves supportsImages

File: `src/adapters/devin/cloud-direct/catalog.ts`.

`parseCatalogBuffer` (107-141) has arms for fields 1, 4, 18 and 22 and no default,
so `ClientModelConfig` field 5 is dropped by omission. `disabled` defaults to
`false` when absent; image support must not copy that pattern, because an absent
field has to stay unknown. That is the #1796 precedent, and Antigravity already
implements the tri-state at `src/providers/antigravity-models.ts`:587-592.

```diff
 export interface ModelCatalogEntry {
   modelUid: string; label: string; disabled: boolean; contextWindow?: number;
+  /** ClientModelConfig #5. Present true/false asserts; omitted means unknown. */
+  supportsImages?: boolean;
 }
+    let supportsImages: boolean | undefined;
       } else if (sf.num === 4 && sf.wire === 0) { disabled = sf.value === 1n;
+      } else if (sf.num === 5 && sf.wire === 0) { supportsImages = sf.value === 1n;
       byUid.set(modelUid, { modelUid, label: label || modelUid, disabled,
         ...(contextWindow > 0 ? { contextWindow } : {}),
+        ...(supportsImages !== undefined ? { supportsImages } : {}),
       });
```

Extend the file-header schema comment with `#5 supportsImages bool` in the same
commit; the comment is the only schema documentation this parser has.

Test: extend `"the catalog parser reads the per-account context window"` in
`tests/providers/devin-adapter.test.ts` (300-323) with three cases built from
`encodeVarintField(5, 1)`, `encodeVarintField(5, 0)` and omission, asserting
`true`, `false` and `undefined`. Encoder helpers already exist at
`src/adapters/devin/cloud-direct/wire.ts`:54-63.

PR #4511 touches only `src/vision/eligibility.ts` and its test, so there is no file
overlap. Do not wait on it and do not restack into it.

Corrections returned by L2 after doing the work: `encodeVarintField` is at
`wire.ts`:63-65, not 54-63; `parseCatalogBuffer` spans 107-142; the file-header
schema comment omits field 18 as well as field 5, so the patch documents both and
carries per-field provenance instead of a blanket "verified against extension.js"
claim, because field 5 identity is corroborated from external ClientModelConfig
documentation rather than re-read from the vendor bundle. For this layer the only
structure owner that actually documents the Devin adapter in prose is
`structure/adapters/registry.md`; `structure/catalog.md` has no Devin mention and
owns the round-2 provider-fetch surface instead.

## L3 bottom — Cursor spare-budget restoration

File: `src/adapters/cursor/protobuf-request.ts`. The per-call 2 KiB cap
(`CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT`, line 84) is applied at envelope
construction in `toolCallArgumentsText` (937-967) and never revisited, even when
almost all of the 192-root and 512 KiB envelope is unused. A 4,693-byte successful
call loses its tail inside a 6,011-byte replay.

Insert a second pass after `selected` is assembled (near line 694) and before the
return. It spends only leftover aggregate bytes, newest `toolResult` first, skips
`outputElided` roots, and never evicts a retained root. It does not remove the cap:
admission still uses the 2 KiB prefix.

Two review-surviving details from recon:

- Gate on `echoToolResultInRoot && replayedCalls` rather than
  `externalModel && replayedCalls`. Native `composer-2.5` echoes results into roots
  but is not an external wire model, so the narrower gate would leave it capped.
- Use the callback form of `String.prototype.replace` so replacement patterns
  appearing inside serialized arguments are not expanded by the replace call.

The two existing 600 KiB tests in
`tests/providers/cursor/cursor-tool-result-invocation.test.ts` stay unchanged and
must stay green: `"PROBE a huge argument must not evict the result output from root
replay"` (244) and `"the truncated invocation line stays within the declared
argument budget"` (261). They are the proof that the cap still bites under
pressure.

The PR body states that this claims nothing about #3506 causation. The four
rejected patches there were 1,648, 1,396, 1,670 and 1,900 bytes, all under the cap.

## Merge track in round 1

Every contributor PR has Cross-platform CI queued and stuck at `action_required`;
none has ever executed a job. Approving those runs is the first action of the
round, not the last.

- #4511 at `6d926244101cb6234b66634464007268a06b1d89`: no outstanding reviewer ask,
  non-draft, readiness 4/4. Approve CI, wait for green, merge.
- #4512 at `0235ce604cb907185295e42b05754d11d11a0bb2`: non-draft, readiness 4/4,
  one open CodeRabbit ask for live `handleExternalLive` regressions. Do not push a
  carry commit onto that branch. The readiness gate binds to the exact head, so a
  new push resets the checklist and re-drafts the PR. Merge as-is and deliver the
  asked coverage as our own follow-up PR in round 2.
- #4528 (2/4) and #4529 (0/4) are drafts. Approve their CI in round 1 so round 2
  has real information, but plan them as carries rather than direct merges.

## Merge and proof mechanics

Each lane pushes with `--no-verify`, fast-forward only. Non-tip chain commits carry
`[skip ci]`. For each PR, dispatch CI explicitly, because a sync or rebase does not
reliably queue it:

```sh
gh workflow run ci.yml --ref <branch> -F lane=all
```

One ruleset term the batch argument has to respect:
`require_extra_approval_for_unattributed_changes` is true on `dev`. A carry that
replays another author's commits can therefore need an approval beyond the standard
one. The mitigation is to author each carry as our own commits with a
`Co-authored-by` trailer rather than cherry-picking the contributor's commits; the
trailer is what GitHub reads for credit, and the change stays attributed to the
pushing author for the ruleset.

Wait for that run at the exact head SHA, then merge. Because `dev` carries no
required-status-check rule and no strict up-to-date rule, the five PRs may merge
back to back inside one generation; their write-sets are disjoint, so the residual
risk is semantic rather than textual. Close the round with one post-merge `dev`
Cross-platform CI run and record its id.

Every PR body fills Summary, Verification and Checklist, and states plainly that
the local suite, typecheck, build and install were NOT RUN, naming the hosted run
id and SHA as the only proof.

One thing the lanes discovered that makes this policy stronger than intended: a
fresh lane worktree has no `node_modules`, so a focused `bun test` cannot execute
at all without `bun install`. Local focused runs are therefore impossible in a lane
rather than merely disallowed, and hosted CI is the only evidence that could exist.
The one check that runs without install is `bun run structure:check`, used for
debugging the doc gate and never cited as proof.

