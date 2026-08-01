# 040 — Phase 4: hardening + release

Work class: **C3-C4** (release surface + protocol-fidelity risks -> the release
slice itself is C4 care). One PABCD cycle; split PRs per blast-radius rule.

## Objective

Close the fidelity gaps deferred from Phase 1-3, label the new surface in
observability, deprecate ccs-wrapper, and ship a release with docs/changelog.

## Workstreams

### 1. Thinking round-trip policy (from 010 risk + 000 open q1)

- Today (post-Phase 1): thinking streamed to Claude Code without signature;
  replayed thinking blocks dropped inbound.
- Harden: when the ROUTED provider is anthropic-family, reuse the existing
  ocxr1 reasoning-envelope machinery (src/responses/reasoning-envelope.ts,
  bridge signature capture) so signed thinking survives Claude Code replay the
  same way it survives Codex replay. Decision gate: only if a real failure mode
  is demonstrated (tool-use turn 400s on replay); otherwise document drop policy
  as intended.

### 2. Error-shape parity

- Map upstream/openai error types -> Anthropic error taxonomy
  (invalid_request_error, authentication_error, permission_error,
  not_found_error, rate_limit_error, api_error, overloaded_error); preserve
  retry-after on 429/529. Table-driven, tested per status.
- `requireApiAuth`/origin-reject responses on /v1/messages return Anthropic
  shape (Phase 1 ships OpenAI shape there — cosmetic but fix here).

### 3. Protocol edges

- `anthropic-beta` headers + `?beta=true`: confirm ignore-safe against a real
  Claude Code session capture; log-once when an unknown beta is requested.
- `count_tokens` fidelity: compare estimate vs provider-reported input_tokens on
  live turns; adjust charsPerToken choice if drift >2x (token-estimate lib).
- Cancellation: client disconnect propagates through the SSE transform to abort
  the internal request (verify with a mid-stream kill; no leaked upstream —
  mirrors RC2 discipline in server code).
- Stall behavior: bridge heartbeat -> ping keeps Claude Code's idle timer alive;
  verify with an artificial 60s stall fixture.
- Non-stream native passthrough edge (claude inbound -> native gpt model,
  stream:false): decide support or explicit 400 with guidance.

### 4. Observability + docs truth

- Request log rows for /v1/messages tagged (e.g. surface="claude") so
  Logs/Usage can filter; GUI Logs gains the filter chip only if trivial —
  else file follow-up.
- docs-site troubleshooting section updated with real error texts from 2.

### 5. Deprecation + release (C4 care)

- ../010_2025/ccs-wrapper: README banner "superseded by opencodex `ocx claude`"
  + pointer; no code changes there.
- Release: version bump, CHANGELOG/release notes (repo release convention:
  `release: vX.Y.Z` commits), README rows already shipped in 030; npm publish
  per scripts/ release flow; smoke `npm i -g` path on a clean shell.

## Out of scope

- New features (slots beyond default/small-fast, think/longContext routing a la
  CCR) — file as a future unit if requested.

## Test plan (C gate)

- Error-mapping table test (every taxonomy row + retry-after passthrough).
- Cancellation test (abort mid-stream, assert upstream abort + log finalize).
- Stall/ping fixture test; beta-header ignore test.
- Full suite + typecheck + gui/docs builds; release dry-run (`npm pack`,
  bin smoke) before publish.

## Gate criteria

1. All workstream decisions recorded (esp. 1 and 3's native non-stream edge)
   with evidence, not assumptions.
2. Fresh full-gate run green; release artifacts verified; ccs-wrapper banner
   committed in its own repo.
3. Post-release smoke: `npm i -g @bitkyc08/opencodex && ocx claude` on a clean
   machine/profile completes a routed turn.

## Risks

- Signature replay (1) can balloon — timebox: demonstrate-or-document, do not
  speculatively build.
- Release + protocol edges in one cycle is wide; if 1-3 produce big diffs,
  split release into its own mini-cycle (blast-radius rule).
