# R1 — the paginated-history guard, from activation and from recovery

Scope: #5321 (activation) and #4812 (recovery). Branch `codex/260920-r1-paginated-history-guard`.

## What the guard was actually protecting

`preflightCodexHistoryInjection` returns `history_paginated_openai_requires_native_writer` when a
provider-table transition finds a thread row that is both `model_provider = 'openai'` and
`history_mode = 'paginated'`. The reasoning is sound. The transition takes the root
`openai_base_url` out, a paginated row cannot be relabeled, and Codex builds its provider map as
`merge_configured_model_providers(built_in_model_providers(openai_base_url), model_providers)`, so
without that root line the built-in `openai` entry is `api.openai.com`. The conversation would
resume outside the proxy.

What made it a lockout is that 2.60.0 classified it alongside "something is wrong with this
store". `src/codex/inject.ts` refuses every reason that is not exactly `HISTORY_RELABEL_STANDS_DOWN`,
so nothing was written at all: no config, no profile, no `model_catalog_json`, integration
disabled. Before 2.60.0 the same home returned the plain stand-down, and the routing and catalog
half landed while the relabel stood down.

## The state that was already in the tree

The injector already builds the safe state for one routing form. `keepRootOverrideAlongsideTable`
keeps the marker-owned root override beside the provider table for client compaction, for exactly
this reason, and passes `resumeHistory: false` so the relabel never runs. Authless was excluded
deliberately — its point is `requires_openai_auth = false` — on the assumption that it could
always forward-tag resume history instead. On a paginated home that assumption is false, and the
refusal is where that showed up.

So the fix is not a new mechanism. `src/codex/inject/paginated-openai-compat.ts` selects the
existing one from the preflight verdict rather than from the routing form: when the reason is the
paginated-openai code and the target can own a root key, retain the override, downgrade the reason
to the stand-down constant, and let the transition complete. The paginated row is never read or
written; it simply keeps resolving to this proxy.

Two cases cannot reach that state, and both are honest outcomes rather than traps:

- An admission-token form cannot use the root key at all, because Codex's built-in `openai` entry
  carries no `x-opencodex-api-key` header. It keeps the refusal, and the message now names
  `unauthenticatedLoopbackListener` and `syncResumeHistory` instead of "do not retry".
- A root line the user owns is left alone. The conversation follows the destination they chose,
  which is the guarantee the injector already makes everywhere else about a line it does not own,
  and the journal correctly records the line as not ours.

## Where it had to live

`src/codex/inject.ts` was at 984 of its 987-line ratchet cap, so the decision could not be
inlined. The new module costs the injector one import and one net line; the file now sits at
exactly 987. The refusal code became an exported constant in `src/codex/history-provider.ts`
because the same literal in two files is how the stand-down pair drifted the first time.

## #4812, checked rather than assumed

The recovery half is already closed on `dev`: `resolveRestoreHistoryDisposition` stands down on
`HISTORY_RELABEL_STANDS_DOWN` and removal retains the provider table. The new code cannot reach
restore at all — it is only set under `providerTableMode`, and restore preflights with
`providerTableMode = false`, whose row predicate is `model_provider = 'opencodex'`.

Two things were still wrong on that side. `ocx restore --remove-codex-provider-table` existed but
appeared in no usage or help text, so the escape hatch was reachable only by reading the parser;
it is now in the command registry and top-level usage, bound by a test that reads the flag out of
`dispatch.ts` rather than restating it. And the public guide in all eight locales still said
restore and removal refuse on paginated history and that such a home cannot be uninstalled, which
has not been true since 2026-09-17.

## Verification

Static review plus exact-head hosted CI. Per the lane constraints, NOT RUN locally: `bun test`,
any individual test file, `bun run typecheck`, any build, any install, live `ocx`, service
restart, and credential or configuration changes.

Regression coverage added:

- `tests/codex-integration/history-paginated-openai-compat.test.ts` — the resolver itself: root
  override retained and placed before the first table, CRLF preserved, a user-owned line left
  untouched and not claimed, the admission-token refusal naming both remedies as keys that are
  asserted to exist in `src/types/config.ts`, every other reason passing through unchanged, and a
  source-oracle check that the refusal code is defined once.
- `tests/codex-integration/codex-inject-integration.test.ts` — the end-to-end regression, rewritten
  from "refuses" to the full transition: config carries both the table and the marker-owned root
  override, the rollout bytes and the thread row are unchanged, and `ocx restore` afterwards takes
  the retained override back out. That last assertion is the one that keeps this from trading
  #5321 for a new #4812.
- `tests/cli/cli-restore-back.test.ts` — the removal flag is discoverable in both help surfaces.

## Not in this lane

The other hard-refusal reasons on the recovery side still have no named repair command: a missing
state database with pending manifest entries, and a backup manifest that is unreadable, foreign,
or schema-invalid. Those are a different failure family from the guard and are left open rather
than folded in here.
