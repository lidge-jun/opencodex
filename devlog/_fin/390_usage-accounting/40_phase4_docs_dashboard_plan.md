# Phase 4 — Dashboard Card and Structure Docs

Phases 1-3 (commits `d1297d7`, `095a02f`, `94a29bf`, `b95e41c`) shipped the usage log, `/api/usage`, the Logs Tokens column, and the Usage tab. This phase documents the new local state and surfaces a small summary on the main Dashboard so users notice the new tab.

## Surface

### MODIFY `gui/src/pages/Dashboard.tsx`

- Fetch `/api/usage?range=30d` alongside the existing parallel `Promise.all`.
- Show one new `stat` card in the existing `.stat-row` after `providers`:
  - Label: `t("dash.tokens30d")`
  - Value: `formatTokens(summary.totalTokens)` if `summary.requests > 0`, else muted dash `—`.
  - Sub-line: `XX% coverage` muted, or hidden when there are zero requests.
- Keep the rest of the dashboard untouched. The summary is purely informational — clicking it does not navigate.
- Failure path: if `/api/usage` errors, show `—` and skip the sub-line. Never block the rest of the dashboard.

### MODIFY `gui/src/i18n/{en,ko,zh}.ts`

Add:

- `dash.tokens30d` → `"Tokens (30d)"` / `"토큰 (30일)"` / `"Token (30 天)"`
- `dash.coverage` → `"{pct} coverage"` / `"커버리지 {pct}"` / `"覆盖率 {pct}"`

### MODIFY `structure/00_overview.md`

Add to the `Local state` table:

```
| `~/.opencodex/usage.jsonl` | opencodex | Append-only request usage log (0o600); only metadata, never prompts or tokens. |
```

### MODIFY `structure/05_gui-and-management-api.md`

Append to the API ownership table:

```
| Usage | `GET /api/usage` aggregate read-only summary derived from the usage log; never exposes prompts. |
```

Optionally add a short note in the same file:

```
## Usage accounting

`src/usage-log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` (0o600). `src/usage-summary.ts`
turns that file into the `/api/usage` shape — totals, daily zero-filled grid, model and provider
breakdowns, and reported / unreported / unsupported counts. Missing usage is never treated as zero.
```

## Out Of Scope

- Log rotation / pruning.
- CSV/JSON export.
- Background incremental aggregation.

## Risks

- Dashboard `/api/usage` fetch adds one more network round-trip on every dashboard render. Mitigation: still parallel with existing fetches, no waterfall.
- Translation drift: keep the keys to a minimum (one label + one templated suffix) so they do not become i18n debt.

## Verification

- `cd gui && bun run build` — catches tsc + vite.
- `bun x tsc --noEmit` — root types unaffected; sanity check.
- `bun test tests/usage-summary.test.ts tests/usage-log.test.ts tests/request-log.test.ts` — no regression.
- Atomic commit: `feat(gui): show 30d token totals on Dashboard + docs(structure): document usage accounting`.
  - Split if the patch is large — one commit for GUI, one for structure docs.
