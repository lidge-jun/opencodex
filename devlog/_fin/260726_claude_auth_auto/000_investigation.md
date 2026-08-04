# 000 — 260726 claude-auth-auto: investigation

## Objective (user's brief, restated)

1. Claude auth가 있는지 보고, 없으면 자동으로 프록시 모드로 실행되게.
2. Claude auth가 등록되면 자동으로 변환되게.
3. 수동 변환(명시적 proxy/subscription)은 그 설정이 계속되도록.
4. "작동 안 된다"는 리포트가 많아서 하드닝 루프까지.

Baseline: `dev` at `fb98fa03` (this unit's docs commit; `911373db` was HEAD when the
section was first drafted). An independent reviewer returned FAIL on the first
roadmap — 2 Critical + 4 High + 2 Medium. Dispositions are in `002_audit_synthesis.md`
and folded into the phase docs below.

## Current authMode flow, with the source located

`OcxClaudeCodeConfig.authMode?: "proxy"` (`src/types.ts:366-369`) — absent means
"subscription", the default. There is no third state today.

`buildClaudeEnv` (`src/cli/claude.ts:28-113`) assembles the launch env:

- never sets `ANTHROPIC_API_KEY` (both token vars trigger Claude Code's auth-conflict
  warning);
- when `config.apiKeys` is non-empty it injects `ANTHROPIC_AUTH_TOKEN = apiKeys[0].key`
  (the proxy admission key) — `:55-57`. This axis is INDEPENDENT of auth mode and is
  not changed by this unit (`002` §2);
- when no AUTH_TOKEN ended up set and `authMode === "proxy"`, it injects
  `ANTHROPIC_AUTH_TOKEN = "opencodex-proxy"` — `:58-60`. This is the proxy-mode marker:
  the proxy accepts it and serves routed models;
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1"` is injected ONLY when an AUTH_TOKEN is
  present (`:79-81`) — the #253 fix: the flag without a host token makes a valid
  subscription look logged out. Regression coverage exists in
  `tests/claude-cli.test.ts` ("subscription mode leaves the host auth assertion
  unset", "a user pre-export of the flag wins").

The management API round-trips the mode: GET `/api/claude-code` returns
`authMode: "proxy" | "subscription"` (`agent-settings-routes.ts:615-617`), and the PUT
persists it — `"proxy"` stores the key, `"subscription"` deletes it
(`agent-settings-routes.ts:693-703`), the round-trip fixed in
`devlog/_fin/260720_claude_authmode_persist`. The GUI select is
`gui/src/pages/claude-code-sections.tsx:38-48` with exactly those two options.

On the wire, `src/server/claude-messages.ts` decides native passthrough (a client
forwarding its own Claude OAuth — the subscription case) at `:91-95` and returns it at
`:558-560`; surface marking is `:514` and `:552-556`.

Beyond the CLI there are three MORE marker-producing paths the first draft missed
(`002` §4): the shell-env file and the launchctl env
(`src/server/system-env.ts:30-35`, `:238-255`), both keyed on a stored `"proxy"`, and
the GUI manual-env snippet (`gui/src/pages/claude-manual-env.ts:36-45`). All of them
must honour the same resolution or auto never reaches ordinary `claude` launches.

## Detection surfaces (verified live on this machine, 2026-07-26)

| # | Source | Shape | Verified |
|---|--------|-------|----------|
| S1 | `~/.claude.json` → `oauthAccount` | JSON; best-effort, not a documented contract | present here: `billingType: "stripe_subscription"` |
| S2 | `.credentials.json` under `CLAUDE_CONFIG_DIR` ?? `~/.claude` | JSON token file | absent here |
| S3 | macOS Keychain `Claude Code-credentials` | `security find-generic-password` exit 0 | present here |
| S5 | `ANTHROPIC_API_KEY` / a USER's `ANTHROPIC_AUTH_TOKEN` | user-exported | — |

S4 (opencodex's own anthropic OAuth credential) was REMOVED by the audit (`002` §5):
`getCredential("anthropic")` reads opencodex's PROVIDER store, which the Claude CLI
never consumes — it is not evidence the client can run natively.

S1 is the cheapest cross-platform read but is best-effort evidence, not a documented
Anthropic contract; the aggregation rule is what keeps that safe. S3 spawns
`security` with metadata flags only (no `-g`/`-w`, which print secret material) and a
failure there must be `unknown`, never `absent`. S5 doubles as detection and
launch-env input — and must exclude our own `opencodex-proxy` marker, or auto feeds
back on itself (`002` §1).

## The design that follows (locked after the failure-mode inventory in 001)

**Auto is a resolution, not a stored value.** `authMode` unset keeps meaning "auto"
(the new default): every launch and every status read recomputes it from the detector.
That is what makes "auth가 등록되면 자동으로 변환" free — there is no stored state to
migrate; the next resolution simply sees the credential.

- auto + auth present → subscription behaviour (no proxy-marker injection; native
  passthrough for claude models). An admission key, if configured, is still injected —
  that axis is orthogonal.
- auto + auth absent → proxy behaviour (`ANTHROPIC_AUTH_TOKEN = "opencodex-proxy"`).
- auto + detection unknown → subscription behaviour + a visible warning. **This is
  the safety rule**: flipping a subscriber into proxy mode because a keychain prompt
  was denied is the worst outcome this feature can produce, so unknown degrades to
  the historical default, never to the new one.

**Manual always wins.** An explicit `"proxy"` or `"subscription"` bypasses the
detector entirely, forever. The auto logic never writes `authMode` — it only reads it.
Storage becomes three-state with literal strings (`"proxy" | "subscription"`, unset =
auto) so "chose subscription" and "never chose" stop colliding, and the GUI select
gains an `Auto` option — without it, every save coerced the user into sticky
subscription with no way back (`002` §3).

## Work-phase map

Round 2 judged the original WP2 too broad and split it (`002` R2 tail):

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` + `001` + `002` | Investigation, failure modes, audit synthesis (4 rounds) | — |
| WP1 | `010_auth_detector.md` | 3-value detector, 4 sources, `staleProxyMarker` | — |
| WP1b | `015_authmode_migration.md` | One-time migration so a legacy explicit Subscription is not silently converted | WP1 |
| WP2 | `020_auto_resolution.md` | Resolver + CLI marker/admission ordering | WP1, WP1b |
| WP2b | `020` §GET/PUT | Management three-state contract | WP2 |
| WP3 | `030_gui_effective_mode.md` | Three-state select + reason line (presentation) | WP2b |
| WP3b | `035_system_env_snapshot.md` | system-env / launchctl marker lifecycle + snapshot semantics | WP2b, WP3 |
| WP4 | `040_hardening.md` | Save wrapper, hijack verification, review, gates, live smoke | WP2, WP3b |

## Accept criteria

Mirrored into the goalplan: c-docs, c-detect, c-auto, c-sticky, c-253, c-gui, c-i18n,
c-hardening, c-gates, c-smoke.

Round 2 added two criteria: **c-migration** (a legacy explicit Subscription survives
the upgrade; a fresh install gets auto) and **c-ordering** (a stale marker never
suppresses the admission key).
