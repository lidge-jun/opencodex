/**
 * Curated facts the client registries do not carry, consumed by
 * scripts/generate-client-support-matrix.ts. Every claim here is re-checked against the code
 * when the page is generated, so a stale entry fails generation instead of shipping:
 *
 * - protocolFields: the config field(s) that carry each client's wire protocol. The generator
 *   builds the client's real export with a fixture catalog, reads every value at each path, and
 *   fails when a path yields nothing or a value is missing from the map.
 * - clientSelected: the exported field names a protocol family and the client picks the endpoint.
 *   These are reviewed claims; reviewedSha pins the exporter file, so any edit to it asks for a
 *   fresh review (update the hash after re-reading the builder).
 * - test: a reviewed test case that asserts this client's generated config or integration
 *   behavior. The generator only checks that the case exists, is not disabled, and names the
 *   client; it does not prove what the case asserts.
 *
 * Adding a client: add an entry here, then run `bun run docs:clients`.
 */

export type MatrixProtocol = "responses" | "chat-completions" | "anthropic-messages" | "openai-compatible";

export interface ProtocolField {
  /** Dotted path into the built config; `*` matches any key or array index. */
  path: string;
  /** Exact value -> protocol, or (match: "suffix") a value suffix -> protocol. */
  values: Readonly<Record<string, MatrixProtocol>>;
  match?: "exact" | "suffix";
}

export interface TestReference {
  file: string;
  title: string;
  /** At least one of these must appear in the test case body. */
  mentions: readonly string[];
}

export interface ExportClientMetadata {
  label: string;
  protocolFields: readonly ProtocolField[];
  nativeOpenaiOverride?: NativeOpenaiOverride;
  clientSelected?: { file: string; anchor: string; reviewedSha: string };
  test?: TestReference;
  guide?: string;
}

/** A sentence or statement that must still be present in the implementing file. */
export interface SourceAnchor {
  file: string;
  text: string;
}

/**
 * The provider default applies to every model except the native OpenAI model, whose entry
 * carries this override. Checked model by model against the fixture catalog.
 */
export interface NativeOpenaiOverride {
  modelsPath: string;
  idKey: string;
  field: string;
  value: string;
  protocol: MatrixProtocol;
}

export interface NativeClientMetadata {
  label: string;
  /** Curated from the native integration; each anchor must still be present in its file. */
  protocols: readonly MatrixProtocol[];
  anchors: readonly SourceAnchor[];
  test?: TestReference;
  guide?: string;
}

const CHAT_API = { "openai-completions": "chat-completions" } as const;
const providersApi = (path = "providers.opencodex.api"): ProtocolField[] => [{ path, values: CHAT_API }];
const OPENAI_FAMILY = { "openai-compatible": "openai-compatible", openai: "openai-compatible" } as const;
const AI_SDK = { "@ai-sdk/openai-compatible": "chat-completions" } as const;

export const EXPORT_CLIENT_METADATA: Readonly<Record<string, ExportClientMetadata>> = {
  qoder: {
    label: "Qoder",
    protocolFields: [{ path: "providers.opencodex.type", values: OPENAI_FAMILY }, { path: "providers.opencodex.protocol", values: OPENAI_FAMILY }],
    test: { file: "tests/clients/qoder-client.test.ts", title: "exports only the provider catalog with normalized model order and context limits", mentions: ["qoder"] },
  },
  "qoder-cn": {
    label: "Qoder CN",
    protocolFields: [{ path: "providers.opencodex.type", values: OPENAI_FAMILY }, { path: "providers.opencodex.protocol", values: OPENAI_FAMILY }],
  },
  workbuddy: {
    label: "WorkBuddy",
    protocolFields: [{ path: "models.*.url", values: { "/chat/completions": "chat-completions" }, match: "suffix" }],
    test: { file: "tests/clients/agent-clients.test.ts", title: "WorkBuddy exports canonical selectors, full chat URL and declared capabilities only", mentions: ["workbuddy"] },
  },
  "workbuddy-ai": {
    label: "WorkBuddy AI",
    protocolFields: [{ path: "models.*.url", values: { "/chat/completions": "chat-completions" }, match: "suffix" }],
  },
  opencode: {
    label: "OpenCode",
    protocolFields: [{ path: "provider.opencodex.npm", values: AI_SDK }],
    test: { file: "tests/config/client-config-export.test.ts", title: "carries the V1 schema and only the opencodex provider key", mentions: ["opencode"] },
    guide: "guides/opencode",
  },
  pi: {
    label: "Pi",
    protocolFields: providersApi(),
    test: { file: "tests/config/client-config-export.test.ts", title: "tells Pi to send system instead of developer, on export and contribution alike (#5664)", mentions: ["\"pi\""] },
    guide: "guides/pi",
  },
  omp: {
    label: "Oh My Pi (omp)",
    protocolFields: providersApi(),
    nativeOpenaiOverride: { modelsPath: "providers.opencodex.models", idKey: "id", field: "api", value: "openai-responses", protocol: "responses" },
    test: { file: "tests/config/client-config-export.test.ts", title: "keeps the provider on completions while opting native OpenAI models into Responses", mentions: ["omp"] },
  },
  hermes: {
    label: "Hermes",
    protocolFields: [{ path: "providers.opencodex.api_mode", values: { chat_completions: "chat-completions" } }],
    test: { file: "tests/clients/hermes-catalog-refresh.test.ts", title: "a connected Hermes block refreshes its models and keeps unrelated YAML bytes and comments", mentions: ["hermes"] },
  },
  openclaw: {
    label: "OpenClaw",
    protocolFields: providersApi("models.providers.opencodex.api"),
    test: { file: "tests/gui/integrations-invariants.test.ts", title: "OPENCLAW_CONFIG_PATH is where apply writes and disable removes", mentions: ["openclaw"] },
  },
  kimi: {
    label: "Kimi CLI",
    protocolFields: [{ path: "providers.opencodex.type", values: OPENAI_FAMILY }],
    test: { file: "tests/config/client-config-export-new-clients.test.ts", title: "uses the loopback placeholder because Kimi reads no environment", mentions: ["kimi"] },
  },
  gajae: {
    label: "Gajae",
    protocolFields: providersApi(),
    test: { file: "tests/clients/client-export-modality-enum.test.ts", title: "audio is dropped from a mixed Gajae entry rather than written through", mentions: ["gajae"] },
  },
  dsh: {
    label: "DSH",
    protocolFields: [{ path: "llm-pi-ai.providers.opencodex.api", values: { "openai-responses": "responses" } }],
    test: { file: "tests/config/client-config-export.test.ts", title: "owns only llm-pi-ai.providers.opencodex with a loopback Responses profile", mentions: ["dsh"] },
  },
  mcode: {
    label: "MCode",
    protocolFields: [{ path: "custom_provider.opencodex.api", values: { "anthropic-messages": "anthropic-messages" } }],
  },
  zcode: {
    label: "ZCode",
    protocolFields: [{ path: "provider.opencodex.kind", values: { openai: "responses" } }],
    clientSelected: {
      file: "src/clients/config-export/zcode.ts",
      anchor: "`kind: \"openai\"` selects the OpenAI Responses protocol",
      reviewedSha: "3b2c3e6eefb5e382510db754920fe5bc9ba47c2c9db8a6a17e715b04eeb070c5",
    },
    test: { file: "tests/clients/integrations-current-store.test.ts", title: "enable puts the intended provider in the store, and leaves the config file alone", mentions: ["zcode"] },
  },
  commandcode: {
    label: "Command Code",
    protocolFields: providersApi("provider.opencodex.api"),
    test: { file: "tests/clients/command-code-client.test.ts", title: "adds only provider.opencodex, wired to the loopback proxy", mentions: ["commandcode", "CommandCode"] },
  },
  prime: {
    label: "Prime",
    protocolFields: providersApi(),
    test: { file: "tests/clients/prime-client.test.ts", title: "adds only providers.opencodex, wired to the loopback proxy", mentions: ["prime", "Prime"] },
  },
  aside: {
    label: "Aside",
    protocolFields: providersApi(),
    test: { file: "tests/clients/aside-profiles-catalog-refresh.test.ts", title: "catalog refreshOnly updates the owned Aside profile and leaves its unowned peer alone", mentions: ["aside", "Aside"] },
  },
  raycast: {
    label: "Raycast",
    protocolFields: [{ path: "providers.*.base_url", values: { "/v1": "chat-completions" }, match: "suffix" }],
    clientSelected: {
      file: "src/clients/config-export/raycast.ts",
      anchor: "Raycast appends `/chat/completions` to `base_url`",
      reviewedSha: "624cf5c2acf9e5ad9fb2da54e8a3b80a6ec3c2dfc0303c1724497788d51d222c",
    },
    test: { file: "tests/clients/raycast-client.test.ts", title: "emits one provider element with the documented field vocabulary", mentions: ["raycast", "Raycast"] },
  },
  omo: {
    label: "omo",
    protocolFields: providersApi(),
    test: { file: "tests/clients/omo-client.test.ts", title: "adds only providers.opencodex, wired to the loopback proxy", mentions: ["omo"] },
  },
  cline: {
    label: "Cline",
    protocolFields: [
      { path: "settings.providers.opencodex.settings.protocol", values: { "openai-responses": "responses" } },
      { path: "catalog.providers.opencodex.provider.protocol", values: { "openai-responses": "responses" } },
    ],
    test: { file: "tests/clients/cline-client.test.ts", title: "emits separate native documents with canonical selectors and no invented limits", mentions: ["cline", "Cline"] },
  },
  kilo: {
    label: "Kilo Code",
    protocolFields: [{ path: "provider.opencodex.npm", values: AI_SDK }],
    test: { file: "tests/clients/client-export-reasoning-controls.test.ts", title: "both generations and Kilo preserve limits, defaults, capabilities and exact effort choices", mentions: ["kilo"] },
  },
  droid: {
    label: "Factory Droid",
    protocolFields: [{ path: "customModels.*.provider", values: { "generic-chat-completion-api": "chat-completions" } }],
    test: { file: "tests/clients/droid-client.test.ts", title: "exports only supported fields with a keyless loopback gateway", mentions: ["droid", "Droid"] },
    guide: "guides/factory-droid",
  },
  "gentle-shell": {
    label: "Gentle Shell",
    protocolFields: providersApi(),
    test: { file: "tests/clients/gentle-shell-client.test.ts", title: "Gentle Shell export reuses Pi protocol and stamps independent ownership", mentions: ["gentle-shell"] },
  },
  t3code: {
    label: "T3 Code",
    protocolFields: [{ path: "providerInstances.opencodex.driver", values: { claudeAgent: "anthropic-messages" } }],
    test: { file: "tests/clients/t3code-client.test.ts", title: "the provider instance routes T3 Code's Claude driver through the proxy origin with a non-secret marker", mentions: ["t3code", "T3"] },
  },
};

/**
 * Native owners. Keys must equal the NativeIntegrationClientId union in
 * src/server/management/native-integration-routes.ts; the generator parses that declaration and
 * fails on any difference in either direction.
 */
export const NATIVE_CLIENT_METADATA: Readonly<Record<string, NativeClientMetadata>> = {
  codex: {
    label: "Codex (CLI, app, SDK)",
    protocols: ["responses"],
    anchors: [{ file: "src/codex/inject/config-toml.ts", text: "`openai_base_url = \"http://${providerBaseHost(hostname)}:${portOrTarget}/v1\"`" }],
    test: { file: "tests/codex-integration/codex-inject-missing-config.test.ts", title: "a Codex home without config.toml is bootstrapped and routed", mentions: ["runInject"] },
    guide: "guides/codex-integration",
  },
  claude: {
    label: "Claude Code",
    protocols: ["anthropic-messages"],
    anchors: [{ file: "src/cli/claude.ts", text: 'setDefault("ANTHROPIC_BASE_URL", managedBaseUrl);' }],
    test: { file: "tests/claude-integration/claude-cli.test.ts", title: "routes unless configured or live Claude routing is explicitly disabled", mentions: ["Claude", "claude"] },
    guide: "guides/claude-code",
  },
  "claude-desktop": {
    label: "Claude Desktop",
    protocols: ["anthropic-messages"],
    anchors: [{ file: "src/claude/desktop-3p.ts", text: 'inferenceProvider: "gateway",' }],
  },
  grok: {
    label: "Grok Build",
    protocols: ["responses"],
    anchors: [{ file: "src/grok/inject.ts", text: "'api_backend = \"responses\"'," }],
    test: { file: "tests/providers/xai/grok-config-inject.test.ts", title: "creates and strips a fresh config", mentions: ["injectGrokConfig", "grok"] },
    guide: "guides/grok-build",
  },
};


