# Source findings

## Why the existing threshold is insufficient

`src/codex/auth-context.ts:67` reads `autoSwitchThreshold` for request-owned main pins. It is a selection preference, not a refusal. `src/codex/routing.ts` permits terminal main fallback and scores unknown usage as 101; it cannot be reused as a 99% predicate. A short-only 99% observation still scores unknown.

`src/codex/native-main-admission.ts` covers credential and management claims, not only billable work. Blocking it would prevent the quota refresh needed to recover.

`src/codex/account-lifecycle.ts:63` reconciles the stable `__main__` alias with physical identity. `src/codex/auth-api.ts:866` already owns identity-checked WHAM reads. Request-owned native bearers must not introduce new physical-main reads.

## Settings/UI

`gui/src/pages/codex-set-multiauth.tsx:197` places account picker, request-user-input and Ultra Fast under `advancedExtras`. `src/server/management/config-routes.ts:383` owns partial PUT validation, persistence and rollback. The new setting must return its confirmed value; do not inherit Ultra Fast's missing PUT acknowledgment fallback.

`gui/src/components/codex-account-pool-main-card.tsx` owns persistent main status, `gui/src/hooks/useCodexAccountPool.ts` owns its DTO, and native `<dialog>` patterns already exist in `codex-account-switch-modal.tsx`.

## Reference Codex TUI, inspected 2026-09-05

Reference prefix: local `121_openai-codex/codex-rs/tui/src/chatwidget/` beneath the user's Codex research corpus; not this repository's runtime.

- `backend_banners.rs:61`: picker restriction is current model `gpt-reserve` plus missing ordinary-usage recovery, not a numeric 100% comparison.
- `model_popups.rs:82,199`: both picker entry points replace all catalog choices with the Reserve-only picker.
- `backend_banners.rs:307`: recovery requires a full identity-validated backend response with `ordinary_usage_allowed` and no remaining blocking state.
- Consequently, catalog injection alone cannot fix that TUI restriction. Exposing other native models by falsifying recovery would misrepresent upstream authorization.
- Desktop behavior still requires separate source evidence; TUI evidence is not Desktop proof.

## Reserve follow-up

`src/codex/inject.ts:191,319` already supports the explicit `codexDesktopAuthless` loopback mode, which uses a custom provider with `requires_openai_auth=false`. Reference app-server `model-provider/src/provider.rs:401` then reports no native account requirement. Whether Desktop's Reserve picker follows this state remains unverified.
`src/router.ts:633` accepts an explicitly configured `main/gpt-reserve` namespace, but routing acceptance is not Reserve entitlement. Static native listing omits Reserve, and unknown account-native discovery currently requires supported_in_api=true, unlike the existing Reserve-shaped test fixture. No live Reserve inference or Desktop coexistence has been proven. Do not synthesize availability or change upstream recovery flags; validate this seam before planning any compatibility implementation.

## Installed Desktop source, 26.901.22334 / build 7746

Read the existing application archive without extraction, installation, application writes or restart. Member offsets below are zero-based UTF-8 bytes, not source line numbers.

- `webview/assets/app-initial-f1c3ba37268a.js`, offset4132166: Reserve eligibility rejects an auth method other than `chatgpt`, besides feature/plan/identity/version checks.
- Same member, offset4133005: active Reserve requires ordinary `rate_limit.allowed=false`, a `gpt-reserve` additional limit with `allowed=true`, and `luna_reserve` banner.
- Same member, offset4451408: account/auth projection reads `account` plus `requiresOpenaiAuth` from app-server. The reference provider's `account_state` reports no native account when `requires_openai_auth=false`.
- `webview/assets/app-primary-b1300cb15eed.js`, offset7352039: active Reserve replaces the whole picker list with the single Reserve row; it has no per-provider exception.

Source conclusion: an effective authless custom provider disables this native Reserve-only picker gate, AND disables Desktop automatic Reserve handling. No installed-client patch is necessary for that particular gate. Explicit Reserve plus routed-model coexistence still needs independently verified catalog/routing/quota compatibility. No live Reserve-entitled session was used; do not label these source checks as live success.

## Necessity and limits

Do nothing/configure-only fails because the existing threshold can return to main. Reuse the existing eligibility and native-auth resolution owners. A small policy leaf is justified to share raw-window/identity logic between routing and the status DTO without importing management or Lab into core paths.

The feature is local request admission, not a reservation of the remaining quota. Known bypass: requests already admitted or sent directly to OpenAI. Final upstream authority remains OpenAI; no client code can promise that a displayed 99 never advances to 100.
