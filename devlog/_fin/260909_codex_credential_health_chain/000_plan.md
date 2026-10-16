# Codex credential health chain (#4120, #3848, #3777) — plan

## Reader summary

Problem: a Codex pool credential whose OAuth grant was revoked upstream keeps
`lastCodexValidationStatus: "ok"` in `codex-accounts.json` and is presented as healthy for as long
as the install lives. Answer: a revoked/expired refresh grant is the strongest terminal evidence
available, so the guardian now persists that verdict on the account record instead of dropping it
into an in-memory backoff map, and the health projector reads it. What changes: an account with a
dead grant reports "Reauthentication required" on the dashboard, in `ocx status` and in
`ocx doctor`, and keeps reporting it across restarts until a re-login or a successful refresh
disproves it.

## Loop spec

- Loop archetype: satisfy-spec, three work-phases delivered as a bottom-up manual branch chain
  (wp1 -> wp2 -> wp3), so this unit opens with the diff-level roadmap below and each decade doc is
  revalidated at its own P.
- Trigger: maintainer directive to deliver #4120, shepherd #3848 and build #3777 as one chain.
- Goal: each layer is a non-draft, mergeable PR whose exact-head remote CI is green.
- Non-goals: no merging (the dispatching session owns merge order); no rebase of any layer unless
  that session asks for one; no release or promotion; no default-on background warmup; and no
  local product suite, typecheck, build, lint or install — the standing maintainer rule is that
  remote CI on the PR's exact final head is the only gate, and every skipped local check is
  recorded NOT RUN.
- Verifier: `.github/workflows/ci.yml` on `pull_request`; the `test` job selects
  `tests/**` through the changes filter, so the appended regression rows in
  `tests/codex-integration/` and `tests/oauth/` are in the selected set on Linux, macOS and
  Windows.
- Stop condition: all three PRs non-draft with green exact-head CI, or a BLOCKED outcome naming
  the blocker. wp1 must be able to land alone if wp2 stalls.
- Escalation: a required rebase, a merge conflict against `dev`, or any need to run a local suite
  returns to the dispatching session rather than being resolved unilaterally.

## Root cause (#4120, evidence)

`guardianSweep`'s pool branch decides whether to sweep an account at
`src/oauth/token-guardian.ts:210-215`:

    const needsRefresh = cred.expiresAt <= nowMs + horizonMs;
    const needsWarmup = opts.codexWarmupEnabled && (...);
    if (!needsRefresh && !needsWarmup) continue;

and decides what to persist on failure at `src/oauth/token-guardian.ts:238-241`:

    const permanent = err instanceof TokenRefreshError && (err.reason === "revoked" || err.reason === "expired");
    if (needsWarmup && !(err instanceof TokenRefreshError)) {
      markCodexAccountValidationFailed(id, codexWarmupFailureReason(err));
    }

`permanent` is computed and then used only to widen the in-memory backoff delay
(`recordFailure`, `:100-115`), which does not survive a restart and is not what any health
surface reads. The persisted-verdict branch requires `needsWarmup`, which is false in the default
configuration because `codexWarmupEnabled` defaults to `false` (`:86`), and it additionally
excludes every `TokenRefreshError`. So the one class of failure that proves the credential is dead
is the one class that never reaches the account record.

The second half of the defect is on the read side: `src/oauth/health.ts` never consults the
validation metadata at all. `projectCodexAccountHealth` (`:196-210`) reads only the in-memory
reauth flag and the cooldown snapshot, so a record carrying a stale login-time `"ok"` projects
`{ status: "healthy" }`.

## Work-phase roadmap

| Phase | Doc | Layer | Base |
|---|---|---|---|
| wp1 | `010_wp1_terminal_verdict.md` | persist + project the terminal verdict (#4120) | `origin/dev` |
| wp2 | `020_wp2_quota_registration.md` | shepherd #3848 onto the chain | wp1 head |
| wp3 | `030_wp3_anthropic_plan.md` | Anthropic subscription tier (#3777) | wp2 head |

The order is a dependency order, not an effort order: wp3 edits `src/cli/account-api.ts`, which
wp2 already rewrites, and wp2 touches the same account-store and guardian surfaces wp1 changes.
Each layer stands alone for review and carries its own tests.
