# omo Client Export Dialect

## Scope and policy

`omoClientExport.api` (`OcxConfig.omoClientExport` in `src/types/config.ts`, validated by
`omoClientExportSchema` in `src/config/schema/leaf-validators.ts`) is a config-file-only opt-in for
the managed Pi-based omo block described under
[omo variants](integrations.md#omo-variants). `"openai-responses"` makes `buildPiClientConfig` write
`api: "openai-responses"` for omo. An absent, unknown or malformed value degrades to undefined and
keeps `PI_API_DIALECT` (`openai-completions`), so a bad value never fails the config parse. The
top-level `omoClientExport` field in `src/config/schema/config-schema.ts` adds the outer fallback: a
malformed block (not an object) is dropped as a whole with `.optional().catch(undefined)`.

The scope is omo only. Pi, Gentle Shell and the other Pi-format clients keep `PI_EXPORT_OPTIONS`.

## Export and refresh

`ocx export --client omo` and the managed contribution used by enable and refresh both derive their
options from the live config through `omoExportOptions()` in `src/clients/config-export.ts`, so a
refresh cannot revert the dialect to Chat. The value applies once the proxy has loaded the edited
config and the omo integration is refreshed; a refresh alone does not reload the config file.
Ownership is unchanged: only `providers.opencodex` in `models.json`.

`tests/clients/omo-client.test.ts`, `tests/clients/integrations-writer.test.ts` and
`tests/clients/omo-responses-loop.test.ts` cover the export, the refresh path and a Responses tool
loop.
