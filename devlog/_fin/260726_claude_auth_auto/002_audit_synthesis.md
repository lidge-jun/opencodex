# 002 — A-phase audit synthesis (WP0)

Reviewer: independent explorer subagent (Dewey, `gpt-5.6-terra`, high), read-only,
audited `000`–`040` against the tree at `fb98fa03`. Final line: `VERDICT: FAIL`,
8 blockers (2 Critical, 4 High, 2 Medium). Dispositions below (REVIEW-SYNTHESIS-01).

## Blocker dispositions

### 1. Critical — inherited proxy-marker feedback loop. ACCEPTED.

Root cause: `buildClaudeEnv` clones `process.env` and preserves non-empty values
(`src/cli/claude.ts:28-33`), and opencodex's own system-env file can export
`ANTHROPIC_AUTH_TOKEN=opencodex-proxy` (`src/server/system-env.ts:30-35,
:238-255`). Under naive S5 the next launch reads that as "auth present" →
subscription → but the stale dummy marker rides along and still triggers the
host-managed flag (`cli/claude.ts:79-81`). Reported mode and actual env diverge.

Decision, three parts:

- **The exact marker value `opencodex-proxy` is opencodex-owned state, never user
  auth.** S5 classifies it as `absent` (it is OUR dummy), and additionally the
  detector records `staleProxyMarker: true` when it sees it.
- **Auto→subscription strips a stale marker**: `buildClaudeEnv` deletes
  `ANTHROPIC_AUTH_TOKEN` when its value is exactly the marker AND the resolved mode
  is subscription — otherwise the marker would keep the launch in de-facto proxy
  mode while the badge claims subscription.
- A full two-launch regression test: launch 1 (no auth) exports the marker →
  launch 2 (auth now present) must drop the marker and resolve subscription.

### 2. Critical — apiKeys admission-key precedence. ACCEPTED.

`cli/claude.ts:55-57` injects `config.apiKeys[0].key` unconditionally when the proxy
requires admission — that is pre-existing behaviour orthogonal to auth mode, and the
source comment (`:50-54`) documents that it changes Claude Code behaviour. The plan
must not claim "subscription = no token".

Decision: the resolver answers ONE question — **does the proxy-mode dummy marker
get injected** — and the admission-key axis stays exactly as it is. The GET payload
exposes both (`effectiveAuthMode` for the marker decision, `admissionKeyActive:
config.apiKeys.length > 0` for the pre-existing axis) so the GUI never presents
"subscription" as "no token anywhere". Tests cover detected-credential + apiKeys
configured.

### 3. High — GUI silently converts auto into sticky manual on any save. ACCEPTED.

GET coerces absent → `"subscription"` (`agent-settings-routes.ts:615-617`), the GUI
repeats it (`ClaudeCode.tsx:42-45`), and every save sends `authMode`
(`ClaudeCode.tsx:95-110`) — so opening an untouched config and saving ANY setting
kills auto forever, with no way back (the select has two options only).

Decision: **intent becomes three-state end to end.**

- Config: store the literal strings — `authMode?: "proxy" | "subscription"`; unset =
  auto. The reviewer's suggestion (literal `"subscription"`) replaces my boolean
  (`authModeExplicitSubscription` is dropped): it is self-describing, backward-safe
  (old readers see a truthy non-"proxy" value; old GET code maps non-"proxy" to
  "subscription" anyway), and needs no second field. `OcxClaudeCodeConfig.authMode`
  type widens (`src/types.ts`), `configSchema` gains the enum.
- API: GET returns `authMode: "auto" | "proxy" | "subscription"` (no more coercion);
  PUT accepts all three: `"proxy"` stores proxy, `"subscription"` stores
  subscription, `"auto"` DELETES the key. The 260720 round-trip contract survives —
  the public values are a superset.
- GUI: the select gains `Auto (recommended)` as the first option; the GUI no longer
  coerces absent to subscription. Mounted test: GET(auto) → unrelated edit → save
  must send `authMode: "auto"` (or omit it), never `"subscription"`.

### 4. High — auto-connect paths (shell env file, launchctl, manual-env snippet) don't honour auto. ACCEPTED.

`system-env.ts:32-35` and `:241-255` inject the marker only for a stored `"proxy"`,
so auto+absent users get NOTHING on ordinary `claude` launches — the
"작동 안 된다" class in its purest form.

Decision: ONE resolution contract. `system-env.ts` computes the effective mode via
`resolveClaudeAuthMode(config, detectClaudeAuth(...))` at the time it (re)writes the
env file / launchctl env — injecting the marker when the resolution is proxy
(manual proxy OR auto-absent) and NOT injecting (and removing a stale marker line)
when it is subscription. The GUI manual-env snippet
(`gui/src/pages/claude-manual-env.ts:36-45`) is generated from the same GET payload
so it can never disagree. Shell-file and launchctl tests cover auto absent/present/
unknown + marker cleanup.

### 5. High — S4 is not Claude auth evidence. ACCEPTED.

`getCredential("anthropic")` reads opencodex's PROVIDER credential store
(`~/.opencodex/auth.json`) — the Claude CLI never consumes it, and the native path
needs the credential on the incoming request (`claude-messages.ts:91-95`). S4 is
REMOVED from the detector. The sources are S1, S2, S3, S5 — four, not five.

### 6. High — H1 writer enumeration + false "preserved naturally" claim. ACCEPTED.

`saveConfig` serializes the whole object, so an on-disk `providers` edit is
clobbered by any stale save too, and comparing only `claudeCode` cannot "preserve
unrelated subtrees naturally" — that claim is deleted. The writers in scope are
enumerated: auto-apply (`agent-settings-routes.ts:95-96`), Desktop profile routes
(`:498-499`, `:510-511`, `:531-532`), CLI Desktop commands
(`src/cli/claude-desktop.ts:34-35, :107-108`), and the claude-code PUT. Non-
`claudeCode` preservation is explicitly OUT of scope (recorded as the unit's
residual). Conflict policy documented: when BOTH sides changed the subtree, our save
wins and the snapshot rebases — a three-way merge is out of scope.

### 7. Medium — CLAUDE_CONFIG_DIR + keychain flags. ACCEPTED.

The detector honours `CLAUDE_CONFIG_DIR` like the existing reader
(`src/oauth/local-token-detect.ts:64-68`) instead of a fixed home-relative path, and
unreadable/corrupt credential files classify as `unknown`. The keychain probe uses
`security find-generic-password -s "Claude Code-credentials"` with NO `-g`/`-w`
(metadata only — those flags display secret material). S1's claim is downgraded
from "cross-platform contract" to "best-effort evidence on current Claude Code" —
the aggregation rule (any present wins, unknown never becomes absent) is what makes
that safe.

### 8. Medium — JSON-string compare + missing race tests. ACCEPTED.

H1 compares parsed subtrees with a structural deep-equal (key-order-insensitive),
and the read/write seam is injectable so a deterministic TOCTOU test exists (edit
between read and atomic write). The decisive-race tests are added to the plan:
inherited dummy-marker feedback loop, apiKeys + detected credential, auto-connect
shell/launchctl, GET → unrelated save, PUT concurrent with hand edit.

## Folded citation corrections

Env builder begins `src/cli/claude.ts:28` (not :24); token injection lines are
`:55-60`; native routing is checked at `claude-messages.ts:91-95` and returned at
`:558-560` (surface marking at `:514`, `:552-556`); roadmap baseline recorded as
`fb98fa03`.

## Scope consequence

WP2 grows: the resolver now owns the marker-cleanup rule and the admission-axis
disclosure. WP3 grows: the select is three-state with a "return to auto" path. WP4
grows: system-env/launchctl honour the resolution, and H1's writer enumeration +
conflict policy are explicit. WP1 shrinks: S4 is gone. Every growth is folded into
the decade docs before B.

---

# Round 2 — `VERDICT: GO-WITH-FIXES (blockers=5)` @ `201de404`

### R2-1. Critical — marker cleanup ordered AFTER admission injection. ACCEPTED.

`setDefault` preserves any existing non-empty token (`cli/claude.ts:31-33`), so with
`base.ANTHROPIC_AUTH_TOKEN="opencodex-proxy"` AND `config.apiKeys` configured, the
admission key is skipped at `:55-57` — and then my subscription cleanup deletes the
dummy, leaving the child with NO token at all. That is a worse failure than the one I
was fixing.

Fixed ordering, now normative in `020`:

1. strip an owned dummy from the base env (unconditionally — it is our state, not the
   user's, and it must never shadow a real token);
2. inject the admission key when `config.apiKeys` is non-empty;
3. inject the dummy only when no token remains AND the marker mode resolves proxy.

New test: `stale marker + apiKeys + detected auth` → admission key present, dummy
gone.

Also accepted: `effectiveAuthMode` is a misleading name for "does the dummy marker
get injected", because native passthrough needs an `sk-ant-` credential on the
incoming request (`claude-messages.ts:85-96`). Renamed to **`markerMode`**
(`"proxy" | "subscription"`) end to end — payload, resolver, GUI reason line.

### R2-2. High — the "same base env" claim is not expressed by the call contract. ACCEPTED.

`010`/`020` disagreed with themselves. Fixed: the CLI calls
`detectClaudeAuth({ ...defaultAuthDetectDeps(), env: () => base })` so detection and
the launch read the same environment by construction; `010` drops the removed S4
dependency `hasOcxAnthropicCredential()` and carries `staleProxyMarker` in every
aggregation branch. The two-launch regression drives the DEFAULT dependency path, not
only a fake.

### R2-3. High — legacy explicit-subscription intent is unmigrated. ACCEPTED.

Old subscription selection DELETED the key (`agent-settings-routes.ts:693-703`), so a
pre-upgrade user who deliberately chose Subscription is byte-identical to one who
never chose. Converting both to auto would flip the former into proxy when their
credentials are absent — a silent behaviour change for an explicit choice.

Decision: a one-time, version-sentinel migration. `claudeCode.authModeMigratedAt`
(absent = pre-upgrade config) is written once at startup: an existing config whose
`claudeCode` key EXISTS but has no `authMode` is migrated to the literal
`"subscription"` (preserving the old effective behaviour); a config with no
`claudeCode` key at all, or a fresh install, gets auto. New work-phase WP1b owns it,
with a test for each of the three pre-states.

### R2-4. High — system-env is a snapshot; GET cannot see terminal-local S5. ACCEPTED.

The shell file only changes when `injectSystemEnv` runs (`cli/index.ts:269-273`,
`:315-321`, settings PUT `agent-settings-routes.ts:816-818`), so logging into Claude
after an auto-absent write leaves the marker until an unrelated refresh. And a
daemon-side GET cannot observe an `ANTHROPIC_API_KEY` exported only in the user's
terminal.

Decision: narrow the promise rather than build a watcher (out of scope for this
unit).

- `ocx claude` resolves LIVE every launch — that is the authoritative path and it
  already re-reads everything.
- The shell-env file is documented as a snapshot refreshed by `ocx ensure`, restart,
  or a settings save; a settings save already triggers `applySystemEnvToggle`
  (`:816-818`), so the GUI has a working "re-apply now" affordance.
- The GUI badge labels itself as daemon-side and EXCLUDES process-local S5 from its
  reason, with a note that a terminal-exported key is only visible to `ocx claude`.
  A badge that silently disagrees with the CLI is exactly the report class this unit
  exists to kill.

### R2-5. High — H1 protects the wrong set: ANY route's stale save clobbers claudeCode. ACCEPTED.

Decisive: `model-routes.ts:226-227` changes only `disabledModels` and calls
`saveConfig(config)`, which serializes the WHOLE object (`config.ts:847-859`) — so an
unrelated model toggle overwrites a hand-edited `claudeCode`. Guarding only the
`claudeCode` mutators cannot work.

Decision: the guard moves to a **save wrapper used by every service-time save**, not
per-route. `saveConfigPreservingClaudeCode` becomes the single entry point for routes
holding server config, and the integration test is the reviewer's: hand-edit
`claudeCode`, invoke an unrelated model PUT, assert the hand edit survives. The
missed direct writers (combo migration `combo-routes.ts:164-182`, CLI Desktop
`claude-desktop.ts:117-119`, `:135-138`) are covered by the same wrapper.

### Non-blocking, accepted

Obsolete `claude.authSource.ocx-anthropic-oauth` locale key removed from `030`;
baselines restated as `201de404`.

### WP2 split (reviewer's suggestion, accepted)

WP2 was too broad. New map:

| WP | Slice |
|----|-------|
| WP1 | detector (3-value, 4 sources, staleProxyMarker) |
| WP1b | config migration + version sentinel |
| WP2 | resolver + CLI marker/admission ordering |
| WP2b | management GET/PUT three-state contract |
| WP3 | GUI select + reason line (presentation only) |
| WP3b | system-env / launchctl snapshot semantics + documented refresh |
| WP4 | hardening: save wrapper, hijack verification, review, gates, live smoke |

---

# Round 3 — `VERDICT: GO-WITH-FIXES (blockers=3)` @ `7bcb2087`

### R3-1. High — WP3b dependency order + a false "cannot disagree" claim. ACCEPTED.

WP3b consumes the GET payload (WP2b) and the state mapping that carries
`detectionScope` (WP3), so its dependency is `WP2b, WP3`, not `WP2`. And the manual
snippet CAN disagree with `ocx claude`: daemon detection cannot see a terminal-only
`ANTHROPIC_API_KEY`, so a daemon auto-absent snapshot says proxy while that terminal
resolves subscription. The claim is retracted in `035`; the snippet carries the same
daemon-scope caveat as the badge. Denying a real divergence would manufacture exactly
the confusing report this unit exists to remove.

### R3-2. High — snapshot ownership and an unenforced conversion. ACCEPTED.

Two real defects in my guard:

- A module-global baseline is wrong when another `loadConfig()` refreshes it while the
  server holds an older object — a later stale save then looks like "our change".
  Fixed: `WeakMap<OcxConfig, Snapshot>` keyed on the config INSTANCE, armed by
  `armClaudeCodeBaseline(config)` in `startServer`. Arming is eager, so the FIRST
  service save is already guarded (a lazy arm loses precisely the edit made before it).
- "Every service-time save" was a claim with nothing checking it. Fixed: a stated
  conversion boundary (`src/server/management/**` plus running-service CLI commands,
  including dynamic `await import("../../config")` forms) and a boundary TEST that
  walks those modules and rejects bare `saveConfig(` — the same shape as this repo's
  Grok writer-boundary test. Startup migrations in `src/server/index.ts` are the
  documented exception.

### R3-3. Medium — injected deps could override the env binding. ACCEPTED.

My own new defect: `{ ...defaults, env: () => base, ...injected }` lets a test fake
replace `env` and silently break the invariant I had just added. Fixed by spreading
injected deps FIRST and binding `env` LAST, plus typing the injection as
`Omit<Partial<AuthDetectDeps>, "env">` so it is a compile-time guarantee.

### Non-blocking, accepted

`020` header now names WP1b as a dependency; F8 in `001` is reassigned from WP2 to
WP3b; the sentinel test validates type/value, not truthiness. Reviewer confirmed
R2-1's ordering, R2-3's sentinel placement (PUT spreads `{ ...config.claudeCode }` at
`agent-settings-routes.ts:672` and `ocx init` never creates the block), and the
launchctl predicate swap.

---

# Round 4 — `VERDICT: GO-WITH-FIXES (blockers=1)` @ `7d24e7ff`

### R4-1. High — the save boundary missed request-path runtime writers. ACCEPTED.

`providers/key-failover.ts:115` saves the LIVE config during a 429 rotation, reached
from `server/responses/fetch-helpers.ts:68` — i.e. during an ordinary turn, with no
user action. `providers/api-keys.ts:90,101,113,131` is the same class. My boundary
test scanned only `src/server/management/**`, so a hand-edited `claudeCode` could
still be clobbered by a rate-limit event.

Fixed in `040`: the boundary is defined as **every writer that saves a live server
config**, tabulated across management routes, request-path runtime writers, and
running-service CLI commands; the enforcement test covers the runtime writers too;
and a new regression drives `rotateKeyOn429` against a hand-edited `claudeCode`.
Startup migrations (`server/index.ts`, `providers/*-startup.ts`) are the documented
exception because they run before the server serves requests.

Reviewer confirmed the three R3 amendments themselves are sound (WP3b dependencies,
the honest daemon-scope divergence, the protected env binding, and the WeakMap
baseline avoiding first-save and cross-instance loss).
