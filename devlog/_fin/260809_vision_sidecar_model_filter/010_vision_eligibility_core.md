# 010 — phase 1: vision eligibility core

Layer 1 of the stack. Branch `codex/260809-vision-eligibility-core`, base
`origin/dev`.

Thesis: **one predicate decides which models may describe an image, and it lives
next to the sidecar that uses it.**

## Files

| Path | Action |
|---|---|
| `src/vision/eligibility.ts` | NEW |
| `src/vision/index.ts` | MODIFY (re-export only) |
| `tests/vision-eligibility.test.ts` | NEW |

No GUI and no route changes in this layer — it must stand alone as "the predicate
plus its proof".

## NEW `src/vision/eligibility.ts`

```ts
/**
 * Which models may serve AS the vision sidecar (the describer), as opposed to the
 * models the sidecar describes FOR.
 *
 * Two rules make this non-obvious, and both are load-bearing:
 *
 * 1. `provider.noVisionModels` marks models the proxy describes images for, and
 *    `applyProviderConfigHints` deliberately ADDS "image" to their advertised
 *    input modalities so the Codex app does not block the attachment client-side.
 *    A blind model therefore advertises image input. Membership in that list is a
 *    hard disqualifier here, checked BEFORE the modality list it rewrote.
 * 2. Catalog rows frequently omit `inputModalities` entirely (the live
 *    `/api/models` response carries none for either openai or anthropic rows).
 *    Unknown is not zero: when no source can speak, the model stays eligible
 *    rather than silently vanishing from the picker.
 */
import { modelInList, type OcxConfig } from "../types";
import { getModelMetadataCaseInsensitive, resolveMetadataProvider } from "../generated/model-metadata";
import { nativeInputModalities } from "../codex/catalog/metadata";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";

/** The two wire protocols `planVisionSidecar` can actually dispatch to. */
export type VisionSidecarBackend = "openai" | "anthropic";

/** Guaranteed entry per backend: cheap, image-capable, and present in every deployment. */
export const BASELINE_VISION_MODELS: Record<VisionSidecarBackend, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
};

export interface VisionCandidateModel {
  provider: string;
  id: string;
  inputModalities?: string[];
  native?: boolean;
}

export interface VisionModelOption {
  value: string;
  label: string;
  backend: VisionSidecarBackend;
  /** True when the row is a guaranteed baseline rather than a catalog discovery. */
  baseline?: boolean;
}

function advertisesImageInput(modalities: readonly string[] | undefined): boolean | undefined {
  if (!modalities || modalities.length === 0) return undefined;
  return modalities.includes("image");
}

/** Vendor-table modalities for a routed row, or undefined when the table has no opinion. */
function metadataImageInput(provider: string, modelId: string): boolean | undefined {
  const resolved = resolveMetadataProvider(provider) ?? provider;
  const meta = getModelMetadataCaseInsensitive(resolved, modelId);
  return advertisesImageInput(meta?.input);
}

/**
 * Is this model listed as one the sidecar describes FOR? Such a model cannot be
 * the describer, and its advertised modalities are untrustworthy.
 */
export function isVisionSidecarConsumer(config: Pick<OcxConfig, "providers">, providerName: string, modelId: string): boolean {
  const provider = config.providers?.[providerName];
  return provider ? modelInList(provider.noVisionModels, modelId) : false;
}

/**
 * Can this model accept an image on the wire? Sources are consulted in descending
 * trustworthiness; the first that speaks wins. `undefined` means nothing knows,
 * which callers treat as eligible.
 */
export function modelAcceptsImageInput(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean | undefined {
  if (isVisionSidecarConsumer(config, candidate.provider, candidate.id)) return false;
  if (candidate.native || SUPPORTED_NATIVE_OPENAI_SLUGS.has(candidate.id)) {
    return advertisesImageInput(nativeInputModalities(candidate.id)) ?? true;
  }
  const fromRow = advertisesImageInput(candidate.inputModalities);
  if (fromRow !== undefined) return fromRow;
  return metadataImageInput(candidate.provider, candidate.id);
}

/** Eligible = not a sidecar consumer, and not positively known to be text-only. */
export function isVisionEligibleModel(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean {
  return modelAcceptsImageInput(config, candidate) !== false;
}

/** Which backend would describe through this row, or undefined when neither can. */
export function visionBackendForCandidate(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): VisionSidecarBackend | undefined {
  if (candidate.native || candidate.provider === "openai") return "openai";
  const adapter = config.providers?.[candidate.provider]?.adapter;
  if (adapter === "anthropic") return "anthropic";
  return undefined;
}

/**
 * The picker's option list: every eligible row reachable by one of the two
 * executors, plus each enabled side's baseline, de-duplicated and stably ordered
 * (openai side first, baselines first within a side).
 */
export function visionEligibleModelOptions(
  config: Pick<OcxConfig, "providers">,
  candidates: readonly VisionCandidateModel[],
  enabledBackends: readonly VisionSidecarBackend[],
): VisionModelOption[] {
  const enabled = new Set(enabledBackends);
  const byValue = new Map<string, VisionModelOption>();

  for (const backend of ["openai", "anthropic"] as const) {
    if (!enabled.has(backend)) continue;
    const id = BASELINE_VISION_MODELS[backend];
    byValue.set(id, { value: id, label: id, backend, baseline: true });
  }
  for (const candidate of candidates) {
    const backend = visionBackendForCandidate(config, candidate);
    if (!backend || !enabled.has(backend)) continue;
    if (!isVisionEligibleModel(config, candidate)) continue;
    if (byValue.has(candidate.id)) continue;
    byValue.set(candidate.id, { value: candidate.id, label: candidate.id, backend });
  }

  const order = (option: VisionModelOption) =>
    (option.backend === "openai" ? 0 : 2) + (option.baseline ? 0 : 1);
  return [...byValue.values()].sort((a, b) => order(a) - order(b) || a.value.localeCompare(b.value));
}
```

### The suggestion list and the write gate are different questions

`visionEligibleModelOptions` answers *"what should the picker suggest?"* and is
deliberately narrow: it emits only rows an executor can reach and some source has
heard of. `modelAcceptsImageInput` answers *"can we prove this model cannot
see?"* and is the ONLY input to phase 2's rejection.

Absence from the option list must never imply rejection (audit round 1,
blocker 1). An unknown id like `custom-vision` is absent from the list yet returns
`undefined` — not `false` — from the predicate, and
`tests/vision-reasoning-contract.test.ts:148-151` requires it to keep saving.
Never let a caller derive the gate from the list.

### Which backends are "enabled"

The caller supplies `enabledBackends`; this module does not read credentials.
That keeps the predicate pure and testable, and it keeps credential inspection in
`src/vision/index.ts`, which already owns `findAnthropicVisionProvider`. Phase 2
computes the set as:

- `"anthropic"` when `findAnthropicVisionProvider(config)` returns a provider;
- `"openai"` when `listOpenAiForwardSidecarCandidates(config).length > 0`.

**Not** "a non-disabled `openai` provider exists" (audit round 1, blocker 4). The
OpenAI describer posts to `${forwardProvider.baseUrl}/responses` with forwarded
ChatGPT headers, and `listOpenAiForwardSidecarCandidates`
(`src/providers/openai-sidecar.ts:55-70`) is the function that decides whether such
a provider exists: it additionally requires `isCanonicalOpenAiForwardProvider`
(`src/providers/openai-tiers.ts:32-36`) — adapter `openai-responses`, authMode
`forward` (an omitted authMode normalizes to forward), and the canonical base URL.
A mis-shaped `openai` row would otherwise light up the OpenAI side and offer a
baseline that cannot run, and it would be asymmetric with the Anthropic side,
which already checks a usable credential.

## MODIFY `src/vision/index.ts`

Add one re-export block after the two existing `export {...} from` lines
(currently lines 15-16), so importers have a single entry point:

```ts
 export { describeImage } from "./describe";
 export { describeImageAnthropic, parseAnthropicVisionSSE } from "./anthropic-describe";
+export {
+  BASELINE_VISION_MODELS,
+  isVisionEligibleModel,
+  isVisionSidecarConsumer,
+  modelAcceptsImageInput,
+  visionBackendForCandidate,
+  visionEligibleModelOptions,
+} from "./eligibility";
+export type { VisionCandidateModel, VisionModelOption, VisionSidecarBackend } from "./eligibility";
```

`planVisionSidecar` is **not** changed. An operator who hand-configures an exotic
model keeps working; the filter governs the picker and the API, not the runtime
dispatch (see the bypass table in `000_plan.md`).

## NEW `tests/vision-eligibility.test.ts`

Cases, each one an assertion the plan owes:

1. **text-only exclusion (activation evidence).** Candidate
   `{ provider: "openrouter", id: "openai/gpt-5.4-mini" }` — the generated table
   marks it `"text"` — asserts `isVisionEligibleModel` is `false`. Paired with
   `{ provider: "anthropic", id: "claude-haiku-4-5" }` asserting `true`, so the
   test proves discrimination, not blanket rejection.
2. **`noVisionModels` inversion.** Config with
   `providers["opencode-go"].noVisionModels = ["glm-5.2"]` and a candidate whose
   `inputModalities` is `["text","image"]` (exactly what
   `applyProviderConfigHints` produces) asserts `false`. This is the case a naive
   modality filter gets wrong.
3. **unknown stays eligible.** Two sub-cases, because "unknown" and "silent row"
   are different states:
   - `{ provider: "anthropic", id: "claude-opus-4-6" }` with no
     `inputModalities` asserts `true` — the row is silent but the generated
     table answers `["text","image"]` (verified). This is the live
     `/api/models` shape.
   - `{ provider: "anthropic", id: "claude-future-9" }`, absent from every
     table, asserts `true` via the `undefined → eligible` fallback, and
     `modelAcceptsImageInput` returns `undefined` for it. Assert the tri-state
     directly here, otherwise cases 3a and 3b are indistinguishable and the
     fallback branch is never actually driven.
4. **native slugs.** Each of the seven `NATIVE_OPENAI_MODELS` asserts `true`.
5. **baseline presence, openai side.** `visionEligibleModelOptions(config, [],
   ["openai"])` contains `gpt-5.6-luna` and no anthropic entry.
6. **baseline presence, anthropic side.** Same with `["anthropic"]` contains
   `claude-haiku-4-5` and no openai entry.
7. **baseline is not duplicated** when the catalog also lists it.
8. **backend routing.** A `cursor`-provider row returns `undefined` from
   `visionBackendForCandidate` and is therefore absent from the options even
   though it is image-capable — the "no third executor" rule made testable.

## Acceptance

| Row | Verifier | Covered? |
|---|---|---|
| predicate correctness | `bun test tests/vision-eligibility.test.ts` | yes |
| no type regressions | `bun run typecheck` | yes |
| no existing-suite breakage | `bun run test` | yes |
| GUI unaffected | — | `N/A`, this layer touches no `gui/` file |
