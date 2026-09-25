# 030 — wp4: picker activation (egress profile, controls, default-on in first-party)

Consumes: D8–D11 in [000](000_plan.md) and the wp3 runtime. After this phase a first-party apply
on macOS turns picker mode on unless `claudeCode.intercept.picker === false`.

The organising rule (D11): **while an opencodex server runs, every picker mutation — enable,
disable, transition cleanup — runs inside that server, in one controller, serialized by one
lock.** The CLI and the dashboard call its routes. The only thing a CLI does locally while a
server runs is the keychain trust step, because the password dialog belongs to the operator's
terminal session. With no server running, nothing can terminate claude.ai, so the CLI may remove
picker artifacts locally, and enabling is refused.

> B-phase amendment from wp3 (see 020, "Desktop egress proxy"): Desktop's `egressProxyUrl` names
> `getClaudeInterceptState().pickerProxyPort`, the dedicated picker CONNECT proxy, never the Claude
> Code proxy port. Every "proxy bound" check below means `pickerProxyPort !== null`, and
> `applyDesktopPickerProfile({ proxyPort })` receives that port.

## Files

| Path | Change |
| --- | --- |
| `src/claude/desktop-3p-library.ts` | MODIFY: `DESKTOP_PICKER_ENTRY_NAME = "opencodex-picker"`; `isOwnedDesktopEntry` accepts it; gateway predicate does not |
| `src/claude/desktop-picker-profile.ts` | NEW: apply/remove/inspect the owned egress profile; state in `<configDir>/claude-picker/profile-state.json` |
| `src/claude/desktop-picker.ts` | NEW: `DesktopPickerController` (server) with `enable`/`disable`/`status` under one async lock; `removeDesktopPickerArtifacts` (local cleanup when no server runs) |
| `src/claude/desktop-first-party.ts` | MODIFY: nothing picker-specific beyond exports used by the controller |
| `src/claude/intercept/runtime.ts` | MODIFY (audit wp4 pre-audit, Medium 5): create the controller next to the picker runtime (`isBusy: () => controller?.busy() ?? false`), expose `getClaudePickerController()`, clear it on stop and on a failed start |
| `src/cli/claude-desktop.ts` | MODIFY: first-party apply delegates to the server when one runs; gateway apply and removal ask the server to clean up; `picker on|off|status|trust` subcommand; help |
| `src/cli/ensure-desired-integrations.ts` | MODIFY: `ensureClaudeDesktopMatchesDesired` async and awaited by reconcile; durable-OFF picker cleanup |
| `tests/providers/xai/grok-lifecycle.test.ts` | MODIFY: source-boundary assertions (:61, :79) expect the async declaration and (:86) the awaited call |
| `src/server/management/agent-settings-routes.ts` | MODIFY: `GET/PUT /api/claude-desktop/picker`; status `firstParty.picker`; first-party apply/remove and gateway apply call the controller in process |
| `src/server/management/native-integration-routes.ts` | MODIFY: first-party enable/disable call the controller; `persistDesktopModeMarker` returns the committed subtree and callers adopt it |
| `src/server/management/config-routes.ts` | MODIFY: `/api/sync` Claude Desktop writer runs its post-discovery re-read, re-resolve and write inside `controller.transition` when a controller exists; race test in `claude-desktop-picker.test.ts` |
| `src/server/management/route-registry.ts` | MODIFY: register GET and PUT `/api/claude-desktop/picker` as standard entries (like `/api/claude-desktop/first-party-bindings`, :155) |
| `src/cli/capabilities.ts`, `skills/ocx/references/01_management_surface.md` (generated) | MODIFY: `claude-desktop.picker` capability for both routes; regenerate with `bun run skill:surface` |
| `gui/src/components/ClaudeDesktopPicker.tsx` + `gui/src/styles/claude-desktop-picker.css` | NEW: picker card (toggle, state, offline and restart notes) mounted in first-party mode |
| `gui/src/pages/ClaudeDesktop.tsx`, `gui/src/main.tsx` | MODIFY: mount the card; import CSS |
| `gui/src/i18n/*.ts` (10) | MODIFY: `claudeDesktop.picker.*` keys |
| `docs-site/src/content/docs/**/guides/claude-code.md` (8) | MODIFY: picker mode subsection (what it does, keychain prompt, offline dependency, how to turn off) |
| `structure/clients/claude-desktop.md`, `structure/gui-and-management-api.md` | MODIFY: picker contract, controller, routes, card |

## desktop-picker-profile.ts

```ts
export interface DesktopPickerProfileState { entryId: string; previousAppliedId: string | null }
export type DesktopPickerProfileInspection =
  | { kind: "absent" } | { kind: "applied"; entryId: string; proxyUrl: string }
  | { kind: "not_selected"; entryId: string } | { kind: "unsafe"; reason: string };
export function pickerEgressUrl(proxyPort: number): string;            // http://127.0.0.1:<port>
export function applyDesktopPickerProfile(options: { proxyPort: number; configDir?: string } & Desktop3pConfigLibraryOptions):
  { ok: true; changed: boolean; path: string } | { ok: false; reason: "gateway_selected" | "foreign_unreadable" | "write_failed" };
export function removeDesktopPickerProfile(options: { configDir?: string } & Desktop3pConfigLibraryOptions):
  { ok: true; changed: boolean } | { ok: false; reason: string; residualPaths?: string[] };
export function inspectDesktopPickerProfile(options?: Desktop3pConfigLibraryOptions & { configDir?: string }): DesktopPickerProfileInspection;
```

Apply: refuse while an owned gateway row is selected; reuse the existing picker row or create one
(`randomUUID`, name `opencodex-picker`); write exactly `{"egressProxyUrl":"http://127.0.0.1:<port>"}\n`
atomically; write `profile-state.json` with the current `appliedId` (unless it already is the picker
row); then set `appliedId` to the picker row. Remove: if the picker row is selected, reselect
`previousAppliedId` when that row still exists, else the owned standard row (created as `{}` like
`removeDesktop3pStandardPivot`); delete the picker profile and its `.bak`; drop the metadata row;
delete `profile-state.json`. Foreign rows and `_meta.json` keys other than `appliedId`/`entries` are
preserved; `_meta.json` never carries opencodex keys.

## desktop-picker.ts

```ts
export type DesktopPickerReason = "active" | "restart_required" | "unsupported_platform" | "not_first_party"
  | "integration_off" | "disabled" | "proxy_unavailable" | "mode_not_committed" | "trust_pending"
  | "trust_declined" | "profile_failed";
export interface DesktopPickerStatus { desired: boolean; supported: boolean; trust: PickerTrustState;
  profile: DesktopPickerProfileInspection["kind"]; listenerReady: boolean; effective: boolean;
  reason: DesktopPickerReason; models: number; snapshotAt: number | null; lastBootstrapAt: number | null;
  hint?: string; residual?: string[] }
export interface DesktopPickerController {
  enable(options: { persist: boolean; context: "cli-trusted" | "server"; callerAddedTrust?: boolean }): Promise<DesktopPickerStatus>;
  disable(options: { persist: boolean }): Promise<DesktopPickerStatus>;
  /**
   * Run a whole Desktop mode transition under the controller lock: callers stage slow work
   * (model discovery) first, then inside `fn` do cleanup → mode/profile commit → optional enable
   * with the lock-free inner helpers `ops.disableLocked` / `ops.enableLocked`.
   */
  transition<T>(fn: (ops: { disableLocked(o: { persist: boolean }): Promise<DesktopPickerStatus>;
    enableLocked(o: { persist: boolean; context: "cli-trusted" | "server"; callerAddedTrust?: boolean }): Promise<DesktopPickerStatus> }) => Promise<T>): Promise<T>;
  status(): Promise<DesktopPickerStatus>;
  busy(): boolean;
}
export function createDesktopPickerController(deps: { runtime: PickerRuntime; readConfig: () => OcxConfig;
  persistPreference: (value: boolean) => boolean; proxyPort: () => number | null; configDir: string; security?: SecurityRunner;
  platform?: NodeJS.Platform }): DesktopPickerController;
export function removeDesktopPickerArtifacts(options: { configDir?: string; security?: SecurityRunner }): Promise<{ ok: boolean; residual?: string[] }>;
```

One promise-chain lock serializes `enable`, `disable` and `transition`. The runtime's periodic and
startup `refresh()` calls `isBusy()` and does not arm while the lock is held; the lock owner arms
through `runtime.rearm()`, which is owner-only and bypasses that check (it is only ever called from
inside the lock). Wiring in `src/claude/intercept/runtime.ts`: `let controller: DesktopPickerController
| null = null; const picker = createPickerRuntime({ …, isBusy: () => controller?.busy() ?? false });
controller = createDesktopPickerController({ runtime: picker, … });` and `getClaudePickerController()`
exposes it to the management routes.

**enable({ persist, context })**, inside the lock:
1. Re-read the persisted config (`readConfig`) and check the conditions that do not depend on the
   preference: macOS, persisted first-party mode, Desktop intent on, proxy bound. A failure returns
   its reason and writes nothing. Then, if `persist`, commit `claudeCode.intercept.picker = true`
   (an explicit `picker on` from a false preference is allowed).
2. Re-read the persisted config again and check everything: macOS; persisted resolved mode is
   first-party (`resolveClaudeDesktopMode(fresh, observeClaudeDesktopMode(fresh))`); Desktop
   integration intent on; preference not false; the intercept proxy is bound
   (`getClaudeInterceptState() !== null`). Failures → `unsupported_platform` / `mode_not_committed` /
   `integration_off` / `disabled` / `proxy_unavailable`, nothing written.
3. `ensurePickerCa`, `issuePickerLeaf`, `inspectPickerTrust`. If not trusted: `context: "server"` tries
   `trustPickerCa` once and re-inspects; still untrusted → `trust_pending` with
   `hint: "ocx claude desktop picker trust"`. `context: "cli-trusted"` means the CLI already ran the
   trust step; untrusted then → `trust_declined`. Record whether this attempt added trust.
4. Re-run the step-2 checks.
5. `applyDesktopPickerProfile({ proxyPort })`.
6. `runtime.rearm()` (clears the latch, refreshes, arms when everything holds) → `restart_required`
   until a bootstrap has been served, then `active`.
Any failure after step 3 that follows trust added by this attempt calls `untrustPickerCa`. For a request with `callerAddedTrust: true`, every refusal or failure at any step (including the step-1 and step-2 checks) compensates, but only when the trusted certificate is the current picker CA (SHA-1 match) and the owned picker profile is not selected — a selected profile means an earlier successful enable still depends on that trust; if that fails too the
status carries `residual: ["trust"]`, `effective: false` and `hint: "ocx claude desktop picker off"`.

**disable({ persist })**, inside the lock: `runtime.disarm()` (latch + generation bump) → if
`persist`, commit `claudeCode.intercept.picker = false` → `removeDesktopPickerProfile` →
`untrustPickerCa`. Failed steps are listed in `residual`; status is never "off" while the profile is
selected or trust remains. `persist: true` only for an explicit `picker off`; mode-transition
cleanup passes `false` and leaves the preference unset, so returning to first-party turns the
picker back on.

## Callers

Every server-side Desktop mode change goes through `runDesktopTransition(fn)` (audit wp4 pre-audit, High 2): with a controller it is `controller.transition(fn)`; with none (intercept disabled, client role, failed intercept or picker proxy bind) it calls `fn` with offline ops, where `disableLocked` runs `removeDesktopPickerArtifacts` (no runtime exists, so nothing can terminate claude.ai) and `enableLocked` returns `proxy_unavailable` without writing anything. Gateway apply, first-party removal, native enable and disable, and `/api/sync` therefore keep today's behaviour when no controller exists, plus leftover-artifact cleanup. Tests: with the intercept disabled, gateway apply and native disable succeed and remove a leftover picker row; with the picker proxy unbound, first-party apply succeeds and reports the picker as `proxy_unavailable`.

| Caller | Runs where | Picker call |
| --- | --- | --- |
| Management first-party apply (`POST /api/claude-desktop/apply`) | server | the whole transition inside `runDesktopTransition`, in today's order (audit wp4 pre-audit, High 1): env write with its rollback, then gateway cleanup with today's partial-cleanup reporting, then the committed and adopted mode, then `enableLocked({ persist: false, context: "server" })` when the preference is not false; a partial apply whose mode write failed does not enable |
| `/api/sync` Claude Desktop writer (src/server/management/config-routes.ts:211–237) | server | discovery (`fetchAllModels`) staged first; then inside `runDesktopTransition`: re-read, re-resolve (010), and `writeDesktop3pConfig` only when the resolved mode is not first-party; no controller (intercept not running) → unchanged behaviour |
| Management first-party removal / gateway apply | server | model discovery staged first; then inside `runDesktopTransition`: `disableLocked({ persist: false })`, the gateway write or env removal, and the mode commit |
| Native enable (first-party branch) / native disable | server | inside `runDesktopTransition`: enable after `persistDesktopModeMarker` returns the committed subtree and it is adopted; disable before OFF cleanup and the intent commit |
| `GET/PUT /api/claude-desktop/picker` | server | `PUT { enabled, persist }` → `enable({ persist, context })` with `context: "cli-trusted"` when the request carries `trustedLocally: true` (sent only by the CLI after its trust step), else `"server"`; or `disable({ persist })` |
| CLI `ocx claude desktop apply --first-party` | CLI | on the local hub path with a live proxy, the same branch where gateway apply already delegates (src/cli/claude-desktop.ts:326), delegate to `POST /api/claude-desktop/apply { mode: "first-party" }` (audit wp4 pre-audit, High 3: the connected-client branch before it stays unchanged and never touches the picker); without one: apply locally as today and report the picker as `proxy_unavailable` |
| CLI gateway apply / first-party removal | CLI | with a live proxy: the delegated server apply performs the disable; without one: `removeDesktopPickerArtifacts` locally |
| CLI `picker on` | CLI | requires a live proxy (else `proxy_unavailable`); `PUT { enabled: true, persist: true }`; if the answer is `trust_pending`, run `picker trust` below and repeat the PUT with `trustedLocally: true` |
| CLI `picker trust` | CLI | local `ensurePickerCa` read + `trustPickerCa` (operator's dialog), recording whether this run added trust; then `PUT { enabled: true, persist: false, trustedLocally: true, callerAddedTrust }`. Compensation for trust the CLI added is done by the server inside the lock: enable treats `callerAddedTrust: true` like trust added by the attempt itself, so any refusal or failure after its trust check untrusts it (residual reported if that fails), and success keeps it. The CLI compensates locally only when the PUT could not be delivered at all (connection refused: no server, so nothing can race). A timeout or lost response is ambiguous: the CLI does not touch trust and prints "state unknown — run `ocx claude desktop picker status`" |
| CLI `picker off` | CLI | with a live proxy: `PUT { enabled: false, persist: true }`; without: persist false locally, then `removeDesktopPickerArtifacts`; prints "Fully quit and reopen Claude Desktop" |
| `ensureClaudeDesktopMatchesDesired` durable OFF | CLI / update hook | becomes async and is awaited by `reconcileEnsureDesiredIntegrations` (:188, :199); with a live proxy `PUT { enabled: false, persist: false }`, else `removeDesktopPickerArtifacts` |

Auth: GET and PUT `/api/claude-desktop/picker` are standard registry entries like
`/api/claude-desktop/first-party-bindings` (route-registry.ts:155), so both the CLI admin token
(`runtimeRequest`, src/cli/runtime-api.ts:140) and the dashboard gui-session are accepted; the
`claude-desktop.picker` capability names both routes, as `tests/server/management-route-registry.test.ts`
requires. `trustedLocally` is only a wording hint for the trust outcome; it never skips a check.

Server startup: the runtime's first `refresh()` arms only when every piece already exists
(persisted first-party, intent on, preference not false, trust for the current CA, profile selected
with the current proxy URL, listener up). It never trusts or writes a profile; status reports what is
missing with the `ocx claude desktop picker on` hint.

Native persistence: `persistDesktopModeMarker` (native-integration-routes.ts:656) returns
`{ ok: true; claudeCode } | { ok: false }`; callers adopt with `adoptPersistedClaudeCode`
(src/config/live-reconcile.ts:123), fixing today's unadopted marker. The runtime itself decides from
persisted reads, so adoption is for status and later whole-config saves.

## GUI

`ClaudeDesktopPicker` card (first-party only): title, one-line explanation, toggle
(`PUT { enabled, persist: true }`), state line from `reason` (active / restart Desktop / waiting for
the keychain step with the `hint` command / declined / proxy not running / unsupported on this OS),
model count, and a fixed note: "While picker mode is on, Claude Desktop reaches the network through
OpenCodex. If OpenCodex stops, Desktop is offline until it restarts or picker mode is turned off."
Keys `claudeDesktop.picker.{title,hint,toggle,state.active,state.restart,state.trustPending,
state.trustDeclined,state.proxyUnavailable,state.unsupported,state.notFirstParty,state.profileFailed,
models,offlineNote}` in all ten catalogs.

## Tests (NEW files registered in layout.json + test-layout-expected.json)

| File | Cases |
| --- | --- |
| `tests/claude-integration/claude-desktop-picker-profile.test.ts` | apply creates the row, writes only egressProxyUrl, records previousAppliedId, selects it; re-apply idempotent; remove restores the previous selection, falls back to a standard row when it vanished, keeps foreign rows; gateway selected → refused; metadata write failure rolls back; gateway removal (`removeDesktop3pStandardPivot`) leaves the picker row alone |
| `tests/claude-integration/claude-desktop-picker.test.ts` | enable order CA → trust → recheck → profile → rearm (recorded); preference false → `enable({ persist: true })` → armed; `enable({ persist: true })` with a failed independent condition (mode, intent, proxy, platform) leaves the preference unchanged; each failed precondition (mode not committed, intent off, proxy unbound, non-darwin) → its reason, nothing written; server-context trust failure → trust_pending + hint, no profile; cli-trusted but untrusted → trust_declined; newly added trust removed when the step-4 recheck fails or the profile write fails, pre-existing trust kept, failed untrust → residual ["trust"] and not effective; disable order disarm → persist (only when asked) → remove → untrust; **serialization**: an enable held pending, then a disable queued → after both, the runtime is disarmed and the profile absent; a disable held pending, then an enable queued → the enable runs after cleanup and re-arms only if its checks pass; an enable requested while a gateway `transition` is between cleanup and mode commit waits and then fails `mode_not_committed`; after a successful enable the CONNECT decision is `intercept` both while the lock is still held (owner `rearm()`) and after release, while a periodic `refresh()` during a pending disable does not arm; a `/api/sync` whose discovery resolves while a first-party `transition` holds the lock waits and then writes nothing; a server enable with `callerAddedTrust: true` that fails its recheck untrusts; one refused at the step-1 checks (for example `integration_off`) also untrusts; one refused while the owned profile is already selected from an earlier enable keeps the trust |
| `tests/claude-integration/claude-picker-runtime.test.ts` (wp3 file, extended) | `disarm()` makes the next claude.ai CONNECT blind while the cached mode is still first-party; periodic `refresh()` never clears the latch and skips arming while the controller is busy; a disarm during an in-flight `ensureStarted()` stays disarmed; startup refresh arms only with every piece present |
| `tests/claude-integration/claude-desktop-picker-routes.test.ts` | `PUT { enabled:false, persist:true }` disarms and persists false; `PUT { enabled:true, persist:true }` from a false preference re-arms; both routes accept the admin token; CONNECT decision (`selectTunnel("claude.ai", 443)`, trust and listener faked) is `intercept` after management and native first-party apply from an explicit `desktopMode: "gateway"` marker and after native OFF→ON on a server whose runtime started with the integration OFF, and `blind` after native OFF and after management gateway apply even when a periodic refresh runs |
| `tests/claude-integration/claude-desktop-cli.test.ts` (MODIFY) | `picker on|off|status|trust` parsing and usage errors; `picker trust` sends `callerAddedTrust` truthfully; a refused PUT leaves compensation to the server (fake server untrusts under its lock); connection refused before sending → local untrust of trust this run added; a PUT timeout while the server enable is held before profile selection → the CLI leaves trust alone and the later successful enable keeps it; `on` without a live proxy → proxy_unavailable; `off` offline removes artifacts locally; CLI first-party apply with a live proxy delegates to `POST /api/claude-desktop/apply { mode: "first-party" }` (fake runtimeRequest), also from a durable-OFF start |
| `tests/claude-integration/claude-desktop-first-party.test.ts` (MODIFY) | first-party apply (management, native) enables the picker by default and not when `intercept.picker === false` or when the mode write failed; gateway apply disables it without writing the preference; `ensureClaudeDesktopMatchesDesired` is awaited and its OFF branch removes a selected picker row (live: PUT; offline: local) |
| `tests/server/management-route-registry.test.ts` (MODIFY) | picker routes registered as standard entries and named by the capability |
| `tests/ci-workflows/skill-ocx.test.ts` | surface map current |

Verifier: the files above plus `tests/providers/xai/grok-lifecycle.test.ts`, `bun run typecheck`,
`bun run skill:surface:check`, `bun run structure:check`, `bun run lint:gui`, `bun run build:gui`,
`cd gui && bun test --isolate tests`.

## Audit record

- wp4 pre-audit (reviewer, FAIL: 3 High, 2 Medium) folded: first-party apply keeps its env-first order inside the transition; runDesktopTransition defines the no-controller path; CLI delegation is limited to the local hub branch; callerAddedTrust is in the enable signatures and forwarded by the route (test in claude-desktop-picker-routes); runtime.ts is in the file inventory. Round 2 GO-WITH-FIXES (2): the controller gets a late-bound proxyPort accessor; DesktopPickerStatus carries lastBootstrapAt.
