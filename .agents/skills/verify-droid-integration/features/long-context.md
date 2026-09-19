# Long context

## Sub-features

- Prompt-file ingestion
- Deterministic context padding
- Recall of markers at both boundaries

## How to get to it (user POV)

Pass a long prompt file to a selected OpenCodex custom model with `droid exec --file <path>`.

## Driving it with Droid CLI

Run `--cases long-context --long-words 20000`. The helper generates model-specific start and end
markers and requires both in the exact final response.

## Gotchas

`--long-words` is a deterministic stress size, not an exact tokenizer count. A timeout is a failure,
not an unsupported result; rerun after Doctor before attributing it to the model.
