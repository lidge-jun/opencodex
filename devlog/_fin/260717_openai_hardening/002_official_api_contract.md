# Official OpenAI API Contract

Only official OpenAI documentation is authoritative for this unit.

## Model family

Official model pages:

- <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
- <https://developers.openai.com/api/docs/models/gpt-5.6-luna>

Verified shared metadata used by OpenCodex:

| Model | Context | Max input | Max output | Input | Output |
|---|---:|---:|---:|---|---|
| `gpt-5.6-sol` | 1,050,000 | 922,000 | 128,000 | text, image | text |
| `gpt-5.6-terra` | 1,050,000 | 922,000 | 128,000 | text, image | text |
| `gpt-5.6-luna` | 1,050,000 | 922,000 | 128,000 | text, image | text |

The current OpenCodex catalog computes routed auto-compaction at 90% of context.
For 1,050,000 that is 945,000, which exceeds the official 922,000 maximum input.
This unit therefore carries the max-input limit narrowly into catalog metadata and
caps auto-compaction at `min(90% of context, max input)`. Max output is recorded
here but does not need a separate Codex picker field in this unit.

`gpt-5.6` is an upstream alias that routes to Sol. The API provider may expose it
as a normal upstream model id; it is not an OCX virtual Pro alias.

## Reasoning contract

Official guide:

- <https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters>
- <https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode>

The documented GPT-5.6 effort ladder is:

`none`, `low`, `medium`, `high`, `xhigh`, `max`

OpenCodex's current Codex picker contract represents `low` through `max`; it does
not define `none` as a selectable Codex effort. This unit therefore advertises the
supported intersection (`low`, `medium`, `high`, `xhigh`, `max`) and leaves an
omitted effort to the API default (`medium`). Adding a global `none` tier would be
a separate cross-provider contract change.

Pro is selected on a base model with:

```json
{
  "model": "gpt-5.6-sol",
  "reasoning": { "mode": "pro" }
}
```

Therefore OpenCodex must not send `gpt-5.6-sol-pro` as an upstream model slug.
The same rule applies to Terra and Luna.

Official guidance states that reasoning mode and effort are independent. A Pro
virtual selection may therefore preserve or set a supported `reasoning.effort`;
when effort is omitted, GPT-5.6 defaults to `medium` in both standard and Pro mode.

## Translation boundary

For a request selecting `openai-apikey/gpt-5.6-sol-pro`:

1. routing recognizes `openai-apikey` and preserves the original selected id in
   logs/history-facing state;
2. the trusted provider virtual-model resolver maps the routed id to
   `gpt-5.6-sol`;
3. it merges `mode: "pro"` into the raw `reasoning` object, preserving the
   independently supported effort and other supported fields;
4. the OpenAI Responses adapter serializes the rewritten body to
   `https://api.openai.com/v1/responses`;
5. the transform is rejected/no-op outside `openai-apikey` and outside the exact
   three virtual ids.

If a caller supplies a conflicting `reasoning.mode`, the selected virtual model is
authoritative and forces `pro`. The request log records that a virtual transform
was applied without logging credentials or request content.

## Compact boundary

The official `POST /v1/responses/compact` OpenAPI schema and current official SDK
`ResponseCompactParams` do not include a `reasoning` field. For a Pro virtual
selection, OpenCodex sends the base model id to compact and no mode/effort member.
This does not downgrade the next generated answer: the following normal Responses
request resolves the same virtual selection and reapplies `reasoning.mode: "pro"`.

## Deferred official capabilities

The guide also documents persisted reasoning, explicit prompt caching, and
Programmatic Tool Calling. They are intentionally excluded until provider/auth
ownership and the Pro alias boundary are stable and independently tested.
