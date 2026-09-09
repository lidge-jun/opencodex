# 010 — Land the missing claude-fable-5-1 metadata (PR #3293)

Work-phase `wp1`. Depends on 000.

## Problem

`src/usage/expected-prices.ts` on `dev` asserts an expected price for
`claude-fable-5-1` on four surfaces, but neither
`scripts/model-metadata.source.json` nor the `anthropic` row of
`src/generated/model-metadata.ts` knows the model exists. Pricing without
metadata is the wrong half to have.

## Diff plan

Carry PR #3293 by [@Veritas-7](https://github.com/Veritas-7). Its diff is exactly
the missing half, so this is a carry rather than a reimplementation.

### scripts/model-metadata.source.json

Insert the `claude-fable-5-1` entry into the `anthropic` provider block, in id
order between `claude-fable-5` and `claude-haiku-4-5`:

```json
"claude-fable-5-1": {
  "id": "claude-fable-5-1",
  "name": "Anthropic Fable 5.1",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "cost": { "input": 10, "output": 50, "cacheRead": 0.25, "cacheWrite": 12.5 },
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "thinking": { "mode": "anthropic-adaptive", "minLevel": "minimal", "maxLevel": "xhigh" },
  "compat": { "toolChoiceSupport": "auto" }
}
```

### src/generated/model-metadata.ts

This file is generated, so it is REGENERATED rather than hand-edited:
`bun run generate:model-metadata`. The expected delta is one row appended to the
`anthropic` array:

```text
["claude-fable-5-1",1000000,128000,"text,image",1,null,10,50,0.25,12.5]
```

Note the cacheRead of `0.25`, not `1`. `claude-fable-5` carries `1`; Fable 5.1's
published cache-hit rate is 0.025x base input, which the existing
`expected-prices.ts` rows already encode. Regenerating rather than typing the row
is what keeps the two files consistent.

### Attribution

`Co-authored-by: Veritas-7 <...>` in the landing commit. Per `CREDITS.md` and
`AGENTS.md`, the trailer is what GitHub reads; prose in the body is read by
nothing.

## Verification

- `bun run typecheck`
- `bun test ./tests/usage-cost.test.ts` — the PR's own test file
- Confirm the generated row exists and matches the source entry
- After merge: re-read `origin/dev` and confirm both files carry the model

## Close-out

Close #3293 citing the landing SHA and naming the author.
