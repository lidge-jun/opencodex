# Search Data Plane

The Responses sidecar parser in `src/web-search/parse.ts` closes collection at the first terminal event or `[DONE]`. Later frames in that network chunk cannot change text, sources, error state or decoded accounting. `tests/web-search/web-search-eof.test.ts` checks this with whole and fragmented bodies.

The opt-in key-auth Responses hosted-search bridge follows the
[continuation binding contract](../providers-and-adapters.md#hosted-search-continuation-binding).
`src/web-search/loop.ts` follows [prepaid initial sends](../transports/responses-spend.md#prepaid-initial-sends)
for Combo child inference: generic HTTP/WS reports physical dispatch; fetchResponse receives the
live adapter budget instead. Initial headers are acquired before Response return, so unsent failures
remain with ingress cleanup. RunTurn search retains its ordinary producer owner; standalone search
and direct callers keep their existing behavior.

On Responses, RunTurn and passthrough-bridge requests, Anthropic helper queries also use the request's
[auxiliary inference admission](../transports/responses-spend.md#auxiliary-search-inference).
Each physical attempt consumes shared capacity without spending the routed model's recovery grant.

Final client tool output after hosted search follows the [explicit empty client-catalog boundary](../transports/responses-wire-shapes.md#declared-tool-membership-by-inbound-wire), before client delivery or continuation state. Internal search execution retains its existing behavior.

When the [Advisor sidecar](../advisor.md#execution-paths) is enabled for a fetch-based search turn,
the same scanner consumes synthetic `web_search` and `advisor` calls in worker order. Both result
types remain internal, real client tools retain terminal ownership, and the shared Advisor bounds
apply without spending the web-search allowance. RunTurn search remains preflight-only for Advisor.

## Serving the relay without ChatGPT auth

`POST /v1/alpha/search` first resolves a non-empty body `model` with `previewRouteModel()`. A route whose
effective adapter is `devin` uses `src/web-search/devin-executor.ts` and the active Devin OAuth
snapshot to call Cognition's non-inference `GetWebSearchResults` RPC. The account snapshot supplies
both the credential and its allowlisted tenant URL; the request rejects redirects and bounds timeout
and response bytes. This decision uses the resolved route, not a model-name family, so current and
future Devin-hosted model ids share the path without a model table. A round-robin preview copies
its selection state instead of claiming or advancing the turn's sticky slot. The RPC receives the
search query but no model id, and its decoded results return in the normal
`{ encrypted_output: null, output, results }` envelope. A configured key's destination scope is
checked against that resolved provider/model before dispatch.

Other requests relay verbatim through a configured ChatGPT forward provider. When no
forward candidate exists, an explicitly configured `webSearchSidecar.backend` of `anthropic`,
`xai`, `gemini`, or `exa` serves the request instead, spending only that backend's own
credential: `src/web-search/alpha-search.ts` runs the query through that backend's executor and
answers `{ encrypted_output: null, output, results }`. An unset or `openai` backend and a sidecar
disabled by `enabled: false` keep the ChatGPT-auth 400. A named backend whose credential is
missing is refused as well, but the message names that backend and the credential it could not
find instead of asking for ChatGPT auth, and the request reaches no other backend. A backend that
fails answers with its own diagnostic. The fallback never runs while a forward candidate exists,
so the verbatim relay stays the path for a ChatGPT deployment.

A configured key's scope covers both branches, each against what it actually reaches. An
account-qualified selector is judged against its resolved route; an unqualified one against the
account the upstream resolved and the model the body names; the fallback against the configured
backend and the model that backend runs, with Exa named by its backend because it has no provider
entry. `tests/server/api-key-scope-alpha-search.test.ts` covers the two unrouted branches.

## Standalone Search and exact account selectors

`POST /v1/alpha/search` retains the selected model in its request body. When that value is an
account-qualified native selector, the server resolves the public namespace, uses only the mapped
stored Codex credential, and sends the bare native model upstream. That exact path is fail-closed:
it does not consult Pool active state or affinity when selecting, and its outcomes cannot rotate
the active Pool account. An account-wide credential failure still quarantines that credential and
clears stale ordinary Pool affinities so they cannot reappear after reauthentication. Quota and
transient outcomes from an exact request leave Pool affinities untouched. Ordinary search requests
keep the normal Direct/Pool sidecar behavior.

Standalone Images and Live requests currently carry neither the account-qualified model selector
nor a trustworthy thread correlation from the Codex client. They therefore retain normal provider
routing. Do not infer an exact account from caller-supplied account headers, process-global last
selection, connection identity, or other ambient state; concurrent threads could cross-route
credentials. Extending exact routing to those endpoints requires an opaque client correlation that
can be bound server-side to a previously validated selector.

The Responses sidecar parser in `src/web-search/parse.ts` checks runtime field shapes before consuming events: non-string types, non-array output/annotations, null content entries and `output_text` blocks whose text is not a string cannot throw away accumulated text. Streamed text is assembled per content part (`output_index`, `content_index`) in index order: each part contributes its done text, or its deltas when its done event never arrived, so one part's done text cannot discard another part's deltas. Matching item IDs reconcile indexed and unindexed snapshots, while distinct item IDs, output indexes and known content indexes remain separate. A part accumulates compatible identity fields across events and gains a positional key when available; an occupied incompatible key never overwrites another part. An output-only identity matches a fully indexed part when it is the unique compatible part for that output; a content-only part can gain an item or output identity without duplication, and earlier content-only siblings retain their relative position when that part gains an index. An indexed event without an item ID also reconciles a uniquely matching unpositioned part with a compatible content index, including an item-only draft; multiple compatible candidates or competing parts at the output position remain separate. A later full snapshot carrying both identities reconciles a unique item draft and previously ambiguous indexed snapshot, including when an earlier delta already gave the draft that position; a competing third part at the position prevents the merge. Request-local identity indexes avoid scanning accumulated parts on each event. Parts with known output indexes are assembled in output order even if an identity conflict prevents a positional key, with unknown content positions after known siblings; other parts retain arrival order. When the completed output skipped a malformed entry, its text may be partial: completed item IDs, including those on output-text blocks with malformed text, reconcile uniquely matching unindexed streamed parts at their completed positions. A uniquely streamed output-only part also matches a compatible completed item with exactly one content entry; conflicting item IDs or multiple content entries prevent that inference. An indexed streamed part with a conflicting completed item ID remains separate from that completed slot. An anonymous completed slot also leaves competing compatible streamed parts separate; a completed item ID can identify its own part while preserving an anonymous competitor. Indexed and output-only parts fill missing completed output while separate ambiguous parts are retained. An unindexed part with no content index is matched only when the completed item has one content entry; without an identifiable or indexed match, a wholly unindexed stream replaces the partial output as a whole. The completed output's citations are kept either way. Failure messages remain nonblank strings; malformed, empty or whitespace-only message values use the existing terminal diagnostic.

Each part's `response.output_text.done` is a full-text snapshot: the latest snapshot, including empty or whitespace-only text, replaces the earlier one instead of being concatenated or restoring deltas. A linking snapshot joins a unique identified draft and anonymous output snapshot when either omits its content index; a competing position or conflicting identity prevents that inference. Bucket sizes bound the work before candidates are inspected. Assembly emits each retained map entry once, including content-key parts that acquired a position and conflicts retained beside partial completed output. Distinct parts retain their index ordering, completed output remains authoritative, and every received snapshot still counts toward the decoded-payload ceiling. `tests/web-search/fix-search-frame-shapes.test.ts` covers repeated snapshots, identity transitions, bounded lookup and incomplete-output fallback.

The parser accepts CR, LF and CRLF line endings, including mixed endings and CRLF split across chunks. At clean response-body EOF, it consumes a final `data:` line even without its trailing newline. The same event handler owns completion, failure, citations and decoded-text accounting for that line; EOF alone is not completion. A byte-limit stop or failed read does not flush the pending line. `tests/web-search/web-search-eof.test.ts` covers line endings, immediate terminal cancellation, EOF behavior and its limit boundaries.

Trailing source extraction in `src/web-search/parse.ts` pairs a pending title with a following URL only when the URL sits on an unmarked continuation line with no title of its own. A list item that cannot be paired, because another list item, a self-titled citation, or a URL that starts its own list item follows it, remains answer text, and extraction continues, so every later citation line, including one whose URL `appendSafeWebSearchSource` rejects, still leaves the answer. Non-HTTP URI-like text inside an inline code span of any backtick run, such as `mode:fast`, is not treated as a citation; an HTTP(S) URL is a citation even when code-formatted, and a closing code backtick is trimmed from it. Code spans are found by pairing backtick runs in one pass and the URI scheme length is bounded, so a long Sources line is scanned in linear time.

Completed-output citations are deduplicated independently of streaming annotations, so an earlier copy of a URL cannot hide its final title. A safe final title takes precedence; when none exists, a safe streamed title for that URL is retained. Final sources are merged before streaming-only sources, with the existing count and byte limits applied to the merged records. `tests/web-search/web-search-sources.test.ts` covers metadata precedence, fallback, ordering and sanitization.

Single-result query and answer truncation in `src/web-search/format-result.ts` uses the same surrogate-safe prefix as batched results. The existing UTF-16 limits and truncation markers remain unchanged.
