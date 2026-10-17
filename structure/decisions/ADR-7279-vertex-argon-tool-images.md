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
