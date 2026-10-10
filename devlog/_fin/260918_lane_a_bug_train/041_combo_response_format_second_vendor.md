# 041 — #5035: the second gateway's response_format refusal

## What was reported

#5035 reopens #4903. The reporter confirms the original model,
`alibaba-token-plan/deepseek-v4.1-flash`, now works, and reports that
`deepseek/deepseek-v4-pro` still refuses `response_format` with HTTP 400 while the combo
chain fails to fall through to `deepseek/deepseek-flash`:

```
Provider error 400: {"error":{"message":"This response_format type is unavailable now",
"type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
```

The natural reading is that #4927 generalized less than it needed to. It did not. Both
halves of the report have a different cause than the one the text suggests.

## The reported build predates the fix

The issue reports version 2.58.0. `v2.58.0` is `6fe4cd0de8`, tagged 2026-09-17 17:40 UTC.
#4927 is `78c71f789a`, authored 2026-09-17 19:49 UTC — two hours and eight minutes later.
`git merge-base --is-ancestor 78c71f789a v2.58.0` exits 1 and `git tag --contains 78c71f789a`
is empty, so the capability classifier is in no published release. `dev` carries it and
declares 2.59.0, which is the first release that would.

So 2.58.0 behaves exactly as the report describes, and for the documented reason: the
gateway sends `type: "invalid_request_error"`, which reaches the generic terminal list in
`comboFailureDecision` before anything asks whether the next target could serve the request.

## Why the Alibaba model improved without the fix

Not failover. #4888 (`25311bcc00`) landed in 2.58.0 and added, to both Alibaba Token Plan
presets, a probe-backed `noJsonSchemaModels: ["deepseek-v4.1-flash"]`. Its comment quotes the
identical upstream string:

> Probed 260915 on the plan gateway: json_object returns valid JSON, strict json_schema is
> rejected 400 ("This response_format type is unavailable now") in both thinking modes.

`src/adapters/openai-chat/passthrough.ts` reads that field and rewrites a `json_schema`
request body to `json_object` for the listed model. The refusal is therefore never provoked,
so the chain never needs to hop. The two models differ in which remedy 2.58.0 happens to
carry, not in how the classifier treats them.

## The envelope already hops on dev

Traced against `isResponseFormatCapabilityRefusal` at `src/combos/failover.ts:452`, the
reported body reaches `hop` in every form the pipeline can produce:

- Raw body with `upstreamCode` extracted as `invalid_request_error`, and with it undefined.
- `Provider error 400: {...}`, the display wrapper.
- `data: {...}`, the single-frame form #4927 added the unwrap for.
- The proxy's own re-wrap, peeled within the depth budget.

`consumeComboFailure` hands the classifier the raw upstream body as `classificationText`
(redacted, bounded to 500 characters) plus the extracted code, and nothing between HTTP 400
and the classifier rewrites it. No earlier `stop` intercepts: `invalid_request_error` is
neither `origin_rejected`, nor non-replayable, nor a cyber-policy code.

The one thing the second gateway does that the first never did is send
`code: "invalid_request_error"` — the code the generic terminal list stops on — at both the
outer and the inner level. Alibaba's `invalid_parameter_error` is not a terminal code, so the
ordering inside `comboFailureDecision` was never load-bearing for it. That is what the new
regression block pins.

## What was deliberately not done

**The hop set was not widened.** It did not need to be, and widening it to make a passing
case pass is how the distinction between "this target cannot accept this request as shaped"
and "this request is wrong" erodes. The verdict still requires the message to name
`response_format` and to claim the field is unavailable; a malformed-schema complaint stays
terminal.

**No `noJsonSchemaModels` row was added for `deepseek-v4-pro`.** It would be the same remedy
#4888 used, and on the evidence it is plausible — the wording is type-specific and DeepSeek's
first-party API has never accepted `json_schema`. Two things stop it. There is no probe: the
reporter's 400 proves the refusal, not that `json_object` is accepted in its place, and
downgrading a model that does support `json_schema` silently degrades the output contract.
And `deepseek-v4-pro` is not on the `deepseek` preset's roster at all
(`src/providers/registry/entries-core.ts:1018`); `entries-extended.ts:778` records that
DeepSeek retired the id. There is no maintained model row to annotate. A probe against the
reporter's gateway would settle it, and it belongs in its own unit if someone runs one.

## The second question in the report

The reporter asks whether `gpt-5.6-terra` needs a shadow-call intercept model too. It does
not, and it is not a gap.

`DEFAULT_SHADOW_SOURCE_MODELS` is `["gpt-5.6-luna"]` (`src/lib/shadow-call.ts:10`). Terra's
exclusion is deliberate and recorded:
`devlog/_fin/260723_issue_fixes/020_issue311_shadow_intercept.md` says it was left out
because no capture showed Codex using it as a helper, and `sourceModels` was added as the
escape hatch if that changed. Three tests hold the decision
(`tests/responses/responses-shadow-intercept.test.ts`).

Terra is a normal native model and a default subagent model, so seeing Terra traffic is not
evidence of a title call. Compaction is a separate path that reuses the client-selected model
(`routeCompactionModel`), which explains Terra appearing in request logs without any shadow
classification.

If a capture ever shows a Terra title call, the operator-side answer already exists:
`shadowCallIntercept.sourceModels: ["gpt-5.6-luna", "gpt-5.6-terra"]`. Terra alone would drop
Luna, and either spelling intercepts every bare Terra request including foreground and
subagent traffic, which is why it is not the default. To ban Terra outright,
`blockedModelRedirects` is the intended knob. No separate issue is warranted.
