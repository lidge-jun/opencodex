# ADR-8969: decision recorded under "Google tool-result adjacency repair"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-result-adjacency-repair)
- Purpose: stop Vertex AI from rejecting tool-result images with HTTP 400 ("Requests ending with
  a model turn are not supported") on Gemini 3+ models beyond the three hardcoded Gemini 4 IDs
  (#8969).
- Prior constraint: ADR-7279 and its #8583 amendment limited nested `functionResponse.parts`
  tool-result images to `gemini-4-argon`, `gemini-4-carbon`, and `gemini-4-hydrogen`. With
  Vertex live Publisher Models discovery (#8583), newly surfaced Gemini 4 models such as
  `gemini-4-neon` fell back to sibling `inline_data` parts and hit the same HTTP 400; the same
  error was also observed live on Vertex `gemini-3.8-flash` (2026-10-22) and `gemini-4-neon`
  (2026-11-20, trailing `custom_tool_call_output` with PNG/WebP `input_image` parts).
- Alternatives: keep appending each new model ID to the static allowlist on every Vertex release,
  or enable nesting across every Google transport (including AI Studio and Cloud Code Assist)
  without live evidence. A static list breaks on every newly discovered Gemini 4+ model; broadening
  non-Vertex routes lacks live evidence and conflicts with pinned CCA/AI Studio adjacency tests.
- Choice: match Vertex Gemini 3 and later with `/^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i` for
  `nestToolResultImages`, matching Google's documented multimodal function-response schema for
  Gemini 3+, while keeping AI Studio, Cloud Code Assist, Vertex Gemini 2.x, and non-Gemini Vertex
  models unchanged.
- Consequences: newly live-discovered Vertex Gemini 3+/4+ models automatically receive nested
  `functionResponse.parts` and separated image-bearing orphan turns without per-model code edits.
  Non-Vertex routes remain isolated until equivalent upstream evidence is gathered.
