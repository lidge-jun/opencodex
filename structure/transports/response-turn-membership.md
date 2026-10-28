# Structural turn replay membership

`src/server/responses/turn-membership.ts` enables structural replay normalization
only with explicit embedding-shell `OPENCODEX_RESPONSE_TURN_SIGNING_KEY` material,
an admitted request, a separately verified dedicated local API credential and an
explicit own `thread-id` header. Parent-thread and session/cache cohorts do not qualify.
`src/server/auth-cors.ts` derives the structural principal with the signing key;
its existing process-local context principal and provider-opaque state ownership
remain unchanged. A different credential or signing key starts a different scope.

`src/responses/turn-membership.ts` verifies versioned item IDs bound to that caller,
thread, turn nonce, item kind and ordinal. IDs prove structural grouping only:
they do not authenticate payload bytes, completion, execution permission or vendor
metadata. `src/server/responses/request-prepare.ts` applies the pass before `parseRequest`. It keeps unique
real results and forms the buffered semantic-items/calls/results ordering only
for authenticated closed spans. Invalid signed groups leave the entire input
unchanged. The codec copies supplied key bytes independently of typed-array subclasses,
so clearing a caller-owned Buffer does not mutate the signing key. No key is generated, restored from customer history or written to disk.
The absent/malformed-key default changes no input. The pass uses bounded linear
indexing with at most 65,536 input items and retains existing item references.

`tests/responses/turn-membership.test.ts` covers token and scope controls;
`tests/responses/turn-membership-ingress.test.ts` proves actual ingress-to-supplier
request equality against the buffered reference and refusal of keyless ownership.
`src/server/responses/adapter-delivery.ts` passes a per-response item-ID factory into
`src/bridge/sse.ts` only for the negotiated canonical Chat streaming path. Each message,
reasoning, function, custom, or client tool-search item receives its identity at creation;
all later frames and the final output retain that identity. Hosted-search cell IDs,
Anthropic progress carriers, compaction, native and sidecar output retain their existing owners.
Client tool-search membership requires a client-executed call with object arguments and one
matching client output with a tools array; missing, wrong or duplicate results refuse normalization.

The trusted `completedToolBlocks` build metadata is set only for authenticated own-thread
streaming Responses requests with durable membership and without compaction. It reaches initial,
retry and queued rebuilds through `src/server/responses/adapter-dispatch.ts` and
`src/server/responses/request-transport.ts`; missing metadata keeps earlier tool delivery off.
This structural mechanism does not alter supplier bodies, reasoning effort, retry policy,
settlement or provider-opaque replay scope.
