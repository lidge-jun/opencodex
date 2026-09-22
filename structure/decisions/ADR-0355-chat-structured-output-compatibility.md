# ADR-0355 — decision recorded under "Chat structured-output compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#chat-structured-output-compatibility)

## Decision record

- Purpose: Bound Moonshot reference-inlining amplification while retaining the tool schema
  whenever an individual expansion fits.
- Prior constraint: Depth, node, and expansion counts did not bound repeated copies of a
  large referenced value across one tool catalog. The normalizer runs on the request path.
- Alternatives: Keep the three existing bounds; reject the whole serialized request when
  large; or reserve each candidate's copied bytes against one request-shared allowance.
- Choice: Reserve raw target bytes before normalization. Charge nested retained copies once
  and then only additional outer growth. Restore byte, node, and expansion allowances when
  a candidate falls back to a bare reference. Share a 1 MiB allowance across the request.
- Reason: Whole-request rejection happens after allocation and discards independent valid
  tool schemas. A transactional candidate keeps later expansions available.
- Consequences: The bound applies only to Moonshot-family Chat targets. Its validator
  requires an explicit object termination type for recursive unions, so a schema carrying
  properties or additionalProperties, or an allOf with such a member, is emitted with
  `type: "object"`. This narrows scalar instances JSON Schema would permit; tool-argument
  schemas do not rely on them. Non-object allOf compositions remain untyped. Unrelated
  providers keep their schemas.
