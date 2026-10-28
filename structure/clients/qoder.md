# Qoder Client Integration

Qoder follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## Qoder settings ownership

Qoder CN is an independent `qoder-cn` client. Its settings live under `QODERCN_CONFIG_DIR`,
defaulting to `~/.qoder-cn`; it shares the Qoder wire schema and fragment ownership, but
never falls back to the Global edition. The edition paths are resolved in
`src/clients/config-export/agent-clients.ts`.


Qoder IDE / qodercli uses JSON at `settings.json` under `QODER_CONFIG_DIR`, default `~/.qoder`;
`qoderHomeDir` resolves that directory once for export, writing and detection, and refuses a
relative or Windows drive-less rooted override through the shared client-path resolver. The Qoder exporter in
`src/clients/config-export/qoder.ts` writes only `providers.opencodex`, with each model's
`displayName` and `contextWindow` in its `models` array. It does not duplicate those keys in
`modelConfigs.customModels`: Qoder rejects the provider when the legacy catalog already
contains its keys. Apply, refresh and disable use the existing recorded-fragment writer;
restore uses its snapshots. On refresh, older ownership records remove their previously
owned custom-model rows before merging the provider-only contribution. Foreign rows remain
untouched, and edits to previously owned rows remain conflicts. The legacy selector template
in `src/integrations/mutation-plan.ts` stays available for previewing that removal.
For both `qoder` and `qoder-cn`, an unowned `modelConfigs.customModels` row with `provider: "opencodex"` and a model the
provider catalog also exports would recreate that rejection, so `classifyIntegration` reports
it as a `conflict` / `unowned-key` before any write; `qoderLegacyCatalogCollision` decides
which rows collide, and rows an ownership record still names are left to the refresh above.
Rows for other providers or other models stay untouched and never conflict.
Because the provider catalog needs no array selector, model IDs containing `,` or `]` are
ordinary Qoder models. The shared reader still reports any contribution that raises
`UnrepresentableSelectorError` as `unsafe` / `unresolvable-path`; preview returns `canApply: false`
and mutations refuse with HTTP 409, so a later selector-bearing fragment cannot fail the whole status collection.

> Decision record: [ADR-7512](../decisions/ADR-7512-qoder-selector-status.md)

> Decision record: [ADR-7390](../decisions/ADR-7390-qoder-legacy-catalog-collision.md)

The default model is the first normalized model; an empty catalog omits the default.
Input limits use authoritative context metadata or Qoder's requested 128000 fallback.
Exports reject non-loopback placeholder use; the writer's existing admission gate protects
apply while permitting cleanup after a bind change. `ocx export --client qoder` asks the live
`/api/client-config` route, like Raycast and Factory Droid, so the serving process's bind and
unauthenticated loopback listener decide the exported URL. Owned-catalog refresh in `ocx sync`,
`/api/sync` and catalog refresh includes Qoder. CLI help, Dashboard export rows, integration
tabs and preview-path validation register the same Qoder client; the managed path templates live in
`src/integrations/mutation-plan.ts` and the builder in `src/clients/config-export/qoder.ts`.

## Qoder assistant-text replay guard

Qoder's assistant text passes through the vendor-scaffolding guard and then the existing `src/lib/tool-envelope-echo-filter.ts` line/fence recognizer.
A replayed tool envelope or an unverified marker released by its bounded fence hold terminates with non-retryable `vendor_scaffold_detected` (502), without publishing that envelope or a later successful terminal; when the marker is recognized only while flushing before an upstream `error` terminal, the envelope is still withheld and that error is forwarded unchanged.
Whole-line result/error markers and tool-call line prefixes are recognized across deltas; ordinary marker prose and closed fenced examples keep the shared recognizer's semantics.
Thinking retains the existing vendor-scaffolding guard. Every non-heartbeat event, including reasoning, ends the current replay-text block.
Held text is settled before reasoning or tool events, which are withheld if that text completes an envelope; the next text block starts with fresh line and fence state.
Pending vendor signatures remain guarded across reasoning boundaries. The adapter records event offsets behind an ambiguous vendor prefix until it is released or suppressed; the queue is limited to 64 Ki characters and 1024 events, and overflow refuses the turn without publishing the held content.
Assistant text retains one trailing high surrogate across nonempty text inputs, preserving pairs split between JSONL frames. A completed scalar precedes events received between its halves; deferred cuts move past the full pair. Heartbeats and empty text do not settle it. Unpaired surrogates become U+FFFD, including a remaining carry at termination, without replacing an upstream error. The carry shares the existing bounded event queue and is cleared on closure.

> Decision record: [ADR-7517](../decisions/ADR-7517-qoder-replay-envelope.md)
