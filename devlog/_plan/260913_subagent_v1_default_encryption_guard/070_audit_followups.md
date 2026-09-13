# Audit follow-ups

An independent reviewer audited the roadmap against the branch tip before any code moved.
Verdict: near-pass. No factual claim in D1 through D5 failed; three cautions are resolved
here.

## 1. The advisory fires for most existing installs, and that is the point

The reviewer noted that a config written before this change usually has no `multiAgentMode`
key at all, so the advisory raises for the majority of upgrading users rather than a rare
corner. That is intended. Those are precisely the operators running base, which pins Sol and
Terra to v2, and who have never been told what that costs them when they delegate to a
routed model. It fires once per install and both answers end it.

## 2. New test files would trip the layout guard

Folded into 020: the new assertions extend `tests/server/config.test.ts` and the existing
management-API describe block in `tests/codex-integration/codex-v2-gate.test.ts` rather than
creating files that would need registering in two manifests.

## 3. The guide needs a sidebar entry

Folded into 040.

## Carried into the build

`src/config/multi-agent-surface.ts` lands in an existing documented directory, so
`structure:check` has nothing new to claim. `structure/gui-and-management-api.md` documents
the `/api/v2` contract and must be updated in the same change, as must the mode table in
`structure/subagents.md`, which still calls base the install default.

GUI locale parity is enforced by `Record<TKey, string>` at GUI build time, so a missing key
in any of the nine catalogs fails `bun run build:gui` rather than slipping through.
