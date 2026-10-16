# Cline source contract

Upstream revision: cline/cline cfe9cadab99617d5013bf89f07b079d105057791, read 2026-09-12. Scope is the current CLI/shared SDK provider store. Legacy VS Code globalState/secrets storage is not the same contract and is not detected as compatible.

- sdk/packages/shared/src/storage/paths.ts:152-185,424-430 resolves CLINE_PROVIDER_SETTINGS_PATH; otherwise CLINE_DATA_DIR/settings/providers.json; otherwise CLINE_DIR/data/settings/providers.json; otherwise ~/.cline/data/settings/providers.json. Relative overrides are rejected by OpenCodex because its cwd is not Cline's cwd.
- sdk/packages/core/src/types/provider-settings.ts:33-68 defines version=1, optional lastUsedProvider, modes={}, providers[id]={settings,updatedAt,tokenSource}. settings.provider is the provider ID; protocol openai-responses, client openai, baseUrl, apiKey and model are accepted.
- sdk/packages/core/src/services/llms/provider-settings.ts:155-199,224-315 maps protocol openai-responses to the OpenAI handler while retaining the custom provider ID and namespaced model.
- sdk/packages/core/src/services/providers/local-provider-registry.ts:48-121 defines sibling models.json: version=1, providers[id]={provider:{name,baseUrl,protocol,client,defaultModelId},models:{id:{name,contextWindow,modalities,supportsVision}}}.
- The same file:689-716 caches model-file loading per process. Restart Cline after external updates; do not claim a running picker is live-synchronized.

CLINE-D09 accepted: settings.modelCatalog.url is not an OpenAI /v1/models endpoint. Its loader expects models.dev data, and picker paths do not forward that setting. A single providers.json does not meet full catalog acceptance.
CLINE-D10 accepted: write providers.json plus sibling models.json as one recoverable journal operation. Each rename is atomic; a filesystem has no atomic rename across both files. Stop Cline before apply/refresh/restore and restart after. Interrupted writes require durable recovery and foreign edits must refuse recovery.

All paths above are pinned under https://github.com/cline/cline/blob/cfe9cadab99617d5013bf89f07b079d105057791/ . No upstream implementation is copied; schema-shaped fixtures use synthetic data. No original carry PR or author credit applies. #3833 is a Command Code reference, not a dependency.
