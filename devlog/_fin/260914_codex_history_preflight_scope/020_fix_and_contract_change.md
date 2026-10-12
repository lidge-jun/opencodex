# 020 — Fix and contract change

PR: https://github.com/lidge-jun/opencodex/pull/4531

On apply, `history_paginated_requires_native_writer` stands the
conversation-history relabel unit down and still writes the config /
profile / catalog half. Restore and remove keep their original hard
refusal. That is narrower than the first draft, which claimed a
history preflight never vetoed the config write in either direction.

The two P1s that forced the narrowing — restore/remove stay refused,
and a provider table the home already published must be kept — came
from the automated Codex reviewer on the pull request, not from the
original analysis. The original write-up asserted the opposite on
both points. The incident review was `structure/`-aware.

## Apply

Only one reason stands the relabel unit down:
`history_paginated_requires_native_writer`, held in the module
constant `HISTORY_RELABEL_STANDS_DOWN`. Codex allocates paginated
rollout ordinals in its own writer; no retry changes that.

When that reason is what preflight returns, config is written. The
relabel job is skipped without spawning a Worker. The reason is
reported in the human message and in the structured
`historyPreflightFailureReason` field, alongside `success: true`. A
mid-transaction observation of that same reason retires the relabel
unit instead of rolling the config back.

Every other reason keeps the original hard refusal and the
compensating rollback:

- `history_injection_preflight_unavailable`
- `history_state_database_missing`
- rollout-integrity codes

That includes a mid-transaction observation of those reasons, which
throws `CodexHistoryPreflightRefusal`. Treating a transient failure
as a stand-down would let `resolveCodexHistoryTransition` record the
transition as converged and suppress the relabel permanently.

## Restore / remove — hard refusal kept

`removeCodexConfig`, `restoreCodexConfigInlineImpl`,
`restoreNativeCodex`, and `restoreNativeCodexAsync` keep their
original hard refusal on a history preflight failure. The first
draft softened those paths and argued they opened no state database
and no rollout, so a history preflight had never authorized them.
That argument is withdrawn.

Stripping the `[model_providers.opencodex]` definition while thread
rows still reference it makes those conversations unresolvable. The
restore path has no seam for keeping a compatibility provider table.
So the uninstall deadlock on an already-paginated home is **not**
fixed by this unit.

Open follow-up: lift the remove/restore deadlock only after the
restore path gains a keep-the-table seam. Until that seam exists,
the hard refusal stays.

## Provider table the home already published

Rows tagged `opencodex` resolve only through
`[model_providers.opencodex]`. The loopback (Design B) form normally
retires that table because the relabel migrates those rows back to
`openai` in the same pass. With the relabel stood down, retiring it
would orphan those conversations.

The injector therefore snapshots `hadOcxProviderTableOnDisk` before
its idempotent cleanup and re-appends the table before the write
witness is built when the relabel stood down and the form is not
already table-based.

The first draft recorded those rows as a pre-existing limitation:
they were equally unresolvable while the refusal blocked the write,
so keeping or dropping the table did not matter. That is true only
for a home that never published the table. For a home that **had**
the table, removing it would have been a new regression. Review
caught that; the original analysis had asserted the opposite.

## `sync.ts`

`syncModelsToCodex` lost the `catalog-only` downgrade. A surviving
refusal is a real failure again. The silent `ok: true` /
`Model catalog synchronized; Codex config and conversation history left
unchanged because paginated history requires its native writer.` path
is gone.

## Safety argument

Paginated rollout bytes and thread rows are not rewritten, and no
Worker is spawned to relabel them. The stand-down is not a write
grant over history bytes.

The stand-down is also not a write grant over remove or restore.
Those directions still refuse, because the only safe restore that
would accompany a config unwind is one that can keep
`[model_providers.opencodex]` for rows that still name it, and that
seam does not exist yet.

Keeping a table the home already published is a preservation of
resolvability, not a new provider install. A home that never had the
table still does not gain one from this path.

## Tests changed

`tests/codex-integration/codex-inject-integration.test.ts`

- The commit-boundary test and the paginated-history test were inverted
  to the apply-path stand-down contract.
- A new test pins that `model_catalog_json` reaches `config.toml` on a
  paginated home.

`tests/codex-integration/codex-sync-api.test.ts`

- The two `catalog-only` downgrade tests were replaced. A surviving
  refusal is a failure, not a successful catalog-only sync.

## Verification so far

- `bun run typecheck`, `bun run structure:check`, and
  `bun run privacy:scan` pass.
- Full CI on PR #4531 went green on the earlier revision (all four
  test shards plus macOS). The narrowed revision is being re-run.
- The local product suite was deliberately never run.
- Live recovery on the affected machine is user-confirmed: the model
  picker shows the routed models again in both the Codex app and the
  CLI.
