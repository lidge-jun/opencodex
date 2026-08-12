# 010 — Plan-restriction disclosure, then merge PR #611

Depends on `000_evidence_ledger.md`. One work-phase, one PABCD cycle.

## Objective

Disclose the Volcengine Plan usage restriction on the two Plan presets, then land
PR #611 on `dev`.

## Scope

IN: `src/providers/registry.ts` (two `note` strings),
`tests/volcengine-providers.test.ts` (two assertions), PR #611 GitHub actions.
OUT: base URLs, adapters, model catalogs, GUI, docs-site, any other provider.

## Why the note matters

`note` is display-only: `src/providers/derive.ts:296` copies it into the saved
provider and `src/server/auth-cors.ts:508-510` surfaces it in the config DTO for
the dashboard. It enforces nothing. That is exactly why it is the right surface
here — the risk is a user consequence (subscription suspension, account ban), so
it belongs in front of the user rather than in a router guard. `tencent-coding-plan`
already ships this shape at `src/providers/registry.ts:1061`, and
`tests/tencent-siliconflow-providers.test.ts:23` asserts it, so this change makes
the two Chinese coding-plan providers consistent instead of inventing a pattern.

Not chosen: blocking Plan routes in `src/router.ts`. Volcengine documents Codex
CLI and Claude Code as supported clients, so refusing to route would break the
vendor's own documented use. The defect is a missing warning, not a missing gate.

## Change map

### MODIFY `src/providers/registry.ts` — `volcengine-coding-plan` note (line 1109)

Before:

```ts
    note: "Coding Plan subscription endpoint with plan-scoped model aliases. Use the plan key issued by the Ark console.",
```

After:

```ts
    note: "Coding tools only. Volcengine restricts Plan quota to supported AI coding tools (Codex, Claude Code, and similar) and warns that other API use of this key may suspend the subscription or ban the account. Use the plan key issued by the Ark console.",
```

### MODIFY `src/providers/registry.ts` — `volcengine-agent-plan` note (line 1124)

Before:

```ts
    note: "Agent Plan subscription endpoint over the native Responses API with a static fallback catalog.",
```

After:

```ts
    note: "Coding tools only. Agent Plan is a subscription endpoint over the native Responses API; Volcengine restricts Plan quota to supported AI coding tools and warns that other API use of this key may suspend the subscription or ban the account.",
```

`volcengine` (pay-as-you-go) is unchanged — the restriction does not apply to it,
and its existing note already tells users this route bills separately.

### MODIFY `tests/volcengine-providers.test.ts`

Add one assertion per Plan entry, mirroring
`tests/tencent-siliconflow-providers.test.ts:23`:

```ts
    expect(entry?.note).toContain("Coding tools only");
```

The existing full-object `toEqual` assertions for both Plan entries already carry
`note`, so their expected strings are updated to the new text in the same edit.

## Acceptance criteria

1. `bun run typecheck` exits 0.
2. `bun test tests/volcengine-providers.test.ts tests/tencent-siliconflow-providers.test.ts tests/provider-registry-parity.test.ts` passes.
3. `bun run test` stays at 0 fail.
4. Both Plan notes contain `Coding tools only`; the pay-as-you-go note does not.
5. Activation scenario: the GUI reads `note` through the `/api/config` DTO
   (`auth-cors.ts:508-510`), so a provider row for either Plan entry displays the
   restriction. Proven by asserting the registry value the DTO copies.
6. PR #611 CI green on the pushed head, then merged into `dev`.

## Out of scope / follow-up

The named maintenance owner is still absent from the PR body. It is a description
field the author owns; record it as a residual in the merge comment rather than
blocking a green, evidence-backed preset on a line of prose.
