# wp2 — registration, as one atomic change

## Why this phase is not backend-only

The first draft split backend from GUI. An audit round failed it, correctly:
`tests/gui/integrations-invariants.test.ts` asserts sorted equality between
`EXPORT_CLIENT_IDS` and five GUI lists, so the moment the backend knows about a
fourteenth client and the GUI does not, that test is red — and leaving it at
thirteen is red against the backend instead. There is no ordering of the two
halves that keeps the tree green.

A further binding runs the same way, though not where it first looks.
`CLIENT_LABEL_KEYS` is an `as const` map, not an annotated
`Record<…, TKey>`; the type pressure comes from its use sites —
`t(CLIENT_LABEL_KEYS[client])` and the exhaustive
`Record<FileIntegrationClientId, TKey>` maps — where `TKey` is
`keyof typeof en` and every other catalog is a `Record<TKey, string>`. So a new
label key has to exist in `en` to compile and in all nine catalogs to keep
parity. i18n is part of the same atomic change rather than a follow-up.

So wp2 is the whole registration: backend, GUI source lists, marks wiring, the
nine locale catalogs, **and every test literal and allowlist that moves with
them** — including `gui/tests/client-config-panel.test.tsx`,
`gui/tests/integrations-api.test.ts`, the row count in
`gui/tests/integrations-overview-rows.test.ts`, `ZH_TW_KEEP_ENGLISH` in
`gui/tests/locale-parity.test.ts` and `INTENTIONAL_ENGLISH` in
`gui/tests/fr-localization.test.ts`. A second audit round caught the earlier
version leaving those in wp3: CI runs `cd gui && bun test` unconditionally, so a
finished wp2 would have been red on five GUI suites.

The `integrations.semantics.omo` string is therefore written in wp2 too, in all
nine locales — a placeholder would fail locale parity just as an absent key
would. wp3 copy-edits it against the rendered page rather than creating it.

**wp2's closing condition** is that all three are green together: `bun run
typecheck`, the focused root tests, and `cd gui && bun test`.

## Files and what each gains

`src/clients/config-export/contracts.ts`
: `"omo"` in the `ExportClientId` union. Every exhaustive `Record<ExportClientId, …>`
  in the tree becomes a typecheck error until it is filled, which is the point.

`src/clients/config-export.ts`
: `omoAgentDir` and `omoConfigPath` helpers implementing omo's published
  precedence (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`,
  `PI_CODING_AGENT_DIR`, `~/.omo/agent`), a `buildOmoContribution` that stamps
  omo's ownership on the shared Pi fragment, and the `EXPORT_CLIENTS.omo` spec
  with all nine fields. `filename` is `omo-models.json` rather than a bare
  `models.json`, for the Downloads-folder collision reason `prime-models.json`
  and `aside-models.json` already record.

  Each of the three variables is resolved separately and reports `ClientPathError`
  under **its own name**, so a user who set `OMO_CODING_AGENT_DIR` is not told
  that `PI_CODING_AGENT_DIR` is wrong. An empty or whitespace value falls through
  to the next name, which is what `agent-dir.js` does.

  One consequence is worth stating rather than discovering: a user who has set
  `PI_CODING_AGENT_DIR` and neither of the other two now has Pi and omo
  resolving the **same** `models.json`. Both write the same `providers.opencodex`
  block through the same builder, so the bytes agree; what does not agree is
  ownership, since two enable records would claim one file. That is omo's own
  contract — it reads Pi's variable by design — and the honest response is to
  document it, not to silently diverge from the client we are configuring.

  One divergence is deliberate and worth naming: omo `resolve()`s its override
  against the process cwd and does not expand `~`. We refuse a relative override
  and do expand `~`, exactly as Pi, Prime, MCode and ZCode already do, because a
  background proxy and a foreground client have different working directories.

  `buildOmoContribution` calls `buildPiClientConfig(ctx, true)` — with the flag,
  not the default. Prime and Aside pass the default in their contribution while
  their `build` also passes the default, so they are consistent; splitting the
  flag across `build` and `buildContribution` would make `ocx export` emit
  `compat` while enable and refresh wrote a file without it.

  **Slot: last, after `raycast`,** in both the union and the `EXPORT_CLIENTS`
  object. `EXPORT_CLIENT_IDS` is `Object.keys(EXPORT_CLIENTS)`, so the object's
  insertion order is the public order that three ordered assertions compare
  against. The existing order is append-only landing order — `pi` is second and
  `prime` eleventh — not a family grouping, so appending is the edit that leaves
  the other thirteen positions untouched.

`src/integrations/registry.ts`
: `INTEGRATION_CLIENTS.omo` with `configPath` and `detectDir`. JSON, so no
  `sourcePreservingYaml`; single-writer, so no `writerLock`; paths are a pure
  function of env and home, so no `resolvePaths` and no `unresolvedPathHint`.
  This matches `pi` and `prime` exactly.

`src/cli/registry.ts`
: the `export` entry's static usage string. Acceptance comes from
  `EXPORT_CLIENT_IDS` through `isExportClientId`, so this is help text only —
  but `tests/cli/cli-headless-parity.test.ts` reads it.

`gui/src/…` and `gui/src/i18n/*`
: the five lists the invariant compares, the two lists only the tab-coverage
  test compares, the three exhaustive records the compiler forces, the mark
  entry, the routing hash, and three keys in each of nine locales. `020`
  enumerates them; they land here because of the binding above, not because wp3
  was abandoned.

`src/cli/help.ts`
: the `(13 clients)` literal on line 84. Hand-written so `ocx --help` does not
  import the export registry, and asserted in lockstep with
  `EXPORT_CLIENT_IDS.length` by `tests/cli/cli-help.test.ts:79`.

`src/integrations/catalog-refresh.ts`, `src/server/management/config-routes.ts`,
`src/cli/dispatch.ts`
: omo added to the three general owned-catalog fan-out lists, per the decision in
  `002`. Not `src/cli/index.ts`, which is a Raycast-specific startup helper.
  `tests/clients/sync-client-integrations.test.ts:68` pins one of those lists as
  source text.

## The detect directory question

`detectDir` is the cheap "is this client installed at all" signal. For omo the
honest directory is the agent directory itself rather than `~/.omo`: `~/.omo`
exists on this machine carrying only `binary-runtime`, written by the v4 launcher
wrapper, while `~/.omo/agent` does not exist yet. Detecting on `~/.omo` would
report a v5 install that is not there. `agent-dir.js` creates the agent directory
on first launch, so its presence is the fact we want.

## Loopback-only

`loopbackOnly: true`, on OMP's and Prime's grounds rather than Pi's and Aside's.

The flag is a policy bit, not a schema observation: `isLoopbackOnly` is read by
the writer, which refuses apply and refresh when the proxy is bound
non-loopback. It does not block `ocx export` or `/api/client-config` for a
Pi-family client.

senpi's provider block *does* accept a `headers` map, so unlike Aside there is a
place an `x-opencodex-api-key` could go. What does not exist is a builder that
emits one — `buildPiClientConfig` writes no headers at all, which is why `pi`
is loopback-only too. So the honest wording is deferred remote wiring, and
`010` must not repeat Pi's "no header field" line, which `001` disproves.

## Session affinity

`buildPiClientConfig` takes a `sendSessionAffinityHeaders` flag. `pi` passes
`true`; `prime` and `aside` leave it false. omo's value follows the same
evidence rule: true only if senpi is verified to read `compat.sendSessionAffinityHeaders`.

## Tests

New: `tests/clients/omo-client.test.ts`, modeled on
`tests/clients/raycast-client.test.ts` and the prime test before it — path
precedence including the two inherited variables, relative-override refusal,
emitted document shape, and the ownership stamp on the contribution.

One assertion must **not** be copied from Prime.
`tests/clients/prime-client.test.ts` asserts Prime's document carries no
`compat` block. omo's asserts the opposite, the way the Pi case in
`tests/config/client-config-export.test.ts` does, and it asserts it on both the
`build` output and the contribution so the two cannot drift apart.

Updated because they assert exact lists:
`tests/config/client-config-export.test.ts` (ordered `EXPORT_CLIENT_IDS`),
`tests/config/client-config-export-new-clients.test.ts` (loopback-only set),
`tests/gui/integrations-invariants.test.ts` (client count and the
`Record<IntegrationClientId, string>` seed, which forces an omo fixture in omo's
own JSON shape), `tests/clients/integrations-state.test.ts` (loopback-only set),
and the layout guards `scripts/test-layout/layout.json` plus
`tests/fixtures/test-layout-expected.json` for the new file.

## Focused test set for this phase

`tests/clients/omo-client.test.ts`, `tests/config/client-config-export.test.ts`,
`tests/config/client-config-export-new-clients.test.ts`,
`tests/clients/integrations-state.test.ts`,
`tests/clients/sync-client-integrations.test.ts`,
`tests/cli/cli-help.test.ts`, `tests/gui/integrations-invariants.test.ts`,
and the two layout guards.

## Execution notes fixed at P

**`omoAgentDir` semantics.** Three variables, in omo's order, each resolved the
way `piAgentDir` resolves its one: `env.NAME?.trim()`, and a falsy result falls
through to the next name. That reproduces `agent-dir.js`, which trims and then
tests truthiness, so a variable set to the empty string or to whitespace is
skipped rather than treated as a path. Each variable reports `ClientPathError`
under **its own name** when it holds a relative path, because telling a user
`PI_CODING_AGENT_DIR must be an absolute path` when they set
`OMO_CODING_AGENT_DIR` is worse than no message.

**The order matters and it is not cosmetic.** omo resolves its own variable
first, so an opencodex that checked `PI_CODING_AGENT_DIR` first would write to a
Pi directory omo will never read whenever a user has both set.

**`sendSessionAffinityHeaders: true`.** The flag is not decoration: the
generated provider tells the client to supply a stable session identity, from
which opencodex derives canonical OpenCode Go affinity
(`docs-site/.../guides/pi.md`). senpi validates the same `compat` key
(`001`), so omo gets the same benefit pi does. `prime` and `aside` are left
false because nobody verified their engines read it — that is an absence of
evidence, not a decision to copy.

**Slot.** `omo` goes last in `ExportClientId` and in `EXPORT_CLIENTS`, after
`raycast`. The ordered assertion in `tests/config/client-config-export.test.ts`
reads `Object.keys` order, and appending is the only edit that leaves the other
thirteen positions untouched.

**Layout.** The `clients` domain regex seeds only `^aside-profile(?!s-routes)`
and `^(?:desktop|omp|pi|prime|remote|sync)-`, so `omo-client.test.ts` cannot be
placed by pattern and needs the explicit entry in both tables.
