# Umans provider cleanup note

## Context

During the PR #14/#19 local dev merge stop audit, an unrelated Umans provider WIP appeared in the working tree. The PR #14/#19 commits themselves were already verified, but the dirty tree meant dev was not ready for a later main merge decision.

## Scope

- Add Umans AI Coding Plan as a key-login Anthropic-compatible provider.
- Preserve provider runtime metadata when saving API-key logins.
- Validate Anthropic-compatible API keys with the Messages API shape instead of `/models`.
- Escape builtin tool names on the wire for gateways that require it and strip the prefix before returning tool calls to Codex.
- Document the new provider/config flag in README and docs-site locale pages.

## Verification

- `bun run typecheck`
- `bun test tests/umans-provider.test.ts tests/provider-registry-parity.test.ts`
- `bun test tests`
- `bun run build:gui`
