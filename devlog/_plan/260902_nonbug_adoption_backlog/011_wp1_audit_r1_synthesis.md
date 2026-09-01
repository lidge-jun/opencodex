# wp1 audit round 1 — synthesis

Reviewer: grok-4.6 adversarial lane (agent `01a05df6`).
Verdict: `GO-WITH-FIXES (blockers=3)`. All three accepted and folded. No rebuttals.

A first reviewer (`01a05de5`) produced nothing across four wait cycles and was
retired under DISPATCH-RETIRE-01; this is the replacement's round.

The reviewer independently confirmed the central blocker — `toPutBody` allowlist
plus wholesale `nextCombos[id] = stored` — so the plan's justification stands.

## Blocker 1 — GET echo, not just disk churn (ACCEPTED)

I planned to sparsify only the PUT persist destructure. The reviewer found
`sparseComboConfig` (`src/server/management/combo-routes.ts:71-78`), which the GET
list handler (`:84-91`) and the PUT response (`:248`) both run, and which today
strips exactly one default: `imageInput: "auto"`.

Since `getCombo` returns an already-normalized combo, every GET row would echo
`"reasoningEffortMode": "strict"` for users who never opted in. Worse, any client
that round-trips GET into PUT would then write that default straight back to disk,
defeating the persist-side fix entirely.

Correction: extend `sparseComboConfig` itself to drop `reasoningEffortMode: "strict"`,
which fixes GET, the PUT response, and the round-trip in one place. The persist-side
destructure becomes redundant — use the shared helper rather than two rules that can
drift.

## Blocker 2 — wrong file for the sync key, two GUI sites missing (ACCEPTED)

`baselineSyncKey` is at `gui/src/components/combo-workspace-detail-panel.tsx:90`,
not in `combo-workspace-data.ts` as my map said. Following the map as written would
ship a toggle whose draft never resyncs when only the mode changes.

Also missing: `emptyDraft` (`combo-workspace-data.ts:619-631`), `draftEquals`
(`:478-488`), and the create path — `combo-workspace-add-modal.tsx:50-52` calls
`intersectComboEfforts` with no mode, so a mixed group's picker still reads empty
while the user is creating the combo. Fixing only the detail panel leaves the
create flow lying at exactly the moment the user is assembling the mixed group
that motivates the feature.

## Blocker 3 — criteria that pass without the branch firing (ACCEPTED)

- Criterion 3 asserted only the plain `reasoning_effort` path, but the PR also
  edits the `reasoningWireFormat === "gateway-object"` branch
  (`src/adapters/openai-chat.ts:1498`). That branch could be left stale and the
  criterion would still go green. Now requires a gateway-object provider assertion.
- Criterion 4 was a `toPutBody` unit assertion, which passes even if PUT still
  drops the field and GET still echoes `strict`. Now requires the management
  round-trip: PUT `adaptive` then GET and see it survive.
- Criterion 1 proved the catalog default, not wire byte-identity. Now split: a
  catalog assertion and an adapter assertion that an unlisted model's body is
  unchanged.

## UX correction (reviewer point 6 — accepted, changes the design)

I had placed the toggle under "Default reasoning". The reviewer's objection is
correct and it is not cosmetic: `defaultEffort` is a *value chosen from* the
intersection, whereas this is a *policy that changes what the intersection is* —
the same kind of thing as `imageInput`, which already lives in `ComboCapabilities`
as a switch (`gui/src/components/combo-workspace-controls.tsx:100-136`).

Placing a policy switch under a value dropdown invites the reading "this changes
my default effort", which is precisely what it does not do.

Revised: the toggle goes in `ComboCapabilities` beside the image-input switch,
where combo-wide capability policy already lives. That is also the component the
create modal and the detail panel share, so the create flow gets the control for
free — which is what blocker 2 requires anyway.

## Not folded

`buildOpenAIChatPassthroughRequest` (`openai-chat.ts:108-142`) ignores this key —
but it equally ignores `noReasoningModels` today, so it is a pre-existing passthrough
boundary, not a regression this unit introduces. Recorded, not fixed here.

Docs wording: the reviewer notes "unsupported effort fields are omitted" overclaims,
because Responses does not run `stripEmptyLadderEffort` (Chat-only,
`src/server/chat-completions.ts:191-196`). The docs sentence will be narrowed to
what is true rather than the feature being expanded.

Line drift: plan cited `openai-chat.ts:1428`; live reasoning block is `:1494-1498`.
