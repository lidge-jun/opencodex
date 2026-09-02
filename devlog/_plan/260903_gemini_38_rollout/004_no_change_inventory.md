# 004 — no-change inventory

Answers audit blocker 7: every remaining `gemini-3.6-flash` / `gemini-3.7-flash` occurrence
that this unit does NOT touch, with the reason. Criterion c-5 requires a recorded reason for
each, not silence.

## Runtime and metadata

| Location | Reason |
|---|---|
| `scripts/model-metadata.source.json` Kilo rows (~16356) | Third-party gateway roster captured from Kilo. Adding a 3.8 row would assert Kilo serves it; nothing proves that. |
| same, OpenCode Zen rows (~61353) | Same reason, different gateway. |
| same, Vercel AI Gateway rows (~77014) | Same reason. |
| `src/types/provider.ts:300` | Doc comment illustrating `directGeminiWireRenames` with the 3.7 `-tiered` rename. 3.8 has no `-tiered` id, so replacing the example would document a rename that does not exist. |
| `src/adapters/client-fingerprint.ts:56` | Explanatory prose about UA-gated 404s, not a model list. Reviewer independently confirmed. |
| `src/providers/command-code-efforts.ts:47` | Keyed by Command Code's own live roster, which has no 3.8 row. |
| `src/adapters/google.ts` `GEMINI_DIRECT_WIRE_RENAMES` | Would invent `gemini-3.8-flash-tiered`; the reviewer confirmed no such string exists anywhere in the tree, and CCA does not publish one. |
| `docs-site/.../providers.md:683` | `--retain-models` usage example. Any valid id works; churn without benefit. |
| `tests/google-output-clamp.test.ts` | `maxOutputTokensForGoogleModel` (`src/adapters/google.ts:83-89`) is FAMILY-based: any `gemini` id not matching the `pro` pattern returns 65536. `gemini-3.8-flash` already gets the right ceiling with no table entry, and `001` confirms 65,536 is the documented value. Adding a case would assert the family rule twice. (Round-2 blocker 5.) |

## Tests using 3.6/3.7 as opaque fixtures

These assert transport, quota, signature, vision, or listing behavior and merely need *a*
valid Gemini id. Rewriting them to 3.8 would enlarge the diff without testing anything new,
and would weaken coverage of the ids real users still have saved.

`tests/antigravity-baseurl-override.test.ts:20`, `claude-agent-startup-sync.test.ts:46`,
`cli-headless-parity.test.ts:350`, `command-code-provider.test.ts:515`,
`commandcode-provider.test.ts:74`, `cursor-fast-listing.test.ts:44`,
`cursor-fast-tier.test.ts:43`, `cursor-integration-status.test.ts:89`,
`google-claude-prefill-guard.test.ts:85`, `google-errors.test.ts:13`,
`google-signature-history-roundtrip.test.ts:34`, `google-vertex-thought-signature.test.ts:15`,
`images/gemini-inline.test.ts:252`, `management-provider-validation.test.ts:338`,
`model-visibility-management-api.test.ts:31`, `provider-account-quota.test.ts:435`,
`provider-quota.test.ts:252`, `thought-signature-credential-scope.test.ts:32`,
`vision-backend-union.test.ts:60`.

## Tests that DO change (behavioral assertions)

| Test | Why it must change |
|---|---|
| `tests/google-antigravity-wire.test.ts` | Owns the ladder and collapse behavior 3.8 introduces. |
| `tests/gemini-37-flash-migration.test.ts` | Owns retirement semantics; must prove 3.7 is NOT retired by this change. |
| `tests/google-hardening.test.ts:777` | Exact `google.models` array. |
| `tests/google-models-listing.test.ts:360` | Exact discovered-id array. |
| `tests/provider-registry-parity.test.ts:771` | `toHaveLength(6)` on the Antigravity model list. |
| `tests/oauth-provider-reconcile.test.ts:82,142` | Default model and post-reconcile length. |
| `tests/google-adapter.test.ts:250` | Claude SDK paragraph strip guard (audit blocker 2). |
| `tests/gemini-web-search.test.ts:80,146` | Sidecar default model and resolved wire id. |
| `tests/cursor-effort-table.test.ts`, `cursor-catalog.test.ts` | Only if the preemptive Cursor seed is kept. |
| `tests/sidecar-settings-web-search-gate.test.ts:222` | Uses 3.7 as an available management row; changes only if the sidecar default assertion moves. |

## Sidecar test note

`tests/gemini-web-search.test.ts:146` currently expects `gemini-3.7-flash-tiered` for a `low`
effort call. After the default moves, the 3.8 equivalent expects `gemini-3.8-flash-low` and
**no** `thinkingConfig` (per `003` blocker 1). That difference is itself the proof the
suffix-tier decision reached the sidecar path.
