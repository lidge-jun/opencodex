# 000 — Plan: Claude Code CLI first-party, independent of Claude Desktop (2026-09-25)

## Loop spec

- Class: C4 (the change decides which Claude subscription requests a local TLS interception proxy
  rewrites; it edits the user's Claude Code settings file). Full PABCD per work-phase.
- Mode: HOTL cxc-loop, host goal active; goalplan bound to session 01a0d874-3c68-7123-94ed-b2f03974fed4.
- Worktree: the task worktree, branch feat/claude-cli-first-party, base origin/dev 9c28acf6a1.
- Tool/credential scope: local git, bun, gh (push of this branch and one PR to dev are user-authorized;
  merge, release, and edits to the live ~/.claude or ~/.opencodex are not). Tests use temp dirs only.
- Write scope: src/claude/**, src/server/index/claude-intercept-lifecycle.ts, src/server/index/optional-listeners.ts,
  src/server/management/{agent-settings-routes,native-integration-routes,context}.ts, src/cli/{claude,claude-desktop,integrations,capabilities,ensure-desired-integrations}.ts,
  src/types/config.ts, src/config/load-degrade.ts (src/config/schema/** unchanged), gui/src/** (Claude pages, i18n), docs-site guides/claude-code.md ×8, structure/ docs named below,
  skills/ocx generated surface, tests/** and gui/tests/** for the touched areas, this devlog unit.
- Budget: no stated token bound; wall clock bounded by the host goal. Hitting a real bound reports BUDGET_EXHAUSTED.
- Delegation: gpt-6-sol subagents (V1 family), read-only explorers/architect/reviewers; writers only with disjoint file scopes.

## Objective

Give the standalone Claude Code CLI its own first-party (1P) switch next to Claude Desktop's, so the two
can be turned on and off independently, and stop describing Desktop 1P as "Code tab only".

## Evidence

`001_research.md` (source anchors, Desktop bundle reading, a measured NO_PROXY experiment).

## Architect consultation

- Handle: architect `01a0d8d7-0fe8-7651-b05a-0793fa55983c` (gpt-6-sol, V1 spawn, CXC-ROLE: architect, read-only).
- Proposal: decisions D1–D9, alternative A1, phase map and test plan (returned 2026-09-25).
- Main dispositions:

| ID | Disposition |
|---|---|
| D1 | Accepted. `claudeCode.cliFirstParty?: boolean`, absent = off. Enabling it pins `claudeCode.desktopMode` first when absent (resolved with today's observation), and `observeClaudeDesktopMode` stops counting an owned env as Desktop evidence while CLI 1P is desired. |
| D2 | Accepted. New `src/claude/first-party-settings.ts` owns desired-state computation and `reconcileClaudeFirstPartySettings`. `intercept/settings.ts` stays the low-level ownership-checked writer. |
| D3 | Accepted, amended: `removeDesktopFirstParty` gains a required `config` parameter and keeps the env when CLI 1P is desired and the intercept can run, so the compiler finds every caller. Desktop apply paths keep `applyDesktopFirstParty`. |
| D4 | Accepted, amended: the live `desiredClients()` callback is built in `src/server/index/claude-intercept-lifecycle.ts` (it may import both `desktop-first-party` and `intercept/runtime`; `runtime.ts` may not import `desktop-first-party`, which imports it). Legacy Desktop mode is observed once at intercept start. |
| D5 | Accepted. Unknown, missing or malformed User-Agent relays. |
| D6 | Accepted. Classification reads the HTTPS request, so picker-port arrivals are covered unchanged. |
| D7 | Accepted. CLI 1P on is refused (no state change) when the intercept is disabled, not running in this process, the CA cannot be prepared, settings are unreadable, or a managed key is foreign. Off always persists. |
| D8 | Accepted. `GET/PUT /api/claude-code` carry the flag; `ocx claude config set --first-party on|off`; `claude config` is declared in CAPABILITIES. The native `claude` row keeps meaning "whole Claude surface". |
| D9 | Accepted. `ocx claude` native fallback sets `NO_PROXY=*` / `no_proxy=*` only when an owned intercept env is present, and drops inherited proxy/CA values only when they equal the owned ones. |
| A1 | Deferred. A Desktop-only egress profile would make a bare terminal `claude` fully native, but it moves all Desktop app traffic onto the local proxy and needs a live Desktop acceptance run CI cannot provide. Recorded as follow-up, not built. |

- Reflection: pending (same handle), recorded in `002_consultation.md`.

## Accepted limitation (stated in PR, GUI and docs)

With Desktop 1P on and CLI 1P off, a bare terminal `claude` still reads the shared `HTTPS_PROXY`, so its
traffic transits the local proxy. The intercept relays it upstream unchanged (no model routing, no body,
credential or usage rewrite), but TLS is terminated locally and the proxy must be running. Fully native
terminal use needs `NO_PROXY='*'` in the shell, or `ocx claude` with Claude routing off. The same holds in
reverse for the Desktop Code tab when only CLI 1P is on.

## Contracts fixed by this plan

    // src/types/config.ts — OcxClaudeCodeConfig
    /** Route the standalone Claude Code CLI through the first-party intercept (settings.json env).
     *  Independent of Desktop's first-party mode. Absent/false = off. */
    cliFirstParty?: boolean;

    // src/claude/first-party-settings.ts (NEW)
    export type ClaudeFirstPartyClient = "desktop" | "cli";
    export interface ClaudeFirstPartyDesired { desktop: boolean; cli: boolean }
    export function cliFirstPartyDesired(config: Pick<OcxConfig, "claudeCode">): boolean;          // === true
    export function desktopFirstPartyDesired(
      config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
      observed?: ClaudeDesktopModeObservation,
    ): boolean;   // claudeDesktopIntegrationEnabled(config) && resolveClaudeDesktopMode(config, observed) === "first-party"
    export function firstPartyDesired(config, observed?): ClaudeFirstPartyDesired;
    export type ClaudeFirstPartyReconcileResult =
      | { ok: true; action: "applied" | "removed" | "unchanged"; changed: boolean; path: string }
      | { ok: false; reason: "intercept_disabled" | "ca_unavailable" | "unreadable" | "foreign_env"; path: string };
    export function reconcileClaudeFirstPartySettings(
      config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole" | "clientIntegrations">,
      desired: ClaudeFirstPartyDesired,
      options?: DesktopFirstPartyOptions,
    ): ClaudeFirstPartyReconcileResult;
    // M6: !desired.desktop && !desired.cli -> removeClaudeInterceptSettings(ownedCa)
    //     some desired && !claudeInterceptEnabled(config) -> { ok: true, action: "unchanged", changed: false }
    //     otherwise -> applyDesktopFirstParty(config, options) semantics

    // src/claude/desktop-first-party.ts (MODIFY)
    export function removeDesktopFirstParty(
      config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
      options?: DesktopFirstPartyOptions,
    ): ClaudeInterceptSettingsWrite & { retainedFor?: "cli" };

    // src/claude/intercept/client-class.ts (NEW)
    export type InterceptClient = "desktop" | "cli" | "unknown";
    export const DESKTOP_ENTRYPOINTS: readonly ["claude-desktop", "claude-desktop-3p", "local-agent"];
    export function interceptEntrypoint(userAgent: string | null): string | null; // /^claude-cli\/\S+ \(external, ([A-Za-z0-9._-]+)/
    export function classifyInterceptClient(userAgent: string | null): InterceptClient;
    export function interceptRouteFor(client: InterceptClient, desired: ClaudeFirstPartyDesired): "router" | "relay-native";

    // src/claude/intercept/listener.ts (MODIFY) — ClaudeInterceptListenerOptions
    /** Per-request decision for EVERY path (A1). "relay-native" relays to https://api.anthropic.com. Absent = "router". */
    route?: (req: Request) => "router" | "relay-native";

    // src/claude/intercept/runtime.ts (MODIFY) — StartClaudeInterceptOptions
    /** Live first-party intent; when given, Messages requests of a client whose intent is off relay. */
    desiredClients?: () => ClaudeFirstPartyDesired;

    // GET /api/claude-code (additions)
    cliFirstParty: boolean; cliFirstPartyApplied: boolean; desktopFirstParty: boolean;
    interceptRunning: boolean; sharedProxyInstalled: boolean;
    // PUT /api/claude-code: { cliFirstParty?: boolean }; 400 { code: "cli_first_party_not_alone" } for a mixed body; refusal 409 { error, code: "intercept_disabled" | "intercept_unavailable" | "foreign_env" }; success may carry warnings ["settings_residual" | "settings_rollback_incomplete"], 500 { code: "ca_unavailable" | "unreadable" | "write_failed" }

## Work-phase map (dependency order)

| wp | Doc | Outcome | Verifier |
|---|---|---|---|
| wp1 | 000–002 + all decade docs | Roadmap locked (this cycle, docs only) | independent audit |
| wp2 | 010_foundations.md | config field + schema; first-party-settings.ts; union-preserving removeDesktopFirstParty at every caller; mode-inference fix | focused tests: 4 desired combinations × enable/disable orderings on temp settings files; legacy inference |
| wp3 | 020_intercept_classification.md | client-class.ts; listener route; runtime + lifecycle plumbing with live desired callback | listener tests: UA matrix × desired matrix → router vs relay; picker-port path; relay preserves body/auth |
| wp4 | 030_management_cli.md | /api/claude-code GET/PUT transactional toggle; ensure reconcile; ocx claude config --first-party; CAPABILITIES + skill surface; ocx claude native NO_PROXY | route tests incl. refusals and rollback; CLI parser test; buildNativeClaudeEnv tests; cli-capabilities; skill:surface:check |
| wp5 | 040_surfaces.md | GUI toggle + shared-env notice + copy fixes (10 locales); Desktop help/status copy; docs-site ×8; structure docs | gui tests, lint:gui, build:gui, structure:check, screenshot |
| wp6 | 050_delivery.md | full verification, push, PR to dev, exact-head CI | typecheck, test:changed, privacy:scan, CI run ids |

## Scope

IN: everything in the contracts and phase docs. OUT: Desktop gateway mode, picker CA/keychain trust,
provider routing, A1 egress design, version bumps, merge, live-state edits, shell rc edits.

## Main decisions after the decade docs (revision 2)

- M1 structure/ docs move into the phase that changes the owned source (`src/AGENTS.md:11`: "every doc
  listed for an area is updated in the same change that changes the area"): wp2 updates
  `structure/config.md` and the inference clause of `structure/clients/claude-desktop.md`; wp3 updates
  `structure/runtime.md` and the relay paragraph of `structure/clients/claude-desktop.md`; wp4 updates
  `structure/gui-and-management-api.md`. The paragraphs are the ones already written in `040_surfaces.md`
  §structure; wp5 keeps only GUI, i18n, CLI copy and docs-site.
- M2 wp3 includes the live-config publication in `src/server/management/native-integration-routes.ts`
  (`020` "scope expansion"): the native Desktop toggle and `persistDesktopModeMarker` adopt the committed
  state into the long-lived server config so the intercept callback never reads stale Desktop intent.
- M3 A syntactically valid `claude-cli/<v> (external, <entrypoint>)` whose entrypoint is not in
  `DESKTOP_ENTRYPOINTS` classifies as `cli` (IDE extensions and SDK callers are terminal-side clients).
  Missing or malformed stays `unknown` and relays.
- M4 `030`'s "`{enabled:false}` removes an owned env nobody can serve" is **rejected**. `ocx ensure` refreshes a
  Desktop env only when stale (`src/cli/ensure-desired-integrations.ts:157-160`), so removal would leave a
  re-enabled Desktop 1P without its env. `enabled:false` keeps today's behaviour (env untouched); GET reports
  `cliFirstPartyApplied:false` and `interceptRunning:false`. `{enabled:false, cliFirstParty:true}` is still
  refused before save.
- M5 CLI-on pins an absent `desktopMode` from an observation taken **before** `cliFirstParty` is written,
  inside the same persisted mutation, and rolls both back if reconciliation fails.
- M6 (supersedes the `want` line in the contracts and `010` reconcile body) Desired intent, not intercept
  liveness, decides removal: `reconcileClaudeFirstPartySettings` removes the owned env only when
  `!desired.desktop && !desired.cli`. When some client is desired but `claudeInterceptEnabled(config)` is false it
  returns `{ ok: true, action: "unchanged", changed: false }` and leaves the file alone (consistent with M4;
  the CLI-on route refuses earlier with `intercept_disabled`). Otherwise it applies. `removeDesktopFirstParty`
  retains the env whenever `cliFirstPartyDesired(config)`, independent of intercept liveness.

## Reflection dispositions (revision 3)

Architect reflection returned MISALIGNED with six gaps; all accepted as R1-R6 below and folded into 010/020/030/040.

- R1 (010) Reconciler: remove the owned env only when !desired.desktop && !desired.cli. If some client is desired but claudeInterceptEnabled(config) is false, return {ok:true, action:"unchanged", changed:false} and do not touch the file. Otherwise apply via applyDesktopFirstParty. removeDesktopFirstParty(config, options) retains ({ok:true, changed:false, path, retainedFor:"cli"}) whenever cliFirstPartyDesired(config), regardless of intercept liveness. Invert disabled/client-role test expectations accordingly.
- R2 (030/040) GET cliFirstPartyApplied = cliFirstParty === true && interceptRunning && inspectDesktopFirstParty(config).applied. PUT with enabled:false does NOT reconcile or remove anything (M4). {enabled:false, cliFirstParty:true} refused before any save.
- R3 (020 main-owned, 030/040 consumers) Intercept callback returns {desktop:false, cli:false} when !claudeInterceptEnabled(liveConfig), so a disabled Claude surface relays everything even while the already-bound listener lives until restart. GET interceptRunning = getClaudeInterceptState() !== null && claudeInterceptEnabled(config).
- R4 (030) CLI-on is one field-scoped mutatePersistedConfig that pins an absent desktopMode (observation taken before the write, via observeClaudeDesktopMode on the pre-write config) and sets cliFirstParty:true together, then adoptPersistedClaudeCode into the live config; then reconcile; on reconcile failure a second mutatePersistedConfig reverts exactly those two fields only if they still hold the values written, adopts, and the route returns the coded refusal. cliFirstParty is processed BEFORE every other PUT field: a refusal returns before any other field is saved. CLI-off: field-scoped mutation deleting cliFirstParty, adopt, then reconcile (retains env when Desktop desired).
- R5 (040) When cliFirstParty (or desktopFirstParty) is desired but interceptRunning is false, the GUI shows a warning: the settings proxy points at a proxy that is not running, so plain claude cannot connect until opencodex runs or this is turned off. No new Desktop absent-env reapply path (out of scope, existing behaviour).
- R6 (030) ocx claude native fallback: set NO_PROXY/no_proxy='*' only when the settings env is owned AND neither inherited HTTPS_PROXY nor https_proxy holds a foreign (non-owned) value. With a foreign inherited proxy: do not override; print one warning line that the settings-owned intercept proxy will still apply and name the fix (turn Desktop/CLI first-party off or unset). Tests for owned-only, foreign-inherited, and no-env cases.

- G1-G3 (second reflection, MISALIGNED with three gaps) accepted; folded as "Revision 3" in 030 and 040.
- G4 (third reflection): cliFirstParty is a standalone PUT field; mixed bodies are refused; see 030 Revision 4.

## Audit round 1 synthesis (two independent reviewers, both FAIL)

Security reviewer 01a0d8f3-edb9 (6 blockers) and contract reviewer 01a0d8f3-eed8 (5 blockers) overlapped on the
sharedEnvInstalled chain and the 050 verifier row. All accepted as A1-A8:

- A1 (020) Opted-out traffic goes to real Anthropic on EVERY path: the listener's route callback is evaluated for every request (not only Messages) and returns "router" | "relay-native". "relay-native" -> relayToUpstream(req, CLAUDE_INTERCEPT_UPSTREAM) (the constant https://api.anthropic.com), never claudeCode.anthropicBaseUrl. "router" keeps today's split: Messages -> dispatch, other paths -> relayToUpstream(req, upstreamBase). Absent route = "router". Rename the listener option type to (req) => "router" | "relay-native" and update 000-referenced names accordingly (interceptRouteFor returns "router" | "relay-native"). Tests: custom anthropicBaseUrl configured + opted-out UA -> fake fetch sees https://api.anthropic.com for /v1/messages AND /v1/models; opted-in UA -> /v1/models goes to upstreamBase.
- A2 (030) CLI-on precondition: desktopFirstPartyTarget(config).proxyPort must equal getClaudeInterceptState()!.proxyPort, else 409 code "intercept_unavailable" with message naming the port mismatch (restart needed). Test the mismatch via a deps seam.
- A3 (030) CLI-off and any reconcile that ends with desired={false,false}: after removal, re-inspect settings; if env.HTTPS_PROXY still equals an owned loopback proxy URL for our port (isClaudeInterceptProxyUrl and port match), respond 200 with warnings ["settings_residual"]. Test: owned HTTPS_PROXY + foreign NODE_EXTRA_CA_CERTS, turn CLI off -> 200 + warning, file untouched.
- A4 (020) Add an SSE streaming relay test: fake fetchImpl returns a ReadableStream text/event-stream emitting two events with a delay; assert content-type preserved, both event bytes delivered in order, first event observable before the second is enqueued (incremental), and client abort cancels the upstream stream.
- A5 (030 emitter, 040 consumer) Rename the GET field to sharedProxyInstalled: true iff the settings env HTTPS_PROXY is an owned loopback proxy URL (inspect kind "applied", or "stale" with an HTTPS_PROXY present that isClaudeInterceptProxyUrl). Full chain: GET emitter diff (030), ClaudeCodeState type + fetchCode normalization + warning JSX condition (040), tests: installed+stopped -> stopped-proxy warning; CA-only stale (no HTTPS_PROXY)+stopped -> no stopped-proxy warning; installed+running -> none.
- A6 (030) {enabled:false, cliFirstParty:true} and any other mixed body -> 400 code cli_first_party_not_alone before mutation; update the executable test (was 409 intercept_disabled) and the acceptance table. 000 contract lists the code (main does 000).
- A7 (020) interceptEntrypoint uses an anchored full-shape regex: /^claude-cli\/[^\s()]+ \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/ . Add near-valid malformed cases: 'claude-cli/2.1.282 (external, cli, junk' (no close), 'claude-cli/2.1.282 (external, cli)junk', 'claude-cli/2.1.282 (external,cli)', 'claude-cli/ (external, cli)', leading space — all unknown.
- A8 (050) delivery table corrected: typecheck reads src only (tsconfig.json include); test files are verified only by the direct bun test commands.
- Architect recheck after audit round 1: one gap (A3/A5 predicate mismatch) folded as 030/040 Revision 6 (ownedProxyInstalled).

## Audit round 2 synthesis (both FAIL, converging)

- B1 `ownedProxyInstalled` now lives in the executable wp2 diff (010) and both wp4 call sites (030 GET and PUT residual).
- B2 Port preflight uses pure `claudeInterceptProxyPort`; no proxy-token mint before a refusal (test asserts no token file).
- B3 Predicate no longer port-matched; an owned proxy URL on an older port is "installed"; running + not applied shows the
  existing not-applied variant (040 Revision 7).
- B4 CLI-on success test reaches the precondition through the injected `getClaudeInterceptState` seam; `context.ts` added
  to the write scope.
- B5 050 GUI verifier uses direct `bun test <file>` arguments.

## Replan after audit round 3 (LOOP-REPAIR-01: three failed A rounds → back to P with a changed plan)

Root cause: proxy status was a set of booleans (`sharedProxyInstalled`, `interceptRunning`, `cliFirstPartyApplied`,
`ownedProxyInstalled`) re-derived in four documents, and the settings target port (config-derived) was compared to the
bound listener port at a different time than the write. Both reviewers kept finding the seams between them.

Changed contracts (supersede every earlier definition of the fields named above):

    // src/claude/first-party-settings.ts (wp2)
    export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown"; // F-contract, rules in "Audit cycle 2 round 2 synthesis"
    export interface FirstPartyProxyStatusInput {
      settings: ClaudeInterceptSettingsState;   // inspectDesktopFirstParty(config).settings (read-only, never mints the token)
      boundProxyPort: number | null;            // getClaudeInterceptState()?.proxyPort ?? null
      eligible: boolean;                        // claudeInterceptEnabled(config)
    }
    /** Pure; evaluation order and meaning: see "Audit cycle 2 round 2 synthesis" (F-contract). */
    export function firstPartyProxyStatus(input: FirstPartyProxyStatusInput): FirstPartyProxyStatus;
    export function readFirstPartyProxyStatus(
      config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
      boundProxyPort: number | null,
      options?: DesktopFirstPartyOptions,
    ): FirstPartyProxyStatus;

    // GET /api/claude-code (replaces sharedProxyInstalled)
    cliFirstParty: boolean; desktopFirstParty: boolean; interceptRunning: boolean;   // bound !== null && eligible
    sharedProxy: FirstPartyProxyStatus;
    cliFirstPartyApplied: boolean;   // cliFirstParty && sharedProxy === "live"

- RP1 GUI notices are a function of `sharedProxy` and the two intents only: stopped → stopped-proxy warning (when any
  client desired); broken → "settings point at an opencodex proxy that does not match the running one — run `ocx ensure`
  or restart opencodex"; live with exactly one client desired → shared-relay notice; none with CLI desired →
  not-applied notice; live/stopped/broken with no client desired → residual notice (`settings_residual`).
- RP2 CLI-on port check runs **inside** the locked `mutatePersistedConfig` callback against the persisted config:
  `claudeInterceptEnabled(persisted)` and `claudeInterceptProxyPort(persisted, persisted.port ?? 10100) === bound.proxyPort`;
  on failure the callback returns `{ changed: false }` with the refusal and the route answers 409 (`intercept_disabled` /
  `intercept_unavailable`). The pre-lock check stays only as a fast path. Test: config file on disk gets a new
  `intercept.port` after the server snapshot; seam bound port = old → 409, config and settings untouched.
- RP3 GET and PUT both read liveness through `deps.getClaudeInterceptState` (`context.ts`), so the live/stopped/broken
  states are reachable in `startServer(0, deps)` tests.
- RP4 PUT residual after a nothing-desired reconcile: `readFirstPartyProxyStatus(...) !== "none"` → `warnings: ["settings_residual"]`.
- RP5 `ocx ensure` from a separate process can still write a config-derived port while the server is bound elsewhere; GET
  then reports `broken`. Accepted, documented residual (restart or `ocx ensure` after restart fixes it).
- RP6 Documents are edited in place: every occurrence of `sharedProxyInstalled` / `ownedProxyInstalled` and the earlier
  boolean warning conditions is replaced, and older Revision notes that define them are reduced to "superseded by Replan".

## Audit cycle 2 round 1 synthesis (both FAIL) — status enum extended (E1-E4)

Both reviewers: a disabled-but-bound listener was reported "stopped"; security: unreadable → false "none", foreign-CA "broken" told users to run a command that cannot fix it; contract: port 80 parsed as 0, a tokenless foreign local proxy attributed to opencodex. All accepted:

E-contract (supersedes the four-state enum everywhere):
  export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "unknown";
  firstPartyProxyStatus({ settings, boundProxyPort, eligible }) — pure, evaluated in this order:
   1. settings.kind === "unreadable" -> "unknown".
   2. settings.kind === "absent" -> "none".
   3. proxy = settings.env.HTTPS_PROXY; if !isClaudeInterceptProxyUrl(proxy) -> "none".
   4. settings.kind === "foreign" (CA not ours): if proxy carries the "opencodex:" userinfo (/^http:\/\/opencodex:[^@/]+@/) -> "foreign", else -> "none" (a tokenless local proxy next to a foreign CA is not attributed to opencodex).
   5. boundProxyPort === null -> "stopped".
   6. !eligible -> "disabled" (Claude surface off; the bound listener still relays every request unchanged until opencodex restarts).
   7. port = Number(new URL(proxy).port || 80); settings.kind === "applied" && port === boundProxyPort -> "live"; otherwise -> "broken".
  GET: sharedProxy: FirstPartyProxyStatus; cliFirstPartyApplied = cliFirstParty && sharedProxy === "live"; interceptRunning = bound !== null && eligible.
  PUT residual (after a nothing-desired reconcile): sharedProxy !== "none" -> warnings ["settings_residual"] (for "unknown" the existing unreadable 500 path already applies).
  GUI selectFirstPartyNotice(state) -> "unknown" | "foreign" | "disabled" | "residual" | "stopped" | "broken" | "notApplied" | "shared" | null, first match wins:
   unknown -> "unknown"; foreign -> "foreign"; disabled -> "disabled"; no client desired && sharedProxy !== "none" -> "residual"; stopped -> "stopped"; broken -> "broken"; none && cliFirstParty -> "notApplied"; live && exactly one of (cliFirstParty, desktopFirstParty) -> "shared"; else null.
  Copy: disabled = "Claude routing in opencodex is off. The local proxy still passes these requests through unchanged until opencodex restarts; after that, plain claude cannot connect while the settings remain. Turn first-party off to remove them." foreign = "~/.claude/settings.json points at the opencodex proxy but trusts a certificate opencodex does not manage, so requests fail. Fix HTTPS_PROXY / NODE_EXTRA_CA_CERTS there by hand." unknown = "~/.claude/settings.json could not be read, so opencodex cannot tell whether its proxy is still configured." broken keeps "run ocx ensure or restart opencodex" (only owned-CA mismatches reach it now).
  Tests: classifier table must include every rule incl. port 80 URL (http://opencodex:t@127.0.0.1:80 with bound 80 -> live), tokenless loopback + foreign CA -> none, opencodex-token + foreign CA -> foreign, !eligible + bound -> disabled, bound null + !eligible -> stopped; selector table covers every precedence edge.

## Audit cycle 2 round 2 synthesis (both FAIL) — F-contract

Contract reviewer: disabled promised a relay without checking usability; exhaustiveness check outside typecheck; null treated as missing; disabled copy impossible with both switches off. Security reviewer: legacy token-less URL beside a foreign CA vanished as none; unrecognized status mislabeled as unreadable. All accepted:

F-contract (supersedes the E-contract enum, classifier order, selector order and normalization):
  export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
  firstPartyProxyStatus({ settings, boundProxyPort, eligible }), first match wins:
   1. kind "unreadable" -> "unknown".   2. kind "absent" -> "none".
   3. proxy = settings.env.HTTPS_PROXY; !isClaudeInterceptProxyUrl(proxy) -> "none".
   4. kind "foreign" (CA not ours): proxy has "opencodex:" userinfo -> "foreign"; otherwise -> "local" (a loopback proxy of unconfirmed ownership, e.g. a token-less URL an older opencodex wrote, next to a CA opencodex does not own).
   5. boundProxyPort === null -> "stopped".
   6. usable = kind "applied" && Number(new URL(proxy).port || 80) === boundProxyPort.
   7. !eligible -> usable ? "disabled" : "broken".
   8. usable -> "live"; else "broken".
  GUI normalizeSharedProxy(value): value === undefined -> "none"; one of the eight literals -> itself; anything else (including null) -> "unknown".
  GUI selectFirstPartyNotice(state), first match wins: unknown -> "unknown"; foreign -> "foreign"; local -> "local"; no client desired && sharedProxy !== "none" -> "residual"; disabled -> "disabled"; stopped -> "stopped"; broken -> "broken"; none && cliFirstParty -> "notApplied"; live && exactly one client desired -> "shared"; else null.
  Exhaustiveness lives in GUI SOURCE (typechecked by tsc -p gui/tsconfig.app.json via build/lint): in gui/src/pages/claude-code-first-party.ts export const FIRST_PARTY_PROXY_STATUSES = [...] as const satisfies readonly ClaudeCodeState["sharedProxy"][] plus a const Record<ClaudeCodeState["sharedProxy"], true> coverage map; tests iterate FIRST_PARTY_PROXY_STATUSES.
  Copy: unknown = "opencodex could not determine whether ~/.claude/settings.json still points at its proxy." local = "~/.claude/settings.json sends Claude Code through a local proxy at 127.0.0.1 that opencodex cannot confirm as its own. If you no longer use it, remove HTTPS_PROXY there." disabled (only reached with an intent on) keeps "... Turn first-party off to remove them." residual keeps its existing copy. PUT residual: status !== "none" -> settings_residual (covers local).
  Tests: classifier table adds tokenless loopback + foreign CA -> local, opencodex token + foreign CA -> foreign, !eligible + applied + port match -> disabled, !eligible + stale older port -> broken, !eligible + token drift (kind stale, same port) -> broken; route test: legacy tokenless URL + foreign CA, CLI off -> 200 + settings_residual; selector table iterates FIRST_PARTY_PROXY_STATUSES x four intent pairs; normalization: undefined -> none, null/"future"/42 -> unknown.

## Audit cycle 2 round 3 (security PASS, contract FAIL: recovery advice ignored eligibility) — third failed round, back to P (LOOP-REPAIR-01) with the G-contract

G-contract (adds to the F-contract; classifier unchanged):
  GET /api/claude-code adds interceptEligible: boolean = claudeInterceptEnabled(config) (same snapshot as sharedProxy/interceptRunning; interceptRunning stays bound !== null && eligible).
  ClaudeCodeState gains interceptEligible (normalize: === true; a missing field -> true so an older cache never shows routingOff).
  selectFirstPartyNotice order becomes: unknown; foreign; local; residual (no client desired && sharedProxy !== "none"); disabled; routingOff when (sharedProxy === "stopped" || sharedProxy === "broken") && !interceptEligible; stopped; broken; notApplied; shared; null.
  FirstPartyNotice union gains "routingOff"; catalog key claude.firstParty.routingOff in all ten locales, English: "Claude routing in opencodex is turned off, so these settings point at a proxy that will not serve them. Turn Claude routing back on, or turn first-party off to remove the settings." stopped copy (reached only when eligible) says to start opencodex; broken copy (only when eligible) keeps "run ocx ensure or restart opencodex".
  Tests: selector table gains the interceptEligible dimension for stopped/broken (stopped+!eligible -> routingOff, broken+!eligible -> routingOff, stopped+eligible -> stopped, broken+eligible -> broken); GET route test: config enabled:false with a matching seam-bound listener and stale settings -> sharedProxy "broken", interceptEligible false.

## Audit cycle 3 round 1 (security PASS, contract FAIL: routingOff copy named only one of three ineligibility causes) — H-fix: cause-neutral routingOff copy in ten locales + GET tests for intercept.enabled=false and runtimeRole client.
- Audit cycle 3 round 2: security PASS (cycle 3 round 1), contract PASS; roadmap audit closed.

## Maintainer directive (2026-09-26): no local test suites

The maintainer asked that local test suites not be run. From wp4 on, local verification is limited to non-suite
checks (`bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun run skill:surface:check`,
`bun run lint:gui`, GUI `tsc -p tsconfig.app.json --noEmit`); every test file named in 030/040/050 is verified by
hosted CI on the PR head instead. The `test:changed` run for wp3 was stopped by this directive; wp2/wp3 focused
receipts were recorded before it.
