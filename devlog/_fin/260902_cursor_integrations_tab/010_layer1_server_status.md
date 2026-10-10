# 010 — Layer 1: cursor detection, last-seen recorder, GET /api/integrations/cursor/status

Branch codex/cursor-integration-status (base origin/dev). PR 1 of 3.

## File map

| Path | Action |
|---|---|
| src/integrations/cursor-detect.ts | NEW — pure detection over injectable fs/platform |
| src/integrations/cursor-seen.ts | NEW — in-memory last-seen recorder |
| src/server/index.ts | MODIFY — raw /v1/models branch: after admission, recordCursorSeen(req.headers) |
| src/server/management/cursor-integration-routes.ts | NEW — GET /api/integrations/cursor/status |
| src/server/management-api.ts | MODIFY — dispatch next to handleNativeIntegrationRoutes |
| src/server/management/route-registry.ts | MODIFY — declare the route (mutates: false) |
| src/cli/capabilities.ts | MODIFY — add to the native-integrations group; bun run skill:surface |
| src/server/models-capabilities.ts | MODIFY — export cursorEffortFamily(id): string[] | null (regex table, values only) |
| tests/cursor-integration-status.test.ts | NEW |

## cursor-detect.ts

    export type CursorBuild = "private-inference" | "regular";
    export interface CursorInstall { build: CursorBuild; path: string; version: string | null }
    export interface CursorDetectDeps { platform: string; homedir: string; env: Record<string, string | undefined>; readText(p: string): string | null; listDir(p: string): string[] }
    export function cursorProductJsonCandidates(deps): string[]
    export function detectCursorInstalls(deps = realDeps()): CursorInstall[]
      // parse each product.json; nameLong "Cursor Private Inference" -> private-inference; "Cursor" -> regular; else skip

## cursor-seen.ts

    export function recordCursorSeen(headers: Headers, now = Date.now()): void   // UA /^Cursor\//
    export function cursorLastSeen(): { at: number; userAgent: string } | null
    export function resetCursorSeenForTests(): void

Only UA prefix + timestamp; no tokens or bodies.

## Route payload

    interface CursorIntegrationStatus {
      privateInference: { installed: boolean; path: string | null; version: string | null };
      regularCursor: { installed: boolean; path: string | null };
      gateway: { baseUrl: string; apiKeyMode: "credential" | "placeholder"; placeholder: string };
      lastSeen: { at: number; userAgent: string } | null;
      models: Array<{ id: string; reasoning: string[] | null; context: { defaultWindow: number; longWindow: number } | null }>;
      guideUrl: string;
    }

- baseUrl: http://127.0.0.1:<readRuntimePort() ?? config.port>/v1
- apiKeyMode: "credential" when isApiAuthRequired(config) (auth-cors.ts:285, non-loopback bind)
  or a credential is configured (configuredApiAuthToken(config) || config.apiKeys?.some(k => k.key.trim())),
  else "placeholder" = "opencodex-loopback". readRuntimePort is src/config/process-state.ts:75
  (returns a state object; use .port) with config.port as fallback.
- capabilities.ts: extend the ["integration","native"] entry's routes with GET
  /api/integrations/cursor/status, then bun run skill:surface so tests/skill-ocx.test.ts passes.
- models: visibleNativeSlugs(config) (metadata.ts:383) for natives plus
  uniqueCatalogModelsForRawPublicList(await fetchAllModels(config)) (aggregation.ts:440) for
  routed rows, public id = alias ?? provider/id — the same two sources the raw list uses.

## Tests

- detect: temp dirs with product.json variants for darwin/win32/linux deps; malformed JSON skipped.
- seen: UA "Cursor/3.18.25" records; "curl" does not; reset works.
- route: startServer(0) + kimi fixture; GET status with admin token -> 200 shape; kimi/k3
  reasoning null; gpt-5.6-sol reasoning [low,medium,high,xhigh], context {272000, 922000};
  after GET /v1/models with UA Cursor/x, lastSeen non-null.
- registry + skill tests pass after declaration/regeneration.
