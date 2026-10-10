# 040 — Verification obligations and evidence plan

## The verification constraint, and what replaces local runs

No local verification runs for this unit. Not `bun test` in any form, not
`bun run test:changed`, not `bun run typecheck`, not `bun x tsc`, not
`bun install`, not `bun run build:gui`, and not `ocx`. A local suite has
previously deleted a real `~/.opencodex`.

That is a real loss of signal, so it has to be paid for twice: with static
obligations that are checkable by reading, and with hosted CI at the exact
head. Neither alone is sufficient, and neither is described here as if it
were.

### Incident: the rule was broken during this unit's survey

A read-only survey subagent built a shell command containing unescaped
backticks, which the shell executed as `ocx restore`.

Observed state afterwards, by direct read:

| Artifact | Evidence |
|---|---|
| `~/.codex/config.toml` | mtime 02:02, hours before the run; injected `openai_base_url`, `model_catalog_json` intact |
| `~/.opencodex/config.json` | mtime 17:44:56, before the subagent was spawned (~17:46:30) |
| `~/.opencodex/integrations/codex.json` | mtime Sep 16 11:07 |

Nothing was written. The restore refused at the history preflight, which is
the behaviour #4812 is about, and the desired-state write was a no-op because
`clientIntegrations.codex` was already `false` and `setIntegrationEnabled`
returns `changed: false` in that case (`src/codex/desired-state.ts:167`).

The pre-existing `clientIntegrations.codex: false` is the user's own state and
was not altered. It is recorded here because it is load-bearing for reading
any later observation of this machine, not because this unit touched it.

Correction applied: delegated prompts must not embed backticks in shell
command strings, and read-only agents get an explicit prohibition on the
`ocx` binary rather than only on the test commands.

## Static obligations

These are the claims that would normally be a test run, and how each is
discharged by reading instead.

**Atomicity of the degraded write.** `010` establishes that a config with root
`model_provider = "opencodex"` and no matching table fails `Config::load`
outright. Obligation: trace every path through
`removeCodexConfig({ retainProviderTable: true })` and confirm a single
`atomicWriteFile`, with the retained block already in the buffer. Any early
return between strip and append is a defect regardless of test outcome.

**Capture/removal symmetry.** `extractOcxProviderTableBlock` and
`removeOcxSection` must agree on what our table is. Obligation: they share
`isOcxProviderHeaderLine` and the same scan shape, so a future change to one
cannot silently diverge from the other.

**Refusal-reason asymmetry.** Only
`history_paginated_requires_native_writer` selects the degraded path.
Obligation: the comparison is against the existing
`HISTORY_RELABEL_STANDS_DOWN` constant, not a string literal, so the apply and
restore directions cannot drift apart.

**Receipt semantics.** `historyPreflightRefusal` must stay unset on the
degraded path, because `src/cli/index.ts:813-818` reads it plus three
`skipped` artifacts to keep a stop obligation owed. Obligation: confirm the
degraded envelope reports config as `partial`, which fails that conjunction on
two counts.

**Lock ordering in the child PR.** Coordinated homes take `N -> C`
(`src/codex/codex-write-lock.ts:18,335`). Obligation: the settings save's `C`
transaction is closed before `injectCodexConfig` is called; confirm by reading
the handler's control flow, not by inspecting a log.

## Test changes owed

Report A identified the assertions that pin the current refusal. Each needs to
move to the degraded contract, and each new file needs byte-identical entries
in both `scripts/test-layout/layout.json` (`explicit`) and
`tests/fixtures/test-layout-expected.json`.

| File | What changes |
|---|---|
| `tests/codex-integration/codex-inject-integration.test.ts:128-143` | the all-skipped refusal envelope becomes the degraded envelope |
| `tests/codex-integration/codex-inject-integration.test.ts:468-493` | `action` union widened |
| `tests/codex-integration/codex-inject-integration.test.ts:525-542` | paginated row: refusal becomes degraded success with the table retained |
| `tests/codex-integration/codex-restore-app-rewrite.test.ts:223` | `action` assertion |
| `tests/service/stop-deferred-teardown.test.ts:128-173` | degraded must not be classified as deferred |
| `tests/cli/uninstall.test.ts:200-223` | degraded no longer produces a failed step |
| `tests/config/settings-stream-mode.test.ts:346-416` | child PR: the two switches assert applied/effective, not only persistence |

New coverage owed, in the domain directory that matches:

- A paginated home where restore removes root routing, keeps the table
  verbatim including its marker, and leaves rollout bytes and thread rows
  byte-identical.
- The ordering invariant: no reachable output has root
  `model_provider = "opencodex"` without the table.
- `--remove-codex-provider-table` removes it and says what breaks.
- Repeated `restore` → `stop` → `uninstall` in sequence is idempotent and
  damages neither user config nor history.
- Child: stored-on / effective-off on a non-loopback bind reports both values
  and the reason.

## Hosted CI evidence

Both PRs record, at the exact head SHA:

- the head SHA itself,
- direct check-runs for that SHA rather than an aggregate run that may be
  stale or cancelled,
- the conclusion per job.

`bun run structure:check` and `bun run privacy:scan` run in CI like everything
else. If a change touches an owned `src/` area, the matching `structure/` doc
is updated **in the same PR**, or `structure:check` fails and that failure is
the correct answer rather than something to route around.

The Windows job is `workflow_dispatch`-only. If either PR plausibly affects
Windows — the config write path and EOL handling both do — the host is told so
it can dispatch. This lane does not dispatch it.

## Honest limits of this evidence

Hosted CI proves the suite's assertions hold on three platforms. It does not
prove the upstream claims in `010`, which come from a vendored corpus snapshot
rather than the Codex binary on any given machine, and it does not prove the
end-to-end recovery on a real paginated home — that needs a live
`ocx uninstall` followed by a working `codex`, which this lane is forbidden to
run. Both gaps are stated in the PR descriptions rather than papered over.
