# 030 — WP3: #252 subagent placeholder sonnet → haiku

## Design

The Agent tool's `model` argument is ignored by the proxy (routing is pinned by the
`<!-- ocx-route: ... -->` directive), but our injected guidance tells the model to
pass `model: "sonnet"` as the placeholder. Claude Code UI then displays "sonnet",
indistinguishable from a genuine Sonnet call (issue #252, screenshot evidence).
Reporter's own proposal: use the lowest tier (`haiku`) as the placeholder so a
placeholder-labeled call reads as obviously-not-the-real-model.

`"haiku"` validity evidence: agents-inject.ts:4 documents the Agent tool's `model`
argument as a hard 4-alias enum (2.1.207 binary) without enumerating members;
`context-windows.ts:142-146` (`ClaudeTierModels` with `sonnet?`/`haiku?` slots) is
corroborating tier-alias evidence only — neither source proves Agent-tool enum
acceptance (re-audit finding 2).
B phase MUST verify the enum acceptance live before committing: dispatch one agent
with `model: "haiku"` through the injected definition and confirm no client-side
rejection — the live dispatch is the AUTHORITATIVE acceptance gate (same live-proof
standard as the devlog 072 fallback evidence). If the
client rejects "haiku", stop and amend this doc (audit finding 7a).

## MODIFY src/claude/agents-inject.ts

```ts
// before (:234-236)
 * placeholder: any value works, "sonnet" is the cheap canonical one.
 */
const NO_MODEL_ARG = "NOTE: this agent's real model is pinned by the opencodex proxy — the `model` argument is ignored. Pass model: \"sonnet\" as a placeholder (or omit it); routing is unaffected either way.";
// after
 * placeholder: any value works; "haiku" is canonical because a haiku-labeled call
 * is visibly a placeholder in the Claude Code UI, while "sonnet" was
 * indistinguishable from a genuine Sonnet call (issue #252).
 */
const NO_MODEL_ARG = "NOTE: this agent's real model is pinned by the opencodex proxy — the `model` argument is ignored. Pass model: \"haiku\" as a placeholder (or omit it); routing is unaffected either way.";
```

Production-source write scope is exactly `src/claude/agents-inject.ts`; test files
are listed in the Tests section below (audit finding 7b + re-audit finding 3 —
000_plan.md's "+ inbound comment" was stale and is corrected): `:155-156` "falls back to sonnet —
live-proven" stays (observed CLIENT fallback, not our guidance);
`src/claude/inbound.ts:145` stays; `tierModels`/`context-windows.ts` stay (REAL tier
env vars, unrelated to the placeholder).

## Tests — MODIFY tests/claude-agents-inject.test.ts

- Assert generated agent definitions / tool descriptions contain `model: \"haiku\"`
  guidance and NOT `model: \"sonnet\"`.
- Existing directive test (claude-agents-inject.test.ts:69 proves the ocx-route
  directive is emitted) must stay green.
- Dispatch-level "routing unaffected" proof lives in tests/claude-messages-endpoint.test.ts
  (audit finding 7c — the injection suite only covers generation): add one case where a
  request carrying placeholder `model: "haiku"` with an ocx-route directive still routes
  to the pinned model. If the endpoint suite's harness makes this disproportionate, the
  live dispatch verification from the Design section doubles as the routing proof and is
  recorded in the WP3 evidence instead.

Pre-fix: the guidance assertion fails on af973e54 (string says sonnet).

## Residual

Claude Code's own UI label for the placeholder arg is upstream behavior; we only
control which placeholder our guidance induces. If the client someday renders the
REAL routed model, this guidance becomes cosmetic — acceptable.
