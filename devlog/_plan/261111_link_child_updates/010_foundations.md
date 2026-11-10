# 010 — Foundations (wp1): gated remote ocx, update contract, observation cache, shared classifier

> **Revision 2 (audit r1).** Folds H1 (registration follows 000 "Test registration rule"), H2 (deviation 3
> now points at 000 A4: launcher for npm/pnpm apply only), M6 (names per 000 "Canonical names"), M9 (the
> update plan gate prints the Child's clock, `ocx-fanout:child-now:<epoch-ms>`, and `readGatedFraming` /
> `classifyUpdatePlanProbe` return it), L12 (base and verifier facts refreshed), L15 (plan-probe comment) and
> L16 (the real-CLI test runs plan and usage cases only).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529521956 (the audit r2 R5 `launcher` check moves to 030, which
> adds the field; wp1's `assertGated` no longer names it), 4529521993 and 4529522026 (a pinned sync that carries a
> restart prints `ocx-fanout:selected-kind:ocx-child` when the selected candidate is `ocx-child`, and
> `classifySyncResult` returns it as `executable`, so a record without `childKind` is still recognised), and the
> cache fields that 4529521968, 4529522106 and 4529522112 need (`catalogSyncedEtag`, `autoUpdateAttempts`,
> `pendingUpdateRecovery`, plus `withoutCarriedFields`), declared here because the tolerant parser drops unknown keys.

- **Work phase:** wp1. **Depends on:** nothing (base `dev` 61151e3457 at revision 2; first drafted on 00680193cb). **Class:** C4: it builds the
  remote command that later runs another machine's updater, so the D20 security review applies.
- **Outcome:** the Home can build one SSH command that selects the Child's served `ocx`, checks its
  version *inside the remote script*, and only then runs `update --plan`, `update --yes` or `sync`.
  An `ocx` older than 2.97.0 never receives an `update` argument (F1). The Home parses the Child's
  `ocx.update.plan/1` and `ocx.update.result/1` documents strictly and maps every exit to a closed
  verdict. A tolerant per-link observation cache exists under `<configDir>/link/`. The sync-result
  classifier moves to `src/link` so the Home-side engine (wp3) can use it without importing `src/cli`.
  Nothing here is wired to a route, a CLI verb or a timer, so no user-visible behaviour changes.
- **IN:** POSIX and Windows gated builders, `remotePinnedSyncArgv` restart options, update argv builders,
  framing reader, plan/result parsers, plan classification, apply exit mapping, observation store,
  classifier move with re-export, tests, `structure/remote-link.md` text.
- **OUT:** observe/sync/update runners and the job engine (wp2/wp3), routes, CLI verbs, timers, any change
  under `src/update/*` (D19), any change to `src/cli/index.ts`, `src/server/index.ts`,
  `src/server/index/serve-options.ts` or `src/types/config.ts`.

## Deviations from 004

1. **Builder location (D1).** 004 puts the gated builder in a new `src/link/child-gated-ocx.ts` importing
   `ssh-argv.ts`. But `remotePinnedSyncArgv` must stay exported from `ssh-argv.ts` (imported by
   `src/cli/sync-command.ts:11` and five test files) and must become a call of the gated builder, so that
   layout is an import cycle whose top-level template would read `REMOTE_OCX_CANDIDATES`
   (`src/link/ssh-argv.ts:213`, unexported) in its temporal dead zone. The script builders therefore live
   beside the pieces they splice: `remoteGatedOcxArgv` in `ssh-argv.ts` (replacing
   `REMOTE_PINNED_SYNC_SCRIPT`, `ssh-argv.ts:325-370`) and `windowsGatedOcxArgv` in `remote-windows.ts`
   (replacing `windowsPinnedSyncArgv`, `remote-windows.ts:213-226`). `src/link/child-gated-ocx.ts` keeps
   the update argv builders, the framing reader and the SSH-result classifiers, importing one way only.
2. **ocx-child refusal for update verbs (new).** `ocx-child --version` prints `opencodex 2.98.0`
   (`native/ocx-child/src/lib.rs:21`, `native/ocx-child/src/cli.rs:76-78`), so a 2.97.0 gate alone admits
   it, and the candidate list runs `ocx-child` first whenever `child/state.json` exists
   (`ssh-argv.ts:225-227`, `remote-windows.ts:152`). D3 branches on `record.childKind` first, but
   `childKind` is optional (`src/link/store.ts:32`). The gate gains `acceptEphemeral`; update verbs pass
   `false` and get exit 121 with `ocx-fanout:child-ocx-ephemeral` before any `update` runs.
   (`ocx-child update` would only print "Unknown ocx-child subcommand" and exit 2, `cli.rs:114-117`; the
   refusal turns that into a named verdict.)
3. **npm/pnpm through a served Bun pair (new finding, decision left to 030).** The served-runtime census
   records `[bun, <root>/src/cli/index.ts]` for a package install (`src/config/serving-runtimes.ts:55-65`)
   and the remote script runs it first (`ssh-argv.ts:228`). That entry skips the Node launcher, where
   npm/pnpm orchestrated apply lives (`bin/ocx.mjs:1362-1390`). In the Bun entry an npm/pnpm apply falls
   through to `src/update/orchestrated-entry.ts:225-233` and exits 10 with `error: "plan-unavailable"`,
   although its plan said `canApply: true` (`orchestrated-plan.ts:28-38` never refuses npm/pnpm). Nothing
   is mutated, so it is not a safety hole, but 000's "npm, pnpm or Bun installs get remote updates" holds
   only for Bun installs and for Children without a census entry. wp1 makes it visible: the update gate
   prints `ocx-fanout:entry:pair` or `ocx-fanout:entry:binary` after the selection marker, and
   `classifyChildUpdatePlan` maps `installer ∈ {npm, pnpm}` with `entry: "pair"` to `owner-action` /
   `launcher-bypassed`. Whether `<root>/bin/ocx.mjs` may be run under the recorded Bun is untested; 030
   decides with fixtures. Decision (000 A4, revision 2): only the **apply** of a plan whose `installer` is
   `npm` or `pnpm` goes to `<node> <root>/bin/ocx.mjs`; the plan probe and every Bun install stay on the
   served entry. Verified fact used here: running this tree's CLI as `update --yes --json ...` prints a
   `ocx.update.result/1` line and exits 10 (verifier run by the planner, never by a test, see L16 in "Tests").
4. **The contract module imports `src/lib/strict-semver`.** D1 says "none"; strict-semver is pure and is
   already the version parser the classifier uses (`src/cli/sync-fanout.ts:1`).
5. **Windows apply refused in the builder.** D20 refuses Windows orchestrated apply in the engine; wp1
   also makes `remoteUpdateApplyArgv(_, "windows")` throw `LinkSshArgumentError("unsupported:windows-apply")`
   so no caller can build that command.

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| src/link/ssh-argv.ts | MODIFY (:22, :325-374) | gate types, `remoteGatedOcxArgv`, script template function, `remotePinnedSyncArgv(linkId, platform, opts)` |
| src/link/remote-windows.ts | MODIFY (:213-226) | `windowsGatedOcxArgv` replaces `windowsPinnedSyncArgv` (sole caller `ssh-argv.ts:373`) |
| src/link/child-gated-ocx.ts | NEW | update argv builders, `readGatedFraming`, `classifyUpdatePlanProbe`, `classifyUpdateApply` |
| src/link/child-update-contract.ts | NEW | strict plan/result parsers, `classifyChildUpdatePlan`, `mapUpdateApplyExit` |
| src/link/child-observations.ts | NEW | tolerant `child-observations.json` store |
| src/link/paths.ts | MODIFY (append after :19) | `childObservationsPath` |
| src/link/sync-fanout-classify.ts | NEW | moved `parseOcxVersion`, `classifyVersionProbe`, `classifySyncResult`, messages, `ChildVerdict` |
| src/cli/sync-fanout.ts | MODIFY (:1-82) | delete the moved code, re-export it |
| tests/clients/link-gated-ocx-argv.test.ts | NEW | gate behaviour on fake executables, Windows script data, validation |
| tests/clients/link-child-update-contract.test.ts | NEW | parsers, mapping, oracle against `src/update` and the real CLI |
| tests/clients/link-child-observations.test.ts | NEW | tolerance, pruning, permissions |
| scripts/test-layout/layout-clients.json | MODIFY | register the three files as `clients` |
| tests/fixtures/test-layout-expected.json | MODIFY | the same three entries |
| structure/remote-link.md | MODIFY (:9) | gated builder, update gate, cache, classifier home |

Expected sizes (threshold 2000; none of these files is in `tests/fixtures/file-size-baseline.json`):
`ssh-argv.ts` about 395, `remote-windows.ts` about 252, `sync-fanout.ts` about 85.

## Changes

### src/link/ssh-argv.ts

Before (`ssh-argv.ts:22`, `:356-374`):

```ts
import { POWERSHELL_ENCODED_MAX, windowsOcxArgv, windowsPinnedSyncArgv } from "./remote-windows";
...
      c=cmp(a[1],"2"); if(!c)c=cmp(a[2],"93"); if(!c)c=cmp(a[3],"0"); if(c<0 || (!c && dash))result=1
...
  if [ "$status" -eq 1 ]; then printf '%s\\n' 'ocx-fanout:child-ocx-lacks-expect-link' >&2; exit 121; fi
  if [ "$status" -ne 0 ]; then printf '%s\\n' 'ocx-fanout:child-ocx-version-unknown' >&2; exit 121; fi
  rm -rf "$dir"; trap - EXIT HUP INT TERM
  printf 'ocx-fanout:selected:%s\\n' "$version" >&2
  printf '%s\\n' 'ocx-fanout:stdout-begin'
  exec "$c" \${ocx_entry:+"$ocx_entry"} sync --expect-link "$1" --json
}
${REMOTE_OCX_CANDIDATES}
exit ${REMOTE_COMMAND_NOT_FOUND}`;

export function remotePinnedSyncArgv(linkId: string, platform: "posix" | "windows" = "posix"): string[] {
  return platform === "windows" ? windowsPinnedSyncArgv(linkId) : ["sh", "-c", REMOTE_PINNED_SYNC_SCRIPT, "ocx", linkId];
}
```

After:

```ts
import { POWERSHELL_ENCODED_MAX, windowsGatedOcxArgv, windowsOcxArgv } from "./remote-windows";

/** Minimum served ocx for a gated command. Closed set: the literals are spliced into awk and PowerShell. */
export type GatedMinVersion = "2.93.0" | "2.97.0";
export type GatedLacksMarker = "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update";
export interface GatedOcxCommand {
  minVersion: GatedMinVersion;
  lacksMarker: GatedLacksMarker;
  /** false: a selected ocx-child exits 121 with ocx-fanout:child-ocx-ephemeral before args run. */
  acceptEphemeral: boolean;
  /** true: print ocx-fanout:entry:pair|binary on stderr right after the selection marker. */
  reportEntry: boolean;
  /** true: print ocx-fanout:child-now:<epoch-ms> (the Child's own clock) after the entry marker. Plan probe only. */
  reportClock: boolean;
  /** Revision 4: with acceptEphemeral, print ocx-fanout:selected-kind:ocx-child when the selected candidate is ocx-child.
   *  Set only by remotePinnedSyncArgv when a restart is requested (ocx-child ignores the restart flags, F2). */
  reportSelectedKind?: boolean;
  args: readonly string[];
}
export const GATED_VERSION_PARTS: Readonly<Record<GatedMinVersion, readonly [string, string, string]>> = {
  "2.93.0": ["2", "93", "0"], "2.97.0": ["2", "97", "0"],
};
const LACKS_MARKERS: ReadonlySet<string> = new Set(["child-ocx-lacks-expect-link", "child-ocx-lacks-orchestrated-update"]);
export const LINK_ID_PATTERN = /^lnk_[0-9a-f]{16}$/;

function assertGated(cmd: GatedOcxCommand): readonly [string, string, string] {
  const parts = Object.hasOwn(GATED_VERSION_PARTS, cmd.minVersion) ? GATED_VERSION_PARTS[cmd.minVersion] : undefined;
  if (!parts || !LACKS_MARKERS.has(cmd.lacksMarker)) throw new LinkSshArgumentError("invalid gated ocx command");
  if (cmd.args.length === 0 || cmd.args.some(arg => arg.includes("\0"))) throw new LinkSshArgumentError("invalid gated ocx arguments");
  return parts;
}

/** Today's pinned script with one gate's literals and options; "$@" carries the arguments. */
function remoteGatedScript(cmd: GatedOcxCommand): string {
  const [major, minor, patch] = assertGated(cmd);
  const ephemeral = cmd.acceptEphemeral ? "" : `
  case "\${c##*/}" in ocx-child*) printf '%s\\n' 'ocx-fanout:child-ocx-ephemeral' >&2; exit 121;; esac`;
  // Revision 4: only a pinned sync that carries a restart asks for this, so the plain sync's stderr stays exact.
  const kind = cmd.acceptEphemeral && cmd.reportSelectedKind ? `
  case "\${c##*/}" in ocx-child*) printf '%s\\n' 'ocx-fanout:selected-kind:ocx-child' >&2;; esac` : "";
  const entry = cmd.reportEntry ? `
  if [ -n "$ocx_entry" ]; then printf '%s\\n' 'ocx-fanout:entry:pair' >&2; else printf '%s\\n' 'ocx-fanout:entry:binary' >&2; fi` : "";
  // Seconds resolution is enough for a 120 s window; a date(1) that prints nothing numeric prints no marker.
  const clock = cmd.reportClock ? `
  now=$(date +%s 2>/dev/null); case "$now" in ''|*[!0-9]*) ;; *) printf 'ocx-fanout:child-now:%s000\\n' "$now" >&2;; esac` : "";
  return `export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
...lines 326-355 of today's script, unchanged...
      c=cmp(a[1],"${major}"); if(!c)c=cmp(a[2],"${minor}"); if(!c)c=cmp(a[3],"${patch}"); if(c<0 || (!c && dash))result=1
    }
    NR>1 {result=2}
    END {exit result}
  ' 2>/dev/null
  status=$?
  if [ "$status" -eq 1 ]; then printf '%s\\n' 'ocx-fanout:${cmd.lacksMarker}' >&2; exit 121; fi
  if [ "$status" -ne 0 ]; then printf '%s\\n' 'ocx-fanout:child-ocx-version-unknown' >&2; exit 121; fi${ephemeral}
  rm -rf "$dir"; trap - EXIT HUP INT TERM
  printf 'ocx-fanout:selected:%s\\n' "$version" >&2${kind}${entry}${clock}
  printf '%s\\n' 'ocx-fanout:stdout-begin'
  exec "$c" \${ocx_entry:+"$ocx_entry"} "$@"
}
${REMOTE_OCX_CANDIDATES}
exit ${REMOTE_COMMAND_NOT_FOUND}`;
}

export function remoteGatedOcxArgv(cmd: GatedOcxCommand, platform: "posix" | "windows" = "posix"): string[] {
  const versionParts = assertGated(cmd);
  if (platform === "windows") return windowsGatedOcxArgv({ ...cmd, versionParts });
  return ["sh", "-c", remoteGatedScript(cmd), "ocx", ...cmd.args];
}

export type ChildRestartRequest = "app-server" | "codex";
export interface PinnedSyncOptions { restart?: ChildRestartRequest }
const RESTART_FLAG: Readonly<Record<ChildRestartRequest, string>> = { "app-server": "--restart-app-server-only", codex: "--restart-codex" };

export function remotePinnedSyncArgv(linkId: string, platform: "posix" | "windows" = "posix", opts: PinnedSyncOptions = {}): string[] {
  if (!LINK_ID_PATTERN.test(linkId)) throw new LinkSshArgumentError("invalid link id");
  if (opts.restart !== undefined && !Object.hasOwn(RESTART_FLAG, opts.restart)) throw new LinkSshArgumentError("invalid restart request");
  const restart = opts.restart === undefined ? [] : [RESTART_FLAG[opts.restart]];
  return remoteGatedOcxArgv({ minVersion: "2.93.0", lacksMarker: "child-ocx-lacks-expect-link", acceptEphemeral: true,
    reportEntry: false, reportClock: false, reportSelectedKind: restart.length > 0,
    args: ["sync", "--expect-link", linkId, "--json", ...restart] }, platform);
}
```

`classifySyncResult` (moved below) accepts at most one `ocx-fanout:selected-kind:ocx-child` line after the selection
marker and returns it as `executable: "ocx-child"` on its verdict (absent otherwise); two such lines are `invalid`.
A record without `childKind` (optional, `src/link/store.ts:32`) whose Child selects `ocx-child` is therefore known to
have ignored the restart flag, and 030's runners and 040's fan-out report the restart as unsupported. Windows never
sends a restart (D20), so the PowerShell builder ignores the field.

The rest of the script is byte-identical: the `try_ocx` probe, the watchdog, the private temp dir and the
`( sleep 10 & timer=$!;` budget that `tests/clients/link-pinned-sync-argv.test.ts:182-183` rewrites. The
positional change (`"$1"` → `"$@"`) is safe because `try_ocx` shifts the candidate off first
(`ssh-argv.ts:332`) and every candidate call passes `"$@"` (`:216, :221, :226, :228, :230, :235, :238`).
For the 2.93 sync gate with `acceptEphemeral: true`, `reportEntry: false` and no restart, stderr stays exactly
`ocx-fanout:selected:<v>`, which the existing exact-match assertions require (`link-pinned-sync-argv.test.ts:56`).
The restart flags are the exact tokens `readRestartScope` reads (`src/cli/restart-scope.ts:35-37`); one is
sent at most. A 2.93 Child already parses them (F2). In wp1 no production caller passes `opts` (wp4 does).
The ephemeral check sits after the version check and before `rm -rf "$dir"`, so the existing `EXIT` trap
removes the temp dir on that refusal too.

### src/link/remote-windows.ts

Before (`remote-windows.ts:213-214, :220, :222-223`):

```ts
export function windowsPinnedSyncArgv(linkId: string): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ args: ["sync", "--expect-link", linkId, "--json"] }) + OCX_CANDIDATES + String.raw`
 ...
 $a=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value);$b=@('2','93','0');$cmp=0
 ...
 if($cmp -lt 0 -or ($cmp -eq 0 -and $m.Groups[4].Success)){[Console]::Error.WriteLine('ocx-fanout:child-ocx-lacks-expect-link');exit 121}
 [Console]::Error.WriteLine('ocx-fanout:selected:'+$v);[Console]::Out.WriteLine('ocx-fanout:stdout-begin');Invoke-Native $x @($d.args)
```

After:

```ts
export interface WindowsGatedCommand {
  versionParts: readonly [string, string, string];
  lacksMarker: "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update";
  acceptEphemeral: boolean;
  reportEntry: boolean;            // Windows reads no census, so the entry is always "binary"
  reportClock: boolean;            // prints ocx-fanout:child-now:<epoch-ms> from [DateTimeOffset]::UtcNow
  args: readonly string[];
}
export function windowsGatedOcxArgv(cmd: WindowsGatedCommand): string[] {
  if (!cmd.versionParts.every(part => /^(0|[1-9][0-9]{0,3})$/.test(part))) throw new Error("invalid gate version");
  if (!/^child-ocx-lacks-(expect-link|orchestrated-update)$/.test(cmd.lacksMarker)) throw new Error("invalid gate marker");
  const b = cmd.versionParts.map(part => "'" + part + "'").join(",");
  const ephemeral = cmd.acceptEphemeral ? "" : String.raw`if(([IO.Path]::GetFileName($x)).ToLowerInvariant().StartsWith('ocx-child')){[Console]::Error.WriteLine('ocx-fanout:child-ocx-ephemeral');exit 121};`;
  const entry = cmd.reportEntry ? String.raw`[Console]::Error.WriteLine('ocx-fanout:entry:binary');` : "";
  const clock = cmd.reportClock ? String.raw`[Console]::Error.WriteLine('ocx-fanout:child-now:'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());` : "";
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ args: cmd.args }) + OCX_CANDIDATES + String.raw`
foreach($x in ($c|select -Unique)){
 ...lines 216-219 unchanged...
 $a=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value);$b=@(` + b + String.raw`);$cmp=0
 ...line 221 unchanged...
 if($cmp -lt 0 -or ($cmp -eq 0 -and $m.Groups[4].Success)){[Console]::Error.WriteLine('ocx-fanout:` + cmd.lacksMarker + String.raw`');exit 121}
 ` + ephemeral + String.raw`[Console]::Error.WriteLine('ocx-fanout:selected:'+$v);` + entry + clock + String.raw`[Console]::Out.WriteLine('ocx-fanout:stdout-begin');Invoke-Native $x @($d.args)
};exit 127
`);
}
```

The packed script grows by under 200 characters before deflate. The existing size assertion
(`link-pinned-sync-argv.test.ts:77`) keeps covering sync; a new one covers the update variant.

### src/link/child-gated-ocx.ts (NEW)

```ts
import { LinkSshArgumentError, remoteGatedOcxArgv } from "./ssh-argv";
import { parseStrictSemver } from "../lib/strict-semver";
import { classifyChildUpdatePlan, mapUpdateApplyExit, parseChildUpdatePlan, type PlanClassification, type UpdateApplyVerdict } from "./child-update-contract";

export type SshResult = { code: number; stdout: string; stderr: string };
export type GatedFraming =
  | { kind: "transport"; reason: "ssh-failed" | "child-ocx-not-found" | "child-ocx-not-contained" | "child-platform-unsupported" }
  | { kind: "refused"; reason: "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update" | "child-ocx-version-unknown" | "child-ocx-ephemeral" | "child-gate-failed" }
  | { kind: "ran"; code: number; selectedVersion: string; entry: "pair" | "binary" | null; childNowMs: number | null; payload: string; lastStderrLine: string | undefined }
  | { kind: "invalid" };

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
function assertHomeVersion(version: string): void {
  if (version.length > 128 || !parseStrictSemver(version)) throw new LinkSshArgumentError("invalid Home version");
}
const UPDATE_GATE = { minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: true, reportClock: false } as const;

/**
 * Never mutates an install: below 2.97.0 the gate exits 121 before `update` runs (F1), and `update --plan` only
 * computes. Not free of side effects on every Child: without a census pair (an npm/pnpm Child whose service never
 * recorded one) the script execs the `ocx` shim, so the Node launcher's ordinary bootstrap runs first (Desktop CLI
 * handoff check, sync-guard bookkeeping, Bun resolution; bin/ocx.mjs:1403-1440), exactly as for every pinned sync
 * already sent to that Child. The probe prints the Child's clock for the apply deadline (M9).
 */
export function remoteUpdatePlanArgv(homeVersion: string, platform: "posix" | "windows"): string[] {
  assertHomeVersion(homeVersion);
  return remoteGatedOcxArgv({ ...UPDATE_GATE, reportClock: true, args: ["update", "--plan", "--json", "--version", homeVersion] }, platform);
}

export function remoteUpdateApplyArgv(input: { homeVersion: string; planToken: string; notAfter: number }, platform: "posix" | "windows"): string[] {
  if (platform === "windows") throw new LinkSshArgumentError("unsupported:windows-apply");
  assertHomeVersion(input.homeVersion);
  if (!TOKEN.test(input.planToken)) throw new LinkSshArgumentError("invalid plan token");
  if (!Number.isSafeInteger(input.notAfter) || input.notAfter <= 0) throw new LinkSshArgumentError("invalid deadline");
  return remoteGatedOcxArgv({ ...UPDATE_GATE, args: ["update", "--yes", "--json", "--version", input.homeVersion,
    "--expect-plan", input.planToken, "--not-after", String(input.notAfter)] }, platform);
}

/** The framing classifySyncResult applies (sync-fanout.ts:42-59), generalised to every gated command. */
export function readGatedFraming(result: SshResult): GatedFraming {
  const { code, stdout, stderr } = result;
  if (code === 255) return { kind: "transport", reason: "ssh-failed" };
  if (code === 127) return { kind: "transport", reason: "child-ocx-not-found" };
  if (code === 126) return { kind: "transport", reason: "child-ocx-not-contained" };
  if (code === 125) return { kind: "transport", reason: "child-platform-unsupported" };
  const lines = stderr.split(/\r?\n/);
  const last = stderr.trimEnd().split(/\r?\n/).at(-1);
  if (code === 121) {
    const marker = /^ocx-fanout:(child-ocx-lacks-expect-link|child-ocx-lacks-orchestrated-update|child-ocx-version-unknown|child-ocx-ephemeral)$/.exec(last ?? "");
    return { kind: "refused", reason: (marker?.[1] ?? "child-gate-failed") as Extract<GatedFraming, { kind: "refused" }>["reason"] };
  }
  const selected = lines.map(line => /^ocx-fanout:selected:(.+)$/.exec(line)).filter(match => match !== null);
  if (selected.length !== 1 || !parseStrictSemver(selected[0]![1]!)) return { kind: "invalid" };
  const entries = lines.filter(line => /^ocx-fanout:entry:(pair|binary)$/.test(line));
  if (entries.length > 1) return { kind: "invalid" };
  const clocks = lines.flatMap(line => /^ocx-fanout:child-now:([0-9]{10,16})$/.exec(line)?.[1] ?? []);
  if (clocks.length > 1 || (clocks.length === 1 && !Number.isSafeInteger(Number(clocks[0])))) return { kind: "invalid" };
  const out = stdout.split(/\r?\n/);
  const delimiters = out.flatMap((line, index) => line === "ocx-fanout:stdout-begin" ? [index] : []);
  if (delimiters.length !== 1) return { kind: "invalid" };
  return { kind: "ran", code, selectedVersion: selected[0]![1]!, entry: entries.length ? (entries[0]!.slice(17) as "pair" | "binary") : null,
    childNowMs: clocks.length ? Number(clocks[0]) : null, payload: out.slice(delimiters[0]! + 1).join("\n").trim(), lastStderrLine: last };
}

export type PlanProbeVerdict =
  | { kind: "plan"; selectedVersion: string; classification: PlanClassification; childNowMs: number | null }
  | { kind: "legacy"; reason: "child-ocx-lacks-orchestrated-update" | "child-ocx-version-unknown" }
  | { kind: "ephemeral" }
  | { kind: "offline"; reason: "ssh-failed" }
  | { kind: "failed"; reason: string };

export function classifyUpdatePlanProbe(result: SshResult, ctx: { homeVersion: string; desktopUpdateRequest: boolean }): PlanProbeVerdict {
  const framing = readGatedFraming(result);
  if (framing.kind === "transport") return framing.reason === "ssh-failed" ? { kind: "offline", reason: "ssh-failed" } : { kind: "failed", reason: framing.reason };
  if (framing.kind === "refused") {
    if (framing.reason === "child-ocx-ephemeral") return { kind: "ephemeral" };
    if (framing.reason === "child-ocx-lacks-orchestrated-update" || framing.reason === "child-ocx-version-unknown") return { kind: "legacy", reason: framing.reason };
    return { kind: "failed", reason: framing.reason };
  }
  if (framing.kind === "invalid") return { kind: "failed", reason: "child-output-invalid" };
  if (framing.code !== 0) return { kind: "failed", reason: framing.code === 64 ? "contract-usage" : "child-plan-failed" };
  const parsed = parseChildUpdatePlan(framing.payload);
  if (!parsed.ok) return { kind: "failed", reason: parsed.reason };
  return { kind: "plan", selectedVersion: framing.selectedVersion, childNowMs: framing.childNowMs,
    classification: classifyChildUpdatePlan(parsed.value, { ...ctx, entry: framing.entry }) };
}

export function classifyUpdateApply(result: SshResult): UpdateApplyVerdict {
  const framing = readGatedFraming(result);
  if (framing.kind === "transport") return framing.reason === "ssh-failed"
    ? { state: "uncertain", reason: "ssh-failed", suppressTarget: false, reobserve: true }
    : { state: "failed", reason: framing.reason, suppressTarget: false, reobserve: false };
  if (framing.kind === "refused") return framing.reason === "child-ocx-ephemeral"
    ? { state: "unsupported", reason: "ephemeral", suppressTarget: false, reobserve: false }
    : { state: "owner-action", reason: framing.reason === "child-gate-failed" ? "child-gate-failed" : "legacy-ocx", suppressTarget: false, reobserve: false };
  // Framing broken after a command may have run: never assume it did not.
  if (framing.kind === "invalid") return { state: "uncertain", reason: "child-output-invalid", suppressTarget: false, reobserve: true };
  return mapUpdateApplyExit(framing.code, framing.payload);
}
```

### src/link/child-update-contract.ts (NEW, pure)

Key sets come from this tree, not from 004: plan `src/update/orchestrated-plan.ts:43-48` (`reason` present
only when `canApply` is false, also for the `plan-unavailable` override at `orchestrated-entry.ts:136`);
result `src/update/orchestrated-outcome.mjs:14-19`, `orchestrated-admission.mjs:3-4` and
`orchestrated-entry.ts:231-232` (`error` optional). Exits: 0/10/11/12 (`orchestrated-outcome.d.mts:18`),
64 usage with stdout `{"error":"usage"}` (`orchestrated-entry.ts:208-214`, `bin/ocx.mjs:1354-1358`).

```ts
import { parseStrictSemver } from "../lib/strict-semver";

export const UPDATE_PLAN_SCHEMA = "ocx.update.plan/1";
export const UPDATE_RESULT_SCHEMA = "ocx.update.result/1";
export const UPDATE_OUTPUT_MAX_BYTES = 65_536;
export type PlanInstaller = "npm" | "pnpm" | "bun" | "mise" | "desktop-app" | "source" | "unknown";
export type PlanRuntimeOwner = "service" | "desktop-app" | "unmanaged" | "none" | "unknown";
export type PlanReason = "desktop-app-owned" | "source-checkout" | "mise-managed" | "installer-unknown" | "plan-unavailable"
  | "serving-install-unknown" | "cli-not-serving-install" | "runtime-ownership-refused" | "target-unresolved" | "downgrade-refused" | "up-to-date";
export interface ChildUpdatePlan {
  schema: typeof UPDATE_PLAN_SCHEMA; currentVersion: string; targetVersion: string | null; installer: PlanInstaller;
  runtimeOwner: PlanRuntimeOwner; servingPath: string | null; cliPath: string; canApply: boolean; reason?: PlanReason;
  restartRequired: boolean; planToken: string; updateInFlight: boolean; mutationBoundMs: number;
}
export interface ChildUpdateResult {
  schema: typeof UPDATE_RESULT_SCHEMA; applied: boolean; fromVersion: string; toVersion: string | null; installer: PlanInstaller;
  restarted: boolean; healthy: boolean; rolledBack: boolean; error?: string;
}
export type ContractParse<T> = { ok: true; value: T } | { ok: false; reason: "contract-unknown" | "contract-output-invalid" | "contract-output-too-large" };
export type InstallKind = "npm" | "pnpm" | "bun" | "source" | "mise" | "desktop-app" | "goat" | "standalone" | "ocx-child" | "unknown";
export type UpdateRoute = "orchestrated" | "desktop-request" | "owner-action" | "replant" | "none";
export interface PlanClassification {
  installKind: InstallKind; updateRoute: UpdateRoute; updateReason: string | null; installedVersion: string | null;
  targetVersion: string | null; runtimeOwner: PlanRuntimeOwner; planToken: string | null; updateInFlight: boolean; mutationBoundMs: number;
}
export type ApplyState = "succeeded" | "up-to-date" | "busy" | "refused" | "failed" | "uncertain" | "owner-action" | "unsupported";
export interface UpdateApplyVerdict { state: ApplyState; reason: string | null; fromVersion?: string; toVersion?: string; suppressTarget: boolean; reobserve: boolean }

export function parseChildUpdatePlan(payload: string): ContractParse<ChildUpdatePlan>;
export function parseChildUpdateResult(payload: string): ContractParse<ChildUpdateResult>;
export function classifyChildUpdatePlan(plan: ChildUpdatePlan, ctx: { homeVersion: string; desktopUpdateRequest: boolean; entry: "pair" | "binary" | null }): PlanClassification;
export function mapUpdateApplyExit(code: number, payload: string): UpdateApplyVerdict;
```

Parser rules (both documents): UTF-8 byte length over `UPDATE_OUTPUT_MAX_BYTES` → `contract-output-too-large`;
the payload must be exactly one line holding one JSON object; an object whose `schema` is a string other
than the expected one → `contract-unknown` (a future `/2` never parses as `/1`, D19); then the key set must
equal the documented set exactly (plan: 12 keys plus optional `reason`; result: 8 plus optional `error`).
Field checks: versions are `parseStrictSemver` and at most 128 characters, except plan `currentVersion` may be
`"unknown"` (`orchestrated-entry.ts:122`); `targetVersion`/`toVersion` may be `null`; enums are the closed
unions above; `servingPath`/`cliPath` are strings of 1–4096 characters without NUL; `planToken` matches
`/^[A-Za-z0-9_-]{16,128}$/`; `mutationBoundMs` is a safe integer in 1..3_600_000; `canApply === (reason === undefined)`;
`canApply` true requires `installer ∈ {npm, pnpm, bun}` and a non-null target (`orchestrated-plan.ts:28-38`);
`error` matches `/^[a-z][a-z0-9-]{0,63}$/` (remote text never becomes a reason verbatim beyond that token).

`classifyChildUpdatePlan` (first matching row wins):

| Condition | installKind | updateRoute | updateReason |
| --- | --- | --- | --- |
| `installer === "unknown"` and `cliPath ?? servingPath` contains `/.local/share/goat/opencodex/` or `\.local\share\goat\opencodex\` | goat | owner-action | `goat` |
| `reason === "up-to-date"` | installer | none | `up-to-date` |
| `canApply` and `targetVersion !== ctx.homeVersion` | installer | none | `target-mismatch` |
| `canApply`, installer npm/pnpm, `ctx.entry === "pair"` | installer | owner-action | `launcher-bypassed` |
| `canApply` | installer | orchestrated | null |
| `desktop-app-owned` | desktop-app | `ctx.desktopUpdateRequest ? "desktop-request" : "owner-action"` | `desktop-app-owned` |
| `mise-managed`, `source-checkout` | mise / source | owner-action | the reason |
| `installer-unknown` | unknown | owner-action | `installer-unknown` |
| any other reason | installer | none | `refused:<reason>` |

`installedVersion` is `currentVersion` unless it is `"unknown"` (then null). `updateInFlight` is carried
through; the engine (wp3) turns it into `busy`, and the observe runner persists it on `ChildObservation.updateInFlight` (Revision 5).

`mapUpdateApplyExit(code, payload)` (D12 step 5, refined against the code):

| Exit | Parse | Verdict |
| --- | --- | --- |
| 0 | `applied && healthy` | `succeeded`, from/to from the result |
| 0 | `!applied`, no `error` | `up-to-date` (admission's up-to-date path, `orchestrated-admission.mjs:9`) |
| 0 | anything else or parse failure | `uncertain` `contract-output-invalid`, reobserve |
| 10 | `error === "update-in-flight"` | `busy` `update-in-flight` |
| 10 | other `error` | `refused` with that token (nothing was mutated: admission or `plan-changed`) |
| 10 | parse failure | `refused` `contract-output-invalid` |
| 11 | `rolledBack` | `failed` `rolled-back`, `suppressTarget: true` |
| 11 | otherwise or parse failure | `failed` `update-failed`, `suppressTarget: true` |
| 12 | any | `uncertain` with `error ?? "outcome-unverified"`, reobserve |
| 64 | any | `refused` `contract-usage` |
| other | any | `uncertain` `unexpected-exit`, reobserve (an apply may have started) |

### src/link/child-observations.ts (NEW) and src/link/paths.ts

`paths.ts` gains `export function childObservationsPath(configDir?: string): string { return join(linkDir(configDir), "child-observations.json"); }`.

```ts
export const CHILD_OBSERVATIONS_SCHEMA = "ocx.link.child-observations/1";
export type ChildOp = "observe" | "sync" | "restart-codex" | "update";
export interface ChildOperationSummary {        // the persisted slice of a wp3 job item (D11 ChildJobItemSummary)
  op: ChildOp; jobId: string; state: string; reason: string | null;
  fromVersion?: string; toVersion?: string; finishedAt: string;
}
export interface ChildObservation {
  observedAt: string; source: "plan" | "inspect" | "peer";
  installedVersion: string | null; installKind: InstallKind; runtimeOwner: PlanRuntimeOwner | null;
  updateRoute: UpdateRoute; updateReason: string | null; targetVersion: string | null;
  catalogPulledAt: number | null; lastOperation: ChildOperationSummary | null; suppressedTarget: string | null;
  /** Revision 4. Etag of the catalog bytes served with the pull at catalogPulledAt (020 recorder). Display verdict only. */
  catalogPulledEtag: string | null;
  /** Revision 4. Home catalog etag current when a Home-run pinned sync of this Child last reported synced (030 writes,
   *  050 reads). A GET of /v1/catalog only proves a fetch, so fan-out eligibility uses this field, never catalogPulledAt. */
  catalogSyncedEtag: string | null;
  /** Revision 4. Counted automatic update attempts for one target (070); survives a Home restart. */
  autoUpdateAttempts: { target: string; count: number } | null;
  /** Revision 5 (final review r2). plan.updateInFlight from the last ocx.update.plan/1 probe; null when the observation
   *  did not come from a plan (source "inspect" or "peer", or a Child below 2.97.0). Written by the observe runner beside
   *  updateRoute; read by 070 recover(). Not a carried field: every observe replaces it. */
  updateInFlight: boolean | null;
  /** Revision 4. An update whose result is unknown (030 writes on uncertain; 070 clears after recovery).
   *  desktopRequestId: set by 080's Desktop route so the next run reconciles that request before sending another;
   *  a record carrying it is cleared only by 080's status reconciliation or by expiry, never by a sync. */
  pendingUpdateRecovery: { target: string; since: string; until: string; desktopRequestId?: string } | null;
}
/** Fields an operation or the Home owns; a fresh observe never overwrites them. Missing in an older file ⇒ null. */
export const CARRIED_OBSERVATION_FIELDS = ["catalogPulledAt", "catalogPulledEtag", "catalogSyncedEtag", "lastOperation",
  "suppressedTarget", "autoUpdateAttempts", "pendingUpdateRecovery"] as const;
export function withoutCarriedFields(observation: ChildObservation): Partial<ChildObservation>;
export interface ChildObservationsFile {
  schema: typeof CHILD_OBSERVATIONS_SCHEMA;
  homeCatalog: { etag: string; changedAt: number } | null;   // D6 header, written by wp2
  children: Record<string, ChildObservation>;
}
export function emptyChildObservations(): ChildObservationsFile;
/** Tolerant: unknown keys dropped, an invalid entry dropped, an invalid file or wrong schema reads as empty. */
export function parseChildObservations(text: string): ChildObservationsFile;
/** Missing, unreadable, larger than 1 MiB or damaged → empty. Never throws for content. */
export function readChildObservations(path?: string): ChildObservationsFile;
/**
 * Read–mutate–write under withConfigMutationLockSync. Inside the lock it reads links.json and drops
 * entries whose link id is absent; a damaged links.json disables pruning for that write only.
 * Dir 0700 (hardenSecretDir on Windows), file written with atomicWriteFile then chmod 0600, as writeLinkStore.
 */
export function updateChildObservations(mutate: (file: ChildObservationsFile) => void,
  deps?: { path?: string; storePath?: string; maxEntries?: number }): ChildObservationsFile;
export function patchChildObservation(file: ChildObservationsFile, linkId: string, patch: Partial<ChildObservation>, now: Date): void;
```

Validation reuses the contract unions; `updateReason` and summary `reason` match `/^[a-z][a-z0-9:-]{0,79}$/`;
times are ISO strings that `Date.parse` accepts or finite non-negative epoch ms; `maxEntries` defaults to
256. It is a cache, not a trust boundary (D4), the opposite of `links.json`'s strict `RECORD_KEYS`
(`store.ts:57-68`), so a downgraded Home ignores the file and `links.json` never changes.

### src/link/sync-fanout-classify.ts (NEW) and src/cli/sync-fanout.ts

Move `sync-fanout.ts:6-7`, `:10-82` verbatim (messages, `ChildVerdict`, `parseOcxVersion`,
`classifyVersionProbe`, `mismatchReasons`, `validDocument`, `classifySyncResult`) into the new file, which
imports only `../lib/strict-semver`. `SYNC_FANOUT_PARTIAL_EXIT` and everything from `:84` stay. In
`src/cli/sync-fanout.ts` the moved block becomes:

```ts
export { classifySyncResult, classifyVersionProbe, parseOcxVersion, REMOTE_LINK_SYNC_MESSAGE,
  STALE_REMOTE_CATALOG_MESSAGE, type ChildVerdict } from "../link/sync-fanout-classify";
```

Consumers keep their imports: `src/cli/sync-command.ts:15`, `tests/cli/sync-fanout.test.ts:2`,
`tests/cli/cli-sync-expect-link.test.ts:28`, `tests/update/update-sync-mutex.test.ts:11`,
`tests/clients/link-ephemeral-child-discovery.test.ts:8`, `tests/clients/link-ocx-child-e2e.test.ts:10`.
The `LinkStatusError` import (`sync-fanout.ts:4`) stays with `runHomeFanout`, so the new module never
pulls `src/cli/link.ts` or `src/oauth/login-cli`.

## Field chains

| Field / value | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| `GatedOcxCommand.*` | `remotePinnedSyncArgv`, `remoteUpdate*Argv` | script literals / PowerShell `dataLine` | the Child's `sh` / PowerShell | wp2 observe runner, wp3 engine, wp4 `runChild` |
| `PinnedSyncOptions.restart` | wp4 `sync-command.ts` `runChild`; wp3 `restart-codex` op | `--restart-app-server-only` / `--restart-codex` argv | `readRestartScope` on the Child | N/A in wp1 (no caller) |
| marker `child-ocx-lacks-orchestrated-update` | gate refusal | stderr | `readGatedFraming` | `classifyUpdatePlanProbe` → `legacy`; `classifyUpdateApply` → `owner-action:legacy-ocx` |
| marker `child-ocx-ephemeral` | gate with `acceptEphemeral:false` | stderr | `readGatedFraming` | `ephemeral` / `unsupported:ephemeral` |
| marker `entry:pair|binary` | update gate | stderr | `readGatedFraming` `entry` | `classifyChildUpdatePlan` `launcher-bypassed` row |
| `PlanClassification.*` | `classifyChildUpdatePlan` | `ChildObservation` fields | `parseChildObservations` | wp2 `?children=1` projection, wp3 update item, wp7 sweep |
| `UpdateApplyVerdict.*` | `mapUpdateApplyExit` | wp3 job item `state/reason`; `suppressTarget` → `suppressedTarget` | — | wp3 engine, wp7 retry suppression |
| `child-observations.json` entries | `updateChildObservations` (wp2/wp3 callers) | JSON 0600 | `readChildObservations` | status projection (wp2), engine (wp3), scheduler (wp5/7) |
| `homeCatalog` header | wp2 revision monitor | same file | same reader | wp2 freshness verdict, wp5 fan-out trigger |

## Tests

All three files are `clients` domain and follow 000 "Test registration rule": `"link-gated-ocx-argv.test.ts": "clients"`,
`"link-child-update-contract.test.ts": "clients"` and `"link-child-observations.test.ts": "clients"`, each on one
new line before the closing `}` of `scripts/test-layout/layout-clients.json` and of
`tests/fixtures/test-layout-expected.json`; nothing goes into `layout.json` (1998 lines, ratchet at 2000). POSIX
cases reuse the fake-executable harness of `link-pinned-sync-argv.test.ts:12-36` and `skipIf(win32)`.

`tests/clients/link-gated-ocx-argv.test.ts` (new; fails before implementation: the imports do not exist):
- `update gate never sends update to 2.96.0` — fake `ocx` answers `2.96.0`; plan argv; expect exit 121,
  stderr `ocx-fanout:child-ocx-lacks-orchestrated-update`, calls exactly `--version\n` (the F1 proof).
- `update gate refuses 2.97.0-preview.1` and `accepts 2.97.0 and 2.100.0+build.1` — calls end with
  `update --plan --json --version 2.100.0`; stderr is selection then `ocx-fanout:entry:binary`.
- `served package pair reports entry:pair` — `recordServingRuntime` fixture as at `:196-215` of the sync test.
- `update gate refuses a selected ocx-child` — `$HOME/.local/bin/ocx-child` printing `opencodex 2.98.0` and
  `$OPENCODEX_HOME/child/state.json` present; exit 121, `child-ocx-ephemeral`, no `update` call, temp dir gone.
- `sync gate still runs ocx-child` — same fixture, pinned sync argv; exit 0, calls contain `sync --expect-link`.
- `restart options add exactly one flag` — POSIX calls end `--json --restart-app-server-only` /
  `--restart-codex`; Windows `windowsScriptData` args match; no option → unchanged args.
- `Windows update script` — `windowsScriptData` args, inflated script contains `$b=@('2','97','0')`,
  the ephemeral line and `entry:binary`; encoded length ≤ `POWERSHELL_ENCODED_MAX`.
- `builders validate input` — bad link id, restart value, Home version, plan token, deadline, NUL argument
  and `remoteUpdateApplyArgv(_, "windows")` throw `LinkSshArgumentError`.
- `framing` — table over 255/127/126/125/121 markers, two selection markers, missing delimiter, two entry lines.
- `Child clock marker` (M9) — POSIX plan argv against the fake `ocx` prints exactly one
  `ocx-fanout:child-now:<n>` line on stderr after the selection marker, with `n` within 2 s of the test's
  `Date.now()` (both clocks are the same machine here); the pinned-sync and apply argv print none; the inflated
  Windows plan script contains `ToUnixTimeMilliseconds` and the sync script does not. Framing: one marker ⇒
  `childNowMs` set; no marker ⇒ `null`; two markers or a 17-digit value ⇒ `invalid`;
  `classifyUpdatePlanProbe` carries `childNowMs` into the `plan` verdict.
- `classifier move` — `classifySyncResult` from `src/cli/sync-fanout` is the same function object as from
  `src/link/sync-fanout-classify`.
- `selected kind` (Revision 4) — the pinned-sync argv with `restart: "app-server"` against a fake `ocx-child` candidate
  prints `ocx-fanout:selected-kind:ocx-child` after the selection marker and `classifySyncResult` returns
  `executable: "ocx-child"`; the same argv against a fake `ocx` prints no such line; the plain sync argv never prints it.
- `carried fields` (Revision 4) — a file written before revision 4 parses with the five new fields `null` (including `updateInFlight`);
  `withoutCarriedFields` drops exactly `CARRIED_OBSERVATION_FIELDS`.

`tests/clients/link-child-update-contract.test.ts` (new; fails before implementation):
- `oracle: every plan buildOrchestratedPlan can emit parses` — feed `buildOrchestratedPlan`
  (`src/update/orchestrated-plan.ts:22`) inputs that produce each of the 11 reasons and `canApply`, JSON
  round-trip, expect `ok` and the classification row above.
- `oracle: every result shape parses and maps` — outputs of `classifyOrchestratedOutcome` for exits 0, 11
  (rolled back and not), 12, and of `decideOrchestratedApply` for `plan-changed`, `deadline-passed`,
  `update-in-flight`, up-to-date; expect the mapping table.
- `real CLI plan and usage` (L16: plan and usage cases only; the test never sends `update --yes` to the
  repository tree, even with a past deadline) — spawn `bun src/cli/index.ts update --plan --json` with a temp
  `HOME`, `OPENCODEX_HOME`, `CODEX_HOME` (30 s timeout); expect exit 0, `parseChildUpdatePlan` ok, installer
  `source` → `owner-action` `source-checkout`. `update --plan` without `--json` → exit 64, verdict
  `contract-usage`. The apply-side mapping (`deadline-passed`, `plan-changed`, exit 10) is covered by the
  `decideOrchestratedApply` oracle above, which calls the pure admission function and never spawns an updater.
- `strictness` — extra key, missing key, `schema: "ocx.update.plan/2"` (`contract-unknown`), 64 KiB + 1 payload,
  two JSON lines, `canApply` with a `reason`, `canApply` with installer `mise`, bad token, `error` with spaces.
- `target mismatch and launcher-bypassed rows` — `canApply` plan with another target; npm plan with `entry: "pair"`.

`tests/clients/link-child-observations.test.ts` (new; fails before implementation):
- `missing and damaged files read empty` (`{`, wrong schema, 1 MiB + 1 bytes); next update rewrites a valid file.
- `unknown keys are dropped, invalid entries removed`, valid siblings kept.
- `entries for removed links are pruned on write` — `links.json` fixture with one of two ids.
- `damaged links.json does not prune`.
- `permissions` (POSIX) — dir `0700`, file `0600`; `assertNotRealHomeUnderTest` refuses the real home.

Existing regressions that must stay green unchanged: `tests/clients/link-pinned-sync-argv.test.ts`,
`tests/cli/sync-fanout.test.ts`, `tests/cli/cli-sync-expect-link.test.ts`, `tests/update/update-sync-mutex.test.ts`,
`tests/clients/link-ephemeral-child-discovery.test.ts`, `tests/clients/link-ocx-child-e2e.test.ts`,
`tests/clients/link-ssh-argv.test.ts`, `tests/lab/core-link-boundary.test.ts`.

## Docs and source-of-truth sync

- `structure/remote-link.md:9`: say the pinned sync is one instance of `remoteGatedOcxArgv` (minimum,
  marker, ocx-child and entry options); update verbs require 2.97.0 inside the script, refuse `ocx-child` and
  report the entry kind; name `src/link/child-update-contract.ts` as the Home's own copy of
  `update.orchestrated/1` and `src/link/child-observations.ts` as a tolerant cache beside the strict
  `links.json`. Owned by the existing `src/link/` claim, so no manifest change and no `structure:index` run.
- No docs-site, skills/ocx, CLI registry or GUI locale change: wp1 has no user-visible surface.

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk / wording |
| --- | --- | --- | --- | --- |
| 2.97.0 gate before `update` | runtime, remote script | Child `sh` / PowerShell | none for the selected candidate; a fake `ocx` that lies about `--version` is the Child user's own binary | "the Home never sends `update` to an ocx that reports < 2.97.0", not "cannot" |
| ocx-child refusal | runtime, remote script | same | an `ocx-child` renamed to `ocx` | wording: "by file name" |
| strict parsers | runtime, Home | `child-update-contract.ts` | none; unknown schema refuses | — |
| Windows apply refusal | builder throw | Home | a caller building argv by hand with `remoteGatedOcxArgv` | reviewed in wp3; wording "the shipped builders refuse" |

## Verifiers

| Command | Today | Reads this phase's target |
| --- | --- | --- |
| `bun test tests/clients/link-pinned-sync-argv.test.ts tests/cli/sync-fanout.test.ts tests/lab/core-link-boundary.test.ts tests/clients/link-ephemeral-child-discovery.test.ts` | ran 2026-11-11: 32 pass, 2 skip, 0 fail, exit 0 | yes: imports `src/link/ssh-argv` (`remotePinnedSyncArgv`) and `src/cli/sync-fanout` |
| `bun test tests/cli/cli-sync-expect-link.test.ts tests/update/update-sync-mutex.test.ts tests/clients/link-ssh-argv.test.ts` | ran: 83 pass, 1 skip, 0 fail, exit 0 | yes: `classifySyncResult` and ssh argv |
| `bun test tests/clients/link-gated-ocx-argv.test.ts tests/clients/link-child-update-contract.test.ts tests/clients/link-child-observations.test.ts` | new; fails before implementation | the new modules |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | not run now (layout unchanged yet) | registration of the three files |
| `bun run typecheck` | ran: exit 0, "No type errors in 2,379 files" | all of `src/` |
| `bun run structure:check` | audit r1 on 61151e3457: exit 0 (the earlier 603-line `anthropic-account-pool.md` failure is fixed on `dev`) | `structure/remote-link.md` |
| `wc -l scripts/test-layout/layout.json` | 1998 on 61151e3457; ratchet fails at 2000 (`scripts/file-size-ratchet.ts:4`) | why no entry goes there |
| `bun run privacy:scan` | ran 2026-11-11: "Privacy scan passed"; rerun at PR time | `devlog/` and source |
| CLI oracle: `bun run src/cli/index.ts update --plan --json` with temp homes | ran: exit 0, one `ocx.update.plan/1` line, `installer:"source"`, `reason:"source-checkout"`; `update --plan` exit 64 `{"error":"usage"}`. (The planner's one-time `update --yes ... --not-after 1` run, exit 10 `plan-changed`, is not repeated: L16.) | the contract the parser copies |

## Acceptance criteria

1. A fake Child `ocx` reporting 2.96.0 receives only `--version` from the plan and apply commands (test above).
2. A fake `ocx-child` selected first receives no `update`; the same fixture still syncs.
3. `remotePinnedSyncArgv(id)` behaves exactly as today: every existing pinned-sync test passes unchanged.
4. `remotePinnedSyncArgv(id, p, {restart})` appends exactly one of the two restart tokens on both platforms.
5. Every plan and result this tree's `src/update` can produce parses; any other key set, schema or size refuses.
6. The real CLI's `update --plan --json` output parses and classifies as `owner-action`/`source-checkout`.
7. Exit 11 sets `suppressTarget`; exit 12, 255 and broken framing set `reobserve`; 121 maps to `legacy-ocx`.
8. `child-observations.json` survives damage, drops unknown keys, prunes removed links, is 0600 in a 0700 dir.
9. `src/router.ts`, `src/server/lifecycle.ts` and `src/server/responses/core.ts` still reach no `src/link`
   module (`tests/lab/core-link-boundary.test.ts`).

## Security notes, risks and Windows

The phase adds no route and runs nothing; it shapes what wp3 will send. Risks: a bug in the spliced
version literals (mitigated: closed set, validated digits, fake-executable tests on the real script); a
reason token echoing remote text (mitigated: token regex and closed vocabularies; stdout and stderr are
never stored). Windows: plan probe and sync builders are supported; apply is refused in the builder with
`unsupported:windows-apply` (D20: the kill-on-close Job kills the orchestrating parent when the channel
drops, `structure/remote-link.md:15`).

NOT RUN: `bun run test` (full suite; shared loaded host), `tests/test-layout*.test.ts`.


## wp1 P re-verification (base dev ddee2c2003)

- Stale check: `git diff 00680193cb..ddee2c2003` over every file this phase modifies or reads as an oracle
  (`src/link/ssh-argv.ts`, `remote-windows.ts`, `paths.ts`, `store.ts`, `src/cli/sync-fanout.ts`,
  `src/update/orchestrated-plan.ts`, `orchestrated-outcome.mjs`, `orchestrated-entry.ts`, `src/config/serving-runtimes.ts`,
  `src/lib/strict-semver.ts`, `native/ocx-child/src/lib.rs`, `scripts/test-layout/layout-clients.json`,
  `structure/remote-link.md`) shows only `tests/fixtures/test-layout-expected.json` changed (other branches' entries).
  Line anchors in this doc are current.
- Folded residual from the #8500 final review: the carried-fields test now names five new fields.
- Architect consultation for this phase is the roadmap's (005); no design decision changed at this P.



## Revision 6 (wp1 plan audit, base ddee2c2003)

Audit verdict GO-WITH-FIXES (blockers 2). Dispositions, binding on the implementation:

1. **High, accepted: disable the Desktop CLI handoff inside update gates.** A package launcher forwards `--version` to the
   Desktop's `ocx` through the handoff (`bin/ocx.mjs:1407`, `src/lib/desktop-cli-handoff.mjs:13`) but runs `update`
   itself, so the gate could read a newer Desktop version while `update` reaches an old launcher. Every gated script
   (POSIX and Windows) exports `OCX_NO_DESKTOP_HANDOFF=1` before both the `--version` probe and the exec. The pinned
   sync gate gets it too (harmless: sync was never excluded from the handoff, and the selected binary should answer for
   itself). Test: a fake launcher whose `--version` prints a Desktop version `2.99.0` only when
   `OCX_NO_DESKTOP_HANDOFF` is unset, and `2.93.0` otherwise; the gate must refuse with exit 121 and the fake must
   record no `update` invocation. The bypass record's "Known bypass: none" becomes "none known after the handoff is
   disabled; an install that ignores `OCX_NO_DESKTOP_HANDOFF` would reopen it (every launcher since v2.90.0 honours it)".
2. **High, accepted: keep `windowsPinnedSyncArgv`.** It stays exported from `remote-windows.ts` as a one-line wrapper over
   `windowsGatedOcxArgv`, because `tests/clients/link-ephemeral-child-discovery.test.ts` and
   `tests/clients/link-ssh-argv-discovery.test.ts` import it. Both files join the unchanged-regression list.
3. **Medium, accepted:** `readGatedFraming` returns `ran` whenever exactly one selection marker and the stdout delimiter are
   present, before looking at the exit code; an exit outside the contract after selection maps to `uncertain` (re-check),
   never `failed`.
4. **Medium, accepted with a Home-side fix:** a plan token that starts with `-` (base64url, about 1 in 64) cannot be passed
   to `--expect-plan` (`src/update/orchestrated-arguments.mjs:47` rejects a value starting with `-`, unchanged since
   v2.97.0). `remoteUpdateApplyArgv` omits `--expect-plan` for such a token; the apply is still pinned by `--version`
   (Home version), bounded by `--not-after`, serialized by the Child's update mutex and refused on downgrade. Only the
   plan-consistency check is lost for those Children. Test: a token starting with `-` produces argv without
   `--expect-plan`; any other token includes it. No `src/update/*` change (D19).
5. **Medium, accepted:** the clock marker regex captures `child-now:(.*)` and validates after capture (10–16 digits, safe
   integer); a malformed value yields `childNowMs: "invalid"` as the test expects.
6. **Low, accepted:** the result parser accepts `"unknown"` for `fromVersion`.
7. **Low, accepted:** the new gated-argv test links `date` into its fake tool path.
8. **Low, accepted:** `ChildVerdict` gains an optional `executable` field in the moved classifier; wp4 must drop it before
   building `ocx.sync.fanout/1` output (noted in 040). wp1 has no caller that emits it.
9. **Low, accepted:** `structure/remote-link.md:9` ("without a restart flag" stays true for wp1, but the sentence gains the
   gated builder and the handoff rule) and `structure/cli-management.md:9` (classifier now lives in
   `src/link/sync-fanout-classify.ts`, re-exported) are updated. No manifest change (the `src/link/` claim covers new files).
10. **Low, accepted:** `updateChildObservations` throws `ConfigMutationLockError` on lock contention (`busy_timeout=0`);
   callers in wp2+ handle it. Counts refreshed: `layout.json` 1999 lines, expected fixture 1655 lines,
   `remotePinnedSyncArgv` has 3 test importers.

