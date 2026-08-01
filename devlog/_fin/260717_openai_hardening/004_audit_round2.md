# Audit Round 2 — Synthesis

Reviewer: GPT-5.6 Sol, high reasoning, priority service tier
Result: `VERDICT: GO-WITH-FIXES (blockers=8)`
Disposition: all eight blockers accepted; no blocker was rebutted.

## Closed from Round 1

- The non-activating 010 / atomic activating 020 split is sound.
- Virtual model identity and client-history ownership are fixed.
- GUI QA has concrete routes, viewports, interactions, console checks, and artifacts.

## Accepted amendments

1. Replace action-only roadmap bullets with exact signatures, branch order, callers,
   and activation assertions in every touched decade document.
2. Reject `chatgpt/<model>` before configured-namespace routing. Route bare OpenAI
   model families through fixed tier precedence before the generic provider
   `defaultModel` loop so `openai-apikey.defaultModel` cannot capture a bare model.
3. Make migration default reassignment explicit: legacy pool intent plus legacy
   default `openai` becomes `openai-multi`.
4. Make backup safe for fresh installs and both platforms: absent original is a no-op,
   backup creation is atomic, temporary files are removed on failure, mode is 0600 on
   POSIX, and existing Windows secret ACL hardening is reused.
5. Keep `codexAccountMode` out of persisted config and `ProviderConfigSeed`. Own it in
   `ProviderRegistryEntry`, derived public DTOs, and runtime `RouteResult`. Management
   rejects forbidden raw own-properties before sanitizing and accepts only a full
   canonical `{name, provider}` registry seed.
6. Replace config-only sidecar choice with ordered candidates plus auth resolution.
   Missing Direct caller auth skips to Multi; an actual Direct upstream 401 is final
   and never triggers a hidden Multi retry.
7. Give compact its own request-log context/finalizer. Persist virtual selected model,
   namespaced requested model, and base resolved model; usage may remain unreported.
8. Make the mandatory E2E intercept `globalThis.fetch` only for exact canonical hosts,
   fail unknown URLs, restore the original fetch after every test, and never add a
   production base-URL override.

## Residual precision amendments

- `projectNativeModelsForOpenAiMulti` is read-only/no-network, not filesystem-pure;
  tests inject a native-slug snapshot.
- GUI wording is “exactly three OpenAI presets alongside existing non-OpenAI and
  custom presets,” not “three total presets.”
- The locale file set is exactly `en.ts`, `ko.ts`, `de.ts`, and `zh.ts`.

## Re-audit gate

The same reviewer must inspect the amended documents and either return PASS or name
only remaining concrete blockers. No implementation begins while a roadmap blocker
remains open.
