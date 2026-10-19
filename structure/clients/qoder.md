# Qoder Client Integration

Qoder follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## Qoder settings ownership

Qoder IDE / qodercli uses JSON at `settings.json` under `QODER_CONFIG_DIR`, default `~/.qoder`;
`qoderHomeDir` resolves that directory once for export, writing and detection, and refuses a
relative override. The Qoder exporter in
`src/clients/config-export/qoder.ts` writes only `providers.opencodex`, with each model's
`displayName` and `contextWindow` in its `models` array. It does not duplicate those keys in
`modelConfigs.customModels`: Qoder rejects the provider when the legacy catalog already
contains its keys. Apply, refresh and disable use the existing recorded-fragment writer;
restore uses its snapshots. On refresh, older ownership records remove their previously
owned custom-model rows before merging the provider-only contribution. Foreign rows remain
untouched, and edits to previously owned rows remain conflicts. The legacy selector template
in `src/integrations/mutation-plan.ts` stays available for previewing that removal.
The default model is the first normalized model; an empty catalog omits the default.
Input limits use authoritative context metadata or Qoder's requested 128000 fallback.
Exports reject non-loopback placeholder use; the writer's existing admission gate protects
apply while permitting cleanup after a bind change. `ocx export --client qoder` asks the live
`/api/client-config` route, like Raycast and Factory Droid, so the serving process's bind and
unauthenticated loopback listener decide the exported URL. Owned-catalog refresh in `ocx sync`,
`/api/sync` and catalog refresh includes Qoder. CLI help, Dashboard export rows, integration
tabs and preview-path validation register the same Qoder client; the managed path templates live in
`src/integrations/mutation-plan.ts` and the builder in `src/clients/config-export/qoder.ts`.
