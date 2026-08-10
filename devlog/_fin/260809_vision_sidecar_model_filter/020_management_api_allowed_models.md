# 020 — phase 2: management API exposes the allowed list and refuses the rest

Layer 2 of the stack. Branch `codex/260809-vision-sidecar-api`, base
`codex/260809-vision-eligibility-core`.

Thesis: **the server publishes which models it recommends, and refuses to persist
one it can prove is blind.** Without this layer the GUI filter is cosmetic —
anything with the admin token could write a blind model into
`visionSidecar.model`.

Two sets, never conflated (audit round 1, blockers 1-2):

| | Question | Source | Effect of `undefined` |
|---|---|---|---|
| suggestion list | what should the picker offer? | `visionEligibleModelOptions` | excluded (list stays tidy) |
| write gate | can we prove this is blind? | `modelAcceptsImageInput(...) === false` | **allowed** (never rejected) |

Rejecting on "absent from the list" would break
`tests/vision-reasoning-contract.test.ts:148-151`, which requires
`{ model: "custom-vision" }` to save with HTTP 200 against `providers: {}`.

## Files

| Path | Action |
|---|---|
| `src/server/management/config-routes.ts` | MODIFY (GET + PUT `/api/sidecar-settings`) |
| `src/server/management/agent-settings-routes.ts` | MODIFY (Claude Code vision override write) |
| `docs-site/src/content/docs/guides/sidecars.md` | MODIFY (SOT-SYNC-01: document the gate) |
| `tests/sidecar-settings-vision-filter.test.ts` | NEW |

`model-rows.ts` is **not** modified: `listManagementModelRows` already returns
`provider`, `id`, `native`, and (where known) `inputModalities`, which is exactly
`VisionCandidateModel`. Reusing it keeps the picker and the Models tab sourced
from one list.

## Imports to add (`config-routes.ts`, alongside the existing line 56 import)

```ts
 import { normalizeVisionReasoningForModel } from "../../vision/reasoning";
+import { findAnthropicVisionProvider } from "../../vision";
+import { modelAcceptsImageInput, visionEligibleModelOptions, type VisionSidecarBackend } from "../../vision/eligibility";
+import { listOpenAiForwardSidecarCandidates } from "../../providers/openai-sidecar";
+import { listManagementModelRows } from "./model-rows";
```

`listManagementModelRows` is async and hits `gatherRoutedModels`, which can be
slow or cooling down after a fetch failure. Both new call sites therefore wrap it
and degrade to `[]` on throw — a catalog outage must not 500 the settings route
nor reject a write. With `[]` the option list is exactly the baselines, which is
the intended floor.

## Helper, added near the top of the module

```ts
/** Backends whose executor could actually run: openai forward, anthropic OAuth. */
function enabledVisionBackends(config: OcxConfig): VisionSidecarBackend[] {
  const backends: VisionSidecarBackend[] = [];
  // The OpenAI describer needs a CANONICAL ChatGPT forward provider, not merely a
  // provider keyed "openai" — same predicate the runtime sidecar resolver uses.
  if (listOpenAiForwardSidecarCandidates(config).length > 0) backends.push("openai");
  if (findAnthropicVisionProvider(config)) backends.push("anthropic");
  // Neither side resolvable (fresh install, no login): fall back to both so the
  // picker is populated rather than empty, matching the permissive-unknown rule.
  return backends.length > 0 ? backends : ["openai", "anthropic"];
}

async function visionModelOptionsFor(config: OcxConfig) {
  let rows: Awaited<ReturnType<typeof listManagementModelRows>> = [];
  try { rows = await listManagementModelRows(config); } catch { rows = []; }
  return visionEligibleModelOptions(
    config,
    rows.filter(row => row.disabled !== true).map(row => ({
      provider: row.provider,
      id: row.id,
      ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
      ...(row.native ? { native: true } : {}),
    })),
    enabledVisionBackends(config),
  );
}
```

## GET `/api/sidecar-settings` (current body at lines 380-393)

```ts
   if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
     const ws = config.webSearchSidecar ?? {};
     const vs = config.visionSidecar ?? {};
     const visionModel = vs.model || "gpt-5.4-mini";
     const visionReasoning = normalizeVisionReasoningForModel(visionModel, vs.reasoning) ?? "low";
+    const visionModels = await visionModelOptionsFor(config);
+    // A model the operator already configured stays selectable even if it is no
+    // longer eligible; dropping it would silently re-point their sidecar.
+    if (!visionModels.some(option => option.value === visionModel)) {
+      visionModels.unshift({ value: visionModel, label: visionModel, backend: vs.backend ?? "openai" });
+    }
     return jsonResponse({
       webSearch: { model: ws.model ?? "gpt-5.6-luna", backend: ws.backend },
       vision: {
         model: visionModel,
         backend: vs.backend,
         reasoning: visionReasoning,
         maxDescriptionsPerTurn: vs.maxDescriptionsPerTurn,
       },
+      visionModels,
     });
   }
```

The same `visionModels` block is appended to the PUT response body (the second
serialization site, currently at lines 470-483), so an optimistic GUI update and a
refetch cannot disagree about the option list.

## PUT validation

Inserted after the existing `vision.reasoning` enum check (lines 422-423), before
the normalization block and well before `saveConfigPreservingClaudeCode(config)`
at line 469, so a rejected write mutates nothing:

```ts
+    // Reject ONLY a model we can prove is blind. An id nothing knows about stays
+    // allowed: the operator may be ahead of our catalog, and the runtime never
+    // required catalog membership (`tests/vision-reasoning-contract.test.ts`
+    // pins `custom-vision` → 200).
+    if (body.vision && typeof body.vision.model === "string" && body.vision.model !== "") {
+      const requested = body.vision.model;
+      const row = (await visionCandidateRows(config)).find(candidate => candidate.id === requested);
+      const accepts = modelAcceptsImageInput(config, row ?? { provider: body.vision.backend === "anthropic" ? "anthropic" : "openai", id: requested });
+      if (accepts === false) {
+        return jsonResponse({
+          error: `vision.model "${requested}" cannot describe images: it has no image input support, or it is a model the vision sidecar describes FOR.`,
+          allowed: (await visionModelOptionsFor(config)).map(option => option.value),
+        }, 400);
+      }
+    }
```

Empty string keeps its existing meaning — clear the override, fall back to
`gpt-5.4-mini` — so it bypasses the check by design.

`visionCandidateRows(config)` is the shared row loader the gate and the list both
read, so they can never disagree about what exists (audit round 2, N3):

```ts
async function visionCandidateRows(config: OcxConfig): Promise<VisionCandidateModel[]> {
  let rows: Awaited<ReturnType<typeof listManagementModelRows>> = [];
  // A catalog outage must not 500 the settings route nor reject a write; with []
  // the option list degrades to the baselines, which is the intended floor.
  try { rows = await listManagementModelRows(config); } catch { rows = []; }
  return rows.filter(row => row.disabled !== true).map(row => ({
    provider: row.provider,
    id: row.id,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.native ? { native: true } : {}),
  }));
}

async function visionModelOptionsFor(config: OcxConfig) {
  return visionEligibleModelOptions(config, await visionCandidateRows(config), enabledVisionBackends(config));
}
```

(The `visionModelOptionsFor` body shown earlier is superseded by this pair.)

### What the synthesized fallback candidate can and cannot reject

When the requested id matches no row, the gate synthesizes
`{ provider: <anthropic if that backend was named, else openai>, id }`. Measured
against `src/generated/model-metadata.ts`, that can only ever reject three ids —
`codex-mini-latest`, `gpt-4`, `o3-mini` (the openai table's only text-only rows;
the anthropic table has none). All three genuinely cannot see, so the rejection is
correct rather than overreach. Every other unmatched id resolves to `undefined`
and is allowed.

## The second write path: Claude Code's vision override

`PUT /api/claude-code` sets `claudeCode.visionSidecar.model` and today only
type-checks it (`src/server/management/agent-settings-routes.ts:1002-1014`). A gate
on one route and not the other is decorative, so the same
`accepts === false` rejection is applied there for the `visionSidecar` field of
that loop. `webSearchSidecar` is untouched — it has no vision requirement.

The Claude Code **GUI** stays freeform: it is an `<input>` + `<datalist>`
(`gui/src/pages/claude-code-sections.tsx:154-205`), not a constrained picker, and
narrowing it is out of scope per `000_plan.md`.

## Wire-shape note

`visionModels` is a top-level sibling of `vision`, not a member of it, because
`SidecarSetting` is shared with `webSearch` and shipping a vision-only array
inside it would give the web-search half a field it can never populate.

## NEW `tests/sidecar-settings-vision-filter.test.ts`

Driven through `handleManagementAPI` with an in-memory `OcxConfig`, exactly as
`tests/vision-reasoning-contract.test.ts:12-31` does (`getVision`/`putVision`
helpers plus `ManagementRequest` from `tests/helpers/management-auth`). That is the
real seam — the sidecar PUT calls the bare `saveConfigPreservingClaudeCode` import
at line 469, so it does **not** use `model-routes.ts`'s `deps` injection. Where a
"did not persist" assertion is needed, assert on the in-memory config object
(which the handler mutates in place) and, if a stronger claim is wanted, use
`spyOn(configModule, "saveConfigPreservingClaudeCode")` as
`tests/codex-account-delete-atomicity.test.ts:71-73` does.

1. **GET returns the allowed list** containing `gpt-5.6-luna`.
2. **GET keeps a configured-but-ineligible model selectable** — set
   `visionSidecar.model` to a text-only id, assert it is present in
   `visionModels` and still returned as `vision.model`.

   This grandfather is **display-only, and asymmetric on purpose** (audit round 2,
   N2): the operator can see what is configured and can change the effort
   (`visionReasoningPatch` sends `{ vision: { reasoning } }` only,
   `gui/src/pages/dashboard-shared.ts:157-159`, so it never trips the model gate),
   but re-submitting that same proven-blind id is rejected. Hiding it instead
   would leave the picker showing some *other* model while the config still names
   this one, which is the worse lie. Case 3 below pins the rejection; this case
   pins the visibility.
3. **PUT rejects an ineligible model with 400 (activation evidence)** — body
   `{ vision: { model: "<text-only id>" } }` asserts status 400, an `allowed`
   array in the body, and that `config.visionSidecar?.model` is **unchanged**. The
   unchanged assertion is the one that proves rejection happened before mutation
   rather than after.
4. **PUT accepts an eligible model** — `claude-haiku-4-5` asserts 200 and a
   persisted config.
5. **PUT with `model: ""` still clears** — asserts 200, proving the guard did not
   capture the clear path.
6. **catalog failure degrades to baselines** — stub the model source to throw and
   assert GET still returns 200 with the baseline entries.
7. **PUT keeps an UNKNOWN id (regression guard for blocker 1)** —
   `{ model: "custom-vision" }` against `providers: {}` asserts 200 and a persisted
   value, mirroring `tests/vision-reasoning-contract.test.ts:148-151`. Without this
   case the over-strict gate could be reintroduced silently.
8. **PUT /api/claude-code rejects a provably blind vision override** with 400,
   and accepts an unknown one.

## Acceptance

| Row | Verifier | Covered? |
|---|---|---|
| allowed list on the wire | `bun test tests/sidecar-settings-vision-filter.test.ts` | yes |
| 400 on ineligible write | same file, case 3 | yes |
| unknown id still accepted | same file, case 7 + `bun test tests/vision-reasoning-contract.test.ts` | yes |
| second write path gated | same file, case 8 | yes |
| no regression in existing sidecar routes | `bun run test` | yes |
| types | `bun run typecheck` | yes |
| GUI consumption | — | `N/A` until phase 3 |
