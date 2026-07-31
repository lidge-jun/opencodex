# 030 — WP3: Grok per-model selection state, sync filter, management API

No dependency on WP1/WP2; this is the backend half of the Grok switch. Audit
fold-backs (blockers 1, 2, 3) come from `001_audit_synthesis.md`.

## The writer boundary, stated precisely

`src/grok/inject.ts:186-207` refuses to auto-register for non-loopback binds, and the
comment there records why: a regenerated block cannot carry the admission token without
either writing the user's secret into `~/.grok/config.toml` or leaving `env_key` to fall
through to grok's own xAI session credential. `injectGrokConfig` also owns backup,
byte-for-byte user-content preservation, EOL detection, orphaned-marker refusal and
alias reservation. Re-implementing any of that behind an HTTP route would widen the blast
radius of a web-reachable surface.

So the rule is not "the management API performs no write" — the apply route below does
reach `atomicWriteFile` through `injectGrokConfig` (`src/grok/inject.ts:238`), and
pretending otherwise would be a guard that cannot fail. The rule is:

> **`injectGrokConfig` remains the single writer of `~/.grok/config.toml`. No new code
> path writes that file, and the HTTP surface may only ask the existing writer to run
> against the persisted config.**

**Threat model for `POST /api/grok/apply`.** The route sits behind the same boundary as
`POST /api/claude-desktop/apply`: API auth runs before management routing
(`src/server/index.ts:344-348`) and origin is checked in `handleManagementAPI`
(`src/server/management-api.ts:82-92`). Beyond that it is deliberately input-free:

| Input | Source | Attacker influence |
|-------|--------|--------------------|
| model list | catalog + `config.grokExcludedModels` | only via the audited selection route |
| target path | `resolveGrokHome()` inside the writer | none |
| port / hostname | runtime-port record (below) | none |
| request body | ignored entirely | none |

The worst an authenticated same-origin caller can do is re-run the sync that
`ocx start` / `ensure` / `restart` already run unprompted.

**Concurrency.** Two clicks must not interleave two read-modify-write cycles over one
file. The route serializes through a module-level chain:

```ts
let grokApplyChain: Promise<unknown> = Promise.resolve();
/** Serializes applies: injectGrokConfig is read-modify-write over a single file. */
function queueGrokApply<T>(run: () => Promise<T>): Promise<T> {
  const next = grokApplyChain.then(run, run);
  grokApplyChain = next.catch(() => {});
  return next;
}
```

## NEW config field — `src/types.ts`

Next to the other top-level toggles (near `subagentModelFallbackPollMs`, `:483-487`):

```ts
  /**
   * Model ids the user has EXCLUDED from the Grok Build managed block. Absent or empty
   * means "everything visible", which is the historical behaviour — so an existing
   * config keeps the fence it already had.
   *
   * Exclusion list rather than an inclusion list on purpose: a newly added provider
   * model should appear in Grok by default, exactly as it does today. An inclusion list
   * would silently hide every future model behind a switch nobody knew to flip.
   */
  grokExcludedModels?: string[];
```

`configSchema` (`src/config.ts:480-493`) is `.passthrough()`, so an unknown key already
survives a round-trip; adding an explicit `z.array(z.string()).optional()` entry makes
the contract intentional and gives a bad hand-edit a real parse error instead of a
silent pass. Add it to the schema object in the same commit.

## Alias stability — why a plain filter is wrong

`buildGrokManagedBlock` allocates aliases with a collision counter over the list it is
handed, plus reservations for user-owned `[model.*]` tables
(`src/grok/inject.ts:130-165`). Dropping an entry BEFORE the builder sees it therefore
renumbers its colliding successors: with `kimi/k3` and `kimi-k3` both sanitizing to
`ocx-kimi-k3`, switching the first one off silently renames the second from
`ocx-kimi-k3-2` to `ocx-kimi-k3` — renaming a name the user already typed into grok.
Order preservation alone does not prevent this (audit blocker 3).

Fix: allocate aliases over the **unfiltered** list and skip only the emission.

### MODIFY — `src/grok/inject.ts`

```diff
-export function buildGrokManagedBlock(port: number, models: GrokInjectModel[], hostname?: string, reservedAliases?: ReadonlySet<string>): string {
+export function buildGrokManagedBlock(
+  port: number,
+  models: GrokInjectModel[],
+  hostname?: string,
+  reservedAliases?: ReadonlySet<string>,
+  /**
+   * Ids to allocate an alias for but NOT emit. Alias numbering must not depend on which
+   * models the user switched off, or excluding one colliding model would rename another
+   * model's alias out from under a grok config that already uses it.
+   */
+  excluded?: ReadonlySet<string>,
+): string {
```

Inside the loop, immediately after `taken.add(alias)`:

```diff
+    if (excluded?.has(model.id)) continue;   // slot consumed, table not written
```

`isFirst` derives from `lines.length === 1`, which stays correct: a skipped model adds
no lines, so the first EMITTED table is still the one that omits the leading blank line.
`injectGrokConfig` grows the same optional field on its `opts` and forwards it.

### MODIFY — `src/grok/sync.ts`

```diff
   const routed = filterCatalogVisibleModels(await deps.fetchAllModels(config), config);
   models = [ /* natives */, /* routed */ ];
 } catch (err) { ... }
-return deps.injectGrokConfig(port, models, { hostname, grokHome });
+// Pass the FULL list plus the exclusion set: the writer allocates aliases over
+// everything and emits only what is switched on, so a model's alias never depends on
+// its neighbours' switches. Absent/empty selection keeps today's behaviour exactly.
+return deps.injectGrokConfig(port, models, {
+  ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
+  ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}),
+  excluded: new Set(config.grokExcludedModels ?? []),
+});
```

Edge case handled, not discovered later: excluding EVERY model emits a fence with the
two markers and no `[model.` table. That is a valid "registered nothing" state, and
`stripGrokConfig` still removes it cleanly. The route rejects nothing on this basis;
the UI warns.

## NEW routes — `src/server/management/agent-settings-routes.ts`

Beside the existing read-only `GET /api/grok` (`:388-396`).

### `GET /api/grok` — extended payload

```diff
   if (url.pathname === "/api/grok" && req.method === "GET") {
     try {
       const { readGrokStatus } = await import("../../grok/status");
-      return jsonResponse(readGrokStatus());
+      const { fetchGrokCandidateModels } = await import("./shared");
+      // `candidates` is the full visible catalog the fence WOULD carry, so the page can
+      // show a switch for a model the user has already excluded (it is absent from the
+      // fence, so `status.models` alone could never list it). The page pairs each
+      // candidate with the alias from `status.models` and renders "—" when there is
+      // none: aliases are the WRITER's output and are never guessed client-side
+      // (audit blocker 3).
+      return jsonResponse({
+        ...readGrokStatus(),
+        candidates: await fetchGrokCandidateModels(config),
+        excluded: config.grokExcludedModels ?? [],
+      });
     } catch (error) { ... }
   }
```

`fetchGrokCandidateModels` is a NEW helper in `src/server/management/shared.ts`,
built from the same two sources `syncGrokConfig` uses so the two can never disagree:

```ts
export interface GrokCandidateModel {
  id: string;
  contextWindow?: number;
  native: boolean;
}

/** The model list `syncGrokConfig` would inject, before the user's exclusions. */
export async function fetchGrokCandidateModels(config: OcxConfig): Promise<GrokCandidateModel[]> {
  const { filterCatalogVisibleModels, nativeOpenAiContextWindow, visibleNativeSlugs } = await import("../../codex/catalog");
  const routed = filterCatalogVisibleModels(await fetchAllModels(config), config);
  return [
    ...visibleNativeSlugs(config).map(id => {
      const contextWindow = nativeOpenAiContextWindow(id);
      return { id, native: true, ...(contextWindow !== undefined ? { contextWindow } : {}) };
    }),
    ...routed.map(m => ({
      id: m.alias ?? `${m.provider}/${m.id}`,
      native: false,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    })),
  ];
}
```

### `PUT /api/grok/selection`

```ts
  // Writes CONFIG only. ~/.grok/config.toml is still written exclusively by
  // injectGrokConfig, through the apply route below — this route cannot touch that file.
  if (url.pathname === "/api/grok/selection" && req.method === "PUT") {
    let body: { excluded?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const raw = body.excluded;
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.length === 0)) {
      return jsonResponse({ error: "excluded must be an array of model ids" }, 400);
    }
    // Dedupe and sort so the stored list is stable, and cap it so a hostile client
    // cannot grow config.json without bound.
    const excluded = [...new Set(raw as string[])].sort();
    if (excluded.length > 2000) return jsonResponse({ error: "excluded list is too large" }, 400);
    if (excluded.length === 0) delete config.grokExcludedModels;
    else config.grokExcludedModels = excluded;
    saveConfig(config);
    return jsonResponse({ ok: true, excluded });
  }
```

### `POST /api/grok/apply`

```ts
  // Re-runs the SAME sync the CLI runs. All guards (no-grok-home, non-loopback refusal,
  // orphaned marker, backup, alias reservation) live in injectGrokConfig and are not
  // duplicated here. Accepts no body: every input comes from persisted state.
  if (url.pathname === "/api/grok/apply" && req.method === "POST") {
    try {
      const { syncGrokConfig } = await import("../../grok/sync");
      const { readRuntimePort } = await import("../../config");
      // The host/port the proxy ACTUALLY bound — not the request authority (caller-
      // influenced, src/server/index.ts:302) and not config.hostname, which
      // src/grok/sync.ts:24 warns may have drifted. `ocx ensure` passes live.hostname
      // for this exact reason (src/cli/index.ts:320-324); the runtime-port record is
      // the in-process equivalent, written at startup (src/cli/index.ts:200).
      const runtime = readRuntimePort(process.pid);
      const port = runtime?.port ?? config.port;
      const hostname = runtime?.hostname ?? config.hostname;
      const result = await queueGrokApply(() => syncGrokConfig(port, config, hostname !== undefined ? { hostname } : {}));
      // A policy skip (non-loopback, no ~/.grok) is not a server error: report it as a
      // result the page can explain rather than a 500 the user cannot act on.
      return jsonResponse({ ok: result.ok, changed: result.changed, message: result.message,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}) }, result.ok ? 200 : 500);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
```

Security note for review: both new routes ride the existing management-API auth/CORS
boundary (`handleManagementAPI` → `handleAgentSettingsRoutes`), the same one that
already carries `PUT /api/claude-desktop` and `POST /api/claude-desktop/apply`. No new
auth surface, no credential handling, no request-body logging. Per `AGENTS.md` this
phase touches a security-adjacent surface: review attention belongs on the threat model
and the serialization above, not on a claim that nothing writes.

## TESTS

`tests/grok-selection.test.ts` (NEW):

- no exclusions → output byte-identical to the current writer (no regression for every
  existing user);
- excluding one id omits exactly that `[model.…]` table and keeps the others;
- excluding an unknown id changes nothing;
- **alias stability**: with two ids that sanitize to the same base alias, excluding the
  first leaves the second's alias unchanged (`ocx-kimi-k3-2` stays `ocx-kimi-k3-2`) —
  the regression the audit found;
- a user-reserved `[model.ocx-…]` table outside the fence still pushes generated
  aliases past it while exclusions are active;
- excluding everything writes a fence with the two markers and no `[model.` table, and
  `stripGrokConfig` removes it cleanly — **activation evidence** for the empty case
  (C-ACTIVATION-GROUNDING-01);
- `syncGrokConfig` with `grokExcludedModels` set produces that filtered TOML end to end
  (uses the `tempGrokHome` helper pattern from `tests/grok-sync.test.ts`).

Extend `tests/claude-management-api.test.ts` style coverage in a NEW
`tests/grok-management-api.test.ts`:

- `PUT /api/grok/selection` with a non-array body → 400;
- with `["a","a","b"]` → 200, stored value `["a","b"]`, and `loadConfig()` reflects it;
- with `[]` → the field is REMOVED from config (not stored as an empty array);
- `GET /api/grok` includes `candidates` and `excluded`;
- `POST /api/grok/apply` in a temp `GROK_HOME` with no `.grok` directory returns
  `ok: true` with `skippedReason: "no-grok-home"` — the guard fires and is observed;
- `POST /api/grok/apply` against a real temp `.grok` writes the fence, and a second call
  reports `changed: false` — proving the HTTP path really reaches the guarded writer
  rather than merely asserting it does not write;
- with a runtime-port record naming a non-loopback hostname, apply returns
  `skippedReason: "non-loopback"` and the file is NOT written — activation evidence for
  the host guard and the regression test for audit blocker 2;
- two concurrent applies both resolve and leave exactly one fence (serialization).

Guard test (NEW, `tests/grok-writer-boundary.test.ts`) — `c-grok-guard` needs a check
that can actually fail:

- walk every file under `src/` and assert that the only module writing a grok
  `config.toml` (an `atomicWriteFile`/`writeFileSync` applied to a grok config path) is
  `src/grok/inject.ts`. A second writer anywhere fails the test — the property the
  criterion actually claims, unlike a string scan of one route file, which the audit
  showed would pass while the capability existed.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/grok-selection.test.ts tests/grok-management-api.test.ts tests/grok-writer-boundary.test.ts tests/grok-sync.test.ts tests/grok-config-inject.test.ts` | pass |
| `bun run typecheck` | clean |
| `bun run privacy:scan` | clean |
