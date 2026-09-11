# Audit lanes

Six read-only lanes, each dispatched to an independent `xai/grok-4.6` subagent with a
fresh context. Read scopes are stated per lane so a finding traces to one owner; the
lanes never write, and the main session de-duplicates the returns.

Every lane compares `2f3f73629...origin/dev` and must return exact `path:line` anchors.
A lane that finds nothing returns "no blocker" with the files it actually read.

Lane coverage is checked mechanically: every path in
`git diff --name-only 2f3f73629...origin/dev -- src gui scripts skills package.json`
belongs to at least one lane. The first revision of this map left
`src/cli/{capabilities,index,models-runtime,observe}.ts` unowned, which is why L6 exists.

## L1 — Responses and request pipeline

`src/server/responses/{core,compact,context-overflow,policy-fallback,codex-ws-wire}.ts`,
`src/server/{chat-completions,chat-native,claude-messages,images,search,request-decompress,request-log}.ts`,
`src/claude/inbound.ts`, `src/web-search/{passthrough-bridge,ollama-executor}.ts`.

Highest-risk lane: the new hosted web-search bridge (`passthrough-bridge.ts` +761), the
non-streaming context-overflow classification, agent-task recovery on mid-thread model
switches, and the configurable inbound body admission limit.

## L2 — Codex accounts, quota, OAuth

`src/codex/{account-runtime-state,account-store,account-usability,auth-api,auth-context,inject,quota,quota-auto-refresh}.ts`,
`src/oauth/{health,index,token-guardian}.ts`, `src/cli/{account,account-api,account-auth,account-extended}.ts`.

Deferred validation, revoked pool grants, reauth-state clearing, the new account plan
field, and the token guardian.

## L3 — Catalog, providers, combos, config

`src/codex/catalog/{parsing,provider-fetch,sync}.ts`, `src/providers/{registry,quota,google-ai-studio-model-discovery,opencode-zen-rate-limit}.ts`,
`src/combos/{index,resolve}.ts`, `src/config.ts`, `src/types.ts`, `src/types/{accounts,config,provider}.ts`,
`src/clients/config-export/zcode.ts`, `src/lib/errors.ts`.

Free-model pricing classification and filtering, quota-exhausted inactive marking, AI
Studio discovery restoration, cross-provider blocked-model redirects.

## L4 — Management API, service, GUI

`src/server/management/*`, `src/server/{management-api,auth-cors,index}.ts`, `src/service.ts`,
`gui/src/**`, `gui/tests/**`.

The routed-account log label, the decode-rate column, management auth, the stale launchd
bootout recovery, and nine i18n locale files that must not contradict `en`.

## L5 — Security, privacy, release surface

Cross-cutting read of `src/lib/privacy.ts`, the body-size admission path, web-search
bridge egress, `package.json`,
`scripts/test-layout/layout.json`, `structure/{02_config-and-codex-home,04_transports-and-sidecars}.md`,
and the repository invariants in `AGENTS.md`: the Lab/core import boundary, the
synchronous `startServer` window, no tracked gitlink, and no request-body or credential
logging.

The email-masking opt-out is the specific item to scrutinize: it deliberately weakens a
privacy default, so it must be off by default, must survive `bun run privacy:scan`, and
its CLI application in `src/cli/index.ts` (L6) must agree with the library default.

## L6 — Operator CLI surface

`src/cli/{capabilities,index,models-runtime,observe}.ts`, `skills/ocx/**`, and the
generated surface map that `tests/ci-workflows/skill-ocx.test.ts` asserts.

`src/cli/index.ts` applies `privacy.maskEmails` to `ocx status` and is a
`service-lifecycle.yml` gate path. `capabilities.ts` adds a mutating `ocx account refresh`
with a consent warning. `models-runtime.ts` adds `--free-only`, which filters on
`pricingStatus === "free"` and therefore drops entries with no status. `observe.ts` adds
`--account` log filtering.

## Blocker definition

A finding blocks the release when any of these hold.

1. **Regression against 2.49.0** — behavior that worked in the released tree and does not now.
2. **Crash, hang, or unbounded resource use** on any path a default install can reach.
3. **New-path functional breakage.** A feature introduced in this delta that does not do
   what it claims still blocks, even though it is not a regression. This covers the
   web-search bridge returning wrong or empty results, `--free-only` silently dropping
   models with an absent `pricingStatus`, and a no-op `ocx account refresh`.
4. **Security or privacy weakening**, including a default that becomes less private, a
   credential or request body reaching a log, or a loosened auth boundary.
5. **User-consent or identity-spend bypass**, per `AGENTS.md` "User-consent actions": any
   path that spends the user's identity, credits, or reputation without the code-level
   gate, including a CLI path that mints its own dashboard session.
6. **Core invariant violation**, per `AGENTS.md`: a Lab import reaching `src/router.ts`,
   `src/server/lifecycle.ts`, or `src/server/responses/core.ts`, an `await` inside the
   synchronous `startServer` activation window, or a tracked gitlink.
7. **Upgrade-path breakage**, not only first-run. An existing 2.49.0 install that keeps a
   stale launchd job, a stale config, or a stale service unit after upgrading blocks.
8. **Broken release, packaging, or operator-surface contract**, including a `skills/ocx`
   map that names a command the registry does not have.

Style, missing coverage for unchanged code, and defects that already shipped in 2.49.0
do not block; they are recorded as non-blockers with the evidence that they predate the delta.
