# 030 — Docs (wp-4)

- `structure/providers/chat-compat.md`: in the opaque-blob recovery paragraph, state that recovery
  covers every adapter whose registry contract resolves to the Responses wire (`openai-responses`
  and its `contractParent` wrappers, today `azure`/`azure-openai`), and that after the destination
  itself rejected foreign opaque state (recovery rebuild and rejection memo) the reasoning item's
  `id` is removed with its blob; a proven route switch alone keeps the id.
- `structure/adapters/registry.md`: note that behaviour keyed to a wire resolves the adapter through
  `effectiveAdapterContract()` / `resolvedAdapterWire()`, with opaque-blob recovery as a consumer.
- `docs-site/src/content/docs/reference/proxy-formats.md` (Encrypted-content hygiene): add a
  troubleshooting paragraph for switching providers mid-conversation, including Azure.
- `docs-site/src/content/docs/reference/adapters.md` `azure-openai` section: one bullet that it
  shares the Responses opaque-state recovery. Translated locales carry no statement about this
  recovery, so none contradicts the English source; they are left for the translation workflow.
