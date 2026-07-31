# 145 — Common Security Hardening (outside Kiro parity)

Goal: harden OpenCodex's shared security surfaces on `feat/kiro-on-dev` while
Kiro adapter parity continues separately in `143_kiro-gateway-parity`.

This plan intentionally excludes Kiro-specific parity work such as CodeWhisperer
retry semantics, payload trimming, tool-schema compatibility, model resolution,
and eventstream adapter behavior. Those stay in plan 143. This plan covers the
common proxy surfaces that can leak secrets, expose local control APIs, or
persist more diagnostic data than needed.

## Context read

- `README.md`: product shape, localhost dashboard, provider config, account pool.
- `structure/01_runtime.md`: `src/server.ts` owns `/v1/responses`, `/v1/models`,
  static GUI, and `/api/*`; adapter events stay internal until bridge conversion.
- `structure/05_gui-and-management-api.md`: management API, logs, usage summary,
  `usage.jsonl`, and `usage-debug.jsonl` invariants.
- `structure/06_docs-and-release.md`: runtime quality gate commands and CI scope.
- `devlog/_plan/143_kiro-gateway-parity/*`: Kiro-specific PABCD stream, to avoid
  overlapping user-owned parity work.
- GPT Pro Q2 security review summary: confirmed common risks are secret logging,
  local API exposure, usage/debug privacy, credential import safety, and config
  input validation.

## Threat model

| Asset | Boundary | Attacker | Failure impact |
| --- | --- | --- | --- |
| Provider API keys and OAuth access/refresh tokens | Browser / local app -> proxy -> config/logs | Malicious local webpage, LAN host, compromised shell, bug report leak | Provider account and quota compromise |
| Local management API and WebSocket routes | Browser Origin / host binding / API key boundary | Malicious webpage, DNS rebinding, LAN host when non-loopback bound | Config mutation, request driving, log/usage disclosure |
| Usage and debug artifacts | Runtime -> `~/.opencodex/*.jsonl` -> GUI/API | Local user, synced backup, support bundle | Prompt, account, project, or secret metadata disclosure |
| Provider config URLs and headers | User config -> outbound fetch | Malicious config or UI input | SSRF, private network probing, credential exfiltration |

## Work-phase map

Each work-phase is one full PABCD cycle with its own focused tests and atomic
commit. Phase 0 is this documentation-only cycle.

| Phase | Priority | Surface | Outcome |
| --- | --- | --- | --- |
| 00 | P0 | Plan and threat model | Scope frozen; phase stubs created; Kiro parity excluded |
| 10 | P0 | Secret redaction foundation | Shared redactor for logs/diagnostics; tests prove token/header/body masking |
| 20 | P0 | Crash/request/usage debug sinks | Existing diagnostic writers use the redactor; no bearer/refresh/profile leaks |
| 30 | P0 | Local HTTP/WS boundary | Origin/CORS/API-key behavior verified and patched where missing |
| 40 | P1 | Usage privacy minimization | Usage/debug records store numeric/coarse metadata only; tests lock shape |
| 50 | P1 | Credential import safeguards | Imported credentials have explicit source/safety metadata and no silent leak paths |
| 60 | P1 | Config URL/header input validation | Provider URL/header validation blocks dangerous local/private/protocol input where applicable |
| 90 | P0 | Final security review | Independent review + full relevant test/typecheck evidence |

## Phase dependencies

Phase 10 must land before phases 20 and 50 so every sink can reuse one redaction
policy. Phase 30 can run in parallel conceptually, but will be done as its own
PABCD pass to avoid mixing server-boundary changes with logging changes. Phase
60 waits until the existing server/config tests are understood so validation does
not break legitimate local provider use cases such as Ollama.

## Verification baseline

- Targeted tests per phase under the existing `bun test tests/...` harness.
- `bun x tsc --noEmit` after code phases.
- For secret-handling changes, add negative tests containing realistic marker
  strings such as bearer tokens, refresh tokens, cookies, profile ARNs, and API
  keys, then assert the exact values never appear in stored/output records.
- For server-boundary changes, use the existing `tests/server-auth.test.ts` and
  focused additions instead of new harnesses.

## Commit discipline

- Commit Phase 0 docs separately.
- Commit each implementation phase separately.
- Do not push unless the user explicitly asks in the same turn.
- Leave unrelated `.opencode/` untracked state untouched.

## Completion criteria

The goal is complete when phases 00/10/20/30/40/50/60/90 have each passed PABCD
with devlog evidence, atomic commits, targeted tests, typecheck for code phases,
and final independent review confirming common OpenCodex security surfaces are
hardened without taking over Kiro adapter parity work.
