# Phase 3 — Web-search sources/citations to GUI

Problem: the Codex desktop app renders a "Sources" chip + inline citations on the
assistant message after a web search. Our proxy already parses `url_citation` from the
sidecar into `outcome.sources` (url+title), but it only feeds them into the toolResult
text via `formatWebSearchResults`. The final assistant message always emits
`output_text.annotations: []`, so the GUI never receives citations.

Decision (user): normalize to the APP wire shape — `output_text.annotations[]` carrying
`url_citation` entries. codex-rs (TUI) ignores annotations today, so this is additive and
TUI is unaffected; the desktop app reads the annotations to draw the Sources chip.

## Wire shape (OpenAI Responses standard)

```json
{
  "type": "output_text",
  "text": "...answer...",
  "annotations": [
    { "type": "url_citation", "url": "https://...", "title": "Node.js Releases", "start_index": 0, "end_index": 0 }
  ]
}
```

## Change map (IN scope)

1. `src/types.ts`: add `OcxUrlCitation { url; title? }` and carry it on the search-end
   event: `web_search_call_end.sources?: OcxUrlCitation[]`.
2. `src/web-search/loop.ts runSearchCall`: dedupe `outcome.sources` across the batch's
   queries and attach them to the `web_search_call_end` event.
3. `src/bridge.ts` (streaming): keep `pendingWebSources` accumulated from
   `web_search_call_end`; when the next assistant message closes, emit its
   `output_text.annotations` as `url_citation[]` (content_part.done + output_item.done).
   Clear after attaching so they bind to exactly one message.
4. `src/bridge.ts buildResponseJSON` (non-streaming): same accumulation, attach in
   `flushText()`.

## OUT of scope
- Inline char-range citations (start/end index point into text). We emit index 0/0; the
  app shows the Sources chip from url/title. parse.ts already drops start/end indices.
- Changing the toolResult text format (the model still gets sources in-text).

## Accept criteria
- After a real search, the assistant message's `output_text.annotations` contains one
  `url_citation` per unique source (url+title), in both streaming and non-streaming paths.
- A turn with no search (or a failed/empty search with no sources) emits `annotations: []`
  exactly as before (no regression).
- Sources bind to the FIRST assistant message after the search, then the buffer clears.
