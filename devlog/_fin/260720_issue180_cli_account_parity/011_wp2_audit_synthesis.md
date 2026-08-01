# 011 — WP2 audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Reviewer: sol agent "Gauss" (WP2 A-gate round 1). Verdict: **FAIL** — 4 High +
2 Medium blockers, 8 non-blocking observations. Scope: `src/cli/account.ts`
(parallel-authored, 458 lines) + `index.ts`/`help.ts` wiring vs 010/003.

## Blocker dispositions

### B1 [High] aggregate `list` swallows 401/403/5xx into partial success — ACCEPT

- RCA: `cmdList` fan-out treats ANY non-200 family response as "provider unknown
  to proxy" and `continue`s (src/cli/account.ts:315-330). On an auth-required bind
  a 401 turns into an empty table with exit 0 — exactly the silent-failure class
  C-ACTIVATION-GROUNDING exists to catch.
- Fix (B): fan-out tolerates ONLY 400/404 (provider not known to the live proxy's
  config — legitimate drift between disk config and running proxy); every other
  non-2xx propagates to exit 1 with the server error text. Explicit single-provider
  invocations keep propagating all non-2xx (current behavior, correct).
- New test: mock 401 on one family during fan-out → exit 1; mock 404 → skipped, exit 0.

### B2 [High] failed `GET /api/codex-auth/active` misreported as null pin — ACCEPT

- RCA: `fetchCodexRows` synthesizes `activeId:null` for any non-200 active read
  (src/cli/account.ts:179-186), printing the misleading `auto (no pin…)` note when
  the read actually failed (e.g. 401).
- Fix (B): non-200 active response → `errorJson` (same failure surface as the
  accounts read); null pin only from a real 200 with `activeCodexAccountId:null`.
- New test: active read 500 → exit 1, no auto note.

### B3 [High] local providers can hold key material server-side — REBUT (with doc note)

- Evidence: server `isKeyAuthProvider` excludes only oauth/forward
  (src/providers/api-keys.ts:38-40), so a `local`-authMode provider with key
  material WOULD be served by the keys endpoints. The reviewer asks for a
  server-side exclusion or api-key routing.
- Rebuttal: GUI parity is this unit's spec — `providerAuthSurface` returns `null`
  for local providers unconditionally (gui/src/provider-workspace/auth.ts:21), so
  the GUI never shows credentials for ollama either. The CLI's "has no credentials"
  error matches the GUI surface exactly. Changing the server predicate is outside
  the unit's write scope (`src/server/*` amendment-only) and would alter behavior
  for every consumer, not just this CLI. Key-bearing local configs are pathological
  (the adapter does not use the key).
- Fold: 010 gains a one-line rationale; a classification test pins the behavior
  (`list ollama` → error even when the fixture config carries key material).

### B4 [High] raw-capable metadata (labels, codex id/plan) printed verbatim — PARTIAL

- Evidence: key labels are arbitrary user strings returned verbatim
  (src/providers/api-keys.ts:64-68); codex pool ids/plan are user-controlled.
- Judgment: the unit's guarantee was never "all output is masked" — it is "the CLI
  prints identifiers EXACTLY as the management API returns them (masked
  server-side), same as the GUI". The GUI renders the same label/id/plan verbatim;
  printing ids is also functionally required (`use` needs them). Server-side
  redaction of user metadata is out of scope and would break GUI parity.
- Fold: reword the guarantee in 010 + help text: "secrets and identifiers are
  printed exactly as the management API returns them (masked server-side);
  user-supplied labels are shown verbatim, identical to the GUI". No code change.

### B5 [Medium] 458 lines > 400 target — ACCEPT

- Fix (B): extract the HTTP/DTO layer (`apiJson`, `resolveBaseUrl`, family
  readers, DTO types) into NEW `src/cli/account-api.ts`; keep classification,
  formatting, and subcommands in `src/cli/account.ts` (re-exporting the public
  surface). Both files land under ~260 lines.

### B6 [Medium] test suite false confidence — ACCEPT

- RCA (row 11): the sentinel lived only in config; nothing proved the CLI would
  not print raw material arriving in a DTO field.
- Fix (B): strengthen row 11 — mock DTO carries the sentinel in `masked` (it must
  NOT print), label carries an arbitrary user string (it MUST print, per B4
  resolution); add the B1/B2 error-propagation cases and the B3 local-with-key
  classification case. Update 010 accept criteria to the real matrix count.

## Non-blocking folds

- 010 `--json` list shape updated to `{accounts, notes}` (implementation is better
  than the doc; doc follows).
- 010 accept criteria "13/13" → "all matrix rows" (matrix grew to 14+ rows).
- "Empty rows everywhere" branch noted unreachable on a healthy server (main row
  always exists); retained as defensive output, no test required.

## Re-audit request

Round 2 goes to the SAME reviewer (Gauss) on the amended 010/011 fix spec; B
implements immediately after the gate, and C re-verifies every fixed path with
activation evidence (401/500 cases driven for real in the mock suite + live proxy).

## Round 2 verdict: FAIL (narrowed to 2 spec-precision findings) — dispositions

### R2-B1 [High] fan-out tolerance must be family/provenance-specific — ACCEPT

- Evidence: codex GET routes are unconditional-200 (src/codex/auth-api.ts:387-390,
  458-465) so any codex non-200 is a broken endpoint; names returned by the live
  `/api/oauth/providers` cannot legitimately 400 on the very next
  `/api/oauth/accounts` call (same predicate, src/oauth/index.ts:124-125,155-157);
  only key-pool 404 ("unknown provider") and config-sourced OAuth 400
  ("unknown oauth provider", version drift) are legitimate skips.
- Fold (010 error rules rewritten): provenance tracked per fan-out target;
  skip = (api-key 404 ∧ "unknown provider") ∨ (config-sourced oauth 400 ∧
  "unknown oauth provider"); codex non-200 always fails; everything else fails
  with the server error text.

### R2-B2 [Medium] row-11 test design contradicts the secret contract — ACCEPT

- RCA: the round-1 fold put the raw sentinel in `masked` — which either
  contradicts the API invariant (server never returns raw there) or implies an
  unspecified client sanitizer.
- Fold: sentinel moves to an UNEXPECTED credential field (`apiKey`/
  `accessToken`) alongside a valid server-masked `masked`; assertions: masked
  form prints, sentinel never prints, the row object carries no credential
  field. Wording tightened at 010 outcome/test rows and `src/cli/help.ts:86`
  ("identifiers shown masked as the API returns them").

### R2 resolved confirmations

- Active-read propagation safe (no legitimate non-200 active state) — B2 closed.
- B3 rebuttal verified against the GUI: local providers get a null auth surface
  before key-material detection (gui/src/provider-workspace/auth.ts:17-27,
  kind.ts:11-14, ProviderDetails.tsx:82-88).
- Module split preserves the test import surface.

Round 3 goes to Gauss on the re-amended 010; B implementation proceeds in
parallel (worker on the fold spec) and integrates any round-3 residuals.
