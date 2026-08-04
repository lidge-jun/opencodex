# 040 — WP4: hardening round

Depends on WP2. Covers F2 (config overwrite), F3 verification, the adversarial review,
the full gates, and the live smoke. Audit fold-backs from `002` §6 and §8.

## H1 — protect `claudeCode` from service-time config overwrite (F2)

`src/config.ts`:

The snapshot is bound to the CONFIG INSTANCE, not a module global (002 R3-2): a
second `loadConfig()` elsewhere must not refresh the baseline that a long-lived
server config is judged against, or a later stale save would look like "our change".

```ts
/** Per-config-instance baseline; no cross-instance leakage. */
const claudeCodeBaseline = new WeakMap<OcxConfig, unknown>();

/** Called once where the long-lived server config is created (startServer). */
export function armClaudeCodeBaseline(config: OcxConfig): void {
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
}

export function saveConfigPreservingClaudeCode(config: OcxConfig): void {
  const onDisk = readRawConfigJson();            // literal file, no schema merge
  const armed = claudeCodeBaseline.has(config);
  if (armed && onDisk !== undefined) {
    const baseline = claudeCodeBaseline.get(config);
    const diskChanged = !deepEqual(onDisk.claudeCode, baseline);
    const weChanged = !deepEqual(config.claudeCode, baseline);
    if (diskChanged && !weChanged) {
      // Hand-edited while we ran and we have no own change to defend: their edit wins.
      config.claudeCode = onDisk.claudeCode as OcxConfig["claudeCode"];
    }
    // diskChanged && weChanged -> our change wins and the baseline rebases below.
    // Documented conflict policy; a three-way merge is out of scope (002 §6).
  }
  saveConfig(config);
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
}
```

**Arming is mandatory, not lazy** (002 R3-2): `startServer` calls
`armClaudeCodeBaseline(config)` immediately after it loads the config, so the FIRST
service save is already guarded. A lazy "arm on first save" would lose exactly the
edit made before that first save — the case the guard exists for.

`deepEqual` is a structural compare on the PARSED subtrees, not `JSON.stringify` —
key order must not decide whether a user's hand edit survives (002 §8).

**The guard cannot be per-writer** (audit R2-5). The decisive counterexample:
`model-routes.ts:226-227` changes only `disabledModels` and calls `saveConfig(config)`,
which serializes the WHOLE object (`config.ts:847-859`) — so an unrelated model toggle
clobbers a hand-edited `claudeCode`. Enumerating `claudeCode` mutators protects
nothing against that.

So the guard sits in **one save wrapper used by every service-time save**:
`saveConfigPreservingClaudeCode` becomes the entry point for routes and CLI commands
that hold a long-lived server config, including the writers the first list missed —
combo migration (`combo-routes.ts:164-182`) and CLI Desktop
(`claude-desktop.ts:117-119`, `:135-138`) — as well as the direct `claudeCode`
mutators (claude-code PUT, Desktop auto-apply `agent-settings-routes.ts:95-96`,
Desktop profile routes `:498-499`, `:510-511`, `:531-532`).

### The conversion is mechanical, and enforced (002 R3-2, widened by R4-1)

"Every service-time save" is a claim until something checks it. The boundary is
**every writer that saves a LIVE server config**, which round 4 showed is wider than
the management routes:

| Area | Examples |
|------|----------|
| Management routes | `model-routes.ts:127-128`, `:227`, `provider-routes.ts:112-119`, `combo-routes.ts:164-182`, the agent-settings writers |
| **Request-path runtime writers** | `providers/key-failover.ts:115` (429 rotation, reached from `server/responses/fetch-helpers.ts:68`), `providers/api-keys.ts:90`, `:101`, `:113`, `:131` |
| Running-service CLI commands | `cli/claude-desktop.ts:117-119`, `:135-138` |

The request-path case is the one that would have escaped: a 429 during an ordinary
turn rotates a key and saves the whole config, clobbering a hand-edited `claudeCode`
with no user action at all. Those helpers take the live config, so they take the
guarded saver the same way — either the wrapper directly or an injected saver, since
`key-failover.ts` already receives its dependencies as parameters.

Dynamic `await import("../../config")` forms count — a grep for a static import alone
would miss them.

Enforcement is a test, not a promise: `tests/config-save-boundary.test.ts` walks
`src/server/management/**` AND the runtime writers named above, asserting no live-config
module calls bare `saveConfig(` (the wrapper is the only permitted entry point) —
mirroring the writer-boundary test this repo already uses for the Grok fence. Startup
migrations (`src/server/index.ts`, `providers/*-startup.ts`) are the documented
exception: they run before the server serves requests, against a config nobody else
holds.

Explicitly **out of scope**: preserving non-`claudeCode` subtrees. A hand edit to
`providers` is still clobbered — the earlier "preserved naturally" claim was false and
is retracted. Widening the wrapper to reconcile the whole config is a separate unit;
this one records the residual and asserts it in a test so it cannot drift into an
assumed guarantee.

Edge semantics, chosen deliberately:

- WE changed the subtree in memory AND the user edited the file → our save wins and
  the snapshot updates (their next edit starts from the new baseline). A three-way
  merge is out of scope.
- File unreadable/missing at save time → behave as before (save what we have); never
  fail a save over protection.

Tests (`tests/config-user-edits.test.ts`, NEW):

- hand-edit `claudeCode` on disk while the service holds memory → guarded save keeps
  the hand edit;
- **the R2-5 integration case**: hand-edit `claudeCode`, then invoke an UNRELATED
  model-visibility PUT → the hand edit survives (this is the test that would have
  failed under the per-writer design);
- **first-save case (R3-2)**: hand-edit BEFORE the service's first save → the edit
  still survives, proving the baseline was armed at startup rather than lazily;
- **instance isolation (R3-2)**: an unrelated `loadConfig()` elsewhere does not
  refresh the server instance's baseline;
- **the R4-1 request-path case**: hand-edit `claudeCode`, then drive a 429 key
  rotation through `rotateKeyOn429` with the live config → the hand edit survives;
- in-memory change to `authMode` + disk edit → in-memory wins, snapshot rebases, and
  the NEXT hand edit starts from the new baseline;
- key-order-only difference on disk → treated as EQUAL (structural compare), so no
  spurious "external edit" branch;
- **TOCTOU seam**: an edit landing between the raw read and the atomic write is the
  known race; the injectable read/write seam drives it deterministically and the test
  pins the documented outcome rather than pretending it cannot happen;
- unreadable/missing file → save proceeds, no throw;
- a `providers` hand edit is NOT preserved (asserted, so the documented residual
  cannot silently drift into an assumed guarantee).

## H2 — F3 verification (settings.json env hijack)

No new defence in this unit — an honest coverage check instead:

- test that `buildClaudeEnv` with a host token emits `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  (exists) and that auto→proxy (host token present) also emits it — NEW case;
- document in the D summary that subscription mode carries no hijack defence by design
  (the flag without a token is F4), so the residual is a documented tradeoff, not an
  accident.

## H3 — adversarial review + gates + live smoke

- Independent reviewer on the whole unit's diff (a FRESH agent — the plan reviewer is
  contaminated by having authored the blocker list).
- Full gates: `bun run typecheck`, `bun run test`, `cd gui && bun run test`,
  `bun run lint:gui`, `bun run lint:i18n`, `bun run privacy:scan`.
- Live smoke (c-smoke) on THIS machine (auth present via S1 + S3):
  `bun src/cli/index.ts claude --version`-equivalent env dump — assert
  `ANTHROPIC_AUTH_TOKEN` is NOT injected and the mode resolves subscription.
  Absent case: fixture home (`HOME`-redirected deps in a unit test already; for the
  smoke, run the resolver against an empty temp home and show auto→proxy).
  Feedback-loop case: pre-set `ANTHROPIC_AUTH_TOKEN=opencodex-proxy` in the smoke env
  and show it is DELETED on the subscription resolution.

## D-phase record

`050_closeout.md`: terminal outcome, evidence per criterion, what did NOT improve
(LOOP-PESSIMIST-01) — expected residuals: F3 (subscription mode carries no
settings.json hijack defence by design, because the flag without a token is F4),
#488's non-`claudeCode` subtrees still unprotected, and the save TOCTOU window.
