# 260809 — vision sidecar model eligibility filter

Base: `origin/dev@632743269`, worktree `/Users/jun/.codex/worktrees/34b7/opencodex`.
Cycle: docs-first. This unit writes the roadmap; no production code lands in this
work-phase.

## Objective

The dashboard's Vision sidecar model picker currently offers **every** model whose
provider is `openai` or `anthropic`, with no regard for whether that model can
actually accept an image. Users have been asking for more models, and the honest
answer has two halves:

1. The picker is simultaneously **too wide** (it lists models that cannot see) and
   **too narrow** (it hard-codes two provider names instead of asking about
   capability).
2. The sidecar has exactly two executors — the OpenAI Responses forward path
   (`src/vision/describe.ts`) and the Anthropic Messages path
   (`src/vision/anthropic-describe.ts`). A model that is not reachable by one of
   those two wire protocols cannot be a vision sidecar today no matter what the
   picker shows.

So the deliverable is a real **vision-capability filter** on both sides, plus a
guaranteed baseline entry per side, plus a dashboard card that shows the allowed
list in the compact delegation-panel form factor.

## Constraints

- The proxy is Bun-native TypeScript; `bun run typecheck` and `bun run test` gate
  every layer.
- `src/vision/reasoning.ts` already owns effort normalization. The filter must not
  duplicate or contradict `normalizeVisionReasoningForModel`.
- The GUI must not be the only gate: `PUT /api/sidecar-settings` has to reject an
  ineligible vision model itself (`PLAN-BYPASS-NAMED-01` below).
- No change to routing, provider registry semantics, or the web-search sidecar's
  behavior. Shared plumbing may be extracted, but web-search's option list keeps
  its current contents in this unit.

## The trap that shapes the whole design

`applyProviderConfigHints` (`src/codex/catalog/provider-fetch.ts:574-582`) **adds**
`"image"` to a model's `inputModalities` when the model is listed in
`provider.noVisionModels`. That is deliberate: `noVisionModels` marks models the
PROXY describes images for, and the Codex app gates attachments client-side on
`input_modalities`, so a text-only entry would block the image before the sidecar
could ever run.

The consequence for this unit is load-bearing: **catalog `inputModalities` is not a
truthful vision-capability signal.** A model that is in `noVisionModels` advertises
`["text","image"]` precisely *because* it is blind. Filtering on `inputModalities`
alone would let a blind model be chosen as the describer for other blind models.

Therefore eligibility is a conjunction:

```
eligible(model) = advertisesImageInput(model) AND NOT isSidecarConsumer(model)
```

where `isSidecarConsumer` is `modelInList(provider.noVisionModels, id)` — the same
predicate `planVisionSidecar` uses to decide a model needs describing.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| # | Doc | Phase | Consumes |
|---|-----|-------|----------|
| 0 | this unit | roadmap | — |
| 1 | `010_vision_eligibility_core.md` | eligibility predicate + baselines in `src/vision/eligibility.ts` | catalog metadata accessors |
| 2 | `020_management_api_allowed_models.md` | `/api/sidecar-settings` exposes the allowed list and rejects ineligible writes | phase 1's predicate |
| 3 | `030_dashboard_vision_card.md` | dashboard card restyle + server-provided options | phase 2's payload |
| 4 | `040_stack_publication.md` | branch cascade, push, stacked PRs | phases 1-3 |

Each phase closes with something independently verifiable: phase 1 with unit tests
over the predicate, phase 2 with route tests over both the 200 and the 400 path,
phase 3 with `lint:gui` + `build:gui` + a read-back screenshot, phase 4 with
`gh pr view` base refs.

## Verifiers (PLAN-VERIFIER-REAL-01)

Run before this plan was written, from the worktree root:

| Command | Exit | Reads this unit's target? |
|---|---|---|
| `bun run typecheck` | 0 | yes — `tsconfig.json` compiles `src/**` and `gui/src/**`, which is where every phase writes |
| `bun run test` | 0 | yes — `tests/*.test.ts` is a flat glob over the whole directory, so a new `tests/vision-eligibility.test.ts` is picked up without configuration |
| `bun run lint:gui` | 0 | yes for phase 3 only — `gui/eslint.config.js` lints `gui/src/**`; it does **not** observe `src/**`, so it is not a gate for phases 1-2 |
| `bun run build:gui` | 0 | yes for phase 3 — Vite builds `gui/src` into `gui/dist` |
| `bun run privacy:scan` | 0 | partially — it scans the repo including `devlog/`, so it observes these documents, but it asserts nothing about the filter's behavior |

`bun run lint:gui` does **not** observe `src/vision/*`; phase 1 and 2 acceptance
rows are covered by `typecheck` + `test`, not by lint.

## Field chain (PLAN-FIELD-CHAIN-01)

The unit adds one field to a wire payload — `visionModels` on the
`/api/sidecar-settings` GET response — and one derived value, the eligibility
boolean. Its chain:

| Stage | Location | Note |
|---|---|---|
| creation | `visionEligibleModelOptions()` in `src/vision/eligibility.ts` (NEW) | derives from `listManagementModelRows` output plus config |
| serialization | `src/server/management/config-routes.ts` GET **and PUT** `/api/sidecar-settings` | both response bodies, so an optimistic update and a refetch cannot disagree |
| deserialization | `SidecarData` in `gui/src/pages/dashboard-shared.ts` | new optional `visionModels?: SidecarModelOption[]` — optional so a stale GUI against a new server, or a new GUI against a cached response, degrades to the old client-side list rather than rendering an empty picker |
| consumers | `use-dashboard-data.ts`: NEW `visionModels` memo + three field-by-field writes in `saveSidecar` (optimistic `next`, success `setSidecar`, session cache) and the hook's return object; `dashboard-overview-sections.tsx` (the vision `Select`) | the existing `sidecarModels` memo stays as-is and keeps serving web-search — `N/A` for it by design. The poll effect assigns `data.sidecar` wholesale, so it needs no edit; `CachedControls.sidecar` is typed `SidecarData`, so the optional field flows without a type change |
| validation | `PUT /api/sidecar-settings` in the same file, and the `visionSidecar` branch of `PUT /api/claude-code` in `agent-settings-routes.ts` | rejects a **provably blind** `vision.model` with 400; an unknown id is allowed |

No enum gains a value in this unit, so the enum-consumer sweep is `N/A`.

## Bypass (PLAN-BYPASS-NAMED-01)

| Field | Value |
|---|---|
| tier | E4 — server-side request validation |
| executing surface | `PUT /api/sidecar-settings` in `src/server/management/config-routes.ts`, plus the Claude Code vision override in `src/server/management/agent-settings-routes.ts` |
| known bypass | editing `~/.opencodex/config.json` by hand and restarting; the config loader does not re-validate `visionSidecar.model` |
| residual risk | a hand-edited blind model stays configured and the sidecar produces useless descriptions; it fails at request time, not at write time |
| wording downgrade | yes, and deliberately. The gate rejects only models **positively known** to be unable to see. It is enforcement against a *proven-blind* selection and no barrier at all against an *unknown* one |
| final layer | none. `planVisionSidecar` stays permissive by design, so an operator can still point at a model the catalog has never heard of |

**The gate and the picker are not the same set** (audit round 1, blocker 1). The
picker suggests; the gate forbids. Deriving one from the other would reject every
unknown id — including `custom-vision`, which
`tests/vision-reasoning-contract.test.ts:148-151` asserts must still save with
`providers: {}`. The rule is therefore:

```
picker option  ⇐  eligible AND reachable by an executor AND known to some source
PUT rejection  ⇐  modelAcceptsImageInput(...) === false     (never on undefined)
```

## Scope boundary: the Claude Code override (audit round 1, blocker 5)

Claude Code carries its own vision sidecar override
(`gui/src/pages/claude-code-sections.tsx:154-205`, persisted through
`PUT /api/claude-code`). Two halves, decided separately:

- **Server: in scope.** The eligibility gate covers every route that sets a vision
  describer, so `agent-settings-routes.ts` gets the same rejection. A second
  unguarded write path would make the first gate decorative.
- **GUI: out of scope.** That surface is a freeform `<input>` with a `<datalist>`
  of suggestions, not a constrained picker. Narrowing a deliberately freeform
  field is a different product decision and is not smuggled into this unit.

Requirement 2 ("both sides show only allowed models") is therefore read as: both
*backend families* (OpenAI and Anthropic) inside the dashboard vision picker —
which is the control the request was anchored on.

## Out of scope

- A third sidecar executor (e.g. a Gemini or xAI vision path). Adding a provider
  family here would change routing surface, not just the picker, and belongs to its
  own unit.
- Changing which models `noVisionModels` contains.
- Web-search sidecar option filtering.
- Merging the resulting PR stack. Publication is authorized; merging is not.
