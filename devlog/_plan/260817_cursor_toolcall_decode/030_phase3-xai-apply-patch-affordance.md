# 030 — Phase 3: `xai/grok-4.6` does not use `apply_patch`

Added mid-loop at the user's request (LOOP-UNIT-CHAIN-01).
**Revised twice after adversarial audits** (round 1 findings 9-10, round 2
findings 1, 3, 5, 6).

## What is proven

Codex advertises `apply_patch` as a **freeform/custom** tool (`type: "custom"`
with a grammar). On the xai path that form is lowered twice:

1. `src/responses/parser.ts:184` replaces the grammar with `{input: string}`.
2. `src/adapters/openai-chat.ts:1183` serializes every internal tool — including
   `freeform: true` ones — as `type: "function"` (`:1194`).

xai resolves to `openai-chat` (`registry.ts:985`) and posts to
`/chat/completions` (`openai-chat-url.ts:7`); OAuth only swaps URL/headers
(`xai-transport.ts:101`, `:142`). The tool is **not** dropped —
`{input: string}` is a concrete schema and passes the filter (`:1141`, `:1193`).

The **return path is already correct**: the tool stays `freeform: true`
(`parser.ts:196`), the bridge recognizes it (`bridge.ts:1023`), unwraps `{input}`
(`:220`), and emits a `custom_tool_call` (`:621`).

**Proven claim: a lossy conversion. Nothing more.**

## What is NOT proven (round 1, finding 9)

`parser.ts:189` already attaches apply_patch-specific guidance to the `input`
property — "begin exactly with `*** Begin Patch` … then use its standard patch
envelope" — covered by `tests/responses-custom-tool-guidance.test.ts:15`.

So the claim that Grok is "never told" what `apply_patch` is was **false**, and
whether the grammar erasure is why Grok declines the tool is **not established by
reading source**. Competing explanations this decode cannot rule out: Grok
weighting an alternative edit affordance, dislike of a large opaque string
parameter, or prompt-level factors unrelated to the catalog.

## The scoping seam does not exist yet (round 2, finding 1)

The previous revision required gating on "the resolved provider being xai". That
is **not implementable where the plan put it**: `createOpenAIChatAdapter()`
receives only `OcxProviderConfig`, the adapter factory context carries no
provider name (`adapters/registry.ts:15-17,57-60`), and `resolveAdapter()` drops
`route.providerName` (`server/adapter-resolve.ts:51-52`,
`server/responses/core.ts:2142`). Host-based detection would misclassify custom
providers, and a provider-isolation test could pass merely by using a different
base URL — a test that proves nothing.

**Consequence: this phase now includes threading provider identity through
adapter construction**, as an explicit, reviewable scope expansion rather than a
hidden assumption. If that seam turns out to be more invasive than the experiment
justifies, the honest move is to defer the phase, not to fake the gate with a
host regex.

**The seam must cover every reconstruction, not just the first build.** Adapters
are rebuilt on retry and rotation paths (`server/responses/core.ts:584` and seven
further sites through `:4135`), so identity has to be mandatory at the
route-resolver boundary rather than passed at one call site. Otherwise the
guidance silently disappears after a failover — the worst kind of bug, since it
only manifests on the retry path the user never sees.

## The sibling-tool predicate is under-specified (round 2, finding 3)

"Suppress when another edit-capable tool exists" has no definition. `OcxTool`
carries no edit-capability provenance (`types.ts:206-224`), name matching misses
arbitrary MCP edit tools, and description matching would suppress the experiment
whenever ordinary code-mode `exec` is present (`tool-catalog-nudge.ts:12-17`).

**Resolution: drop the sibling-tool gate.** Replace it with a narrower, decidable
rule — the note describes how to *call* `apply_patch` when it is used, and never
asserts it should be preferred over another tool. Required wording shape:
conditional, not imperative — "when using `apply_patch`, pass the entire patch
as the `input` string, beginning `*** Begin Patch` …" — with no "prefer",
"always", or "for every file edit".

**This reduces demotion risk; it does not eliminate it.** Any added system-level
emphasis can shift relative tool selection even without exclusivity language, and
no unit test can measure that. Residual sibling-selection risk is therefore
live-test-dependent and is recorded as an accepted risk of running the
experiment, not as something the tests below disprove.

## xAI capability, corrected (round 2, finding 5)

The earlier statement that xAI describes Chat Completions as "function-calling
only" was too strong. Current xAI documentation demonstrates function calling
through `/v1/responses` and accepts an object root or `anyOf`/`oneOf` whose
branches are objects. What it documents are **Responses function tools**, not
Codex-style freeform `type: "custom"` grammar tools.

Stated precisely: **the documented contract does not preserve freeform grammar**,
so lowering to `{input: string}` would still be required on that route. That is
a statement about the documentation, not a proof that the endpoint would reject a
grammar tool — only the planned live probe can settle that.
<https://docs.x.ai/developers/tools/function-calling>

Any option-3 evaluation must also distinguish public API-key Responses support
from the OAuth CLI proxy (`xai-transport.ts:101`), which are different surfaces.

## Live probe (2026-08-17) — the premise is now in doubt

The user pointed out that `xai/grok-4.6` and `cursor/grok-4.6` are both
spawnable as subagents, which turns this phase's central question from
unprovable into testable. A baseline probe was run before writing any code.

**Setup.** Two identical scratch directories, each with one `greet.js`. One
subagent per provider, same prompt: change the greeting string, then report
which tool performed the edit.

**Result: both succeeded.**

| Provider | Edit applied | Tool reported |
|----------|--------------|---------------|
| `xai/grok-4.6` | yes, verified by reading the file back | `apply_patch` |
| `cursor/grok-4.6` | yes, verified by reading the file back | `apply_patch`, explicitly "called from `exec` via `tools.apply_patch`" |

**What this does and does not establish.**

- It does **not** confirm the reported symptom. On this task `xai/grok-4.6` edited
  the file successfully and named `apply_patch` as the tool.
- It does **not** exercise the surface this phase is about. The cursor agent
  stated it reached `apply_patch` through **code mode** — `tools.apply_patch` nested
  inside `exec` — which is a different path from the top-level freeform tool
  whose grammar `parser.ts:184` erases. Code mode is exactly the case
  `tool-catalog-nudge.ts:12-17` describes. The xai agent's bare "`apply_patch`"
  is ambiguous between the two paths.
- Self-reported tool names are **not wire evidence**. A model naming a tool is a
  claim about its own behavior, not a record of what was sent. The routing
  history DB (`~/.opencodex/routing-history.sqlite`) stopped recording at 16:00
  local, well before the probe, so the actual request bodies were not captured.

**Consequence for this phase.** The premise — that `xai/grok-4.6` does not use
`apply_patch` — is not reproduced by the first probe that tried. Implementing a
guidance change now would be fixing a defect that has not been demonstrated,
and the identity seam it requires is a real cost (round 3 finding 2).

**Revised first step: reproduce before repairing.** The next cycle of this phase
is a measurement cycle, not an implementation cycle:

1. Capture the wire. Re-enable request-history recording (or a scoped capture)
   so the outgoing tool catalog and the returned call are observed, not reported.
2. Probe with code mode **disabled**, so the top-level freeform `apply_patch` is
   the only edit affordance. That is the surface this phase theorises about.
3. Probe a multi-file / larger patch, where authoring the full envelope inside a
   JSON string is materially harder than a one-line replacement.
4. Ask the user for the failing case they actually saw, since their report is
   the only evidence the symptom exists at all.

If the symptom does not reproduce under (2) and (3), the honest outcome for this
phase is **NOOP with evidence**, not a speculative prompt change. The options
below stay on record for the case where it does reproduce.
## Decision

Options, ranked after two audits:

1. **Structured edit aliases** (mirroring Cursor's `edit_file`/`multi_edit`,
   `cursor/tool-definitions.ts:274`, translated at `protobuf-events.ts:1170`).
   Matches xAI's documented JSON-schema contract; largest surface, needs
   provenance gating so a legitimate MCP `edit_file` is never hijacked (#1036).
2. **Sharpened call-shape guidance**, xai-scoped via the new identity seam.
   Cheapest probe, but per-property guidance already exists, so it is the weaker
   hypothesis.
3. **Native Responses routing.** Needs a live capability probe on both xai
   surfaces; risks OAuth transport and continuation regressions.

**Chosen: (2) — but CONDITIONAL on reproduction.** Nothing below is implemented
until the measurement cycle above reproduces the symptom. If it does not, this
phase closes NOOP with evidence and the options stay on record. Read the rest of
this section as "what we would build IF the defect is real", not as a commitment.

Chosen if reproduced: (2), explicitly as an experiment, with the identity seam as declared
scope. If a live run still shows Grok avoiding `apply_patch`, escalate to (1)
rather than iterating on wording.

## Tests (`tests/xai-apply-patch-guidance.test.ts`)

1. xai + freeform `apply_patch` -> the note appears exactly once.
2. A non-xai `openai-chat` provider using an **identical `OcxProviderConfig`
   object** -> no note. Only the separately threaded provider identity may vary.
   Same-URL alone is insufficient: auth mode, headers, or the fetch wrapper could
   otherwise be doing the discriminating (round 3 finding 3).
3. xai without `apply_patch` -> no note.
4. The advertised tool remains `type: "function"` with `{input: string}` —
   guidance must not alter the wire schema.
5. A returned `apply_patch` call still decodes to a `custom_tool_call`
   (regression over `bridge.ts:621`).
6. The provider-identity seam itself: a route's provider name reaches the adapter.
7. **Reconstruction**: an adapter rebuilt on a retry/rotation path still carries
   provider identity, so the note survives a failover (round 3 finding 2).

## Done when

**Measurement cycle (runs first).** Done when the wire is captured for an xai
`apply_patch` request, a code-mode-disabled probe and a larger multi-file probe
have both been run, and the outcome is recorded either as a reproduced symptom
(then the implementation criteria below apply) or as NOOP with evidence.

Harness note (round 4 finding 4): every routed catalog row is stamped
`code_mode_only` (`src/codex/catalog/parsing.ts:424`), so the probe cannot simply
"turn code mode off" — it needs a direct Responses request fixture or a
controlled catalog override that exposes only the top-level freeform tool. Name
the chosen harness before running the probe.

**Implementation cycle (only if reproduced).**

All seven pass, typecheck clean, suite green on `ssh lidge`, pushed — and the
report states plainly that the behavioral claim is **unverified pending a live
xai run**. Passing tests prove delivery and isolation, never that Grok changed
its mind.

