# ADR-7279: decision recorded under "Google tool-result adjacency repair"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-result-adjacency-repair)
- Purpose: allow Vertex `gemini-4-argon` to continue after a tool returns an image (#7279).
- Prior constraint: tool images were sibling `inline_data` parts beside `functionResponse`.
  A synthetic live request ending in `user` still received HTTP 400, "Requests ending with
  a model turn are not supported"; adding final user text did not repair it.
- Alternatives: discard images, move them to a separate user turn, or nest them inside the
  response. Discarding loses information; separate turns obscure ownership in parallel results.
- Choice: nest matched result images in `functionResponse.parts` only for Vertex
  `gemini-4-argon`, preserving the existing text, IDs, names, order and image bytes. The nested
  synthetic request succeeded and reported IMAGE input tokens. Other routes retain their existing
  representation because this incompatibility was reproduced only on Vertex Argon.
- Consequences: no new configuration, retry or shared-history mutation. Orphan results still
  degrade to marked text and sibling images; existing adjacency and thought-signature repairs
  remain intact. Revisit the model scope when another route has equivalent upstream evidence.
- Amendment (#8583, 2026-11-13): the scope now also covers Vertex `gemini-4-carbon` and
  `gemini-4-hydrogen`. The 400 was not reproduced on those models; the maintainer accepted the
  extension because `functionResponse.parts` is the documented multimodal function-response form
  for Gemini 3 and later, so the nested shape is valid input for them, and the PR author ran both
  models live on Vertex. Other routes are unchanged.
- Amendment (2026-11-20): the same Vertex HTTP 400 (`Requests ending with a model turn are not
  supported`) was reproduced live on Vertex AI with `gemini-4-neon` (2026-11-20, trailing
  `custom_tool_call_output` with PNG/WebP `input_image` parts) and `gemini-3.8-flash`
  (2026-10-22). The Vertex scope now matches Gemini 3 and later (`/^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i`)
  instead of a fixed model list so live-discovered Vertex Gemini 3+/4+ models receive the
  documented nested `functionResponse.parts` layout automatically. AI Studio, Cloud Code Assist,
  Vertex Gemini 2.x, and non-Gemini Vertex models retain their existing representation.
