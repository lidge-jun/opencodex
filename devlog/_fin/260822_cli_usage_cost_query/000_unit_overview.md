# 260822 — CLI usage cost query

## Why this unit exists

A user asked, in order: "how much Grok did we use on ocx today?" and then
"what did it cost?". Neither question could be answered with `ocx usage`.

Answering the first one required piping `ocx usage --range 7d --json` into a
separate script that filtered `days[]` by date and `models[]` by provider.
Answering the second one was not possible from the day breakdown at all,
because the day breakdown carries no cost field. The proxy knows every number
involved — it prices each request at read time — and the CLI throws all of it
away before it reaches the terminal.

That is the defect. Not a missing feature: a reporting surface that computes
the answer and then declines to print it.

## The four concrete gaps

1. **The default CLI view drops the cost breakdown.**
   `usage()` in `src/cli/observe.ts` hands the `/api/usage` payload to
   `summaryLines()` (`src/cli/runtime-api.ts`), a generic key/value flattener
   that stops at `depth > 1` and renders any array as `"models: 45 item(s)"`.
   `models[].estimatedCostUsd`, `providers[].estimatedCostUsd` and
   `accounts[].estimatedCostUsd` are all computed server-side and all
   invisible. `--json` is the only way to see them, which makes the human
   view strictly less useful than piping to `python3`.

2. **There is no "today".** `UsageRange` is `7d | 30d | all`. The most
   common question a cost surface gets asked — what am I spending right now —
   has no direct answer.

3. **Day rows carry no cost.** `UsageDay` and `UsageDayModel` have
   `requests`, `totalTokens` and nothing else. So even in `--json`, per-day
   cost does not exist. A caller who wants it must re-derive prices the proxy
   already computed.

4. **There is no way to ask about one provider.** Narrowing to xAI means
   fetching the whole window and filtering client-side. `--surface` looks
   like it might help and does not: it selects the *client* (codex / claude /
   grok), not the upstream provider. That near-miss actively misleads —
   `--surface grok` returns Grok-client traffic, which for this user was 10
   requests, while their actual xAI spend that window was 1,447.

## Scope

IN: `src/usage/summary.ts`, `src/cli/observe.ts`, `src/cli/help.ts`,
`src/server/management/logs-usage-routes.ts`, `src/server/management/usage-summary-cache.ts`,
tests, docs-site.

OUT: GUI dashboard rework, price-table rates in `src/usage/cost.ts`, provider
quota APIs, new dependencies, `go/`.

## Roadmap

| Doc | Work-phase | Deliverable |
|-----|-----------|-------------|
| `001` | — | Current-state inventory (read-only research) |
| `010` | wp2 | Data layer: `today` range + day-level cost fields |
| `020` | wp3 | API layer: range/provider/model parsing, cache-key correctness |
| `030` | wp4 | CLI layer: cost-bearing renderer, flags, help |
| `040` | wp5 | Verification, docs sync, PR against `dev` |

Dependency order, not effort order: `030` cannot render a number `010` does
not compute, and `020` cannot filter a window `010` does not define.

## Non-negotiables

- `--json` stays backward compatible. Fields may be added; none renamed or removed.
- A zero cost must never be presented as "free". Unpriced and unmetered
  requests are counted and shown separately, because `estimatedCostUsd: 0`
  today can mean "no matching price row" rather than "no spend".
- OAuth-plan providers genuinely have no per-request dollar price. The surface
  must say so instead of printing a confident `$0.00`.
