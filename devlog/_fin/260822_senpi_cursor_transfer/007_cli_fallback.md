# 007 — CLI fallback lane

Plato. senpi SHA `a5eed44536f3024c5740dc3dfff4ffe0bb08b717`. PR [#921](https://github.com/code-yeongyu/senpi/pull/921).

## What senpi added

`cursor-cli-oauth` is a **documented fallback**, never a replacement for native `cursor` ([AGENTS.md L1-5](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/AGENTS.md#L1-L5)).

It spawns official `cursor-agent -p --output-format stream-json --stream-partial-output --trust` ([spawn-args.ts L18-34](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/spawn-args.ts#L18-L34)). CLI tools are display-only. `--force` requires `noApprovalAcknowledgedAt` ([guardrails.ts L136-154](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/guardrails.ts#L136-L154)). Kill switch: verbatim `enabled: false` outranks stored accounts. Implicit fallback is refused while force-ack is pending (`index.ts:77-85`). File-store HOMEs, `AGENT_CLI_CREDENTIAL_STORE=file`, 130 KB prompt cap, process-group kill. senpi remains context owner for usage numbers.

## What OpenCodex has

Native protobuf only. OAuth comment: no dependency on a local Cursor IDE/CLI (`src/oauth/cursor.ts:1-4`). Repo `rg` has no `cursor-agent` spawn, `stream-json`, or `cursor-cli-oauth`. Native-exec kill is `nativeLocalExec` default off (`exec-policy.ts:17-45`) — different layer.

## Transfer class

**REJECT for OpenCodex core.** OpenCodex is a Codex/Claude proxy. Spawning Cursor's own agent CLI would fork tool execution out of Codex sandbox/approvals, add a binary dependency, and spend Cursor quota through a second harness. If a fallback is ever wanted, it is a separate opt-in product surface (NEEDS_HUMAN), not an adapter default.

Do not confuse this with native protobuf hardening. Native-first is the senpi recommendation too.

