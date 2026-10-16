# 010 — wp2: live Desktop supervision evidence and its projection (PR A → dev)

Branch `codex/desktop-sidecar-cli-authority`, worktree `.tmp/lanes/L1-desktop-cli`. Consumes 000/001/002.

## Outcome

A runtime whose direct parent is an OpenCodex Desktop app, running that app's sibling `ocx`, is reported as
Desktop-supervised whether or not a durable ownership claim exists. Restart safety credits it when that same
app's login registration is verified; otherwise it is at risk with Desktop guidance and **no shell command**.
`ocx resolve --json` carries the fact additively. Durable ownership, takeover consent and every existing
owned-claim path are unchanged.

## Data model (PLAN-FIELD-CHAIN-01)

`DesktopStartupDiagnostic` (src/service/desktop-startup.ts:8-15) gains one optional field:

```ts
/** Present only when the live runtime's direct parent was verified as this Desktop app and no
 *  durable desktop claim exists. Owned-claim diagnostics keep their exact current shape. */
supervisor?: { pid: number; runtimePid: number; app: string };
```

and `deriveDesktopStartup` becomes `viable: (facts.owned || facts.supervisor !== undefined) && facts.loginEnabled && facts.running`.

`StartupHealth` (src/codex/autostart-health.ts:41-71) gains `recommendedAction?: string | null` (a sentence for a
person; never a command).

| Stage | Location |
|---|---|
| creation | `diagnoseMacDesktopStartup`/`diagnoseLinuxDesktopStartup` unowned branch (below); `deriveStartupHealth` sets `recommendedAction` |
| serialization | `__startup-health` child prints StartupHealth JSON (src/cli/internal-command.ts → collectStartupHealth); `/api/startup-health` route returns the cache value; `ocx status --json` embeds `startup`; `ocx resolve --json` adds `supervisor` |
| deserialization | `src/server/startup-health-cache.ts` runProbe parse (spreads parsed JSON — passes both fields through; verify), `src/cli/status.ts` `fetchLiveStartupHealth` validator (:247-287) — must accept protection `desktop`, an optional well-formed `desktop` object and optional string/null `recommendedAction`; Rust `resolve.rs` `Resolved` ignores unknown fields (no `deny_unknown_fields`) |
| consumers | autostart-health `deriveStartupHealth`, `classifyStartupHealthSummary`, `markStartupHealthDiagnosticStale` (startup-health-cache.ts:84-101), `statusServiceSummary` (status.ts:298-318), doctor hint (doctor.ts:1686-1689), status human block (index.ts:1785-1801), GUI `startupRiskDetailKey` and startup-sections.tsx:292 (read `desktop?.owned` — unchanged behavior: recommendedCommand is null for the supervised case, so the GUI shows no service command; GUI wording for unowned supervision is a follow-up, out of PR A to avoid a 10-locale change) |

## File change map

### NEW `src/service/desktop-supervision.mjs` + `src/service/desktop-supervision.d.mts`

Plain ESM (Node and Bun), so wp5 can import it from `bin/ocx.mjs`. Synchronous.

```js
// inspectDesktopSupervision(deps?) → SupervisionEvidence
//   { kind: "desktop", runtimePid, supervisorPid, app, proxy }
//   { kind: "none" }                       // no live pid, or parent is not an OpenCodex desktop app
//   { kind: "unknown", reason }            // probe failed or the two reads disagree
//   { kind: "unsupported" }                // win32 and other platforms
// deps: { platform, readPid, run, proc, realpath, access }
```

- darwin: `/bin/ps -p <pid> -o ppid=,comm=` for the runtime and for its parent (same parser as
  desktop-startup.ts:59-62, moved here and re-exported for desktop-startup). Desktop iff
  `basename(parentExe) === "opencodex-desktop"`, `dirname(parentExe)` ends with `/Contents/MacOS`,
  `realpath(childExe) === realpath(join(dirname(parentExe), "ocx"))`, both executable. Read the whole snapshot
  twice (pid file, child row, parent row) and require equality, else `unknown`.
- linux: procfs reader identical to desktop-startup.ts:40-48 (moved here), same double read; sibling `ocx` rule as
  desktop-startup.ts:150-160.
- pid source: `readPid` dep, default reads `<home>/ocx.pid` via the existing process-state helper's file path
  (the .mjs cannot import TS; take the path from `OPENCODEX_HOME` or `~/.opencodex` exactly as
  `src/config/paths.ts` resolves it — cite and mirror; a pinned test asserts the two agree).
- Every probe: `execFileSync` with `timeout: 750`, `maxBuffer: 128 KiB`, no shell.

### MODIFY `src/service/desktop-startup.ts`

- Import `inspectDesktopSupervision` and `processIdentity`/`procfs` from the new module; delete the local copies.
- `diagnoseMacDesktopStartup` (:65-104): when `owner` is not a desktop claim (today `return undefined` at :69),
  call `inspectDesktopSupervision({platform, readPid, run})`; on `kind !== "desktop"` return `undefined`
  (unchanged output). On `desktop`: verify login for **that** app — the existing plist + launchctl block
  (:76-93) factored into `macLoginEnabledFor(app, plistPath, deps)` minus the install-id comparison — and return
  `deriveDesktopStartup({ owned: false, loginEnabled, running: true, supervisor: { pid, runtimePid, app } })`.
  Owned branch: unchanged bytes except the call into the factored helper.
- `diagnoseLinuxDesktopStartup` (:134-185): same shape; login = `linuxLoginApp(entry)` realpath equals
  `supervision.app`, XDG rule (:146-147) kept.
- `desktopStartupOwnership` (:51-57): unchanged (server request path stays probe-free).

### MODIFY `src/codex/autostart-health.ts`

- :93-95 `desktopEffective` → `… && inputs.desktop !== undefined && inputs.desktop.loginEnabled && inputs.desktop.running && inputs.desktop.viable`
  (owned no longer required; `viable` already encodes owned-or-supervised).
- :108 recommendedCommand null condition → `ownsLocalRouting && inputs.desktop !== undefined`.
- NEW `recommendedAction`: for at-risk + ownsLocalRouting + desktop present:
  login off/unverified → `"Turn on Start at Login in the OpenCodex menu so the desktop app starts this proxy after a restart."`;
  owned but not running → existing owned sentence. Else null.
- `classifyStartupHealthSummary` (:207-221): before the `desktop?.owned` line add
  `if (health.desktop?.supervisor && !health.desktop.loginEnabled) return "AT RISK after restart (OpenCodex Desktop runs this proxy, but its Start at Login is off; turn it on in the OpenCodex menu)";`
  and change the owned line's guard to `health.desktop`.

### MODIFY `src/server/startup-health-cache.ts` `markStartupHealthDiagnosticStale` (:84-101)

`value.desktop?.owned` → `value.desktop` for the null-command case; keep `recommendedAction`.

### MODIFY `src/cli/status.ts`

- `fetchLiveStartupHealth` (:262): accept `"desktop"` in protection; validate `desktop` when present
  (`owned/loginEnabled/running/viable` booleans, optional `supervisor` with finite pids and string app) and
  `recommendedAction` (undefined | null | string ≤ 512 chars). Anything else → null (fallback path, as today).
- `statusServiceSummary` (:308-315): when `liveStartup.desktop?.supervisor`, prefix
  `"OpenCodex Desktop supervises the running proxy; "` and never append a `run '…'` clause (command is null).

### MODIFY `src/cli/index.ts` human status (:1787, ≤ +3 lines; cap 1999, now 1976)

After `Runtime:` print, when `status.json.startup.desktop?.supervisor`:
`   Runtime supervisor: OpenCodex Desktop (pid <pid>, <app>); durable owner: none` (string built by a helper in
`src/cli/status.ts` `runtimeSupervisorLine(startup)` so index.ts grows one line).

### MODIFY `src/cli/doctor.ts` (:1686-1689)

```ts
if (!startup.rebootSafe) {
  if (startup.recommendedAction) hints.push(`Codex is pinned to the local proxy without persistent startup protection. ${startup.recommendedAction}`);
  else { const command = startup.recommendedCommand ?? startup.commands.restoreNative; hints.push(/* existing text */); }
}
```

### MODIFY `src/cli/resolve.ts`

`ResolveJson` adds `supervisor?: { kind: "desktop" | "none" | "unknown" | "unsupported"; pid?: number; app?: string }`
(only when `live`); `buildResolveJson` takes an optional `supervision` argument; `handleResolve` computes it with
`inspectDesktopSupervision()` only after liveness is established and never lets a throw change the exit code.
`reportHuman` adds `supervisor: desktop (pid …)` to its second line when desktop.

## Tests (extend existing files; no new test files)

| File | Case | Activation → observable |
|---|---|---|
| tests/service/service-desktop-startup.test.ts | unowned + child/parent verified + login loaded → `{owned:false, loginEnabled:true, running:true, viable:true, supervisor:{…}}` | fixture owner `{kind:"none"}` |
| same | unowned + login disabled → viable false, supervisor present | `disabled` = `"OpenCodex" => disabled` |
| same | unowned + parent is not opencodex-desktop → `undefined` | parent row = `/usr/bin/zsh` |
| same | unowned + snapshot changes between reads → `undefined` | changedPid |
| same | owned cases unchanged (existing assertions pass byte-for-byte) | — |
| tests/service/service-desktop-startup-linux.test.ts | unowned procfs equivalents (verified, login absent, foreign parent) | proc fake |
| tests/service/service-desktop-startup-health.test.ts (or the file that covers deriveStartupHealth; verify) | supervised+login → protection desktop, recommendedCommand null; supervised no login → at-risk, command null, recommendedAction set, summary names Start at Login | deriveStartupHealth inputs |
| tests/cli/cli-status-startup-health.test.ts | validator accepts protection desktop + desktop object; rejects malformed supervisor; summary has no `run '…'` | payload fixtures |
| tests/cli/cli-resolve.test.ts | `supervisor` present only when live; exit code unchanged when the probe throws | inject supervision fn |
| tests/service/service-desktop-startup.test.ts | `inspectDesktopSupervision` win32 → unsupported; ps throws → unknown | platform/run fakes |

## Verifier

`bun test tests/service/service-desktop-startup.test.ts tests/service/service-desktop-startup-linux.test.ts tests/service/service-desktop-startup-health.test.ts tests/cli/cli-status-startup-health.test.ts tests/cli/cli-resolve.test.ts tests/cli/cli-status-json.test.ts`
(each imports a changed module directly), `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`.
Live read-only check: `bun run src/cli/index.ts status --json` and `resolve --json` from the lane checkout against the
real home must show `startup.desktop.supervisor` and `recommendedCommand: null` on the reporting Mac. This reads the pid
file and runs `ps`/`launchctl print` only. Note: the live runtime is 2.81.0, so `ocx status` may take the **live**
startup health from the 2.81.0 runtime's own probe (old code); the lane CLI only uses its local derivation when the live
read is rejected. Record which path produced the result.

## Docs (SoT)

- `structure/desktop-shell.md` "Runtime ownership, from the app's side": a paragraph that live supervision is a third,
  independent fact (parentage + sibling binary), how it is credited, and that it never becomes ownership.
- `structure/ops/service-and-sidecars.md` desktop startup diagnostics paragraph (:526): unowned supervision branch.
- `structure/runtime.md#background-service-runtime-ownership`: one sentence pointing at the supervision fact.
- docs-site desktop guide (en + ko): "`ocx status` shows *Runtime supervisor: OpenCodex Desktop*; turn on Start at Login".

## Scope

IN: files above. OUT: command guards (020), launcher (030), GUI wording, Windows evidence, Rust shell.

## Risks

- Older running runtimes (2.81.0) answer the live startup-health read with their own old derivation; status prefers it.
  Mitigation in this PR: `selectStatusStartupHealth` keeps preferring live, so the fix shows once the runtime is
  updated; record this in the PR. (Alternative — prefer local when local finds Desktop supervision — rejected: two
  sources for one verdict.)
- `ps comm=` truncation: macOS prints the full path for `comm`; Linux uses procfs. Covered by existing usage.



## r2 amendments (Kant reflection, MISALIGNED → folded)

1. **Old live runtime.** `selectStatusStartupHealth(live, fallback, supervision)` (status.ts:291-296): when the attested
   live verdict has no `desktop` key but `inspectDesktopSupervision({ targetPid: live.pid })` returns `desktop`, use the
   local `fallback()` (new derivation) and mark the JSON `startupSource: "local-supervision-override"`. Rationale: a
   runtime that predates supervision cannot report it; this is a version-capability rule, not a second verdict for new
   runtimes (a live verdict that carries `desktop` always wins). Test: cli-status-startup-health — live payload without
   desktop + supervision desktop → local chosen; with desktop → live chosen. This makes the live acceptance check on the
   reporting Mac achievable.
2. **Target binding.** `inspectDesktopSupervision({ targetPid })`: status and resolve pass the identity-checked
   `live.pid`; the startup-health child passes `readPid()`. When both a target pid and the pid file exist and differ →
   `unknown`. Test: mismatched pid → unknown, no protection, no `supervisor` in resolve.
3. **Ownership kinds.** The unowned branch runs only for `owner.kind === "none"`. `unknown` ownership and CLI-owned
   claims keep today's output (no supervisor credit). The human line prints the real ownership kind. Test: owner unknown
   + desktop parent → `undefined`.
4. **GUI consumers are in scope.** `gui/src/pages/startup-sections.tsx` (:91 activation buttons, :262 service commands,
   :292 recommended) and `gui/src/startup-health-ui.ts` switch from `desktop?.owned` to "desktop present"; a new key
   `startup.desktopSupervisedRecovery` ("OpenCodex Desktop runs this proxy. Turn on Start at Login in the OpenCodex
   menu; service and launcher changes stay disabled while the app runs it.") is added to every locale file under
   `gui/src/i18n/` (count them; the catalog is exhaustive). `StartupRiskDetail.desktop` gains `supervisor?`. Extend
   `tests/gui/startup-health-ui.test.ts`. PR A therefore needs a GUI screenshot (pr-assets branch) of the startup card in
   the supervised state; produce it with the GUI dev server against a stubbed `/api/startup-health` response.
5. **Stale Desktop guidance.** `markStartupHealthDiagnosticStale` keeps `recommendedCommand: null` and sets
   `recommendedAction` to "Reopen OpenCodex and check Start at Login." when `desktop` is present; doctor uses it.
   Test in tests/server (the file covering markStartupHealthDiagnosticStale; locate it) + doctor hint assertion.
6. **Fail-closed for guards** (consumed by 020): `unknown` results carry `desktopSeen: boolean`, true when any read in the
   double-read saw an `opencodex-desktop` parent. Projection treats it as no credit; guards treat it as desktop.
7. **Anchors/wording.** Resolve entry is `runResolve` (src/cli/resolve.ts:250), not `handleResolve`. Service diagnostics
   paragraph is service-and-sidecars.md:536. "Start at Login is off" → "Start at Login could not be verified" when the
   check failed rather than read disabled.



## r3 amendments (Kant re-check)

1. **All projection consumers use the selected verdict.** `src/cli/status.ts` computes `statusServiceSummary` (:760) from
   the startup verdict *after* `selectStatusStartupHealth` (pass the selected value, so a supervision override also
   drops the old `run 'ocx service install'` clause). `src/cli/doctor.ts` (:1382, where doctor chooses live vs local
   startup) applies the same `selectStatusStartupHealth(live, fallback, supervision)` rule; extract the selector so both
   call one function. Tests: status summary under override has no `run '` clause; doctor under override prints the
   Desktop action, not `ocx service install`/`ocx restore`.
2. **Evidence correlation.** `inspectDesktopSupervision({ targetPid })` reads the pid file and `runtime-port.json` pid
   (pid only; the attestation secret is never read into the result). Any two present values that differ → `unknown`
   (`reason: "pid-mismatch"`). Tests: pid file vs runtime-port mismatch → unknown; target vs pid file mismatch → unknown.



## r4 amendments (A audit round 1, FAIL → folded)

- **F4 predicate:** `desktopEffective = platform ∈ {darwin, linux} && !diagnosticStale && desktop !== undefined && (desktop.owned || desktop.supervisor !== undefined) && desktop.loginEnabled && desktop.running && desktop.viable`.
  The existing negative case (tests/service/service-desktop-startup-health.test.ts:26, unowned without supervisor) keeps
  no protection; add the positive supervised case beside it.
- **F5 canonical shapes (one naming everywhere):**
  - ESM evidence: `{kind:"desktop", runtimePid, supervisorPid, app, proxy}` | `{kind:"none"}` |
    `{kind:"unknown", reason, desktopSeen}` | `{kind:"unsupported"}` — all four in `desktop-supervision.d.mts`.
  - `DesktopStartupDiagnostic.supervisor?: { supervisorPid: number; runtimePid: number; app: string }` — copied
    field-for-field from the evidence (supersedes the `pid` name above).
  - `ResolveJson.supervisor?: { kind: "desktop"|"none"|"unknown"|"unsupported"; supervisorPid?: number; runtimePid?: number; app?: string }`.
  - `StatusJson.startupSource: "live" | "local" | "local-supervision-override"` — top-level beside `versionSkew`
    (status.ts:217), set where `selectStatusStartupHealth` runs; JSON-only (no human line). Test asserts each value.
  - GUI `gui/src/pages/startup-shared.ts` `StartupHealthData.desktop` gains `supervisor?` (same shape) and the type gains
    `recommendedAction?: string | null`; `StartupRiskDetail` mirrors `supervisor?`.
  - Serializer anchor corrected: `__startup-health` prints at `src/cli/dispatch.ts:730`.
- **F6 verification list for wp2 (replaces the earlier verifier):**
  `bun test tests/service/service-desktop-startup.test.ts tests/service/service-desktop-startup-linux.test.ts tests/service/service-desktop-startup-health.test.ts tests/service/autostart-health.test.ts tests/cli/cli-status-startup-health.test.ts tests/cli/cli-status-json.test.ts tests/cli/cli-resolve.test.ts tests/gui/startup-health-ui.test.ts <doctor test file that asserts startup hints — locate with rg 'without persistent startup protection' tests>`,
  `bun run typecheck`, `bun run lint:gui`, `bun run build:gui` (GUI type-check + catalog exhaustiveness),
  `bun run structure:check`, `bun run privacy:scan`. GUI component assertion: activation buttons disabled and service
  commands hidden when `desktop.supervisor` is present (startup-sections consumer; extend the existing GUI test that
  renders startup sections, or assert through `startupRiskDetailKey` + an exported predicate `desktopManagesStartup(health)`
  used by startup-sections.tsx so the predicate is unit-tested).
- **Docs cap:** `structure/runtime.md` is at its 600-line cap — the supervision sentence replaces existing text there; the
  bulk lands in desktop-shell.md (545) and service-and-sidecars.md (538).


## r5 (A audit round 2)

- Doctor verifier: extend `tests/codex-integration/doctor.test.ts` (imports `runDoctor`, line 26) with a fixture whose
  startup verdict has `desktop.supervisor`, login unverified, `recommendedCommand: null`, `recommendedAction` set; assert
  the hint contains the action and contains neither `ocx service install` nor `ocx restore`. Add this file to the wp2 verifier.
- Type name: `CliStatusJson.startupSource` (src/cli/status.ts:107).
