# 010 — WP1: client registry + per-client serializers

Diff-level PRD. Baseline contracts: `005_contract_inventory.md`. **Shared
types are defined in `006_module_contracts.md` and are authoritative — where
this document disagrees with 006, 006 wins.** Client schemas:
`002_client_toggle_matrix.md`. This phase adds no writer and no route — it
makes the export core able to *describe* six clients in three text formats,
keeping the existing read-only surfaces byte-identical.

**A-gate amendments folded in (round 1):**

- `Bun.YAML.stringify` emits flow style with no trailing newline (verified);
  YAML is **hand-rendered** like TOML (006 §1). The `serializeDocument` sketch
  below is superseded by 006 §1 on the YAML branch.
- `ExportClientSpec` gains **both** `format` and `summarize` (the §3.2
  consumer requires `summarize`; the §2.1 diff below omits it and is
  corrected here).
- This phase also lands `buildContribution` per client (006 §2) — the
  writer-side fragment list — because only the builder knows each client's
  schema. WP2/WP3 consume it; they do not re-derive paths.

## Scope boundary

IN

- `src/clients/config-export.ts` — MODIFY (registry gains a format axis,
  four new builders).
- `src/integrations/serialize.ts` — NEW (format serializers, incl. the
  hand-rendered TOML fragment writer).
- `src/cli/export-command.ts` — MODIFY (stop assuming JSON text).
- `src/server/management/model-routes.ts` — MODIFY (`summarizeExportedModels`
  loses its "non-OpenCode means Pi" branch; envelope gains `format`/`text`).
- `gui/src/components/apikeys-workspace/client-config-clients.ts` — MODIFY
  (tuple + label keys + envelope type).
- `tests/client-config-export.test.ts` — MODIFY; `tests/integrations-serialize.test.ts` — NEW.

OUT

- No file writing, no ownership, no journal (WP2/WP3).
- No new route (WP4). No GUI page work beyond the client tuple (WP5/WP6).
- `src/cli/opencode.ts` re-export surface stays byte-compatible.
- `src/codex/prompt-layers.ts` and its test: untouched (another session owns them).

## 1. `src/integrations/serialize.ts` (NEW)

```ts
/**
 * Text serializers for client config documents.
 *
 * Bun 1.3.14 gives us JSON/YAML/JSON5 stringify natively but NO TOML
 * stringify, so TOML is hand-rendered exactly like the Grok managed block
 * (src/grok/inject.ts buildGrokManagedBlock). We only ever render the narrow
 * subset of TOML our own document uses: a table of string/number values plus
 * nested single-level tables. Anything richer is a programming error here,
 * not a user input, so it throws rather than emitting invalid TOML.
 */
export type ConfigFormat = "json" | "yaml" | "toml" | "json5";

export const FORMAT_MEDIA_TYPE: Record<ConfigFormat, string> = {
  json: "application/json",
  yaml: "application/yaml",
  toml: "application/toml",
  json5: "application/json5",
};

export const FORMAT_EXTENSION: Record<ConfigFormat, string> = {
  json: "json", yaml: "yaml", toml: "toml", json5: "json5",
};

/** TOML basic-string escape. Mirrors src/grok/inject.ts `tomlString`. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a scalar; throws on anything TOML cannot express inline. */
function tomlScalar(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every(v => typeof v === "string")) {
    return `[${value.map(tomlString).join(", ")}]`;
  }
  throw new Error(`unsupported TOML value: ${JSON.stringify(value)}`);
}

/**
 * Render `{ [table]: { key: scalar } }` as TOML. Table headers are emitted in
 * insertion order so two calls with the same document produce identical bytes
 * (the byte-stability guarantee normalizeExportModels exists to protect).
 */
export function renderToml(document: Record<string, unknown>, prefix = ""): string {
  const scalars: string[] = [];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(document)) {
    const path = prefix ? `${prefix}.${quoteTomlKey(key)}` : quoteTomlKey(key);
    if (isPlainRecord(value)) {
      const body = renderToml(value, path);
      tables.push(`[${path}]\n${body}`.trimEnd());
    } else {
      scalars.push(`${quoteTomlKey(key)} = ${tomlScalar(value)}`);
    }
  }
  return [scalars.join("\n"), tables.join("\n\n")].filter(Boolean).join("\n\n") + "\n";
}

/** Bare key when safe, basic-string key otherwise (TOML 1.0 §Keys). */
export function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

export function serializeDocument(document: unknown, format: ConfigFormat): string {
  switch (format) {
    case "json": return JSON.stringify(document, null, 2) + "\n";
    case "yaml": return Bun.YAML.stringify(document);
    case "json5": return Bun.JSON5.stringify(document, null, 2) + "\n";
    case "toml": {
      if (!isPlainRecord(document)) throw new Error("TOML root must be a table");
      return renderToml(document);
    }
  }
}
```

**Activation scenarios.** `tomlScalar` throw: a test passes
`{ a: { b: () => {} } }` and asserts the thrown message names the value.
`quoteTomlKey` basic-string branch: a model alias containing `.` (e.g.
`anthropic/claude-opus-4.8`) must emit `"anthropic/claude-opus-4.8"` and the
result must survive `Bun.TOML.parse` — that round-trip IS the observable proof.

## 2. `src/clients/config-export.ts` — registry gains a format axis

### 2.1 Type changes

```diff
-export type ExportClientId = "opencode" | "pi";
+export type ExportClientId =
+  | "opencode"
+  | "pi"
+  | "hermes"
+  | "openclaw"
+  | "kimi"
+  | "gajae";

 export interface ExportClientSpec {
   id: ExportClientId;
   filename: string;
   destination: (env: NodeJS.ProcessEnv) => string;
   apiKeyEnv: string;
   exportHint: string;
   build: (ctx: ExportContext) => unknown;
+  /**
+   * Text format of the client's config file. `filename` already carries the
+   * extension; this drives serialization and the download media type so no
+   * consumer has to infer either from the name.
+   */
+  format: ConfigFormat;
+  /**
+   * Count models in THIS client's document shape. Required so a new client
+   * cannot be added without teaching the summarizer about it — the old
+   * "anything not OpenCode must be Pi" branch was a latent bug (§3.2).
+   */
+  summarize: (document: unknown) => { modelCount: number; modelsWithoutLimits: number };
+  /**
+   * Writer-side fragment list (006 §2). Only the builder knows where this
+   * client keeps our entries, so ownership paths originate here and WP2/WP3
+   * consume them rather than re-deriving a single "provider key" path.
+   */
+  buildContribution: BuildContribution;
 }
```

`filename` values change to match each format (`hermes-config.yaml`,
`openclaw.json5`, `kimi-config.toml`, `gajae-models.yaml`); `opencode.json`
and `pi-models.json` are unchanged, so their bytes and download names stay
byte-identical (the regression tests at `tests/client-config-export.test.ts`
pin exactly this).

### 2.2 New public helper

```ts
/** One place that turns a client id + context into the bytes a user gets. */
export function buildClientConfigText(
  client: ExportClientId,
  ctx: ExportContext,
): { document: unknown; text: string; format: ConfigFormat; mediaType: string } {
  const spec = EXPORT_CLIENTS[client];
  const document = spec.build(ctx);
  return {
    document,
    text: serializeDocument(document, spec.format),
    format: spec.format,
    mediaType: FORMAT_MEDIA_TYPE[spec.format],
  };
}
```

`buildClientConfig` stays exactly as-is so `src/cli/opencode.ts` and existing
tests keep compiling.

### 2.3 New constants (env references only — no secret is ever serialized)

```ts
/** Hermes interpolates `${VAR}` anywhere in config.yaml (002 §Hermes). */
export const HERMES_API_KEY_ENV = "OPENCODEX_HERMES_API_KEY";
export const HERMES_API_KEY_ENV_REF = `\${${HERMES_API_KEY_ENV}}`;

/** OpenClaw interpolates ${UPPERCASE_VAR} and fails closed when unset. */
export const OPENCLAW_API_KEY_ENV = "OPENCODEX_OPENCLAW_API_KEY";
export const OPENCLAW_API_KEY_ENV_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

/**
 * Kimi Code reads credentials ONLY from config.toml — it never falls back to
 * shell env (002 §Kimi). A loopback bind needs no real admission key, so we
 * emit the same placeholder Grok uses rather than a user secret. A non-loopback
 * bind is refused by the writer (WP3), not papered over here.
 */
export const KIMI_LOOPBACK_PLACEHOLDER = "opencodex-loopback";

/** Gajae `apiKeyEnv` is env-name-only and fail-closed — the safe field. */
export const GAJAE_API_KEY_ENV = "OPENCODEX_GAJAE_API_KEY";
```

### 2.4 Builders

Each builder consumes `normalizeExportModels(ctx.models)` (dedupe + sort) and
`exportModelLabel` for display names, exactly like the existing two.

**Hermes** (`~/.hermes/config.yaml`, YAML). Emits only the `providers` entry —
never `model.default`, because hijacking the user's main model is out of scope
(004 §5.4 "건드리지 않음" default):

```ts
export interface HermesProviderBlock {
  api: string;                    // http://127.0.0.1:<port>/v1
  api_key: string;                // ${OPENCODEX_HERMES_API_KEY}
  api_mode: "chat_completions";
  discover_models: false;         // we supply the list; skip their probe
  models: string[];               // namespaced selectors
  extra_headers?: Record<string, string>;  // x-opencodex-api-key on non-loopback
}
export interface HermesGeneratedConfig {
  providers: Record<string, HermesProviderBlock>;
}
```

**OpenClaw** (`~/.openclaw/openclaw.json5`, JSON5):

```ts
export interface OpenclawModelEntry { id: string; name: string; contextWindow?: number }
export interface OpenclawProviderBlock {
  baseUrl: string; apiKey: string; api: "openai-completions";
  models: OpenclawModelEntry[]; headers?: Record<string, string>;
}
export interface OpenclawGeneratedConfig {
  models: { mode: "merge"; providers: Record<string, OpenclawProviderBlock> };
}
```

`mode: "merge"` keeps the bundled catalog (002 §OpenClaw). `agents.defaults`
is deliberately absent.

**Kimi Code** (`~/.kimi-code/config.toml`, TOML). Two tables per document:

```ts
export interface KimiProviderBlock { type: "openai"; base_url: string; api_key: string }
export interface KimiModelBlock {
  provider: string; model: string; max_context_size: number;
  display_name?: string;
}
export interface KimiGeneratedConfig {
  providers: Record<string, KimiProviderBlock>;
  models: Record<string, KimiModelBlock>;
}
```

`max_context_size` is **mandatory and positive** (002 §Kimi), so a model with
no authoritative context window is **omitted entirely** rather than guessed —
the "no metadata is guessed" invariant wins over completeness. `capabilities`
is never emitted: our catalog does not assert them, and Kimi's prefix
inference cannot classify routed ids. The omission is documented for the user
in the export hint.

**Gajae Code** (`~/.gjc/agent/models.yml`, YAML). Strict schema — unknown
fields FAIL validation, so the builder emits only schema-known fields:

```ts
export interface GajaeModelEntry {
  id: string; name: string; input: string[];
  contextWindow?: number; maxTokens?: number;
}
export interface GajaeProviderBlock {
  baseUrl: string; apiKeyEnv: string; api: "openai-completions";
  models: GajaeModelEntry[];
}
export interface GajaeGeneratedConfig { providers: Record<string, GajaeProviderBlock> }
```

`apiKeyEnv` (not `apiKey`) because it is env-name-only and fail-closed;
`apiKey` would silently become a literal token when the var is unset (002
§Gajae) — a footgun this project must not ship.

### 2.5 Registry entries

```ts
hermes: {
  id: "hermes", filename: "hermes-config.yaml", format: "yaml",
  destination: env => hermesConfigPath(env),
  apiKeyEnv: HERMES_API_KEY_ENV,
  exportHint: `export ${HERMES_API_KEY_ENV}=<your key>`,
  build: buildHermesClientConfig,
},
// openclaw / kimi / gajae follow the same shape.
```

`hermesConfigPath(env)` honors `HERMES_HOME`, then Windows
`%LOCALAPPDATA%\hermes`, then `~/.hermes` (002 §Hermes; cc-switch's resolution
order in 001 §2). `kimiConfigPath(env)` honors `KIMI_CODE_HOME`.

## 3. Consumer updates

### 3.1 `src/cli/export-command.ts`

```diff
-  const clientConfig = buildClientConfig(client, { baseUrl: proxyV1BaseUrl(root), models, config });
-  const text = JSON.stringify(clientConfig, null, 2);
+  const built = buildClientConfigText(client, { baseUrl: proxyV1BaseUrl(root), models, config });
+  const text = built.text;
```

`--out` still writes `${text}\n`? **No** — `serializeDocument` already ends
with a newline for every format, so the CLI writes `text` verbatim. A test
pins "exactly one trailing newline" for all six clients.

`--json` keeps meaning "machine-readable envelope" and now carries
`{ client, filename, destination, format, text }` so a script never has to
guess the format. This is additive; existing keys are unchanged.

### 3.2 `src/server/management/model-routes.ts`

```diff
-function summarizeExportedModels(client: ExportClientId, document: unknown) {
-  if (client === "opencode") { /* ...OpencodeGeneratedConfig... */ }
-  /* everything else is assumed to be Pi */
-}
+/**
+ * Count models per client without a "whatever is not OpenCode must be Pi"
+ * assumption — that branch was a latent bug the moment a third client existed.
+ * Each client declares how to count its own document.
+ */
+function summarizeExportedModels(client: ExportClientId, document: unknown): {
+  modelCount: number; modelsWithoutLimits: number;
+} {
+  return EXPORT_CLIENTS[client].summarize(document);
+}
```

`summarize` becomes a required `ExportClientSpec` field so a new client cannot
be added without one (compile-time, not review-time).

Envelope gains `format` and `text`; `config` stays for back-compat:

```diff
       exportHint: spec.exportHint,
+      format: built.format,
+      text: built.text,
       ...summarizeExportedModels(requested, document),
       config: document,
```

### 3.3 GUI tuple

`CLIENTS` becomes the six ids; `CLIENT_LABEL_KEYS` gains four keys;
`ClientConfigEnvelope` gains `format: string; text: string`.
`ClientConfigRow.tsx` renders `data.text` instead of
`JSON.stringify(data.config, null, 2)`, and `ClientConfigPanel.tsx` uses the
envelope's media type for the download blob. Full GUI work is WP5/WP6; this
phase changes only what is needed to keep the existing panel correct.

## 4. Tests

`tests/integrations-serialize.test.ts` (NEW)

| Test | Asserts |
|---|---|
| `renders a nested table` | `renderToml({a:{b:"c"}})` parses back via `Bun.TOML.parse` to the same object |
| `quotes keys that are not bare-safe` | a `.`-containing key emits `"..."` and round-trips |
| `throws on an unsupported value` | message names the offending value |
| `every format ends with exactly one newline` | for all four formats |
| `yaml round-trips` | `Bun.YAML.parse(serializeDocument(doc,"yaml"))` deep-equals doc |

`tests/client-config-export.test.ts` (MODIFY)

- Registry assertion moves from "exactly opencode+pi" to "exactly the six ids,
  each with a non-empty filename whose extension matches `format`".
- **No-secret test extended to all six**: serialize with a context whose
  config carries a real-looking key and assert the text contains neither the
  key nor the string `sk-`.
- Byte-stability test runs per client on `built.text` (not `JSON.stringify`).
- OpenCode and Pi goldens unchanged — proves this phase is non-breaking.
- Kimi omission test: a model with no `contextWindow` is absent from
  `[models.*]` and its absence does not remove the provider table.
- Gajae strict-schema test: emitted keys ⊆ the schema-known set.

## 5. Accept criteria

1. `bun run typecheck` clean.
2. `bun test tests/client-config-export.test.ts tests/integrations-serialize.test.ts
   tests/cli-export-command.test.ts tests/management-client-config-route.test.ts` green.
3. `EXPORT_CLIENT_IDS` has six entries; each spec has `format` and `summarize`.
4. OpenCode/Pi output bytes are unchanged from the pre-change goldens.
5. Every emitted document for the four new clients contains an env reference
   or the loopback placeholder, never a credential.
6. `bun run privacy:scan` shows no new findings.
7. `src/cli/opencode.ts` re-exports still compile untouched.

## OPEN QUESTIONS

- Kimi `api.json` registry serving (003 §5 Option B) is deliberately NOT in
  WP1; whether the toggle later prefers the registry path over file writes is
  a WP3 decision.
- Hermes `extra_headers` is emitted only when `shouldInjectApiAuthHeader`
  says the bind is non-loopback; the exact header set for a non-loopback
  Hermes bind is unverified against a live install (002 marks Hermes literal
  vs env acceptance as documented-but-untested).
