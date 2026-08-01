# 070 — Gate the legacy max_threads warning to native v2

## Cause

`GET /api/v2` reports the native `multi_agent_v2` state and the presence of
`[agents] max_threads` independently. The Models page rendered the warning from
the latter value alone, so a valid v1 configuration showed a false boot-conflict
warning.

## Change

Render the warning only when both values are true: native `multi_agent_v2` is
enabled and `[agents] max_threads` is present. This matches Codex's actual
startup validation and the management API's PUT warning condition.

## Verification

- GUI TypeScript production build passes.
- Existing v2 parser and gate tests remain green.
