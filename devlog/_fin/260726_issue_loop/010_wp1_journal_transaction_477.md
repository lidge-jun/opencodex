# 010 — WP1: journal snapshot refresh (issue #477)

Background, call graph, and rejected alternatives: `001_research_journal_lifecycle.md`.
This document is the implementation design.

## The invariant

**The journal snapshot must be replaced whenever the config being journaled is
provably not opencodex-owned, and must never be created or replaced from
opencodex-owned bytes.**

Both halves matter. The first breaks the day-one freeze that issue #477
reports. The second is what the current early return protects, and the audit
found that a "replace only when a journal already exists" gate silences it in a
reachable case: `tests/codex-inject-integration.test.ts` ("upgrade path: a
legacy-injected config converts to the Design B form in one inject") starts from
an injected config with **no journal at all**, and today's code happily
snapshots those injected bytes as the original.

So the classification governs *creation* as well as replacement.

## Design

`hasInjectedCodexRouting()` (`src/codex/inject.ts:285`) already decides
ownership for both the loopback Design B root override and the legacy provider
table. The caller passes both the verdict and the **exact bytes it classified**,
which closes the audit's TOCTOU finding: journaling the caller's `rawContent`
rather than re-reading the file means the snapshot can never disagree with the
classification, however many processes race on `config.toml`.

### MODIFY `src/codex/journal.ts`

Before:

```ts
export function writeJournal(): void {
  if (existsSync(JOURNAL_PATH) && readJournal()) return;
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const config = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const profile = existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
```

After:

```ts
export interface WriteJournalOptions {
  /**
   * The caller's verdict on the config it is about to transform: false when
   * `hasInjectedCodexRouting` matched. This does NOT decide whether the content
   * may be journaled — that is checked here, from the bytes themselves. It only
   * authorizes REPLACING an existing snapshot, which is why omitting it still
   * allows a first snapshot but never an overwrite.
   */
  currentStateIsNative?: boolean;
  /**
   * The exact bytes the caller classified. Journaling these rather than
   * re-reading the file keeps the snapshot and the verdict describing the same
   * content when another process rewrites config.toml mid-flight.
   */
  configContent?: string;
}

/**
 * Snapshot the pre-injection Codex state.
 *
 * Only native (non-opencodex-owned) config may be journaled, and native config
 * always supersedes an older snapshot. The first half is what stops a re-inject
 * from recording opencodex's own routing as the user's original — which would
 * survive `ocx stop` and make the injection unremovable. The second half is the
 * #477 fix: without it the first snapshot a machine ever takes is the only one it
 * ever has, so an unclean shutdown days later replays a day-one config over the
 * user's plugins, model choice, and trusted projects.
 */
export function writeJournal(options: WriteJournalOptions = {}): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const config = options.configContent ?? readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Ownership is decided HERE, from the bytes about to be journaled — never taken
  // on the caller's word. A caller that says "native" about injected content would
  // otherwise make opencodex's own routing the user's permanent "original".
  if (hasInjectedCodexRouting(config)) return;
  // The caller's verdict only authorizes REPLACEMENT. It is weaker evidence than
  // the check above (it may describe bytes read a moment earlier), so an
  // unclassified call creates a first snapshot but never overwrites one.
  if (existsSync(JOURNAL_PATH) && readJournal() && options.currentStateIsNative !== true) return;
  const profile = existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
```

Two details the audit forced:

- **Ownership is checked, never asserted.** Round 3 caught that a derived
  *default* still let `writeJournal({ currentStateIsNative: true })` record
  injected bytes if a caller lied or drifted. The predicate now runs
  unconditionally on the content being journaled, so the invariant holds for
  every caller present and future, and `currentStateIsNative` degrades from a
  claim about content to a much narrower permission: *may I replace?*
- **An unclassified call still creates.** `writeJournal()` with no arguments —
  the form used by `writeJournal creates journal file`
  (`tests/codex-journal.test.ts:31`), `restoreNativeCodex uses journal snapshot…`
  (`:154`) and `full lifecycle: write → crash → reconcile restores` (`:256`) —
  keeps working on a native config and is refused on an injected one.

`hasInjectedCodexRouting` lives in `inject.ts`, which imports `journal.ts` at
line 3 — so `journal.ts` cannot import it back. The predicate and the three
helpers it needs move to a new leaf module `src/codex/injected-marker.ts`, and
both files import from there.

The rest of the function is unchanged: it rebuilds the record from scratch, so a
refreshed journal carries a fresh `pid` and `timestamp` and — importantly — no
`injectedConfigHash`. That is why no transaction-identity field is needed.

`markJournalInjectedState` is **left exactly as it is**. The audit's proposed
`journal.pid !== process.pid` guard was evaluated and rejected: `ocx sync` and
the `ocx ensure` parent legitimately inject in a process that did not write the
journal, so a PID guard would suppress the hash refresh precisely when it is
needed. The existing `if (journal.injectedConfigHash) return;` is already
correct once `writeJournal` can refresh, because a refreshed journal has no hash
and therefore accepts the new one.

### MODIFY `src/codex/inject.ts`

Line 532, before:

```ts
  writeJournal();
```

After:

```ts
  // Classify and journal the same bytes: a native config is a valid original and
  // supersedes a stale snapshot (#477), while an injected one must never become
  // one — that is how opencodex routing would survive `ocx stop`.
  writeJournal({
    currentStateIsNative: !hasInjectedCodexRouting(rawContent),
    configContent: rawContent,
  });
```

`rawContent` is read at line 516 and `hasInjectedCodexRouting` is defined at
line 285 of the same module, so no import changes.

### NEW `src/codex/injected-marker.ts`

The move is the **transitive closure**, not the four functions named at first.
Round 3 caught two helpers missing from the list; walking the call graph gives
the complete set:

| Symbol | `inject.ts` line | Needed by |
|--------|------------------|-----------|
| `OCX_SECTION_MARKER` | 10 | `hasInjectedOpenaiBaseUrl` |
| `tomlStringPattern` | (helper) | `rootTomlString`, `providerTableString` |
| `providerTableStart` | (helper) | `providerTableString` |
| `isRootOpenaiBaseUrlLine` | (helper) | `hasInjectedOpenaiBaseUrl` |
| `hasInjectedOpenaiBaseUrl` | 171 | `hasInjectedCodexRouting` |
| `rootTomlString` | 189 | `hasInjectedCodexRouting` |
| `providerTableString` | 208 | `hasInjectedCodexRouting` |
| `hasInjectedCodexRouting` | 285 | `journal.ts`, `inject.ts` |

All are exported from the new module. Its only external dependency is
`parseTomlString` from `./paths`, which `journal.ts` already reaches — no cycle.

`inject.ts` **imports** all eight rather than re-exporting only some, because it
keeps using them internally: `OCX_SECTION_MARKER` at 97, 133, 140, 144, 159 and
636; `hasInjectedOpenaiBaseUrl` at 262 and 658; `rootTomlString` at 258 and 265;
`providerTableString` at 268; and `providerTableStart` inside
`classifyCodexRouting` at 267. It re-exports `hasInjectedCodexRouting` and
`hasInjectedOpenaiBaseUrl` so external callers — `isCodexRoutingInjected`,
status, doctor, the dashboard, and the tests importing from `inject` — are
untouched.

`rootTomlString`, `providerTableString`, `tomlStringPattern` and
`providerTableStart` are currently module-private; the split exports them. That
widened visibility is the cost of breaking the cycle, noted rather than hidden.

### MODIFY `src/cli/index.ts`

The snapshot at line 201 is the audit's race source: it runs at server start,
while injection happens ~70 lines later. It is also redundant — every path that
injects journals first, inside `injectCodexConfig`, and that is the snapshot
with the correct content. Removing it collapses the race rather than papering
over it.

Before:

```ts
  if (!currentExternalCodexModelProvider()) writeJournal();
```

After:

```ts
  // No pre-emptive snapshot here. `injectCodexConfig` journals the exact bytes it
  // is about to transform; snapshotting earlier only captured a baseline that could
  // be stale by the time injection ran (#477).
```

`writeJournal` then drops out of the import at `src/cli/index.ts:7`, leaving
`reconcileJournal`.

Safe because every path that injects Codex routing goes through
`injectCodexConfig`, which journals the bytes it is about to transform. The
audit confirmed there is no alternate injection source. The `start` path's
`syncModelsToCodex(port).catch(() => {})` at `src/cli/index.ts:274` swallows
failures, but a failed injection is precisely the case where no journal should
exist: nothing was transformed, so there is nothing to restore.

## Regression tests

All in `tests/codex-journal.test.ts`, reusing its `runScript(codexHome, script)`
harness, which runs the real modules in a child process against a throwaway
`CODEX_HOME`.

### Test 1 — the #477 proof (RED before, GREEN after)

```ts
test("a stale journal is superseded once the config is native again (#477)", () => {
  const r = runScript(testDir, `
    const fs = require("fs");
    const path = require("path");
    const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
    const configPath = path.join(process.env.CODEX_HOME, "config.toml");
    (async () => {
      // Day one: inject, then edit while routing is live so the stop leaves the journal.
      await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
      fs.appendFileSync(configPath, '\\n[projects."/tmp/day-one"]\\ntrust_level = "trusted"\\n', "utf8");
      restoreNativeCodex();
      // Day four: the user installs a plugin while opencodex is not running.
      fs.appendFileSync(configPath, '\\n[plugins."browser@openai-bundled"]\\nenabled = true\\n', "utf8");
      const nativeBaseline = fs.readFileSync(configPath, "utf8");
      await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
      console.log(JSON.stringify({ nativeBaseline }));
    })();
  `);
  expect(r.status).toBe(0);
  const { nativeBaseline } = JSON.parse(r.stdout);

  const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
  expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(nativeBaseline);
  // A refreshed record is a new transaction: the day-one injected fingerprint is gone,
  // replaced by one for the injection that just ran.
  expect(journal.injectedConfigHash).toBeString();

  // And the recovery actually works end to end: an unclean shutdown restores day four.
  const r2 = runScript(testDir, `
    const { reconcileJournal } = require("./src/codex/journal");
    const fs = require("fs");
    const path = require("path");
    const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
    const j = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    fs.writeFileSync(journalPath, JSON.stringify({ ...j, pid: 999999 }));
    console.log(JSON.stringify({ restored: reconcileJournal() }));
  `);
  expect(JSON.parse(r2.stdout).restored).toBe(true);
  const recovered = readFileSync(join(testDir, "config.toml"), "utf8");
  expect(recovered).toContain("browser@openai-bundled");
  expect(recovered).not.toContain("[model_providers.opencodex]");
  expect(recovered).not.toContain("Auto-injected by opencodex");
});
```

Pre-change behavior: the journal still holds the day-one config, so the
`toBe(nativeBaseline)` assertion fails on the missing plugin block.

### Test 2 — the naive-fix guard, native start (GREEN both trees)

```ts
test("re-injecting over an injected config never captures it as the original (#477)", () => {
  const original = '# original config\nmodel_provider = "openai"\n';
  writeFileSync(join(testDir, "config.toml"), original, "utf8");

  const r = runScript(testDir, `
    const { injectCodexConfig } = require("./src/codex/inject");
    (async () => {
      await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
      await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
      console.log("done");
    })();
  `);
  expect(r.status).toBe(0);
  const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
  expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(original);
});
```

### Test 3 — the audit's injected/no-journal case (RED before, GREEN after)

This is the case the first design missed: an injected config with no journal at
all, which the existing "upgrade path" integration test proves is reachable.

```ts
test("an injected config with no journal is never captured as the original (#477)", () => {
  // Legacy-injected config, journal deliberately absent — the upgrade path in
  // tests/codex-inject-integration.test.ts starts from exactly this state.
  const injected = [
    'model_provider = "opencodex"',
    "",
    "# Auto-injected by opencodex",
    "[model_providers.opencodex]",
    'name = "OpenCodex Proxy"',
    'base_url = "http://127.0.0.1:10100/v1"',
    "",
  ].join("\n");
  writeFileSync(join(testDir, "config.toml"), injected, "utf8");

  const r = runScript(testDir, `
    const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
    (async () => {
      await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
      restoreNativeCodex();
      console.log("done");
    })();
  `);
  expect(r.status).toBe(0);

  // Whatever the restore produced, it must not reinstate opencodex routing as if
  // the user had written it.
  const after = readFileSync(join(testDir, "config.toml"), "utf8");
  expect(after).not.toContain("[model_providers.opencodex]");
  expect(after).not.toContain("Auto-injected by opencodex");
});
```

Pre-change behavior: `writeJournal` snapshots the injected bytes, the restore
replays them, and both assertions fail.

### Test 4 — a journal this process did not write is still markable (GREEN both trees)

Documents the rejected PID design rather than claiming to trap it. Round 3 is
right that this test would also pass under `if (journal.injectedConfigHash &&
journal.pid !== process.pid) return` — the journal here is hashless, so that
guard short-circuits before the PID comparison ever matters. Which is precisely
why no PID guard is needed: **the only journal a marking process ever encounters
is hashless**, because a refresh rebuilds the record and a non-refresh means the
previous transaction already completed. The test pins that property; it is not
a trap for a design nobody is proposing to write.

```ts
test("a hashless journal from another process can still be marked (#477)", () => {
  // Process 1: journal a native config and exit without injecting.
  runScript(testDir, `
    const { writeJournal } = require("./src/codex/journal");
    writeJournal();
    console.log("journaled");
  `);
  const first = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
  expect(first.injectedConfigHash).toBeUndefined();
  const foreignPid = first.pid;

  // Process 2 marks it directly — no refresh in between, so the journal it marks
  // is provably the one process 1 wrote.
  const r = runScript(testDir, `
    const { markJournalInjectedState } = require("./src/codex/journal");
    markJournalInjectedState("# injected\\n", null);
    console.log(String(process.pid));
  `);
  expect(r.status).toBe(0);
  expect(Number(r.stdout)).not.toBe(foreignPid);

  const second = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
  expect(second.pid).toBe(foreignPid);          // still process 1's record
  expect(second.injectedConfigHash).toBeString(); // and process 2 marked it
});
```

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

| Branch | Reachable from | C triggers it via | Observable effect |
|--------|----------------|-------------------|-------------------|
| native + existing journal → refresh | any start after a partial restore | Test 1 | `originalConfig` equals the day-four config |
| injected + existing journal → keep | `ocx sync` while routing is live | Test 2 | `originalConfig` still the pre-injection config |
| injected + no journal → refuse to create | legacy upgrade path | Test 3 | restore leaves no opencodex routing |
| derived-verdict creation (no options) | every existing direct caller | Test 5 | first snapshot still created from native config |
| cross-process marking | `ocx sync` marking a journal it did not write | Test 4 | `injectedConfigHash` set while `pid` stays foreign |

### Test 5 — the unclassified contract still works (GREEN both trees)

```ts
test("writeJournal() with no options still snapshots a native config", () => {
  const r = runScript(testDir, `
    const { writeJournal } = require("./src/codex/journal");
    writeJournal();
    console.log("written");
  `);
  expect(r.status).toBe(0);
  const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
  expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toContain("original config");
});

test("writeJournal() with no options refuses an injected config", () => {
  writeFileSync(join(testDir, "config.toml"), [
    'model_provider = "opencodex"',
    "",
    "# Auto-injected by opencodex",
    "[model_providers.opencodex]",
    'base_url = "http://127.0.0.1:10100/v1"',
    "",
  ].join("\n"), "utf8");
  runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("done");`);
  expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
});
```

## Scope boundary

IN: `src/codex/journal.ts`, the new leaf `src/codex/injected-marker.ts` (pure
move), the corresponding deletion plus re-export in `src/codex/inject.ts`, one
call site in `src/codex/inject.ts`, removal of the redundant call in
`src/cli/index.ts`, and `tests/codex-journal.test.ts`.

OUT: the hashless-journal replay policy in `restoreJournalState`
(`tests/codex-journal.test.ts:49` and `:256` encode it as deliberate legacy
recovery); a timestamp staleness bound; and any ownership-based partial-restore
redesign. Recorded as residual risk rather than silently dropped.

## Accept criteria

- Tests 1 and 3 fail on the pre-change tree and pass after.
- Tests 2, 4 and 5 pass on both trees.
- The eleven existing `tests/codex-journal.test.ts` tests and the eleven in
  `tests/codex-inject-integration.test.ts` still pass **unmodified** — in
  particular the three that call `writeJournal()` with no arguments
  (`:31`, `:154`, `:256`).
- Full gates green.
