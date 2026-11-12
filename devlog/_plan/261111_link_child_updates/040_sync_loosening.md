# 040 — Looser ocx sync (wp4): --child and --restart-children

> **Revision 2 (audit r1).** Folds H1 (both new tests register in the `layout-clients.json` shard, 000 "Test
> registration rule"), M7 (this phase plus 030's Restart Codex is how root-cause layer 2 is cleared by default, 000),
> M8 (`--restart-children=codex` requires `--yes`; activity is already read per Child at run time, deviation 3) and
> L12 (verifier facts on 61151e3457).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529522026 (a sync verdict with `executable: "ocx-child"`, 010's new
> marker, reports `restart-unsupported:ocx-child` for a record without `childKind`), 4529522035 (a failed activity
> re-read withholds the restart with `restart-skipped:activity-unknown`) and 4529521916 (the Child is synced first and
> the restart goes out as a second pinned sync after a fresh activity read, as in 030).
> Also escapes the regex pipe in the Verifiers table (`Codex\|Fan-out`), which split that row.

> **Revision 5 (wp4 P re-verification on 4e4d8d4206).** Re-anchors every citation to the merged wp1-wp3 code, makes the
> CLI fan-out reuse wp3's "sync then guarded restart" sequence (decision 7, new `src/link/sync-then-restart.ts`),
> adds the two outcomes wp3 already distinguishes (`restart-not-run`, `restart-result-unknown`) and records the
> wire's activity collapse (decision 8). Details in "wp4 P re-verification" at the end.

- **Work phase:** wp4. **Depends on:** wp1 (`remotePinnedSyncArgv(linkId, platform, opts)`, `ssh-argv.ts:482-491`;
  `classifySyncResult(result, { expectSelectedKind })`, `sync-fanout-classify.ts:63`), wp2
  (`GET /api/link/status?children=1` with `child.activity` and `child.activeJob`, validated by `validateChildOps`,
  `src/cli/link-status-child.ts:30-66`, reached from `validateStatus`, `src/cli/link.ts:189`), wp3
  (`syncWithRestart`, `child-ops-runners.ts:116-130`, whose sequence this phase extracts and reuses). **Class:** C3, promoted to C4 for the
  `sync.home-fanout/1` document change and because the Home can now end running turns on another machine.
- **Outcome:** on a Home, `ocx sync --child <linkId>` (repeatable) fans out only to the named links, and
  `ocx sync --restart-children[=app-server|codex]` asks each selected Child to restart its Codex
  app-servers (default) or the Codex app after its pinned sync. Following amendment A2, the Home skips the
  restart, never the sync, for a Child with a relayed model request in flight and reports
  `restart-skipped:link-active`. Fan-out also skips a Child that a Child operation (wp2/wp3 job) holds.
  Without the new flags the behaviour and the JSON document are exactly today's.
- **IN:** `src/cli/sync-flags.ts`, `src/cli/sync-command.ts` (`runChild`), `src/cli/sync-fanout.ts` (filter,
  busy skip, restart note to reason and hint, exit rule), `src/cli/sync-link-status.ts` (`children=1`),
  `src/link/sync-then-restart.ts` (NEW, the sequence moved out of wp3's `syncWithRestart`),
  `src/link/child-ops-runners.ts` (`syncWithRestart` delegates; behaviour unchanged), wording in
  `capabilities-base.ts:786`, `registry.ts:191-195`, `help.ts:52`, `lifecycle.md:592-612` + 7 locales,
  `structure/remote-link.md:9` and `:75`, `skills/ocx`, tests.
- **OUT:** any Child-side change (the Child already honours both restart tokens since 2.54/2.93, F2); a restart
  outcome marker (wp8); Windows Child restarts (refused, D20); `ocx link restart-codex` (wp3).

## Decisions and deviations from 004

1. **How a skipped restart is reported (A2).** The Child's own `--json` output must stay the 4-key
   `ocx.sync.fanout/1` document, because Homes classify any other key set as `child-output-invalid`
   (`validDocument`, `src/link/sync-fanout-classify.ts:45-57`). The restart flags do not change it: under `--json` the Child routes
   restart text to stderr (`sync-command.ts:21`) and the restart happens after the catalog write
   (`handleConnectedSyncCatalogWrite`, `sync-command.ts:239-245`). The Home reports its own decision in the Home's document, on the existing
   `ChildResult` (`sync-fanout.ts:11`) without a new key: a Child whose sync succeeded but whose restart
   was withheld is `{ state: "synced", reason: "restart-skipped:link-active", hint }`. Today `reason` is
   always `null` for `synced`; a consumer that branches on `state` keeps working. The same carrier holds
   `restart-skipped:activity-unknown` (the Home runtime answered without `child`, or the re-read failed),
   `restart-skipped:windows`, `restart-unsupported:ocx-child` (`ocx-child` accepts and ignores the flags,
   `native/ocx-child/src/cli.rs:1211-1215`), and two outcomes wp3 already tells apart (decision 7):
   `restart-not-run` (the restarting sync certainly ran nothing, F2) and `restart-result-unknown` (it was sent and its
   result is unknown; same string as wp3's `RESTART_RESULT_UNKNOWN`, `child-ops-runners.ts:27`). The wp1 rule that
   `ChildVerdict.executable` never reaches `ocx.sync.fanout/1` already holds twice on the merged base:
   `runChild` picks `{ state, reason }` (`sync-command.ts:220-222`) and `runHomeFanout` builds each row from the
   schema's own fields (`sync-fanout.ts:59-61`). This phase keeps both.
2. **Exit 6 for a withheld restart (refinement of D16).** The operator asked for a restart that did not
   happen, so `fanoutExitCode` returns 6 for a `synced` row whose `reason` starts with `restart-`, exactly as
   it does for a hinted skip (`sync-fanout.ts:70-73`). This matches `ocx link sync` (030 R2). `not-selected` and `child-busy` rows carry no hint and
   keep exit 0, as D16 and D8 specify.
3. **Activity is re-read per Child, not once.** `runHomeFanout` reads status once (`sync-fanout.ts:34`).
   With `--restart-children` it reads it again for each Child after that Child's plain sync and immediately before a
   second pinned sync that carries the restart (Revision 4), so the window in which a new turn can start shrinks
   from the whole fan-out (up to 180 s per Child) to one loopback request plus one SSH round trip of a no-op sync. A
   failed re-read withholds the restart (`restart-skipped:activity-unknown`); the first read is never reused.
   The residual window is recorded under "Enforcement bypass record".
4. **An absent `child` block withholds the restart.** A CLI newer than the running Home runtime (not restarted
   after an update) gets rows without `child`; the Home cannot see running turns, so it syncs and reports
   `restart-skipped:activity-unknown` instead of guessing idle (D5: unknown is never idle).
5. **Windows is decided in `runChild`.** The platform is known only after `requireRemotePlatformFramed`
   (`sync-command.ts:213`); a Windows Child gets the plain pinned sync and `restart-skipped:windows` (D20).
6. **`--restart-children=codex` needs `--yes` (audit M8, 000 A2).** Quitting and relaunching the Codex desktop app on
   another machine ends every conversation there, so the scope matches `ocx link restart-codex --scope codex --yes` and
   `ocx link sync --restart-codex --yes` (030). The default `app-server` scope keeps working without `--yes`, as the
   owner asked; it is still withheld per Child while a relayed request is in flight. `ocx sync` does not reject unknown
   flags (no `rejectArgs` in `src/cli/sync-command.ts`), and the Home's own restart reads exact tokens
   (`restart-scope.ts:35-37`), so `--yes` changes nothing else.
7. **One implementation of "sync then guarded restart" (re-verification).** wp3's `syncWithRestart`
   (`child-ops-runners.ts:116-130`) already encodes the sequence this phase needs: plain sync; `unsupported` on a
   non-POSIX platform or `childKind: "ephemeral"`; `not-run` when the plain sync did not succeed; activity read after
   it, unknown counting as in flight; a second pinned sync carrying the restart; `unsupported` when the second sync
   reports `executable: "ocx-child"`; `not-run` when the second sync certainly ran nothing (F2,
   `child-ops-runners.ts:97-100`); otherwise the restart was sent and, if that sync did not succeed, its result is
   unknown. The CLI fan-out cannot call it as is: it is module-private, it takes the runtime's `ChildOpsEnv` (the
   runtime's `SshRunner`, `catalogEtag`, `writeObservation` and a synchronous `activity`,
   `child-ops-types.ts:59-79`), and the CLI runs in its own process with `runFanoutProcess` (process-tree
   termination, `FanoutProcessError`) and reads activity over `GET /api/link/status?children=1`. Copying the sequence
   would let the two drift, so wp4 moves the sequence (and the F2 "ran nothing" rule) into a pure module,
   `src/link/sync-then-restart.ts`, parameterised by a `runPinned(restart)` callback and an async
   `readActivity()`. `syncWithRestart` becomes a wrapper over it with identical results (its tests in
   `tests/clients/link-child-ops-runners.test.ts` stay unchanged and green, which is the proof). The CLI's `runChild`
   calls the same function with a `runFanoutProcess` callback and a `readActivity` that `runHomeFanout` passes in
   (the per-Child re-read of decision 3), then maps the result to a `reason`. The module imports only types, so it
   adds nothing to the CLI's import graph beyond itself. Lab boundary: none of the three core files reaches it.
8. **The wire collapses unknown activity into `inFlight: 0` (re-verification).** `attachLinkChildOps` writes
   `{ idle: false, inFlight: 0, lastDataEndAt: null }` when the listener has no activity snapshot
   (`src/link/status-projection.ts:149-150`), so a CLI reading the wire cannot tell "no activity book" from "nothing
   in flight". On a Home the snapshot is never null: the link listener always creates the activity book and serves
   `linkActivity` (`src/server/index/link-listener.ts:93`, `:237`; read at `link-child-ops-routes.ts:138`). The
   gate stays `inFlight > 0`, the same test wp3 applies (`child-ops-runners.ts:51-52`), and the residual is recorded
   under "Enforcement bypass record". Gating on `idle` instead would also withhold the restart for ten minutes after
   every finished turn (`DEFAULT_IDLE_AFTER_MS`, `child-activity.ts:4`), which A2 does not ask for.

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| src/cli/sync-flags.ts | MODIFY (:1-10) | parse `--child`, `--restart-children`; reject conflicts |
| src/cli/sync-command.ts | MODIFY (:18-19, :207-228) | unknown-id check before the Home sync; pass selection and restart; `runChild` calls the shared sequence |
| src/cli/sync-fanout.ts | MODIFY (`runHomeFanout`, `fanoutExitCode`) | filter, busy skip, per-Child `readActivity`, restart hint, exit rule |
| src/cli/sync-link-status.ts | MODIFY (:29) | `?children=1` |
| src/link/sync-then-restart.ts | NEW | `syncThenRestart`, `pinnedSyncRanNothing`, `RESTART_RESULT_UNKNOWN` (decision 7) |
| src/link/child-ops-runners.ts | MODIFY (:27, :97-100, :116-130) | `syncWithRestart` and `runPinnedSync` delegate; constant re-exported |
| src/cli/capabilities-base.ts | MODIFY (:786, :790, `flags` at :772) | wording and the two flags |
| src/cli/registry.ts | MODIFY (:191, :195) | usage and wording |
| src/cli/help.ts | MODIFY (:52) | one-line usage |
| docs-site/src/content/docs/reference/cli/lifecycle.md | MODIFY (:592, :609-612) | heading usage, restart paragraph |
| docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/cli/lifecycle.md | MODIFY | fr :166/:170, ja :173/:177, ko :261/:265, ru :262/:266, tr :259/:263, zh-cn :169/:173, zh-tw :161/:165 |
| structure/remote-link.md | MODIFY (:9, :75) | "without a restart flag" → opt-in restart; name the shared sequence |
| skills/ocx/references/05_remote_hub.md | MODIFY (:325) | hand page wording |
| skills/ocx/references/01_surface_lifecycle.md | REGENERATE | `bun run skill:surface` (line 110 comes from `capabilities-base.ts:786`) |
| tests/cli/sync-fanout-select-restart.test.ts | NEW | pure fan-out cases |
| tests/cli/sync-command-child-flags.test.ts | NEW | flags, unknown id, `runChild` argv and restart mapping |

Sizes on 4e4d8d4206: `sync-command.ts` 245 → about 265, `sync-fanout.ts` 78 → about 100, `sync-flags.ts` 10 → about 45,
`child-ops-runners.ts` 312 → about 300, new module about 60. None of them is in `tests/fixtures/file-size-baseline.json`.

## Changes

### src/cli/sync-flags.ts

Before (whole file, `:1-10`):

```ts
export type SyncFanoutFlags = { ok: true; localOnly: boolean; json: boolean } | { ok: false; message: string };

export function parseSyncFanoutFlags(args: readonly string[]): SyncFanoutFlags {
  for (const flag of ["--local-only", "--json"]) {
    if (args.filter(arg => arg === flag).length > 1 || args.some(arg => arg.startsWith(`${flag}=`))) {
      return { ok: false, message: `ocx sync accepts ${flag} once without a value.` };
    }
  }
  return { ok: true, localOnly: args.includes("--local-only"), json: args.includes("--json") };
}
```

After:

```ts
import type { ChildRestartRequest } from "../link/ssh-argv";

export type SyncFanoutFlags = {
  ok: true; localOnly: boolean; json: boolean;
  /** null: every link (today's behaviour). Otherwise the deduplicated ids given with --child. */
  children: readonly string[] | null;
  restartChildren: ChildRestartRequest | null;
} | { ok: false; message: string };

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

export function parseSyncFanoutFlags(args: readonly string[]): SyncFanoutFlags {
  for (const flag of ["--local-only", "--json"]) {
    if (args.filter(arg => arg === flag).length > 1 || args.some(arg => arg.startsWith(`${flag}=`))) {
      return { ok: false, message: `ocx sync accepts ${flag} once without a value.` };
    }
  }
  const children: string[] = [];
  let restart: ChildRestartRequest | null = null, restartSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--child" || arg.startsWith("--child=")) {
      const value = arg === "--child" ? args[++i] : arg.slice("--child=".length);
      if (value === undefined || !LINK_ID.test(value)) return { ok: false, message: "--child needs a link id of the form lnk_ followed by 16 hex digits (see ocx link status)." };
      if (!children.includes(value)) children.push(value);
    } else if (arg === "--restart-children" || arg.startsWith("--restart-children=")) {
      if (restartSeen) return { ok: false, message: "ocx sync accepts --restart-children once." };
      restartSeen = true;
      const value = arg === "--restart-children" ? "app-server" : arg.slice("--restart-children=".length);
      if (value !== "app-server" && value !== "codex") return { ok: false, message: "--restart-children accepts app-server (default) or codex." };
      restart = value;
    }
  }
  const localOnly = args.includes("--local-only");
  if (restart === "codex" && !args.includes("--yes")) {
    return { ok: false, message: "--restart-children=codex quits and relaunches the Codex app on each selected Child and ends its conversations; pass --yes." };
  }
  if (localOnly && (children.length > 0 || restartSeen)) return { ok: false, message: "--local-only disables fan-out; it cannot be combined with --child or --restart-children." };
  return { ok: true, localOnly, json: args.includes("--json"), children: children.length ? children : null, restartChildren: restart };
}
```

The Home's own restart is read by exact token (`src/cli/restart-scope.ts:35-37`), and neither `--restart-children`
nor `--restart-children=codex` equals `--restart-codex` or `--restart-app-server-only`, so the Home never restarts
itself because of the new flag. `parseSyncExpectation` ignores the new flags (`sync-expectation.ts:21-36`). A
`--child` value consumed here is not an `--expect-link` value: the two parsers match different flag names.

`ChildRestartRequest` is exported by `src/link/ssh-argv.ts:478` (`"app-server" | "codex"`), so the import above
resolves on the merged base; `sync-flags.ts` is still the 10-line file shown under Before.

### src/link/sync-then-restart.ts (NEW, decision 7)

The body is wp3's `syncWithRestart` (`child-ops-runners.ts:116-130`) and its F2 rule (`:97-100`), moved
verbatim and parameterised. Type-only imports.

```ts
import type { ChildRestart, ChildRestartOutcome } from "./child-ops-types";
import type { LinkRecord } from "./store";

/** Revision 6 F2 (030): a restarting sync that may have run but whose result is unknown. */
export const RESTART_RESULT_UNKNOWN = "restart-result-unknown";

type Verdict = { state: string; reason: string | null; executable?: "ocx-child" };
/** One pinned sync: its verdict and whether it certainly ran nothing on the Child (F2). */
export interface PinnedRun<S extends Verdict> { sync: S; notRun: boolean }
/** Why no restart went out. In process only; never serialized into a job or ocx.sync.fanout/1. */
export type RestartWithheld = "platform" | "ocx-child" | "sync-failed" | "activity-unknown" | "link-active" | "second-not-run";

export interface SyncThenRestart<S extends Verdict> {
  /** The plain sync's verdict, or the restarting sync's when restartUnknown. */
  sync: S;
  restart?: { requested: "app-server" | "codex"; outcome: ChildRestartOutcome };
  restartUnknown?: true;
  withheld?: RestartWithheld;
  /** The restarting sync's verdict whenever one ran. */
  second?: S;
}

/** F2: the gate refused before selecting an ocx, or the Child's sync declined. Moved from child-ops-runners.ts:97-100. */
export function pinnedSyncRanNothing(verdict: Verdict, result: { code: number; stderr: string }): boolean {
  const selected = /^ocx-fanout:selected:/m.test(result.stderr);
  return verdict.state === "skipped" || (verdict.state === "failed" && !selected && [121, 125, 126, 127].includes(result.code));
}

export async function syncThenRestart<S extends Verdict>(input: {
  requested: ChildRestart; platform: "posix" | "windows"; childKind: LinkRecord["childKind"];
  runPinned: (restart: ChildRestart) => Promise<PinnedRun<S>>;
  /** Read after the plain sync, immediately before the restart. null is unknown and counts as in flight (D5). */
  readActivity: () => Promise<{ inFlight: number } | null>;
}): Promise<SyncThenRestart<S>> {
  const { requested } = input;
  const first = (await input.runPinned("none")).sync;
  if (requested === "none") return { sync: first };
  if (input.platform !== "posix") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "platform" };
  if (input.childKind === "ephemeral") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "ocx-child" };
  if (first.state !== "synced") return { sync: first, restart: { requested, outcome: "not-run" }, withheld: "sync-failed" };
  const activity = await input.readActivity();
  if (activity === null) return { sync: first, restart: { requested, outcome: "skipped" }, withheld: "activity-unknown" };
  if (activity.inFlight > 0) return { sync: first, restart: { requested, outcome: "skipped" }, withheld: "link-active" };
  const second = await input.runPinned(requested);
  if (second.sync.executable === "ocx-child") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "ocx-child", second: second.sync };
  if (second.sync.state === "synced") return { sync: first, restart: { requested, outcome: "requested" }, second: second.sync };
  if (second.notRun) return { sync: first, restart: { requested, outcome: "not-run" }, withheld: "second-not-run", second: second.sync };
  return { sync: second.sync, restart: { requested, outcome: "requested" }, restartUnknown: true, second: second.sync };
}
```

wp3's order is kept exactly: the unsupported checks precede the "plain sync failed" check, as at
`child-ops-runners.ts:120-121`. The callback never sees a Windows restart, so `remotePinnedSyncArgv`'s
refusal (`ssh-argv.ts:486`, `LinkSshArgumentError("unsupported:windows-restart")`) stays a backstop.

### src/link/child-ops-runners.ts

- `:27` becomes `export { RESTART_RESULT_UNKNOWN } from "./sync-then-restart";` (its three uses at :169, :197, :306 and any
  importer keep the name).
- `runPinnedSync` `:97-100`: `const notRun = pinnedSyncRanNothing(sync, result);`.
- `syncWithRestart` `:116-130` keeps its signature and its result type (`withheld`/`second` are dropped):

```ts
async function syncWithRestart(record: LinkRecord, platform: Platform, requested: ChildRestart,
  env: ChildOpsEnv): Promise<{ sync: SyncResult; restart?: RestartReport; restartUnknown?: true }> {
  const { sync, restart, restartUnknown } = await syncThenRestart({ requested, platform, childKind: record.childKind,
    runPinned: restart => runPinnedSync(record, platform, restart, env),
    // linkBusy's rule: unknown is in flight.
    readActivity: async () => env.activity(record.id) });
  return { sync, ...(restart ? { restart } : {}), ...(restartUnknown ? { restartUnknown } : {}) };
}
```

`linkBusy` (`:51-53`) stays for `runRestartCodexItem`'s pre-check (`:194`).

### src/cli/sync-command.ts

Before (`:18-19` and `:207-228`, abridged):

```ts
    const flags = parseSyncFanoutFlags(deps.args.slice(1));
    if (!flags.ok) { console.error(flags.message); return 2; }
...
    const document = await runHomeFanout({
      home: { state, exit: code }, catalogCurrent, localOnly: flags.localOnly, applicable,
      readStore: () => readLinkStore(linkStorePath()), readLinkStatus: () => readHomeLinkStatus(),
      runChild: async (link, deadline) => {
        ...platform discovery (:211-217)...
        try {
          const result = await runFanoutProcess(buildExecArgv({ alias: link.alias, knownHostsFile: linkKnownHostsPath(), argv: remotePinnedSyncArgv(link.id, platform) }), { timeoutMs: Math.max(0, deadline - Date.now()) });
          // Pick the public fields: a verdict key that ocx.sync.fanout/1 does not define never reaches the document.
          const { state, reason } = classifySyncResult(result);
          return { state, reason, exit: result.code };
        } catch (error) { ...FanoutProcessError → timed-out / failed... }
      },
    });
```

After:

```ts
    const flags = parseSyncFanoutFlags(deps.args.slice(1));
    if (!flags.ok) { console.error(flags.message); return 2; }
    if (flags.children) {
      // D16: an unknown id is a usage error before the Home sync changes anything.
      let known: Set<string>;
      try { known = new Set(readLinkStore(linkStorePath()).links.map(link => link.id)); }
      catch { console.error("--child cannot be checked: the Remote Link store could not be read."); return 2; }
      const unknown = flags.children.find(id => !known.has(id));
      if (unknown) { console.error(`--child ${unknown} is not a link on this Home (see ocx link status).`); return 2; }
    }
...
    const document = await runHomeFanout({
      home: { state, exit: code }, catalogCurrent, localOnly: flags.localOnly, applicable,
      selected: flags.children === null ? null : new Set(flags.children), restartChildren: flags.restartChildren,
      readStore: () => readLinkStore(linkStorePath()), readLinkStatus: () => readHomeLinkStatus(),
      runChild: async (link, deadline, options) => {
        ...platform discovery unchanged (:211-217), once per Child...
        type Run = { state: ChildResult["state"]; reason: string | null; exit: number | null; executable?: "ocx-child" };
        const runPinned = async (restart: ChildRestart): Promise<PinnedRun<Run>> => {
          try {
            const result = await runFanoutProcess(buildExecArgv({ alias: link.alias, knownHostsFile: linkKnownHostsPath(),
              argv: remotePinnedSyncArgv(link.id, platform, restart === "none" ? {} : { restart }) }), { timeoutMs: Math.max(0, deadline - Date.now()) });
            const verdict = classifySyncResult(result, { expectSelectedKind: restart !== "none" });
            return { sync: { ...verdict, exit: result.code }, notRun: pinnedSyncRanNothing(verdict, result) };
          } catch (error) {
            if (!(error instanceof FanoutProcessError)) throw error;
            const timedOut = error.reason === "deadline-exceeded" || error.reason === "termination-unconfirmed";
            return { sync: { state: timedOut ? "timed-out" : "failed", reason: error.reason, exit: null }, notRun: error.reason === "ssh-spawn-failed" };
          }
        };
        const done = await syncThenRestart({ requested: options.restart ?? "none", platform, childKind: link.childKind,
          runPinned, readActivity: options.readActivity });
        // Pick the public fields: executable, withheld and second never reach ocx.sync.fanout/1.
        const note = restartNote(done, link);
        return note === null ? { state: done.sync.state, reason: done.sync.reason, exit: done.sync.exit }
          : { state: "synced", reason: note, exit: done.sync.exit };
      },
    });
```

`restartNote` lives in `sync-fanout.ts` (pure, tested there) and returns `null` unless the plain sync succeeded:

| `syncThenRestart` result | row `reason` (state `synced`) |
| --- | --- |
| no restart requested, or `outcome: "requested"` without `restartUnknown` | `null` (row as today) |
| `withheld: "platform"` | `restart-skipped:windows` |
| `withheld: "ocx-child"` (childKind or selected-kind marker) | `restart-unsupported:ocx-child` |
| `withheld: "sync-failed"` | `null`: the plain sync's failure row stands |
| `withheld: "activity-unknown"` | `restart-skipped:activity-unknown` |
| `withheld: "link-active"` | `restart-skipped:link-active` |
| `withheld: "second-not-run"` | `restart-not-run` |
| `restartUnknown` | `restart-result-unknown` (the plain sync succeeded; `done.sync` is the second run, so `exit` is that run's) |

The per-Child budget is unchanged: both pinned syncs share `deadline` and run inside `runHomeFanout`'s existing race
(`sync-fanout.ts:53-58`), so a slow second sync ends as `timed-out/termination-unconfirmed` like any Child.

### src/cli/sync-fanout.ts

```ts
export type RestartNote = "restart-skipped:link-active" | "restart-skipped:activity-unknown" | "restart-skipped:windows"
  | "restart-unsupported:ocx-child" | "restart-not-run" | "restart-result-unknown";
export type ChildRunOptions = { restart?: ChildRestartRequest; readActivity: () => Promise<{ inFlight: number } | null> };

export async function runHomeFanout(deps: {
  ...existing fields (:15-18)...
  selected?: ReadonlySet<string> | null;
  restartChildren?: ChildRestartRequest | null;
  runChild: (link: LinkRecord, deadline: number, options: ChildRunOptions) => Promise<Omit<ChildResult, "linkId" | "alias">>;
}): Promise<FanoutDocument>;
```

Worker loop (`sync-fanout.ts:42-64`), after `const link` and the client-initiated `continue` (:46):

```ts
      if (deps.selected && !deps.selected.has(link.id)) { result.children[index] = classify(link, "skipped", "not-selected"); continue; }
      const wire = status.links.find(row => row.id === link.id);
      ...unchanged link-not-in-runtime (:48) and tunnel-<state> (:49)...
      if (wire.child?.activeJob) { result.children[index] = classify(link, "skipped", "child-busy"); continue; }
      // Decision 3 / 4529522035: a fresh read per Child; a failed read or a row without child is unknown.
      const readActivity = async () => {
        try { return (await deps.readLinkStatus()).links.find(row => row.id === link.id)?.child?.activity ?? null; }
        catch { return null; }
      };
      const options: ChildRunOptions = deps.restartChildren ? { restart: deps.restartChildren, readActivity } : { readActivity };
      ...race unchanged (:50-58), calling deps.runChild(link, deadline, options)...
      // :60 grows one branch; :61 is unchanged, so only schema fields reach the row.
      const hint = child.state === "skipped" ? childSkipHint(child.reason, link.alias)
        : child.state === "synced" && child.reason?.startsWith("restart-") ? childRestartHint(child.reason as RestartNote, link.alias) : child.hint;
```

```ts
export function restartNote(done: SyncThenRestart<{ state: string; reason: string | null }>, link: LinkRecord): RestartNote | null {
  if (!done.restart) return null;
  // Reached only after a successful plain sync; done.sync is then the restarting sync's verdict.
  if (done.restartUnknown) return "restart-result-unknown";
  // Any failed plain sync keeps its own row, including on Windows or ocx-child (wp3 checks those first).
  if (done.sync.state !== "synced") return null;
  switch (done.withheld) {
    case undefined: case "sync-failed": return null;
    case "platform": return "restart-skipped:windows";
    case "ocx-child": return "restart-unsupported:ocx-child";
    case "activity-unknown": return "restart-skipped:activity-unknown";
    case "link-active": return "restart-skipped:link-active";
    case "second-not-run": return "restart-not-run";
  }
}

function childRestartHint(note: RestartNote, alias: string): string {
  if (note === "restart-skipped:link-active") return `A model request was running on ${alias}; its Codex was not restarted. Retry when it is idle.`;
  if (note === "restart-skipped:activity-unknown") return "Restart this Home's OpenCodex runtime so it reports Child activity, then retry.";
  if (note === "restart-skipped:windows") return "Codex restarts over SSH are not supported on Windows Children; restart Codex on that machine.";
  if (note === "restart-not-run") return `The restart was not sent to ${alias}; check its sync status and retry.`;
  if (note === "restart-result-unknown") return `The restart was sent to ${alias} but its result is unknown; check Codex on that machine.`;
  return "ocx-child does not restart Codex; restart the Codex app or its app-servers on that machine.";
}

export function fanoutExitCode(document: FanoutDocument): number {
  if (document.home.exit !== 0) return document.home.exit;
  return document.fanout.state === "failed" || document.children.some(child => child.state === "failed" || child.state === "timed-out"
    || (child.state === "skipped" && child.hint !== undefined)
    || (child.state === "synced" && child.reason?.startsWith("restart-") === true)) ? SYNC_FANOUT_PARTIAL_EXIT : 0;
}
```

`restartNote` takes `link` only for symmetry with the hint and may drop it. Without `--restart-children` no
`restart` is requested, `readActivity` is never called, `runChild` makes exactly one `runFanoutProcess` call
with `remotePinnedSyncArgv(link.id, platform, {})` and the row is today's. `FanoutDocument`'s type and key set are unchanged;
only the value domain of `reason` on a `synced` row grows. `sync-fanout.ts` takes `SyncThenRestart` as a type import from
`src/link/sync-then-restart.ts`, as it already imports `childSkipHint` from `src/link` (:4).

### src/cli/sync-link-status.ts

`:29` `fetch(`${base}/api/link/status`, ...)` → `fetch(`${base}/api/link/status?children=1`, ...)`. `validateStatus`
accepts `child` since wp2 (`src/cli/link.ts:168` allows the key, `:189` calls `validateChildOps`), and `ocx link
status` already sends the query (`link.ts:321`). An older Home ignores the query; rows then
lack `child`, which only matters with `--restart-children` (decision 4) or for the busy skip (no `activeJob` ⇒ no skip).
The `?children=1` read costs more than the plain one (`attachLinkChildOpsForState` flushes catalog pulls and reads
`child-observations.json`, `link-child-ops-routes.ts:127-142`); it stays inside `readHomeLinkStatus`'s 5 s deadline.

### Wording (source of truth first, then derived copies)

- `src/cli/capabilities-base.ts:786` before: "A current Home catalog fans out to linked Children. Fan-out never
  requests a Codex app or app-server restart on a Child; use GOAT or ocx sync --restart-codex there. Applying changed
  Home settings may restart the Child's own OpenCodex client runtime." After: "A current Home catalog fans out to
  linked Children; --child <linkId> (repeatable) limits it to those links. Fan-out requests no Codex restart on a
  Child unless --restart-children[=app-server|codex] is given; the Home then skips the restart, never the sync, for
  a Child with a model request in flight (restart-skipped:link-active), on Windows Children, and on ocx-child, and
  exits 6. Applying changed Home settings may restart the Child's own OpenCodex client runtime." The same entry's
  `usage` (the `ocx sync ...` string at `:790`) and `flags` (the list opening at `:772`) gain `--child` (string,
  repeatable) and `--restart-children` (optional value `app-server|codex`). The exit-6 detail at `:787` names the
  `restart-*` reasons beside the skipped Children.
- `src/cli/registry.ts:191` usage gains `[--child <linkId>]... [--restart-children[=app-server|codex]]`; `:195` is
  replaced by the sentence above minus the first clause (`:194` already says what `--local-only` and `--json` do).
- `src/cli/help.ts:52`: `ocx sync [--local-only] [--json] [--restart-codex] [--child <id>] [--restart-children]`.
- `docs-site/src/content/docs/reference/cli/lifecycle.md`: the `:592` heading usage gains both flags (the explicit
  `<span id=...>` anchor stays, so links keep working); `:609-612` becomes: "Fan-out requests no Codex restart on a
  Child unless you pass `--restart-children` (app-servers) or `--restart-children=codex --yes` (the Codex desktop app,
  which ends live conversations and needs a signed-in desktop session on that machine). The Home skips the restart,
  never the sync, for a Child that is relaying a model request at that moment (`restart-skipped:link-active`), for
  Windows Children and for `ocx-child`, and then exits 6. If the restart could not be sent, or was sent but its result
  is unknown, the Child's row reads `restart-not-run` or `restart-result-unknown` and the exit is also 6.
  `--child <linkId>` (repeatable) fans out only to those
  links; the others are reported `not-selected`. A Child busy with a Child operation is skipped as `child-busy`.
  The Child's pinned sync may still restart its own OpenCodex client runtime after applying changed Home settings.
  If the Home times out and stops its local SSH process, a remote sync already running may continue on the Child."
  The seven locale files listed in the change map get the same paragraph and heading in their language; a
  translator lane may do it, but the PR must not leave any locale stating "never requests a restart"
  (`docs-site/AGENTS.md`: translations must not contradict English).
- `structure/remote-link.md:9`: "...before executing `sync --expect-link` without a restart flag." → "...before
  executing `sync --expect-link`; the Home adds `--restart-app-server-only` or `--restart-codex` only for
  `ocx sync --restart-children`, never on Windows or `ocx-child`, and withholds it for a link whose relayed
  model traffic is in flight (`src/cli/sync-fanout.ts`, `src/link/sync-then-restart.ts`)." `:75`, which names
  `child-ops-runners.ts` as the runners' home, gains: "The sync-then-restart sequence both the runners and `ocx sync
  --restart-children` use is `src/link/sync-then-restart.ts`." `structure/cli-management.md:9` already describes
  the fan-out files for `src/cli/`: add one sentence there naming the two flags.
- `skills/ocx/references/05_remote_hub.md:325`: same rule in one sentence; `01_surface_lifecycle.md` regenerates.

## Field chains

| Field / value | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| `flags.children` | `parseSyncFanoutFlags` | N/A (in process) | N/A | `sync-command.ts` unknown-id check, `runHomeFanout` `selected` |
| `flags.restartChildren` | `parseSyncFanoutFlags` | Child argv `--restart-app-server-only` / `--restart-codex` (wp1 builder) | Child `readRestartScope` | Child `handleRestartScopeAfterWrite` |
| `reason: "not-selected"`, `"child-busy"` | `runHomeFanout` | `ocx.sync.fanout/1` `children[].reason` | GOAT and scripts parsing the document; `renderFanoutHuman` | exit rule (no hint ⇒ no 6) |
| `reason: restart-*` + `hint` on `synced` | `runHomeFanout` | same document | same | `fanoutExitCode` → 6; human line |
| `child.activity.inFlight`, `child.activeJob` | wp2 projection (`status-projection.ts:149-151`) | `/api/link/status?children=1` | `validateChildOps` (`link-status-child.ts:62-66`) via `validateStatus` and `readHomeLinkStatus` | `readActivity` → `syncThenRestart`; busy skip |
| `SyncThenRestart.withheld`, `.second`, verdict `executable` | `syncThenRestart`, `classifySyncResult` | N/A (in process; `runChild` picks schema fields) | N/A | `restartNote` → row `reason` |

## Tests

Revision 5 moves the sequence cases (activity read after the plain sync, failed re-read, selected-kind `ocx-child`,
not-run, result unknown) to the layer that owns them: `syncThenRestart` is covered through wp3's
`tests/clients/link-child-ops-runners.test.ts` (unchanged; it must stay green after the extraction, which proves the
wrapper changed nothing) and through `runChild` in the command test below. `runHomeFanout` cases check selection,
the busy skip, that `readActivity` reads status afresh, hints and the exit rule.

- `tests/cli/sync-fanout-select-restart.test.ts` (new, cli; fails before implementation because
  `runHomeFanout` ignores `selected`/`restartChildren` and the 3-argument `runChild` does not exist). Each case
  drives `runHomeFanout` with an in-memory store, a scripted `readLinkStatus` and a recording `runChild` that
  returns a scripted row and may call `options.readActivity`:
  - `--child runs only the selected link`: two connected links, `selected = {A}`; B is `skipped/not-selected`
    with no hint; `runChild` called once; exit 0.
  - `busy link is skipped`: row with `child.activeJob`; `skipped/child-busy`, no hint, no SSH.
  - `restart request reaches runChild`: with `restartChildren: "codex"`, `options.restart` is `"codex"`; without
    it `options.restart` is absent and `readActivity` is never called (no second status read).
  - `readActivity reads afresh` (decision 3): the first status read is idle, the second returns `inFlight: 1` for
    that link; `options.readActivity()` resolves `{ inFlight: 1, ... }`, so the first read is never reused.
  - `readActivity is unknown`: a row without `child` and a throwing re-read (4529522035) both resolve `null`.
  - `restart notes get hints and exit 6`: `runChild` returns `synced` with each `RestartNote`; each row carries
    `childRestartHint` and the exit is 6; a `synced` row with `reason: null` exits 0.
  - `restartNote table`: every row of the mapping table under `sync-command.ts`, including a failed plain sync on
    Windows and on `childKind: "ephemeral"` → `null` (the failure row stands).
  - `document keys unchanged`: a `runChild` result carrying `executable` still yields rows whose key set is a subset
    of `linkId, alias, state, reason, exit, hint`.
- `tests/cli/sync-command-child-flags.test.ts` (new, cli; fails before implementation):
  - `parse table`: `--child id`, `--child=id`, duplicate id (deduplicated), bad id, missing value,
    `--restart-children` bare/`=codex --yes`/`=desktop` (exit 2)/twice (exit 2), with `--local-only` (exit 2);
    `--restart-children=codex` without `--yes` (exit 2, message names `--yes`, no Home sync and no SSH); bare
    `--restart-children` without `--yes` is accepted.
  - `Home restart scope untouched`: `readRestartScope(["--restart-children=codex"])` is `{appServers:false, desktopApp:false}`.
  - `unknown --child exits 2 before the Home sync`: `runSyncCommand` with a temp `OPENCODEX_HOME` holding one
    link and `--child lnk_ffffffffffffffff`; exit 2 and the injected Home sync spy never runs (pattern of
    `tests/cli/sync-command-fanout.test.ts`).
  - `runChild runs the shared sequence`: `spyOn(processApi, "runFanoutProcess")` and `fanoutSshRunner` as in
    `tests/cli/sync-command-fanout.test.ts:218-219`, and a scripted local status (`readHomeLinkStatus` spied the same
    way). POSIX idle: two process calls, the first argv ending `--json`, the second `--json --restart-app-server-only`
    (`--restart-codex` for `=codex --yes`), row `synced`/`null`, exit 0. In flight: one call,
    `restart-skipped:link-active`, exit 6. Windows (`remotePlatform: "windows"`): one call with no restart token,
    `restart-skipped:windows`. Second call stderr with `ocx-fanout:selected-kind:ocx-child`:
    `restart-unsupported:ocx-child`. Second call exit 121 without the selection marker: `restart-not-run`. Second
    call exit 255: `synced`/`restart-result-unknown`, `exit` 255. No case's JSON row has an `executable` key.
- Status query: extend nothing in place; one case in the new command test asserts the fetched URL ends with
  `/api/link/status?children=1` (`readHomeLinkStatus` takes `fetchImpl`, `sync-link-status.ts:12`).

Registration (000 "Test registration rule"): both files as `"cli"`, one line each before the closing `}` of
`scripts/test-layout/layout-clients.json` (196 lines on 4e4d8d4206) and of `tests/fixtures/test-layout-expected.json`
(1669 lines); nothing goes into `layout.json` (1999 lines on 4e4d8d4206, one below the 2000 ratchet). Existing files that must stay green unchanged: `tests/clients/link-child-ops-runners.test.ts` (the extraction's proof), `tests/cli/sync-fanout.test.ts`,
`sync-command-fanout.test.ts`, `sync-fanout-process.test.ts`, `sync-link-status.test.ts`,
`cli-sync-expect-link.test.ts`, `cli-json-contract.test.ts`, `tests/update/update-sync-mutex.test.ts`,
`tests/clients/link-pinned-sync-argv.test.ts`, `tests/cli/cli-capabilities.test.ts`, `tests/ci-workflows/skill-ocx.test.ts`.

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk / wording |
| --- | --- | --- | --- | --- |
| skip restart while a relayed turn runs | runtime, Home | `syncThenRestart` (called from `runChild`) after each Child's plain sync, with `runHomeFanout`'s per-Child `readActivity` (Revision 4, 5) | a turn that starts between the per-Child status read and the Child's restart (one loopback request plus one SSH round trip of a no-op sync; the catalog sync itself now runs before the read); traffic the Home does not relay (a Child user composing locally) | docs say "skips the restart for a Child that is relaying a model request at that moment", never "never interrupts a turn" |
| unknown activity is never idle | runtime, Home | `readActivity` → `null` for a missing row, a missing `child` block or a failed read | a Home listener without an activity book projects `inFlight: 0` on the wire (`status-projection.ts:149-150`), which reads as idle; the Home's link listener always has one (`link-listener.ts:93`, `:237`) | decision 8; wp3's in-process path still sees `null` and withholds |
| an unknown restart result is not reported as success | runtime, Home | `restartNote` → `restart-result-unknown`, exit 6 | none | the hint asks the operator to check Codex on that machine |
| no restart on Windows / `ocx-child` | runtime, Home | `runChild`, `runHomeFanout` | none: the flag is never sent | — |
| Home's own scope unaffected | parse rule | `readRestartScope` exact tokens | none | — |
| unknown `--child` refused | runtime, Home | `runSyncCommand` | an id removed between the check and fan-out reads `link-not-in-runtime` or is absent from the store | harmless |

## Verifiers

| Command | Today | Reads this phase's target |
| --- | --- | --- |
| `bun test tests/cli/sync-command-fanout.test.ts tests/cli/sync-link-status.test.ts tests/cli/sync-fanout-process.test.ts tests/cli/cli-json-contract.test.ts tests/cli/sync-fanout.test.ts tests/clients/link-child-ops-runners.test.ts tests/clients/link-pinned-sync-argv.test.ts` | ran on 4e4d8d4206 (revision 5): 117 pass, 2 skip, 0 fail, 119 tests across 7 files, exit 0 | yes: `sync-command.ts`, `sync-fanout.ts`, `sync-link-status.ts`, the JSON contract, wp3's sequence, the restart argv |
| `bun test tests/cli/cli-sync-expect-link.test.ts tests/update/update-sync-mutex.test.ts` | ran (with link-ssh-argv): 83 pass, 1 skip, 0 fail, exit 0 | yes: Child-side sync and mutex the restart rides on |
| `bun test tests/cli/sync-fanout-select-restart.test.ts tests/cli/sync-command-child-flags.test.ts` | new; fail before implementation | new behaviour |
| `bun run skill:surface:check` | ran: exit 0 (current) | `capabilities-base.ts:786` → `01_surface_lifecycle.md` |
| `bun test tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts` | ran in the 020 batch: 0 fail | flag/route parity, hand pages |
| `rg -n -i "never requests a Codex\|Fan-out never\|without a restart flag" src skills structure docs-site` | ran on 4e4d8d4206: 6 hits (lifecycle.md:609, 05_remote_hub.md:325, 01_surface_lifecycle.md:110, capabilities-base.ts:786, registry.ts:195, structure/remote-link.md:9); must be 0 English hits after the change, and each locale's paragraph is rewritten | wording sync |
| `bun run typecheck` | ran on 4e4d8d4206: exit 0 (2,402 files) | all `src/` |
| `bun run structure:check` | revision 1: exit 1 on 00680193cb (an unrelated 603-line doc); audit r1 on 61151e3457: exit 0 | `structure/remote-link.md`, `cli-management.md` |

## Acceptance criteria

1. `ocx sync --json` without new flags prints the same document as today for the same inputs (existing tests).
2. `ocx sync --child A --json` with links A and B syncs only A; B reads `skipped/not-selected` without a hint; exit 0.
3. `ocx sync --child lnk_<unknown>` exits 2 and the Home catalog is not touched.
4. `ocx sync --restart-children` on an idle POSIX full Child sends exactly `--restart-app-server-only` after `--json`;
   `=codex` sends `--restart-codex`; the Home's own Codex is not restarted.
5. With a relayed request in flight on that link (`child.activity.inFlight > 0` at the per-Child read), the Child
   syncs without a restart flag, the row reads `synced`/`restart-skipped:link-active` with a hint, and the exit is 6.
6. A Child held by a Child operation is `skipped/child-busy` with no SSH and no exit 6.
7. Windows and `ocx-child` Children never receive a restart flag and report their note.
8. No English source, generated skill page or locale page still says fan-out never requests a restart.
9. After the extraction, `tests/clients/link-child-ops-runners.test.ts` passes unchanged, and `src/link/child-ops-runners.ts`
   no longer contains the sequence or the F2 code list (one implementation, decision 7).
10. A restarting sync that certainly ran nothing reports `restart-not-run`; one whose result is unknown reports
    `synced`/`restart-result-unknown` with the second run's `exit`; both exit 6 and neither row carries `executable`.

## Security notes, risks and Windows

The new flags add no route and no credential: they change two tokens in a command that already runs over the
pinned channel, and the Child applies its own restart rules (`readRestartScope` narrow-wins,
`handleRestartScopeAfterWrite` only after a write). The risk is ending running turns on another machine; it is
bounded by the explicit opt-in, the app-server default, the A2 skip and the exit-6 signal. `codex` scope
relaunches the desktop app from an SSH session, which needs a logged-in GUI session and is reported only as
requested (004 assumption 2). Windows: sync and `--child` are supported; restart is refused with
`restart-skipped:windows` (D20: no interactive desktop from an OpenSSH session, and the app-server signal path
is unproven there).

NOT RUN: full `bun run test` (shared host), `bun run lint:i18n` (no `gui/` change).

## wp4 P re-verification (base dev 4e4d8d4206)

Checked on `codex/link-child-updates-wp4` at 4e4d8d42061765fe05d1d4a3db8eb52e9e9d1233 (= `origin/dev`, with wp1 #8505,
wp2 #8508 and wp3 #8513 merged). Revision 5 above carries the fixes; this section records what was checked.

**Stale anchors fixed.** `ChildResult` `sync-fanout.ts:85` → `:11`; status read `:119` → `:34`; exit rule
`:153-156` → `:70-73`; worker loop `:127-147` → `:42-64`; strict 4-key check `sync-fanout.ts:28-40` → moved by wp1 to
`validDocument`, `src/link/sync-fanout-classify.ts:45-57`; Child restart after write `sync-command.ts:237-243` →
`:239-245`; fan-out call `:207-226` → `:207-228`; `registry.ts:186/:190` → `:191/:195`; `layout.json` 1998 → 1999
lines; `layout-clients.json` 196 and `test-layout-expected.json` 1669 lines; sizes (`sync-command.ts` 245,
`sync-fanout.ts` 78, not 85). Still accurate: `sync-command.ts:18-19`, `:21`, `:213`; `restart-scope.ts:35-37`;
`sync-link-status.ts:12`, `:29`; `capabilities-base.ts:786`, `:790`; `help.ts:52`; `lifecycle.md:592`, `:609-612`
and every locale line pair; `structure/remote-link.md:9`; `05_remote_hub.md:325`; `01_surface_lifecycle.md:110`;
`native/ocx-child/src/cli.rs:1211-1215`; `sync-expectation.ts:21`.

**Names and types confirmed.** `remotePinnedSyncArgv(linkId, platform = "posix", opts: PinnedSyncOptions = {})` with
`opts.restart?: ChildRestartRequest` and the Windows refusal `LinkSshArgumentError("unsupported:windows-restart")`
(`ssh-argv.ts:478-490`); `classifySyncResult(result, { expectSelectedKind })` returns `ChildVerdict` with optional
`executable: "ocx-child"` only when asked (`sync-fanout-classify.ts:14`, `:63-83`); `child.activity` is
`{ idle, inFlight, lastDataEndAt }` and `child.activeJob` is `{ jobId, op, state } | null`
(`src/cli/link-status-child.ts:15-18`, `:62-66`). Revision 4's draft read `second.executable` from `runChild`, which
wp1's fix now strips at `sync-command.ts:220-222`; the sequence therefore moves below that pick (decision 7).

**wp1 note folded: already done.** `ChildVerdict.executable` cannot reach `ocx.sync.fanout/1` on the merged base:
`runChild` returns only `{ state, reason, exit }` (`sync-command.ts:220-222`) and `runHomeFanout` rebuilds each row
from schema fields (`sync-fanout.ts:59-61`). wp4 keeps both picks and adds a test with an `executable`-carrying result.

**Reuse decision.** Decision 7: one implementation, `src/link/sync-then-restart.ts`, extracted from wp3's
`syncWithRestart` and F2 rule and called by both the runners and the CLI `runChild`. It also brings the CLI to wp3's
outcome set, so two outcomes the revision 4 draft folded into a failed row become `restart-not-run` and
`restart-result-unknown` on a `synced` row (the catalog did sync). Decision 8 records the wire's `inFlight: 0` collapse.

**Earlier decisions kept.** Repeatable `--child`; unknown id exits 2 before the Home sync; unselected rows
`skipped/not-selected` without a hint or exit 6; `--restart-children[=app-server|codex]`, bare = `app-server`, `codex`
needs `--yes`; A2 withholding per link; no new key in the Child's strict 4-key document or in `ocx.sync.fanout/1`;
Windows and `ocx-child` never receive a restart flag; an old Home without `child` withholds; the wording targets.

**Commands run (this re-verification).**

- `bun test tests/cli/sync-command-fanout.test.ts tests/cli/sync-link-status.test.ts tests/cli/sync-fanout-process.test.ts tests/cli/cli-json-contract.test.ts tests/cli/sync-fanout.test.ts tests/clients/link-child-ops-runners.test.ts tests/clients/link-pinned-sync-argv.test.ts`:
  117 pass, 2 skip, 0 fail, 466 expect() calls, 119 tests across 7 files, exit 0.
- `bun run typecheck`: "No type errors in 2,402 files", exit 0.
- `rg` wording hits: 6, listed in the Verifiers table.

NOT RUN: full `bun run test`, `bun run structure:check` and `bun run skill:surface:check` (no source, structure or
capability change in this pass; they run in the wp4 build).


## Revision 6 (wp4 plan audit, base 4e4d8d4206)

Audit verdict GO-WITH-FIXES (blockers 4, no High/Critical). All findings accepted; binding on the implementation:

1. **Blocker.** Before the second (restarting) `runPinned`, if the shared deadline is spent (`deadline - now <= 0`), the
   sequence returns `notRun: true` (restart reason `restart-not-run`), because nothing reached the Child. Test: a first sync
   that consumes the deadline yields `restart-not-run`, never `restart-result-unknown`.
2. **Blocker. Default-path change stated honestly.** Every Home fan-out (with or without flags) now reads
   `GET /api/link/status?children=1` and skips a Child that holds an active job as `child-busy` (no hint, not exit 6). The
   Outcome line and acceptance criterion 1 say so. A `child` block that fails validation is treated as absent for that row
   (no busy skip, restarts withheld with `restart-skipped:activity-unknown`), never as a failure of the whole status read;
   the other rows are unaffected. Tests: no-flags fan-out skips a busy Child as `child-busy`; a malformed `child` block on
   one row leaves the other rows' results unchanged.
3. **Blocker.** `lifecycle.md` (`:600-602`) and `capabilities-base.ts:787` (and the 7 locale copies of lifecycle.md) list
   `not-selected` and `child-busy` as intentional skips that do not cause exit 6.
4. **Blocker.** The sync capability gains a `--yes` flag entry; `--child` and `--restart-children` are declared with
   `value: "string"`, their summaries stating "repeatable" and "bare means app-server"; registry usage, help line and the
   regenerated skill page show `--yes` for `--restart-children=codex`.
5. Low. `child-ops-runners.ts` imports `RESTART_RESULT_UNKNOWN` from `sync-then-restart.ts` (and re-exports only if an
   external importer exists; none today).
6. Low. Wording: a link whose `childKind` is not recorded can receive the restart flag on the second sync, which is how the
   selected-kind marker is learned; `ocx-child` ignores it (`native/ocx-child/src/cli.rs:1211-1215`). Acceptance criterion 7,
   the enforcement table and `structure/remote-link.md:9` say exactly this.
7. Low. Selection is applied first in every branch of `runHomeFanout` (Home sync failed, status unavailable or invalid):
   unselected links always report `not-selected`.
8. Low. The `restart-skipped:activity-unknown` hint says the Home could not read the Child's activity (status read failed,
   timed out, or the Home predates activity reporting) and to retry `ocx sync --child <id> --restart-children`; it only
   suggests updating the Home when the `child` block is absent.
9. Low. `guides/remote-link.md` (Home-side restart paragraph) and its 7 translations mention `ocx sync --restart-children`
   as the fan-out form with the same activity guard.

