# 020 — Phase 2: main card renders the plan badge

Work phase: `wp2`. Depends on: `010` (only for the ticket badge to have data;
the plan badge itself is independent).

## Goal

The main account card shows its plan as a badge, exactly as pool cards do.

## Scope boundary

IN: `gui/src/components/codex-account-pool-main-card.tsx` badge row.
OUT: card layout, the skeleton block, pool card markup, styling changes.

## File change map

### `gui/src/components/codex-account-pool-main-card.tsx` (~line 87)

Inside `<span className="card-badges">`, as the FIRST child — matching the pool
card's order at `codex-account-pool-cards.tsx:91` so both cards read
plan → paused → priority → pinned → ticket → health:

```tsx
{main?.plan && <span className="badge badge-green">{main.plan}</span>}
```

The existing ticket badge line moves after the pinned badge so the two cards
share one badge order. Nothing else in the row changes.

### Skeleton parity (`~line 279`) — decision recorded

The load skeleton reserves a ticket slot and a `badge-primary` slot. The
question was whether the new plan badge needs a matching muted strut.

**Decision: no strut.** The skeleton already omits the priority and pinned
badges that the ready state can render, so approximate width parity is the
established norm for this card rather than a regression introduced here. Adding
a strut for the plan badge alone would make the skeleton wider than the common
ready state (an account with no plan renders no badge at all), trading one
small shift for a different one. Recorded per the audit's blocker 2, which
asked for the strut or a stated reason.

## Accept criteria

1. With `main.plan === "pro"`, the rendered main card contains
   `<span class="badge badge-green">pro</span>`.
2. With `main.plan` undefined, no plan badge element is rendered (no empty span).
3. Badge order in the main card matches the pool card.

## Verifier

Rendered-DOM observation on the running dashboard (C-RENDER-GROUNDING-01) plus
`bun run lint:gui` and `bun run typecheck`. There is no existing GUI unit-test
harness for this component, so the DOM observation is the acceptance evidence and
that is recorded rather than claimed as a gate.

## Bypass record

No enforcement added. Final enforcement layer: none; the visual check is human/DOM
observation.
