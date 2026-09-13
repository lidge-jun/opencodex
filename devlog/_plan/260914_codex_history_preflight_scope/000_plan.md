# 000 — History preflight scopes only the relabel unit

- Unit: `260914_codex_history_preflight_scope`
- Opened 2026-09-14
- Class C4 (Codex-home config write + conversation-history safety; public `ocx sync` contract)

## Objective

A history preflight refusal scopes only the conversation-history relabel unit.
It never vetoes the config / profile / catalog write, in either direction.

That is the whole unit. The on-disk catalog was already correct. The picker
showed six built-in OpenAI models because `model_catalog_json` never reached
`~/.codex/config.toml`. The preflight that was meant to protect paginated
rollouts from a non-native writer was used as a hard veto on the entire
config transaction, and `sync.ts` then downgraded that veto to a successful
catalog-only result. The operator saw `Model catalog synchronized`. The
picker did not.

## Symptom

On Codex `0.154.0-alpha.6.2`, the model picker in both the desktop app and
the CLI showed only the six built-in OpenAI models.

`ocx sync --restart-app-server-only` printed `Model catalog synchronized`
and restarted the app-server, so the failure looked like a success. The
on-disk catalog `~/.codex/opencodex-catalog.json` was correct the whole
time (24 models). Evidence for the chain that produced this is in `010`.
The contract that replaces it is in `020`.

## Constraints

- **No local product suite.** `bun test`, `bun run test`, and
  `bun run test:changed` are NOT RUN for this unit. The local suite was
  deliberately skipped at the user's instruction. Hosted CI is the
  verification gate.
- Paginated rollout bytes and thread rows are never modified while the
  preflight refuses. The native writer stays the only writer of that
  shape.
- Do not invent facts beyond the chain and contract recorded in `010`
  and `020`. No security-sensitive or pre-disclosure material belongs
  here.

## Work-phase map

| wp | Doc | Output |
|---|---|---|
| wp0 | this file | objective and completion criteria |
| wp1 | `010_rootcause_evidence.md` | verified cause chain and file:line |
| wp2 | `020_fix_and_contract_change.md` | contract change, safety argument, accepted limitation |

## Completion criteria

- Apply always writes the config / profile / catalog half. A history
  preflight refusal skips the relabel job without spawning a Worker,
  reports the reason in the human message and in
  `historyPreflightFailureReason`, and still returns `success: true`.
  A mid-transaction migration retires the relabel unit instead of
  rolling the config back.
- Restore and remove write the config and catalog halves. The history
  restore unit stands down. Paginated rollout bytes and thread rows
  are not modified in this state.
- `src/codex/sync.ts` no longer special-cases the preflight reason into
  a catalog-only `ok: true`. A surviving refusal is a real failure
  again.
- Tests match the new contract:
  `tests/codex-integration/codex-inject-integration.test.ts` (commit-
  boundary and paginated-history cases inverted; new case pinning that
  `model_catalog_json` reaches `config.toml` on a paginated home) and
  `tests/codex-integration/codex-sync-api.test.ts` (the two
  `catalog-only` downgrade tests replaced).
- `bun run typecheck` has already passed. A real `ocx sync` on the
  affected machine has already written `model_catalog_json` and
  `openai_base_url`, printed the stood-down relabel warning, and the
  model picker recovered (user-confirmed). Local suite: NOT RUN.
  Remaining gate: hosted CI.
- Rows already tagged `model_provider = 'opencodex'` stay recorded as
  a follow-up question in `020`, not as a regression this unit
  introduced.

## Terminal outcomes

- **DONE** — `010` and `020` record the chain and the contract; the
  completion criteria above hold; hosted CI is the remaining proof.
- **BLOCKED** — a fact required by `010` or `020` cannot be stated
  without invention. Stop rather than fill the gap.
- **UNSAFE** — any design that writes paginated rollout bytes or
  thread rows under a preflight refusal. Stop and redesign.
