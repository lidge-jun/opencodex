# wt1 — Implementation roadmap (re-verify at P before building)

Branch `codex/wt1-update-path` off `dev`. One PABCD cycle per bug (A then B; C optional).

## Bug A — PR #871: preview → stable update (build first)

File map:

- MODIFY `src/update/notify.ts` — `isNewer()`: when channel is `latest` and the installed version is a preview (`x.y.z-preview.*`), compare by `major.minor.patch` core; a preview registry target is never accepted as a stable update target (strict target side stays).
- MODIFY `src/update/badge.ts` — only if the GUI/API update-check result needs the same comparator path (it consumes `isNewer` at :69, so likely no change; verify).
- MODIFY `tests/` update comparator tests near existing `notify`/`badge` coverage.

Acceptance + activation scenarios:

1. Installed `2.8.2-preview.20260731`, channel `latest`, npm latest `2.9.1` → `isNewer` true, GUI shows update available (was `already_latest`). Activation: unit test driving exactly this pair.
2. Installed `2.9.1`, registry target `2.9.2-preview.*` on `latest` channel → still false (target-strict). Activation: regression test.
3. Preview channel behavior unchanged. Activation: existing suite green.

## Bug B — Issue #879: star-prompt deferral bound (build second)

File map:

- MODIFY `src/cli/star-prompt.ts` — add a deferral record (e.g. `.star-deferred` with ISO timestamp) written when `printAgentDeferral()` fires; skip the deferral when the record is younger than the chosen cooldown (recommend: once per version, or 7 days — pick one and document). Bound the relay text itself: one relay per deferral event, not repeat-forever.
- MODIFY `AGENTS.md` — the user-consent paragraph must match the new bound (remove "repeat unchanged forever", keep "never answer for the user").
- MODIFY `tests/startup-prompt.test.ts`, `tests/agent-driven.test.ts` — regressions below.
- DO NOT TOUCH: `src/server/management/sidebar-routes.ts` `403 agent_consent_required`; the human interactive prompt path; marker semantics used by `src/update/notify.ts:135`.

Acceptance + activation scenarios:

1. Second agent-driven `ocx start` within the cooldown prints nothing. Activation: test with a fresh config dir, env marker set, deferral record present.
2. Hand-typed interactive run (no agent env, TTY mocked) still shows the real prompt regardless of deferral record. Activation: existing prompt test stays green + new case.
3. Deferral text no longer instructs repeat-forever relay. Activation: snapshot/string assertion on `printAgentDeferral` output.
4. `hasStarPromptRun()` semantics for `update/notify.ts` unchanged. Activation: existing notify tests green.

## Bug C — PR #557 (optional, capacity permitting)

Fold the two high-severity blockers (fail-closed npm cache probe before proxy stop; sanitize persisted job command/log/error fields). Draft PR exists — rebase and finish rather than rewrite.

## Verification gate for the worktree session

`bun run typecheck` + focused tests + `bun run test` before proposing merge. Commit per bug; no push without user approval.
