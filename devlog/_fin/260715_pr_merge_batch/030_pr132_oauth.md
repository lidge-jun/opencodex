# 030 — Land PR #132: OAuth manual redirect URL / code paste fallback

Work-phase: `wp3-pr132-oauth`. One full PABCD cycle. Diff source: `diffs/pr132.patch`.
Author: claudianus (external contributor; remote/mobile OAuth user). Per user
instruction we stack improvements on top instead of rejecting.

## What the PR does (~369 ins)

- `src/oauth/index.ts` +78: manual authorization-code / redirect-URL completion path
  (accepts pasted final redirect URL or bare code; must reuse the pending flow's PKCE
  verifier + state).
- `src/oauth/callback-server.ts` +6/-: keeps loopback flow; exposes completion hook.
- `src/server/management-api.ts` +13: endpoint for the GUI to submit the pasted code.
- GUI `AddProviderModal.tsx` + `Providers.tsx`: manualCode input + busy/msg states,
  paste box shown alongside the auth URL ("If the browser cannot reach this machine...").
- i18n: 6 new keys x de/en/ko/zh (`prov.pasteRedirect`, `prov.pasteRedirectHint`,
  `prov.pasteSubmit`, `prov.pasteSubmitting`, `prov.pasteOk`, `prov.pasteFail`).
- `tests/oauth-manual-code.test.ts` (new, 106 lines).

## Security gate (from Copernicus review, must be resolved before B)

- state/PKCE handling on the manual path (no verifier bypass).
- management-api endpoint auth surface: same auth/CORS treatment as other management
  endpoints; no code leakage into request logs.
- normal localhost flow unchanged (regression check).

## Landing plan (B phase)

1. `git fetch origin pull/132/head:pr-132 && git merge --no-ff pr-132` onto dev.
2. Conflicts expected: `AddProviderModal.tsx` / `Providers.tsx` with #128/#129 GUI hunks
   (state declarations + modal body); resolve keeping both features.
3. Stacked improvements (separate commits, locked from Copernicus review):
   - SECURITY: `src/oauth/callback-server.ts` `parseCallbackInput` -> return
     `{kind: "url"|"query"|"raw", code, state}`; require state match for url/query
     inputs; allow missing state only for syntactically-raw codes.
   - Validated request/ack protocol (audit item 1): `onManualCodeInput` signature gains
     the flow's `expectedState` (`(expectedState: string) => Promise<string>`);
     `waitForManualLoginCode(provider, signal, expectedState)` records it in the
     ManualCodeSlot. `submitManualLoginCode` then validates synchronously with the
     kind-aware parser: no extractable code -> 409; url/query kind with missing or
     mismatched state (when expectedState is registered) -> 409 with explicit reason;
     raw code -> accepted. Early-post race (slot not yet registered): parseable input
     is stashed and re-validated by the flow loop (documented optimistic path).
   - `src/server/management-api.ts`: reject non-string/oversized input (4 KiB cap) with
     400 before touching the flow.
   - TESTS: rewrite `tests/oauth-manual-code.test.ts` with a deterministic fake flow /
     mocked token endpoint asserting code_verifier reuse, redirect URI, pasted code,
     persistence, done status; negative cases (missing/mismatched state, raw code,
     no active flow, oversized input); route-level test of `POST /api/oauth/login/code`.
   - i18n: `AddProviderModal.tsx` uses existing `prov.paste*` keys instead of hardcoded
     English; add aria-label to match Providers page.
   - error-string sniffing for message color (`/error|Could not|Network/.test`) is
     locale-fragile -> pass an explicit ok/fail flag.
   - UX copy: hint should say "copy the full URL from the browser address bar" (prefer
     full redirect URL over bare code — retains state validation).

## Verification (C phase)

- `bun test --isolate ./tests/` (incl. oauth-manual-code.test.ts) + typecheck green.
- `bun test --isolate ./tests/oauth-callback-server.test.ts` explicitly (normal
  localhost callback regression) + GUI typecheck AND GUI build (react hunk conflicts
  in AddProviderModal/Providers were manually resolved) (audit item 2).
- Manual smoke: management-api endpoint rejects submissions with no pending flow.
- PR #132 commented/closed appropriately; issue cross-referenced if one exists.
