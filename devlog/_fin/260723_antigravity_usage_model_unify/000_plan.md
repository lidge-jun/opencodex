# Antigravity usage-model unification plan

## Objective

Collapse Google Antigravity usage under the picker/call base model name while preserving wire routing, saved-ID compatibility, token totals, request de-duplication, and cost attribution.

## Constraints

- Canonicalize at summary/read time; do not rewrite append-only `usage.jsonl` history.
- Scope canonicalization to `baseProviderLabel(provider) === "google-antigravity"`.
- Keep CCA wire selection and compatibility behavior unchanged.
- Preserve unknown IDs unchanged and avoid guessing provider behavior.
- Production changes require focused tests plus full typecheck/test gates.

## Dependency-ordered phases

| Phase | Outcome | Depends on |
|---|---|---|
| WP0 | Confirm code/log root cause and define the reverse map | none |
| WP1 | Add a provider-owned canonical call-model resolver and apply it consistently in usage summary identities, values, and cost-row lookups | WP0 |
| WP2 | Harden GUI display/key behavior only if the API can still emit routing-detail `resolvedModel` values | WP1 |
| WP3 | Focused tests, full gates, live API restart check, Provider workspace browser check, closeout evidence | WP1-WP2 |

## Exit criteria

- `/api/usage?range=30d` emits one `gemini-3.6-flash` row and one `gemini-3.1-pro` row for all known Antigravity aliases/wire IDs.
- Daily model buckets use the same canonical names.
- Provider Workspace renders picker/call base names and stable unique React keys.
- Aggregate request/token/cost totals are unchanged, except that split rows are combined.

