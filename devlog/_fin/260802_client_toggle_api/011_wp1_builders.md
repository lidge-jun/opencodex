# 011 — WP1: paste-ready serializer and client builders

> **Status: verified by `tools/check-blocks.ts` (see `007_execution_method.md`).**
> The bodies below are compiled as self-contained units by the block checker.
> They remain the paste source; the checker guarantees they parse and are
> internally consistent, while cross-module resolution is settled by the
> repository's own `bun run typecheck` during the implementing phase.



**A-gate round-3 addendum (read first).** Two items the audit found missing
from WP1's executable surface, specified here so the phase needs no invention.

### A. OpenCode and Pi also gain `summarize` and `buildContribution`

`ExportClientSpec` requires both on **every** entry (010 §2.1), so the two
existing clients are not exempt. These bodies extract current behavior rather
than inventing any:

```ts
// opencode — models live in provider.opencodex.models (a keyed object)
function summarizeOpencode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const block = (document as OpencodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID];
  const models = Object.values(block?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(m => !m.limit).length };
}

function buildOpencodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildOpencodeClientConfig(ctx);
  return {
    clientId: "opencode",
    fragments: [{ path: ["provider", OPENCODE_PROVIDER_ID], value: doc.provider[OPENCODE_PROVIDER_ID] }],
  };
}

// pi — models are an ARRAY under providers.opencodex.models
function summarizePi(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as PiGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(m => m.contextWindow === undefined).length,
  };
}

function buildPiContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildPiClientConfig(ctx);
  return {
    clientId: "pi",
    fragments: [{ path: ["providers", OPENCODE_PROVIDER_ID], value: doc.providers[OPENCODE_PROVIDER_ID] }],
  };
}
```

Both registry entries gain `format: "json"`, `summarize`, and
`buildContribution`; nothing else about them changes, so their golden bytes
stay identical (010 §5 accept criterion 4).

### B. `src/server/management/model-rows.ts` (NEW) — the canonical loader

Extraction only, no behavior change. The declarations move out of
`model-routes.ts`, which then imports them:

The move is verbatim: `model-routes.ts:114` (type), `:129`
(`listManagementModelRows`, including its `disabled` computation and the
native/custom/routed merge), and `:182` (`toExportModel`) are cut and pasted
unchanged, gaining `export`. Only the type declaration and the two new
exports are reproduced here — the moved function bodies are not retyped,
because retyping them by hand is how a "mechanical extraction" stops being
mechanical. The instruction is: **cut lines 114-122, 129-180, and 182-192
from `model-routes.ts` into this file, add `export` to each, and change
nothing else.**

```ts
import type { CatalogModel } from "../../codex/catalog";
import type { ExportModel } from "../../clients/config-export";
import type { OcxConfig } from "../../types";

/** Verbatim from model-routes.ts:114, now exported. */
export type ManagementModelRow = Partial<CatalogModel> & {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
};

/** Verbatim from model-routes.ts:129, now exported. Body unchanged. */
export async function listManagementModelRows(config: OcxConfig): Promise<ManagementModelRow[]> { /* moved verbatim */ }

/** Verbatim from model-routes.ts:182, now exported. Body unchanged. */
export function toExportModel(row: ManagementModelRow): ExportModel { /* moved verbatim */ }

/**
 * NEW. Visible (non-disabled) rows as export models — the ONE loader used by
 * both /api/client-config and the integration routes, so the two can never
 * disagree about which models a client is told about. The filter+map is
 * exactly what the client-config branch inlines today.
 */
export async function loadExportModels(config: OcxConfig): Promise<ExportModel[]> {
  const rows = await listManagementModelRows(config);
  return rows.filter(row => !row.disabled).map(toExportModel);
}
```

`model-routes.ts` then adds
`import { listManagementModelRows, loadExportModels, toExportModel, type ManagementModelRow } from "./model-rows";`
and its `/api/client-config` branch replaces
`rows.filter(row => !row.disabled).map(toExportModel)` with
`await loadExportModels(config)`.

`model-routes.ts` replaces its local declarations with
`import { listManagementModelRows, loadExportModels, toExportModel } from "./model-rows";`
and its `/api/client-config` branch calls `loadExportModels(config)` instead
of inlining the filter+map.

Regression proof: `tests/management-client-config-route.test.ts` pins that
envelope and must pass unchanged — that is what makes the extraction provably
mechanical.

Implementation-only overflow for `010_wp1_client_registry.md`. Shared types and
fragment ownership are authoritative in `006_module_contracts.md`; this file does
not import from `src/integrations/registry.ts`.

## 1. `src/integrations/serialize.ts` — `renderYaml`

Place these helpers after `isPlainRecord`. Replace the YAML branch of
`serializeDocument` with `return renderYaml(document);`.

```ts
function isYamlScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Keep only unambiguous, single-token strings plain. Everything else uses a
 * JSON-compatible YAML double-quoted scalar, which gives deterministic escaping.
 */
function yamlString(value: string): string {
  const plainSafe =
    value.length > 0 &&
    value.trim() === value &&
    /^[A-Za-z_./][A-Za-z0-9_./-]*$/u.test(value) &&
    !/^(?:null|true|false|yes|no|on|off|~|\.nan|[-+]?\.inf)$/iu.test(value);
  return plainSafe ? value : JSON.stringify(value);
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isFinite(value)) return String(value);
  throw new Error(`unsupported YAML number: ${String(value)}`);
}

/**
 * Type guard, not a boolean check — the renderer walks `unknown`, so without
 * the predicate every narrowed branch stays `unknown` and `Object.entries`
 * rejects it. (Caught by tools/check-blocks.ts, TS2769.)
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlEmptyCollection(value: unknown): "[]" | "{}" | undefined {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isPlainRecord(value) && Object.keys(value).length === 0) return "{}";
  return undefined;
}

function yamlMapEntryLines(key: string, value: unknown, indent: number): string[] {
  const padding = " ".repeat(indent);
  const renderedKey = yamlString(key);
  if (isYamlScalar(value)) {
    return [`${padding}${renderedKey}: ${yamlScalar(value)}`];
  }
  const empty = yamlEmptyCollection(value);
  if (empty !== undefined) {
    return [`${padding}${renderedKey}: ${empty}`];
  }
  if (Array.isArray(value) || isPlainRecord(value)) {
    return [`${padding}${renderedKey}:`, ...yamlLines(value, indent + 2)];
  }
  throw new Error(`unsupported YAML value at key ${JSON.stringify(key)}: ${String(value)}`);
}

function yamlArrayMapLines(value: Record<string, unknown>, indent: number): string[] {
  const entries = Object.entries(value);
  const padding = " ".repeat(indent);
  if (entries.length === 0) return [`${padding}- {}`];

  const [[firstKey, firstValue], ...rest] = entries;
  const renderedFirstKey = yamlString(firstKey);
  const firstEmpty = yamlEmptyCollection(firstValue);
  const lines: string[] = [];
  if (isYamlScalar(firstValue)) {
    lines.push(`${padding}- ${renderedFirstKey}: ${yamlScalar(firstValue)}`);
  } else if (firstEmpty !== undefined) {
    lines.push(`${padding}- ${renderedFirstKey}: ${firstEmpty}`);
  } else if (Array.isArray(firstValue) || isPlainRecord(firstValue)) {
    lines.push(`${padding}- ${renderedFirstKey}:`);
    lines.push(...yamlLines(firstValue, indent + 4));
  } else {
    throw new Error(
      `unsupported YAML value at key ${JSON.stringify(firstKey)}: ${String(firstValue)}`,
    );
  }
  for (const [key, child] of rest) {
    lines.push(...yamlMapEntryLines(key, child, indent + 2));
  }
  return lines;
}

function yamlLines(value: unknown, indent: number): string[] {
  const padding = " ".repeat(indent);
  if (isYamlScalar(value)) return [`${padding}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${padding}[]`];
    return value.flatMap(item => {
      if (isYamlScalar(item)) return [`${padding}- ${yamlScalar(item)}`];
      if (isPlainRecord(item)) return yamlArrayMapLines(item, indent);
      throw new Error(`unsupported YAML array item: ${String(item)}`);
    });
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${padding}{}`];
    return entries.flatMap(([key, child]) => yamlMapEntryLines(key, child, indent));
  }
  throw new Error(`unsupported YAML value: ${String(value)}`);
}

/** Block-style YAML for the shallow shapes we emit. Throws on anything else. */
export function renderYaml(value: unknown, indent = 0): string {
  if (!Number.isInteger(indent) || indent < 0) {
    throw new Error(`YAML indent must be a non-negative integer: ${String(indent)}`);
  }
  return `${yamlLines(value, indent).join("\n")}\n`;
}
```

Quoting contract:

- Plain form is limited to non-empty `[A-Za-z_./][A-Za-z0-9_./-]*` strings
  that are not YAML implicit booleans/null/special floats.
- Empty strings, whitespace, `:`, `#`, `${...}`, numeric-looking values,
  punctuation-leading values, and strings needing escapes use JSON double
  quotes. JSON string escaping is valid YAML 1.2 string escaping.
- Map keys use the same rule as scalar strings.
- Non-finite numbers, null, undefined, functions, arrays nested directly inside
  arrays, and other unsupported values throw rather than producing ambiguous
  bytes.
- Object key order and array order are preserved. `renderYaml` appends exactly
  one newline and no helper appends another.

## 2. `src/clients/config-export.ts` — supporting types and constants

The interfaces are the shapes from `010` §2.4. Add these constants beside the
existing client constants. `ConfigFormat`, `ManagedFragment`,
`ManagedContribution`, and `BuildContribution` remain owned by this module as
required by `006` §2.

```ts
export const HERMES_API_KEY_ENV = "OPENCODEX_HERMES_API_KEY";
export const HERMES_API_KEY_ENV_REF = `\${${HERMES_API_KEY_ENV}}`;

export const OPENCLAW_API_KEY_ENV = "OPENCODEX_OPENCLAW_API_KEY";
export const OPENCLAW_API_KEY_ENV_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

export const KIMI_LOOPBACK_PLACEHOLDER = "opencodex-loopback";

export const GAJAE_API_KEY_ENV = "OPENCODEX_GAJAE_API_KEY";

export interface HermesProviderBlock {
  api: string;
  api_key: string;
  api_mode: "chat_completions";
  discover_models: false;
  models: string[];
  extra_headers?: Record<string, string>;
}

export interface HermesGeneratedConfig {
  providers: Record<string, HermesProviderBlock>;
}

export interface OpenclawModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface OpenclawProviderBlock {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: OpenclawModelEntry[];
  headers?: Record<string, string>;
}

export interface OpenclawGeneratedConfig {
  models: {
    mode: "merge";
    providers: Record<string, OpenclawProviderBlock>;
  };
}

export interface KimiProviderBlock {
  type: "openai";
  base_url: string;
  api_key: string;
}

export interface KimiModelBlock {
  provider: string;
  model: string;
  max_context_size: number;
  display_name?: string;
}

export interface KimiGeneratedConfig {
  providers: Record<string, KimiProviderBlock>;
  models: Record<string, KimiModelBlock>;
}

export interface GajaeModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface GajaeProviderBlock {
  baseUrl: string;
  apiKeyEnv: string;
  api: "openai-completions";
  models: GajaeModelEntry[];
}

export interface GajaeGeneratedConfig {
  providers: Record<string, GajaeProviderBlock>;
}
```

## 3. `src/clients/config-export.ts` — four builders

`admissionHeaders` mirrors the existing `opencodeProviderOptions` branch while
letting each client use its own documented env-reference syntax. Gajae does not
call it because its strict schema contract in `010` contains no `headers` field.
Kimi does not call it because its writer is loopback-only and its credential
field is literal-only.

```ts
function admissionHeaders(
  ctx: ExportContext,
  apiKeyReference: string,
): Record<string, string> | undefined {
  const config = ctx.config ?? OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG;
  if (!shouldInjectApiAuthHeader(config)) return undefined;
  return { "x-opencodex-api-key": apiKeyReference };
}

export function buildHermesClientConfig(ctx: ExportContext): HermesGeneratedConfig {
  const provider: HermesProviderBlock = {
    api: ctx.baseUrl,
    api_key: HERMES_API_KEY_ENV_REF,
    api_mode: "chat_completions",
    discover_models: false,
    models: normalizeExportModels(ctx.models).map(model => model.namespaced),
  };
  const extraHeaders = admissionHeaders(ctx, HERMES_API_KEY_ENV_REF);
  if (extraHeaders !== undefined) provider.extra_headers = extraHeaders;
  return { providers: { [OPENCODE_PROVIDER_ID]: provider } };
}

export function buildOpenclawClientConfig(ctx: ExportContext): OpenclawGeneratedConfig {
  const models: OpenclawModelEntry[] = normalizeExportModels(ctx.models).map(model => {
    const entry: OpenclawModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) entry.contextWindow = context;
    return entry;
  });
  const provider: OpenclawProviderBlock = {
    baseUrl: ctx.baseUrl,
    apiKey: OPENCLAW_API_KEY_ENV_REF,
    api: "openai-completions",
    models,
  };
  const headers = admissionHeaders(ctx, OPENCLAW_API_KEY_ENV_REF);
  if (headers !== undefined) provider.headers = headers;
  return {
    models: {
      mode: "merge",
      providers: { [OPENCODE_PROVIDER_ID]: provider },
    },
  };
}

export function buildKimiClientConfig(ctx: ExportContext): KimiGeneratedConfig {
  const models: Record<string, KimiModelBlock> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const context = authoritativeContextWindow(model.contextWindow);
    if (context === undefined) continue;
    const alias = `${OPENCODE_PROVIDER_ID}/${model.namespaced}`;
    models[alias] = {
      provider: OPENCODE_PROVIDER_ID,
      model: model.namespaced,
      max_context_size: context,
      display_name: exportModelLabel(model),
    };
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        type: "openai",
        base_url: ctx.baseUrl,
        api_key: KIMI_LOOPBACK_PLACEHOLDER,
      },
    },
    models,
  };
}

export function buildGajaeClientConfig(ctx: ExportContext): GajaeGeneratedConfig {
  const models: GajaeModelEntry[] = normalizeExportModels(ctx.models).map(model => {
    const entry: GajaeModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      input:
        model.inputModalities && model.inputModalities.length > 0
          ? [...model.inputModalities]
          : ["text"],
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    return entry;
  });
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        apiKeyEnv: GAJAE_API_KEY_ENV,
        api: "openai-completions",
        models,
      },
    },
  };
}
```

No builder reads `config.apiKeys`, provider credentials, or process env values.
Hermes/OpenClaw serialize env references, Kimi serializes the fixed loopback
placeholder, and Gajae serializes only an env variable name.

## 4. `src/clients/config-export.ts` — four managed contributions

```ts
export function buildHermesContribution(ctx: ExportContext): ManagedContribution {
  const document = buildHermesClientConfig(ctx);
  return {
    clientId: "hermes",
    fragments: [
      {
        path: ["providers", OPENCODE_PROVIDER_ID],
        value: document.providers[OPENCODE_PROVIDER_ID],
      },
    ],
  };
}

export function buildOpenclawContribution(ctx: ExportContext): ManagedContribution {
  const document = buildOpenclawClientConfig(ctx);
  return {
    clientId: "openclaw",
    fragments: [
      {
        path: ["models", "providers", OPENCODE_PROVIDER_ID],
        value: document.models.providers[OPENCODE_PROVIDER_ID],
      },
    ],
  };
}

export function buildKimiContribution(ctx: ExportContext): ManagedContribution {
  const document = buildKimiClientConfig(ctx);
  const fragments: ManagedFragment[] = [
    {
      path: ["providers", OPENCODE_PROVIDER_ID],
      value: document.providers[OPENCODE_PROVIDER_ID],
    },
  ];
  for (const [alias, model] of Object.entries(document.models)) {
    fragments.push({ path: ["models", alias], value: model });
  }
  return { clientId: "kimi", fragments };
}

export function buildGajaeContribution(ctx: ExportContext): ManagedContribution {
  const document = buildGajaeClientConfig(ctx);
  return {
    clientId: "gajae",
    fragments: [
      {
        path: ["providers", OPENCODE_PROVIDER_ID],
        value: document.providers[OPENCODE_PROVIDER_ID],
      },
    ],
  };
}
```

The Kimi fragment order is provider first, followed by model aliases in the
normalized selector order used to construct `document.models`. No contribution
performs a prefix scan.

## 5. `src/clients/config-export.ts` — four summaries

Each implementation counts the emitted document, never the input catalog.

```ts
export function summarizeHermesClientConfig(document: unknown): {
  modelCount: number;
  modelsWithoutLimits: number;
} {
  const models = (document as HermesGeneratedConfig).providers[OPENCODE_PROVIDER_ID].models;
  return { modelCount: models.length, modelsWithoutLimits: models.length };
}

export function summarizeOpenclawClientConfig(document: unknown): {
  modelCount: number;
  modelsWithoutLimits: number;
} {
  const models = (document as OpenclawGeneratedConfig)
    .models.providers[OPENCODE_PROVIDER_ID].models;
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length,
  };
}

export function summarizeKimiClientConfig(document: unknown): {
  modelCount: number;
  modelsWithoutLimits: number;
} {
  // Annotate the value type: `Object.values` on an indexed record widens to
  // `unknown` under strict mode without it. (check-blocks.ts, TS18046.)
  const models: KimiModelBlock[] = Object.values((document as KimiGeneratedConfig).models ?? {});
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => model.max_context_size === undefined).length,
  };
}

export function summarizeGajaeClientConfig(document: unknown): {
  modelCount: number;
  modelsWithoutLimits: number;
} {
  const models = (document as GajaeGeneratedConfig).providers[OPENCODE_PROVIDER_ID].models;
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length,
  };
}
```

Hermes cannot express per-model limits in the verified schema, so every emitted
Hermes model is reported without limits. Kimi's mandatory-positive rule means
every emitted Kimi model has `max_context_size`; the filter deliberately proves
that property from the document rather than hard-coding zero.

## 6. `src/clients/config-export.ts` — destination helpers

Extend the `node:path` import to include `win32`. The optional `platform` seam
makes the Windows branch testable on non-Windows CI while production defaults to
`process.platform`.

```ts
export function hermesConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const hermesHome = env.HERMES_HOME;
  if (hermesHome && hermesHome.length > 0) {
    return platform === "win32"
      ? win32.join(hermesHome, "config.yaml")
      : join(hermesHome, "config.yaml");
  }
  if (platform === "win32" && env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0) {
    return win32.join(env.LOCALAPPDATA, "hermes", "config.yaml");
  }
  return join(home, ".hermes", "config.yaml");
}

export function openclawConfigPath(home: string = homedir()): string {
  return join(home, ".openclaw", "openclaw.json");
}

export function kimiConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const kimiHome = env.KIMI_CODE_HOME;
  return join(kimiHome && kimiHome.length > 0 ? kimiHome : join(home, ".kimi-code"), "config.toml");
}

export function gajaeConfigPath(home: string = homedir()): string {
  return join(home, ".gjc", "agent", "models.yml");
}
```

Resolution order is exact:

1. Hermes: non-empty `HERMES_HOME`; on Windows, non-empty `LOCALAPPDATA` plus
   `hermes`; otherwise `~/.hermes`; then `config.yaml`.
2. OpenClaw: `~/.openclaw/openclaw.json`.
3. Kimi: non-empty `KIMI_CODE_HOME`; otherwise `~/.kimi-code`; then
   `config.toml`.
4. Gajae: `~/.gjc/agent/models.yml`.

## 7. `src/clients/config-export.ts` — complete registry entries

Insert these four entries after `pi`. They assume the required `format`,
`summarize`, and `buildContribution` fields from `010` §2.1 have also been added
to the two existing entries.

```ts
hermes: {
  id: "hermes",
  filename: "hermes-config.yaml",
  format: "yaml",
  destination: env => hermesConfigPath(env),
  apiKeyEnv: HERMES_API_KEY_ENV,
  exportHint: `export ${HERMES_API_KEY_ENV}=<your key>`,
  build: buildHermesClientConfig,
  summarize: summarizeHermesClientConfig,
  buildContribution: buildHermesContribution,
},
openclaw: {
  id: "openclaw",
  filename: "openclaw.json5",
  format: "json5",
  destination: () => openclawConfigPath(),
  apiKeyEnv: OPENCLAW_API_KEY_ENV,
  exportHint: `export ${OPENCLAW_API_KEY_ENV}=<your key>`,
  build: buildOpenclawClientConfig,
  summarize: summarizeOpenclawClientConfig,
  buildContribution: buildOpenclawContribution,
},
kimi: {
  id: "kimi",
  filename: "kimi-config.toml",
  format: "toml",
  destination: env => kimiConfigPath(env),
  apiKeyEnv: "",
  exportHint: "Loopback only: Kimi uses the fixed opencodex-loopback placeholder; no key export is required.",
  build: buildKimiClientConfig,
  summarize: summarizeKimiClientConfig,
  buildContribution: buildKimiContribution,
},
gajae: {
  id: "gajae",
  filename: "gajae-models.yaml",
  format: "yaml",
  destination: () => gajaeConfigPath(),
  apiKeyEnv: GAJAE_API_KEY_ENV,
  exportHint: `export ${GAJAE_API_KEY_ENV}=<your key>`,
  build: buildGajaeClientConfig,
  summarize: summarizeGajaeClientConfig,
  buildContribution: buildGajaeContribution,
},
```

OPEN QUESTION: `ExportClientSpec.apiKeyEnv` is a required `string`, but Kimi has
no environment-variable credential support. WP1 uses the non-fabricated empty
string above. Before a consumer starts assuming this field is non-empty, decide
whether the contract should become `apiKeyEnv: string | null`; do not invent a
Kimi env variable.

OPEN QUESTION: Hermes' `extra_headers` acceptance is documented upstream but
not live-install verified (`010` §OPEN QUESTIONS). Keep the branch and its exact
serialized proof in WP1; live-client acceptance remains a later integration
gate.

## 8. C-ACTIVATION-GROUNDING-01

| Branch | Activation scenario | Observable proof |
|---|---|---|
| `yamlString` plain branch | `opencodex`, `chat_completions`, or a selector such as `anthropic/claude` | Serialized text contains the token without quotes; `Bun.YAML.parse` returns the original string. |
| `yamlString` quoted branch | Empty string, `${OPENCODEX_HERMES_API_KEY}`, URL with `:`, display name with spaces, `true`, or `123` | Serialized text contains a JSON-style double-quoted scalar; YAML round-trip deep-equals the input. |
| `yamlScalar` string / boolean / finite-number branches | Render one value of each scalar type | Output is respectively quoted/plain text, `true`/`false`, and decimal text; parse restores each type. |
| `yamlScalar` non-finite rejection | Render `NaN`, `Infinity`, or `-Infinity` | `renderYaml` throws `unsupported YAML number`. |
| Empty array / empty map inline branches | Render `{ a: [], b: {} }`, plus root `[]` and `{}` | Output contains `a: []`, `b: {}`, and root forms parse to empty collections. |
| Map scalar / nested collection branches | Render `{ a: 1, b: { c: 2 }, d: [3] }` | Output uses two-space block indentation and parses to the original document. |
| Array scalar / array-map branches | Render `{ values: ["a", "b"], models: [{ id: "x", input: ["text"] }] }` | Output uses `-` block items; parse restores both arrays and insertion order is byte-stable. |
| Unsupported map value / array item / root value branches | Render a function as a map value, array item, and root | Each call throws an `unsupported YAML...` error naming the boundary. |
| Invalid indent branch | Call `renderYaml({}, -1)` and `renderYaml({}, 1.5)` | Both calls throw `YAML indent must be a non-negative integer`. |
| Loopback admission branch | Omit `ctx.config` or use hostname `127.0.0.1` | Hermes has no `extra_headers`; OpenClaw has no `headers`; env references remain in their credential fields. |
| Non-loopback header-injection branch | Use `ctx.config.hostname = "0.0.0.0"` | Hermes emits `extra_headers.x-opencodex-api-key`; OpenClaw emits `headers.x-opencodex-api-key`; both values are that client's env reference, never a secret. |
| OpenClaw known-context branch | Model has finite positive `contextWindow` | Emitted entry has floored `contextWindow`; summary does not count it as without limits. |
| OpenClaw missing/invalid-context branch | Context is absent, zero, negative, `NaN`, or infinite | Entry remains but omits `contextWindow`; summary increments `modelsWithoutLimits`. |
| Kimi emitted-model branch | Model has a finite positive authoritative context window | `models["opencodex/<selector>"]` exists with positive `max_context_size`, and contribution has the exact matching model fragment. |
| Kimi omitted-model branch | Context is absent, zero, negative, `NaN`, or infinite | No model table or model fragment exists for the selector; provider table/fragment still exists. |
| Gajae declared-input branch | `inputModalities` is a non-empty array | `input` is a copied array with exactly those modalities. |
| Gajae default-input branch | `inputModalities` is absent or empty | `input` is exactly `["text"]`. |
| Gajae known-context branch | Model has finite positive `contextWindow` | Entry contains floored `contextWindow` and `maxTokens = min(32000, contextWindow)`. |
| Gajae missing/invalid-context branch | Context is absent, zero, negative, `NaN`, or infinite | Entry remains and omits both `contextWindow` and `maxTokens`; summary increments `modelsWithoutLimits`. |
| Kimi contribution loop | One or more models pass the mandatory-context gate | Provider fragment is first, followed by one exact `models/<alias>` fragment per emitted model in selector order. |
| Kimi contribution empty-model case | Every model lacks authoritative context | Contribution contains only `providers.opencodex`; no prefix-derived model path appears. |
| Summary missing-limit predicates | Hermes model, OpenClaw/Gajae entry without context, or malformed Kimi document without `max_context_size` | `modelsWithoutLimits` equals the count visible in the emitted document shape. |
| Hermes override branch | Non-empty `HERMES_HOME` | Path is `<HERMES_HOME>/config.yaml`; it wins even if `LOCALAPPDATA` is present. |
| Hermes Windows local-app-data branch | Empty/absent `HERMES_HOME`, `platform = "win32"`, non-empty `LOCALAPPDATA` | Path is `%LOCALAPPDATA%\\hermes\\config.yaml` using `win32.join`. |
| Hermes home fallback branch | No override, or non-Windows even when `LOCALAPPDATA` is present | Path is `<home>/.hermes/config.yaml`. |
| Hermes platform separator branch | Non-empty `HERMES_HOME` with `platform = "win32"` versus a non-Windows platform | Windows proof contains backslashes; non-Windows proof uses native `join`. |
| Kimi override branch | Non-empty `KIMI_CODE_HOME` | Path is `<KIMI_CODE_HOME>/config.toml`. |
| Kimi home fallback branch | Empty/absent `KIMI_CODE_HOME` | Path is `<home>/.kimi-code/config.toml`. |

## 9. Test appendix

### `tests/integrations-serialize.test.ts`

| Exact test name | Assertion |
|---|---|
| `renderYaml emits deterministic two-space block YAML with exactly one trailing newline` | Nested maps and arrays render in insertion order, contain no flow-style root, end in `\n`, and do not end in `\n\n`; two calls are byte-identical. |
| `renderYaml round-trips the emitted shallow shapes through Bun.YAML.parse` | A fixture containing maps, string/number/bool scalars, scalar arrays, and arrays of maps deep-equals `Bun.YAML.parse(renderYaml(fixture))`. |
| `renderYaml quotes ambiguous strings and unsafe keys` | Empty, whitespace, URL, `${VAR}`, `true`, numeric-looking, colon/hash, and unsafe-key strings are double quoted and round-trip as strings. |
| `renderYaml keeps unambiguous strings plain` | Provider ids, dialect names, and namespaced selectors appear without quotes and parse as strings. |
| `renderYaml emits empty maps and arrays inline` | Root and nested empty collections parse to the matching collection types. |
| `renderYaml rejects non-finite numbers and unsupported values` | `NaN`, infinities, null, undefined, functions, and arrays nested directly in arrays throw the documented error family. |
| `renderYaml rejects negative and fractional indentation` | `-1` and `1.5` throw the exact indent-contract message. |
| `serializeDocument uses renderYaml for YAML and preserves its newline contract` | `serializeDocument(doc, "yaml") === renderYaml(doc)` and round-trips through `Bun.YAML.parse`. |

### `tests/client-config-export.test.ts`

| Exact test name | Assertion |
|---|---|
| `the registry covers exactly six clients with complete format-aware specs` | IDs are `opencode`, `pi`, `hermes`, `openclaw`, `kimi`, `gajae`; every entry has matching id, filename extension/format, build, summarize, and buildContribution. |
| `Hermes emits the documented provider schema and no default-model takeover` | Only `providers.opencodex` exists with `api`, `${VAR}` `api_key`, `chat_completions`, `discover_models: false`, and sorted selector strings; no root `model` key exists. |
| `OpenClaw emits merge mode and the openai-completions provider schema` | `models.mode` is `merge`, only `models.providers.opencodex` is owned, `agents.defaults` is absent, and entries are sorted with shared labels. |
| `Kimi emits only models with mandatory positive authoritative context windows` | Unknown/invalid-context rows are absent, valid rows use aliases `opencodex/<selector>`, and provider remains present. |
| `Kimi serializes only the loopback placeholder and no environment reference` | `api_key` equals `opencodex-loopback`; text contains no real-looking key and no fabricated Kimi env name. |
| `Gajae emits only strict-schema-known provider and model fields` | Provider keys are a subset of `baseUrl`, `apiKeyEnv`, `api`, `models`; model keys are a subset of `id`, `name`, `input`, `contextWindow`, `maxTokens`; `apiKey` and `headers` are absent. |
| `Gajae defaults input to text and preserves declared modalities` | Missing/empty modalities become `["text"]`; non-empty modalities are copied exactly. |
| `Hermes and OpenClaw inject only env-reference admission headers on non-loopback binds` | `0.0.0.0` adds the exact header field for both clients; loopback omits it; serialized output contains no configured live key. |
| `all six client documents serialize without credentials and with stable bytes` | Shuffled/duplicated input produces byte-identical `buildClientConfigText(...).text`; configured real-looking keys and `sk-` never appear. |
| `the four new summaries count the emitted document shapes` | Hermes counts all as without limits; OpenClaw/Gajae count missing context; Kimi counts only emitted models and reports zero for valid generated output. |
| `managed contributions use the canonical per-client fragment paths` | Hermes/Gajae use `providers.opencodex`; OpenClaw uses `models.providers.opencodex`; values deep-equal the corresponding built blocks. |
| `Kimi contribution contains the provider plus one exact fragment per emitted model` | Provider is first; each valid model produces `models["opencodex/<selector>"]`; omitted models produce no fragment; order is stable. |
| `Hermes destination honors HERMES_HOME then Windows LOCALAPPDATA then home` | Injected env/home/platform fixtures prove all three resolution branches and Windows separators. |
| `Kimi destination honors KIMI_CODE_HOME and otherwise uses the home fallback` | Override and fallback fixtures produce the exact `config.toml` paths. |
| `OpenClaw and Gajae destinations use their canonical home-relative files` | Paths equal `~/.openclaw/openclaw.json` and `~/.gjc/agent/models.yml`. |
| `registry credential metadata treats Kimi as loopback-only without inventing an env var` | Kimi has `apiKeyEnv === ""` and a placeholder/no-export hint; the other three entries name the env reference present in their document. |

The focused WP1 gate remains:

```bash
bun test tests/client-config-export.test.ts tests/integrations-serialize.test.ts \
  tests/cli-export-command.test.ts tests/management-client-config-route.test.ts
bun run typecheck
bun run privacy:scan
```
