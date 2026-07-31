# Shadow Call Intercept

## What are shadow calls?

Codex Desktop App makes background API calls with a hard-coded helper model for internal tasks:

- **Thread title generation** — auto-generates 3-8 word titles after your first prompt
- **Commit message generation** — generates git commit messages
- **Skill orchestration** — internal orchestration turns

These calls happen independently of your selected main model and use `reasoningEffort: low`.

The helper model is not stable across client versions. Codex used `gpt-5.4-mini` up to 0.144.x and
moved to `gpt-5.6-luna` in 0.145.0, which silently disabled a single-literal intercept
([#311](https://github.com/lidge-jun/opencodex/issues/311)). The intercept therefore matches a
**set** of source-model prefixes — `gpt-5.4-mini` and `gpt-5.6-luna` by default — so a client bump
does not quietly turn the feature off. Routed ids (`provider/model`) are never matched: a shadow
call is always a bare native slug, and an explicit routed selection must not be hijacked.

## The problem

- Non-OpenAI providers (Bedrock, Azure, etc.) may not support the bare helper slug, causing 404 errors
- Users have no control over which model handles these helper tasks
- Shadow calls consume API quota without user awareness

Related GitHub issues: [#26288](https://github.com/openai/codex/issues/26288), [#28741](https://github.com/openai/codex/issues/28741), [#28821](https://github.com/openai/codex/issues/28821), [#24208](https://github.com/openai/codex/issues/24208)

## Configuration

### Via Dashboard UI

1. Open the opencodex dashboard
2. Find the "Shadow Call Intercept" panel
3. Toggle the switch to enable
4. Enter a replacement model (e.g., `gpt-5.5`)

The panel badge and tooltip render the source models the running proxy actually intercepts, read
from `GET /api/shadow-call-settings` (`sourceModels`), so the UI never names a stale slug.

### Via config.json

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5"
  }
}
```

`sourceModels` is an optional override. When set to a non-empty array of strings it **replaces**
the defaults rather than extending them:

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

### Behavior

- When enabled, ALL requests whose bare model id starts with one of the source-model prefixes
  (default `gpt-5.4-mini`, `gpt-5.6-luna`) are rewritten to the configured model
- Reasoning effort is forced to `low` (matching the original behavior)
- The original model ID is logged as `shadowCallRewrittenFrom` in request logs
- When disabled (default), no interception occurs

### Warning

Enabling this redirects every request for a source model, not just Codex's background helper turns.
`gpt-5.6-luna` is also a selectable chat model, so if you pick it as your main model while the
intercept is on, those turns are redirected too — narrow `sourceModels` if that matters to you.
