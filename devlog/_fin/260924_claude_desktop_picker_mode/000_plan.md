# Claude Desktop: gateway by default, first-party with a risk warning, and a picker that lists opencodex models

Claude Desktop reaches opencodex in two ways. Gateway (3P) switches the whole app to the local
gateway and shows every opencodex model by name. First-party (1P) keeps the app on claude.ai and
routes only the Code tab's Claude Code through a local interception proxy; until now its model
picker could only show Anthropic's models, because claude.ai builds that list. This unit makes
gateway the default for new installs, warns that first-party sends a Claude subscription through
a local interception proxy and can get the account suspended, and adds a first-party **picker
mode**, on by default, that shows opencodex routes by their real names in the Code tab picker.
Picker mode points Desktop's own traffic at the opencodex CONNECT proxy through the
`egressProxyUrl` config-library key (supported in 1P since Desktop 1.44121.1), trusts a local CA
whose name constraints permit only `claude.ai` and its subdomains, and adds entries to the Code surface of the claude.ai
bootstrap. Evidence is in [001_research.md](001_research.md). The threat model stays in scratch
space (`.tmp/260924_claude_desktop_picker_mode/threat_model.md`, untracked) per AGENTS.md until the
change ships; its controls are restated in the decade docs.

## Loop spec

- Loop archetype: satisfy-spec, five work-phases (docs-first, then four dependency-ordered cycles).
- Trigger: the user asked for gateway as the default, a first-party account-suspension warning,
  and first-party picker mode on by default, delivered through a merged PR.
- Goal: a fresh install applies gateway; choosing first-party shows the risk everywhere it can be
  chosen or seen; with first-party applied on macOS the Desktop Code tab picker lists opencodex
  routes by name and a turn with one of them is served by opencodex.
- Non-goals: Chat tab and other non-CLI surfaces; picker trust on Windows and Linux (reported as
  unsupported); OS-wide proxy settings; changing `api.anthropic.com` interception; mentioning or
  copying any third-party project.
- Verifier: per-phase focused suites named in each decade doc, `bun run typecheck`,
  `bun run structure:check`, `bun run skill:surface:check`, `bun run privacy:scan`,
  `bun run lint:gui`, `bun run build:gui`, `bun run test:changed` on the merge result, then the
  live Desktop proof in [040](040_wp5_live_proof_pr_merge.md).
- Stop condition: PR merged to `dev` by squash after exact-head CI, merged tree verified.
- Memory artifact: this unit; goalplan
  `.codexclaw/goalplans/opencodex-claude-desktop-default-to-gateway-3p-w/`.
- Expected terminal outcomes: DONE when every goalplan criterion has fresh evidence; NEEDS_HUMAN
  only for the macOS keychain password dialog during the live proof; BLOCKED on repeated external
  CI blockage; UNSAFE if picker mode could leave Desktop without connectivity.
- Escalation condition: any change to the operator's live service beyond the documented restart,
  any need to disable upstream TLS verification, or a live bootstrap shape that contradicts 001.
- Resource bounds: writes limited to this worktree, `/private/tmp` scratch, the operator's
  Desktop config library and login keychain during the live proof; pushes limited to the PR
  branch and `pr-assets`; gpt-6-sol subagents for discovery, bounded slices and review; no token or
  time budget was set by the user.

## Work-phase map

| Work-phase | Doc | Closes with |
| --- | --- | --- |
| wp1 docs-first | 000, 001 and the decade docs | roadmap locked, no code |
| wp2 gateway default + 1P warning | [010](010_wp2_gateway_default_and_warning.md) | resolver/CLI/API/sync tests, typed locales, docs parity |
| wp3 picker core | [020](020_wp3_picker_core.md) | CA/trust, CONNECT decision, claude.ai relay, bootstrap rewrite, route snapshot tests |
| wp4 picker activation | [030](030_wp4_picker_activation.md) | egress profile, CLI/API/GUI controls, docs, default-on in 1P |
| wp5 live proof + PR + merge | [040](040_wp5_live_proof_pr_merge.md) | Desktop screenshots, usage.jsonl proof, CI green, squash merge |

The phases follow build order: the mode contract (wp2) is consumed by activation (wp4); the relay
and CA (wp3) must exist before anything selects the egress profile (wp4); nothing is shown to a
real Desktop before wp5. One branch, one PR, ordered commits.

## Decisions

Decision IDs come from the architect proposal; dispositions are main's.

| ID | Decision | Disposition |
| --- | --- | --- |
| D1 | Default `gateway`; resolver takes observations (owned first-party settings applied/stale → legacy first-party) with precedence explicit → observed gateway → gateway fingerprint → owned first-party settings → gateway. Implicit applies persist the preserved mode. `/api/sync` stops writing a gateway profile when the resolved mode is first-party. | Accepted. Status stays read-only. Reflections r1/r2: the selected owned gateway row joins the observation; the intercept-disabled fallback is removed, so an observed first-party install keeps its mode and an apply with the intercept disabled is refused with `intercept_disabled`. |
| D2 | One owner for the risk text (`src/claude/desktop-risk.ts`), `riskWarning` in status, CLI apply/status, native toggle response, dashboard selector + active card, 10 locales, 8 guides; default badge moves to gateway. | Accepted. |
| D3 | Separate picker CA under `<configDir>/claude-picker/`, critical nameConstraints permitting `claude.ai` and excluding every IP address, leaf SAN `claude.ai` only; macOS `security add-trusted-cert -r trustRoot -p ssl -k <login keychain>` (the first build passed `-s claude.ai`; #5731 dropped it because Chromium skips host-scoped trust), trust checked with `security verify-cert -q -L -c <leaf> -p ssl -n claude.ai`, removal with `security remove-trusted-cert`. | Accepted, amended: tests use a fake command runner; no real keychain in CI. Reflection r1 gap 4 folded: "trusted" also requires the login keychain to hold a certificate whose SHA-1 equals the current picker CA (`security find-certificate -a -Z -c <CN> <login keychain>`), and `verify-cert` searches that keychain (`-k`). Audit r1 blocker 1 folded: the claim is narrowed to "`claude.ai` and its subdomains" (an RFC 5280 dNSName subtree cannot be exact), and it is only claimed for verifiers shown to enforce it: a Bun/BoringSSL test rejects an off-host leaf issued by the picker CA, and wp5 runs Apple `verify-cert` on an ephemeral off-host leaf after trust; whatever that shows is what the PR states. The primary control stays the 0600 key that never leaves the machine. |
| D4 | CONNECT decides per connection: `messages` (api.anthropic.com), `picker` (claude.ai, only when desired + first-party effective + listener ready + cached trust matches the CA fingerprint), else `blind`. Trust cache invalidated on toggle/rotation, rechecked on a bounded interval. | Accepted. |
| D5 | Dedicated `node:https` HTTP/1.1 terminator for claude.ai with `request` and `upgrade` handlers, fixed upstream `claude.ai:443`, verified TLS, raw headers and bodies streamed. | Accepted after a spike on Bun 1.4.0 (`/private/tmp/ocx-picker-spike/spike.ts`): gzip bytes, two `Set-Cookie` headers and a WebSocket upgrade passed through unchanged. |
| D6 | Rewrite only GET bootstrap responses (`/edge-api/bootstrap`, `/edge-api/bootstrap/{org}/app_start`, `/api/bootstrap…`) with a `code` surface; clone a selectable Claude entry per route; decode gzip/br/deflate under compressed and decompressed caps; fail open with the original bytes. | Accepted, amended: the bootstrap request's `accept-encoding` is narrowed to `gzip, deflate, br` so zstd never arrives. Reflection r1 gap 6 partly folded: clones drop `fast_mode` and every version-gate key (`/version/i`) with the presentation fields; `thinking` and `capabilities` stay because the intercept translates effort and handles images for routed models. |
| D7 | Picker routes mirror the gateway's rendered Desktop profile, ids minted with `aliasForRoute`/`claudeCodeNativeAlias`, served from a snapshot so bootstrap never waits on provider discovery. | Accepted, amended: snapshot built at server start (when picker is desired), on picker on/apply, and refreshed stale-while-revalidate after 10 minutes. |
| D8 | Picker egress profile is an owned standard row containing only `egressProxyUrl`; previous selection recorded in opencodex state (never in `_meta.json`); off/removal/gateway switch: stop terminating, reselect previous, delete owned row, untrust CA; partial cleanup reported. | Accepted. Config field is `claudeCode.intercept.picker?: boolean` (absent = on in 1P on macOS). Reflections r1–r3: every disable first calls the running runtime's `disarm()` (new claude.ai CONNECTs go blind at once, independent of the preference and of the cached mode), then removes the profile, then untrusts. Only an explicit `picker off` persists `false`; mode-transition cleanup leaves the preference unset so first-party turns the picker back on. |
| D9 | `ocx claude desktop picker on|off|status|trust`, `GET/PUT /api/claude-desktop/picker` (standard management auth: CLI admin token and dashboard session), `firstParty.picker` in status with desired/effective/reason/hint/residual. | Accepted; reshaped by D11: `on`/`off` go through the server when one runs; `trust` is the only CLI-local mutation; `off` and transition cleanup run locally only when no server runs. |
| D10 | Live mode propagation: the runtime's `refresh()` decides from a fresh persisted read (resolved mode, Desktop intent, picker preference); `selectTunnel` reads only the cached decision; a disarm latch that only a completed, verified enable clears; server paths adopt committed `claudeCode` for status. | Accepted with the architect's amendments; the POST disarm/refresh routes of earlier revisions are dropped under D11. |
| D11 | While a server runs, every picker mutation (enable, disable, transition cleanup) runs in one server-side `DesktopPickerController`, serialized by one lock; CLI first-party apply delegates to `POST /api/claude-desktop/apply` like gateway apply already does; enable re-reads persisted state, commits an explicit preference first, checks mode/intent/preference/bound proxy before and after trust, and compensates trust it added on any later failure; startup never trusts or writes a profile. | Added at the second P re-entry after audit round 5 (ordering and race findings from rounds 4–5 all came from two mutation sites); architect reflection below. |

## Field chains (PLAN-FIELD-CHAIN-01)

| Field | Creation | Serialization | Deserialization | Consumers |
| --- | --- | --- | --- | --- |
| `claudeCode.intercept.picker?: boolean` | `DesktopPickerController.enable({ persist: true })` / `.disable({ persist: true })` (CLI `picker on|off` and the dashboard toggle through `PUT /api/claude-desktop/picker`); offline CLI `picker off` writes `false` locally before `removeDesktopPickerArtifacts`; first-party apply and transition cleanup never write it (absent = on) | `config.json` through the field-scoped config writer; `src/types/config.ts:151` type; `src/config/schema/config-schema.ts` boolean validation | `loadConfig` → `OcxClaudeCodeConfig.intercept.picker`; a non-boolean fails schema validation | `pickerDesired` (picker-runtime `refresh()`), `DesktopPickerController.enable` checks, `DesktopPickerController.status`, status payload |
| `riskWarning: { code, message } \| null` | status builder (agent-settings-routes), first-party apply response | JSON response | GUI `DesktopStatus` (`gui/src/pages/ClaudeDesktop.tsx:62`); CLI `status` prints every key | GUI callout (localized by `claudeDesktop.mode.firstPartyRisk`, gated on presence), CLI status |
| `firstParty.picker: DesktopPickerStatus` | `DesktopPickerController.status()` in the status builder (with no controller running: a static "proxy_unavailable" status); `GET/PUT /api/claude-desktop/picker` | JSON response | GUI `DesktopFirstPartyStatus` (`ClaudeDesktop.tsx:49`); CLI `picker status` | `ClaudeDesktopPicker` card, CLI output |
| config-library row name `opencodex-picker` | `applyDesktopPickerProfile` | `_meta.json` `entries[].name` (Desktop's schema; no opencodex keys added) | `parseMetadata` (desktop-3p-library) | `isOwnedDesktopEntry` (owned, inspection kind `standard` because the profile has no `inferenceProvider`), `removeDesktopPickerProfile`; `isOwnedDesktopGatewayEntry` stays `name === "opencodex"`, so gateway writes and gateway cleanup never pick it |
| `PUT /api/claude-desktop/picker` body `{ enabled, persist, trustedLocally?, callerAddedTrust? }` | CLI `picker on|off|trust`, dashboard toggle, CLI transition helpers | JSON request | route handler validation (booleans only; unknown keys rejected) | `DesktopPickerController.enable/disable`; `trustedLocally` only selects the trust-outcome wording (`trust_declined` vs `trust_pending`) and never skips a check; `callerAddedTrust` makes the server compensate that trust inside its lock on refusal or failure |
| `ClaudeDesktopModeObservation` | `observeClaudeDesktopMode` | N/A — in-process value | N/A | `resolveClaudeDesktopMode`, `resolveClaudeDesktopApplyMode` callers listed in 010 |

## Guard bypasses (PLAN-BYPASS-NAMED-01)

The trust gate on claude.ai termination is a safety guard, not enforcement.

- Tier: runtime check in process (no OS or build gate).
- Executing surface: `PickerRuntime.selectTunnel` on every new CONNECT to `claude.ai:443`.
- Known bypass: trust removed outside opencodex (Keychain Access) stays cached as trusted for up to
  the 60 s refresh interval; connections opened in that window fail TLS in Desktop until the next
  refresh. An operator who edits the config library by hand can point Desktop elsewhere. While a
  server runs, enable and disable are serialized by the picker controller's lock, and the disarm
  latch is cleared only at the end of an enable whose checks all passed; with no server running,
  nothing can terminate claude.ai. A process that edits opencodex's config or the keychain
  directly, outside these paths, is not constrained.
- Residual risk: Desktop has no network while its pinned egress proxy is down; stated in CLI, GUI
  and docs.
- Wording downgrade: described as a guard everywhere; no document calls it enforcement.
- Final layer: none.

## Architect consultation

- Handle: `01a0d104-9116-7d22-b92d-81bc155eab50` (gpt-6-sol, CXC-ROLE architect, read-only).
- Proposal D1–D9 above; dispositions recorded in the table.
- Reflection on revision r1: MISALIGNED with six gaps. Gap 1 (security working note tracked in
  devlog) folded: the threat model moved to scratch. Gap 2 partly folded, gaps 3–5 folded, gap 6
  partly folded; dispositions are in the decision table.
- Reflection r2: MISALIGNED (3 gaps: intercept-disabled fallback, picker mode from config alone,
  transition cleanup persisting false) — all folded into 010/020/030.
- Reflection r3: MISALIGNED (cleanup could keep terminating while the cached mode was still
  first-party; stale table wording) — folded: `disarm()` first, table updated.
- Reflection r4: MISALIGNED (no server path to disarm without changing the preference; in-flight
  `ensureStarted()` could re-arm) — folded: `POST /api/claude-desktop/picker/disarm`, arm
  generation guard, route and race tests.
- Reflection r5: **ALIGNED**, no remaining material gap.
- After audit round 1 and round 2 amendments: rechecks MISALIGNED (overflow chunk, failed compensation;
  grok-lifecycle source assertions) → folded → **ALIGNED**.
- P re-entry after audit round 3 (LOOP-REPAIR-01): D10 proposed by main, amended by the architect
  (disarm latch, integration intent, native adoption, OFF→ON test), reflection MISALIGNED once
  (integration intent not visible to the runtime) → decision source changed to a fresh persisted
  read → **ALIGNED**.
- Second P re-entry after audit round 5: D11 (single server-side controller) proposed by main;
  the architect amended it three times (transition lease, CLI trust compensation, preference commit
  after independent checks; then restart_required and lost-response handling) → **ALIGNED**.

## Audit record

- Reviewer `01a0d114-541c-7d13-8277-ed9f711dad59` (gpt-6-sol, CXC-ROLE reviewer).
- Round 1: FAIL (7 blockers: CA boundary claim, /api/sync race, durable-OFF cleanup, oversize
  fail-open handoff, signature mismatches, trust compensation, trust_pending test) → all folded.
- Round 2: FAIL (5: overflow triggering chunk, async ensure caller, stale mode passed to enable,
  missing cap seam, hint/declined contract) → all folded.
- Round 3: FAIL (1: committed mode not reaching the running runtime) → returned to P, D10 added.
- Round 4: FAIL (4: stranding Desktop without a bound proxy, failed mode write, latch cleared by a
  caller claim, CLI/route auth mismatch) → folded.
- Round 5: FAIL (4: off→on refused by its own guard, stale intent in CLI apply, concurrent enable
  during cleanup, second-guard compensation) → second P re-entry, D11.
- Round 6: FAIL (4: /api/sync outside the lock, busy guard vs in-lock rearm, lost CLI response
  racing server enable, live-proof rollback leaving picker state) → folded; architect rechecks added
  early-refusal compensation.
- Round 7: FAIL (2: startup refresh missing, config-routes.ts absent from the wp4 inventory) →
  folded; architect recheck added the bounded first-CONNECT wait and the persisted route snapshot.
- Round 8: **GO-WITH-FIXES (blockers=1)** — field-chain rows still named pre-D11 functions →
  folded. Main's judgment: near-pass; no High/Critical blocker remains.

## wp1 close (D)

Roadmap locked at D1–D11; the next cycle is wp2 (gateway default and the first-party risk warning).

- What changed: the unit's plan, research and four diff-level decade docs; the threat model stays in
  scratch.
- Hypotheses that died: "no local change can add a row to the first-party picker" (true only for
  Desktop builds older than 1.44121.1, which lack `egressProxyUrl` in 1P); "Desktop filters
  non-Anthropic model ids" (only the custom-3P provider does; 1P returns `{ok:true}`); "Cloudflare
  in front of claude.ai rejects a re-originated TLS client" — a Bun `node:https` GET of
  `/edge-api/bootstrap` and `/api/bootstrap` returned 200 JSON (brotli) with no `cf-mitigated`
  header (`/private/tmp/ocx-picker-spike/cf.ts`, 2026-09-24).
- What did not improve: the audit needed eight rounds and two returns to P; every late finding was
  about ordering between two mutation sites, which D11 removed. The activation surface is still the
  largest part of the change.
- Evidence that would show the direction is wrong: a logged-in bootstrap without a `code` surface
  in `model_selector_config` (the logged-out bootstrap has no `model_selector_config` at all, so
  this is only checkable in wp5); Desktop's Chromium refusing a login-keychain-trusted root with
  name constraints; the launchd service never able to raise the keychain dialog (then
  `trust_pending` + `picker trust` is the only path, which the plan already supports).
