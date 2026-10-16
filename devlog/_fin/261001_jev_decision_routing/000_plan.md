# 261001 JEV decision routing

Status: open. Loop session `01a0f5d4-89c4-7973-9b32-3cadcb4f0929`, branch `codex/jev-decision-routing` from `origin/dev` `64294638a6`.

A `strategy: "jev"` combo asks a decision service which target and reasoning effort should take the next call. Today that service is always a System One endpoint. This unit turns the transport into a pluggable **decision backend** so the same state and candidate list can be answered either by a System One server or by any model opencodex already routes.

## Sources carried

| Source | Author | What is carried | What is not |
|---|---|---|---|
| #6302 | SeongwoongCho | Commits `d60975ee1b`..`304bd4aaee` (self-hosted `jev-decision` rows, `decisionProvider`, `decisionTimeoutMs`, cleartext loopback opt-in, GUI select, save/PATCH guards) cherry-picked with authorship. CLI partial-update fixes `2740904285` and `af1b035e7a`, adapted. | Level mode, quota signals, quota warmer, configurable wording (`4b5c636db2` and later). They go back to the author as a rebase onto this PR. |
| #6185 | yxr1995-maker | Pure discovery helpers (`decision-discovery.ts`: model hint, `/systemone` endpoint derivation, dedupe) and a read-only discovery endpoint; regression cases proving environment TypeSafe keys never reach another destination. | `Decisions.tsx` page and sidebar tab, automatic destination scan, global `JEV_MODEL` override, `jev-opencode` preset (MAINTAINERS.md: a new preset is a credential-destination change needing primary-source evidence; OpenCode zen is documented as an ordinary row), adopt endpoint that copies credentials. |
| #6275 | codingbooo | Its custom-endpoint regression, adapted to a non-`jev` row id (a `jev` row stays pinned to TypeSafe by design). | The `isConfiguredJev` retargeting of the `jev` row. |

All three authors get `Co-authored-by` trailers on the squash.

## Decisions

- **D1 config.** Combo fields: `decisionProvider` (existing), `decisionModel` (new, opencodex route string), `decisionTimeoutMs` (existing). The backend is derived, never stored: `decisionModel` set → `model`; `decisionProvider` set and not `jev` → `systemone`; otherwise → `typesafe`. Setting both is a config error. Existing combos need no change.
- **D2 backend seam.** `resolveJevDecision` becomes a dispatcher over two backends that share one runtime envelope (candidate bounds, state check, deadline, abort handling, fail-open): System One (unchanged bytes on the TypeSafe path) and Model (prompt → JSON `{"choice": "<key>"}`). Level/quota modes can later add a question builder on top of the same envelope.
- **D3 model invocation.** The pure backend takes an injected `invoke(model, prompt, signal)`. Server glue in `src/server/responses/jev-model-invoke.ts` runs a fresh internal `/v1/responses` turn through the dispatcher's `handleResponses` with its own send budget, its own turn lease (`tryAdmitTurn`), a detached log context whose spend tracker is settled, the parent's admission, and no parent history/tools/session headers. The response is read through `readBoundedResponseBytes` (64 KiB) and `createSseInspector`.
- **D4 recursion.** A decision model that resolves (canonical `combo/<id>` or alias, after synthetic selector stripping) to its own combo or to any `strategy: "jev"` combo is refused by `comboConfigIssues` against the prospective combo map. At runtime an `internalDecisionCall` flag refuses combo reentry defensively and fails open.
- **D5 stats.** `PersistedJevDecisionV1` gains optional `backend`; old rows keep parsing and land in an `unknown` bucket. Aggregates add per-backend count and average latency.
- **D6 surfaces.** CLI `ocx combo set --decision-model <route|->`; management PUT/POST combos accept `decisionModel`; `POST /api/combos/decision-test` probes an unsaved decision configuration with synthetic candidates; `GET /api/combos/decision-discovery` lists configured System One rows and catalog rows that look like decision models with the derived endpoint.
- **D7 dashboard.** A `Decision method` section in the combo detail panel and add dialog (TypeSafe / System One-compatible server / opencodex model, timeout, Test, recent stats). No separate page.

## Work-phase map

| Doc | Work-phase | Depends on | Closes with |
|---|---|---|---|
| 010_wp1_backend_interface.md | wp1 backend seam, System One backend, stats backend kind, carried tests | — | focused routing/usage tests, typecheck |
| 020_wp2_model_backend_surfaces.md | wp2 model backend, server glue, validation, CLI/API, decision test, discovery | wp1 | focused routing/server/cli tests, typecheck |
| 030_wp3_dashboard_docs.md | wp3 GUI section, i18n, docs-site, structure docs | wp2 | gui tests, lint:i18n, build, structure:check |
| 040_wp4_landing.md | wp4 full validation, PR, CI, source PR closure | wp3 | exact-head CI green, PRs commented |

## Out of scope

Merging to `dev`, releases, promotions, level/quota mode, new credential stores, provider presets.
