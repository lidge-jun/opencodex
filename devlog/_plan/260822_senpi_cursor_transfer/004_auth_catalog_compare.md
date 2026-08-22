# 004 — Auth / catalog / effort / max-mode

Planck + Archimedes.

## Auth — ALREADY-HAVE

Same three URLs and PKCE params (`challenge`, `uuid`, `mode=login`, `redirectTarget=cli`).

OpenCodex `src/oauth/cursor.ts:13-15, 78-85`. senpi [oauth/cursor.ts L17-19, L123-130](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/auth/oauth/cursor.ts#L17-L19).

Delta worth a small adapt: senpi fail-fasts poll 400/401/403/410 and does not spend the transient budget on 429. OpenCodex retries any non-ok as consecutive errors up to 3 (`src/oauth/cursor.ts:121-148`). OpenCodex-only keepers: JWT `sub`/`email` multiauth, 15s refresh timeout, 429/5xx refresh retry.

Login catalog refresh: senpi auto `fetchModels` after `/login cursor`. OpenCodex clears model cache and tells the operator to `ocx sync` (`src/oauth/index.ts:1234`, `src/oauth/login-cli.ts:95`).

## Catalog — different-shape

OpenCodex: static seed + live id filter + `stripCursorWirePrefix` (`discovery.ts:67-84`). Decode keeps ids only (`live-models.ts:4-6`). Empty 0-byte GetUsableModels body is a Bun HTTP/2 requirement (`live-models.ts:12-14`).

senpi: no static baseline; live GetUsableModels is the catalog; grouping produces `thinkingLevelMap` / `cursorReasoning` / `legacyAliases` ([providers/cursor.ts L10-17](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/providers/cursor.ts#L10-L17), [catalog-grouping.ts L19-31](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/cursor/catalog-grouping.ts#L19-L31)). Decode keeps `maxMode`, display name, `thinkingDetails` ([cursor-agent.ts L4354-4369](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L4354-L4369)).

## Effort / max-mode

OpenCodex flattens Codex effort onto a static suffix table (`effort-map.ts:96-108`). Grok Fast is parameterized (`request-builder.ts:182-204`). `RequestedModel.maxMode` is always `false` (`protobuf-request.ts:963-966`; the 934-937 window is debug logging, not maxMode).

senpi copies live `cursorMaxMode` onto the wire ([reasoning-params.ts L8-20](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent/reasoning-params.ts#L8-L20)). Family-specific parameters (Claude thinking/context/effort, GPT extra-high, etc.) come from a captured AvailableModels capability table, not from GetUsableModels fields.

## Transfer suspicion

Medium-high: honor live `maxMode` instead of hardcoding false (proto field already exists at `gen/agent_pb.ts:2617`). Medium: fail-fast OAuth poll. Low/product: replace static seed with fully dynamic catalog (OpenCodex still needs logged-out fallback and `auto-{cost,balance,intelligence}` router ids). Do not copy senpi's 204-id alias JSON wholesale.
