# 010 — Layer 1: DeepSeek reasoning ladder (#1057)

## The defect

`src/providers/registry.ts:349-360` advertises `["high","xhigh","max"]` for both
DeepSeek V4 models and maps `low -> high`. Native `low` is therefore unreachable,
and `xhigh` is presented as a native tier while aliasing something else.

## What the vendor actually documents

From `001`, confirmed in both the English and Chinese official tables:

| requested | `deepseek-v4-flash` | `deepseek-v4-pro` |
|---|---|---|
| `low` | `low` | `high` |
| `high` | `high` | `high` |
| `xhigh` | `high` | `max` |
| `max` | `max` | `max` |

**The two models do not share a mapping.** The current code applies one
`DEEPSEEK_THINKING_REASONING_MAP` to both, so no single corrected constant is
right for both models.

## Change map

### `src/providers/registry.ts:349-360` — MODIFY

Replace the one shared map with the advertised ladder plus two per-model maps.

```ts
// BEFORE
const DEEPSEEK_THINKING_EFFORTS = ["high", "xhigh", "max"];
const DEEPSEEK_THINKING_REASONING_MAP: Record<string, string> = {
  low: "high", medium: "high", high: "high", xhigh: "max", max: "max",
};

// AFTER
// DeepSeek's Codex ladder is low/high/max (api-docs.deepseek.com/guides/thinking_mode,
// verified 2026-08-06). `xhigh` is a compatibility alias, not a native tier, and it
// resolves DIFFERENTLY per model: xhigh->max on Pro, xhigh->high on Flash. `medium`
// has no documented row; mapping it to `high` is our own compatibility choice.
// Flash honors low natively. Pro does not (low->high today), so Pro must not
// advertise a tier the vendor silently upgrades.
const DEEPSEEK_FLASH_EFFORTS = ["low", "high", "max"];
const DEEPSEEK_PRO_EFFORTS = ["high", "max"];
const DEEPSEEK_PRO_REASONING_MAP: Record<string, string> = {
  low: "high", medium: "high", high: "high", xhigh: "max", max: "max",
};
const DEEPSEEK_FLASH_REASONING_MAP: Record<string, string> = {
  low: "low", medium: "high", high: "high", xhigh: "high", max: "max",
};
```

### The advertised ladder is per model too, and this is the audit's finding

An earlier draft advertised `["low","high","max"]` for both models. The reviewer
rejected that, correctly: on Pro, DeepSeek resolves `low -> high`. Advertising
`low` there would put a tier in the picker that the vendor silently upgrades — the
user selects "low", pays for "high", and nothing tells them. That is not a smaller
version of the reported defect, it is the same defect pointed at a different value.

So Pro advertises `["high","max"]` — the two levels it actually distinguishes —
and Flash advertises `["low","high","max"]`. The reporter asked for `low/high/max`
everywhere; that is right for Flash and wrong for Pro, and following the vendor
table beats following the request.

`xhigh` disappears from both advertised ladders while staying in both wire maps.
That is the issue's actual ask: aliases stay, they just stop pretending to be
native tiers.

**Re-verify before implementing.** The vendor page carries a footnote that Pro's
mapping updates in early August 2026, which is now. If Pro starts honoring `low`
natively, `DEEPSEEK_PRO_EFFORTS` gains it and the map entry changes with it. The
layer's first action is to re-read the table, not to trust this document.

### The seven consumers — MODIFY each to pick the right map

`DEEPSEEK_THINKING_REASONING_MAP` is consumed by seven provider entries. Each
becomes a per-model selection instead of one shared object:

| provider | line | models |
|---|---|---|
| `opencode-go` | 934-950 | both |
| `orcarouter` | 1088-1093 | `deepseek/deepseek-v4-pro` |
| `deepseek` | 1185-1186 | both |
| `volcengine-coding-plan` | 1460-1478 | both |
| `alibaba-token-plan` | 1519-1524 | pro only |
| `alibaba-token-plan-intl` | 1552-1562 | both |
| `opencode-free` | 1668-1669 | `deepseek-v4-flash-free` → Flash map |

A small helper keeps this from becoming seven hand-written objects:

```ts
const isDeepseekFlash = (modelId: string): boolean =>
  modelId.toLowerCase().includes("flash");
const deepseekEffortsFor = (modelId: string): string[] =>
  isDeepseekFlash(modelId) ? DEEPSEEK_FLASH_EFFORTS : DEEPSEEK_PRO_EFFORTS;
const deepseekReasoningMapFor = (modelId: string): Record<string, string> =>
  isDeepseekFlash(modelId) ? DEEPSEEK_FLASH_REASONING_MAP : DEEPSEEK_PRO_REASONING_MAP;
```

The audit verified this substring test against every ID in the seven entries,
including the prefixed `deepseek/deepseek-v4-pro` and the suffixed
`deepseek-v4-flash-free`, and found it correct today. It is still a substring
test, so the layer adds an assertion enumerating the exact IDs and their expected
classification — a future `deepseek-v5-flashlite-pro` would otherwise misroute
silently.

### `src/config.ts` — MODIFY (saved-config migration)

A constants-only patch fixes fresh installs only. CLI-created built-in providers
persist the full registry seed (`src/cli/provider.ts:168-179`,
`src/providers/derive.ts:135-140`), and a persisted per-model ladder *replaces*
the registry ladder at routing (`src/router.ts:162-170`). An existing user keeps
advertising `xhigh` and mapping `low -> high` forever.

Narrow in-memory normalizer during `loadConfig`, no write from the read path
(matching `src/config.ts:1509-1516`).

**The migration is per model, exactly like the registry.** An earlier draft
normalized every legacy ladder to `["low","high","max"]`, which would have handed
Pro back the `low` tier the registry change just removed — the same defect,
reintroduced through the upgrade path for existing users only. The audit caught it.

- Legacy ladder `["high","xhigh","max"]` on a **Flash** model → `["low","high","max"]`.
- Legacy ladder `["high","xhigh","max"]` on a **Pro** model → `["high","max"]`.
- Legacy map: set `low` to `low` on Flash, leave `low: "high"` on Pro, and set
  `xhigh` to `high` on Flash / `max` on Pro.
- Replace the exact legacy shapes only; leave any non-exact user override untouched.
- Apply only where provider name and transport match the registry entry.

After migration a saved config and a fresh install must produce identical
metadata for the same model. That equality is the migration test.

### Tests

**Update (these lock the defect):**

- `tests/provider-registry-parity.test.ts:110-113` — advertised ladder.
- `tests/volcengine-providers.test.ts:71-78` — advertised ladder + `low` mapping.

Both now expect **different** values per model, not one shared array.

**Do not touch (these lock compatibility aliases, not the defect):**

- `tests/volcengine-providers.test.ts:261-264` — `medium -> high`, `xhigh -> max`.
- `tests/opencode-go-deepseek.test.ts:102-110` — same.
- `tests/umans-provider.test.ts:81-82` — Umans GLM, unrelated literal match.
- `tests/alibaba-intl-token-plan.test.ts:57-64` — Qwen 3.8, unrelated.
- `tests/reasoning-effort.test.ts:723-734` — generic self-heal fixture.

**Add**, in `tests/provider-registry-parity.test.ts` (registry) and
`tests/config.test.ts` (migration):

- Flash maps `xhigh -> high`; Pro maps `xhigh -> max`.
- Flash advertises `["low","high","max"]`; Pro advertises `["high","max"]`.
- An enumerated ID-to-classification table covering all seven entries, so a future
  id like `deepseek-v5-flashlite-pro` cannot misroute through the substring test.
- Migration: a legacy Pro config normalizes to `["high","max"]` and a legacy Flash
  config to `["low","high","max"]`; both then equal a fresh install.
- Migration: a user-customized ladder is left untouched.

## Red-green

The new per-model test fails on the pre-fix tree because both models currently
share one map. Ablating the Flash map alone flips that single assertion.

## Accept criteria

- Flash advertises `["low","high","max"]`; Pro advertises `["high","max"]`. No
  entry advertises `xhigh`.
- Flash and Pro carry different wire maps, matching the vendor table verified
  2026-08-06 (`001`, re-confirmed immediately before implementation).
- A migrated legacy config equals a fresh install for the same model, per model.
- A user-customized ladder is not rewritten.
- `bun run typecheck` clean; the affected test files pass.
