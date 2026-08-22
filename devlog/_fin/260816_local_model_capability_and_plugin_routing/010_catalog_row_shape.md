# 010 — Phase 1: give the catalog explicit capability provenance

Diff-level implementation doc. Research: `001_capability_evidence_defect.md`.
**Revised after audit round 1** — see `003_audit_synthesis_round1.md`. The first
draft proposed reading the catalog's `context_window`/`input_modalities`
directly. That was rejected: those fields are synthesized for Codex's strict
parser, so reading them turns unknown into a false negative (B2), and matching
a row disarms the tool-capability fallback (B1).

## Goal

A model whose only evidence source is the catalog must carry its REAL
contextWindow and image evidence — and only when that evidence is real. A
synthesized compatibility default must stay unknown, and no dimension that is
correct today may regress.

## Why not read context_window / input_modalities

`ensureStrictCatalogFields()` fills those fields so Codex's parser accepts the
file, whether or not any provider asserted them:

    // src/codex/catalog/parsing.ts:315
    if (!Array.isArray(entry.input_modalities) && !options.preserveExactInputModalities) {
      entry.input_modalities = ["text"];
    }
    // src/codex/catalog/parsing.ts:328
    const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;

Every row therefore has both fields, and their presence says nothing about what
is known. Routing must distinguish "the provider said text-only" from "nobody
said anything", so it needs a separate channel.

## Scope boundary

IN: the provenance stamp in `src/codex/catalog/effort.ts` (sourcing both the
CatalogModel and the jawcode generated-metadata lookup), the reader in
`src/routing/capability.ts`, the shared generated-metadata lookup export in
`src/codex/catalog/parsing.ts`, the `supportsImages` tri-state restoration in
`src/providers/antigravity-models.ts` (added after audit round 5), and the
focused tests including the two writer-through-normalizer regressions.
OUT: the evidence priority order, the memoization strategy, the policy
evaluator, reasoning-effort ingestion, and every other module.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/codex/catalog/effort.ts` | MODIFY | Stamp `opencodex_capability_provenance` for non-combo rows only |
| `src/providers/antigravity-models.ts` | MODIFY | Restore the supportsImages tri-state (absent != false) |
| `src/codex/catalog/parsing.ts` | MODIFY | Export the generated-metadata lookup so `effort.ts` shares it instead of duplicating |
| `src/routing/capability.ts` | MODIFY | Read the provenance block; make the adapter tool fallback unconditional |
| `tests/routing-capability-catalog.test.ts` | NEW | Real evidence survives; synthesized defaults stay unknown; tools never regresses |

## MODIFY 1 — src/codex/catalog/effort.ts

`applyCatalogModelMetadata()` writes exclusively inside guarded blocks that test
the `CatalogModel`'s own fields, which makes it the right place to stamp. It is
NOT the only writer of real values, though — see "Capturing jawcode generated
metadata too" below, which is why the stamp reads two sources rather than one.

Existing shape (unchanged):

    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      entry.context_window = model.contextWindow;
      entry.max_context_window = model.contextWindow;
      ...
    }
    if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
      entry.input_modalities = model.inputModalities;
    }

Added at the end of the function — **SUPERSEDED, kept for provenance of the
design's evolution.** This first form stamped only `CatalogModel` fields, with no
combo guard, no generated-metadata fallback, and no context cap. Audit rounds 4,
5 and 7 each proved it insufficient. The single authoritative algorithm is
"Final stamp algorithm" below; do not implement from this snippet.

    const provenance: Record<string, unknown> = { provider: model.provider, model_id: model.id };
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      provenance.context_window = model.contextWindow;
    }
    if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
      provenance.input_modalities = model.inputModalities;
    }
    entry.opencodex_capability_provenance = provenance;

### Final stamp algorithm (authoritative — this is what shipped)

One algorithm, covering all three audit corrections: skip synthesized combo rows
(round 5), read both real evidence sources (round 7), and apply the context cap
(round 8). Verbatim from `src/codex/catalog/effort.ts`:

    function stampCapabilityProvenance(entry: RawEntry, model: CatalogModel): void {
      // Virtual combo rows are synthesized from last-resort defaults (a generic
      // 128k context and a ["text"] modality), so their values are placeholders
      // rather than assertions. Stamping them would reintroduce the exact
      // false-evidence defect this block exists to prevent.
      if (model.provider === COMBO_NAMESPACE) return;

      const meta = generatedModelMetadata(model.provider, model.id);
      const metaContext = typeof meta?.contextWindow === "number" && meta.contextWindow > 0
        // The generated context is capped before it reaches the entry, so
        // provenance must apply the same cap or routing would advertise a
        // window the cap refused.
        ? applyProviderContextCap(meta.contextWindow, model.contextCap) ?? meta.contextWindow
        : undefined;
      const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : metaContext;
      const inputModalities = Array.isArray(model.inputModalities) && model.inputModalities.length > 0
        ? model.inputModalities
        : (Array.isArray(meta?.input) && meta.input.length > 0 ? meta.input : undefined);

      entry.opencodex_capability_provenance = {
        provider: model.provider,
        model_id: model.id,
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(inputModalities !== undefined ? { input_modalities: [...inputModalities] } : {}),
        ...(Array.isArray(model.capabilities) && model.capabilities.length > 0
          ? { capabilities: [...model.capabilities] }
          : {}),
      };
    }

`provider`/`model_id` are always stamped: they are the exact-identity match
that closes the slug-collision hole (B4).

B must confirm the key survives `ensureStrictCatalogFields` and
`normalizeServiceTiers` (neither strips unknown keys today —
`opencodex_catalog_kind` already depends on this, src/codex/catalog/sync.ts:371)
and that Codex's strict parse accepts an extra object-valued key. If it does
not, the fallback is a flat JSON string under the same prefix; B records which
was used.

### Excluding synthesized combo rows (round-4 B2)

The claim that `applyCatalogModelMetadata()` only ever sees real assertions is
FALSE as written, and audit round 4 proved it. The combo synthesis path builds a
`CatalogModel` out of last-resort defaults and feeds it through the same
function:

- `src/codex/catalog/provider-fetch.ts:697` — a synthetic `128000` context is the
  documented final fallback for combo member synthesis.
- `src/codex/catalog/provider-fetch.ts:793` — that fallback plus a synthesized
  `["text"]` modality is applied.
- `src/codex/catalog/aggregation.ts:164` — the result becomes an ordinary
  `CatalogModel` with `provider: COMBO_NAMESPACE`.

Reviewer reproduction:

    MEMBER={"id":"unknown","provider":"demo",...,"inputModalities":["text"],"contextWindow":128000}
    DERIVED={"provider":"combo","id":"synthetic",...,"contextWindow":128000,"inputModalities":["text"]}

Stamping that as provenance would reintroduce exactly the B2 defect the whole
redesign exists to avoid — a synthesized `128000` and a synthesized `["text"]`
presented to routing as asserted fact.

**Amendment.** Do not stamp synthesized combo rows. The function already tests
this namespace on its first line (`src/codex/catalog/effort.ts:117`), so the
guard is a one-line reuse of an existing check:

    // Virtual combo rows are synthesized from last-resort defaults
    // (provider-fetch.ts:697/793 -> aggregation.ts:164), so their context and
    // modality values are placeholders, not provider assertions. Stamping them
    // would recreate the exact false-evidence defect this block exists to
    // prevent. Combos are not ordinary routing candidates, so skipping them
    // costs nothing.
    if (model.provider !== COMBO_NAMESPACE) {
      const provenance: Record<string, unknown> = { provider: model.provider, model_id: model.id };
      ...
      entry.opencodex_capability_provenance = provenance;
    }

**Required regression (writer-through-normalizer).** The consumer-only tests
proposed earlier cannot catch this, because they hand-write catalog rows. B adds
a test that drives the real combo synthesis path end to end and asserts the
emitted entry carries NO `opencodex_capability_provenance`:

    test("synthesized combo rows are not stamped with capability provenance", () => {
      // Drives provider-fetch synthesis -> aggregation -> applyCatalogModelMetadata,
      // rather than hand-writing a row, so the writer itself is under test.
      const entry = buildComboCatalogEntry(/* member with no asserted context/modalities */);
      expect(entry.opencodex_capability_provenance).toBeUndefined();
      expect(entry.context_window).toBe(128000); // the synthesized default still ships to Codex
    });

The second assertion matters: the synthesized value must keep reaching Codex's
catalog (it is what makes the row parse), while staying invisible to routing.
That split is the whole point of a separate provenance channel.

**Residual, stated honestly.** This guard covers the one synthesized producer
found by audit. Any future path that manufactures a `CatalogModel` from defaults
would need the same treatment; the regression test is an early warning for that
class, not a proof that no other producer exists.

### Capturing jawcode generated metadata too (round-7 B1)

`applyCatalogModelMetadata()` is NOT the only writer of real capability values,
and a stamp built from `model.*` alone silently drops a whole class of correct
evidence. Audit round 7 found the second writer:

    // src/codex/catalog/sync.ts:321-322 — order matters
    if (model) applyCatalogMetadata(e, model.provider, model.id, model.contextCap);
    applyCatalogModelMetadata(e, model);

`applyCatalogMetadata()` (`src/codex/catalog/parsing.ts:458`) looks the model up
in the generated jawcode metadata and writes `context_window` /
`input_modalities` from it. Those values are REAL assertions — they come from a
curated metadata table, not from `ensureStrictCatalogFields`. But they never
touch the `CatalogModel`, so a stamp reading only `model.*` cannot see them.

Reviewer reproduction — a live-discovered row carrying identity only, whose
serialized entry nonetheless has full metadata:

    catalogModel: { "provider": "opencode-go", "id": "grok-4.6" }
    serialized:   { "context_window": 500000, "input_modalities": ["text","image"] }

Under the previous design the provenance block would carry identity and nothing
else, and routing would still lose valid evidence — defeating the phase goal for
exactly the providers that rely on generated metadata.

**Amendment.** Stamp provenance AFTER both writers have run, and source each
field from the model when it asserted one, otherwise from the metadata lookup.
Never from the entry itself: reading `entry.context_window` back would
reintroduce the B2 defect the moment `ensureStrictCatalogFields` has run.

    // Both real-assertion writers must have run before this point:
    //   applyCatalogMetadata()      — jawcode generated metadata (parsing.ts:458)
    //   applyCatalogModelMetadata() — the CatalogModel's own fields
    // Read from those two SOURCES, never from `entry`: the entry also carries
    // ensureStrictCatalogFields' compatibility defaults, which are not evidence.
    const meta = lookupGeneratedMetadata(model.provider, model.id);   // same lookup parsing.ts:458 uses
    const assertedContext = (typeof model.contextWindow === "number" && model.contextWindow > 0)
      ? model.contextWindow
      : (typeof meta?.contextWindow === "number" && meta.contextWindow > 0 ? meta.contextWindow : undefined);
    const assertedModalities = (Array.isArray(model.inputModalities) && model.inputModalities.length > 0)
      ? model.inputModalities
      : (Array.isArray(meta?.input) && meta.input.length > 0 ? meta.input : undefined);

Precedence matches the existing write order: the `CatalogModel` wins where it
asserts, generated metadata fills the rest.

The lookup currently lives inside `applyCatalogMetadata` and is not exported
(`src/codex/catalog/parsing.ts:458-463`); `effort.ts` imports only `readCatalog`
and types from that module (`src/codex/catalog/effort.ts:34-35`). So "extract,
not duplicate" is a real edit to `parsing.ts`, not a free choice: export the
resolve-and-fetch step as a named helper and have both callers use it. That is
why `parsing.ts` is in the file map and the scope boundary above.

Context-cap note: `applyCatalogMetadata` passes the metadata context through
`applyProviderContextCap(meta.contextWindow, contextCap)`. Provenance must apply
the same cap, or routing would advertise a window the cap already refused. B
confirms the cap argument reaching this point.

**Required regression (writer-to-reader).** The consumer-only fixtures cannot
catch this either:

    test("provenance captures jawcode generated metadata for an identity-only model", () => {
      // The CatalogModel carries provider/id ONLY; context and modalities come
      // from the generated metadata table via applyCatalogMetadata.
      const entry = buildRoutedEntry({ provider: "opencode-go", id: "grok-4.6" });
      expect(entry.context_window).toBe(500000);
      expect(entry.opencodex_capability_provenance.context_window).toBe(500000);
      expect(entry.opencodex_capability_provenance.input_modalities).toEqual(["text", "image"]);
    });

    test("provenance carries the CAPPED metadata context, not the raw table value", () => {
      // applyCatalogMetadata pipes generated context through applyProviderContextCap
      // (parsing.ts:464-466). An implementation that stamps the uncapped table value
      // would still pass the test above while advertising a window the cap refused.
      const entry = buildRoutedEntry({ provider: "opencode-go", id: "grok-4.6", contextCap: 350000 });
      expect(entry.context_window).toBe(350000);
      expect(entry.opencodex_capability_provenance.context_window).toBe(350000);
      // And the same value must survive all the way to routing evidence.
      expect(candidateCapabilityEvidence(config, "opencode-go", "grok-4.6").contextWindow).toBe(350000);
    });

    test("a model with no assertion anywhere stamps identity only", () => {
      // Neither the CatalogModel nor generated metadata asserts anything, so the
      // strict default still ships to Codex while provenance stays silent.
      const entry = buildRoutedEntry({ provider: "demo", id: "unknown-model" });
      expect(entry.context_window).toBe(128000);
      expect(entry.opencodex_capability_provenance.context_window).toBeUndefined();
    });

**Why six rounds missed it.** Rounds 4-6 audited *producers* — code paths that
manufacture a `CatalogModel` — and correctly found two synthesizers. This defect
is the mirror image: a writer that supplies real values without going through a
`CatalogModel` at all. Auditing one direction thoroughly is not the same as
auditing the other.

### Restoring the tri-state in the Antigravity producer (round-5 B2)

The combo guard above is necessary but NOT sufficient. Audit round 5 found a
second synthesizer that carries a real provider name, so it walks straight past
a `COMBO_NAMESPACE` check:

    // src/providers/antigravity-models.ts:334
    inputModalities: info.supportsImages === true ? ["text", "image"] : ["text"],

That ternary collapses two different facts into one value. `supportsImages:
false` (the provider said no) and `supportsImages` absent (nobody said anything)
both become `["text"]`. `src/codex/catalog/provider-fetch.ts:1338` then turns the
row into an ordinary `CatalogModel` with `provider: name`, and
`src/routing/capability.ts:163` reads `["text"]` as `image: false`.

Reviewer reproduction, with no `supportsImages` assertion present:

    [ { "id": "future-agent-model", "contextWindow": 333333,
        "inputModalities": ["text"] } ]

Such rows are not hypothetical: `tests/google-antigravity-wire.test.ts:131`
already constructs models without the field.

**Amendment.** Preserve the tri-state at the producer, which is the only place
the distinction still exists:

    // Tri-state, deliberately not a ternary: `true` is an assertion of image
    // support, `false` is an assertion against it, and ABSENT is unknown.
    // Collapsing absent into ["text"] would let routing read it as a confident
    // image:false (src/routing/capability.ts:163). The strict catalog still
    // receives its ["text"] compatibility default downstream via
    // ensureStrictCatalogFields; only the routing-evidence channel stays honest.
    ...(info.supportsImages === true
      ? { inputModalities: ["text", "image"] }
      : info.supportsImages === false
        ? { inputModalities: ["text"] }
        : {}),

**Required regression (writer-through-normalizer).** Same class as the combo
test, and equally uncatchable by consumer-only fixtures:

    test("an Antigravity model with no supportsImages leaves modality unknown", () => {
      const rows = parseAntigravityAvailableModels(/* wire payload without supportsImages */);
      expect(rows[0].inputModalities).toBeUndefined();
      // The strict catalog still gets its compatibility default...
      const entry = buildCatalogEntry(rows[0]);
      expect(entry.input_modalities).toEqual(["text"]);
      // ...but provenance carries no modality claim, so routing stays unknown.
      expect(entry.opencodex_capability_provenance.input_modalities).toBeUndefined();
    });

    test("an explicit supportsImages:false still asserts text-only", () => {
      const rows = parseAntigravityAvailableModels(/* payload with supportsImages: false */);
      expect(rows[0].inputModalities).toEqual(["text"]);
    });

The second test is what keeps this a tri-state restoration rather than a
silent weakening: a provider that genuinely says "no images" must keep saying it.

**Scope addition.** `src/providers/antigravity-models.ts` joins Phase 1's file
change map for this reason.

**Residual, restated.** Audit found two synthesizers (combo, Antigravity). The
guard plus the tri-state cover both. Any future producer that manufactures a
`CatalogModel` field from a default would need the same treatment; the two
writer-through-normalizer tests are the early warning for that class, not proof
that no third producer exists. B greps for other `inputModalities:` and
`contextWindow:` literal assignments in producer paths before closing.

## MODIFY 2 — src/routing/capability.ts

### 2a. Row type

Before:

    type CatalogModelRow = {
      provider: string;
      id: string;
      contextWindow?: number;
      inputModalities?: string[];
      reasoningEfforts?: string[];
      capabilities?: string[];
    };

After:

    type CatalogModelRow = {
      /** Exact provider/native-id identity, from the provenance block. */
      provider: string;
      id: string;
      /** Only values a CatalogModel asserted; never a strict-parser default. */
      contextWindow?: number;
      inputModalities?: string[];
      capabilities?: string[];
    };

`reasoningEfforts` is dropped: the catalog writes `supported_reasoning_levels`
as `{effort, description}` objects and this unit adds no mapping. Its absence
is today's behavior, so nothing regresses.

### 2b. Projection — read the provenance block

Before (the filter that discards all 17 rows):

    const rows = models
      .filter((model): model is Record<string, unknown> & { id: string; provider: string } =>
        typeof model === "object" && model !== null && typeof model.id === "string" && typeof model.provider === "string")
      .map(model => ({
        provider: model.provider,
        id: model.id,
        ...

After:

    const rows = models.flatMap(model => {
      if (typeof model !== "object" || model === null) return [];
      const provenance = (model as Record<string, unknown>).opencodex_capability_provenance;
      if (typeof provenance !== "object" || provenance === null) return [];
      const p = provenance as Record<string, unknown>;
      if (typeof p.provider !== "string" || typeof p.model_id !== "string") return [];
      return [{
        provider: p.provider,
        id: p.model_id,
        ...(typeof p.context_window === "number" && p.context_window > 0
          ? { contextWindow: p.context_window }
          : {}),
        ...(Array.isArray(p.input_modalities)
          ? { inputModalities: p.input_modalities.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(p.capabilities)
          ? { capabilities: p.capabilities.filter((value): value is string => typeof value === "string") }
          : {}),
      }];
    });

A row without provenance contributes nothing — exactly today's behavior for
every row — so this can only add evidence, never remove it.

### 2c. Lookup — unchanged

    const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);

The provenance block stores the exact native provider/model_id, so the existing
equality lookup is already correct. No slug decoding, no new import, and the B4
collision risk disappears rather than being mitigated.

### 2d. Keep the adapter tool fallback unconditional (B1)

Before:

    const tools = capabilities.includes("tools")
      || isNative
      || (catalogRow === undefined && provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
      || provider?.parallelToolCalls === true
      || undefined;

After:

    const tools = capabilities.includes("tools")
      || isNative
      // The adapter protocol is positive evidence on its own. This was gated on
      // `catalogRow === undefined`, which was safe only while the catalog lookup
      // never matched: once it matches, a row that simply does not enumerate
      // "tools" would silently revoke tool support for every openai-chat and
      // anthropic candidate.
      || (provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
      || provider?.parallelToolCalls === true
      || undefined;

A strict widening of a positive signal. `capabilities` stays positive-only, so
nothing can turn `tools` false.

### Import-boundary check

No new import is added, so the import graph is unchanged.
`tests/core-lab-boundary.test.ts` (13 pass pre-change) must still be re-run.

## NEW tests/routing-capability-catalog.test.ts

Writes a temporary catalog file and points the catalog path at it. B confirms
the path-override mechanism used by existing catalog tests before writing, and
amends this doc if it differs.

    test("carries asserted context window and image modality from a catalog-only model", () => {
      // Provider config declares NO modelContextWindows / modelInputModalities,
      // so the provenance block is the only possible evidence source.
      const evidence = candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4");
      expect(evidence.contextWindow).toBe(262144);
      expect(evidence.image).toBe(true);
    });

    test("a synthesized strict-parser default stays unknown (B2)", () => {
      // Row written with context_window 128000 and input_modalities ["text"]
      // by ensureStrictCatalogFields, but no provenance for either field.
      const evidence = candidateCapabilityEvidence(config, "demo", "unknown-model");
      expect(evidence.contextWindow).toBeUndefined();
      expect(evidence.image).toBeUndefined();   // never false
    });

    test("matching a catalog row does not revoke adapter tool support (B1)", () => {
      const evidence = candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4");
      expect(evidence.tools).toBe(true);
    });

    test("exact identity is not confused by slug collision (B4)", () => {
      // Native ids "a/b" and "a-b" both encode to the slug "p/a-b".
      expect(candidateCapabilityEvidence(config, "p", "a/b").contextWindow).toBe(111000);
      expect(candidateCapabilityEvidence(config, "p", "a-b").contextWindow).toBe(222000);
    });

## Accept criteria

1. Test 1 FAILS on the current tree and PASSES after the change; both runs
   recorded (C-ACTIVATION-GROUNDING-01).
2. Test 2 asserts undefined, never false — the B2 contract.
3. Test 3 passes before AND after: it proves the fix does not introduce the
   regression the audit predicted.
4. `bun x tsc --noEmit` clean.
5. `tests/core-lab-boundary.test.ts` green.
6. Remote exact-head suite green on lidge (command in the section below).

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `bun run test tests/routing-capability-catalog.test.ts` | YES — the file under test is the direct argument | Bare `bun test` bypasses the wrapper and fails test-home-guard (B6) |
| `bun x tsc --noEmit` | YES — tsconfig include covers `src/**` | Verified exit 0 pre-change |
| `bun run test tests/core-lab-boundary.test.ts` | YES — walks the import graph from `src/router.ts` into `src/routing/capability.ts` | Verified 13 pass pre-change |
| Remote exact-head suite (command below) | YES — shared routing surface | Required: shared surface |

## Field chain (PLAN-FIELD-CHAIN-01)

| Stage | Path | State after this phase |
|-------|------|------------------------|
| creation | `src/cli/models.ts` (`ocx models add`) / provider discovery | unchanged |
| serialization | `applyCatalogModelMetadata`, src/codex/catalog/effort.ts:113 | NEW provenance key |
| deserialization | `cachedCatalogModels`, src/routing/capability.ts:45 | reads provenance only |
| consumers | `candidateCapabilityEvidence` -> `src/routing/evaluator.ts` | receives real evidence; unknown stays unknown |

No other consumer reads `CatalogModelRow`: it is a module-local type
(src/routing/capability.ts:28) with no export.

## Bypass record (PLAN-BYPASS-NAMED-01)

No enforcement added; this repairs a data path. Tier: N/A. Executing surface:
none. Known bypass: a CatalogModel carrying no context/modality still yields
unknown evidence — by design. Residual risk: provenance is written by exactly
one function, so a future writer bypassing `applyCatalogModelMetadata` would
produce rows routing cannot read. The new tests are the early warning, not
enforcement. Final enforcement layer: none.

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
