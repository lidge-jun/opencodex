# 100.20 — Model Messages and Personality

## Questions

- What is `model_messages`?
- What is `supports_personality`?
- Does inheriting a native Codex template affect routed model identity?

## Codex RS Behavior

`model_messages` is prompt assembly metadata. It is not display copy. It can contain:

- `instructions_template`
- `instructions_variables`

If `instructions_template` is present, Codex uses it through `ModelInfo::get_model_instructions()`
before falling back to `base_instructions`.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:346
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:446
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:452
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:474
```

`supports_personality` is derived, not a raw field. Codex reports personality support only when:

1. `model_messages` exists;
2. the template contains `{{ personality }}`;
3. all three variables exist:
   - `personality_default`
   - `personality_friendly`
   - `personality_pragmatic`

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:482
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:505
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:553
/tmp/opencodex-codex-src/codex-rs/tui/src/chatwidget/settings.rs:288
/tmp/opencodex-codex-src/codex-rs/tui/src/chatwidget/settings_popups.rs:23
/tmp/opencodex-codex-src/codex-rs/tui/src/chatwidget/input_submission.rs:333
```

## Current opencodex Behavior

Routed entries are cloned from a native template in:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:108
```

For namespaced routed models, opencodex currently rewrites `base_instructions` identity text:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:122
```

It does not rewrite `model_messages.instructions_template`.

## Gap

If a native template includes `model_messages.instructions_template`, Codex may use that template
instead of the rewritten `base_instructions`. That can leak GPT/Codex/OpenAI identity text into
routed models such as Claude, Grok, Gemini, Kimi, OpenRouter, local vLLM, or Ollama.

This also means the Codex personality UI can appear for routed models because the template supports
personality, even though the routed provider identity text was not normalized in the active prompt
template.

## Options

### Option A — Strip `model_messages` for Routed Models

Pros:

- safest identity behavior;
- avoids pretending routed models support Codex-native personality templates;
- simple implementation.

Cons:

- disables `/personality` UX for routed models;
- loses any useful prompt-template scaffolding in Codex native metadata.

### Option B — Rewrite `model_messages.instructions_template`

Pros:

- preserves personality UX;
- keeps Codex prompt assembly structure;
- avoids identity leak if every identity-bearing string is rewritten correctly.

Cons:

- requires careful template-specific rewrite logic;
- templates may change upstream;
- provider-specific model families may need different identity wording.

## Superseded Recommendation

The initial recommendation was to try Option B first if rewrite could be made robust. The follow-up
investigation supersedes that: routed non-OpenAI models should strip `model_messages` first.

See:

```text
/Users/jun/Developer/new/700_projects/opencodex/devlog/100_codex-native-parity/21_model-messages-strip-first.md
```

Reason: `model_messages.instructions_template` is not a cosmetic field. Codex uses it before
`base_instructions`, so the existing routed `base_instructions` rewrite can be bypassed.

Minimum acceptance criteria:

- routed `provider/model` catalog entries must not mention OpenAI/GPT/Codex as the model identity
  unless the provider is native OpenAI passthrough;
- `supports_personality` should be true only when the final prompt template is known to be safe for
  routed providers;
- tests should inspect generated catalog JSON, not only runtime UI output.
