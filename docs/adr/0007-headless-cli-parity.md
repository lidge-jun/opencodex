# ADR 0007: Headless CLI parity through the management control plane

## Status

Accepted

## Context

The dashboard exposes provider editing and tests, live model visibility, combo routing,
subagent policy, request/usage observability, API admission keys, Claude Code settings,
Grok selection, and startup settings. Historically the CLI covered lifecycle operations
and a smaller provider/account/model subset. Headless servers therefore required either
the dashboard or direct `config.json` edits, and direct edits bypassed live validation,
catalog refreshes, and runtime side effects.

## Decision

[Decision Log]
- 목적과 의도: Make every non-visual dashboard management capability usable from a discoverable headless CLI.
- 기존 구현 및 제약 조건: The dashboard already used validated `/api/*` management routes; CLI commands mixed direct config writes and one-off HTTP clients. Runtime ports can move, and management auth must follow the same identity and token rules as the dashboard.
- 검토한 주요 대안: Duplicate all route validation in CLI modules; expose a generic raw HTTP command; use a shared management client and resource-oriented commands.
- 선택한 방식: Add a shared identity-checked runtime API client and resource-oriented commands (`provider`, `account`, `models`, `combo`, `agent`, `observe`, `access`, `grok`, `system`, `config`). Existing commands and aliases remain compatible.
- 다른 대안 대신 이 방식을 선택한 이유: Reusing management routes keeps GUI and CLI validation, persistence, cache refresh, and live side effects aligned. Resource commands remain easier to discover than arbitrary endpoint invocation.
- 장점, 단점 및 영향: Headless parity improves and future operations share consistent errors. Live management commands require a running proxy; offline config inspection/import remains available through a separately validated `ocx config` path.

## Command structure

```text
ocx setup                  interactive first-run flow (`init` remains an alias)
ocx provider ...           provider config, test, quota, selected models
ocx account ...            Codex/OAuth/key-pool login and lifecycle
ocx models ...             live/custom models, visibility, context, shadow calls
ocx route combo ...        failover and round-robin virtual models
ocx agent ...              subagents, fallback, injection, effort, sidecars
ocx observe ...            logs, usage, storage, memory, debug captures
ocx access ...             external API keys, endpoints, model tests
ocx integration ...        Claude and Grok client integrations
ocx system ...             settings, startup, diagnostics, sync, update jobs
ocx config ...             masked inspection and validated offline import/edit
```

Convenience aliases (`model`, `combo`, `logs`, `usage`, `storage`, `memory`,
`api-key`, `grok`) do not define separate behavior. Destructive operations require
`--yes`. List/status is the default action where it is unambiguous. Structured output
uses `--json`; streaming request logs use `--jsonl`.

## Boundaries

- Theme, language, navigation, and other purely visual dashboard state are not CLI features.
- Cloudflare Tunnel is intentionally outside this ADR and this implementation.
- Secrets are masked in config/account/provider reads. API admission-key creation is the
  deliberate exception: the newly generated key is returned once so it can be stored.
- Live mutations go through the running management API. `ocx config import/set` validates
  the complete candidate before an atomic write and never hot-reloads a stopped process.

## Consequences

- New dashboard management operations should receive a CLI mapping or an explicit
  visual-only exemption in the same change.
- Management route validation remains authoritative; CLI parsers provide early UX errors
  but must not become a second domain schema.
- Existing automation keeps working because old command names and semantics are preserved.
