# 260711 — Claude Code inbound (/v1/messages): research + plan (docs-only unit)

## Preflight note

- `cxc` CLI not on PATH in this session and no SessionStart binding line exists in
  context, so the PABCD FSM could not be armed (SESSION-IDENTITY-01). This unit runs
  the HITL P->A->B->C->D discipline manually; this doc is the P artifact.
- User directive for this unit: **research + devlog only, no src changes.** A
  first implementation pass (src/anthropic/inbound.ts) was started in-session and
  rolled back on request; its design findings are preserved here.

## Objective

Decide how opencodex should serve Claude Code (and other Anthropic-SDK clients) the
way it already serves Codex — "use any LLM with Claude Code" — reusing the existing
provider stack (OAuth store, account pool, adapters, key failover, vision/web-search
sidecars) so login state carries over with zero extra auth work.

Questions this unit answers:

1. How do CCR-class tools attach to Claude Code? (evidence: claude-code-router)
2. Should the dashboard be a separate app/port or integrated into the existing GUI?
3. What is the right internal architecture for an Anthropic Messages inbound?
4. What happened to the user's earlier Claude-side proxy (ccs-wrapper) and what is
   reusable from it?

## Findings (summary — evidence in 001_research_claude_attach.md)

- **Attach mechanism is pure env redirect.** Claude Code keeps speaking the Anthropic
  Messages API; `ANTHROPIC_BASE_URL` only repoints the host. A router implements
  `POST /v1/messages` (+ streaming SSE back in Anthropic shape) and does all protocol
  translation server-side. `ANTHROPIC_AUTH_TOKEN` can be a placeholder for a local
  gateway. (CCR project docs.)
- **CCR runs dashboard and gateway on ONE port** (current desktop default
  `localhost:8080`; legacy CLI `:3456` with `ccr ui` on the same port). Precedent
  says: no separate dashboard process.
- **CCR's router slots map Claude Code's model slots**: `default`, `background`
  (haiku/small-fast slot), `think`, `longContext`, `webSearch`. This is the feature
  users actually configure; opencodex needs an equivalent (env injection first,
  optional inbound modelMap later).
- **opencodex already has the right seam**: `handleResponsesCompact`
  (src/server/responses.ts) builds an internal `/v1/responses` Request and calls
  `handleResponses` — an Anthropic inbound can follow the same pattern with two
  translators (Anthropic req -> Responses req; Responses SSE/JSON -> Anthropic
  SSE/JSON) and inherit routing/OAuth/pool/sidecars for free.
- **ccs-wrapper (010_2025) is the predecessor**, not a base: single-file FastAPI
  wrapper over third-party CCS (:8317), stale model aliases, fake streaming on the
  thinking route, currently not running. Its useful ideas (slot aliasing, thinking
  effort mapping) carry over as config, not code.
- **Local reference exists**: devlog/_chase/_cca (CLIProxyAPI, Go) ships a
  Claude Code inbound + executor (internal/runtime/executor/claude_executor.go,
  internal/translator/claude/*) for cross-checking wire details during build.

## Decisions (P-level)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Implement inbound `/v1/messages` INSIDE opencodex, same daemon/port | Reuses provider stack + login state; matches CCR one-port precedent; ccs-wrapper stays deprecated |
| D2 | Dashboard: integrate into existing GUI (new "Claude Code" section later; Logs/Usage work day one) | One daemon, one GUI; separate dashboard adds a process + auth surface for no gain |
| D3 | Internal architecture: translate-and-replay through `handleResponses` (compact-handler pattern) | Avoids duplicating ~400 lines of routing/auth/failover; SSE translation needed either way |
| D4 | Launcher: `ocx claude [args...]` injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, optional `ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL` from `config.claudeCode`, auto-`ensure`s the proxy | Mirrors `ccr code` UX; zero manual env setup |
| D5 | Model mapping v1 = env slot injection + optional `claudeCode.modelMap` (exact id, then date-stripped) | Covers CCR's `default`/`background` slots without new GUI work |
| D6 | Picker visibility via the official gateway model discovery protocol (`GET /v1/models` + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Claude Code >= 2.1.129): expose routed models as claude-/anthropic-prefixed alias ids with honest `display_name`, resolve aliases back on inbound | CCR's typed `/model provider,model` comma-hack is the legacy path; discovery puts custom models IN the native picker (002_research_model_visibility.md) |

## Phased plan (each phase = one PABCD cycle; detailed P docs below)

- **Phase 1** — core inbound `/v1/messages` + count_tokens (C3):
  010_phase1_core_inbound.md
- **Phase 2** — `ocx claude` launcher + gateway model discovery/aliases (C2-C3,
  D6; starts with Tier-2 doc verification -> 003_evidence_discovery.md):
  020_phase2_cli_discovery.md
- **Phase 3** — GUI "Claude Code" section + docs-site/README, 3-4 locales (C2):
  030_phase3_gui_docs.md
- **Phase 4** — hardening (thinking replay, error parity, protocol edges,
  observability tag) + ccs-wrapper deprecation + release (C3-C4):
  040_phase4_hardening.md

## Out of scope (this unit)

- NO src/gui/docs-site changes (docs-only unit; rollback of the started
  src/anthropic/inbound.ts is complete — working tree carries only pre-existing
  user edits).
- NO separate dashboard process, NO new port, NO standalone "openclaude" repo.

## Open questions (carry into Phase 1 P)

1. Thinking blocks: emit Anthropic `thinking` SSE without signature (CCR-style) and
   drop them on replay, or hide thinking entirely by default?
2. Auth default for loopback: accept any `x-api-key` on 127.0.0.1 (current
   opencodex behavior: no auth required on loopback) — confirm acceptable.
3. `count_tokens`: char-estimate (src/lib/token-estimate.ts) is approximate; is that
   good enough for Claude Code's context meter? (CCR precedent suggests yes.)
4. Whether `/v1/messages?beta=true` query + `anthropic-beta` headers need any
   special handling beyond ignoring them.
5. D6 details to Tier-2-verify before build: exact discovery response schema and
   the claude/anthropic id-prefix rule; alias format choice
   (`claude-<provider>-<model>` vs `anthropic-<provider>/<model>`); whether picker
   selection persists to settings.json (002 doc, claims 4-5).
