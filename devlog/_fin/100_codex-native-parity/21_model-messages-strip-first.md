# 100.21 — Model Messages Strip-First Decision

## Decision

For routed non-OpenAI models, strip `model_messages` first.

Do not try to preserve `/personality` on routed models until opencodex owns provider-safe
`model_messages` templates.

## Why This Changed

Earlier Phase 100 docs left two options open:

1. strip `model_messages`;
2. rewrite `model_messages.instructions_template`.

Follow-up Codex RS inspection makes the safer path clear. `model_messages` is live prompt assembly
metadata. Codex calls:

```text
model_info.get_model_instructions(config.personality)
```

and that method prefers:

```text
model_messages.instructions_template
```

over:

```text
base_instructions
```

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:592
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:452
```

## Native Model State

Most current native picker models use `model_messages`:

| Model | `model_messages` |
| --- | --- |
| `gpt-5.5` | present |
| `gpt-5.4` | present |
| `gpt-5.4-mini` | present |
| `gpt-5.3-codex` | present |
| `gpt-5.2` | null |
| `codex-auto-review` | present |

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:24
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:118
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:207
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:291
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:375
/tmp/opencodex-codex-src/codex-rs/models-manager/models.json:455
```

The template shape is simple but large:

- an identity header that starts with Codex/GPT-5 wording;
- `{{ personality }}`;
- the main Codex instruction body;
- three personality variables.

`supports_personality` is derived from the template, not an independent flag:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:446
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:474
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:490
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:512
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:553
/tmp/opencodex-codex-src/codex-rs/app-server/src/models.rs:25
```

## Current opencodex Risk

opencodex currently deep-clones the native template and rewrites only `base_instructions`:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:108
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:122
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:135
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:157
```

That rewrite is probably ineffective for routed entries cloned from modern native models, because
Codex can ignore `base_instructions` when `model_messages.instructions_template` exists.

There is also uneven proxy-side mitigation:

- OpenAI-compatible chat requests rewrite the first GPT-5 identity line;
- Anthropic and Google pass `systemPrompt` through directly.

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:206
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:10
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts:51
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:13
```

## Practical Policy

For routed entries where `slug.includes("/")`:

```text
delete e.model_messages
```

Expected result:

- Codex falls back to `base_instructions`;
- the existing routed identity rewrite becomes active;
- `supports_personality` becomes false for routed models;
- no OpenAI/GPT/Codex identity leaks through a cloned native template.

Native OpenAI passthrough entries should keep `model_messages`.

## Future Option

Provider-safe personality can come back later through opencodex-owned templates. That should be a
separate feature:

1. create a small routed template independent of upstream GPT wording;
2. keep `{{ personality }}` support;
3. supply all three personality variables;
4. snapshot-test generated catalog entries for identity leaks.

Until then, strip-first is the correct default.
