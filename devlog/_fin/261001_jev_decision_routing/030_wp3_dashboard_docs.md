# 030 wp3: dashboard, i18n, docs

## GUI

- NEW `gui/src/components/combo-workspace-jev-decision.tsx`: `ComboJevDecisionSection` replaces `JevDecisionFields` (moved out of `combo-workspace-controls.tsx`). Radio group: TypeSafe / System One-compatible server / opencodex model. Server: existing provider select (with discovery hints from `/api/combos/decision-discovery`). Model: select over a separate `decisionModels` inventory (enabled routable models; jev combos and the combo itself excluded). Shared timeout input. `Test` button → `POST /api/combos/decision-test` with the draft, shows ok/gate/latency, cancels on selection change. Saved combos show a compact recent summary from `/api/usage?jev=1&comboId=&range=7d` (decisions, applied %, avg latency, per-backend).
- MODIFY `gui/src/combo-workspace-data.ts`: `ComboItem.decisionModel`; `parseComboList`, `draftEquals`, `toPutBody` (explicit null for the inactive selector), `validateComboDraft` (model required for model method, not self/jev), `jevDecisionSummary` shows the model.
- MODIFY `gui/src/jev-decision-service.ts`: `jevDecisionModelOptions(...)`, `jevDecisionMethod(item)`.
- MODIFY detail panel / add modal / ComboWorkspace / Combos page to pass `apiBase`, `decisionModels`, combos.
- MODIFY `gui/src/components/jev-stats-panel.tsx`: per-backend row.
- i18n: new keys in `en.ts` and the other nine locales; generalize "decision service" wording where it now covers models.
- Tests: `gui/tests/jev-decision-fields.test.tsx`, `tests/gui/combo-workspace-jev-decision.test.ts`, `gui/tests/jev-stats-panel.test.tsx`.

## Docs

- `docs-site/src/content/docs/guides/combos.md`: JEV section → "Decision method" with the three backends, model example (`ollama/qwen3:4b`), OpenCode zen as a System One row example, recursion rule, timeout, stats, CLI/API.
- `docs-site/.../reference/configuration/routing.md` field table: `decisionModel`. CLI reference `--decision-model`.
- `structure/providers-and-adapters.md` JEV contract, `structure/runtime.md` combo dispatch, management/usage owners for the new routes and backend aggregation; `bun run structure:check`.
- `skills/ocx` surface regenerate if the capability registry changes.

## Accept

`cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`; root `tests/gui`; `bun run structure:check`; `bun run skill:surface:check`; screenshot of the section captured for the PR.


## Resume plan (2026-10-01, fork session 01a0f655)

State at resume: wp1 and wp2 are committed (`a4dd92baac`, `36c444fb5c`). The wp3 GUI section, data helpers, overview/stats wiring, ten-locale keys, and the combos guide rewrite are present but uncommitted. The maintainer forbids local test suites and typechecks for this lane, so the wp3 accept list moves to hosted CI on the wp4 head; nothing below is run locally.

Remaining wp3 work:

1. `combo-workspace-jev-decision.tsx`: restore the accessibility contract the removed `JevDecisionFields` carried. The System One select gets `aria-describedby` pointing at a `-decision-provider-hint` paragraph (service hint plus base URL) and, when the stored row is unusable, at a `-decision-provider-issue` paragraph. The model input gets its own `-decision-model-hint`. The method hint keeps the TypeSafe default text and the empty-server text.
2. `gui/tests/jev-decision-fields.test.tsx`: move the four existing cases to the method buttons (System One select lists only server rows; switching to TypeSafe is a method click; an unusable deep link lands on the TypeSafe method with no select), and add a model-method case: pick a route, save sends `decisionModel` with `decisionProvider: null`, the combo itself and JEV combos are absent from the route list.
3. `tests/gui/combo-workspace-jev-decision.test.ts`: `decisionModel` parse/PUT round trip, provider/model mutual exclusion in `toPutBody`, `invalidDecisionModel` for empty, self, and JEV routes, `jevDecisionMethod`, and `jevDecisionModelOptions` exclusions.
4. `gui/tests/jev-stats-panel.test.tsx`: a per-backend row renders when the payload carries `backends` and is absent for an older server.
5. Docs: `reference/cli/agents.md` gains `--decision-model <route|->` and `ocx combo test`; `structure/providers-and-adapters.md` JEV section names the backend seam (`jev-dispatch.ts`, `jev-model-backend.ts`, `jev-decision-contract.ts`, `server/responses/jev-model-invoke.ts`), the recursion refusal, the decision-test/discovery routes, and replaces the "no JEV-only editor" sentence with the Decision method section.
6. Commit wp3 in two commits (GUI + tests, docs + structure) on `codex/jev-decision-routing`.

Verification moves to wp4: exact-head hosted CI (GUI tests, lint, i18n, build, structure:check, privacy scan, full suite shards).

### Audit round 1 amendments (VERDICT: FAIL → plan amended)

7. `tests/gui/combo-workspace-jev-decision.test.ts` summary assertions (`jevDecisionSummary` exact objects) gain `model: null`, plus a model-backed summary case.
8. `JEV_BACKEND_LABEL_KEYS` moves out of the TSX component into `gui/src/jev-decision-service.ts` (oxlint `only-export-components` rejects a non-primitive constant export beside a component); the component and `jev-stats-panel.tsx` import it from there.
9. `jevDecisionModelForbidden` strips trailing synthetic selectors before comparing, mirroring `normalizeDecisionModelSelector`: one trailing `--fast` and one trailing `--<effort>` (`none|minimal|low|medium|high|xhigh|max|ultra`), in either order. The server stays authoritative; the GUI check only prevents an obviously refused save. Regression cases cover `combo/self--fast` and a JEV alias with `--high`.
10. `reference/configuration/routing.md`: add the `decisionModel` row (mutually exclusive with `decisionProvider`, recursion refusal), reword the credential sentence so only the TypeSafe method needs the `jev` key, and repoint the link to `/guides/combos/#decision-method`.
11. Scope change, recorded: the section ships without discovery hints and without its own recent summary. Recent statistics, including the new per-backend table, stay in the detail panel's Stats tab (`JevStatsPanel`), and discovery stays an API/CLI surface (`GET /api/combos/decision-discovery`). Neither is required by the maintainer brief; both can follow as a GUI-only change.

### Audit round 2 amendment

9 (revised). Exact selectors win first, as on the server (`fast-row.ts` known-id guard, `effort-row.ts`): when the route equals some combo's `combo/<id>`, alias, or model exactly, only that combo decides (refused if it is the edited combo or a JEV combo) and nothing is stripped. Otherwise strip exactly one trailing synthetic marker, either `--fast` or `--<effort>`, never both (the server refuses composed Fast+effort selectors), and re-check. Regression cases: a non-JEV combo literally named `self--fast` stays allowed while `self` is JEV; `combo/self--fast` and `<jev-alias>--high` are refused; `combo/x--fast--high` is not stripped twice.

### Audit round 3 amendment

9 (final). The GUI check is conservative: it may only refuse what the server certainly refuses. A route is never stripped when it exactly equals any known selector, meaning any combo's `combo/<id>`, alias, or model, or any catalog route the section receives (physical model ids, namespaced ids, and model aliases as listed by `/api/models`). Only an unknown route ending in exactly one synthetic marker is stripped once and re-checked against combos. Regression cases add a catalog model literally named `router--high` that stays allowed while `router` is a JEV alias. Anything the GUI cannot decide is left to the server's save-time `decisionModelRouteError`, whose message the dashboard already surfaces.

### Audit round 4 amendment

9 (final, simplified). The GUI does no suffix stripping at all. It refuses only an exact match: the route equals the edited combo's `combo/<id>`, alias, or model, or the same of any JEV combo. Every suffixed or otherwise uncertain selector is left to the server's save-time `decisionModelRouteError`, which knows whether Fast and effort parsing are active, and the dashboard surfaces that error on save. The GUI can therefore never refuse more than the server. Regression cases: exact self and exact JEV alias are refused in the GUI; `combo/self--fast`, `router--high` (with `router` a JEV alias), and a catalog model named `router--high` all pass the GUI check.
