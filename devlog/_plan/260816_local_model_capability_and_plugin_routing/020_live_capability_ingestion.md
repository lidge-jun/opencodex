# 020 — Phase 2: absorb llama.cpp served context from live discovery

Diff-level implementation doc. Depends on Phase 1 (`010_catalog_row_shape.md`):
without the provenance channel, anything this phase learns is still invisible to
routing.

**Re-scoped after audit round 1** — see `003_audit_synthesis_round1.md` (B3).
The first draft assumed one merged model item. The real parser never builds
one, so half the original goal moves to a filed issue.

## What the server actually returns

`GET http://100.100.125.116:8081/v1/models` returns a dual-envelope body:

    { "models": [ { "name": "qwen3.8-27b-nvfp4",
                    "capabilities": ["completion", "multimodal"] } ],
      "object": "list",
      "data":   [ { "id": "qwen3.8-27b-nvfp4", "owned_by": "llamacpp",
                    "meta": { "n_ctx": 262144, "n_ctx_train": 262144 } } ] }

The image signal (`multimodal`) is in `models[]`. The context signal
(`meta.n_ctx`) is in `data[]`.

`extractProviderModelItems()` reads ONLY `data` envelopes or top-level arrays,
and says so deliberately (src/providers/model-discovery.ts:337-343):

    // Together-style top-level /models arrays. Catalog discovery must not treat a stray
    // `models` key on openai-chat responses as valid — only `data` envelopes or top-level arrays.

Verified by running the verbatim payload through it: one surviving item, and
`catalogHintsFromModelsApiItem` returns `{}` for it.

## Scope decision

IN: `meta.n_ctx` / `meta.n_ctx_train` as context sources. This is a pure
addition to an existing precedence list, affects only rows that reach the
parser, and is independently useful for every llama.cpp deployment.

OUT: the two harder halves of the image gap, now tracked as **issue #1797**:

1. Cross-envelope merging of `models[]` into `data[]`. That relaxes a
   deliberately conservative discovery boundary (src/providers/model-discovery.ts:337)
   whose comment explains why it refuses a stray `models` key. It needs
   identity-safe joining by model id and belongs in its own audited unit.
2. Mapping the `multimodal` capability token to image input. Audit round 4
   showed the first draft of this doc was WRONG to imply the merge alone
   would restore image evidence: even a hand-merged item stays image-unknown,
   because modelInputModalities (src/codex/catalog/provider-fetch.ts:991)
   recognizes only vision / image-input / image_input.

   Reviewer proof:

       catalogHintsFromModelsApiItem("lidge", {
         meta: { n_ctx: 262144 }, capabilities: ["completion", "multimodal"] })
       => { "capabilities": ["completion", "multimodal"] }   // no inputModalities

So this phase fixes ONLY the context source. The image gap is fully deferred,
both halves of it, to #1797.

Also OUT (B8): the `ProviderModelsApiItem` type edit. The declaration is
already `Record<string, unknown> & { id: string }`
(src/providers/model-discovery.ts:33), so `item.meta` is permitted with no
change.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/codex/catalog/provider-fetch.ts` | MODIFY | Read `meta.n_ctx` / `meta.n_ctx_train` as context sources |
| `tests/catalog-llamacpp-capabilities.test.ts` | NEW | Verbatim-payload and precedence coverage |

## MODIFY — catalogHintsFromModelsApiItem()

Before:

    const limits = plainRecord(metadata?.limits);
    const contextWindow =
      positiveSafeInteger(
        limits?.max_context_length,
        metadata?.context_length,
        item.context_length,
        item.context_size,
        item.max_model_len,
        item.max_context_length,
      );

After:

    const limits = plainRecord(metadata?.limits);
    // llama.cpp reports the served context under `meta`: `n_ctx` is what the
    // server was actually started with, `n_ctx_train` the model's trained
    // maximum. Prefer the served value — routing must not promise a window the
    // running server will refuse. Both come LAST so no provider that already
    // supplies a recognized field changes behavior.
    const meta = plainRecord(item.meta);
    const contextWindow =
      positiveSafeInteger(
        limits?.max_context_length,
        metadata?.context_length,
        item.context_length,
        item.context_size,
        item.max_model_len,
        item.max_context_length,
        meta?.n_ctx,
        meta?.n_ctx_train,
      );

## NEW tests/catalog-llamacpp-capabilities.test.ts

Rewritten after B5: the original precedence tests passed unchanged today and
so proved nothing.

    test("absorbs meta.n_ctx from the verbatim llama.cpp data[] item", () => {
      // This is the item extractProviderModelItems actually produces from the
      // observed dual-envelope body — not a hand-merged one.
      const hints = catalogHintsFromModelsApiItem("lidge", {
        id: "qwen3.8-27b-nvfp4",
        object: "model",
        owned_by: "llamacpp",
        meta: { n_ctx: 262144, n_ctx_train: 262144 },
      });
      expect(hints.contextWindow).toBe(262144);
    });

    test("prefers the served n_ctx over the trained maximum", () => {
      const hints = catalogHintsFromModelsApiItem("lidge", {
        id: "short-ctx",
        meta: { n_ctx: 8192, n_ctx_train: 262144 },
      });
      expect(hints.contextWindow).toBe(8192);
    });

    test("a recognized context field still wins over meta (precedence)", () => {
      // Contested: without the ordering guarantee this could return 8192.
      const hints = catalogHintsFromModelsApiItem("lidge", {
        id: "both",
        context_length: 32768,
        meta: { n_ctx: 8192 },
      });
      expect(hints.contextWindow).toBe(32768);
    });

    test("the dual-envelope body still yields no image evidence (documents the gap)", () => {
      // models[] carries "multimodal" but discovery reads only data[]. This
      // asserts the KNOWN limitation so the filed issue has a live witness and
      // a future fix has a test to flip.
      const extracted = extractProviderModelItems(VERBATIM_LLAMACPP_BODY, discovery);
      const hints = catalogHintsFromModelsApiItem("lidge", extracted.items[0]);
      expect(hints.contextWindow).toBe(262144);
      expect(hints.inputModalities).toBeUndefined();
    });

The fourth test is the honest part: it encodes what this phase does NOT fix.

## Accept criteria

1. Measured pre-change matrix (audit round 2 ran these):

   | Test | Before | After |
   |------|--------|-------|
   | 1 verbatim meta.n_ctx | FAIL (hints `{}`) | PASS |
   | 2 served n_ctx over trained | FAIL (hints `{}`) | PASS |
   | 3 recognized field wins over meta | PASS already | PASS |
   | 4 dual-envelope gap characterization | FAIL (asserts the new context value too) | PASS |

   Test 3 passes today because recognized fields already win while `meta`
   is ignored; it guards the ordering against a future reshuffle rather
   than proving this change. Tests 1, 2 and 4 are the activation evidence.
2. Test 4 keeps characterizing the surviving image gap after the change:
   contextWindow present, inputModalities still undefined. It is the live
   witness for #1797 and the test a future fix flips.
3. Issue #1797 is filed and linked before this phase closes (verified with
   `gh issue view 1797`). A deferral with no tracking issue is not a
   deferral, it is a silent drop.
4. `bun x tsc --noEmit` clean.
5. The targeted suites pass on lidge at the pushed head, and the full suite
   runs with only the documented environment failures — `provider-fetch.ts`
   is a shared surface touched by many catalog suites, so the full run is
   required even though it is not fully green.

   Recorded result (see `040_implementation_record.md`): 12337 tests across
   792 files, 7 fail. All seven are `Cannot find package 'react'` /
   `react/jsx-dev-runtime` from `gui/` sources, because the isolated clone
   installs no GUI dependencies; they reproduce identically on an unmodified
   `dev` checkout. Claiming this criterion as "green" would have been false —
   the honest bar is: both new suites pass, and no failure is attributable to
   this change.

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `bun run test tests/catalog-llamacpp-capabilities.test.ts` | YES — direct argument | New file |
| `bun x tsc --noEmit` | YES — tsconfig include covers `src/**` | Verified exit 0 pre-change |
| Remote exact-head suite (command below) | YES — existing catalog suites exercise `provider-fetch.ts` | Required: shared surface |

## Field chain (PLAN-FIELD-CHAIN-01)

| Stage | Path | State |
|-------|------|-------|
| creation | upstream server `/v1/models` response | unchanged |
| extraction | `extractProviderModelItems`, src/providers/model-discovery.ts:329 | unchanged (data[] only) |
| hint mapping | `catalogHintsFromModelsApiItem` | NEW: meta.n_ctx read |
| serialization | `applyCatalogModelMetadata` (Phase 1 provenance) | carries the value to routing |
| consumer | `candidateCapabilityEvidence` | receives contextWindow |

N/A: no new enum value and no new type member (B8).

## Bypass record (PLAN-BYPASS-NAMED-01)

No enforcement added. Tier: N/A. Executing surface: none. Known bypass: a
server reporting context nowhere in the recognized list still yields unknown —
by design. Residual risk: `n_ctx` is trusted as reported; a server misreporting
it would mislead routing exactly as any other context field would. Wording
downgrade: N/A. Final enforcement layer: none.

## Remote exact-head suite (round-5 correction)

Five rounds of audit produced five distinct ways a remote command can lie. The
final form separates PUBLISH from VERIFY, and every step fails closed.

**Step 1 — publish (separate, must succeed on its own).**

    set -eu
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    LOCAL_SHA=$(git rev-parse HEAD)
    git push --no-verify csa906 "$BRANCH"

Round 5 observed this step fail with `! [remote rejected] ... (permission denied)`
while the verification that followed still ran and could have reported success.
Publication is therefore its own command whose exit code is checked before
anything else happens.

**Step 2 — assert the remote actually has this commit.**

    set -eu
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    LOCAL_SHA=$(git rev-parse HEAD)
    REMOTE_SHA=$(git ls-remote csa906 "refs/heads/$BRANCH" | cut -f1)
    test -n "$REMOTE_SHA"
    test "$REMOTE_SHA" = "$LOCAL_SHA"

`test -n` matters independently: a failed push leaves `REMOTE_SHA` EMPTY, and an
empty-vs-empty comparison would otherwise pass.

**Step 3 — verify in an isolated scratch clone.**

    LOCAL_SHA=$(git rev-parse HEAD)
    ssh lidge "set -eu
      export PATH=\"\$HOME/.bun/bin:\$PATH\"
      command -v bun >/dev/null
      WORKDIR=\$(mktemp -d -t ocx-verify-XXXXXX)
      trap 'rm -rf \"\$WORKDIR\"' EXIT
      git clone --quiet --no-checkout https://github.com/csa906/opencodex.git \"\$WORKDIR\"
      cd \"\$WORKDIR\"
      git fetch --quiet origin $LOCAL_SHA
      git checkout --quiet --detach $LOCAL_SHA
      test \"\$(git rev-parse HEAD)\" = \"$LOCAL_SHA\"
      bun install --frozen-lockfile
      bun run test"

Each guard exists because a specific failure was observed in audit:

| Guard | Observed failure it prevents |
|-------|------------------------------|
| Steps split + `set -eu` | round 5: push was rejected and `ls-remote` returned empty, yet the suite still ran and could have reported success |
| `test -n "$REMOTE_SHA"` | an empty remote SHA comparing equal to an empty string |
| `git ls-remote` SHA equality | `fatal: remote error: upload-pack: not our ref 60fd5a7d9...` on an unpushed commit |
| `export PATH` + `command -v bun` | `command -v bun` empty over non-interactive ssh while `/home/lidgeai/.bun/bin/bun` exists |
| `mktemp -d` + `trap` cleanup | `~/ocx-ci/opencodex` had modified `src/bridge.ts`, `src/server/responses/core.ts`; a run there proves nothing about this change |
| `git rev-parse HEAD` equality | a stale checkout reporting a green suite for different code |

Each step recomputes `BRANCH`/`LOCAL_SHA` so it is independently runnable in a
fresh shell: audit round 6 showed Step 2 aborting with `BRANCH: parameter not
set` when the variables only existed in Step 1. That failed closed, but a
verifier that only works when pasted in one session is not the verifier the
doc describes.

C runs these three literal steps in order and pastes each exit code. A green
suite whose publication step failed is not evidence.

Note: round 5 ran step 3 successfully and recorded `12299 pass, 11 skip, 7 fail`
on an unrelated tree state. C must reach a green run at THIS unit's head, or
triage each failure against `dev` before claiming the phase verified.
