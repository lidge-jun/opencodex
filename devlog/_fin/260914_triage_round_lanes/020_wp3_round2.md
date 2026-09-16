# 020 — wp3: Round 2

Top layers, the carries, and the security-gated remainder. Target: four to six more
PRs merged, bringing the loop total to 9-11.


## Round-2 state at entry (recorded 2026-09-14)

Round 1 landed six PRs and the tree underneath this document moved, so these facts
replace the assumptions the sections below were written against.

`dev` is `866367a6f`. It carries all six round-1 merges plus a
`chore(release): open dev at 2.55.0` commit pushed by a separate release train.
That push is also why the first post-merge `dev` run was cancelled: the concurrency
group killed it when the version bump arrived. The joint proof was retaken at the
new tip, run `34778300807`, success with no failing jobs. Expect the same to happen
again — if a `dev` run is cancelled, check whether `dev` moved before treating it
as a failure, and retake the proof at the tip.

Three round-2 targets are already resolved or partly resolved:

- #4501 and #4502 are CLOSED as COMPLETED. Repository automation closed them when
  #4511 and #4512 merged, so wp4 does not need to close them.
- #4529 is CLOSED with a comment naming #4545 and the merge commit
  `e30f1d27eec4ac22baeb6d5212413bc645bb6786`. The carry rationale in the L4 section
  below is now settled history rather than a pending decision.
- #4522 is still OPEN and is now closable: the carry that fixes it has landed.
  It belongs in the wp4 sweep with `e30f1d27e` as its reference.

#4528 moved to head `d1d8d45f2` after the author pushed again, which reset its
readiness checklist and left fresh workflow runs waiting at `action_required`.
Those were approved on entry to round 2, so its first real CI verdict should exist
by the time the round is ready to merge.

One process correction carried forward from round 1: a push to a branch with an
open PR already queues a full Cross-platform CI run, so the explicit
`gh workflow run` dispatch in the sections below is a fallback, not a routine step.
Doing both produced eight full runs for four PRs and roughly two hundred jobs
competing for the same macOS runners; four duplicates were cancelled to clear it.
Dispatch explicitly only when no run appears for the exact head.

## Retarget mechanics

Round 1 merges the bottom of each chain. Delete the bottom branch on merge and
GitHub retargets the open child PR to `dev` by itself, which is the cheapest
correct path. Then bring `dev` into the child by merging it, not by rebasing:
`dev` blocks non-fast-forward pushes, and an append-only merge keeps the child
pushable with `--no-verify` and no force. Re-dispatch CI after that merge, because
the child head changed and the earlier green no longer describes it.

## L1 top — endpoint destination policy (#4519)

The policy already exists and is already applied to provider `baseUrl`. The defect
is that no call site applies it to `webSearchBridge.endpoint`, so an operator
endpoint is returned verbatim after a shape-only check and the serving provider key
is sent there as a Bearer token.

Reuse `providerDestinationConfigError` from `src/lib/destination-policy.ts`:306.
Metadata destinations always fail; loopback, localhost and private require the
existing `allowPrivateNetwork` opt-in or the registry default. Do not write a new
classifier.

Two call sites, both needed, because config-time alone does not cover a file that
was edited by hand.

An audit against the real signatures corrected where the config-time half goes.
`providerWebSearchBridgeConfigError` takes `(value: unknown)` and receives only the
bridge object, so neither the provider name nor `allowPrivateNetwork` is in scope
inside it and the sketch below does not compile as placed. Put the check at its sole
caller, `src/server/auth-cors.ts`:769, where `name`, `raw` and `typed` are already
in scope, or widen the helper's signature and update that caller. Either is fine;
the PR says which.

The real signature is
`providerDestinationConfigError(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): string | null`,
and every message it returns begins with `baseUrl`, including the secure-transport
arm, so one `/^baseUrl/` rewrite covers them all.

The file-load path at `src/config.ts`:684 only schema-parses with
`.catch(undefined)` and runs no error function, so a hand-edited config never reaches
the config-time check at all. That makes the runtime planner check the load-bearing
one rather than a belt over a brace, and the PR description should say so. It is the
same shape `baseUrl` itself already has.

```diff
# src/config.ts  providerWebSearchBridgeConfigError (522-545)
+  const destinationError = providerDestinationConfigError(providerName, {
+    baseUrl: endpoint, allowPrivateNetwork: provider.allowPrivateNetwork,
+  });
+  if (destinationError) return destinationError.replace(/^baseUrl/, "webSearchBridge.endpoint");

# src/web-search/passthrough-bridge.ts  resolveOllamaWebSearchEndpoint (119-134)
   if (configured !== undefined) {
-    return originOf(configured) === undefined ? undefined : configured;
+    if (originOf(configured) === undefined) return undefined;
+    if (providerDestinationConfigError(providerName, {
+      baseUrl: configured, allowPrivateNetwork: provider.allowPrivateNetwork,
+    })) return undefined;
+    return configured;
   }
```

The runtime check needs the provider name for the registry default; the planner
already holds the provider object, so thread the name through
`planPassthroughWebSearchBridge`. The management write at
`src/server/auth-cors.ts`:769-771 has `name` and `raw` in scope already.

The comment at `src/config.ts`:508-512 claims the planner re-validates the origin
before any key is sent. That is weak rather than false: the planner does re-check
the origin, but only through `originOf`, which is a URL-shape parse and not a
destination assessment. Tighten the comment to say which check actually runs, and
say it precisely, because this is the security-gated PR and an overstated defect
claim in its own description is the fastest way to lose a reviewer.

Tests: metadata endpoint rejected at config write and leaves the bridge disarmed at
plan time; a private address rejected without opt-in and accepted with it; the
canonical `https://ollama.com/api/web_search` still passes. Do not fold DNS
resolution into this slice; `baseUrl` does not do it at this boundary either.

This layer is security-sensitive under MAINTAINERS.md and needs independent review.
If that review has not happened by the time the rest of round 2 is ready, merge the
rest and leave this PR open rather than holding the round.

## L2 top — capability propagation and precedence

Carry the parsed flag through to the client. Three hops, all named by recon:

```diff
# src/adapters/devin/live-models.ts  DevinUsableModelsResult (140-142)
-  | { ok: true; models: string[]; contextWindows: ...; efforts: ... }
+  | { ok: true; models: string[]; contextWindows: ...; efforts: ...; inputModalities: Record<string, string[]> }

# src/codex/catalog/provider-fetch.ts  Devin branch (1736-1750)
+          ...(liveResult.inputModalities[id]?.length
+            ? { inputModalities: liveResult.inputModalities[id] } : {}),
           ...catalogHintsFromProviderConfig(...),
```

Collapse policy across the effort variants of one base, mirroring the `Math.min`
treatment of context windows: all known values true gives `["text","image"]`, all
known false gives `["text"]`, and any unknown or any disagreement omits the key.
One unsuffixed unknown row must not poison a measured image base, and a single
false must not be overridden by its siblings.

Precedence needs no Devin special case. `applyProviderConfigHints` (753-827) already
puts exact `modelCapabilities[id].inputModalities` first, then the fuzzy legacy
record, then the sidecar-consumer rewrite that adds image so the app does not block
attachments, and the live row survives only when none of those fired. Keep
`catalogHintsFromProviderConfig` spreading last, which is what makes that ordering
real.

Tests: the `fetchDevinUsableModels` collapse matrix against a fake cached catalog;
a live image row with an exact operator text-only declaration still taking the
existing sidecar path; and the existing `"discovery-derived text-only rows are NOT
advertised image"` case staying green.

## L3 top — budget and ordering regressions

Three cases in `tests/providers/cursor/cursor-tool-result-invocation.test.ts`: spare
space preserves a complete just-over-cap successful call; spare space restores the
newest call without evicting an older result; a checkpoint-covered call keeps its
tail in the result suffix. Add UTF-8 round-trip and an `outputElided` skip if the
lane has room. Port the fixture out of scratch into the suite rather than leaving
it in `.tmp`.

## L4 — the carries

Both carries need a `Co-authored-by` trailer in a branch commit so it survives the
squash. Prose credit is not equivalent; `missing_coauthor_credit` in
`.github/scripts/pr-carry-attribution.cjs` is the check, and CREDITS.md is the list
of 27 landings that already got this wrong.

L4-a carries #4529 by Voyagerroc-Lab: the version-skew refusal plus the `"unknown"`
health-version case that CodeRabbit asked for. That case must be authored, not
cloned. The `"0.0.0"` placeholder test it parallels exists only inside #4529's own
head diff; `dev` has no such test, and `0.0.0` appears nowhere under `tests/`. The
carry brings the placeholder test along and adds the unknown case beside it. The
carry also writes `src/cli/index.ts` and `src/cli/system-restart-client.ts`, so it
owes a structure update and `bun run structure:check` like any source change. The carry
exists because #4529 is a draft at 0/4 whose readiness gate the author has not
completed; carrying is the repository-sanctioned way past that, and #4529 closes
with credit once the carry lands.

L4-b is a follow-up rather than a carry: #4512 merges as-is in round 1, and this PR
adds the two live `handleExternalLive` regressions to
`tests/server/audio-dictation.test.ts` — invalid answer data yielding client 502
while `recordCodexUpstreamOutcome` books 200, and alias-registration failure
yielding client 503 with the same booked 200. They do not belong in
`tests/server/audio-transcriptions.test.ts`; that file already covers the
transcription half.

## #4528

Draft at 2/4, 21 files, security-adjacent, and its only live code ask is one
Turkish wording fix at `docs-site/src/content/docs/tr/guides/combos.md`:410. The
stale CodeRabbit thread about image-failover documentation is already satisfied by
the current head and should be resolved rather than acted on. Decide in round 2 on
evidence: if its approved CI run is green and an independent security review is
available, merge; otherwise leave it open and record NEEDS_HUMAN for that item
alone.

