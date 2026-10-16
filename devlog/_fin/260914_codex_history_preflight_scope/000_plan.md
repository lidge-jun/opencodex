# 000 — History preflight stands down only paginated relabel on apply

- Unit: `260914_codex_history_preflight_scope`
- Opened 2026-09-14
- PR: https://github.com/lidge-jun/opencodex/pull/4531
- Class C4 (Codex-home config write + conversation-history safety; public `ocx sync` contract)

The first shipped draft scoped every history preflight, in both
directions, and treated already-tagged `opencodex` rows as a
pre-existing limitation. Automated review on the pull request found
that both claims were wrong. This file describes the narrowed
contract that actually shipped. The two P1s — restore/remove must
keep the hard refusal, and a provider table the home already
published must be kept — came from the automated Codex reviewer, not
from the original analysis. The incident review was `structure/`-aware.

## Objective

On apply, `history_paginated_requires_native_writer` stands the
conversation-history relabel unit down and still writes the config /
profile / catalog half. That is the only reason that stands down,
and apply is the only direction that does.

Restore and remove keep their original hard refusal. Every other
preflight reason keeps the original hard refusal and the
compensating rollback. The uninstall deadlock on an already-paginated
home is not this unit's to close.

The on-disk catalog was already correct. The picker showed six
built-in OpenAI models because `model_catalog_json` never reached
`~/.codex/config.toml`. `sync.ts` then downgraded that apply veto to
a successful catalog-only result. The operator saw `Model catalog
synchronized`. The picker did not.

## Symptom

On Codex `0.154.0-alpha.6.2`, the model picker in both the desktop app and
the CLI showed only the six built-in OpenAI models.

`ocx sync --restart-app-server-only` printed `Model catalog synchronized`
and restarted the app-server, so the failure looked like a success. The
on-disk catalog `~/.codex/opencodex-catalog.json` was correct the whole
time (24 models). Evidence for the chain that produced this is in `010`.
The contract that replaces the apply-path veto is in `020`.

## Constraints

- **No local product suite.** `bun test`, `bun run test`, and
  `bun run test:changed` are NOT RUN for this unit. The local suite was
  deliberately never run. Hosted CI is the verification gate.
- Paginated rollout bytes and thread rows are never modified while the
  preflight refuses. The native writer stays the only writer of that
  shape.
- Restore and remove stay hard-refused. Softening them without a
  keep-the-table seam on restore orphans conversations that still
  reference `[model_providers.opencodex]`.
- Only `history_paginated_requires_native_writer` is a stand-down.
  Treating a transient reason as one would let
  `resolveCodexHistoryTransition` record the transition as converged
  and suppress the relabel permanently.
- Do not invent facts beyond the chain and contract recorded in `010`
  and `020`. No security-sensitive or pre-disclosure material belongs
  here.

## Work-phase map

| wp | Doc | Output |
|---|---|---|
| wp0 | this file | objective and completion criteria |
| wp1 | `010_rootcause_evidence.md` | verified cause chain and file:line |
| wp2 | `020_fix_and_contract_change.md` | shipped contract, review corrections, open follow-up |

## Completion criteria

- Apply writes the config / profile / catalog half when the preflight
  reason is `history_paginated_requires_native_writer` (held in
  `HISTORY_RELABEL_STANDS_DOWN`). The relabel job is skipped without
  spawning a Worker. The reason is reported in the human message and
  in `historyPreflightFailureReason`, alongside `success: true`. A
  mid-transaction observation of that same reason retires the relabel
  unit instead of rolling the config back.
- Every other apply-path reason
  (`history_injection_preflight_unavailable`,
  `history_state_database_missing`, rollout-integrity codes) keeps the
  original hard refusal and the compensating rollback, including when
  observed mid-transaction, where it throws
  `CodexHistoryPreflightRefusal`.
- `removeCodexConfig`, `restoreCodexConfigInlineImpl`,
  `restoreNativeCodex`, and `restoreNativeCodexAsync` keep the
  original hard refusal on a history preflight failure. The uninstall
  deadlock on an already-paginated home remains open follow-up; a
  later fix needs a keep-the-table seam on the restore path.
- When the relabel stands down, a `[model_providers.opencodex]` table
  the home already published is kept. The injector snapshots
  `hadOcxProviderTableOnDisk` before its idempotent cleanup and
  re-appends the table before the write witness is built if the form
  is not already table-based. Removing that table would be a new
  regression, not a pre-existing limitation.
- `src/codex/sync.ts` no longer special-cases the paginated-history
  reason into a catalog-only `ok: true`. A surviving refusal is a
  real failure again.
- Tests match the narrowed contract:
  `tests/codex-integration/codex-inject-integration.test.ts` (commit-
  boundary and paginated-history cases inverted; new case pinning that
  `model_catalog_json` reaches `config.toml` on a paginated home) and
  `tests/codex-integration/codex-sync-api.test.ts` (the two
  `catalog-only` downgrade tests replaced).
- `bun run typecheck`, `bun run structure:check`, and
  `bun run privacy:scan` pass. Full CI on PR #4531 went green on the
  earlier revision (all four test shards plus macOS); the narrowed
  revision is being re-run. Local suite: NOT RUN. Live recovery on
  the affected machine is user-confirmed: the model picker shows the
  routed models again in both the Codex app and the CLI.

## Terminal outcomes

- **DONE** — `010` and `020` record the chain and the narrowed
  contract; the apply-path completion criteria above hold; the
  uninstall deadlock is recorded as open follow-up, not claimed
  closed.
- **BLOCKED** — a fact required by `010` or `020` cannot be stated
  without invention. Stop rather than fill the gap.
- **UNSAFE** — any design that writes paginated rollout bytes or
  thread rows under a preflight refusal, or that strips
  `[model_providers.opencodex]` while tagged rows still reference it.
  Stop and redesign.
