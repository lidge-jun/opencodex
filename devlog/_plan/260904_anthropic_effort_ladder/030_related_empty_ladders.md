# 030 — Related: other rows advertising no effort ladder

Work phase: wp4. Consumes 020. Investigation first; a fix only where evidence
supports one.

## Candidates from the live catalog

`GET /v1/models` on 2026-09-04 returned an empty ladder for three rows besides
the Anthropic ones. Two are genuine candidates:

| Row | Provider block state |
|---|---|
| `lidge/qwen3.8-27b-nvfp4` | no `models` key, no `modelReasoningEfforts` |
| `opencode-free/muse-spark-1.2-contributor-free` | `modelReasoningEfforts` declares `deepseek-v4-flash-free` only |

## The question to answer for each

Not "does it have a ladder" — the catalog already answers that. The question is
whether the ADAPTER would honor an effort if one were declared, which is what
made the Anthropic case a safe fix. An empty ladder on a model whose adapter
ignores or rejects effort is CORRECT, and adding one there would advertise a
control that silently does nothing.

So for each candidate:

1. Which adapter serves it, and does that adapter have an effort path?
2. Is the model reasoning-capable at all, per its own vendor surface?
3. Is it excluded on purpose (a `noReasoningModels` entry, a deliberate empty
   `reasoningEfforts: []`)? Several providers in the registry declare
   `reasoningEfforts: []` explicitly, which is a positive statement of "no
   reasoning", not an oversight.

`lidge` is a local/self-hosted block with `allowPrivateNetwork` and an API-key
pool, so its capabilities depend on the deployed server rather than a vendor
contract — a ladder claim there needs a live probe, not a guess.

## Disposition rule

- Adapter honors effort AND the model reasons -> same fix shape as 010, but as
  its own change with its own evidence. It does NOT ride along in the Anthropic
  PR; a reviewer evaluating a Claude fix should not have to also adjudicate an
  unrelated provider's capabilities.
- Adapter ignores effort, or capability is unproven -> report to the user with
  the evidence and leave the catalog honest. An unproven ladder is a worse defect
  than a missing one, because the control appears to work.

## Deliverable

A written finding per candidate naming the adapter, the capability evidence, and
the verdict. Reported to the user regardless of whether any code changes.

## Findings (260904)

### `lidge/qwen3.8-27b-nvfp4` — NOT A DEFECT, and not this repository's to fix

`lidge` is not a registry provider. The only two `lidge` matches in
`src/providers/registry.ts` are maintainer-attribution comments (lines 744 and
1781). It is the operator's own **custom provider** in `~/.opencodex/config.json`,
pointed at `http://100.100.125.116:8081/v1` on a private network, and it is
currently `disabled: true`. The model is a `customModels` row whose
`reasoningEfforts` is unset.

There is no registry ladder that could fill it, and there should not be: it is a
self-hosted vLLM-style endpoint whose capabilities depend on the deployed server
and its launch flags, not on a vendor contract this repository can assert. The
correct fix is operator-side — set the ladder on the custom model, which the
management API already supports (`src/server/management/model-routes.ts` reads
`reasoningEfforts` on a custom-model PUT).

Verdict: **no code change.** Report to the user as a configuration note.

### `opencode-free/muse-spark-1.2-contributor-free` — NOT A DEFECT under the fix rule

The provider DOES declare `modelReasoningEfforts`, but only for
`OPENCODE_FREE_DEEPSEEK_MODELS` — a one-element list, `deepseek-v4-flash-free`
(registry line 616). Every other Zen free model, including the muse row, falls
through with no ladder.

That is not the Anthropic shape. Zen's free roster is `liveModels: true`:
discovered at runtime, changing on the vendor's schedule, and heterogeneous —
DeepSeek thinking models sit beside models with no reasoning at all. The
DeepSeek entries are declared precisely because they were pinned to a verified
wire contract (`modelReasoningEffortMap`, `preserveReasoningContentModels`,
issues #950/#994). Asserting a ladder for a discovered model whose upstream
effort support nobody verified would be exactly the failure mode this unit's
own rule forbids: an advertised control that may do nothing.

Note also that `muse-spark-1.2-contributor-free` on the Zen tier is a different
route from `meta-muse/muse-spark-1.3`, which DOES carry a ladder
(`META_MUSE_REASONING_EFFORTS`, registry line 1508). So the capability is
already advertised where it was verified.

Verdict: **no code change without a live probe** of the Zen route's effort
handling. Recorded as a candidate, not a defect.

### What the two have in common

Neither is the reported bug. The Anthropic case was a first-party provider with a
known vendor contract and an adapter that already honored effort — every fact
needed to assert the ladder was in the repository. These two are a private
self-hosted endpoint and a live-discovered free roster; in both the missing
ladder is an honest "unknown" rather than a lost fact.

The general `derive.ts` per-model fill shipped in the Anthropic PR does help
both classes going forward: any operator who pins one model on these providers
will no longer suppress whatever registry knowledge exists for the others.
