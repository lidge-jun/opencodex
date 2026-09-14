# Phase 1 — Reimplement on current dev, audit, publish

## Diff level

Branch codex/carry-4528-codex-forward-user off origin/dev 246b5cab43. The upstream diff
applies cleanly at that base (39 files, 613+/61-), which is itself the evidence that the
CI red was the version test alone and not a code conflict.

Source changes carried:

- src/adapters/openai-responses.ts — stripCanonicalForwardUser, called only inside the
  existing isCanonicalOpenAiForwardProvider gate, after the prompt-cache strips.
- src/combos/failover.ts — isRequestLocalTargetIncompatibility: HTTP 400 only, 16,384
  char bound, generic outer code required, strict JSON parse, error object required,
  inner code string-or-null and generic, leaf type invalid_request_error, only the exact
  "Provider error 400: " wrapper unwrapped with a depth budget of 3. Three accepted
  shapes. Wired into both comboFailureDecision (hop) and comboFailureCooldownScope.
- src/vision/plan.ts — requiresVisionPreprocessing replaces the isModelTextOnly call
  sites. Proven-negative capability preprocesses; unknown custom models stay sighted.
- src/vision/eligibility.ts — canonical Codex consults the generated openai-codex bundle
  before generic row metadata; shallow copy plus cloned vision maps so an injected fetch
  survives enrichment.
- scripts/generate-model-metadata.ts and src/generated/model-metadata.ts — openai-codex
  retained as a capability-only bundle.
- src/providers/registry.ts — OPENCODE_ZEN_IMAGE_MODELS records mimo-v2.5-free and
  longcat-2.0-free as positive modality evidence instead of blacklist absence.
- src/server/responses/core.ts, chat-native.ts, chat-completions.ts and
  src/web-search/index.ts — thread providerName through so one gate applies everywhere.

## Audit plan

Six parallel read-only recon agents: failover classifier bounds, the sanitation
boundary, vision capability routing and generated-file consistency, structure ownership,
docs-site locale fidelity, plus one adversarial counter-read of both security boundaries.

## Fold list beyond the upstream diff

Turkish combos.md wording (cikti baslamadan ONCE sonraki uygun hedefe); the stale
noVisionModels activation row in structure/ops/service-and-sidecars.md; the
transports/responses.md contract pointer and its whitespace churn; a Zen positive-modality
note in transports/inventory.md; the English cross-reference; the French before-output
timing; seven locale failover-table exception rows; and two comment blocks that wrongly
claimed unknown capability fails closed.

## Known limitation, documented not fixed

On the combo path the classifier never sees more than 500 characters: consumeComboFailure
passes normalized.safeText, which is redactSecretString(text).slice(0, 500) at
src/server/responses/core.ts:954. The classifier's own 16,384 bound is the outer belt.
An envelope fatter than 500 bytes truncates mid-JSON, fails the parse and does not hop.
That fails closed, and raising it would touch shared redaction and byte-accounting
contracts outside this carry's scope.

## Exit

Push --no-verify fast-forward only, open against dev with the full template, report the
PR number, head SHA and the CI run id whose head_sha equals the final head. Do not merge;
do not close #4528 or #4527.
