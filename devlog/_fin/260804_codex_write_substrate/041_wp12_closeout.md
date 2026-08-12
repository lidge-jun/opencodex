# 041 — WP12 closeout: the call edge, and the decision that did not survive review

This document owns the last stretch of WP12: the runtime `AdmissionSnapshot`
producer, tri-state ownership, and the first production caller of
`withCodexWriteLock`. It also records a design decision that was refuted before
it was implemented, because the refutation is the more useful artifact.

## D1 — proposed, refuted, replaced

### What was proposed

`admitCodexWrite()` refuses on `generation` authority in any home that has never
had a cooperating config write, because `observeConfigGeneration()` returns
`unavailable` when `config-mutation.sqlite` does not exist
(`src/codex/generation.ts:149-156`, `src/config.ts:1872-1874`). That is not only
a fixture problem: a user whose `config.json` predates the coordinator database
would have every Codex write refused permanently.

The proposal was to widen `AdmissionSnapshot.generation` to
`{ present: boolean; value: number }`, admit `present:false` when the database is
absent, and treat that as matching only `present:true, value:0` under the lock.
The justification: `withConfigMutationLockSync` opens the database with
`create: true` and calls `initializeConfigGeneration`, which inserts the
singleton at 0 (`src/config.ts:1814-1822`, `src/codex/generation.ts:24-32`), so 0
is a positive fact rather than an assumed baseline.

### Why it is wrong

An independent reviewer that did not write the code refuted both halves, and both
refutations were then reproduced directly.

**The invariant is not enforced.** `withConfigMutationLockSync` is a generic
exported lock: it initializes the generation, invokes an arbitrary callback, and
commits without bumping anything (`src/config.ts:1805-1843`). A callback may
mutate `config.json` and leave the generation at 0. The recognized writers —
`saveConfig` (`:1923-1940`), `mutatePersistedConfig` (`:2011-2021`),
`saveConfigPreservingClaudeCode` (`:2275-2283`) — do bump, but the mechanism does
not require it. "Generation 0 proves no cooperating write happened" is a
statement about today's call sites, not about the lock.

**And the rule could never have matched.** On first acquisition the
`BEGIN IMMEDIATE` that creates the table is still uncommitted while
`withCodexWriteLock` calls `readAdmissionUnderLock()`, which opens a *separate*
read-only connection (`src/codex/codex-write-lock.ts:303-305`,
`src/codex/generation.ts:158-168`). A live probe:

```text
before lock, db exists = false
before lock, observe   = {"kind":"unavailable","reason":"database"}
INSIDE lock, observe   = {"kind":"unavailable","reason":"database"}
after lock, observe    = {"kind":"ready","generation":{"value":0}}
```

The under-lock re-read cannot see `value:0`, so `absent` would never have matched
its only permitted counterpart and **every first write would have been refused as
stale**. The proposed rule was not merely unsound in theory; it was inoperative.

A second probe confirmed what does already hold: a corrupt coordinator database
fails closed at the lock itself with `ConfigMutationLockError`, so nothing here
needs to re-derive that protection.

## D1' — the replacement

1. `ConfigGenerationObservation` gains `{ kind: "absent" }`, returned **only** for
   `ENOENT` from the initial `statSync`. Permission errors, `ENOTDIR`, an invalid
   schema version, and SQLite corruption all stay `unavailable/database`. Absence
   and corruption must not collapse.
2. The under-lock re-read takes the generation from the **already-open** `C`
   transaction handle, not from a fresh observer connection. This removes the
   visibility hazard entirely rather than working around it.
3. A pre-lock `absent` authorizes a write only when that in-transaction read
   returns exactly 0.
4. `configDigest` is the primary interference authority; the generation
   corroborates it. This inverts the earlier emphasis, which leaned on a counter
   the mechanism does not guarantee.
5. **`configDigest` must actually be a byte digest, which today it is not.**
   Round 3 caught the claim in item 4 being false as written: the digest hashes
   `JSON.stringify(config)` — the *parsed* object (`src/codex/admission.ts:141-144`)
   — because `readConfigDiagnostics()` throws away the raw text it just read
   (`src/config.ts:1727-1745`). A whitespace-only or key-reordering rewrite by a
   non-cooperating writer leaves that digest identical. Having demoted the
   generation to corroboration, item 4 moved the weight onto something that
   could not carry it.

   Admission does **not** get the raw bytes. `config.ts` keeps its single-read
   owner and hands back a digest computed there:

   ```ts
   // A union, not a nullable field. `{source:"file", contentSha256:null}` is a
   // state that cannot occur, so it must not be a state that can be WRITTEN —
   // refusing it at runtime is a check somebody can forget; making it
   // unrepresentable is not.
   export type ConfigAdmissionSnapshot =
     | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
     | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;
   export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot;
   ```

   One `readFileSync` into a Buffer, hashed exactly as read — BOM and whitespace
   included — then decoded once for `configDiagnosticsFromRaw`. No second read,
   so no torn read between them.

   Exporting `readConfigFileSnapshot()` instead would put `raw` in a caller's
   hands, and that string carries provider API keys and admission keys.
   `privacy:scan` would not catch it: it scans tracked source text from
   `git ls-files` (`scripts/privacy-scan.ts:51-67,187-229`), not runtime values.
   The raw-bearing helper stays private.

### The comparator, which D1' at first also omitted

A second audit round found that D1' fixed the SQLite visibility hazard and then
failed for a different reason one layer down. The lock compares
`authoritySnapshotId` byte-for-byte (`src/codex/codex-write-lock.ts:303-307`) and
the generation participates in that hash (`src/codex/admission.ts:173-184`), so
`{present:false}` and `{present:true,value:0}` still produce different IDs — and
every first write is still refused. Fixing the read direction was necessary and
not sufficient.

So the hash **canonicalizes the two into one authority token**:

```ts
// Absent and present-zero are the SAME authority: both mean "no committed
// cooperating write has happened". They must hash identically or the
// comparison refuses every first write. Any value >= 1 hashes as itself.
generationAuthority(g) = g.present && g.value > 0 ? `gen:${g.value}` : "gen:0"
```

Canonicalizing inside the hash is chosen over a special-case comparator beside
it, because a comparator that treats one field specially has to be reimplemented
at every future comparison site, and the one that gets forgotten is the one that
matters.

### Why exactly zero, and nothing else, is reachable

Once our `BEGIN IMMEDIATE` succeeds (`src/config.ts:1820`) no cooperating process
can create or bump concurrently — every generation mutation runs inside a SQLite
write transaction (`src/codex/generation.ts:110-122,176-185`). So after a pre-lock
ENOENT the in-transaction read can only be: 0 when nobody committed a bump
(including a creator that rolled back, and a creator that initialized without
bumping), or >= 1 when someone committed one. A competing holder makes our own
acquisition busy instead, and the callback never runs. Zero is therefore the only
value consistent with "no committed bump survived", which is exactly the claim
being made — and no more than that, which is why `configDigest` still carries the
byte-level authority independently.

### Consumers

`tests/codex-config-generation.test.ts:107-117` currently pins absence to
`unavailable/database`, and its comment states the reason: a caller that may only
look must not receive something it could mistake for a known-good zero. D1' pays
that debt rather than deleting it — the observer may report `absent`, but it is
promoted to a usable zero only after `C` is held and a real zero is read there.

`admitCodexWrite` is not the only consumer. `captureCatalogAdmissionSnapshot`
(`src/codex/catalog-admission.ts:141-144`) also reads the observation and formats
`generation.reason`, a field `absent` does not have — so it breaks at compile
time unless it gains an explicit branch. It keeps refusing on absence: WP9 gather
has no lock to promote an absence inside, so for that caller absence remains a
refusal and the widened union simply forces the case to be stated.

## D2 — ownership is tri-state, and the existing helper cannot supply it

`assertNativeTeardownOwned()` returns `{ ok: true }` when the service state file
is unreadable (`src/integrations/native/ownership-preflight.ts:31-34`). Failing
open is correct for a teardown route, whose own input being broken should not
wedge the route. Projecting that same answer into `ownership: "owned"` would turn
"could not be read" into "belongs to me" — the absence-as-guarantee defect this
unit has now found seven times.

So `inspectNativeCodexOwnership()` is added alongside, returning
`owned | foreign | unknown`, and unattended convergence refuses on both `foreign`
and `unknown` without creating any artifact. The teardown helper keeps its
fail-open behavior and its callers.

## The call edge

`withCodexWriteLock` has had zero production callers since it was written, which
is defect #10 of this unit and the reason WP11 was folded into WP12. A mechanism
with no consumer cannot be exercised except through a fabricated object.

`injectCodexConfig` (`src/codex/inject.ts:491`) is the edge. The naive reading —
"wrap the two `atomicWriteFile` calls" — is wrong, and the audit caught it:
**`writeJournal()` already runs at `:534`**, seventy lines before them, and it
performs an atomic write (`src/codex/journal.ts:69-90`). Wrapping only the tail
would leave the first artifact-creating write outside the lock, which is not
exclusivity; it is a shorter unprotected window.

Line numbers here track `origin/dev` at `468587632`, after #1022 and #1000
landed. They move; the anchors — `writeJournal`, the two `atomicWriteFile`
calls, `markJournalInjectedState`, and `runCodexHistoryJob` — do not.

The lock therefore opens **before `writeJournal`** (`:534`) and closes after
`markJournalInjectedState` (`:607`), covering the journal write, both
`atomicWriteFile` calls (`:605-606`), and the injected-state marking as one
section. Everything before that point in the function is classification and
refusal, which creates nothing. The awaited history job stays **outside**: it has
its own cross-process lock (WP10) and the `N -> H` order is deliberate.
Production reaches this function from `src/codex/sync.ts:58,110` and
`src/cli/init.ts:197`.

### What else lives inside that span

The span is wider than the three writes, and an audit caught me claiming
otherwise. PR #1022 (tri-state `fastMode`, now landed as `ebcfff44f`) changes two
call sites — `ensureFastModeFeature` at `:555` and `buildProfileFile` at `:603` —
and I argued they sat outside the lock because the first is "before the writes".
They are not: `writeJournal` opens the span at `:534` and both changed lines fall
after it.

The order still holds, with a different reason. Landing #1022 first is right not
because it avoids the section but because WP-R1c should be written against the
function's final shape rather than against a version about to change underneath
it. Both transforms are pure and bounded, so they compose inside the callback;
what would have been wrong is discovering that during implementation instead of
before it.

A second reviewer caught the sentence that stood here, which claimed nothing in
the span may be non-deterministic or IO-bearing. That is plainly false: the span
*is* the IO — journal writes, two atomic file replacements, and the marking that
follows them. The real constraint is narrower: nothing in the span may perform IO
the journal does not account for, because the restore path replays only what the
journal recorded.

`buildProfileFile` with an unset `fastMode` now emits different bytes, and that
stays safe because the journal captures the original profile before the write
(`src/codex/journal.ts:69-90`) and records the exact new one after
(`:93-107`); restore replays the captured original (`:128-141`). The comparison
is against what was actually written, not against what the generator would
produce today.

### The external-provider branch, and the fix that could not work

"Open the lock before `writeJournal`" does not cover the external-provider path
at all: that branch **calls `removeJournal()` at `:497` and returns at `:503`**,
never reaching `writeJournal`. `removeJournal` unlinks
(`src/codex/journal.ts:93-95`). The one path whose entire purpose is "someone
else owns this config, do not touch it" was performing an unguarded destructive
write.

The obvious repair — move the deletion inside the lock — was written here and
then refuted, because it is **internally impossible**. Admission refuses
external-provider, so no admitted snapshot exists; `withCodexWriteLock` requires
one. A refused admission cannot authorize a locked deletion. The sentence was
self-contradictory and survived a round only because nobody traced it.

Refusing outright is also a regression, and a user-visible one. Today the branch
returns `success: true` with preservation guidance (`src/codex/inject.ts:492-509`)
and `syncModelsToCodex` projects that straight into `ok` (`src/codex/sync.ts:56-70`).
Tests pin it: `tests/codex-inject-integration.test.ts:247-309,358-384` and
`tests/codex-sync-api.test.ts:227-263`. Turning it into a failure would take
`/api/sync` from 200 to 500 (`src/server/management/config-routes.ts:261-268`),
give `ocx sync` exit 1 (`src/cli/index.ts:840-846`), and turn `ocx init`'s
checkmark into a warning (`src/cli/init.ts:194-199`).

So the resolution is neither: the external-provider admission refusal maps to
the **existing successful no-op**, and the branch preserves config, profile,
history *and the journal*. The stale-journal deletion is a separate operation
needing its own authority contract, and it does not ride along inside a write
path that was never admitted. A6b therefore asserts the journal survives
byte-identical, which is the opposite of what this document said one round ago.

### Except the deletion is load-bearing, and measurement said so

"Preserve the journal" was the third wrong answer here, and only a probe
settled it. The restore path compares hashes before writing
(`src/codex/journal.ts:125-126`), which looks like it makes the deletion
redundant — an external provider owns different bytes, so the hash mismatches
and nothing is restored. That is true only for a **marked** journal.

`writeJournal` does not record `injectedConfigHash`; `markJournalInjectedState`
adds it afterwards. And `restoreJournalState` treats a MISSING hash as
"unchanged" (`!journal.injectedConfigHash || ...`), so an unmarked journal is
restored unconditionally. Measured, in a scratch home:

```text
journal written from native config, never marked
external provider takes over config.toml
restoreJournalState() -> configRestored:true
config after restore: model = "gpt-5"          *** CLOBBERED ***

same run, but marked first:
restoreJournalState() -> configRestored:false, configChanged:true
config after restore: model_provider = "someone-else"   PRESERVED
```

So the window the `:497` comment describes is real: a launcher that journaled
and was interrupted before marking leaves exactly the unmarked journal that
overwrites an external provider's config on the next `ocx stop`. Deleting that
call reintroduces the bug it was written for.

The deletion stays. What changes is that it is no longer the only thing standing
between a stale journal and someone else's config — but making the restore path
refuse an unmarked journal is a different unit's work, and pretending otherwise
by removing the guard now would be trading a real protection for a tidier
diagram.

`tests/codex-inject-integration.test.ts:281-308` already requires the removal,
so deleting the call would also have turned a shipped regression test red — a
cheaper signal than the probe, and one I should have looked for first.

## WP-R1c: superseded by the audit below

An earlier draft of this section resolved the Windows problem by branching on
`process.platform` — coordinate on POSIX, leave Windows on the legacy path. A
reviewer found the better answer, and it is recorded further down under
"wiring admission is a separate decision from taking the lock": the lock does
not need admission to GATE the call in order to hold the write section. Keeping
both would have left two incompatible designs in one document, so the platform
split is withdrawn rather than parked.

The four mechanical findings from that audit survive and are stated there: the
callback must publish or `assertPublished` throws with the files already
written; the under-lock generation comes from
`readConfigGenerationInCurrentMutationTransaction()`; `busy` cannot ride inside
`{success, message}`; and a failed first initialization leaves a coordinator
database that every later attempt refuses (`src/codex/transition-state.ts:384-424`,
`:282-290`) — recorded as out of scope with its own follow-up.
### The journal admission was hashing does not exist

`admitCodexWrite` records the journal at
`join(getConfigDir(), "codex-journal.json")` (`src/codex/admission.ts:120-121`),
but the real journal is `join(CODEX_HOME, "opencodex-journal.json")`
(`src/codex/journal.ts:6-9`). Different directory, different filename. So
`journalIdentity` was watching a path nothing writes, and would have reported a
serene `absent` while the actual journal was rewritten underneath the lock. The
test at `tests/codex-admission.test.ts:157-164` reproduced the wrong location,
which is how it stayed invisible: the fixture and the producer agreed with each
other and both disagreed with production.

This is the same failure the unit keeps finding, in a new place — a check whose
subject is not the thing being protected. `canonicalTargets.journal` becomes the
real path, and its test asserts against `journal.ts`'s own constant rather than
re-deriving the path by hand.

## Acceptance

| # | Claim | Evidence |
|---|---|---|
| A1 | A first write on a coordinator-less home SUCCEEDS end to end | **R1c.** Not merely that the callback returned: the lock must reach `assertPublished` and `commit`, with a pre-lock `absent` generation |
| A2 | BYTE interference is caught without any generation change | **R1d.** A whitespace-only rewrite — no semantic change, no bump — still refuses. Needs the admission gate; R1c refuses nothing |
| A2p | The PRIMITIVE that A2 rests on | **R1a.** A whitespace-only rewrite changes `contentSha256` and therefore `hashAuthority`, proven at the function level. R1a cannot reach `authority_not_proven` — that needs an admitted snapshot, which needs truthful ownership, which is R1b |
| A2b | Committed-bump interference is caught | **R1c.** A competing cooperating write between the witness and the commit yields `authority_not_proven` — this one is exclusion, not permission, so it lands with the lock |
| A3 | Absence is not corruption, at both layers | Only `ENOENT` reports `absent`; a corrupt DB refuses at the observer AND fails closed at lock open |
| A4 | Admission creates nothing and destroys nothing | A pre-seeded journal, config, profile, catalog, service-state and integration record all survive byte-identical; no `config-mutation.sqlite`; directory modes unchanged |
| A5 | Unknown ownership refuses on the OWNERSHIP authority | Generation warmed first so the run cannot be refused earlier for another reason; assert the exact authority |
| A6 | External provider is its own veto | With ownership proven `owned`, the refusal authority is `external-provider` |
| A6b | The external branch keeps deleting an UNMARKED journal, and that is correct | Measurement showed removing the call lets a stale unmarked journal overwrite an external provider's config; `tests/codex-inject-integration.test.ts:281-308` already requires the removal. The call still returns `success: true` with its preservation message |
| A6c | External provider wins even when ownership is UNKNOWN | With service evidence unavailable, the refusal is still `external-provider` — the message the user can act on — and every artifact EXCEPT the unmarked journal is preserved — A6b requires that one deleted, and "every artifact" contradicted it. A6 cannot catch this, because it proves ownership `owned` first |
| A7 | The lock has a live production caller | `rg` reachability PLUS a test that observes the lock being taken on the real `injectCodexConfig` path |
| A8 | The edge is exclusive across processes | A barrier held inside the acquired lock; the loser reports `busy` and its PROCESS-UNIQUE candidate bytes are absent from the final file, so the winner is provable rather than assumed |
| A9 | The apply section is inside, history is outside — scoped to what R1c actually locks, which is `writeJournal` through `markJournalInjectedState`; the external branch's journal deletion is a different surface and gets its own contract | An ordered trace showing journal write, config write, profile write and marking all between acquire and release, and the history job after release |
| A10 | `journalIdentity` tracks the real journal | The identity changes when `journal.ts` writes, asserted against an EXPORTED constant from `journal.ts` — `JOURNAL_PATH` is private today (`src/codex/journal.ts:8`), and a re-derived test path is how the current mismatch stayed invisible |

A1 additionally asserts the transition was **published**, not merely that the
callback returned; A2/A2b place the competing edit at a barrier *after* admission
and *before* acquisition, or the race proves nothing; A5 gains the two ENOENT
corroboration cases; A7 must observe the real lock rather than a spy.

Each acceptance row is tagged with the phase that can actually prove it. The
distinction between A2 and A2p is the one that took a round to see: R1a builds
the digest that makes byte interference *detectable*, but it cannot demonstrate
the *refusal*, because a refusal requires an admitted snapshot and admission
cannot honestly admit anything until ownership stops being hardcoded. Claiming
A2 in R1a would have meant proving it against the placeholder.

Every mechanism above gets a broken-change check: mutate it, watch the test go
red, restore, and confirm `git diff --stat` is empty. A green suite is not
evidence in this unit — roughly 8400 tests pass today beside the defects it
fixes. Each check is recorded by name — the mutation applied, the test that went
red, and the restored-clean confirmation — because an unrecorded mutation check
is indistinguishable from one that was never run.

## D2 — the tri-state, and why `null` is not one state

`readServiceInstallState()` returns `null` for a fresh machine with no service,
for an unreadable file, for invalid JSON, and for JSON that fails schema
validation alike (`src/service.ts:165-175`, schema at `:127-141`). Mapping `null`
to either pole is wrong in one direction or the other: call it `unknown` and
every fresh machine refuses; call it `owned` and a corrupt state file becomes a
licence to write.

So the distinction is drawn from the file evidence rather than from the parsed
result:

| Evidence | Ownership |
|---|---|
| Every known state path is ENOENT, **and no manager definition exists on disk, and no registration is loaded** | `owned` — no persistent service claim observed |
| Every known state path is ENOENT, but a manager definition exists, a registration is loaded, or either cannot be asked | `unknown` |
| Readable, valid, both homes match, **and any manager definition names the same homes, and the loaded registration matches that definition** | `owned` |
| Readable, valid, homes differ | `foreign` |
| Readable and valid, but a manager definition names DIFFERENT homes | `unknown` — an interrupted reinstall, not a decision to make unattended |
| Definition and state agree, but launchd/systemd is running an OLDER definition, or the registration cannot be read | `unknown` |
| Present but unreadable, malformed, or schema-invalid | `unknown` |
| Two valid states that disagree | `unknown` |
| A valid state beside an unreadable one | `unknown` |
| Two managers both proven present (Windows scheduler + WinSW) | `unknown` (`conflict` at the probe) |

`readServiceInstallState` cannot answer this: it returns the FIRST valid state
and discards every later path (`src/service.ts:165-175`), so a valid mirror
beside a corrupt one reads as clean. The projection needs an all-paths evidence
API that reports what each path said, not the first thing that parsed.

The "older definition" row is not hypothetical: `startLaunchd` already
distinguishes it and tells the user to `bootout` and reinstall
(`src/service.ts:1655-1667`). Disk and live can disagree, so reading the disk
definition alone leaves the same hole one layer in.

### What this table does NOT prove

`owned` here means **no persistent service claim was observed**. It does not
mean this process is the only writer: two foreground `ocx start` processes on
one home both read `owned`, correctly, because neither installs a service.
Exclusion between them is the write lock's job (WP-R1c), and deciding a
sequential takeover between different `OPENCODEX_HOME`s is provenance's job
under that lock. Reading this row as exclusivity would be borrowing a guarantee
from a phase that has not run.

### The race this cannot close

Admission re-reads under the lock, but `writeServiceInstallState` and the
definition writes (`src/service.ts:1610-1625`, `:2017-2021`) do not take that
lock, so a definition can appear immediately after the probe looked. Reading the
definition bytes twice around the registration check narrows the window and
detects an A-B-A, but detection is not prevention: closing it requires
install/uninstall/repair to take the same authority lock. That is a real
follow-up, recorded rather than papered over — the probe reports what it saw,
and does not claim the world held still while it looked.

Known paths and the current home pair come from `src/service.ts:82-107`, and
normalization from `:109-112`. The detailed inspection belongs in `service.ts`;
`inspectNativeCodexOwnership()` only projects it. `assertNativeTeardownOwned()`
is untouched at `src/integrations/native/ownership-preflight.ts:21-35` — its
fail-open behavior is correct for the teardown routes that call it.

The service-manager corroboration is the round-3 correction, and it is the same
defect one layer out: installs write state to both the current and the default
home (`src/service.ts:90-95,144-160`), so a mere `OPENCODEX_HOME` change is
already caught by the default mirror — but all-paths-ENOENT *also* describes a
machine whose state files were deleted while the service is still installed and
running. Reading that as `owned` would be absence-as-guarantee again, in the one
place where being wrong means writing over a live installation's home.

Round 4 then found that the probe this requires does not exist yet. Windows is
adequate — `schtasks` already returns `present|absent|unknown`
(`src/service.ts:761-788`) and WinSW treats only error 1060 as proof of absence
(`src/lib/winsw.ts:209-266`). macOS and Linux are not: `launchdJobMatchesPlist`
maps every failed `launchctl print` to `loaded:false` (`src/service.ts:577-600`),
and the systemd helpers collapse any command failure to empty
(`src/service.ts:2000-2042`). Both turn "could not ask" into "not installed",
which is the exact inversion this table exists to prevent. A new fail-closed
probe is needed:

```ts
export type ServiceManagerInstallation =
  | { kind: "absent" }
  | { kind: "present"; backend: "launchd" | "systemd" | "scheduler" | "winsw" }
  | { kind: "conflict" }
  | { kind: "unknown"; reason: string };
export function inspectServiceManagerInstallation(): ServiceManagerInstallation;
```

A sixth round replaced that shape too. `{ backend }` tells a caller which manager
answered, which is not the question either — the caller needs the homes the
definition names, so that comparing them is the projection's job rather than a
verdict the probe hands down:

```ts
type ServiceManagerClaim = {
  backend: "launchd" | "systemd" | "scheduler" | "winsw";
  definitionPath: string;
  homes: { codexHome: string; opencodexHome: string };
  registration: "present" | "absent";
};

type ServiceManagerInstallation =
  | { kind: "absent" }
  | { kind: "present"; claims: readonly [ServiceManagerClaim, ...ServiceManagerClaim[]] }
  | { kind: "conflict"; claims: readonly ServiceManagerClaim[] }
  | { kind: "unknown"; reason: string };
```

On Windows the "definition" is a chain, not a file. The task XML names only the
launcher (`src/service.ts:1450-1458`); the homes live in the batch wrapper it
eventually runs (`:1358-1366`). A probe that parsed the XML and stopped would
read a definition that mentions neither home and conclude they match by default.

### Registration is not the question; the definition is

A fifth round rejected that sketch, and the reason reframes the whole probe.
**Asking whether a job is currently loaded answers the wrong question.**

Installation writes the definition FIRST and the state file after
(`src/service.ts:1610-1625` on macOS, `:2017-2021` on Linux), and the definition
itself embeds `CODEX_HOME` and `OPENCODEX_HOME` (`:276-284`, `:1948`). So an
interrupted reinstall leaves a valid state file for home A beside an installed
plist for home B — and a probe that only asks "is a job loaded?" calls that
`owned`. Worse on macOS: a logged-out user has the plist on disk with no GUI
domain at all, so the registration probe reports nothing loaded while a foreign
definition sits right there.

The probe therefore reads the **definition**, and compares the homes inside it:

| Platform | Definition | Registration |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.opencodex.proxy.plist` (`:56-59`) | `launchctl print` |
| Linux | `~/.config/systemd/user/opencodex-proxy.service` (`:1935-1941`) | `systemctl --user show` |
| Windows | Task Scheduler XML / WinSW config | `schtasks /query`, `sc query` |

Absence requires BOTH: no definition on disk AND no registration. Either one
present, or either one unaskable, is not absence.

### Measured exit codes, and the one that is not a code at all

macOS distinguishes the two cases, verified against nonexistent targets rather
than assumed:

```text
launchctl print gui/<uid>/<no-such-label>  -> exit 113  "Could not find service ... in domain"
launchctl print gui/999999/<label>         -> exit 112  "Could not find domain for user"
```

113 is "definitely not registered in a domain that answered". 112 is "that
domain does not exist", which is refined further below — it is not simply
"could not ask", and the table in "Cannot ask is not one state" supersedes any
earlier reading of this paragraph.

`runLaunchctl` currently discards the numeric status and keeps only a boolean
(`src/service.ts:551-565`), so the probe needs a variant that preserves it —
classifying on stderr text alone would rest on output Apple does not treat as a
stable interface.

Linux does NOT signal through the exit code, which is the trap a code-based
design would have fallen into:

```text
systemctl --user show -p LoadState --value opencodex-proxy  ->  "not-found", exit 0
```

A missing unit exits **zero**. The value carries the answer and the exit code
carries only whether the question reached the bus. `LoadState` alone is also
insufficient — it is orthogonal to `ActiveState`, so the probe asks for
`LoadState`, `ActiveState` and `FragmentPath` together and calls absence only
when the unit is inactive AND has no fragment.

Those three still cannot tell whether the LOADED bytes match the file, which is
the systemd form of the stale-plist case. `NeedDaemonReload` is exactly that
signal, and this repository already documents it as "the systemd analogue of
launchd's stale-plist case" (`src/service.ts:2023-2031`) — writing the unit file
does not change what systemd has loaded until `daemon-reload`. So the query
includes it, and `yes` — or a value that cannot be read — is `unknown`.

### An unreadable definition is not a present one

`present` carries parsed `homes`, so an artifact that cannot supply them cannot
be `present`. A definition that exists but is unreadable, truncated, or dangling
maps to `unknown`, not `present` with the homes left blank or guessed. Blank
homes would compare equal to nothing and the projection would read them as
agreement.

### Every probe is bounded and read-only

`spawnSync`/`execSync`/`execFileSync` in this module carry no timeout
(`src/service.ts:533,551,631`), so a wedged service manager would block the
event loop. Each probe gets a short timeout, and a timeout maps to `unknown`
like any other unanswered question.

The allowlist is enforced by an injected runner that records executable and
argv: `print`, `show`, `/query`, `sc query` and nothing else. The user's proxy
is live under launchd, so a probe that could start, stop or reload anything is
not a probe. Asserting this from the source text is not enough — this unit has
already shipped a "fix" that was only a comment — so the test drives each verb
to a mutating one and requires the assertion to fail.

### Three ways this could pass while broken

Named by the audit, and each answered by a specific assertion rather than by
care:

| False pass | What the test must do instead |
|---|---|
| Inspect only disk definitions and miss a stale LOADED one | Assert the older-definition row: disk and live disagree, result is `unknown` |
| Parse the Task Scheduler XML and stop, never following it to the batch wrapper where the homes actually are | Assert the parsed `homes` against a fixture whose XML and wrapper name DIFFERENT homes |
| Mutation-test the fake argv the harness supplies rather than the argv production emits | The recorder observes the PRODUCTION probe's emitted argv; mutating the fixture must not be able to satisfy it |

### `conflict` is reachable

It is not decorative: Windows can have both a Task Scheduler registration and a
WinSW service proven present at once, a combination the existing code already
names (`src/service.ts:829`). The combinator states it rather than picking a
winner.

### Windows already wrote this down

`probeWindowsSchedulerTask` (`src/service.ts:766-788`) is the pattern, and its
own comment states the reason: "if both fail, returns `unknown` so callers can
fail closed instead of releasing locks." It tries the specific query, falls back
to a CSV listing, and only concludes absence when a listing succeeded without
the task in it. WinSW is equally careful — only error 1060 proves absence
(`src/lib/winsw.ts:209-266`).

So this phase does not invent a convention. It brings two platforms up to one
that already ships:

| Platform | Today | Why it is wrong |
|---|---|---|
| launchd | every failed `launchctl print` becomes `loaded:false` (`src/service.ts:594`) | permission denial, a bad domain, and a missing `launchctl` all read as "not installed" |
| systemd | `sh()` failures are swallowed by `catch` (`src/service.ts:2036-2043`) | no user bus reads as "nothing here" |
| Windows | `present \| absent \| unknown` | — |

`runLaunchctl` already returns `{ ok, stdout, stderr }` (`src/service.ts:551-565`),
so the evidence exists and is being discarded one layer up. The new probe keeps
it. `launchdJobMatchesPlist` itself is left alone: its callers want a boolean for
staleness diagnostics, and widening it would change behavior this phase has no
business changing.

### The probes may not touch the running service

`launchctl print`, `systemctl show`, `schtasks /query` and `sc.exe query` are all
read-only, and that is not incidental. This machine has a live proxy on port
10100 under launchd. A probe that started, stopped or reloaded anything to
determine installation would take down the user's running proxy to answer a
question about whether it exists.

### "Cannot ask" is not one state — the correction that saves fresh machines

A second reviewer found the flaw that would have made this change worse than the
bug it fixes. If every unanswerable probe returns `unknown`, and `unknown`
refuses, then **a fresh machine with no service manager reachable refuses every
Codex write** — headless macOS with no GUI domain, a container with no user bus,
a Linux box with no systemd at all. Those are ordinary environments, not
contested ones.

The escape is that not all silence is equal. Some failures prove the backend
*cannot exist here*, and that is positive evidence of absence rather than a hole:

**The disk artifact is consulted FIRST, on every platform, and it can only ever
raise the verdict.** A second audit round caught me applying that rule to
launchd and then reasoning about Linux as though a systemd unit were not also a
file. It is: `~/.config/systemd/user/opencodex-proxy.service`, written BEFORE
`daemon-reload`, `enable`, `restart` and the state file (`src/service.ts:1936,2017-2022`)
— the same ordering that makes the launchd plist outlive a failed install.

So "backend impossible" never overrides a residue on disk:

| Observation | Verdict | Why |
|---|---|---|
| unit file or plist present (or `lstat` fails for any reason other than ENOENT) | at least `present` | an interrupted install leaves it, and it activates on the next login or boot |
| `/run/systemd/system` missing AND no unit file | `absent` | systemd is not the init on this host and nothing is staged |
| `systemctl` missing while systemd IS the init, no unit file | `unknown` | the manager may hold a definition whose file was deleted; we merely cannot ask |
| not Linux at all, no unit file | `absent` | this backend has no installer here |
| `systemctl --user show` exits 0 with `not-found` | `absent` | the manager answered |
| `systemctl --user show` exits nonzero (bus unreachable) | `unknown` | a user manager may hold a unit we cannot see |
| `launchctl print` exits 113 | `absent` | measured on macOS 27.0: "Could not find service ... in domain" |
| BOTH `gui/<uid>` and `user/<uid>` answered 113, or are 112, AND no plist | `absent` | every domain that could hold it either answered "no such service" or does not exist |
| either domain exits 112 AND a plist exists | `unknown` | something is staged and we cannot see whether it is loaded |
| `/bin/launchctl` cannot be spawned on macOS, no plist | `unknown` | launchd is certainly running; we simply cannot query it |
| not macOS, no plist | `absent` | launchd does not exist here |
| not this platform's backend, no artifact | `absent` | that backend has no installer here |

The domain rows decide whether a fresh headless Mac works at all. An earlier
draft said 112 was always `unknown` while also claiming headless machines were
saved; both could not be true.

That reading was challenged on the grounds that a job loaded from a
since-deleted plist could survive, and it was settled by measurement rather than
argument. On macOS 27.0:

```text
launchctl print gui/<uid>/com.opencodex.proxy      -> 0    (live job)
launchctl print gui/<uid>/com.nonexistent.whatever -> 113  (domain answered: no such service)
launchctl print gui/999999/com.opencodex.proxy     -> 112
launchctl print gui/999999/com.nonexistent.whatever-> 112
launchctl print gui/999999                         -> 112  (no label at all)
launchctl print gui/<uid>                          -> 0
```

112 is an answer about the DOMAIN and does not depend on the label — querying
the domain with no service name at all still returns it. 113 is service-scoped
within a domain that answered. So the orphan-job case (a job still loaded after
its plist was removed) lands in the exit-0 quadrant, where the manager reports
it; it cannot hide behind a 112, because a domain that cannot be reached is not
running anything on our behalf.

**One domain is not enough**, and this took a third round to surface.
`gui/<uid>` and `user/<uid>` are independent domains with separate service sets:

```text
launchctl print gui/<uid>/com.opencodex.proxy   -> 0    (our live service)
launchctl print user/<uid>/com.opencodex.proxy  -> 113  (same label, absent there)
launchctl print user/<uid>                      -> 0    (that domain answers)
```

A GUI 112 therefore says nothing about a job loaded into the user domain. The
installer ships an Aqua LaunchAgent, so a user-domain job is atypical — but this
probe claims that no COMPETING installation exists, not that our own usual path
is clear. Both domains are queried.

### "I could not ask" is never "it is not there"

The rule that kept catching me across three rounds: a manager definition can
outlive the file it was loaded from, so a missing artifact plus an unanswerable
manager is not absence. Only two things prove absence without an answer — the
platform has no such backend at all, or the init system that would hold it is
demonstrably not running here. A `launchctl` that will not spawn on macOS, or a
missing `systemctl` while `/run/systemd/system` exists, is silence. Silence is
`unknown`.

`existsSync` is not sufficient for the artifact check. A dangling symlink or an
unreadable path answers "no" to it while still being residue, so the probe uses
`lstat` and treats every error EXCEPT `ENOENT` as `present`.

Measured rather than assumed. On macOS 27.0 the three launchd cases return 0,
113 and 112; on Linux `systemctl --user show -p LoadState --value` exits 0
printing `not-found` for a missing unit and exits 1 with "Failed to connect to
bus" when the bus is gone. Both platforms separate "answered no" from "could not
ask" by exit status, so neither depends on message parsing.

### `runLaunchctl` discards the number this needs

I wrote that the evidence "already exists and is being discarded one layer up".
That was wrong about launchd. `runLaunchctl` collapses `result.status` into
`ok: result.status === 0` (`src/service.ts:560-564`), so 113 and 112 arrive
indistinguishable. Depending on stderr text instead would mean parsing
undocumented, localizable output — exactly what this design says it avoids.

The result type gains `status: number | null`. Existing callers read `ok` and are
unaffected; `launchdJobMatchesPlist` keeps its boolean shape.

### Windows fails closed, and that is the honest answer

There is no backend-impossible escape on Windows: `schtasks` and `sc.exe` are
always present. On a locked-down host where the SCM query is denied and the
scheduler query cannot prove absence, ownership is `unknown` and automatic
convergence refuses.

That is accepted rather than worked around. The local scheduler XML is written
before registration (`src/service.ts:1700,1727`) and WinSW assets can outlive an
SCM registration that still exists (`src/lib/winsw.ts:219`), so neither is
authoritative — inferring absence from a generated file we wrote ourselves is
precisely the mistake this table exists to prevent. The refusal carries the
probe's reason so the user can act on it.

### The plist outlives the job

A second launchd hazard: the installer writes the plist BEFORE loading it and
writes service state only AFTER a successful load (`src/service.ts:1613-1629`).
An interrupted install therefore leaves a plist on disk, no loaded job, and no
state file — and a job-only probe calls that uncontested, while the plist will
load with foreign homes baked in at next login.

So the launchd probe reads BOTH: `~/Library/LaunchAgents/com.opencodex.proxy.plist`
on disk, and the loaded job. A plist present with no job is `present`, not
`absent`.

### `conflict` is reachable, and it is Windows

`conflict` is not decorative. The scheduler task and the WinSW registration can
both exist — the code already names that state (`src/service.ts:829`) and already
queries both because a failed backend switch can leave both installed
(`src/service.ts:2211`). Manager conflict overrides to `unknown` for admission:
two managers claiming one home is exactly the case where writing is unsafe.

Three more rows the first draft missed, all evidence loss rather than ownership:

| Case | Verdict |
|---|---|
| a valid state file beside a MISSING mirror | `unknown` — installs write every mirror (`src/service.ts:155`), so one missing is loss |
| manager backend disagrees with `state.backend` | `unknown` |
| scheduler and WinSW both present | `unknown` |

### External provider must be read first

Ownership currently runs before external-provider detection
(`src/codex/admission.ts:98-116`). Making ownership stricter would hand an
external-provider user an opaque `service-home` refusal instead of the actionable
"you pointed Codex somewhere else" message. Both reads are read-only and neither
depends on the other, so the external-provider check moves FIRST. Acceptance A6
as originally written could not have caught this, because it proves ownership
`owned` before testing the provider veto.

### The systemd probe may not edit the process environment

`ensureUserBusEnv()` repairs `XDG_RUNTIME_DIR` by mutating `process.env`
(`src/service.ts:1994`). Admission documents itself as read-only, and while an
environment variable is not a file, "reads only" that quietly rewrites its own
process is the kind of almost-true this unit keeps finding. The probe passes a
derived environment to the `systemctl` child instead.

## This is three work-phases, not one

Round 4's closing finding, accepted: the plan now spans three independent
failure domains, and combining them would make a failure in one impossible to
localize or revert.

| Phase | Owns | Regression surface |
|---|---|---|
| WP-R1a admission substrate | single-read byte digest, `absent` observation, transactional generation read, canonical hash, catalog consumer branch, real journal path | config read path, WP9 catalog admission |
| WP-R1b ownership evidence | detailed service-state reads, the new tri-state manager probe on three platforms, projection to `owned/foreign/unknown` | service diagnostics on every platform |
| WP-R1c production activation | the `injectCodexConfig` lock boundary and the two-process race. NOT the admission gate | the caller surface stays as it is |

Only WP-R1c can claim the lock has a production caller, and it depends on both
of the others. That dependency order was stated before the call-edge audit
found that wiring admission into production would refuse every Windows
injection — see the scope split below. WP-R1c needs WP-R1a's witness
primitives, not WP-R1b's ownership projection, which gates nothing here.

## WP-R1c, after its own audit: wiring admission is a separate decision from taking the lock

The plan for the call edge was "wrap `writeJournal` through
`markJournalInjectedState` and pass `admitCodexWrite` as the under-lock re-read".
An audit found five blockers, and two of them change what this phase may
attempt at all.

### The lock does not accept a callback that publishes nothing

`assertPublished` runs after the callback returns and throws unless the callback
called `ctx.coordinator.beginTransition(...)`
(`src/codex/codex-write-lock.ts:324`; the pattern is demonstrated at
`tests/codex-write-lock.test.ts:58-70`). Wrapping the writes and returning would
roll SQLite back **after** the files were already replaced — the worst of both,
since the filesystem does not roll back with it. The callback publishes the
transition explicitly, with the generation pair the lock just read rather than
an assumed `{0,null}`.

### Re-admission cannot be `admitCodexWrite`

Three reasons, each fatal on its own:

1. It reads the generation through the OBSERVER (`src/codex/admission.ts`), and
   the observer cannot see a first-use initialization that has not committed —
   the measured fact this unit already paid for. Under the lock the generation
   must come from `readConfigGenerationInCurrentMutationTransaction`.
2. It returns `CodexAdmission`, a union; the lock's `readAdmissionUnderLock`
   returns `AdmissionSnapshot` unconditionally
   (`src/codex/codex-write-lock.ts:86`). A fresh refusal has nowhere to go.
3. Its ownership arm shells out. `readAdmissionUnderLock` runs with N **and** C
   both held (`:303`), and the module's own contract forbids subprocesses
   underneath the callback (`:18`). On macOS that is up to two 2-second probes
   holding both locks.

That argument was written before the scope split, and the split makes it
irrelevant: WP-R1c does not gather manager evidence at all. Ownership is not
observed in this phase, so nothing is gathered before N and nothing of the kind
is revalidated under it. The split applies only to the WP-R1d gate, where the
expensive manager probe runs before N and only cheap, stable evidence is
revalidated under the lock — honest there because service installation is not
something config bytes can change mid-operation.

### Wiring admission into `injectCodexConfig` NOW would break Windows and some Linux

The probe returns `unknown` for Windows unconditionally, by design, because its
definition chain is not walked yet. Linux returns `unknown` with no reachable
user systemd bus. Unattended convergence refuses on `unknown` — correctly — so
wiring admission into the production path today refuses **every Windows
injection that works right now**.

That is not a defect in the probe or in the refusal rule. It is the phase order
being wrong: the lock can take the write section without admission gating the
call. So WP-R1c does exactly that, and the admission gate becomes its own
phase behind the Windows chain walk.

| WP-R1c does | WP-R1c does NOT |
|---|---|
| Give the lock its first production caller | Gate `injectCodexConfig` on `admitCodexWrite` |
| Publish the transition from inside the callback | Refuse on `unknown` ownership in production |
| Prove exclusion with a two-process race through the real entry point | Change what `ocx start` / `ocx sync` / `/api/sync` return today |

The snapshot the lock needs is still real — built from the same config bytes and
generation — but it authorizes the WRITE, not the DECISION to write. Turning it
into a gate is a user-visible behavior change and gets its own audit.

### That answer was wrong, and the reason is worth keeping

I argued the snapshot was not decorative because the lock throws
`CodexWriteLockStaleAdmission` when the two authority IDs differ
(`codex-write-lock.ts:305`) — so it answers "is the world I looked at still
there", which is a real question even without a gate.

The audit showed the snapshot cannot answer even that one here.
`configDigest` hashes the persisted **`config.json`** (`admission.ts:190`), while
the bytes this operation is about to write are derived from the native
**`config.toml`** and the `port` it was called with (`inject.ts:492`). Neither
is in the hash. Two contenders injecting DIFFERENT ports produce the SAME
`authoritySnapshotId`, so the staleness check passes while the thing that
actually differs is invisible to it.

Reusing `AdmissionSnapshot` also drags in `ownership` and `externalProvider`,
which this phase deliberately does not gate on. Carrying them through both
hashes unchanged proves nothing and makes them look load-bearing.

So WP-R1c gets its own witness, over the inputs that determine THIS mutation:

Enumerating the inputs was the wrong shape and a third round showed why: the
list was already incomplete. `InjectCodexOptions` carries `catalogPath`
(`inject.ts:72`), whose `undefined` case triggers filesystem-dependent
resolution (`:469`), and the emitted bytes also depend on the passed `config` —
`hostname`, websockets, subagent defaults, injection model and effort
(`:556`, `:574`) — which may differ from the persisted `config.json` entirely.
Any such list invites the next omission.

So the witness hashes the **computed candidate bytes** rather than the inputs
that produced them:

| Field | Source |
|---|---|
| candidate config bytes | the exact string about to be written to `config.toml` |
| candidate profile bytes | the exact string about to be written to the profile |
| native input identity | sha256 of the `config.toml` bytes read at `:492` |
| persisted identity | `contentSha256` + generation |
| effective catalog path | the RESOLVED value, not the raw option |
| canonical targets | config, profile, journal paths |
| journal identity | as today |

Hashing the output closes the class instead of the instance: an input that
changes the bytes changes the hash whether or not anyone remembered it.

`hashAuthority` keeps `ownership` and stays as it is — WP-R1d needs it. This is
a second, narrower hash for a narrower claim, not a weakening of the first.

### The transforms move above the journal write

Hashing the candidate bytes and opening the lock before `writeJournal` are in
tension as written: `content` and `profileContent` are not final until `:599-600`,
seventy lines AFTER the journal write the span is supposed to contain. At
acquisition time the witness would have nothing to hash.

The resolution is to hoist, not to shrink the span. Everything between `:534` and
`:600` is string transformation — verified, no `writeFileSync`, `mkdirSync`,
`unlinkSync` or rename anywhere in it. The one filesystem touch is
`chooseCatalogPathForInjection`, which calls `existsSync` on the catalog paths
(`:469-478`): a read, of files `writeJournal` does not touch. And `writeJournal`
is called with `configContent` supplied (`:530-533`), so it never rereads
`config.toml` — it snapshots the baseline it was handed plus the current profile
(`journal.ts:69-82`).

So nothing in the hoisted region depends on the journal write having happened,
and the journal write does not depend on anything the region produces. Order
becomes:

1. compute the candidate bytes,
2. hash the witness over them,
3. acquire N (and C),
4. recompute the witness under the lock and compare,
5. publish, then `writeJournal` through `markJournalInjectedState`.

Shrinking the span to `:600` instead would put the journal write back outside the
lock, which earlier rounds established as the hole this phase exists to close.

### What the callback publishes

```text
beginTransition(
  { nativeGeneration: ctx.expectation.nativeBefore, currentTxId: ctx.currentTxId },
  { txId: ctx.expectation.txId, direction: "apply",
    authoritySnapshotId: <the witness ID above>, nextRetryAt: <now, ISO> },
)
```

Every expected value comes from what the lock already read — `ctx.currentTxId`
exists precisely because guessing `null` passes on a fresh machine and fails on
a real one. The call goes BEFORE the filesystem writes so a rejected transition
costs nothing, and **its result is checked immediately**: `beginTransition`
returns a `conflict` rather than throwing (`transition-state.ts:339`), so
ignoring the return would write every file and only then have `assertPublished`
reject.

`direction` is `"apply"`; the external-provider branch returns long before this
point.

#### The history operation the row cannot hold

I wrote here that the Worker "derives its operation from admitted intent". That
is false, and the audit caught it. The parent sends `request.operation` in the
message (`history-job.ts:178`) and the Worker executes that value
(`history-worker.ts:104-110`). The durable row stores only `apply|remove`
(`convergence-types.ts:293`), so it cannot reconstruct which of `skip`,
`apply-opencodex` or `migrate-openai` was scheduled.

That is a real gap and it is NOT closed by wording. Two honest options were
offered here, and the audit rejected the second as unimplementable —
`beginTransition` unconditionally writes the schedule fields
(`transition-state.ts:111-120`), a positive row without a complete schedule is
rejected (`:210-219`), and `BeginCodexTransitionNext` requires `nextRetryAt`
(`convergence-types.ts:308`). "Publish the transition and defer the schedule"
is a sentence the API does not permit.

So WP-R1c records the operation it actually dispatches, and it CAN, because the
operation is derived deterministically from the caller's own intent:
`deriveCodexHistoryOperation({ direction, resumeHistory, legacyMode })`
(`history-job.ts:84-92`). The caller has all three inputs when it builds the
witness, so the exact operation is known at publish time — it is not a value
that only exists later. The row stores what the caller already decided, not a
direction with a guessed operation beside it.

That is the resolution of the durable-schedule question: not "defer it" (the
API forbids it) and not "widen the row" (nothing needs widening — the operation
is derivable from the inputs already present). It is recorded as the schedule
the transition actually launched.

That last claim was wrong on both counts, and a fifth round found both.

The operation is derivable at publish time, but derivable is not persistable:
the schema has `history_direction` and no operation column
(`transition-state.ts:63`), and `BeginCodexTransitionNext` has no operation
field (`convergence-types.ts:308`). Supplying it means widening the row, the
type, and the API — which this phase now owns.

And the second is worse, because it is a defect TODAY, not only in this phase's
scope: `updateCodexHistoryTransition` has **no production caller**, so a
completed or skipped history job leaves the row permanently `pending`. The
transition is published and never resolved. WP-R1c publishes the terminal
result after the job returns, so the row reflects what actually happened —
which is the first time that claim is true.

### The migration and the terminal update, made explicit

The widening is not a bump-and-forget. `initialize()` rejects any nonzero
version it does not recognize (`transition-state.ts:282-285`), so a version
bump alone would refuse every existing database.

| Existing row | Handling |
|---|---|
| v1, generation zero | migrate to v2 with `operation = NULL` — nothing was ever scheduled |
| v1, positive generation | the operation is unknowable from `direction` alone, so preserve it and refuse unattended use as legacy-ambiguous, never guess |
| new rows | `operation` is required and non-null; accepting null here would just preserve the defect this exists to close |

And the schema rejects impossible pairs — `direction:"apply"` with
`operation:"restore-openai"` is not a state a well-formed transition can be in,
so the CHECK says so rather than letting it through to be misread later.

The terminal update is its own CAS, not a blind write. The acquired callback
returns a receipt — the generation and txId it just committed — and that is
what `updateCodexHistoryTransition` is given after the job, inside its own
short N transaction (`transition-state.ts:569`). No second witness is needed:
the compare-and-swap on generation and txId already prevents a job that was
overtaken from overwriting the winner.

Every outcome is handled, because a `busy` that is ignored is the "pending
forever" defect wearing a different name:

| `updateCodexHistoryTransition` result | Action |
|---|---|
| `updated` | terminal recorded |
| `conflict` | a newer transition won; do not overwrite it |
| `unavailable / busy` | bounded retry; a busy terminal CAS cannot record itself, so on exhaustion the previously persisted `pending` schedule is preserved and the failure is reported observationally (`record-write-failed`), per `005_contract.md:277` |
| `unavailable / database or unsafe-path` | surfaced as a failure, not retried into a wall |

An earlier version of this section proposed recording the exhausted retry as
`blocked` with `db-busy`. That cannot work — the terminal update itself takes
`BEGIN IMMEDIATE` (`transition-state.ts:570`), which is the resource that was
busy — and it contradicted the contract this unit already audited in WP8b. The
preserved-`pending` rule is the existing answer, and this phase adopts it
rather than inventing a second one.

### The outcome-to-state mapping

The mapping is not reinvented here. It is the one
`020_history_isolation.md:564-572` already defines, applied rather than
restated, because an earlier attempt to restate it produced several wrong rows
at once:

- busy → `pending / db-busy` with a next retry, not `blocked`
- permission/refusal → `blocked / permission`
- unreadable DB/manifest → `unknown / unreadable`, null counts
- unsupported schema/shape → `unknown / schema`, null counts
- watchdog → `unknown / timeout`
- graceful cancellation → `unknown / shutdown-cancelled`
- Worker error, malformed terminal IPC, or early close → reread durable state,
  then `unknown / worker-died`
- superseded identity or a terminal-CAS conflict → a typed `overtaken` result,
  with no self-retry by the loser
- terminal N update failure → `unknown / record-write-failed`, pending work
  preserved — a Worker error is not the same event

#### A boundary this phase has to widen

Three gaps, not one, and the audit found the second and third after the first
was written down. The parent today handles only `message` and `error`
(`history-job.ts:157-172`).

1. **An unrecognised message type is ignored** until the watchdog reports
   `timeout` (`:153`), so a dead Worker and a slow one are classified alike.
2. **An early Worker close is not listened for at all.** Bun exposes `close`
   and `messageerror`; the parent subscribes to neither, so a Worker that dies
   without erroring still surfaces as `timeout`.
3. **A malformed message with a RECOGNISED type is not validated.**
   `{requestId, type:"done"}` with nothing else reaches an unchecked cast and
   reads as `converged` with undefined fields — the worst outcome, because it
   reports success for work that may not have happened.

So the parent validates `HistoryWorkerResult` fully — matching `requestId`
AND `jobId`, and the payload fields each type requires — and subscribes to
`close` and `messageerror` as death signals alongside `error`. Each of the
three is a small change; the point is that they are three, and the durability
claim needs all of them.

The tests that hold it down are named, because the Worker always closes after
posting its result (`history-worker.ts:160`) — so a `close` handler that
overturned a valid success would turn every completed job into a reported
death:

- a malformed message with a RECOGNISED type is rejected, not cast;
- an unrecognised type is a death signal, not silence;
- `messageerror` and an early `close` classify as `worker-died`;
- a terminal message followed by a normal `close` leaves the success intact —
  the last case is the one that proves the new handler did not learn to lie.

Two facts that stay true regardless of which row applies:

- `converged.rows`/`files` are mutation counts (`history-worker.ts:140-146`),
  not the durable counts — `pendingRows`/`backupEntries` come from the final
  probe (`history-provider.ts:756`);
- a `skip` deliberately performs no probe, so it stores NULL counts rather
  than manufacturing a zero-looking one (`005_contract.md:272-275`).

Two correctness rules follow from the same round:

- the operation is computed ONCE, before acquisition, included in the witness,
  and passed verbatim to both the publication and `runCodexHistoryJob`.
  Re-deriving it after the awaited acquisition would let a mutable
  `config.syncResumeHistory` diverge between what was scheduled and what ran;
- the acceptance criterion reads the COMMITTED row and asserts the stored
  operation equals the single value passed to the job, with table cases over
  `skip`, `apply-opencodex` and `migrate-openai` — and a test that swapping the
  dispatched operation fails, so a row that claims one thing while running
  another cannot pass.

The failure mode a test must not satisfy: asserting `native_generation` and
`direction` while ignoring `history_status`, `nextRetryAt` and the schedule,
which would pass on a row that claims nothing real.

#### A failed write between the two files

If the profile write throws after the config write landed, the exception leaves
the callback, C unwinds, and N rolls back (`codex-write-lock.ts:327`). The row
is clean — and the first file is already replaced. SQLite does not roll back a
filesystem.

This is not fixed by moving `beginTransition`. It is what the journal is for:
the journal is written FIRST, inside the same section, precisely so a partial
apply is recoverable. The callback compensates before rethrowing, and the test
that proves it injects a fault between the two writes — including on a
re-injection where the journal is already marked, which is the case a
fresh-journal fixture would miss.

### The minimum a race child must seed

Smaller than it would be with the gate, because ownership is no longer observed:

- a temp `CODEX_HOME` with a clean native `config.toml`
- a temp `OPENCODEX_HOME` with a valid `config.json`
- no routed residue and no pre-existing malformed coordinator — initialization
  refuses those (`transition-state.ts:268`)
- `catalogPath: null` and `syncResumeHistory: false`, so the race is about the
  native section rather than catalog and history fixtures
- a DIFFERENT port per child, which is what makes the winner identifiable
- a barrier inside the acquired section, and a zero-deadline loser

No service-state or manager fixture: this phase does not look at ownership.

### Ways this could still pass while broken

| False green | Answered by |
|---|---|
| Both contenders publish the same authority ID because port and native bytes are absent from the hash | The witness above; a test asserting two ports produce two IDs |
| Publication passes only because `currentTxId` was assumed null | Pre-seed a nonzero transition before the race |
| Final `config.toml` names the winner while the profile, journal or transition row belongs to the loser | Assert all four agree on one process |
| A direct lock-holder child proves contention but never runs production injection | The child calls `injectCodexConfig` |
| A pass-through mock satisfies "the lock was called" | The race is the proof, not the spy |
| A fault after the first file replacement rolls N back and leaves partial files | Fault injection between the two `atomicWriteFile` calls |

### A rolled-back row is not a rolled-back filesystem

Publication goes first so that a failure to publish costs no file writes. But the
converse needed saying out loud, and an audit had to say it: if publication
succeeds and then `atomicWriteFile` throws, `withCodexWriteLock` rolls the
coordinator transaction back (`codex-write-lock.ts:327-342`) and the row
correctly stops claiming a transition — while the files that already renamed stay
renamed. Each `atomicWriteFile` is atomic by itself, never across the journal,
config and profile together (`src/config.ts:193-235`).

Three reachable middles:

| Fails at | Left behind |
|---|---|
| profile write | journal + config changed, old profile |
| journal marking | config + profile changed, journal unmarked |
| any of them | coordinator row rolled back, so nothing records it |

The unmarked-journal case is the one with teeth, because an unmarked journal is
restored unconditionally — the same property measured earlier in this document.

So the callback compensates rather than assuming the rollback covered it: on any
failure inside the artifact sequence, restore from the journal before rethrowing,
check whether the restoration actually completed, and if it did not, report
partial native state as partial. Calling that a clean rollback would be the
tidier and less true description.

A publication test with no injected failure at each write boundary proves none of
this.

### The external deletion still races the admitted write

`removeJournal()` on the external branch (`inject.ts:492-497`) stays — measurement
proved it necessary — but it is not serialized against N. The lock re-reads
authority once before invoking the callback (`codex-write-lock.ts:303-315`), so a
provider change after that point lets a second `injectCodexConfig` enter the
external branch and delete the journal the first callback just wrote. The result
is an injected config and profile with no recovery journal.

A9 is therefore narrowed to the ADMITTED APPLY SECTION rather than claiming the
whole native surface, and this race is recorded as an open safety residual. Fixing
it needs a reduced journal-cleanup authority that can contend with native writes
without pretending an external provider admitted a transition — its own phase,
not a line in this one.

### The snapshot this needs is not an `AdmissionSnapshot`

"Use the snapshot without gating on it" reads well and does not typecheck as a
design. `admitCodexWrite` refuses before it ever constructs a snapshot unless
ownership is `owned` (`src/codex/admission.ts:131-140`), so every snapshot it
produces carries `ownership: "owned"` — the field cannot hold `unknown` at all.
Bypassing the producer leaves no way to build one; not bypassing it makes the
call gated. There is no third path through the current types.

And copying the value would not help. Ownership is in the authority hash
(`admission.ts:237-248`) and the lock compares only that hash
(`codex-write-lock.ts:303-307`), so a pre-lock `unknown` copied verbatim into the
under-lock read matches itself and detects nothing. Re-observing it properly
means running the service-manager subprocess while N and C are held, which is
exactly the cost this phase set out to avoid.

So the coordination this phase needs is a DIFFERENT type with a different
producer:

- name it for what it is — a write-coordination observation, not an admission —
  and do not call its field `admitted`;
- its comparison id contains only evidence that can be independently re-read
  under N and C: config bytes, generation, journal and profile identities;
- ownership travels as recorded context, not as a hashed verdict, unless it is
  genuinely re-observed;
- `CodexAdmission` stays what it is, the later fail-closed policy, and the gate
  phase projects observation into admitted or refused.

Reusing `AdmissionSnapshot` and `readAdmissionUnderLock` while skipping admission
would move the untruth from the control flow into the names.

### Compensation cannot just call `restoreJournalState()`

Calling it under N is lock-order safe — it takes neither N nor C, only writes
files (`src/codex/journal.ts:118-150`) — but it restores whatever journal
currently occupies the shared path, and that need not be the one this operation
wrote. A failed journal write leaves the older journal; a re-injection legitimately
leaves an existing one. Compensation would then "succeed" while restoring a
baseline from some earlier day.

Two acceptable shapes: bind the journal to `ctx.expectation.txId` so compensation
only acts when the current journal is still ours, or capture exact pre-images of
config, profile and journal before mutating and restore those. A blind call is
neither.

### Failed compensation must THROW

If the callback returns a partial-state result normally, the lock proceeds to
`assertPublished` and commits (`codex-write-lock.ts:324-326`) — recording a
completed apply over incomplete artifacts, which is the precise outcome this
phase exists to prevent.

So: compensation succeeded, rethrow the original failure. Compensation failed,
throw a typed partial-write error carrying content-free surface status. Either
way N rolls back, and `injectCodexConfig` maps the error to a structural outcome
OUTSIDE the lock. No path returns normally after an artifact write failed.

### Publishing `apply` while intent is OFF contradicts the contract

`ConvergeRequest` states it outright: the caller says when, never which way, and
direction derives from persisted intent (`convergence-types.ts:179-200`). But
`injectCodexConfig` is imperative apply, and explicit `ocx sync` and `/api/sync`
reach it with no desired-state gate — only startup has one
(`desired-state.ts:148-160`). Hashing `intent: "off"` and then publishing
`direction: "apply"` claims conformity this does not have.

The honest resolution for this phase: WP-R1c coordinates a LEGACY IMPERATIVE
APPLY, and its observation excludes convergence intent rather than carrying a
field it then contradicts. Making injection obey persisted intent is the gate
phase's job, and it is a user-visible behavior change that needs its own audit.

### Outcomes stay structural

`busy` and `refused` differ by `retryable` (`codex-write-lock.ts:68`), and
flattening both into `success:false` throws that away. `/api/sync` answers **503 with `Retry-After`** for contention while a permanent
refusal stays a permanent refusal. 503, not 409: the canonical contract already
fixed that (`005_contract.md:1776-1788`), and a draft here said 409 — one
document cannot hold two status codes for one condition. Prose in a message field cannot carry that.

Likewise the external-provider branch: `applied.ok` currently drives a
`state:"current"` response saying routing goes through opencodex
(`src/server/management/native-integration-routes.ts:263-265`), which is false
for a preserved external provider. That needs a structural
`preserved-external`, not a boolean — recorded here, and out of scope for this
phase.

### The five-second timeout was wrong too

A legitimate holder can exceed it before any contention exists: Windows ACL
hardening inside each atomic write is bounded by a budget that reaches 60
seconds (`src/lib/windows-secret-acl.ts:224`). The acquisition timeout must
bound waiting for a *contended* lock, not the section itself, so it is set
against the observed cost of the section rather than against how long a CLI
"feels" hung. History's numbers are deliberately different — `H` fails fast,
the state DB waits 5s, the Worker has a 30s watchdog — because they bound
different things, and forcing them equal would be tidiness, not correctness.

## Deferred, with issues rather than silence

Three things leave this unit as issues rather than as silence:

| Issue | What it covers |
|---|---|
| [#1048](https://github.com/lidge-jun/opencodex/issues/1048) | WP13 composed acceptance — every production entry point funnelling through the substrate, not each helper passing its own test |
| [#1049](https://github.com/lidge-jun/opencodex/issues/1049) | Adopting pre-substrate routed homes into the coordinator |
| PR #998 | WP14 itself; the PR is the deliverable, so a separate issue would only duplicate it |

The middle one was not planned. Implementation found it: `assertInitialStateCanBeCreated`
cannot seed a coordinator row over routed bytes, which describes every install
predating this substrate, so gating injection on the lock would have broken
re-injection for all of them. Its design already exists at `005_contract.md:709-779`.


WP13 (the composed acceptance suite, `050_composed_acceptance.md`) and WP14 do
not land here. They become GitHub issues so that `dev` carries an honest record
of what is proven and what is not: the lock's production edge is demonstrated by
a real two-process race, but the composed suite that would exercise every entry
point together is still outstanding.
