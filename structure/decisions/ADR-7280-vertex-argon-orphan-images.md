# ADR-7280: decision recorded under "Google tool-result adjacency repair"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-result-adjacency-repair)
- Purpose: preserve adjacent orphan images without reopening the Vertex Argon 400 from #7279.
- Prior constraint: ADR-7279 nested matched images, but duplicate or mismatched result images
  still shared their user turn with the function responses. Both cases reproduced the same
  upstream 400; moving the orphan content to a following user turn succeeded.
- Alternatives: discard orphan images, attach them to a matched response, or preserve them in
  a separate turn. The first loses content; the second invents ownership.
- Choice: for Vertex `gemini-4-argon` only, move the entire adjacent orphan batch to a following
  user turn when it contains a representable image. Keep the complete response batch adjacent
  to its calls and preserve the orphan markers, image bytes, and orphan result order.
- Consequences: no history mutation, invented success, configuration or retry. Text-only and
  standalone orphans keep their prior shape; other Google routes are unchanged. The existing
  Vertex regression file covers duplicates, mismatches, missing results and route isolation.
