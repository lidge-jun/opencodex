# 10 — Home `ocx sync` fans out to linked Children (C2, `sync.home-fanout/1`)

Class C4 (public CLI contract: new flags, a new JSON schema, a new exit code, a new capability
field). Single work-phase `wp1`. Sibling lanes: L1 `ocx update` orchestration (shares the capability
contracts list) and L3, the GOAT consumer.

Revision 8 folds the round-7 audit: each candidate's `--version` runs once, in the background,
under a 10 s kill watchdog and a size bound, and that one run both selects and versions the
candidate; Windows reads through a new bounded C# helper; the capture file is removed before `exec`;
failed candidates fall through as today. It also reserves exit 7 for L1's sync/update mutex.
Revision 7 folded the round-6 audit: the POSIX version capture keeps the real exit status and is
size-limited with `ulimit -f` instead of a `head` pipeline.
Revision 6 folded the round-5 audit: the capability probe is removed (it could run shim repair
before the link check and buffered unbounded output on the Child). Children now identify themselves
by their own sync output, and success needs positive evidence in both forms. The wrapper's version
capture is bounded.
Revision 5 folded the round-4 audit (JSON support is probed from the selected executable, not
inferred from its version; best-effort store inspection on the thrown-Home path).
Revision 4 folded the round-3 audit (version marker and fail-closed modern output, exit 0 required
for success, thrown Home sync in human mode, strict SemVer bound, Windows execution tests).
Revision 3 folded the round-2 audit (single remote operation, machine-readable freshness, catalog
gate, bounded status deadline, termination-unconfirmed, store failure, restart wording).
Revision 2 folded the round-1 audit (terra xhigh, FAIL) and the origin's decision on its blocker:
`--restart-children` is removed (option A). Home fan-out never restarts a Child's Codex; restart
authority stays with GOAT, which knows real running turns, or with an operator running
`ocx sync --restart-codex` on the Child.

## Problem

To sync a Remote Link Home and its Children, GOAT or an operator has to SSH to every Child and run
`ocx sync --expect-link <linkId>` there. An operator who types `ocx sync` on the Home refreshes only
the Home, so Children keep a stale catalog until someone syncs them one by one.

## Contract

### When propagation runs

- Only on the local branch of the `sync` runner (the machine is not a connected client) and only
  without `--expect-link`/`--expect-hub-key`. A connected client never propagates. The pinned form is
  the call a Home makes into a Child, so a chain cannot recurse.
- On by default; `--local-only` turns it off (accepted and a no-op on every other path).
- Only when the Home sync committed a current catalog: exit 0, `synced.status` is `applied` or
  `catalog-only`, `synced.refreshOutcome === "committed"`, and `projectLocalSyncResult(synced).catalog.converged`
  (catalog exists, not refused, no safety warning). An exit-0 run without that evidence (a refused or
  thrown catalog refresh, `refreshOutcome` absent) skips every Child with `home-catalog-not-current` and
  keeps the Home exit. The implementation must confirm with a test that an unchanged catalog reports
  `committed`; if it does not, the gate uses the evidence the unchanged path does report, never weaker. A Child's
  `/v1/catalog` fetch serializes the Home's persisted Codex catalog
  (`src/server/index/serve-options.ts` `/v1/catalog` -> `src/server/catalog-download.ts`), so after a
  failed or skipped Home sync a Child could only receive whatever the failed run left behind. Every
  Child is then `skipped` with `home-sync-failed` or `home-sync-skipped`, and the Home exit code is
  kept. A Home sync that throws is caught by the runner. JSON mode prints the document (`home.state
  failed`, `home.exit` 1, every hub-initiated Child `skipped` `home-sync-failed` when the link store is
  readable; an unreadable store instead yields `fanout.state` `failed`, reason `link-store-unreadable`,
  and no children) and one sanitized
  `Sync failed: ...` stderr line. Human mode prints
  one stderr line, `Children were not synced because the Home sync failed.`, when a best-effort
  store read (any error swallowed, so it can never replace the original error) finds a link, then
  rethrows the original error unchanged so today's failure output and exit stay.
- Never requests a Codex app or app-server restart on a Child, and never restarts the Home proxy:
  the command sent to a Child carries no restart flag. The Child's own pinned sync keeps its existing
  behavior of restarting its OpenCodex client runtime after it applies changed Home settings
  (`src/cli/link-apply-restart.ts`), which can interrupt a request relayed at that moment. Help and
  docs state both and point to GOAT or `ocx sync --restart-codex` on the Child for a Codex restart.

### Which links

- Records come from `<configDir>/link/links.json` (`readLinkStore`). `client-initiated` links are
  `skipped` (`client-initiated-link`): the Home has no SSH path or pinned host key for them.
- Reachability comes from the Home runtime's `GET /api/link/status`, read once by
  `readHomeLinkStatus` under one absolute 5 s deadline that covers live-runtime discovery, the
  request headers and the body read (a `Promise.race` against a typed `LinkStatusTimeout` plus an
  `AbortController` passed to fetch; discovery that ignores the deadline is abandoned, and the CLI
  exits through `process.exit`). It uses the same discovery and admin headers as `runtimeRequest`. The route
  admits the admin token on trusted loopback (`auth(ctx, "either")`). Outcomes, applied to every
  hub-initiated Child: no live Home runtime -> `skipped` `home-runtime-not-running`; 401/403 ->
  `failed` `home-link-status-unauthorized`; abort/timeout -> `failed` `home-link-status-timeout`; any
  other error -> `failed` `home-link-status-unavailable`; a DTO that fails validation -> `failed`
  `home-link-status-invalid`. Per link: absent from the DTO -> `skipped` `link-not-in-runtime`; state
  not `connected` -> `skipped` `tunnel-<state>` (state from the closed `LinkWireState` set).

### Per Child

Each Child runs in its own worker with one deadline (180 s from the moment the worker starts)
covering every ssh call. All commands use `buildExecArgv` with the link known_hosts
(`StrictHostKeyChecking=yes`) and `remoteOcxArgv(args, platform)`.

1. Platform: `record.remotePlatform`, or when absent `requireRemotePlatformFramed` through the owned
   runner with each call's timeout clamped to the remaining deadline. A successful Windows probe
   identifies Windows when any trimmed stdout line is exactly `Windows_NT`. Otherwise a POSIX probe
   prints `ocx-platform:<uname -s>`; exactly one framed line is required. Login-shell output is ignored;
   exit 255 is a transport failure and ambiguous or failed probes -> `failed` `platform-probe-failed`.
2. One remote operation, `remotePinnedSyncArgv(linkId, platform)` (NEW in `src/link/ssh-argv.ts` for
   POSIX and `src/link/remote-windows.ts` for Windows), sharing the candidate list and order with
   `REMOTE_OCX_SCRIPT` / `windowsOcxArgv`. For each candidate in order it runs that executable's
   `--version` exactly once, and that single run both decides selection and supplies the version:
   - POSIX: `( ulimit -c 0; ulimit -f 1; exec "$c" --version ) >"$tmp" 2>/dev/null &`, a watchdog
     `( sleep 10; kill -9 "$vp" ) &`, `wait "$vp"` for the real status, then the watchdog is killed and
     reaped; the whole group's stderr goes to `/dev/null`. After exit, the capture file itself is
     measured before parsing; a capture over 256 bytes is skipped even if the process exited 0.
     Checked locally with `sh`: a writer that ignores SIGPIPE and SIGXFSZ and swallows its write
     errors is killed at the watchdog (status 137, file at 512 bytes, its pid gone afterwards); a
     version printing `opencodex 2.93.0` and exiting 17 returns 17; a normal one returns 0.
   - Windows: a new `[OcxJob]::V(path)` in `OCX_JOB_SOURCE` starts the process with redirected
     stdout and stderr, reads stdout in a loop into a 257-char buffer on a task, drains stderr on
     another task discarding it, waits for the reading task and the exit together under one 10 s
     deadline, kills and waits for the process on overflow or deadline, and returns the text only
     when the process exited 0 with at most 256 characters.
   - A candidate whose run exits nonzero, is killed by the watchdog or overflows is skipped and the
     next candidate is tried, as today's `try_ocx` skips a failing one; it is never synced. No
     qualifying candidate -> exit 127 as today.
   - The first qualifying candidate is selected. Its output must parse as `opencodex <semver>` or a
     bare `<semver>` (the full `src/lib/strict-semver.ts` grammar: `MAJOR.MINOR.PATCH`, optional `-prerelease`,
     optional `+build`; build metadata is accepted and ignored for precedence, as SemVer specifies,
     and the marker carries the version string exactly as parsed); unparsable -> last stderr line `ocx-fanout:child-ocx-version-unknown`, exit 121.
     A version that strict SemVer precedence orders below 2.93.0 (so `2.93.0-preview.*` is refused)
     -> `ocx-fanout:child-ocx-lacks-expect-link`, exit 121. 2.93.0 is the first release with
     `--expect-link` (959a07a5ea is in v2.93.0, not v2.92.0); checking first matters because an older
     ocx ignores unknown flags and would run an unpinned sync.
   - Otherwise it removes the capture file, clears the trap, writes exactly
     `ocx-fanout:selected:<version>` on stderr, then `ocx-fanout:stdout-begin` on stdout, and execs
     `<that path> sync --expect-link <linkId> --json`. The trap removes the file on every refusal path.
   - No `ocx` command other than `--version` runs on the Child before the pinned sync (platform
     discovery may run its fixed OS probe first), so the pinned sync's "nothing changed on mismatch"
     guarantee (shim repair deferred until after the identity check) is unchanged.
   - Replacing the binary on disk between its version run and the exec is outside the threat model:
     it needs write access to the Child's ocx install, which already controls the Child's OpenCodex.
     The Windows script must stay within `POWERSHELL_ENCODED_MAX` (asserted by a test).
3. Classification, transport first (these apply whatever the output says): exit 255 -> `failed` `ssh-failed`; 127 -> `failed`
   `child-ocx-not-found`; 126 (Windows containment) -> `failed` `child-ocx-not-contained`; 125 ->
   `skipped` `child-platform-unsupported`; 121 with a known `ocx-fanout:` marker as the last stderr
   line -> `skipped` with that code (121 without a marker -> `failed` `child-sync-failed`). Then the
   sync result. Success needs exit 0 and positive evidence; a nonzero exit is never overridden by a
   document. The Home requires exactly one stderr line matching `^ocx-fanout:selected:(.+)$` with a
   strict SemVer version, and exactly one stdout line `ocx-fanout:stdout-begin`. Missing, duplicate,
   or malformed framing -> `failed` `child-output-invalid` after the transport cases above. Login-shell
   output before the markers is ignored; classification uses only stdout after the delimiter. For exit 0:
   - that stdout, trimmed, starts with `{`: the Child claims the `--json` form (this release and later).
     It must be exactly one valid `ocx.sync.fanout/1` document; `home.state "synced"` -> `synced`,
     `home.state "stale"` -> `failed` `child-catalog-stale`; malformed JSON, an unknown schema, a
     second document, an inconsistent document (any other state, or `home.exit` not 0) -> `failed`
     `child-output-invalid`.
   - otherwise the Child is a release from v2.93.0 up to the one before this change (it ignores
     `--json`): stdout must contain the legacy success sentence `Remote Link Home catalog
     synchronized.` -> `synced`, or the stale sentence `Home unavailable; retained and applied the
     last-known-good remote catalog (stale).` -> `failed` `child-catalog-stale` (stale wins if both
     appear); neither -> `failed` `child-output-invalid`. Both sentences are identical in v2.93.0,
     v2.94.0, v2.95.0 and v2.96.0 (checked with `git show <tag>:src/cli/dispatch.ts`) and are exported
     as constants that a test pins.
   Exit 5 ->
   `skipped` `child-link-mismatch:<reason>` when the final stderr line parses as
   `{"phase":"child_link_mismatch","reason":R}` with R in the closed reason set, otherwise
   `child-link-mismatch`; exit 7 -> `skipped` `child-updating` (reserved for L1's sync/update
   mutex, `update-in-flight`; nothing changed on the Child); any other non-zero (including exit 1 after a fresh catalog when the apply
   record or runtime restart failed) -> `failed` `child-sync-failed`.
4. Deadline -> `timed-out` `deadline-exceeded` with `exit: null`; when the process cannot be
   confirmed gone after SIGKILL and its wait, the reason is `termination-unconfirmed` instead. Spawn failure -> `failed`
   `ssh-spawn-failed`; output over the cap or undecodable -> `failed` `ssh-output`. A worker that
   throws for any other reason -> `failed` `internal-error`.

`reason` is always one of these fixed codes (null for `synced`). No ssh stderr or remote text
reaches the output.

### Process ownership and isolation

- A dedicated runner in `src/cli/sync-fanout-process.ts` spawns each ssh with `Bun.spawn`
  (`stdin: "ignore"`, piped bounded stdout/stderr, `linkSshSpawnEnv()`). On deadline, output-limit or
  decode failure it sends SIGTERM, waits up to 2 s for exit, then SIGKILL and waits up to 1 s more.
  The worker returns only after that sequence, so the CLI's `process.exit` does not skip the
  escalation. A `kill` that throws ESRCH counts as exited; any other signal error, or no exit within
  the final wait, is reported as `termination-unconfirmed` and never claimed as gone.
  Pipe readers are cancelled after exit plus a 250 ms grace, so a descendant holding an inherited
  pipe cannot hold the worker. A grace-cancelled pipe is incomplete and fails as `ssh-output`.
- Concurrency cap 3. Workers catch every error. A Child's failure, hang or crash never stops another
  active worker and never changes the Home result. A queued Child starts no later than
  `ceil(position / 3)` waves of (180 s + 3 s kill grace); the whole run is bounded by
  `ceil(n / 3) × 183 s` plus the 5 s status read.
- Propagation runs only in the CLI process. The Home server runs no propagation code.
- Killing the local ssh does not necessarily stop a remote `ocx sync` already running; it finishes
  or fails on the Child by itself (documented).

### Output and exit

- `--json`: in JSON mode `console.log` is routed to stderr for the whole runner, and stdout carries
  exactly one document on every path except usage errors:
  `{schema:"ocx.sync.fanout/1", home:{state:"synced"|"stale"|"skipped"|"failed", exit}, fanout:{state:"ran"|"disabled"|"not-applicable"|"failed", reason}, children:[{linkId, alias, state, reason, exit}]}`.
  `home.state` is `stale` when a connected sync applied the last-known-good catalog. `fanout` is
  `disabled` under `--local-only`, `not-applicable` on connected, pinned and link-less runs, and
  `failed` with `link-store-unreadable` when `links.json` cannot be read or parsed (Home ok -> exit 6).
  `children` is empty on connected, pinned, `--local-only` and link-less runs. A pinned mismatch is
  `home.state "failed"`, `exit 5`, with the existing stderr lines unchanged.
- Usage errors exit 2 with stderr only. New flags are validated in the root preflight
  (`src/cli/root.ts`) before shim auto-restore and any other preflight side effect, alongside the
  existing pinned-flag check.
- Exit 7 is reserved for L1's sync/update mutex (`update-in-flight`, nothing changed); the runner
  keeps the Home's local sync as one step that ends before fan-out starts, so that mutex can cover
  the Home's own mutation without being held for the fan-out.
- Exit: Home failure keeps its code (1, 5, 7, or `process.exitCode`); Home ok and every Child `synced`
  or `skipped` -> 0; any Child `failed` or `timed-out`, or `fanout.state failed` -> **6** (partial).
- Human mode prints the existing Home lines, then one line per Child:
  `<alias> (<linkId>): <state>[ (<reason>)]`. An unreadable link store prints the fixed stderr line
  `Children were not synced: the Remote Link store could not be read.`

### Capabilities

- `ocx capabilities --json` gains a top-level `contracts: string[]` (always present, unaffected by
  `--route`/`--mutating-only`; schemaVersion stays 1) from `CAPABILITY_CONTRACTS` in
  `src/cli/capability-contracts.ts`, containing `sync.home-fanout/1`. `ocx capabilities --contracts
  --json` prints only `{"schemaVersion":1,"contracts":[...]}`; `--contracts` without `--json` prints
  one contract per line; combined with `--route` or `--mutating-only` it exits 64. Agreed with L1 and
  L3 (same file and constant name; the later merge adds one array entry).

## Diff-level plan

1. NEW `src/cli/capability-contracts.ts`: `export const CAPABILITY_CONTRACTS = ["sync.home-fanout/1"] as const;`
   with no imports.
2. MODIFY `src/cli/capabilities-command.ts`: `--contracts` handling, 64 combinations, `contracts` on
   every JSON document including the unmatched-route one, usage `[--contracts]`; capabilities-base
   entry for `capabilities` gains the flag.
3. NEW `src/cli/sync-flags.ts`: `parseSyncFanoutFlags(args)` -> `{localOnly, json}` or a usage error
   (repeated flag). Called from `root.ts` preflight and the runner.
4. NEW `src/cli/sync-command.ts`: the `sync` runner moved out of `dispatch.ts` with existing branches
   unchanged, as `runSyncCommand(deps)`; JSON-mode stdout routing; Home result capture; fan-out call;
   rendering; exit combination. `dispatch.ts` keeps a one-line delegate. Export
   `STALE_REMOTE_CATALOG_MESSAGE` (link form) and use it in the existing print.
5. NEW `src/cli/sync-fanout.ts`: `runHomeFanout(deps)` with injected `readStore`, `readLinkStatus`,
   `runChild`, `resolvePlatform`, `now`, `deadlineMs`, `concurrency`; `classifyVersionProbe`,
   `classifySyncResult`, `parseOcxVersion`, `fanoutExitCode`, `renderFanoutJson`, `renderFanoutHuman`,
   bounded pool, `SYNC_FANOUT_PARTIAL_EXIT = 6`.
6. NEW `src/cli/sync-fanout-process.ts`: the owned-process runner described above; it also
   implements `SshRunner.run` (timeouts clamped to the remaining deadline) for `requireRemotePlatformFramed`.
6a. MODIFY `src/link/ssh-argv.ts` / `src/link/remote-windows.ts`: `remotePinnedSyncArgv` and its
   Windows script, sharing the candidate lists with `REMOTE_OCX_SCRIPT` / `windowsOcxArgv`.
6b. NEW `src/cli/sync-link-status.ts`: `readHomeLinkStatus(deadlineMs)` with the typed errors.
7. MODIFY help, registry and capabilities-base `sync` entries (usage
   `ocx sync [--expect-link <linkId> | --expect-hub-key <apiKeyId>] [--local-only] [--json] [--restart-codex] [--restart-app-server-only]`,
   flags, details, `json: "payload"`), including that fan-out never requests a Codex app or
   app-server restart on a Child and that the Child's pinned sync may restart its own client runtime.
8. Docs: `docs-site/src/content/docs/reference/cli/lifecycle.md` (English),
   `skills/ocx/references/05_remote_hub.md`, `04_failure_semantics.md` (exit 6),
   `01_surface_lifecycle.md` if it lists sync flags, `structure/cli-management.md` and
   `structure/remote-link.md`; regenerate `bun run skill:surface`; review `structure/manifest.json`
   ownership for the new files.
9. Guards: extend the source scans in `tests/cli/cli-transport-honesty.test.ts` and
   `tests/cli/cli-json-contract.test.ts` that read `dispatch.ts` to cover `sync-command.ts` too.
10. Tests, each new file registered in `scripts/test-layout/layout.json` and
    `tests/fixtures/test-layout-expected.json`:
    - `tests/cli/sync-fanout.test.ts`: classification tables (probe, sync, stale, mismatch reason
      parsing incl. an unknown reason), version gate, client-initiated skip, each status-read error,
      link-not-in-runtime, tunnel states, Home failed/skipped/thrown -> Children skipped, exit
      combination, JSON shape, concurrency never above 3 with 7 Children, three hung Children delay a
      fourth by at most one wave, a throwing worker is isolated.
    - `tests/cli/sync-fanout-process.test.ts`: the owned runner against real child processes: a
      process that ignores SIGTERM is SIGKILLed and gone before the call returns; a process that
      exits 255; a descendant holding the stdout pipe is rejected as incomplete without holding the
      call, and is reaped by the test; output over the cap.
    - `tests/cli/sync-command-fanout.test.ts`: through the real CLI entry (`bun run src/cli/index.ts`
      with a temp `OPENCODEX_HOME` and a fake `ssh` on PATH, no live runtime): `--local-only` makes no
      ssh call; JSON mode prints exactly one document; usage errors exit 2 before preflight; a pinned
      sync never fans out.
    - `tests/clients/link-pinned-sync-argv.test.ts`: run the POSIX script with `sh` against fake
      candidate directories (2.92.0 first -> exit 121 marker, never sync; 2.93.0 -> sync argv on the
      same path with the `ocx-fanout:selected:2.93.0` marker and no other command run on that fake;
      a fake whose `--version` writes endlessly while ignoring SIGPIPE, SIGXFSZ and its write errors is
      killed by the watchdog, skipped, and its pid is gone; a broken first candidate followed by a
      working one selects the second; a fake printing a valid version but exiting 17 is skipped,
      never run; the capture file is gone after both a refusal and a successful exec; a zero-exit
      version probe over 256 bytes is skipped; the stdout delimiter precedes the sync output;
      `2.93.0-preview.1` -> refused; unparsable -> marker; a
      candidate set that changes between two runs still pins the version check and the exec to one
      path per run). Windows: extend the existing `windowsOcxArgv` execution tests
      (`tests/clients/link-ssh-argv*.test.ts` and any PowerShell-executing test they use) to the new
      script: selection order, fragmented output, delayed extra bytes past 256, a process that never
      writes (deadline), version refusal, the exact argv handed to `Invoke-Native` (so
      containment is kept), the marker line, and the size budget.
    - Classification: stdout after the delimiter starting with `{` that is malformed, of an unknown schema, or two
      documents fails `child-output-invalid`; empty stdout at exit 0 fails `child-output-invalid`; a
      legacy Child printing the success sentence is `synced` and with the stale sentence is
      `child-catalog-stale`; a document saying `synced` with exit 1 fails `child-sync-failed`;
      a legacy 2.96.0 Child with and without the stale sentence; no marker -> `child-output-invalid`.
    - Human-mode thrown Home sync: the one stderr line, then the original error and exit; with a
      damaged `links.json` the original error still surfaces unchanged.
    - `tests/cli/sync-link-status.test.ts`: stalled discovery, stalled headers, stalled body each end
      at the deadline as `home-link-status-timeout`; 401/403; invalid DTO; no runtime.
    - Home gate cases: refused refresh, thrown refresh, unchanged committed catalog, missing catalog.
    - capabilities: `contracts` in every JSON output, `--contracts` output and the 64 combinations.

## Verification

`bun run typecheck`; the new test files plus the capabilities tests, `tests/ci-workflows/skill-ocx.test.ts`,
`tests/test-layout*.test.ts`, `tests/cli/cli-sync-expect-link.test.ts`, `tests/cli/cli-registry.test.ts`,
the extended guard tests, `tests/lab/core-lab-boundary.test.ts` and the file-size ratchet;
`bun run test:changed`; `bun run privacy:scan`; `bun run structure:check`; `bun run skill:surface:check`;
`bun run lint:gui` is not affected (no `gui/` change). No real service, desktop app, GOAT server or
Codex app is touched.

## Risks

- A powered-off Child whose tunnel state still reads `connected` costs up to the ssh ConnectTimeout
  (10 s), reports `failed` and makes the run exit 6.
- A remote `ocx sync` can keep running after the Home kills its ssh on deadline.
- Stale detection depends on a sentence shared through one constant; a future Child that changes it
  must keep the constant, and the classifier test pins it.
