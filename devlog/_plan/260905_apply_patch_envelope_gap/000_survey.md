# 000 — Survey: routed-provider `apply_patch` envelope failures in code mode

Unit: `devlog/_plan/260905_apply_patch_envelope_gap`. Opened 2026-09-05 against `origin/dev` `917d5dc0d`.

## Why this unit exists

The reported symptom is that routed models — grok most visibly — keep getting the
Codex patch envelope wrong. That report is real, but it turned out to name two
different defects that share a symptom and have opposite correct answers. Splitting
them is most of the work here.

## Method

Every measurement below comes from the local Codex rollout store,
`~/.codex/sessions/**/*.jsonl` (10931 files). A rollout records each
`custom_tool_call` verbatim, including the `input` the provider produced, and
`turn_context` names the model. So the provider's own bytes are recoverable rather
than inferred. Denominators are every `custom_tool_call` whose name is `exec`.

This is observational data from one operator's machine. It is strong evidence about
what these models actually emit and weak evidence about population rates.

## The two failure modes

### MODE A — a raw patch envelope submitted as the `exec` body

The provider emits a code-mode `exec` call whose entire `input` is a patch envelope.
It is not JavaScript, so the V8 isolate throws and the turn is wasted.

| Model | occurrences |
|---|---|
| `anthropic/claude-opus-5` | 36 |
| `xai/grok-4.6` | 8 |
| `kimi/k3[1m]` | 6 |
| `anthropic/claude-fable-5` | 5 |

Note the ordering: this one is **not** grok-dominated. It is led by the Anthropic
models, which matters because it means MODE A is not a single provider's quirk.

### MODE B — a decorated envelope inside otherwise valid JavaScript

The body is real JavaScript, usually `await tools.apply_patch(...)`, but the patch
string decorates the marker lines as `*** Begin Patch ***` with a trailing `***`.
Codex rejects that form.

| Model | occurrences | distinct sessions |
|---|---|---|
| `xai/grok-4.6` | 116 | 54 |
| `anthropic/claude-fable-5` | 8 | 1 |
| `anthropic/claude-opus-5` | 7 | 3 |
| `kimi/k3[1m]` | 7 | — |
| `gpt-5.6-sol` | 3 | 1 |
| `cursor/grok-4.6` | 2 | — |
| `kiro/claude-opus-5` | 1 | 1 |

This is the grok-dominated one, and it is what the report was mostly about.

## Rate, before and after the guidance sentence

Commit `03d576762` (2026-08-23) added a sentence to the injected tool-contract nudge
telling models not to decorate the markers. A plausible theory was that the sentence
backfired, because it displays the forbidden string `*** Begin Patch ***` as a
copyable literal, and models pattern-copy examples.

Splitting the same corpus on that date does not support the theory as stated:

```
model                           PREdec   PREtot     PRE%   POSTdec  POSTtot    POST%
xai/grok-4.6                        35     5781   0.605%        95     8335   1.140%
anthropic/claude-opus-5              4    30807   0.013%        12    23079   0.052%
anthropic/claude-fable-5            13    11715   0.111%         0     1141   0.000%
kimi/k3[1m]                         12     3202   0.375%         0      825   0.000%
cursor/grok-4.6                      2      378   0.529%         0       59   0.000%
gpt-5.6-sol                          0   116399   0.000%         3    37570   0.008%
```

**The decorated form predates the sentence.** grok was already at 0.605% before the
sentence existed, so the sentence cannot be the cause. The rate did roughly double
afterwards (0.605% -> 1.140%), which is consistent with the sentence making things
worse — and equally consistent with model version changes, workload mix, or the
simple fact that post-cutoff traffic is a different set of tasks. Two models moved
the other way to zero.

Recorded honestly: the copy-hazard is a real property of the wording, the
correlation is suggestive, and causation is **not** established.

### The A/B probe did not reproduce the defect

Eight `xai/grok-4.6` subagents, four given the current wording and four the proposed
replacement, were asked to emit the exact `apply_patch` payload. All eight produced
the canonical form. Decorated rate 0/4 in both arms.

A null result on both arms means the probe **cannot discriminate the two wordings**.
It does not show the current wording is fine, and it does not show the new one helps.
The real defect is rare (about 1%) and appears in long sessions under load, which a
single clean-room turn does not recreate. Any wording change therefore ships as a
readability improvement with an unproven effect on the defect rate, not as a fix.

## Why nothing repairs these today

`src/responses/apply-patch-envelope.ts` repairs decorated delimiters only for a
top-level `apply_patch` payload. `repairFreeformToolInput` deliberately returns any
other freeform body byte-identical:

```ts
const ownsApplyPatchGrammar = namespace === undefined || namespace === "functions";
return ownsApplyPatchGrammar && toolName === "apply_patch"
  ? normalizeApplyPatchDelimiters(unwrapped)
  : unwrapped;
```

For a code-mode `exec` call `toolName` is `exec`, so both modes fall through
untouched. That pass-through is correct by design — the header comment says
"arbitrary `exec` JavaScript is caller-authored executable input and must remain
byte-identical" — and `tests/apply-patch-envelope.test.ts` locks it.

## The existing seam

OpenCodex already has a mechanism for "this call is really a nested helper, compile
it into exec JavaScript": `codeModeHelperName`, set in `src/bridge.ts` when
`normalizeDeclaredToolName` rewrites an emitted helper name to the declared `exec`.
When set, `compileCodeModeHelperInput` emits
`await tools.apply_patch(<JSON.stringify'd patch>)`.

That inference is **name-based** and is decided at `tool_call_start`, before any
arguments exist. Neither failure mode reaches it, because in both the provider's tool
name is already `exec`.

## Disposition

Recorded in `010`. In short: MODE A is a candidate for repair through the existing
seam, MODE B is not repairable in the proxy, and the prompt wording is a separate,
smaller question.

