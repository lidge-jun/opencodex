# 070 — urgent incident: restore provider config and prevent test fixture persistence

One emergency PABCD cycle inserted before WP6 after a real user configuration was
replaced by a unit-test fixture.

## Evidence and root cause

- The live `/Users/jun/.opencodex/config.json` was recreated at 2026-07-31 07:27:42,
  size 874 bytes, with one provider (`openai`).
- Its distinctive payload — custom model id `existing-uuid`, provider `deepseek`, model
  `deepseek-v4`, plus the five DeepSeek disabled slugs — matches the fixture in
  `tests/catalog-input-modality-enum.test.ts` exactly. This is not a plausible user
  configuration coincidence.
- The latest recoverable snapshot
  `config.json.invalid-2026-07-29T00-43-54-907788Z` is 41,380 bytes, parses cleanly
  under the current code in an isolated `OPENCODEX_HOME`, and contains 10 providers
  plus 3 embedded Codex accounts.
- Credential stores survived: `auth.json` contains 8 provider families and
  `codex-accounts.json` contains 32 account records. The incident is config loss, not
  token-store deletion.
- `handleModelRoutes` receives a fixture `config` object, but its mutation branches call
  the process-global `saveConfigPreservingClaudeCode`, which writes the real
  `OPENCODEX_HOME`. The test passed `deps: {}` and therefore persisted its fixture to
  the user's file.

## Plan

MODIFY `src/server/management/context.ts`:

- add optional `saveConfigPreservingClaudeCode(config)` to `ManagementApiDeps`.

MODIFY `src/server/management/model-routes.ts`:

- derive one `persistConfig` function from the injected dependency or the production
  default;
- route every config write in this module through it, including dynamic-import sites;
- production behavior is byte-identical because the default remains the same function.

MODIFY `tests/catalog-input-modality-enum.test.ts`:

- inject a no-op persistence dependency. The route is under test, not filesystem
  persistence; no test may write outside its fixture scope.

Runtime recovery (not committed):

1. preserve the contaminated 874-byte file as a timestamped incident snapshot;
2. restore the latest verified 41KB snapshot to `config.json` with mode 0600;
3. restart only `com.opencodex.proxy` so it reloads the restored bytes;
4. verify the management API reports all 10 providers and the two credential-store
   counts/sizes are unchanged;
5. run `ocx sync` only after the service reports the restored provider set.

## Acceptance criteria

1. Running `tests/catalog-input-modality-enum.test.ts` leaves a sentinel real config
   byte-identical.
2. All model-route mutation sites use injected persistence; no direct global save
   remains in `model-routes.ts`.
3. Focused tests and typecheck pass.
4. Restored service reports the 10 provider ids from the verified snapshot.
5. `auth.json` and `codex-accounts.json` remain intact (8 provider families / 32 account
   records, values never printed).
6. The contaminated file remains recoverable as an incident snapshot.

## Terminal outcomes

- DONE: code fix landed, config restored, service and focused tests verified.
- BLOCKED: snapshot fails parse/load or restored service still reports one provider.
- UNSAFE: only a secret-bearing file without a verified parse remains as a recovery
  source.

---

# P-phase amendment: the injection seam is not enough (2026-07-31)

Recovery is verified: disk and the live service both report the 10 providers again,
`auth.json` still holds 8 provider families and `codex-accounts.json` 32 accounts, and
the contaminated file is preserved as `config.json.incident-clobbered-20260731-072742`.

The user's requirement is stronger than "fix this file": this must never happen on
anyone else's machine. A survey of the real tree shows the injection seam alone does
not deliver that.

## Why the seam alone fails

Seven management route modules call the process-global writer directly, in ~25 places:

| Module | Direct global save sites |
|---|---|
| `agent-settings-routes.ts` | 96, 199, 350, 385, 413, 482, 524, 593, 605, 626, 937 |
| `provider-routes.ts` | 124, 166, 302, 431, 448 |
| `config-routes.ts` | 214, 341, 377 |
| `oauth-account-routes.ts` | 308, 460, 468 |
| `combo-routes.ts` | 188, 209 |
| `logs-usage-routes.ts` | import at 13 |
| `shared.ts` | import at 13 |

And 12 test files call management handlers with NO `OPENCODEX_HOME` isolation:
`memory-watchdog`, `codex-catalog`, `management-api-logs-metrics`, `opencode-cli`,
`autostart-health`, `cursor-hardening`, `sidebar-routes`, `system-restart`,
`native-model-toggle`, `windows-tray`, `startup-action-control`, and the fixture
`tests/fixtures/provider-outbound-e2e.ts`.

Retro-fitting a `deps` seam into 25 call sites and 12 test files is both large and
fragile: it protects only the paths someone remembered to convert, and the 26th call
site written next month is unprotected again. That is the same class of defect, not a
fix for it.

## The actual fix: fail closed at the single choke point

`getConfigDir()` (`src/config.ts:958`, resolving through `resolveConfigDir` at :411) is
the sole path source for ALL THREE stores that matter — `config.json` (`saveConfig`),
`auth.json` (`src/oauth/store.ts:32`), and `codex-accounts.json`
(`src/codex/account-store.ts:17`). One guard there covers every writer, present and
future, regardless of which route or test reaches it.

NEW `src/lib/test-home-guard.ts`:

```ts
/**
 * Under a test runner, writing the developer's REAL OpenCodex home is always a bug.
 * A management-route unit test once persisted its fixture over a live 41KB provider
 * config, wiping ten providers on a real machine (devlog 260730.../070).
 *
 * The guard fails CLOSED and lives at the single path choke point, so it protects
 * config.json, auth.json and codex-accounts.json for every present and future
 * writer — no per-route opt-in to forget.
 */
export function assertNotRealHomeUnderTest(dir: string): void
```

Semantics, chosen so it cannot become a nuisance that someone disables:

1. Inert unless a test runner is detected (`process.env.BUN_TEST`/`NODE_ENV=test`/
   `JEST_WORKER_ID`, plus an explicit `OCX_TEST_HOME_GUARD=1` escape for CI shells).
2. Under test, throw only when the resolved dir equals the DEFAULT real home
   (`~/.opencodex` with no `OPENCODEX_HOME` set). A test that sets `OPENCODEX_HOME`
   to a temp dir is untouched, which is why 17 already-isolated suites keep passing.
3. The message names the offending test's obligation and the two fixes (set
   `OPENCODEX_HOME` to a temp dir, or inject persistence), so the next person is
   taught rather than blocked.

MODIFY `src/config.ts`: call the guard inside `getConfigDir()`.

MODIFY `bunfig.toml`: `preload` a test setup file that sets a temp `OPENCODEX_HOME`
by DEFAULT for every test process, so isolation is opt-out instead of opt-in. This is
the belt to the guard's braces: even a test that never heard of the guard writes to a
throwaway directory.

NEW `tests/helpers/isolated-opencodex-home.ts`: the `installIsolatedOpenCodexHome()`
twin of the existing `installIsolatedCodexHome()`, for suites that need to control the
home explicitly.

## Revised acceptance criteria

7. With the guard active, a deliberate write attempt against the default real home
   under a test runner THROWS; the same write with `OPENCODEX_HOME` set to a temp dir
   succeeds. Both directions asserted (activation evidence, not a green suite).
8. The full `bun run test` suite passes with the preload active, proving the default
   isolation does not break the 17 suites that already manage their own home.
9. A sentinel check proves the real `config.json` is byte-identical before and after a
   full suite run.
10. Production behavior is unchanged: outside a test runner the guard is inert, and
    `ocx` continues to read and write the real home normally.

---

# A-phase fold-back (reviewer verdict FAIL, 1 Critical + 1 High)

An independent terra reviewer failed the amendment above. Both blockers are accepted
and reproduce against the real tree; this section is the FINAL design and supersedes
the amendment wherever they disagree.

## Blocker 1 (Critical, accepted) — never infer "test" from ecosystem variables

The amendment activated on `BUN_TEST` / `NODE_ENV=test` / `JEST_WORKER_ID`. But
`NODE_ENV=test ocx ...` is an ordinary inherited shell environment, not proof that the
process is a test. A real user with that variable exported would have their OpenCodex
throw on startup — strictly worse than the incident being fixed, because it fails for
someone who did nothing wrong.

Verified while folding back: the generated launchd plist emits only `OCX_SERVICE` and
`PATH` (plus the homes), and no source file reads `NODE_ENV`/`BUN_TEST` today. That
makes the risk latent rather than active — which is exactly when it is cheapest to
design out.

FINAL: the guard arms on ONE dedicated, repo-owned variable that nothing but our own
test preload sets:

```ts
const TEST_HOME_GUARD_ENV = "OCX_TEST_HOME_GUARD";
```

`BUN_TEST`, `NODE_ENV`, and `JEST_WORKER_ID` are explicitly NOT consulted. A variable
only our preload writes cannot be inherited into a user's `ocx` by accident, and the
failure mode of a missing variable is "guard inert" — the pre-incident behavior, never
a broken CLI.

## Blocker 2 (High, accepted) — guard writes, not reads; `getConfigDir` is the wrong seam

Two independent defects in one placement:

1. `getConfigPath()` does NOT go through `getConfigDir()` — it calls `resolveConfigPath()`
   directly (`src/config.ts:962` → `:419`). Tests already write that path directly
   (`tests/azure-adapter.test.ts:86`, `tests/config-user-edits.test.ts:26`,
   `tests/combos.test.ts:115`), so a future test that unsets `OPENCODEX_HOME` would walk
   straight past the guard. The claimed choke point does not hold.
2. `getConfigDir()` is on read paths (`loadConfig` at `:1114`) across 106 call sites. A
   READ of the real home under test destroys nothing; only WRITES did. Guarding reads
   buys no safety and adds failure surface.

FINAL placement — the three write functions that own the three stores that matter:

| Store | Guarded writer |
|---|---|
| `config.json` | `saveConfig` (`src/config.ts:1283`) |
| `auth.json` | `persist` (`src/oauth/store.ts:133`) |
| `codex-accounts.json` | `persist` (`src/codex/account-store.ts:98`) |

Each calls `assertNotRealHomeUnderTest(getConfigDir())` as its first statement, before
any `mkdirSync`/`chmodSync`/write. These are the exact writers the incident traversed,
and they are write-only, so no read path changes behavior.

## Defense in depth, and the honest limits

The guard is the second line. The FIRST line is the bunfig test preload that gives every
test process a temp `OPENCODEX_HOME` by default — that is what protects the stores the
guard does not wrap (`usage.jsonl`, `artifacts/`, service tokens, quota cache, and the
rest the reviewer enumerated), because those all resolve from the same home the preload
redirected.

Stated plainly rather than papered over:

- The preload sets `OPENCODEX_HOME` only when it is ABSENT, so the 17 suites that manage
  their own home keep working (both inspected suites snapshot the value at module load
  and restore it per test).
- One temp home per test PROCESS is safety isolation, not per-suite isolation. Suites
  sharing a process still share that directory; this fix stops the real home from being
  clobbered, it does not make every suite hermetic.
- Nothing here protects stores outside the OpenCodex home — `CODEX_HOME`, Claude Desktop
  config, shell rc files. Out of scope for this incident, named so nobody assumes
  coverage that does not exist.

## Revised acceptance criteria (supersede 7-10 above)

7. With `OCX_TEST_HOME_GUARD=1` and no `OPENCODEX_HOME`, each of the three writers
   THROWS; with `OPENCODEX_HOME` pointed at a temp dir, each succeeds. Both directions
   asserted per store — activation evidence, not a green suite.
8. With the guard variable UNSET, a write to the default home succeeds. This is the
   production-safety assertion: it proves the guard cannot fire for a real user, and it
   must run in a temp home so it never touches the developer's real config.
9. Full `bun run test` passes with the preload active.
10. The real `config.json` is byte-identical (sha256) before and after a full suite run.

---

# A-phase fold-back round 2 (verdict FAIL, 1 Critical + 1 Medium)

Second audit round, same reviewer. Both blockers accepted and reproduce. This section
is the FINAL design and supersedes everything above where they disagree.

## Blocker 1 (Critical, accepted) — an inherited custom home reopens the whole incident

The round-1 design had the preload set `OPENCODEX_HOME` "only when ABSENT" and the guard
fire only for the DEFAULT home. A developer who exports a custom
`OPENCODEX_HOME=/their/real/home` — a fully supported production setup
(`src/config.ts:411-416`, deliberately preserved by the service at `src/service.ts:275-280`)
— then runs `bun test`, and BOTH controls stand down: the preload preserves their value,
the guard sees a non-default path. The fixture lands in their real home. That is the
exact incident, on someone else's machine, which is the thing the user asked to make
impossible.

This is the load-bearing correction of the whole unit, and it inverts the preload's rule.

FINAL preload semantics — **replace unconditionally, never preserve**:

```
// The preload OWNS OPENCODEX_HOME for the test process. It always points at a fresh
// temp dir, whether the variable was absent, or set to a developer's real custom home.
// "Only fill when absent" is what would let `OPENCODEX_HOME=/my/real/home bun test`
// destroy a live config — the incident this unit exists to prevent.
process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-test-home-"));
```

Suites that need a specific directory keep setting it AFTER preload, exactly as the 17
already-isolated suites do today; their behavior is unchanged because they overwrite the
value themselves.

FINAL guard semantics — **the guard no longer special-cases the default path**. Under
`OCX_TEST_HOME_GUARD=1`, a write is allowed only when the resolved home is inside the OS
temp directory; any other home (default OR custom) throws. This is what makes the guard
meaningful for the custom-home user rather than a default-path-only tripwire.

```ts
export function assertNotRealHomeUnderTest(dir: string): void {
  if (process.env.OCX_TEST_HOME_GUARD !== "1") return;   // inert in production
  if (isInsideTempDir(dir)) return;                      // isolated temp home: allowed
  throw new Error(/* names the offending home + the two fixes */);
}
```

Sentinel test required: preload REPLACES an inherited custom `OPENCODEX_HOME`, proven by
writing a sentinel file into a fake "real" custom home before the suite and asserting it
is untouched after.

## Blocker 2 (Medium, accepted) — criterion 8 could not prove what it claimed

Criterion 8 asked for "a write to the default home succeeds" while also demanding the test
"run in a temp home". Those are mutually exclusive: the default is selected only when
`OPENCODEX_HOME` is absent. As written it would either write the developer's real config
or prove nothing about production inertness.

Split into two assertions that are each honest and neither of which touches a real home:

- **8a (production inertness, no filesystem mutation):** with the guard variable unset,
  call `assertNotRealHomeUnderTest(<default home path>)` DIRECTLY and assert it does not
  throw. Pure function call on a path string; nothing is written.
- **8b (writers still work):** with the guard unset and `OPENCODEX_HOME` at a temp dir,
  exercise each of the three real writers and assert success.

## Residuals, now genuinely acceptable

The reviewer's own condition: per-process isolation, direct `getConfigPath()` test writes,
and out-of-home stores are acceptable residuals for this incident ONLY because the preload
now forcibly redirects an inherited home. With unconditional replacement, a direct
`getConfigPath()` write in a future test resolves to the temp home too — so the bypass the
round-1 design left open is closed by the preload rather than by the guard.

Sidecar writers (`.invalid-*`, `.pre-multiauth`, `.bak` migration snapshots) stay
unguarded by design: they never overwrite the three primary stores, and this incident's
recovery depended on exactly those snapshots existing.

## Final acceptance criteria (supersede all earlier lists)

1. Preload replaces an INHERITED custom `OPENCODEX_HOME`; sentinel file in a fake real
   custom home is byte-identical after a suite run.
2. Guard armed + non-temp home (default AND custom, both cases) → each of the three
   writers throws.
3. Guard armed + temp home → each of the three writers succeeds.
4. 8a: guard unset → `assertNotRealHomeUnderTest(defaultHome)` does not throw, no write.
5. 8b: guard unset + temp home → all three writers succeed.
6. Full `bun run test` green with the preload active.
7. Real `config.json` sha256 identical before and after a full suite run.

---

# A-phase fold-back round 3 (verdict FAIL, 2 Critical) — FINAL DESIGN

Round 3 found the two defects that make this unit actually correct, and the second one
reframes the whole fix. Both accepted.

## The reframing: the isolation already exists; the incident bypassed it

`scripts/test.ts` — what `bun run test` invokes (`package.json:40`) — ALREADY builds a
fully isolated environment: a temp root with `HOME`, `USERPROFILE`, `OPENCODEX_HOME` and
`CODEX_HOME` all redirected, cleaned up afterwards (`createIsolatedTestEnvironment`).
Under `bun run test` this incident could not have happened.

The incident happened because a bare **`bun test <file>`** was run directly — the exact
command an agent or a developer reaches for when iterating on one file. That path gets no
`scripts/test.ts` wrapper and therefore no isolation at all.

So the correct fix is not a new mechanism competing with the old one: it is to move the
EXISTING isolation into a bun `preload`, which every invocation honors — `bun run test`,
bare `bun test`, and a single-file `bun test tests/foo.test.ts` alike. The guard then
exists only as a tripwire for the case where isolation was somehow defeated.

## Blocker 1 (Critical, accepted) — "inside OS temp" is not a safe predicate

A lexical prefix check accepts `<tmp>/link` where `link` symlinks to a real home, and can
falsely reject valid homes across the macOS `/var` ↔ `/private/var` aliasing (verified
locally: `mkdtemp` returns `/var/folders/...` while its realpath is `/private/var/folders/...`).

FINAL: the guard does not authorize "the temp directory" at all. It authorizes only roots
the test harness itself REGISTERED:

```ts
// The preload registers the root it created; explicit helpers register theirs.
registerTestHomeRoot(root: string): void      // stores realpathSync.native(root)

// Allowed iff the candidate canonically resolves INSIDE a registered root.
// realpath both sides (killing /var vs /private/var and any symlink escape), then
// require relative(root, candidate) to be neither "" -> escaping ".." nor absolute.
```

For a not-yet-existing candidate, canonicalize its nearest existing parent instead. This
is symlink-safe by construction rather than by string shape.

## Blocker 2 (Critical, accepted) — deleting `OPENCODEX_HOME` falls back to the real `HOME`

Round 2's inverted preload is defeated by tests that DELETE the variable outright
(`tests/key-failover.test.ts:47-49`, `tests/config.test.ts:37-40`) and then write through
`getConfigPath()` directly (`tests/config.test.ts:48-52`, `tests/config-user-edits.test.ts:24-26`).
With the variable gone, `resolveConfigDir()` falls back to `homedir()/.opencodex` — the
developer's REAL home. Since suites share a process, one file's delete can expose another
file's direct write.

FINAL: the preload replaces `HOME`/`USERPROFILE` as well, reusing
`createIsolatedTestEnvironment` from `scripts/test.ts` rather than reimplementing it. Then
the fallback path is a temp home too, and deleting `OPENCODEX_HOME` becomes harmless — no
test needs rewriting, which is what makes this fix hold for code nobody has written yet.

## Final design (supersedes every earlier design section)

1. NEW `tests/preload.ts`: calls `createIsolatedTestEnvironment()`, assigns every key of
   its `env` onto `process.env` (`HOME`, `USERPROFILE`, `OPENCODEX_HOME`, `CODEX_HOME`),
   sets `OCX_TEST_HOME_GUARD=1`, and calls `registerTestHomeRoot(root)`.
2. MODIFY `bunfig.toml`: `preload = ["./tests/preload.ts"]` under `[test]`, alongside the
   existing `root = "tests"` pin.
3. NEW `src/lib/test-home-guard.ts`: `registerTestHomeRoot` + `assertNotRealHomeUnderTest`
   with the realpath-containment predicate above; inert unless `OCX_TEST_HOME_GUARD=1`.
4. MODIFY the three writers to call the guard first: `saveConfig` (`src/config.ts:1283`),
   OAuth `persist` (`src/oauth/store.ts:133`), account `persist` (`src/codex/account-store.ts:98`).
5. `scripts/test.ts` keeps its wrapper (belt and braces; the preload is idempotent).

## Final acceptance criteria

1. Bare `bun test tests/catalog-input-modality-enum.test.ts` — the exact command that
   caused the incident — leaves the real `config.json` sha256 unchanged.
2. Guard armed + a non-registered home (default AND custom) → all three writers throw.
3. Guard armed + the registered temp home → all three writers succeed.
4. Guard unset → `assertNotRealHomeUnderTest(<default home>)` does not throw; no write.
5. Symlink escape: a path inside a registered root that symlinks OUT is REJECTED.
6. `/var` vs `/private/var` aliasing: the same temp home written both ways is ACCEPTED.
7. Deleting `OPENCODEX_HOME` mid-test resolves to a temp `HOME`, never the real one.
8. Full `bun run test` green; real `config.json` sha256 identical before and after.

---

# A-phase fold-back round 5 (verdict FAIL, 1 Critical) — LOCKED DESIGN

Accepted. This was the hole I flagged in my own round-4 design, and the reviewer
confirmed it independently. It is now closed, and the design is locked.

## Blocker (Critical, accepted) — the deny target must be captured BEFORE isolation

The closing predicate computed the real home as `join(homedir(), ".opencodex")` at call
time. But the preload replaces `HOME`/`USERPROFILE` first, and `resolveConfigDir()`
derives its fallback from `homedir()` at call time too (`src/config.ts:411-416`). So
after preload, `homedir()` IS the temp root: the guard would deny `<temp>/.opencodex` —
a path nothing wants to write — while leaving the developer's actual `~/.opencodex`
unprotected. The guard would be perfectly inverted, and criteria 2 and 4 would assert
against the wrong path while looking green.

Verified empirically before folding (bun 1.3.14, macOS):

```
HOME inherited            -> homedir() = /Users/jun
HOME replaced pre-process -> homedir() = /var/folders/.../ocx-homeprobe-...
os.userInfo().homedir     -> same temp path (NOT an escape hatch)
HOME mutated in-process   -> homedir() = /Users/jun   (cached at startup)
```

The last line is the subtle part: mutating `process.env.HOME` inside a running process
does NOT move `homedir()`, but the `bun run test` wrapper sets `HOME` in the CHILD's
environment, so a wrapped run starts with `homedir()` already pointing at the temp root.
Both paths must therefore be handled by capture, not by reading `homedir()` later.

## Locked design for the deny target

```ts
// src/lib/test-home-guard.ts
//
// The production default home, captured ONCE at module load — before any test harness
// replaces HOME/USERPROFILE. Read from OCX_REAL_HOME when the harness captured it for
// us (the wrapped `bun run test` path already starts with HOME rewritten, so homedir()
// is useless there), otherwise from homedir() at load time.
const PROTECTED_HOME = canonicalize(
  join(process.env.OCX_REAL_HOME?.trim() || homedir(), ".opencodex"),
);
```

Ordering obligations, both required:

1. `scripts/test.ts` sets `OCX_REAL_HOME` to the ORIGINAL `homedir()` in the child env it
   builds, before it overwrites `HOME`/`USERPROFILE`. That is the only place the true
   home is still visible on the wrapped path.
2. `tests/preload.ts` captures the value FIRST — importing the guard module (which snaps
   `PROTECTED_HOME` at load) before calling `createIsolatedTestEnvironment()` — so the
   bare `bun test` path captures the real home before it is replaced.

`canonicalize` is `realpathSync.native` on the path, falling back to its nearest existing
parent when the path does not exist yet, applied identically to both sides of the
comparison. That covers a symlinked real home, unset/empty `HOME`, and Windows
`USERPROFILE`, since `homedir()` is evaluated once before any replacement.

`PROTECTED_HOME` is never recomputed from mutable `process.env` afterwards.

## Criteria 2 and 4, corrected

Both must assert against the CAPTURED pre-preload home, not a recomputed one:

- **2:** guard armed + `PROTECTED_HOME` → all three writers throw.
- **4:** guard unset + `PROTECTED_HOME` → no throw, no write (pure predicate call).

A test proves the capture itself: with `HOME` pointed at a temp dir at process start and
`OCX_REAL_HOME` set to a distinct sentinel path, the guard must protect the SENTINEL, not
the temp path. Without that assertion this Critical could silently regress.

Criteria 1, 3, 5-8 are unchanged and already mechanically checkable.

---

# A-phase fold-back round 6 (verdict GO-WITH-FIXES, 1 High) — A-GATE CLOSED

Accepted. The audit loop converged: 2 Critical → 2 Critical → 1 Critical + 1 Medium →
1 High → 1 Critical → 1 High, each round finding strictly narrower defects, and this
last one is about how to PROVE the fix rather than about the fix itself.

## Blocker (High, accepted) — the proof must not touch the real home either

Criterion 2 asked the three writers to throw against `PROTECTED_HOME`. But the public
entry points do real filesystem work BEFORE reaching the guarded private `persist`:
`saveCredential()` acquires `auth.store.lock`, creating and hardening the directory and
writing lock metadata (`src/oauth/store.ts:297-301`, `:151-155`), and
`saveCodexAccountCredential()` loads and hardens the real file first
(`src/codex/account-store.ts:80-82`, `:121-134`). Running that criterion literally would
chmod real secrets and create a real lock file before observing the intended throw —
violating this unit's own rule that the proof never writes a real home.

FINAL: prove the deny with a SENTINEL, not with the developer's actual home.

```
Criterion 2 (revised): in a CHILD process with OCX_TEST_HOME_GUARD=1 and
OCX_REAL_HOME=<temp sentinel>, point OPENCODEX_HOME at <temp sentinel>/.opencodex and
call each of the three writers. Each throws. Nothing outside the temp sentinel is
touched, and the assertion is exactly as strong: PROTECTED_HOME is captured from
OCX_REAL_HOME by the same code path the real run uses.
```

This is why the `OCX_REAL_HOME` capture hook earns its keep twice: it makes the wrapped
`bun run test` path correct, and it makes the deny-path testable without ever aiming a
writer at a real home.

Criterion 1 stays the only assertion involving the real home, and it only READS
(sha256 before/after). Criterion 4 is a pure predicate call with no IO.

## Scope note recorded, deliberately not fixed here

The reviewer's alternative — move the guard earlier, into the public mutation entry
points, so lock acquisition and directory hardening are also refused — is a genuine
hardening improvement and is NOT rejected on merit. It is out of scope for this incident
because the incident route was `saveConfig`, and widening the guard into OAuth locking
and account-store loading during an urgent fix trades a data-loss fix for new failure
surface in credential paths. Recorded here as the follow-up it is, rather than silently
dropped.

## A-gate verdict

All blockers from six rounds are folded. Remaining residuals are named and accepted:
per-process (not per-suite) isolation; the guard protects the captured default home
rather than arbitrary hand-typed real directories; sidecar backup writers stay unguarded
by design because this incident's recovery depended on them existing; the earlier-guard
hardening above is deferred. Proceeding to B.

---

# A-phase fold-back round 4 (verdict GO-WITH-FIXES, 1 High) — CLOSING DESIGN

Accepted, with a narrower fix than the reviewer proposed. Reason recorded because the
difference matters.

## The blocker is real

A registered-roots-only allowlist rejects legitimate fixtures. Suites routinely
`mkdtemp` their own directory, point `OPENCODEX_HOME` at it, and call a guarded writer
without registering anything: `tests/oauth-accounts-api.test.ts:41`,
`tests/management-provider-validation.test.ts:167`,
`tests/provider-connection-test.test.ts:17`, `tests/config.test.ts:34`. Measured scope:
**54 test files call `saveConfig`.** Criterion 8 (full suite green) could not pass.

## Why not the proposed fix

The reviewer's remedy — migrate every such suite onto a registering helper — is rejected
as the primary mechanism on two grounds:

1. **Scope.** Rewriting fixture setup across 54 files during an urgent incident fix is a
   large, mechanical, review-heavy change with its own regression risk. This unit's job
   is to stop data loss, not to refactor the suite.
2. **Fragility — the same defect class.** An allowlist that must be opted into fails
   OPEN for anything nobody remembered to convert. The 55th file written next month is
   unprotected, which is precisely the failure shape that caused this incident.

## Closing design: deny the real home, allow everything else

Invert the predicate. The guard does not try to enumerate legitimate test homes; it
recognizes the ONE thing that is never legitimate under a test runner:

```ts
// Deny-list of exactly one path: the real user home OpenCodex would use in production.
// Any other home — a suite's raw mkdtemp, the preload's root, a fixture dir — is fine.
// This fails CLOSED for new code: a future test writing the real home is rejected
// without registering, opting in, or knowing this guard exists.
function realHomeCandidates(): string[] {
  return [join(homedir(), ".opencodex")];   // realpath-normalized
}
```

`registerTestHomeRoot` is DROPPED — no registration, no migration, no per-suite opt-in.
Symlink safety is retained where it matters: both the candidate and the real-home path
are canonicalized with `realpathSync.native` (nearest existing parent when the candidate
does not exist yet) before comparison, so a temp path symlinked at the real home is still
caught, and the macOS `/var` ↔ `/private/var` aliasing cannot cause a false verdict.

What this trades away, stated honestly: the guard no longer objects to a test writing
some OTHER real directory (say a hand-typed `/tmp/../Users/...` path). That was never the
incident, and the preload's `HOME` redirect already covers the realistic fallback route.
The guard's job is narrow and absolute: **the user's real OpenCodex home is untouchable
while tests run.**

## Also folded from round 4

- **Preload cleanup:** the preload registers `process.on("exit", ...)` to `rmSync` ONLY
  the root it personally created. The `bun run test` wrapper keeps owning its own root
  (double isolation is kept deliberately; the preload never infers or reuses an existing
  environment from pathnames, which would trust user-controlled state).
- **Preload frequency:** asserted rather than assumed — the preload records its PID so a
  test can verify one root per process instead of relying on undocumented behavior.
- Import path confirmed sound: `tests/test-runner.test.ts:4` already imports
  `createIsolatedTestEnvironment` from `../scripts/test`, the `import.meta.main` block
  does not run on import, `tsconfig` builds only `src`, and `[test].root` governs
  discovery rather than resolution.

## Closing acceptance criteria (supersede round 3's list)

1. Bare `bun test tests/catalog-input-modality-enum.test.ts` leaves the real
   `config.json` sha256 unchanged.
2. Guard armed + the REAL home path → all three writers throw.
3. Guard armed + any temp home (raw `mkdtemp`, unregistered) → all three writers succeed.
   This is the criterion that proves the 54 existing suites keep working.
4. Guard unset → the real-home path does not throw; no write performed.
5. Symlink: a temp path that canonically resolves to the real home is REJECTED.
6. `/var` vs `/private/var` spelling of the same temp home is ACCEPTED both ways.
7. Deleting `OPENCODEX_HOME` mid-test resolves under the preload's temp `HOME`.
8. Full `bun run test` green; real `config.json` sha256 identical before and after.
