# Text, stream, and reasoning

## Sub-features

- Normal JSON completion
- Stream JSON lifecycle with a final completion
- Advertised reasoning-effort selection

## How to get to it (user POV)

Select an `OpenCodex: ...` custom model in Droid, then run a prompt normally or pass
`--output-format stream-json` and `--reasoning-effort <level>` to `droid exec`.

## Driving it with Droid CLI

Run the full verifier or `--cases text,stream,reasoning`. Proof requires exact marker text, a stream
`system` event, a `completion` event, and the requested effort in the init event.

## Gotchas

A model with no exported effort ladder is `unsupported` for the reasoning case. A successful final
line alone does not prove the stream lifecycle.
