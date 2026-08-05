# 120 — Issue #959: management-plane provider headers (adopt PR #961)

Independent lane. Research: explorer batch G (read PR #961 head
`2a295b46f803b1b8a5ad365956f4cb6b5fc08389`).
Decision: **adopt PR #961; do not compete.** Add one hardening slice.

## Verified current state

- PATCH `/api/providers` recognizes fields at
  `src/server/management/provider-routes.ts:219-287`; unknown-only → 400
  (`:289`). CLI has no headers option
  (`src/cli/provider-runtime.ts:30-55`).
- `OcxProviderConfig.headers` exists (`src/types.ts:1058`);
  `providerHeadersConfigError()` rejects malformed names, non-string/CRLF
  values, and credential headers (`src/config.ts:605-614,651`). Adapters
  apply configured headers AFTER generated auth
  (`src/adapters/openai-chat.ts:840-847`, `src/adapters/anthropic.ts:875-894`).
- Secret-DTO precedent: GET exposes `hasApiKey` never the key
  (`provider-routes.ts:81-93`); `safeConfigDTO()` exposes `hasHeaders`,
  never names/values (`src/server/auth-cors.ts:506-514`); regression proof
  `tests/server-auth.test.ts:389-428`.
- #961 already carries the right architecture: reusable PATCH helper,
  shallow case-insensitive merge, `null`/`{}` clear, registry static-header
  preservation, validation reuse, mutation-lock replay, CLI parsing,
  argument redaction, tests + locale docs. Still draft; no full CI.

## Diff-level plan (on top of #961's adoption)

1. Review #961 forward (or rebase-carry it with authorship preserved):
   require ready-for-review, full CI green, privacy scan.
2. Hardening addition: GET `/api/providers`
   (`provider-routes.ts:81-93`) gains only
   `hasHeaders: !!p.headers && Object.keys(p.headers).length > 0`. Never
   return header names/values from GET or PATCH responses; add GET/PATCH
   serialization assertions proving a sentinel name/value is absent.
3. Semantics: `Authorization` and other credential headers stay rejected
   (apiKey/authMode/apiKeyTransport own those); other values treated as
   secret-ish in logs/CLI diagnostics; keep #961's `runtime-api.ts`
   redaction; docs state `--headers` is non-authentication metadata.

Files (retained from #961): `src/server/management/provider-routes.ts`,
`src/cli/provider-runtime.ts`, `src/cli/runtime-api.ts`,
`tests/management-provider-validation.test.ts`,
`tests/cli-headless-parity.test.ts`, locale CLI/management docs.

## Tests / activation

`ocx provider edit AGR-OAI --headers '{"x-app":"cli"}'` merges + persists;
next adapter request sends the header; management GET shows `hasHeaders`
only. Matrix: valid PATCH persists; second PATCH shallow case-insensitive
merge; `null`/`{}` clears (registry provider keeps registry static headers);
invalid body/array/non-string/CRLF → 400 no mutation; credential headers →
400; `X-Foo` then `x-foo` → one final value; concurrent independent PATCHes
both survive; unknown-only → 400; GET/PATCH/logs never expose names/values;
CLI object/`-`/`{}`/malformed/repeated flag/inline redaction; adapter
structural test (headers reach the wire, management can't override generated
auth).

## Risks

- CLI JSON lives in shell history — documented as non-secret metadata only.
- Merge-not-replace semantics documented.
- POST `/api/providers` overwrite removing omitted headers is a different
  (non-)defect.

## Accept criteria

- #961 adopted with CI + the GET non-disclosure hardening; gates as 030.
