# 020 — Fix and contract change

A history preflight refusal now scopes only the conversation-history
relabel unit. It never vetoes the config / profile / catalog write, in
either direction.

## Apply

Config is always written. The relabel job is skipped without spawning a
Worker. The reason is reported in the human message and in the
structured `historyPreflightFailureReason` field, alongside
`success: true`.

If a mid-transaction migration is already in flight, it retires the
relabel unit instead of rolling the config back. The config half that
has been written stays written.

## Restore / remove

The config and catalog halves proceed. The history restore unit stands
down. Paginated rollout bytes and thread rows are never modified in
this state.

The same preflight that used to deadlock `removeCodexConfig`,
`restoreCodexConfigInlineImpl`, and the two `restoreNativeCodex*` sites
can no longer hold those directions closed. Remove and restore become
reachable again because they no longer share a veto with the relabel
unit.

## `sync.ts`

`syncModelsToCodex` lost the `catalog-only` downgrade. A surviving
refusal is a real failure again. The silent `ok: true` /
`Model catalog synchronized; Codex config and conversation history left
unchanged because paginated history requires its native writer.` path
is gone.

## Safety argument

`removeCodexConfig` and the config half of restore open no state
database and no rollout. A history preflight never authorized them in
the first place. Scoping the refusal to the relabel unit is therefore
not a new write grant over history bytes; it is the removal of a veto
that those paths did not need and that left the home unrecoverable.

The history unit itself is unchanged in this state: paginated rollout
bytes and thread rows are not rewritten, and no Worker is spawned to
relabel them.

## Accepted limitation (follow-up, not a regression)

Rows already tagged `model_provider = 'opencodex'` resolve only in the
routing forms that install a `[model_providers.opencodex]` table. They
were equally unresolvable while the refusal blocked the write, so this
is pre-existing and is not introduced by the fix.

Follow-up question: how should those already-tagged rows resolve when
the installed routing form does not carry a `[model_providers.opencodex]`
table? Record the answer in a later unit. Do not treat the current
unresolvable rows as a regression of this contract change.

## Tests changed

`tests/codex-integration/codex-inject-integration.test.ts`

- The commit-boundary test and the paginated-history test were inverted
  to the new contract.
- A new test pins that `model_catalog_json` reaches `config.toml` on a
  paginated home.

`tests/codex-integration/codex-sync-api.test.ts`

- The two `catalog-only` downgrade tests were replaced. A surviving
  refusal is a failure, not a successful catalog-only sync.

## Verification so far

- `bun run typecheck` passes.
- A real `ocx sync` on the affected machine now writes
  `model_catalog_json` and `openai_base_url`, prints the stood-down
  relabel warning, and the model picker recovered (user-confirmed).
- The local product suite was deliberately NOT RUN at the user's
  instruction. Hosted CI is the verification gate.
