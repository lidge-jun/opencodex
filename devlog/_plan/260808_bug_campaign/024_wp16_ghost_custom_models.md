# WP16 — ghost custom models (#1273), and closing out the campaign's tail

## Scope

Three items survived WP15 as hand-offs. One is already done, one is a
disposition, and one is a real two-part defect that needs a patch.

| Item | State entering WP16 | Outcome |
|------|--------------------|---------|
| #1283 grok weekly limit | OPEN, but fixed on `dev` by #1290 | closed with the landed SHA |
| #1278 / #1279 Windows console flash | PR open, CI unapproved | CI approved at SHA-matched head |
| #1273 ghost custom models | OPEN, no fix PR | **the work of this phase** |

### #1283 — already fixed, closed manually

`5222f354a fix(quota): prefer Grok weekly credits for xAI dashboard (#1290)`
landed on `dev` at 13:35Z and does exactly what the report asked: prefer
`GET /v1/billing?format=credits` and map SuperGrok's weekly window to
`weeklyPercent`/`weeklyResetAt`, with the legacy 30-day endpoint demoted to a
fallback (`src/providers/quota.ts:49`, `:592`).

The PR body said `Closes #1283`, but PRs here target `dev` and GitHub only
auto-closes on merges into the default branch, so the issue sat open with its
fix already shipped. Closed by hand with the SHA. This is a recurring trap in
this repository and it is why `AGENTS.md` tells contributors to close linked
issues manually.

One loose thread worth recording: #1290's own description noted a pre-existing
`tests/translator-budget.test.ts` failure on the tip and pushed with
`--no-verify`. Checked on a clean worktree at `dev`: **13 pass / 0 fail**. The
failure was local to that environment, not on `dev`, so nothing to chase.

### #1278 / #1279 — approved, awaiting author

#1279 (`fix(windows): eliminate console windows from proxy-internal identity &
process lookups`, wade19990814-hue, head `43b6b824c`) is non-draft and
`MERGEABLE`, touching seven Windows source files and four test files. Its
Cross-platform CI sat at `action_required`, invisible to `gh pr checks`.

Approved at a SHA-matched head (`43b6b824c` == run head, `MATCH` in
`.tmp/ocx_approval_ledger.tsv`). Disposition is **awaiting CI, then review** —
the change is Windows-specific and this campaign has no Windows host, so CI is
the only evidence available and the review will have to lean on it.

## #1273 — the actual defect

The report describes two defects. Both reproduce in the source; neither is a
false positive.

### Defect 1 — provider removal orphans `config.customModels`

Both removal paths delete only the provider record:

- `src/cli/provider.ts:304` — `delete config.providers[name]; validateAndSave(config);`
- `src/server/management/provider-routes.ts:617` — `delete config.providers[name];`
  followed by `setProviderContextCap`, `save`, `reconcileLiveStateStores`,
  `clearModelCache(name)`, `convergeCodexCatalog()`.

Note what the management path *does* clean up: context caps, the model cache,
and the catalog. It walks right past `config.customModels`. So a custom model
for the removed provider stays in the config, keeps appearing in `/api/models`,
and keeps being emitted into the Codex catalog — a row pointing at a provider
that no longer exists.

### Defect 2 — a stale in-memory config wins a whole-document write

`saveConfigPreservingClaudeCode` (`src/config.ts:2710`) takes one authoritative
pre-write read of the on-disk config and uses it for exactly two reconciliations:

- `claudeCode` (`:2716`–`:2726`): if disk changed and we did not, adopt disk.
- the live server binding (`:2731`–`:2739`): port/hostname come from disk.

`customModels` gets neither. `projectCustomModelCatalogMigration`
(`src/codex/custom-model-catalog-migration.ts`) *does* consult the persisted
config, but only to project the `customModelCatalogMigration` ownership marker —
it reads `customModels` to classify legacy slugs and never writes the array
back. The candidate's array passes through untouched into
`persistConfigUnlocked`.

So the reporter's step 4 is exactly right: a `PUT /api/shadow-call-settings`
from a process whose config predates a CLI deletion re-persists the whole stale
document, and the deleted rows return. Their diff even shows the cooperating
save path working correctly (generation bumped, catalog mtime matching) — the
write was well-formed, it just wrote the wrong document.

**The asymmetry is the bug.** Two fields already get last-writer-wins protection
because they are known to be mutated by other processes. `customModels` is
mutated by `ocx models remove` from a different process and got no such
treatment.

## Diff-level plan

### WP16-A — `src/config.ts`: reconcile `customModels` against disk

Add a third reconciliation next to the `claudeCode` block, using the same
already-taken `onDisk` read (`:2715`) — no second read, since the comment there
correctly warns that a second read could observe different bytes.

Shape, mirroring the `claudeCode` baseline logic:

- Track a `customModelsBaseline` per config object, set when the config is
  loaded, exactly as `claudeCodeBaseline` is.
- On write: if the on-disk array differs from the baseline **and** the
  in-memory array equals the baseline, adopt the on-disk array. That is
  "someone else changed it and we did not", which is precisely the reporter's
  scenario.
- If both changed, the in-memory value wins and we do not silently merge. A
  merge would invent an intent neither writer expressed; last-writer-wins on a
  genuine concurrent edit is the same rule `claudeCode` already uses.

Acceptance: a test that loads a config, deletes a custom model on disk out of
band, then performs an unrelated `PUT`-shaped save from the stale object, and
asserts the deleted row does not return.

### WP16-B — both removal paths drop the provider's custom models

`src/cli/provider.ts:304` and `src/server/management/provider-routes.ts:617`
each filter `config.customModels` by `provider !== name` before saving. The
management path already clears the model cache and reconverges the catalog, so
the ghost disappears from `/api/models` and the catalog in the same write.

**Open question, answered before writing the patch.** Does anything rely on a
`customModels` row outliving its provider — re-adding the provider and
expecting its models back, for instance? If so, deleting would be wrong and the
fix would belong at read time.

The answer is in provider *rename*. `rewriteProviderReferences`
(`src/providers/provider-id-rewrite.ts:34`) explicitly rewrites
`customModels[].provider` alongside combo targets and Claude tier maps
(`:97`–`:101`). So this array is already designed to track the provider
lifecycle; rename follows it and remove simply does not. No test anywhere
expects rows to survive removal and be restored on re-add.

That makes deletion the consistent fix rather than a judgement call, and it
reframes defect 1: not a missing feature, but a lifecycle hook that one of two
sibling operations forgot. Consumers confirm the same shape —
`src/codex/catalog/provider-fetch.ts` emits every row into the catalog keyed by
`routedSlug`, and `src/server/management/model-rows.ts` lists every row in the
dashboard, neither checking that the provider still exists.

### WP16-C — verification

- Focused: new tests in the config and provider-removal suites.
- Ablation: revert each half independently; the matching test must fail and the
  other must not. Two defects, two independent proofs.
- Full `bun run test`, `bun run typecheck`, `bun run privacy:scan`.
- Republish protocol: `mktemp -d` worktree, no writes in the dirty checkout
  outside `devlog/`.

This is a maintainer-authored fix with no contributor PR to preserve, so there
is no `Co-authored-by` trailer. The PR body credits the reporter for a
reproduction that included a before/after config diff and the evidence that the
cooperating save path itself was healthy — that is what made the second defect
findable rather than a vague "settings sometimes revert".

## Acceptance criteria

1. #1283 closed with the landed SHA and an explanation of the manual close.
2. #1279's CI approved at a SHA-matched head, logged, disposition recorded.
3. Both #1273 defects fixed, each with its own regression test and its own
   ablation.
4. Full suite, typecheck, and privacy scan green on the rebased branch.
5. PR opened against `dev` with all three template sections and the reporter
   credited.
6. The consumer question in WP16-B answered with file:line evidence before the
   patch is written.

---

# Audit fold — five blockers, all accepted

A `gpt-5.6-terra` reviewer returned `VERDICT: fail` on the plan above with
B1–B5. Every one is accepted. B3 is the important one: it finds a case where my
proposed rule loses user data, which is worse than the bug it was written to
fix.

## B3 — "memory wins if both changed" resurrects a deleted provider's model

My rule was whole-array last-writer-wins: adopt disk when disk changed and
memory did not, otherwise keep memory. The reviewer supplied the case that
breaks it.

Disk deletes provider **P** (and, after WP16-B, P's custom models). Meanwhile
the in-memory process independently edits an unrelated custom model **Q** — a
legitimate edit through `/api/models`. Now *both* arrays differ from the
baseline, so my rule keeps memory wholesale, and P's custom model comes back.
The exact ghost row #1273 is about, reintroduced by the fix for #1273.

A whole-array comparison cannot distinguish "I edited Q" from "I am asserting
the entire array including P". The array is a keyed collection and has to be
reconciled as one:

- Reconcile per row, keyed by `routedSlug(provider, modelId)`, three-way
  against the baseline: a row deleted on disk and untouched in memory stays
  deleted; a row edited in memory is kept; a row added on either side is kept.
- Then prune any surviving row whose provider is absent from the config being
  written. That prune is the lifecycle invariant from WP16-B applied at the
  write boundary, so it holds no matter which path produced the array.

Required regression: disk deletes P while memory edits Q, then an unrelated
save. Q keeps its edit, P's row does not return.

## B1 — the same staleness applies to `providers`, not just `customModels`

I scoped the fix to `customModels` because that is what the issue reported. But
`saveConfigPreservingClaudeCode` writes the *whole document*, so the identical
stale-write path resurrects `config.providers[P]` itself. Fixing only the models
leaves a deleted provider coming back, which then makes its models legitimate
again — the ghost returns by a different door.

**Correction:** the acceptance test asserts both. After an external provider
deletion and an unrelated long-lived-server save, `config.providers[P]` **and**
P's custom models must both stay absent. If whole-array reconciliation cannot
deliver that, the answer is provider-aware reconciliation or a field-scoped
persistence path, not a narrower test.

## B2 — I described the baseline mechanism wrongly

I wrote that the baseline is "set when the config is loaded, exactly as
`claudeCodeBaseline` is". That is not what `claudeCodeBaseline` does. It is a
`WeakMap` armed **explicitly by `startServer`** (`src/config.ts:2497`,
`src/server/index.ts:485`), and the comment there says arming is eager on
purpose because lazy arming would lose the hand edit the guard exists to
protect.

The consequence matters: a CLI process that loads a config and saves it is
**not armed**, so a guard modelled on this would be silently inert there. That
is defensible for `claudeCode`, whose contested writer is the long-lived
server, but it must be a stated policy rather than an accident.

**Correction:** the plan must name every writer path, state whether it is
armed, and define the unarmed behaviour explicitly. My current position: an
unarmed config has no baseline, so it cannot claim "I did not change this" —
the safe default there is the provider-absence prune from B3, which needs no
baseline at all. That is why the prune is not optional.

## B4 — deletion is consistent, but the marker needs its own test

The reviewer confirmed WP16-B's premise: dependent combos are already rejected
before provider deletion, rename already rewrites `customModels[].provider`,
and `src/server/management/model-rows.ts:55` renders custom rows without
checking that the provider exists. So deletion matches existing lifecycle
behaviour.

**Correction:** add a regression that deletion removes the visible row *without
corrupting* `legacyOwnedSlugs` in the `customModelCatalogMigration` marker. That
marker grants one-time ownership of pre-marker rows; if deletion silently
rewrites it, an older binary's view of ownership changes, and the migration
file's own comment warns against exactly that.

## B5 — do not imply #1290's CI was green

I recorded #1290 as landed without qualifying its CI. Checked: the
Cross-platform run at its head `0fe140f91` concluded **`cancelled`**, not
`success`.

What actually validates the fix is `dev` afterwards. `dev` at `5222f354a` also
shows `cancelled`, and the first `success` on `dev` after it is `57ea8df47` —
the #1288 merge, which contains #1290's change as an ancestor. So the Grok
weekly fix *is* covered by a green `dev` run, but by inheritance, one merge
later, and not at its own head.

That distinction is worth stating rather than smoothing over: "it's on `dev`
and `dev` is green" is a weaker claim than "its own CI passed", and the run
ids are what let a reader tell which one they are being given. The same
`test 3/4` flake recorded in WP15 is the likely cause of both cancellations.

## Revised acceptance criteria

1. #1283 closed with the landed SHA, the manual-close reason, **and** the
   honest CI provenance from B5.
2. #1279's CI approved at a SHA-matched head, logged, disposition recorded.
3. Both #1273 defects fixed. Defect 2's fix reconciles per row and prunes rows
   whose provider is absent; it does **not** rely on whole-array comparison.
4. Regressions, each with its own ablation:
   a. provider removal drops that provider's custom models;
   b. stale save does not resurrect deleted rows;
   c. **disk deletes P while memory edits Q** — Q survives, P does not;
   d. stale save does not resurrect the deleted **provider** either;
   e. deletion leaves `legacyOwnedSlugs` intact.
5. Every writer path named with its arming status, and the unarmed policy
   stated.
6. Full suite, typecheck, privacy scan green on the rebased branch.
7. PR against `dev`, all three template sections, reporter credited.

## Writer-path survey, as B2 requires

`saveConfigPreservingClaudeCode` / `validateAndSave` are called from about
twenty files:

```
11 src/server/management/agent-settings-routes.ts
 7 src/server/management/provider-routes.ts
 5 src/server/management/oauth-account-routes.ts
 5 src/providers/api-keys.ts
 5 src/cli/claude-desktop.ts
 4 src/server/management/routing-profile-routes.ts
 4 src/server/management/config-routes.ts
 4 src/cli/provider.ts
 3 src/server/management/combo-routes.ts
 3 src/codex/routing.ts
 ... 10 more
```

They split into two populations:

- **Management routes** (`src/server/management/*`) run inside the long-lived
  server, which armed the baseline at `startServer`. A per-config baseline
  guard works there.
- **CLI paths** (`src/cli/provider.ts`, `src/cli/claude-desktop.ts`,
  `src/cli/models.ts`) are short-lived processes that load, mutate, and exit.
  They are **never armed**, and arming them would be meaningless: they read
  disk moments before writing, so their "baseline" is the disk.

This settles the B2 policy and reinforces B3. A baseline-only guard is inert
across roughly half the call sites, so correctness cannot rest on it. The
provider-absence prune needs no baseline and therefore holds on every path,
which is why it is the load-bearing half of the fix and the row-keyed
reconciliation is the refinement layered on top where a baseline exists.

A guard that silently does nothing on half its call sites is the kind of fix
that reads well in a diff and fails in the field — which is the shape of the
original defect, where two sibling operations disagreed about the same array.

---

# Second audit fold — the design was still wrong in four places

A second review round returned `VERDICT: fail` again. B5 is closed; B1–B4 are
not, and two of them invalidate the replacement design rather than refining it.

## B2 — `routedSlug` is an encoding, not an identity

This is the worst error in the plan so far, because it was introduced *by* the
fix for the previous worst error. I keyed row reconciliation on
`routedSlug(provider, modelId)`. Both components are mutable:

- `PUT /api/custom-models/:id` accepts a new `modelId`
  (`src/server/management/model-routes.ts:356` — it looks the row up by
  `cm.id === id` and then reassigns `cm.modelId`).
- provider rename rewrites `model.provider`
  (`src/providers/provider-id-rewrite.ts:97`).

So a renamed row looks like a *deleted row plus a new row* under my key. Three-
way reconciliation would then either drop the rename or keep both copies. The
reviewer's phrase is the right test: one row must survive, not two conflicting
copies and not zero.

The type already carries the right key. `OcxCustomModel.id` is a
`crypto.randomUUID()` assigned at creation (`src/types.ts:531`–`:533`) and never
rewritten by rename or by the PUT — which is exactly why the PUT route looks
rows up by it.

**Correction:** reconcile keyed by `OcxCustomModel.id`, with an explicit
field-level conflict policy: a row present on both sides takes the in-memory
field values where memory differs from baseline, and disk values otherwise. A
row absent on disk and unchanged in memory is a remote delete and stays deleted.
Regressions must cover a disk-side provider rename and a disk-side `modelId`
change, each concurrent with an in-memory metadata edit of the same row.

I should have found this myself: I *read* the PUT route while confirming defect
1 and still reached for the slug, because the slug is what the catalog uses.
Catalog-facing identity and storage identity are different things.

## B1 — the provider record itself is still unreconciled

I widened the acceptance criterion to require that a stale save resurrect
neither the provider nor its rows, then wrote a design that only reconciles
`customModels`. Pruning models cannot make `providers[P]` absent, and
`saveConfigPreservingClaudeCode` still serializes the whole candidate object.
The criterion and the design contradict each other, and the criterion is right.

**Correction:** the design must name how `providers` is reconciled. Two options,
to be decided with evidence rather than taste:

1. Extend keyed reconciliation to `providers` — remote deletes win when the
   in-memory record is unchanged from its baseline.
2. A field-scoped persistence operation: callers declare which top-level fields
   they are changing and only those are written, leaving everything else at the
   on-disk value.

Option 2 fixes the entire class rather than two fields, but it changes every
call site and is a much larger blast radius; option 1 keeps the change local at
the cost of leaving the next field to be discovered the same way `customModels`
was. The decision needs the call-site matrix below to be made honestly, and it
is explicitly *not* made in this revision.

## B3 — the writer survey was approximate, so its conclusion was unearned

I wrote "…10 more" and then drew a two-population conclusion from a list I had
truncated. The reviewer named a counterexample I had elided:
`src/storage/policy.ts:265` loads an unarmed config and calls the wrapper, and
it is neither a management route nor a CLI command.

Exhaustive matrix, all 13 files that call `saveConfigPreservingClaudeCode` or
`validateAndSave`, with how each obtains its config:

| File | calls | config provenance |
|------|-------|-------------------|
| `src/server/management/agent-settings-routes.ts` | 8 | `loadConfig()` |
| `src/providers/api-keys.ts` | 4 | passed-in |
| `src/cli/provider.ts` | 4 | `loadConfig()` |
| `src/cli/claude-desktop.ts` | 4 | `loadConfig()` |
| `src/server/management/oauth-account-routes.ts` | 4 | passed-in |
| `src/server/management/config-routes.ts` | 3 | `loadConfig()` |
| `src/server/management/combo-routes.ts` | 2 | passed-in |
| `src/codex/routing.ts` | 2 | passed-in |
| `src/server/management/provider-routes.ts` | 1 | passed-in |
| `src/storage/policy.ts` | 1 | `loadConfig()` |
| `src/codex/auth-api.ts` | 1 | `loadConfig()` |
| `src/providers/key-failover.ts` | 1 | passed-in |
| `src/config.ts` | 1 | internal |

The honest conclusion is not "two populations". It is that **provenance is
mixed within every layer**: management routes both load fresh and mutate a
long-lived object, and non-route modules (`storage/policy`, `codex/routing`,
`providers/key-failover`, `providers/api-keys`) write config too. A guard keyed
to `startServer` arming covers some of these and not others, and which is which
is not predictable from the directory.

## B4 — the prune needs a stated precondition, not universal application

I claimed the provider-absence prune is safe everywhere because it needs no
baseline. The reviewer's objection stands: `saveConfigPreservingClaudeCode`
performs no runtime full-config validation, and `auth-api.ts:377` treats any
object with a truthy `providers` as a runtime config. Nothing structurally
prevents a caller from saving a filtered or partially built config, and a prune
would silently delete that user's rows.

The reviewer looked and found no production writer that deliberately saves a
partial config — but "I could not find one" is not an invariant, and my plan
asserted safety without establishing one.

**Correction:** the prune applies only to a config proven to carry an
authoritative provider map. Either enforce that precondition at the write
boundary explicitly, or scope the prune to the reconciled snapshot the write
path itself builds from the on-disk read. A test must show that a filtered or
partial caller cannot silently delete retained rows.

## Where this leaves WP16

Two rounds of review have found, in order: a rule that resurrects deleted rows,
a key that duplicates renamed rows, a criterion contradicting its own design, a
truncated survey used to justify a conclusion, and an unproven safety claim.
That is a defect whose correct fix is a genuine concurrency design, not a patch
I can land credibly inside this session's remaining scope.

**Disposition: #1273 stays open with a documented diagnosis rather than a rushed
fix.** Both defects are confirmed at file:line and that is real value for
whoever picks it up. Shipping my third design attempt — after two were shown to
lose user data — into a config-persistence path would be the least defensible
thing in this entire campaign.

The diagnosis goes on the issue: both defect sites, the asymmetry with
`claudeCode` and the server binding, the rename-vs-remove inconsistency, the
identity requirement (`OcxCustomModel.id`, not the slug), the writer matrix, and
the two candidate designs with their tradeoffs.

---

# Third audit fold — the matrix was still wrong, and the hold was too wide

## The "exhaustive" matrix was not exhaustive

I built it by grepping the wrapper name, which misses every aliased binding.
The management routes bind it through a test-injection seam:

```
model-routes.ts:129            const persistConfig = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
routing-profile-routes.ts:316  const save = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
native-integration-routes.ts:731  const persist = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
```

So `model-routes.ts` — the file that owns custom models — showed up as **zero
writes** in a matrix I published as exhaustive, in a document arguing that the
previous version's approximation was the problem. Corrected inventory, direct
plus aliased:

| File | direct | aliased |
|------|--------|---------|
| `src/server/management/agent-settings-routes.ts` | 8 | 2 |
| `src/server/management/provider-routes.ts` | 1 | 7 |
| `src/server/management/model-routes.ts` | 0 | 6 |
| `src/cli/claude-desktop.ts` | 4 | 0 |
| `src/cli/provider.ts` | 4 | 0 |
| `src/providers/api-keys.ts` | 4 | 0 |
| `src/server/management/oauth-account-routes.ts` | 4 | 0 |
| `src/server/management/config-routes.ts` | 3 | 0 |
| `src/server/management/combo-routes.ts` | 2 | 0 |
| `src/codex/routing.ts` | 2 | 0 |
| `src/server/management/routing-profile-routes.ts` | 0 | 2 |
| `src/server/management/native-integration-routes.ts` | 0 | 1 |
| `src/storage/policy.ts` | 1 | 0 |
| `src/codex/auth-api.ts` | 1 | 0 |
| `src/providers/key-failover.ts` | 1 | 0 |
| `src/config.ts` | 1 | internal |

**16 writer files; 20 wrapper references.** The distinction matters and I
blurred it: `src/server/management-api.ts`, `management/context.ts`,
`management/logs-usage-routes.ts`, and `management/shared.ts` import or
type-reference the wrapper without ever invoking it (`context.ts:21` declares it
as an optional dependency for the test seam). Counting those as writers
overstates the surface, which is the same species of error as the undercount it
replaced — I fixed a number by changing it to a different wrong number.

Also corrected: I labelled `auth-api.ts` as `loadConfig()`-only, but
`getRuntimeConfig` at `:381` prefers a passed-in runtime config when one is
supplied.

The conclusion survives and strengthens — provenance is mixed and arming-keyed
guards are inert on much of this surface — but I published a false count while
criticising an approximate one. Both public comments on #1273 were corrected.

## Splitting the disposition: defect 1 ships, defect 2 holds

The reviewer rejected the all-or-nothing hold, correctly. My reasoning was "a
stale save can reintroduce the rows anyway, so cleaning them up is theatre".
That conflates two things: defect 2 is a *concurrency* defect that needs a
reviewed persistence design, while defect 1 is a *lifecycle* gap in two direct
code paths that already do provider cleanup and already reject dependent combos
first (`provider-routes.ts:604`). One being unfinished does not make the other
unsafe or useless.

**Revised disposition:**

- **Defect 1 — fix now.** Filter `config.customModels` by provider in both
  removal paths, with a regression proving `legacyOwnedSlugs` in the
  `customModelCatalogMigration` marker is not corrupted.
- **Defect 2 — stays open on #1273** with the diagnosis, pending a persistence
  design reviewed on its own terms.

This is the third time in this work-phase that the review changed my answer
rather than polishing it, which is the argument for running the gate at all.

---

# Fourth audit fold — the CLI half had no test

Four more blockers, all accepted.

**The one that mattered: I fixed the CLI path and never tested it.** The
ablation I presented reverted *both* files at once and showed one API test
failing, which proves the management wiring and says nothing about
`src/cli/provider.ts`. A reviewer reading "ablation passes" would reasonably
assume both halves were covered. They were not.

Added `tests/cli-provider.test.ts` → "provider remove drops that provider's
custom models (#1273)", which spawns the real CLI, asserts the persisted
`config.json`, and asserts the new `--json droppedCustomModels` field. Ablating
`src/cli/provider.ts` **alone** now gives 29 pass / 1 fail, and that failure is
the CLI test. Two paths, two independent proofs — which is what the previous
work-phase already established as the standard and what I failed to apply here.

**Marker persistence was asserted on the helper, not the write path.** The
marker test only proved `dropProviderCustomModels` does not mutate the in-memory
object. It never exercised `projectCustomModelCatalogMigration`, which runs
inside the save. Both integration tests now seed
`customModelCatalogMigration` and assert its value in the persisted
`config.json` after the delete, so the claim covers the real path.

**A false comment in the shipped code.** I wrote that dropping the emptied key
leaves a config "byte-identical to one whose last custom model was removed" —
untrue, because the migration marker deliberately survives. Narrowed to the
claim actually being made: the `customModels` field is absent either way.

Final verification on `57ea8df47`:

- `bun run test` — **10008 pass / 7 skip / 0 fail**, 626 files
- `bun test` on the three touched suites — 62 pass, then 30 pass for the CLI suite
- ablation, management path only — 61 pass / 1 fail (the API test)
- ablation, CLI path only — 29 pass / 1 fail (the CLI test)
- `bun run typecheck` clean, `bun run privacy:scan` passed

---

# Outcome

| Item | Disposition |
|------|-------------|
| #1283 grok weekly limit | **closed** — fixed on `dev` by #1290 (`5222f354a`), closed manually with a public correction about its CI provenance |
| #1273 defect 1 (orphaned rows) | **fixed** — PR #1293, `472015e5a` |
| #1273 defect 2 (stale whole-document write) | **open with a diagnosis**, deliberately not patched |
| #1278 / #1279 Windows console flash | **awaiting CI** — approved at a SHA-matched head, three shard hangs so far, diagnosed publicly |

## #1279 and the shard that keeps hanging

Three Cross-platform runs on #1279 ended `cancelled`. Each time shard
`test 2/4` (or `3/4`) runs normally, then stops emitting output entirely until
the runner kills it roughly 14 minutes later. Nothing fails.

The same pattern hit `dev` with no PR involved (`31259450263`,
`31259447622`) and cost #1288 two reruns before `rerun-failed-jobs` went green,
so the base branch has an unstable shard today. That is the likely answer.

I did not simply write "flake" on the PR and move on, because #1279 changes
process and identity lookups and a hang right after a proxy server starts is the
shape a blocking child-process call would take. What argues against it: the
hanging shard runs on Linux, where the `windows-*` modules should never be
reached. I have no Windows host, so I told the author exactly that — what the
evidence shows, what I cannot rule out, and the one concrete thing worth
checking (timeouts on lookups reachable during startup) — rather than either
dismissing it or implying their patch is at fault.

## The pattern across WP16

Four review rounds, and each one changed the answer rather than polishing it:

1. Whole-array reconciliation → resurrects a deleted provider's rows.
2. `routedSlug` as a row key → duplicates renamed rows. I had *read* the PUT
   route that mutates `modelId` and still reached for the slug, because the slug
   is what the catalog uses. Catalog identity and storage identity are different
   things.
3. "Exhaustive" writer matrix → missed every aliased binding, including the file
   that owns custom models.
4. All-or-nothing hold → wrong; defect 1 was bounded and shippable, and holding
   it gained nothing.

Plus two false public claims I had to retract on the issue: a wrong writer count
(13), then a differently wrong one (20 references, 16 writers).

The useful lesson is narrower than "review is good". Every one of these was a
claim I could have checked and did not, because the claim felt like background
detail rather than the thing being decided. The slug key and the writer count
were both stated in passing while my attention was on the reconciliation rule.
