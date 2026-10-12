# JEV Auto Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one optional `jev-auto` model that asks TypeSafe JEV to choose the initial OpenCodex Combo target and reasoning effort, while preserving every existing model and all existing Combo fallback behavior.

**Architecture:** Extend Combo with a `jev` strategy. A small native TypeScript decision module builds the bounded JEV state and joint target/effort question, calls the fixed TypeSafe endpoint with the configured JEV credential, validates the answer, and returns either an eligible initial pick or a deterministic fail-open pick. The existing Combo dispatcher remains responsible for eligibility, cooldowns, quota state, concrete routing, retries, and subsequent fallback attempts. A registry-only JEV provider row owns key setup without publishing a routable model. The GUI adds JEV to the existing Combo editor and provides a prefilled `jev-auto` action whose target list remains fully editable.

**Tech Stack:** Bun, TypeScript, OpenCodex Combo runtime, provider registry/management API, React/Vite GUI, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-09-21-jev-auto-routing-design.md`

## Global Constraints

- Existing public model ids, aliases, picker rows, defaults, and direct routing must remain unchanged.
- `jev-auto` is opt-in and is never synthesized until the operator creates the JEV Combo.
- JEV chooses once per logical model call. Existing Combo logic alone owns later failover.
- Candidate models come only from the configured Combo target allowlist and must pass existing eligibility checks before they are offered to JEV.
- Missing credentials, timeout, redirect, non-2xx, malformed JSON, invalid choices, and empty usable candidate sets fail open to the first existing eligible Combo pick.
- Caller cancellation propagates; it must not be converted into fail-open dispatch.
- TypeSafe calls use `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, a four-second deadline, manual redirect handling, one attempt, and a bounded response body.
- JEV request state is bounded and excludes secrets, raw images, tool arguments, headers, encrypted reasoning, and full conversation history.
- Observability may contain only the selected target, effort, gate/reason, latency, confidence/probability, and numeric usage. It must never contain the JEV key or decision state.
- All TypeSafe coverage is mocked. A live smoke is explicitly deferred until the user supplies a key.
- New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- Visible GUI strings must be added to every locale in `gui/src/i18n/`.

## Review Focus

- A hostile JEV response cannot select a target or effort outside the eligible, configured choice map.
- A caller abort during the JEV call ends the request as cancellation and never dispatches the fail-open target.
- A JEV outage cannot suppress the request or alter existing direct-model routing.
- The selected effort is clamped/omitted through the existing target capability ladder and caller `service_tier` is removed for the JEV-selected initial child only; fallback children rebuild from the original request under ordinary Combo rules.
- The JEV provider row stores credentials but emits no direct model/catalog row and can never be selected as a Combo target.
- After a JEV-selected target fails retryably, existing cooldown and fallback ordering continue without a second JEV call.

---

## Task 1: Add the JEV Combo strategy and pure decision contract

**Files:**

- Create: `src/combos/jev.ts`
- Modify: `src/types/config.ts`
- Modify: `src/combos/types.ts`
- Modify: `src/combos/index.ts`
- Modify: `src/cli/combo.ts`
- Modify: `tests/codex-integration/combos.test.ts`
- Modify: `tests/cli/cli-headless-parity.test.ts`
- Create: `tests/routing/jev-decision.test.ts`
- Modify: `scripts/test-layout/layout.json`
- Modify: `tests/fixtures/test-layout-expected.json`

**Interfaces produced:**

```ts
export interface JevCandidate {
  key: string;
  provider: string;
  model: string;
  reasoningEfforts: readonly OcxComboDefaultEffort[];
}

export interface JevDecision {
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  gate: "apply" | "missing_key" | "no_choices" | "timeout" | "network" | "redirect" | "http" | "malformed" | "invalid";
  latencyMs: number;
  confidence?: number;
  chosenProbability?: number;
  usage?: Record<string, number>;
}

export function buildJevState(body: unknown): Record<string, unknown>;
export function buildJevRouteQuestion(candidates: readonly JevCandidate[]): Record<string, unknown>;
export function parseJevDecision(payload: unknown, candidates: readonly JevCandidate[]): Pick<JevDecision, "targetKey" | "effort" | "confidence" | "chosenProbability" | "usage">;
```

- [ ] Add focused failing Combo and CLI tests proving `strategy: "jev"` validates, normalizes, round-trips, falls back to configured order in the synchronous picker, and is accepted by `ocx combo set`. Run `bun test tests/codex-integration/combos.test.ts tests/cli/cli-headless-parity.test.ts`; expect assertions to fail because `jev` is rejected or normalized to `failover`.
- [ ] Extend `OcxComboStrategy`, validation text, normalization, Combo exports, and CLI `--strategy` parsing/help with `jev`. Re-run the focused test; expect it to pass.
- [ ] Add failing pure tests for bounded current-user extraction, envelope removal, recent assistant intent, last tool-output tail/name, image presence, literal choice-map construction, known Luna/Sol/Astra profiles, neutral arbitrary-target profiles, valid response parsing, complete probability validation, invalid/out-of-allowlist choices, malformed confidence, and numeric-only usage extraction. Run `bun test tests/routing/jev-decision.test.ts`; expect an import failure because `src/combos/jev.ts` does not exist.
- [ ] Implement only the pure state/question/parser pieces in `src/combos/jev.ts`. Keep state caps aligned with the reference router: 500-character head/tail current ask, 240-character assistant tail, and 520-character tool-output tail. Re-run the new tests; expect all to pass.
- [ ] Register the test file in both test-layout manifests, run `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, then run `bun run typecheck`. Expect exit code 0.
- [ ] Stage the Task 1 files and commit with `git commit -m "feat: add JEV combo decision contract"`.

## Task 2: Add registry-backed JEV credential setup and the secure TypeSafe client

**Files:**

- Modify: `src/providers/registry/entries-extended.ts`
- Modify: `src/providers/derive.ts` only if the empty-model decision-service row needs a narrow projection adjustment
- Modify: `src/combos/jev.ts`
- Modify: `src/server/management/provider-routes.ts`
- Create: `tests/providers/jev-provider.test.ts`
- Modify: `tests/server/management-provider-validation.test.ts`
- Modify: `tests/providers/provider-registry-parity.test.ts`
- Modify: `scripts/test-layout/layout.json`
- Modify: `tests/fixtures/test-layout-expected.json`

**Interfaces produced:**

```ts
export const JEV_PROVIDER_ID = "jev";
export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export interface ResolveJevDecisionOptions {
  body: unknown;
  candidates: readonly JevCandidate[];
  fallback: { targetKey: string; effort: OcxComboDefaultEffort | null };
  config: OcxConfig;
  signal?: AbortSignal;
  post?: typeof providerOutboundPost;
  now?: () => number;
}

export function resolveJevDecision(options: ResolveJevDecisionOptions): Promise<JevDecision>;
```

- [ ] Add a failing provider test proving the registry exposes a paid key-auth `jev` preset with the fixed endpoint, no models/default model, and `liveModels: false`; prove `fetchProviderModelsWithAuth` emits no JEV catalog row. Run `bun test tests/providers/jev-provider.test.ts`; expect no preset.
- [ ] Add the `jev` registry entry (`adapter: "jev-decision"`, `preserveCustomDestination: true`, TypeSafe dashboard/docs URL, no model roster) and make only the minimum projection adjustment required. Re-run the provider test; expect it to pass.
- [ ] Add failing client tests using an injected POST boundary. Cover configured key, `${TYPESAFE_API_KEY}`/environment fallback, exact endpoint/model/auth headers/body, four-second timeout, manual redirect refusal, non-2xx, oversized body, invalid JSON, invalid decision, and caller cancellation. Assert returned decisions rather than mock call counts except where endpoint/auth/body are the contract. Run `bun test tests/routing/jev-decision.test.ts`; expect client cases to fail because `resolveJevDecision` is absent.
- [ ] Implement the secure client with `resolveProviderApiKey`, environment fallback, `providerOutboundPost`, `providerRedirectError`, `readBoundedResponseBytes`, `AbortSignal.timeout(4000)`, and one request only. Re-run the client tests; expect all to pass.
- [ ] Add a failing management test for `POST /api/providers/test?name=jev`: missing key returns a sanitized failure; a mocked valid one-choice JEV answer returns connected; upstream body text is never echoed. Run `bun test tests/server/management-provider-validation.test.ts`; expect the static-catalog not-applicable result.
- [ ] Add the narrow JEV connection-probe branch before the generic static-catalog branch and reuse the same bounded client. Re-run the management test, provider test, layout tests, and `bun run typecheck`; expect exit code 0.
- [ ] Stage the Task 2 files and commit with `git commit -m "feat: add TypeSafe JEV provider setup"`.

## Task 3: Route Combo first picks through JEV without replacing fallback

**Files:**

- Modify: `src/combos/jev.ts`
- Modify: `src/server/responses/core-combo.ts`
- Modify: `src/server/responses/core-options.ts`
- Create: `tests/server/server-jev-combo-e2e.test.ts`
- Modify: `scripts/test-layout/layout.json`
- Modify: `tests/fixtures/test-layout-expected.json`

**Interfaces consumed:** Task 1's strict choice map/parser and Task 2's `resolveJevDecision` client.

- [ ] Add a failing server test that configures an aliased `jev-auto` Combo, injects a successful JEV answer selecting the second target at `high`, and proves only that target receives the request, with forced/clamped `reasoning.effort` and no caller `service_tier`. Assert the served catalog has one public `jev-auto` row and still contains unchanged direct-model rows. Run `bun test tests/server/server-jev-combo-e2e.test.ts`; expect the first configured target to receive the request.
- [ ] Add a small helper that enumerates currently eligible `jev` targets in configured order without marking them all attempted, asks JEV once, and rebuilds the selected `ComboPick` with only the chosen target in `attempted`. Integrate it immediately after the existing initial `pickWithWait`; keep the loop and `advanceComboAfterFailure` unchanged. Re-run the focused test; expect it to pass.
- [ ] Add failing cases for: missing key fail-open to first eligible at medium; invalid JEV choice fail-open; selected target retryable failure then existing fallback with no second JEV call and with the original caller effort/tier restored; cooled/disabled targets omitted from choices; explicit empty target effort ladder omitted/stripped; caller abort during JEV returns 499 and sends no model request. Run the focused test and inspect each expected failure.
- [ ] Implement the minimum runtime behavior for those cases. Apply the JEV effort and remove `service_tier` only on the selected initial child. If that child fails, rebuild every fallback from the untouched original request with the Combo's ordinary effort/tier behavior. Emit one sanitized structured debug event for the decision. Re-run the focused test plus `bun test tests/routing/combo-management-api.test.ts tests/codex-integration/combos.test.ts`; expect all to pass.
- [ ] Register the new test file, run layout tests and `bun run typecheck`; expect exit code 0.
- [ ] Stage the Task 3 files and commit with `git commit -m "feat: route jev-auto through combo runtime"`.

## Task 4: Add the editable JEV Auto GUI flow

**Files:**

- Modify: `gui/src/combo-workspace-data.ts`
- Modify: `gui/src/components/combo-workspace-controls.tsx`
- Modify: `gui/src/components/combo-workspace-add-modal.tsx`
- Modify: `gui/src/components/ComboWorkspace.tsx`
- Modify: `gui/src/components/combo-workspace-types.ts`
- Modify: `gui/src/pages/Combos.tsx` only if the prefilled-add state belongs at the page boundary
- Modify: `gui/src/components/provider-workspace/ProviderOverview.tsx`
- Modify: `gui/src/components/provider-workspace/ProviderDetails.tsx`
- Modify: `gui/src/pages/Providers.tsx`
- Modify: `gui/src/hash-routing.ts`
- Modify: `gui/src/pages/models-tab.ts`
- Modify: `gui/src/i18n/en.ts`
- Modify: `gui/src/i18n/de.ts`
- Modify: `gui/src/i18n/fr.ts`
- Modify: `gui/src/i18n/ja.ts`
- Modify: `gui/src/i18n/ko.ts`
- Modify: `gui/src/i18n/ru.ts`
- Modify: `gui/src/i18n/tr.ts`
- Modify: `gui/src/i18n/vi.ts`
- Modify: `gui/src/i18n/zh.ts`
- Modify: `gui/src/i18n/zh-TW.ts`
- Modify: `tests/gui/combo-workspace-data.test.ts`
- Create: `gui/tests/jev-auto-combo.test.tsx`

**Interfaces produced:**

```ts
export function jevAutoDraft(models: readonly ModelOption[]): ComboItem;
```

- [ ] Add failing pure GUI tests proving `jev` parses/serializes without drift and `jevAutoDraft` creates id/alias `jev-auto`, strategy `jev`, adaptive effort mode, and available Astra/Sol/Luna targets in fail-open order Astra → Sol → Luna while leaving the target list editable. Run `bun test tests/gui/combo-workspace-data.test.ts`; expect missing strategy/template failures.
- [ ] Implement the GUI strategy records and pure template builder. Re-run the pure tests; expect them to pass.
- [ ] Add a failing component test proving both the Combo workspace and configured JEV provider overview expose `Create JEV Auto`; the provider action deep-links into the same prefilled add modal. Prove the modal lets the user add/remove/change targets and submits the normal `PUT /api/combos` shape. Also prove the action is disabled or clearly reports a collision when `jev-auto` already exists. Run `cd gui && bun test tests/jev-auto-combo.test.tsx`; expect the actions to be absent.
- [ ] Add the quick action by parameterizing the existing add modal with an initial draft and one hash route owned by the Models/Combos page; do not fork the target editor or create a JEV-only editor. For the `jev` strategy, mark the first row as fail-open and show each row's known effort ladder. Add JEV strategy/target/setup copy to all ten locale modules. Re-run the component and pure tests; expect them to pass.
- [ ] Run `cd gui && bun test tests`, `cd gui && bun run lint`, `cd gui && bun run lint:i18n`, and `cd gui && bun run build`; expect exit code 0 for each.
- [ ] Stage the Task 4 files and commit with `git commit -m "feat(gui): add JEV Auto setup flow"`.

## Task 5: Add per-target JEV effort allowlists and prove key setup

**Files:**

- Modify: `src/types/config.ts`
- Modify: `src/combos/types.ts`
- Modify: `src/server/responses/core-combo.ts`
- Modify: `gui/src/combo-workspace-data.ts`
- Modify: `gui/src/components/combo-workspace-controls.tsx`
- Modify: `gui/src/styles-combos-workspace.css`
- Modify: `gui/src/i18n/*.ts`
- Modify: focused Combo, JEV runtime, GUI, provider, and CLI-login tests

- [ ] Add failing config and GUI round-trip tests proving an optional non-empty
  `target.reasoningEfforts` list survives load/save exactly, rejects malformed or
  duplicate values, participates in dirty-state comparison, and is omitted by
  older/unrestricted configurations.
- [ ] Add a failing JEV runtime test proving unchecked efforts are absent from
  the TypeSafe choice criteria and a configured allowlist is intersected with
  the target's current supported ladder rather than broadening it.
- [ ] Implement the smallest typed config/runtime projection. An omitted list
  means all advertised efforts; a present list means only its supported
  intersection. A present list with no supported member contributes no JEV
  target/effort choice.
- [ ] Add a failing component test for per-target effort checkboxes. All
  advertised efforts start selected through omission, toggling persists an
  explicit subset, the final selected effort cannot be removed, and changing
  provider/model resets the override to all.
- [ ] Implement those controls in the existing target editor, with accessible
  labels and localized copy; do not create a JEV-only model picker or alter the
  ordinary picker.
- [ ] Add behavioral tests proving the JEV provider exposes the ordinary GUI
  API-key surface and `ocx login jev` persists a key-backed, credential-only
  provider without publishing a model. Avoid a spurious model-catalog probe for
  this decision-only provider.
- [ ] Run the focused server/GUI/provider/CLI suites and typecheck. Commit with
  `feat: add per-target JEV effort controls` after fresh tests pass.

## Task 6: Document, review, verify, and publish the PR

**Files:**

- Modify: `docs-site/src/content/docs/guides/combos.md`
- Modify: `docs-site/src/content/docs/reference/configuration/routing.md`
- Modify: `structure/runtime.md`
- Modify: `structure/providers-and-adapters.md`
- Modify: `structure/gui-and-management-api.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md` only if the existing template cannot represent the required screenshot/evidence; otherwise leave it unchanged
- Add a screenshot only in the repository's accepted documentation/media location if needed for a stable PR-body link

- [ ] Update canonical docs with JEV key setup, the `jev` strategy, editable target allowlist, `jev-auto` quick-create flow, fail-open/cancellation behavior, one-decision-per-call rule, and the no-live-key testing boundary. Update structure docs for the new runtime/provider/GUI ownership.
- [ ] Run `bun run structure:check`, `bun run privacy:scan`, `bun run typecheck`, `bun run test`, `bun run prepush`, and `cd docs-site && bun install --frozen-lockfile && bun run build`. Save complete outputs in the execution workspace and require exit code 0.
- [ ] Start a disposable local OpenCodex instance with a mocked model target and no TypeSafe key, call `jev-auto`, and verify it reaches the first eligible fail-open target. Use a separate temporary OpenCodex home and ports; never mutate or restart the user's active instance.
- [ ] Launch the built GUI against a disposable local config, create/open the JEV Auto editor, and capture a screenshot showing the JEV strategy plus editable targets. Do not modify the user's running OpenCodex config.
- [ ] Generate the execution skill's whole-branch review package from merge-base `dev` to `HEAD`. Dispatch the required read-only fresh-context reviewer, then verify and fix every valid Critical/Important finding through a new RED→GREEN test before one final full-suite run.
- [ ] Run `git diff --check`, verify `git status --short`, and commit documentation/review fixes with Conventional Commits after fresh tests/builds pass.
- [ ] Push `feat/jev-auto-routing`, create a PR against `dev` using the repository template, include the GUI screenshot and exact test/build evidence, request Codex and Copilot review once, and attach the PR artifact to this task. Do not claim a live TypeSafe decision test.

## Completion Contract

- The ordinary picker still contains every pre-existing model unchanged.
- `jev-auto` appears only after explicit GUI/CLI/API creation.
- The JEV key can be configured through the provider GUI, `ocx login jev`, or `TYPESAFE_API_KEY`.
- JEV can choose only the operator-selected eligible targets and each target's operator-selected supported efforts; omitted target effort lists retain the all-advertised default.
- Every JEV failure mode has a tested first-eligible fail-open path; cancellation has a tested fail-closed 499 path.
- Retryable selected-target failure uses existing Combo fallback exactly once per target without another JEV call.
- Root tests/typecheck/privacy/structure/prepush, GUI tests/lint/build, and docs build pass on the final tree.
- The PR targets `dev`, includes the screenshot and verification evidence, and explicitly states that live-key validation is pending.
