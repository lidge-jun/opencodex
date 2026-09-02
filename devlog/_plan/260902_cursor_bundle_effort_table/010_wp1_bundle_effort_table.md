# 010 — wp1: read Cursor's effort table from the installed bundle

Depends on: 000. Delivers: `src/integrations/cursor-effort-table.ts` (NEW), a resolver in
`src/server/models-capabilities.ts`, provenance on the status route, tests. PR 1; targets
`dev` directly (independent of wp2..wp6).

Loop-spec: archetype spec-satisfaction; trigger = status card shows "—" for ids the bundle
would render; goal = the card follows the installed Cursor build instead of a hand copy;
non-goals = changing what Cursor renders, writing into a Cursor install; verifier =
`bun test tests/cursor-integration-status.test.ts tests/cursor-effort-table.test.ts` + typecheck;
stop = both green and exact-head CI green; escalation = if the minified literal shape differs on
Windows/Linux builds, keep the static fallback and record it in 011.

## File change map

### NEW `src/integrations/cursor-effort-table.ts`

```ts
/**
 * Cursor's local-agent effort table, read from the installed bundle.
 *
 * Cursor Private Inference decides which model rows get a Reasoning control from a table
 * compiled into extensions/cursor-agent-exec/dist/main.js, not from the gateway's
 * reasoning_effort list (devlog 260902_cursor_bundle_effort_table/000). Reading that table
 * from the install the dashboard already detects lets the prediction follow a Cursor update
 * instead of a hand-copied mirror. Read-only, size-bounded, cached by (path, mtime, size);
 * any parse failure yields null so the caller falls back to the static mirror.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CursorInstall } from "./cursor-detect";

export interface CursorEffortFamily {
  id: string;
  pattern: RegExp;
  /** [] = family matched but Cursor shows no control. */
  ladder: readonly string[];
  param?: "reasoning_effort" | "output_config.effort";
  defaultValue?: string;
  outputCap?: number;
  requiresReasoningCapability: boolean;
}

export interface CursorEffortTable {
  families: readonly CursorEffortFamily[];
  /** The bare gpt-5 / gpt-5.x rule that runs when no family matched. */
  bareGpt5: { pattern: RegExp; ladder: readonly string[]; defaultValue: string } | null;
  version: string | null;
  bundlePath: string;
}

const BUNDLE_MAX_BYTES = 32 * 1024 * 1024;

/** Bundle path under the install root cursor-detect reports. */
export function cursorAgentBundlePath(install: Pick<CursorInstall, "path">, platform = process.platform): string {
  const tail = ["extensions", "cursor-agent-exec", "dist", "main.js"];
  return platform === "darwin"
    ? join(install.path, "Contents", "Resources", "app", ...tail)
    : join(install.path, "resources", "app", ...tail);
}

/**
 * Parse the family table out of the minified source:
 *   const w={param:"reasoning_effort",values:[...],defaultValue:"medium"};
 *   ...const T={...},k={...},S={...},b=[{id:"...",matches:e=>/.../u.test(e),effort:k,outputCap:128e3},...];
 * Identifier names are minifier-assigned, so binding is by structure: every
 * <ident>={param:"...",values:[...],defaultValue:"..."} is an effort constant, and a family's
 * effort: is either such an identifier or an inline object.
 */
export function parseCursorEffortTable(source: string): Omit<CursorEffortTable, "version" | "bundlePath"> | null {
  const constants = new Map<string, { param: string; values: string[]; defaultValue: string }>();
  const constRe = /(?:const |,)([A-Za-z_$][\w$]*)=\{param:"(reasoning_effort|output_config\.effort)",values:\[([^\]]*)\],defaultValue:"([a-z]+)"\}/gu;
  for (const m of source.matchAll(constRe)) {
    constants.set(m[1]!, { param: m[2]!, values: splitStrings(m[3]!), defaultValue: m[4]! });
  }
  const tableStart = source.indexOf('=[{id:"anthropic-');
  if (tableStart === -1) return null;
  const tableEnd = source.indexOf("];", tableStart);
  if (tableEnd === -1) return null;
  const body = source.slice(tableStart + 2, tableEnd + 1);
  const entryRe = /\{id:"([^"]+)",matches:e=>\/((?:\\\/|[^/])+)\/([a-z]*)\.test\(e\)((?:,(?:effort:(?:[A-Za-z_$][\w$]*|\{[^}]*\})|outputCap:[\de.]+|effortRequiresReasoningCapability:!0))*)\}/gu;
  const families: CursorEffortFamily[] = [];
  for (const m of body.matchAll(entryRe)) {
    let pattern: RegExp;
    try { pattern = new RegExp(m[2]!, m[3]!); } catch { return null; }
    const tail = m[4]!;
    const effortRef = /effort:([A-Za-z_$][\w$]*)(?:,|$)/u.exec(tail)?.[1];
    const inline = /effort:\{param:"([^"]+)",values:\[([^\]]*)\],defaultValue:"([a-z]+)"\}/u.exec(tail);
    const effort = inline
      ? { param: inline[1]!, values: splitStrings(inline[2]!), defaultValue: inline[3]! }
      : effortRef ? constants.get(effortRef) : undefined;
    if (effortRef && !inline && !effort) return null; // unknown constant: structure changed
    const cap = /outputCap:([\de.]+)/u.exec(tail)?.[1];
    families.push({
      id: m[1]!,
      pattern,
      ladder: effort?.values ?? [],
      ...(effort ? { param: effort.param as CursorEffortFamily["param"], defaultValue: effort.defaultValue } : {}),
      ...(cap ? { outputCap: Number(cap) } : {}),
      requiresReasoningCapability: tail.includes("effortRequiresReasoningCapability:!0"),
    });
  }
  if (families.length === 0) return null;
  const bareRe = /if\(\/(\^gpt-5[^/]+)\/([a-z]*)\.test\(t\)\)return ([A-Za-z_$][\w$]*)\}/u.exec(source);
  const bareConst = bareRe ? constants.get(bareRe[3]!) : undefined;
  const bareGpt5 = bareRe && bareConst
    ? { pattern: new RegExp(bareRe[1]!, bareRe[2]!), ladder: bareConst.values, defaultValue: bareConst.defaultValue }
    : null;
  return { families, bareGpt5 };
}

function splitStrings(list: string): string[] {
  return [...list.matchAll(/"([^"]+)"/gu)].map(m => m[1]!);
}

export interface CursorEffortTableDeps {
  platform: string;
  stat(path: string): { mtimeMs: number; size: number } | null;
  readText(path: string): string | null;
}

export function realCursorEffortTableDeps(): CursorEffortTableDeps {
  return {
    platform: process.platform,
    stat: path => { try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } },
    readText: path => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  };
}

let cache: { key: string; table: CursorEffortTable | null } | null = null;

/** Table from the Private Inference install, else null (caller falls back to the static mirror). */
export function loadCursorEffortTable(install: CursorInstall | undefined, deps: CursorEffortTableDeps = realCursorEffortTableDeps()): CursorEffortTable | null {
  if (!install) return null;
  const bundlePath = cursorAgentBundlePath(install, deps.platform);
  const st = deps.stat(bundlePath);
  if (!st || st.size > BUNDLE_MAX_BYTES) return null;
  const key = `${bundlePath}|${st.mtimeMs}|${st.size}`;
  if (cache?.key === key) return cache.table;
  const text = deps.readText(bundlePath);
  const parsed = text ? parseCursorEffortTable(text) : null;
  const table = parsed ? { ...parsed, version: install.version, bundlePath } : null;
  cache = { key, table };
  return table;
}

export function resetCursorEffortTableCacheForTests(): void { cache = null; }
```

### MODIFY `src/server/models-capabilities.ts`

Keep `CURSOR_EFFORT_FAMILIES` as the static mirror (comment becomes "fallback mirror of the
3.18.25 table; the live table is read by src/integrations/cursor-effort-table.ts"). Add:

```ts
import type { CursorEffortTable } from "../integrations/cursor-effort-table";

export interface CursorEffortPrediction {
  ladder: string[] | null;
  source: "bundle" | "static";
  /** Bundle family id when one matched (e.g. "anthropic-opus-5"); null otherwise. */
  family: string | null;
  outputCap?: number;
}

export function normalizeCursorPickerId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  const at = id.indexOf("@");
  if (at !== -1) id = id.slice(0, at);
  return id;
}

export function predictCursorEffort(modelId: string, table: CursorEffortTable | null): CursorEffortPrediction {
  const id = normalizeCursorPickerId(modelId);
  if (table) {
    for (const family of table.families) {
      if (family.pattern.test(id)) {
        return {
          ladder: family.ladder.length > 0 ? [...family.ladder] : null,
          source: "bundle",
          family: family.id,
          ...(family.outputCap !== undefined ? { outputCap: family.outputCap } : {}),
        };
      }
    }
    if (table.bareGpt5?.pattern.test(id)) return { ladder: [...table.bareGpt5.ladder], source: "bundle", family: "gpt-5" };
    return { ladder: null, source: "bundle", family: null };
  }
  return { ladder: cursorEffortFamily(modelId), source: "static", family: null };
}
```

`cursorEffortFamily` is unchanged in behavior (the existing test keeps passing) and reuses
`normalizeCursorPickerId`.

### MODIFY `src/server/management/cursor-integration-routes.ts`

Before (lines 64-72):
```ts
  const models = ids.map(id => {
    const tier = nativeOpenAiContextTier(id, limits);
    return {
      id,
      reasoning: cursorEffortFamily(id),
      context: tier ? { defaultWindow: tier.defaultWindow, longWindow: tier.longWindow } : null,
    };
  });
```
After:
```ts
  const table = (deps.loadCursorEffortTable ?? loadCursorEffortTable)(privateInference);
  const models = ids.map(id => {
    const tier = nativeOpenAiContextTier(id, limits);
    const predicted = predictCursorEffort(id, table);
    return {
      id,
      reasoning: predicted.ladder,
      family: predicted.family,
      context: tier ? { defaultWindow: tier.defaultWindow, longWindow: tier.longWindow } : null,
    };
  });
  const effortTable = table
    ? { source: "bundle" as const, version: table.version, families: table.families.length }
    : { source: "static" as const, version: null, families: null };
```

- `CursorIntegrationStatus` gains `effortTable: { source: "bundle" | "static"; version: string | null; families: number | null }`
  and each model row gains `family: string | null`; `effortTable` is added to the returned object.
- `ManagementContext.deps` (`src/server/management/context.ts`, next to `readRuntimePort`) gains
  optional `loadCursorEffortTable?: (install: CursorInstall | undefined) => CursorEffortTable | null`
  so the route test injects a fixture table without touching /Applications.
- Imports: `predictCursorEffort` replaces `cursorEffortFamily`; `loadCursorEffortTable` from
  `../../integrations/cursor-effort-table`.

### MODIFY `gui/src/pages/integrations/cursor-api.ts`

Add `effortTable` and `family` to the TS interface only (rendering is wp4). No behavior change.

### NEW `tests/fixtures/cursor-agent-exec-effort-table.min.js`

The verbatim literal window from 3.18.25 (`const w={param:...}` through
`effortRequiresReasoningCapability:!0}];`, ~3.6 KB) with unrelated minified code before and
after, so the parser proves it scans rather than matches at offset 0.

### NEW `tests/cursor-effort-table.test.ts`

1. `parseCursorEffortTable(fixture)`: 16 families; `anthropic-opus-5` → ladder low..max, param
   output_config.effort, default high, outputCap 128000; `gemini` → requiresReasoningCapability
   true; `anthropic-haiku-4-5` → ladder [] and outputCap 32768; `bareGpt5` default medium.
2. `predictCursorEffort("anthropic/claude-opus-5", table)` → source bundle, family anthropic-opus-5;
   `"anthropic/claude-fable-5-1"` and `"cursor/kimi-k3"` → ladder null, source bundle, family null;
   `"gpt-5.4"` → bareGpt5 ladder; `"xai/grok-4.6@main"` → grok-4.6 (the @ strip).
3. Fallback activation (C-ACTIVATION-GROUNDING-01): `loadCursorEffortTable` with `stat` → null
   returns null; with a bundle lacking the literal → null; with a malformed regex (`/[/u`) → null;
   `predictCursorEffort(id, null)` → source static with the mirror ladder.
4. Cache: two loads with equal stat call `readText` once; a changed mtime re-reads.

### MODIFY `tests/cursor-integration-status.test.ts`

Existing route case passes `deps: { loadCursorEffortTable: () => null }` and asserts
`effortTable.source === "static"`; a new case injects the parsed fixture and asserts
`source === "bundle"`, `version === "3.18.25"`, `families === 16`, and
`models.find(m => m.id === "kimi/k3").family === null`.

## Scope boundary

IN: files above. OUT: GUI rendering (wp4), `/v1/models` row shape (wp2), any write into a
Cursor install. The bundle read is bounded (32 MiB), read-only, and never executes Cursor code.

## Accept criteria

- `bun run typecheck` 0; `bun test tests/cursor-effort-table.test.ts tests/cursor-integration-status.test.ts` 0.
- On this machine `curl /api/native-integrations/cursor` shows `effortTable.source: "bundle"`,
  `version: "3.18.25"`, `families: 16`, and `anthropic/claude-fable-5-1` keeps `reasoning: null`.
- `tests/core-lab-boundary.test.ts` unaffected (no import from src/lab).

## Bypass fields (PLAN-BYPASS-NAMED-01)

Tier E3 (runtime read with fallback); surface: the status route; bypass: a build whose literal
shape changed falls back to static, and the GUI shows "static" so the drift is visible; residual
risk: a newer build that renamed a param; wording: "prediction", never "enforcement".
