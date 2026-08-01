# 015 — WP1b: one-time authMode migration (audit R2-3)

Depends on WP1's type widening. Small, but it is the difference between "auto helps
new users" and "auto silently changed an existing user's deliberate choice".

## The problem, exactly

Before this unit, choosing Subscription in the GUI **deleted** the key
(`agent-settings-routes.ts:693-703`). So on disk today:

| Pre-upgrade state | What the user meant | Naive auto reading |
|---|---|---|
| `claudeCode.authMode === "proxy"` | proxy | proxy ✅ |
| `claudeCode` exists, no `authMode` | **explicitly chose Subscription** (or accepted the default) | auto → could flip to proxy ❌ |
| no `claudeCode` key at all | never touched Claude settings | auto ✅ |

Row 2 is the damage: an existing subscriber whose credentials are momentarily absent
(or undetectable) would be flipped into proxy mode by an upgrade they did not ask for.

## The migration

A one-time, version-sentinel pass at server start, next to the existing startup
migrations (`src/server/index.ts:239-270` runs the Alibaba/OpenAI-tier ones):

```ts
/**
 * authMode migration (devlog 260726_claude_auth_auto/015): before auto existed,
 * "Subscription" was stored by DELETING the key, so a pre-upgrade config cannot
 * distinguish an explicit subscription choice from "never chose". Preserve the old
 * EFFECTIVE behaviour for configs that already had a claudeCode block; only genuinely
 * untouched configs get auto.
 */
export function runClaudeAuthModeMigration(config: OcxConfig): boolean {
  const cc = config.claudeCode;
  if (!cc) return false;                        // fresh/untouched -> auto, nothing to do
  if (cc.authModeMigratedAt) return false;      // already migrated, never re-run
  if (cc.authMode === undefined) cc.authMode = "subscription";
  cc.authModeMigratedAt = new Date().toISOString();
  return true;
}
```

`OcxClaudeCodeConfig.authModeMigratedAt?: string` is the sentinel; its ABSENCE is what
identifies a pre-upgrade config, so the migration is idempotent and cannot re-fire
after the user later chooses auto.

Callers: `startServer` (same block as the other startup migrations), saving only when
the function returns true.

## Consequence for the GUI

An upgraded user opens the Claude tab and sees **Subscription** selected — the truth
about what they had — and can choose Auto deliberately. A fresh install sees
**Auto**. Nobody is silently converted in either direction.

## TESTS — `tests/claude-authmode-migration.test.ts` (NEW)

- pre-state `claudeCode` present without `authMode` → becomes `"subscription"` with a
  sentinel; effective behaviour identical to pre-upgrade;
- pre-state `claudeCode.authMode === "proxy"` → unchanged, sentinel written;
- pre-state no `claudeCode` key → untouched, no sentinel, resolves auto;
- idempotence: running twice changes nothing the second time;
- a user who later PUTs `"auto"` (key deleted) is NOT re-migrated on the next start —
  the sentinel survives on the `claudeCode` block.

Edge to pin in the test: PUT `"auto"` deletes `authMode` but must KEEP
`authModeMigratedAt`, or the next start would resurrect subscription and undo the
user's choice. That is the single sharpest failure mode of this phase.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-authmode-migration.test.ts` | pass |
| `bun test tests/claude-auth-mode.test.ts` | still pass (resolver unaffected) |
