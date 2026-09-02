# 050 — Phase 5 (wp5): Issue #3280 — GUI full-config PUT rejection

## Finding (gpt-5.6-sol investigator, high effort)

VERDICT FIXABLE_NOW, confidence high, credential-surface risk YES.

`gui/src/hooks/useJsonConfigEditor.ts:27-39` serializes the redacted config DTO
and submits `PUT /api/config`. The server deliberately rejects every such
request at `src/server/management/config-routes.ts:248-253`, reinforced by
`src/server/management/route-registry.ts:165`. Fanning out to per-provider
POST/PATCH/DELETE is unsafe: each operation persists independently
(`src/server/management/provider-routes.ts:652-655`, `779-781`, `1101-1138`),
which allows partial saves and loss of fields absent from the public DTO.

## MODIFY / NEW / DELETE map

- MODIFY `src/server/auth-cors.ts` — typed provider-editor DTO plus a single
  public-field projection, so a redacted or derived field can never become write
  authority.
- MODIFY `src/server/management/provider-routes.ts` — NEW atomic
  `PUT /api/providers` taking `{ baseline, next }`; compare `baseline` against
  the latest public projection, merge `next` into freshly read persisted
  providers while preserving API keys, pools, headers and credentials, validate
  every provider/default/deletion, then commit once through
  `mutatePersistedConfig` and reconcile caches/accounts/catalog a single time.
- MODIFY `src/server/management/route-registry.ts` — register the new route;
  keep the `/api/config` 405 exactly as is.
- MODIFY `gui/src/hooks/useJsonConfigEditor.ts` — expose only
  `{ defaultProvider, providers }`, send one `{ baseline, next }` request, and
  keep parse failures distinct from network/server failures.

## TESTS

- NEW `tests/provider-config-batch-management.test.ts` — the PUT updates several
  providers in one commit, preserves masked credentials and private fields,
  returns 400 with zero persisted change when any row is invalid, and 409 on a
  stale baseline.
- NEW `gui/tests/use-json-config-editor.test.tsx` — Save issues exactly one
  `PUT /api/providers` carrying baseline and next, never `PUT /api/config`, never
  a POST/PATCH/DELETE fan-out, and refreshes only after success.

Both are red on current HEAD.

## Verification (C)

```
bun test tests/provider-config-batch-management.test.ts
bun test gui/tests/use-json-config-editor.test.tsx
bun run typecheck
```

The credential-preservation assertion is the load-bearing one: the endpoint must
never persist `hasApiKey`/`hasHeaders` or any other derived marker.


## Security review checkpoint (required before merge)

This phase creates a NEW write endpoint that must preserve secrets the caller
never sees. `MAINTAINERS.md` requires explicit security review for credential
surfaces, and a green CI run is not that review. Record all of the following in
the PR description before requesting merge:

- Threat model: the GUI holds only the redacted public projection. A naive
  round-trip therefore writes `hasApiKey: true` back over a real `apiKey`. The
  `{ baseline, next }` shape exists so the server, which alone holds the secret,
  performs the merge.
- Non-authority invariant: no field originating from the public projection may
  become write authority. `hasApiKey`, `hasHeaders`, and every other derived
  marker must be rejected, not persisted.
- Atomicity invariant: one `mutatePersistedConfig` commit. A partial save on this
  surface can strand a provider without its credential.
- Concurrency invariant: a stale `baseline` returns 409 rather than overwriting a
  concurrent edit.
- Unchanged: the `/api/config` 405 stays exactly as is. This phase does not
  re-enable full-config PUT.

Merge is blocked until this block is filled in on the PR. If review concludes the
merge semantics cannot be made safe, the outcome is UNSAFE, not merged.

