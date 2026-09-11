# Raycast Custom Providers integration — plan

Raycast (Pro-only) reads `~/.config/raycast/ai/providers.yaml` and watches it, so a
file-toggle client is the right shape. Spec: https://manual.raycast.com/ai/custom-providers.

Decisions taken with the maintainer:

1. Install signal is `~/.config/raycast/ai` (the directory Raycast creates on
   "Reveal Providers Config"), not `Raycast.app`.
2. A non-Pro plan is a warning in status/GUI, never a refusal.
3. Every exported model declares `tools: supported: true` (same stance as Hermes:
   every routed model is tool-capable).
4. Array ownership goes into the shared merge/classifier layer as a path-segment
   selector rather than a Raycast-only patcher. `structure/09_client-integrations.md`
   forbids a special case that lives only in the writer or only in status; a
   selector segment that `readPath`/`setPath`/`deletePath` all understand is the
   one way both keep agreeing.

## Raycast file shape

```yaml
providers:
  - id: opencodex            # <- our one owned sequence item
    name: OpenCodex
    base_url: http://127.0.0.1:10100/v1
    models:
      - id: anthropic/claude-opus-5
        name: Claude Opus 5
        context: 200000
        abilities:
          temperature: { supported: true }
          vision: { supported: true }
          system_message: { supported: true }
          tools: { supported: true }
          reasoning_effort: { supported: false }
```

No `api_keys`: loopback is unauthenticated and the file has no env interpolation,
so the client is `loopbackOnly: true`.

## Pro signal (macOS)

`defaults read com.raycast.macos.v1 subscriptions_active` → `1` / `0`. Read via
`Bun.spawnSync`, not by parsing the binary plist (cfprefsd caches). Windows: `unknown`.

## Work packages (disjoint files, run in parallel)

| WP | Files |
|---|---|
| 1 merge selector | `src/integrations/merge.ts`, `src/integrations/state.ts`, `tests/integrations-merge.test.ts` |
| 2 client | `src/clients/config-export.ts`, `src/integrations/registry.ts`, `src/cli/registry.ts`, `src/cli/help.ts`, `tests/raycast-client.test.ts`, list-assertion tests |
| 3 sync fan-out | `src/integrations/owned-refresh.ts`, `src/cli/dispatch.ts`, `src/server/management/config-routes.ts`, `src/cli/index.ts`, `tests/sync-client-integrations.test.ts` |
| 4 detect + API + GUI | `src/integrations/raycast-detect.ts`, `src/server/management/integration-routes.ts`, `src/cli/integrations.ts`, `gui/**`, i18n |
| 5 docs | `docs-site/**` |

### WP1 — `[field=value]` path segment

```ts
// merge.ts
const ARRAY_SELECTOR = /^\[([A-Za-z_][A-Za-z0-9_]*)=([^\]]+)\]$/u;
export type PathSegment = { kind: "key"; key: string } | { kind: "select"; field: string; value: string };
export function parseSegment(raw: string): PathSegment;
export class AmbiguousSelectorError extends Error {}
```

- `setPath`: a `select` segment addresses the element of an array whose
  `item[field] === value`. Missing parent → `[]` is created (recorded by
  `createdContainerPaths`). Match found → replace in place; none → push; ≥2 →
  throw `AmbiguousSelectorError` (writer maps it to `unsafe` alongside
  `UnserializableValueError`).
- `deletePath`: splice the match; an emptied array we created is pruned by the
  existing `createdContainers` walk.
- `state.ts readPath`: `select` → `Array.prototype.find`. Because the classifier
  and the writer share this one function, status and mutation cannot disagree.
- `blockedContainerPath`: a non-array, non-undefined value where a `select`
  segment expects an array is blocked (`providers: {}` written by the user).
- `createdContainerPaths`: unchanged join rule; a `select` segment is never a
  container prefix on its own.
- A key-only path is byte-for-byte the old behaviour; the twelve existing clients
  do not change.

### WP2 — client registration

`config-export.ts`: `"raycast"` in `ExportClientId`; `raycastAiDir(env, home)` =
`join(home, ".config", "raycast", "ai")` (Raycast ignores XDG; same path on Windows);
`raycastConfigPath` = `…/providers.yaml`; types `RaycastAbility`,
`RaycastModelEntry`, `RaycastProviderEntry`, `RaycastGeneratedConfig`;
`buildRaycastClientConfig(ctx)` over `normalizeExportModels(ctx.models)` with
`exportModelLabel(model)` as `name`, `contextWindow` → `context`, abilities:
`temperature: !(reasoningEfforts?.length)`, `vision: inputModalities?.includes("image") ?? false`,
`system_message: true`, `tools: true`, `reasoning_effort: (reasoningEfforts?.length ?? 0) > 0`.
`buildRaycastContribution` = `singleFragment("raycast", ["providers", "[id=opencodex]"], providers[0])`.
`summarizeRaycast` finds the `opencodex` item. `EXPORT_CLIENTS.raycast`:
`filename: "raycast-providers.yaml"`, `format: "yaml"`, `apiKeyEnv: ""`, `loopbackOnly: true`.

`registry.ts`: `configPath: raycastConfigPath`, `detectDir: raycastAiDir`, no
`sourcePreservingYaml` (that patcher handles block-map leaves only), no `writerLock`.

### WP3 — sync fan-out

Raycast joins the shared `refreshOwnedCatalogIntegrations` coordinator. Model
selection changes use its default `["pi", "aside", "raycast"]` set;
`POST /api/sync` uses `["mcode", "pi", "aside", "raycast"]`; direct CLI sync
updates `["mcode", "pi", "raycast"]` locally and keeps Aside behind its
server-owned multi-profile route. Startup and ensure refresh the owned Raycast
catalog after the Codex catalog publishes, using the live port.

### WP4 — detection, API, GUI

`raycast-detect.ts` mirrors `cursor-detect.ts` (injectable deps, read-only):
`RaycastPlan = "pro" | "free" | "unknown"`, `detectRaycast(deps)` →
`{ appPath, aiDirPresent, plan }`. `GET /api/client-integrations/raycast`
adds `raycast: { plan, appPath, aiDirPresent }` to the envelope (only for this
client). `ocx integration client status --client raycast` prints `plan`. GUI:
every surface in `devlog/_fin/260831_aside_client_and_integrations_ux/002_registration_checklist.md`
plus one `RaycastPlanNotice` shown when `plan !== "pro"` or `!aiDirPresent`.

### WP5 — docs

`guides/integrations.md` row + paragraph (Pro, reveal-first), `reference/cli/agents.md`,
translated locales, `bun run build` in `docs-site`.
