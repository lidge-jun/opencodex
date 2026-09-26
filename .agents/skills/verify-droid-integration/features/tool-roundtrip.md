# Tool round trip

## Sub-features

- Read tool definition reaches the model
- Tool call arguments select the marker file
- Droid returns a successful tool result
- The final answer includes content from that result

## How to get to it (user POV)

Run Droid in a repository and ask the selected OpenCodex model to read a file.

## Driving it with Droid CLI

Run `--cases tool`. The helper creates a unique marker file inside the evidence directory and
requires a Read call for that exact path, its matching successful result containing the marker,
and an exact final completion.

## Gotchas

Prompt compliance without a tool event is a failure. The verifier limits available tools to Read so
the proof remains read-only.
