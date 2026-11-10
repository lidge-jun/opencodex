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

- **Work phase:** wp4. **Depends on:** wp1 (`remotePinnedSyncArgv(linkId, platform, opts)`, the classifier in
  `src/link/sync-fanout-classify.ts`), wp2 (`GET /api/link/status?children=1` with `child.activity` and
  `child.activeJob`, and `validateStatus` accepting `child`). **Class:** C3, promoted to C4 for the
  `sync.home-fanout/1` document change and because the Home can now end running turns on another machine.
- **Outcome:** on a Home, `ocx sync --child <linkId>` (repeatable) fans out only to the named links, and
  `ocx sync --restart-children[=app-server|codex]` asks each selected Child to restart its Codex
  app-servers (default) or the Codex app after its pinned sync. Following amendment A2, the Home skips the
  restart, never the sync, for a Child with a relayed model request in flight and reports
  `restart-skipped:link-active`. Fan-out also skips a Child that a Child operation (wp2/wp3 job) holds.
  Without the new flags the behaviour and the JSON document are exactly today's.
- **IN:** `src/cli/sync-flags.ts`, `src/cli/sync-command.ts` (`runChild`), `src/cli/sync-fanout.ts` (filter,
  restart decision, exit rule), `src/cli/sync-link-status.ts` (`children=1`), wording in
  `capabilities-base.ts:786`, `registry.ts:186-190`, `help.ts:52`, `lifecycle.md:592-612` + 7 locales,
  `structure/remote-link.md:9`, `skills/ocx`, tests.
- **OUT:** any Child-side change (the Child already honours both restart tokens since 2.54/2.93, F2); a restart
  outcome marker (wp8); Windows Child restarts (refused, D20); `ocx link restart-codex` (wp3).

## Decisions and deviations from 004

1. **How a skipped restart is reported (A2).** The Child's own `--json` output must stay the 4-key
   `ocx.sync.fanout/1` document, because older Homes classify any other key set as `child-output-invalid`
   (`src/cli/sync-fanout.ts:28-40`). The restart flags do not change it: under `--json` the Child routes
   restart text to stderr (`sync-command.ts:21`) and the restart happens after the catalog write
   (`sync-command.ts:237-243`). The Home reports its own decision in the Home's document, on the existing
   `ChildResult` (`sync-fanout.ts:85`) without a new key: a Child whose sync succeeded but whose restart
   was withheld is `{ state: "synced", reason: "restart-skipped:link-active", hint }`. Today `reason` is
   always `null` for `synced`; a consumer that branches on `state` keeps working. The same carrier holds
   `restart-skipped:activity-unknown` (the Home runtime answered without `child`), `restart-skipped:windows`
   and `restart-unsupported:ocx-child` (`ocx-child` accepts and ignores the flags,
   `native/ocx-child/src/cli.rs:1211-1215`).
2. **Exit 6 for a withheld restart (refinement of D16).** The operator asked for a restart that did not
   happen, so `fanoutExitCode` returns 6 for a `synced` row whose `reason` starts with `restart-`, exactly as
   it does for a hinted skip (`sync-fanout.ts:153-156`). `not-selected` and `child-busy` rows carry no hint and
   keep exit 0, as D16 and D8 specify.
3. **Activity is re-read per Child, not once.** `runHomeFanout` reads status once (`sync-fanout.ts:119`).
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

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| src/cli/sync-flags.ts | MODIFY (:1-10) | parse `--child`, `--restart-children`; reject conflicts |
| src/cli/sync-command.ts | MODIFY (:18-19, :207-226) | unknown-id check before the Home sync; pass selection and restart; `runChild` options |
| src/cli/sync-fanout.ts | MODIFY (`runHomeFanout`, `fanoutExitCode`, `childSkipHint`) | filter, busy skip, restart decision, exit rule |
| src/cli/sync-link-status.ts | MODIFY (:29) | `?children=1` |
| src/cli/capabilities-base.ts | MODIFY (:786, usage line, flags) | wording and the two flags |
| src/cli/registry.ts | MODIFY (:186, :190) | usage and wording |
| src/cli/help.ts | MODIFY (:52) | one-line usage |
| docs-site/src/content/docs/reference/cli/lifecycle.md | MODIFY (:592, :609-612) | heading usage, restart paragraph |
| docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/cli/lifecycle.md | MODIFY | fr :166/:170, ja :173/:177, ko :261/:265, ru :262/:266, tr :259/:263, zh-cn :169/:173, zh-tw :161/:165 |
| structure/remote-link.md | MODIFY (:9) | "without a restart flag" → opt-in restart |
| skills/ocx/references/05_remote_hub.md | MODIFY (:325) | hand page wording |
| skills/ocx/references/01_surface_lifecycle.md | REGENERATE | `bun run skill:surface` (line 110 comes from `capabilities-base.ts:786`) |
| tests/cli/sync-fanout-select-restart.test.ts | NEW | pure fan-out cases |
| tests/cli/sync-command-child-flags.test.ts | NEW | flags and `runChild` argv |

Sizes: `sync-command.ts` 243 → about 262, `sync-fanout.ts` about 85 after wp1 → about 125, `sync-flags.ts` 10 → about 45.

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

### src/cli/sync-command.ts

Before (`:18-19` and `:207-226`, abridged):

```ts
    const flags = parseSyncFanoutFlags(deps.args.slice(1));
    if (!flags.ok) { console.error(flags.message); return 2; }
...
    const document = await runHomeFanout({
      home: { state, exit: code }, catalogCurrent, localOnly: flags.localOnly, applicable,
      readStore: () => readLinkStore(linkStorePath()), readLinkStatus: () => readHomeLinkStatus(),
      runChild: async (link, deadline) => {
        ...
          const result = await runFanoutProcess(buildExecArgv({ alias: link.alias, knownHostsFile: linkKnownHostsPath(), argv: remotePinnedSyncArgv(link.id, platform) }), { timeoutMs: Math.max(0, deadline - Date.now()) });
          return { ...classifySyncResult(result), exit: result.code };
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
        ...platform discovery unchanged...
        const windowsSkip = options.restart !== undefined && platform === "windows";
        const restart = windowsSkip ? {} : options.restart === undefined ? {} : { restart: options.restart };
        try {
          const result = await runFanoutProcess(buildExecArgv({ alias: link.alias, knownHostsFile: linkKnownHostsPath(),
            argv: remotePinnedSyncArgv(link.id, platform, restart) }), { timeoutMs: Math.max(0, deadline - Date.now()) });
          return { ...classifySyncResult(result), exit: result.code, ...(windowsSkip ? { restartNote: "restart-skipped:windows" as const } : {}) };
        } ...unchanged catch...
      },
    });
```

### src/cli/sync-fanout.ts

```ts
export type RestartNote = "restart-skipped:link-active" | "restart-skipped:activity-unknown" | "restart-skipped:windows" | "restart-unsupported:ocx-child";
type ChildRun = Omit<ChildResult, "linkId" | "alias"> & { restartNote?: RestartNote };

export async function runHomeFanout(deps: {
  ...existing fields...
  selected?: ReadonlySet<string> | null;
  restartChildren?: ChildRestartRequest | null;
  runChild: (link: LinkRecord, deadline: number, options: { restart?: ChildRestartRequest }) => Promise<ChildRun>;
}): Promise<FanoutDocument>;
```

Worker loop (`sync-fanout.ts:127-147`), after `const link` and the client-initiated `continue`:

```ts
      if (deps.selected && !deps.selected.has(link.id)) { result.children[index] = classify(link, "skipped", "not-selected"); continue; }
      let wire = status.links.find(row => row.id === link.id);
      if (!wire) { ...unchanged link-not-in-runtime... }
      if (wire.state !== "connected") { ...unchanged tunnel-<state>... }
      if (wire.child?.activeJob) { result.children[index] = classify(link, "skipped", "child-busy"); continue; }
      let options: { restart?: ChildRestartRequest } = {}, note: RestartNote | undefined;
      if (deps.restartChildren && link.childKind === "ephemeral") note = "restart-unsupported:ocx-child";
      ...race unchanged, calling deps.runChild(link, deadline, {}) (the plain sync, never a restart)...
      // Revision 4 (4529521916): activity is read after the sync, then the restart goes out as a second pinned sync.
      if (deps.restartChildren && !note && run.state === "synced") {
        let fresh: typeof wire | undefined;
        // 4529522035: a failed re-read means activity is unknown; the first read is not reused.
        try { fresh = (await deps.readLinkStatus()).links.find(row => row.id === link.id); } catch { fresh = undefined; }
        const activity = fresh?.child?.activity;
        if (!activity) note = "restart-skipped:activity-unknown";
        else if (activity.inFlight > 0) note = "restart-skipped:link-active";
        else {
          // ...race again within the same deadline:
          const second = await deps.runChild(link, deadline, { restart: deps.restartChildren });
          // 4529522026: ocx-child ignores the flag; 010's selected-kind marker tells us even without childKind.
          if (second.executable === "ocx-child") note = "restart-unsupported:ocx-child";
          else if (second.state !== "synced") run = { ...second, restartNote: second.restartNote };
        }
      }
      const { restartNote, ...child } = run;
      const finalNote = note ?? restartNote;
      result.children[index] = child.state === "synced" && finalNote
        ? { linkId: link.id, alias: link.alias, ...child, reason: finalNote, hint: childRestartHint(finalNote, link.alias) }
        : { linkId: link.id, alias: link.alias, ...child, ...(child.state === "skipped" ? { hint: childSkipHint(child.reason, link.alias) } : {}) };
```

```ts
function childRestartHint(note: RestartNote, alias: string): string {
  if (note === "restart-skipped:link-active") return `A model request was running on ${alias}; its Codex was not restarted. Retry when it is idle.`;
  if (note === "restart-skipped:activity-unknown") return "Restart this Home's OpenCodex runtime so it reports Child activity, then retry.";
  if (note === "restart-skipped:windows") return "Codex restarts over SSH are not supported on Windows Children; restart Codex on that machine.";
  return "ocx-child does not restart Codex; restart the Codex app or its app-servers on that machine.";
}

export function fanoutExitCode(document: FanoutDocument): number {
  if (document.home.exit !== 0) return document.home.exit;
  return document.fanout.state === "failed" || document.children.some(child => child.state === "failed" || child.state === "timed-out"
    || (child.state === "skipped" && child.hint !== undefined)
    || (child.state === "synced" && child.reason?.startsWith("restart-") === true)) ? SYNC_FANOUT_PARTIAL_EXIT : 0;
}
```

`FanoutDocument`'s type and key set are unchanged; only the value domain of `reason` on a `synced` row grows.

### src/cli/sync-link-status.ts

`:29` `fetch(`${base}/api/link/status`, ...)` → `fetch(`${base}/api/link/status?children=1`, ...)`. `validateStatus`
already accepts `child` after wp2 (`020_signals_visibility.md`). An older Home ignores the query; rows then
lack `child`, which only matters with `--restart-children` (decision 4) or for the busy skip (no `activeJob` ⇒ no skip).

### Wording (source of truth first, then derived copies)

- `src/cli/capabilities-base.ts:786` before: "A current Home catalog fans out to linked Children. Fan-out never
  requests a Codex app or app-server restart on a Child; use GOAT or ocx sync --restart-codex there. Applying changed
  Home settings may restart the Child's own OpenCodex client runtime." After: "A current Home catalog fans out to
  linked Children; --child <linkId> (repeatable) limits it to those links. Fan-out requests no Codex restart on a
  Child unless --restart-children[=app-server|codex] is given; the Home then skips the restart, never the sync, for
  a Child with a model request in flight (restart-skipped:link-active), on Windows Children, and on ocx-child, and
  exits 6. Applying changed Home settings may restart the Child's own OpenCodex client runtime." The same entry's
  `usage` (the `ocx sync ...` string at `:790`) and `flags` gain `--child` (string, repeatable) and
  `--restart-children` (optional value `app-server|codex`).
- `src/cli/registry.ts:186` usage gains `[--child <linkId>]... [--restart-children[=app-server|codex]]`; `:190` is
  replaced by the sentence above minus the first clause.
- `src/cli/help.ts:52`: `ocx sync [--local-only] [--json] [--restart-codex] [--child <id>] [--restart-children]`.
- `docs-site/src/content/docs/reference/cli/lifecycle.md`: the `:592` heading usage gains both flags (the explicit
  `<span id=...>` anchor stays, so links keep working); `:609-612` becomes: "Fan-out requests no Codex restart on a
  Child unless you pass `--restart-children` (app-servers) or `--restart-children=codex --yes` (the Codex desktop app,
  which ends live conversations and needs a signed-in desktop session on that machine). The Home skips the restart,
  never the sync, for a Child that is relaying a model request at that moment (`restart-skipped:link-active`), for
  Windows Children and for `ocx-child`, and then exits 6. `--child <linkId>` (repeatable) fans out only to those
  links; the others are reported `not-selected`. A Child busy with a Child operation is skipped as `child-busy`.
  The Child's pinned sync may still restart its own OpenCodex client runtime after applying changed Home settings.
  If the Home times out and stops its local SSH process, a remote sync already running may continue on the Child."
  The seven locale files listed in the change map get the same paragraph and heading in their language; a
  translator lane may do it, but the PR must not leave any locale stating "never requests a restart"
  (`docs-site/AGENTS.md`: translations must not contradict English).
- `structure/remote-link.md:9`: "...before executing `sync --expect-link` without a restart flag." → "...before
  executing `sync --expect-link`; the Home adds `--restart-app-server-only` or `--restart-codex` only for
  `ocx sync --restart-children`, never on Windows or `ocx-child`, and withholds it for a link whose relayed
  model traffic is in flight (`src/cli/sync-fanout.ts`)." Owned by `structure/cli-management.md` for `src/cli/`
  too: add one sentence there naming the two flags.
- `skills/ocx/references/05_remote_hub.md:325`: same rule in one sentence; `01_surface_lifecycle.md` regenerates.

## Field chains

| Field / value | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| `flags.children` | `parseSyncFanoutFlags` | N/A (in process) | N/A | `sync-command.ts` unknown-id check, `runHomeFanout` `selected` |
| `flags.restartChildren` | `parseSyncFanoutFlags` | Child argv `--restart-app-server-only` / `--restart-codex` (wp1 builder) | Child `readRestartScope` | Child `handleRestartScopeAfterWrite` |
| `reason: "not-selected"`, `"child-busy"` | `runHomeFanout` | `ocx.sync.fanout/1` `children[].reason` | GOAT and scripts parsing the document; `renderFanoutHuman` | exit rule (no hint ⇒ no 6) |
| `reason: restart-*` + `hint` on `synced` | `runHomeFanout` | same document | same | `fanoutExitCode` → 6; human line |
| `child.activity.inFlight`, `child.activeJob` | wp2 projection | `/api/link/status?children=1` | `validateStatus` (wp2) via `readHomeLinkStatus` | restart decision, busy skip |
| `restartNote` | `runChild` (Windows) | N/A (stripped before output) | N/A | merged into `reason` |

## Tests

- `tests/cli/sync-fanout-select-restart.test.ts` (new, cli; fails before implementation because
  `runHomeFanout` ignores `selected`/`restartChildren` and the 3-argument `runChild` does not exist). Each case
  drives `runHomeFanout` with an in-memory store, a scripted `readLinkStatus` and a recording `runChild`:
  - `--child runs only the selected link`: two connected links, `selected = {A}`; B is `skipped/not-selected`
    with no hint; `runChild` called once; exit 0.
  - `busy link is skipped`: row with `child.activeJob`; `skipped/child-busy`, no hint, no SSH.
  - `idle link gets the restart`: `child.activity.inFlight: 0`; `runChild` receives `{}` and then
    `{restart: "app-server"}` (Revision 4: sync first, restart second); row `synced`, `reason null`, exit 0.
  - `active link syncs without restart` (A2): the second status read returns `inFlight: 1`; `runChild` receives
    `{}`; row `synced`/`restart-skipped:link-active` with hint; exit 6.
  - `a turn that starts after the first read is seen`: first read idle, second read `inFlight: 1` → withheld
    (proves the per-Child re-read).
  - `missing child block withholds`: rows without `child` → `restart-skipped:activity-unknown`.
  - `failed re-read withholds` (Revision 4, 4529522035): first read idle, the re-read throws →
    `restart-skipped:activity-unknown`, `runChild` called once with `{}`, exit 6.
  - `ocx-child without childKind` (Revision 4, 4529522026): no `childKind`; the second `runChild` returns
    `executable: "ocx-child"` → `synced`/`restart-unsupported:ocx-child` with hint, exit 6.
  - `ocx-child withholds`: `childKind: "ephemeral"` → `restart-unsupported:ocx-child`, no status re-read.
  - `Windows note is merged`: `runChild` returns `restartNote: "restart-skipped:windows"` → reason set, exit 6.
  - `failed sync keeps its own reason`: `runChild` fails with `child-sync-failed` while a note exists → the failure wins.
  - `document keys unchanged`: every child row's key set is a subset of `linkId, alias, state, reason, exit, hint`.
- `tests/cli/sync-command-child-flags.test.ts` (new, cli; fails before implementation):
  - `parse table`: `--child id`, `--child=id`, duplicate id (deduplicated), bad id, missing value,
    `--restart-children` bare/`=codex --yes`/`=desktop` (exit 2)/twice (exit 2), with `--local-only` (exit 2);
    `--restart-children=codex` without `--yes` (exit 2, message names `--yes`, no Home sync and no SSH); bare
    `--restart-children` without `--yes` is accepted.
  - `Home restart scope untouched`: `readRestartScope(["--restart-children=codex"])` is `{appServers:false, desktopApp:false}`.
  - `unknown --child exits 2 before the Home sync`: `runSyncCommand` with a temp `OPENCODEX_HOME` holding one
    link and `--child lnk_ffffffffffffffff`; exit 2 and the injected Home sync spy never runs (pattern of
    `tests/cli/sync-command-fanout.test.ts`).
  - `runChild argv carries the token`: capture the `buildExecArgv` argv for POSIX (last args
    `--json --restart-app-server-only`) and Windows (`windowsScriptData` args) and none for a Windows restart.
- Status query: extend nothing in place; one case in the new command test asserts the fetched URL ends with
  `/api/link/status?children=1` (`readHomeLinkStatus` takes `fetchImpl`, `sync-link-status.ts:12`).

Registration (000 "Test registration rule"): both files as `"cli"`, one line each before the closing `}` of
`scripts/test-layout/layout-clients.json` and of `tests/fixtures/test-layout-expected.json`; nothing goes into
`layout.json` (1998 lines, the ratchet fails at 2000). Existing files that must stay green unchanged: `tests/cli/sync-fanout.test.ts`,
`sync-command-fanout.test.ts`, `sync-fanout-process.test.ts`, `sync-link-status.test.ts`,
`cli-sync-expect-link.test.ts`, `cli-json-contract.test.ts`, `tests/update/update-sync-mutex.test.ts`,
`tests/clients/link-pinned-sync-argv.test.ts`, `tests/cli/cli-capabilities.test.ts`, `tests/ci-workflows/skill-ocx.test.ts`.

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk / wording |
| --- | --- | --- | --- | --- |
| skip restart while a relayed turn runs | runtime, Home | `runHomeFanout` after each Child's plain sync (Revision 4) | a turn that starts between the per-Child status read and the Child's restart (one loopback request plus one SSH round trip of a no-op sync; the catalog sync itself now runs before the read); traffic the Home does not relay (a Child user composing locally) | docs say "skips the restart for a Child that is relaying a model request at that moment", never "never interrupts a turn" |
| no restart on Windows / `ocx-child` | runtime, Home | `runChild`, `runHomeFanout` | none: the flag is never sent | — |
| Home's own scope unaffected | parse rule | `readRestartScope` exact tokens | none | — |
| unknown `--child` refused | runtime, Home | `runSyncCommand` | an id removed between the check and fan-out reads `link-not-in-runtime` or is absent from the store | harmless |

## Verifiers

| Command | Today | Reads this phase's target |
| --- | --- | --- |
| `bun test tests/cli/sync-command-fanout.test.ts tests/cli/sync-link-status.test.ts tests/cli/sync-fanout-process.test.ts tests/cli/cli-json-contract.test.ts tests/cli/sync-fanout.test.ts` | ran 2026-11-11: 38 pass, 1 skip, 0 fail, exit 0 | yes: `sync-command.ts`, `sync-fanout.ts`, `sync-link-status.ts`, the JSON contract |
| `bun test tests/cli/cli-sync-expect-link.test.ts tests/update/update-sync-mutex.test.ts` | ran (with link-ssh-argv): 83 pass, 1 skip, 0 fail, exit 0 | yes: Child-side sync and mutex the restart rides on |
| `bun test tests/cli/sync-fanout-select-restart.test.ts tests/cli/sync-command-child-flags.test.ts` | new; fail before implementation | new behaviour |
| `bun run skill:surface:check` | ran: exit 0 (current) | `capabilities-base.ts:786` → `01_surface_lifecycle.md` |
| `bun test tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts` | ran in the 020 batch: 0 fail | flag/route parity, hand pages |
| `rg -n -i "never requests a Codex\|Fan-out never" src skills structure docs-site` | ran: 5 hits (lifecycle.md:609, 05_remote_hub.md:325, 01_surface_lifecycle.md:110, capabilities-base.ts:786, registry.ts:190); must be 0 English hits after the change, and each locale's paragraph is rewritten | wording sync |
| `bun run typecheck` | ran: exit 0 | all `src/` |
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
