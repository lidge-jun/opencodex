# ocx login codex — route the Codex account names out of the provider wall

## Summary for a reader

`ocx login codex` is the first thing a person types when they want the proxy to
talk to their ChatGPT/Codex account, and until now it answered with a usage list
of roughly ninety provider ids that never contains the word `codex`. The
capability was never missing — the Codex account pool has its own login at
`ocx account login codex` — so the dead end was vocabulary, not function. This
unit routes the three Codex spellings (`codex`, `chatgpt`, `openai`) from
`ocx login` into that existing account-pool flow, and makes the usage wall,
`ocx help` and the CLI registry entry name the route. Nothing about credential
handling, the pool ledger, or the `/api/codex-auth` surface changes.

## Loop spec

- **Loop archetype**: satisfy-spec. One work-phase (wp1), one PABCD cycle.
- **Trigger**: user asked why `ocx login` has no `codex`, then asked to add it
  because people get confused, under `cxc-loop` with reviewer dispatch and a PR.
- **Goal**: `ocx login codex|chatgpt|openai` performs the Codex account-pool
  login; the provider wall and help text name that route; the docs stop
  advertising the stale `ocx login chatgpt` form.
- **Non-goals**: `isPublicOAuthProvider`/`listOAuthProviders` semantics and the
  deliberate `chatgpt` exclusion from the generic `/api/oauth` surface; any
  credential, token, refresh or `/api/codex-auth` behavior; `ocx logout`;
  the GUI; every other CLI command.
- **Verifier**: see the verifier reality table below.
- **Stop condition**: the PR is open against `dev` with the template filled and
  every criterion in the bound goalplan carries fresh captured evidence.
- **Memory artifact**: this unit, plus the goalplan at
  `.codexclaw/goalplans/opencodex-ship-ocx-login-codex-codex-chatgpt-acc/` and
  the session ledger.
- **Expected terminal outcomes**: DONE with the PR URL; NEEDS_HUMAN if the
  requested `xai/grok-4.6` reviewer cannot be routed and the user must pick
  another reviewer model; BLOCKED if the push or PR is refused.
- **Escalation condition**: anything that would touch credential material, log
  into a provider on the user's behalf, or merge/promote the PR. Main reclaims a
  slice after two distinct agents fail its packet; moving a slice to a worker
  requires a P-phase amendment.
- **Resource bounds**: local repository writes only, plus one authorized push and
  one PR creation against `lidge-jun/opencodex`. Reviewer dispatch is read-only.
  No token or wall-clock budget was set by the user, so none is invented.

## Why routing, not a pointer message

`cxc-dev-uiux-design` UX-LAZY-01 orders the options: do nothing, delete, absorb,
demote. "Print a nicer error naming `ocx account login codex`" is the *demote*
answer — it still makes the user learn a second noun before they can log in.
Absorbing is available here because the account flow already accepts the same
argument shape, so the system can take the complexity instead of the user.
UX-STATE-01 covers the failure mode that absorption introduces: the pool login
runs inside the proxy, so it can fail when the proxy is down. That path already
ends in `Proxy is not running. Start it with: ocx start`
(`src/cli/runtime-api.ts:48`), which names its own recovery, so the routed
command never dead-ends either.

Destructive symmetry is deliberately NOT absorbed: `ocx logout codex` keeps its
current behavior, because UX-LAZY-01 exempts destructive actions from magic
defaults and removing a pool account is `ocx account remove openai <id> --yes`.

## File change map

| File | Change |
|------|--------|
| `src/cli/account-auth.ts` | Export `isCodexAccountLoginName()` over the existing private `CODEX_NAMES` set, so the three spellings keep one source of truth. |
| `src/cli/dispatch.ts` | `login` runner: lazily import the predicate, and on a match call `handleAccountAuthCommand("login", argv, { findLiveProxy })` instead of `handleLogin`. Full argv is forwarded, so `--reauth`, `--id`, `--device`, `--code`, `--no-wait` and `--json` keep working. |
| `src/oauth/login-cli.ts` | Extract `loginUsageMessage()` and add a first line naming the Codex route. `handleLogin` prints it. |
| `src/cli/registry.ts` | `login` entry gains `details` naming the Codex route and its running-proxy precondition. |
| `src/cli/help.ts` | Banner line for `ocx login` mentions `ocx login codex`. |
| `tests/cli/cli-dispatch.test.ts` | New describe block: every spelling routes (incl. case/whitespace), flags survive, an unknown flag is still a usage error, the usage text names the route, and `listOAuthProviders()` still excludes `chatgpt`/`codex`. |
| `docs-site/src/content/docs/guides/providers.md` + 7 locale mirrors | Replace the stale `ocx login chatgpt` line and its prose claim with the routed `ocx login codex` form. |

Dependency order: predicate -> routing -> usage/help text -> tests -> docs. Each
step is independently verifiable by `bun test tests/cli/cli-dispatch.test.ts`.

## Field chain (PLAN-FIELD-CHAIN-01)

No new type field or enum value is introduced. The only new value class is the
set of routed names, and its chain is: creation = argv (`deps.args`), matching =
`isCodexAccountLoginName` (`src/cli/account-auth.ts`), consumption =
`handleAccountAuthCommand("login", ...)` -> `login()` -> `CODEX_NAMES.has`
branch -> `/api/codex-auth/login`. Serialization/deserialization: N/A, the value
never leaves the process as data. The pre-existing consumer
`src/cli/model-selection-guidance.ts:3` maps `codex`/`chatgpt` to `openai`
independently and is unaffected.

## Verifier reality (PLAN-VERIFIER-REAL-01)

| Command | Exit | Observes this change? |
|---------|------|-----------------------|
| `bun x tsc --noEmit` | 0 (run on the rebased branch head) | Yes — `tsconfig.json` includes `src` and `tests`, so both edited trees typecheck. |
| `bun test tests/cli/cli-dispatch.test.ts` | 0, 43 pass (rebased head) | Yes — the file is the direct argument and imports `dispatchCommand`, `loginUsageMessage`, `isCodexAccountLoginName`. |
| `bun test tests/cli/cli-registry.test.ts tests/cli/cli-help.test.ts` | 0, 29 pass | Yes — these cross-check `src/cli/help.ts` against `src/cli/registry.ts`, the two text surfaces edited here. |
| `bun test tests/oauth/oauth-public-surface.test.ts` | to run in C | Yes — it owns the `chatgpt` public-surface exclusion this change must not reopen. |
| `bun run test:changed` | to run in C | Partially — it follows Bun's module graph from the changed files; it does not observe the docs-site markdown. |
| docs-site markdown | no gate | No. Nothing in build/typecheck/test reads `docs-site/` content for this claim, so the docs rows are **human review**, verified by `rg` for the stale string. |

## Enforcement bypass (PLAN-BYPASS-NAMED-01)

This unit adds no enforcement layer; it adds routing plus regression tests.
Tier E1 (test suite), executing surface = `bun test` in CI and locally. Known
bypass path: the routing lives in a dispatch runner, so any future caller that
invokes `handleLogin()` directly bypasses it — `src/cli/dispatch.ts` is the only
caller today (verified by grep) and the test asserts through `dispatchCommand`.
Residual risk: a second entry point could reintroduce the wall without failing a
test. Final layer: none. No wording was downgraded.

## Accept criteria

1. `ocx login codex`, `ocx login chatgpt`, `ocx login openai` reach the account
   login. Activation scenario for the conditional path: with no live proxy
   (`findLiveProxy` returning null), the command exits 1 and prints
   `Proxy is not running. Start it with: ocx start`, which `handleLogin` would
   never print. Observable effect proving the branch ran = that exact message.
2. `ocx login codex --reauth --id <id>` reaches the same path (flags forwarded,
   not dropped); `ocx login codex --nope` is still a usage error (exit 2).
3. `loginUsageMessage()` names `ocx login codex`, and `listOAuthProviders()`
   still excludes `chatgpt` and `codex`.
4. `rg "ocx login chatgpt" docs-site` returns nothing.
5. tsc and the focused suites above are green on the branch head.

## Source-of-truth sync (SOT-SYNC-01)

The user-facing source of truth for this surface is
`docs-site/src/content/docs/guides/providers.md` (+ locales) and the CLI's own
help/registry text; both are patched in this unit. `skills/ocx/` is generated
from `src/cli/capabilities.ts`, which declares no `login` capability, so no
surface-map regeneration is required — confirmed by grep before planning.

## Architect consultation

Recorded honestly: this is a C2 slice whose design question (route vs. pointer)
is decided above from an owned skill rule, and the exposed `architect` role is
dispatched for a reflection check on this written plan rather than a fresh design
proposal. Any MISALIGNED finding is folded before A.

