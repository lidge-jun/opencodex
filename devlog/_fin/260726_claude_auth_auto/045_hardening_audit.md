# 045 — WP4 audit (A-phase gate)

Audit of the WP4 plan in `040_hardening.md` against the real source before B.
Verdict at the bottom.

## A1 — the plan's writer list was incomplete (BLOCKER, fixed in B)

`040` enumerated management routes, `providers/key-failover.ts`, `providers/api-keys.ts`
and `cli/claude-desktop.ts`. A full sweep of `rg -n "saveConfig\b" src` found two more
modules that hold a LIVE server config and save the whole object:

| Path | What it does | Why it matters |
|---|---|---|
| `src/codex/routing.ts:487` (`setActiveCodexAccount`) | Codex account auto-switch on quota threshold | Reached mid-turn from the request path. Eight call sites (`:512, :526, :546, :663, :678, :684, :796`). No user action involved. |
| `src/codex/auth-api.ts:220` (`saveRuntimeConfig`) | Runtime account/quota persistence | Takes the live config via `getRuntimeConfig`, then mutates the caller's instance in place. |

This is the SAME failure class the plan built the guard for: a save that never touches
`claudeCode` rewrites it anyway, because `saveConfig` serializes the whole object. Had
only the plan's list been converted, an ordinary account rotation would still have eaten
a hand edit. Both are converted and added to the enforcement test's guarded set.

## A2 — the remaining bare `saveConfig` callers are NOT in scope (verified, no change)

Every other caller was checked individually. They are safe for one of two reasons:

- **Fresh-load callers.** `oauth/index.ts:601`, `oauth/login-cli.ts:125`,
  `cli/provider.ts:69`, `cli/models.ts:165,205`, `cli/init.ts:166`, `cli/v2.ts:124`,
  `cli/index.ts:133` each call `loadConfig()` immediately before saving, so the object
  they serialize already CONTAINS the user's hand edit. Routing them through the wrapper
  would add a redundant disk read, not protection.
- **Startup migrations.** `server/index.ts:252,258,274`,
  `providers/openai-tier-startup.ts:14`, `providers/alibaba-region-startup.ts:25`, and
  `oauth/index.ts:565` (`reconcileOAuthProviders`, called only from `startServer:247`)
  run before the server serves a request, against a config nobody else holds. This is
  the documented exception in `040`.

Consequence for arming order: the baseline must be armed AFTER those migrations, not
before. Arming first would record a pre-migration `claudeCode`, making the migration's
own write look like "our change" and letting it win a conflict against a real hand edit.
`startServer` arms at `:277`, after all three. The enforcement test pins this by
asserting every bare save inside `startServer` precedes the arming call.

## A3 — `deepEqual` must not be `JSON.stringify` (accepted as planned)

Confirmed necessary, and one case the plan did not spell out: a JSON round-trip turns an
explicit `undefined` value into an absent key. A compare that treats those as different
would report a spurious external edit on every save. The implementation skips keys where
both sides are `undefined`.

## A4 — unarmed configs must stay pass-through (added)

Short-lived CLI loads never call `armClaudeCodeBaseline`. The wrapper must behave exactly
like the old `saveConfig` for them, or a CLI write would start silently reading disk state
back over the caller's intent. Guarded by `has(config)` on both the reconcile and the
rebase, and asserted.

## A5 — residuals carried forward unchanged

- Non-`claudeCode` subtrees stay unprotected; a `providers` hand edit is still lost. This
  is asserted in a test so it cannot drift into an assumed guarantee.
- The read-then-write TOCTOU window remains.
- Conflict policy is last-writer-wins in our favour, not a three-way merge.

## Verdict

**PASS with one blocker folded in.** The design in `040` is sound; its writer INVENTORY
was wrong, which the sweep in A1 corrected. Proceed to B with the widened boundary.
