import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoPath } from "./repo-root";
const hooks = {
  upstreamLoads: 0, upstreamHits: 0, nativeLoads: 0, nativeHits: 0, verdictLoads: 0,
  admittedRecords: 0, collectedMatches: 0, admissions: [] as boolean[],
  redInputs: [] as { path: string; marker: boolean }[],
  redFilterChecks: [] as { forward: boolean; backward: boolean }[],
};
(globalThis as typeof globalThis & { __fixtureHooks: typeof hooks }).__fixtureHooks = hooks;
const portable = (path: string) => path.replaceAll("\\", "/");
function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw new Error("Fixture anchor missing or duplicated: " + anchor);
  return source.replace(anchor, replacement);
}
function readOriginal(path: string): string {
  const rel = relative(repoPath(), path);
  const exported = process.env.MESSAGES_RED_SOURCE && join(process.env.MESSAGES_RED_SOURCE, rel);
  const red = !!exported && existsSync(exported);
  const contents = readFileSync(red ? exported! : path, "utf8");
  if (red) hooks.redInputs.push({ path: portable(rel), marker: contents.includes("L7_RED_SOURCE_MARKER") });
  return contents;
}
if (process.env.MESSAGES_RED_SOURCE) {
  const instrumented = new Set(["src/server/claude-messages.ts", "src/server/messages-native.ts", "src/claude/failure-verdict.ts"]);
  const paths = [...new Bun.Glob("src/**/*.ts").scanSync(process.env.MESSAGES_RED_SOURCE)].filter(path => !instrumented.has(portable(path)));
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = new RegExp("^(?:" + paths.map(path => portable(repoPath(path)).split("/").map(escape).join("[\\\\/]")).join("|") + ")$");
  hooks.redFilterChecks = paths.map(path => {
    const candidate = portable(repoPath(path));
    return { forward: filter.test(candidate), backward: filter.test(candidate.replaceAll("/", "\\")) };
  });
  Bun.plugin({ name: "935199a98 red source", setup(build) {
    build.onLoad({ filter }, ({ path }) => ({ contents: readOriginal(path), loader: "ts" }));
  } });
}
const kind = process.argv[2]!;
const filters = {
  upstream: /src[\\/]server[\\/]claude-messages\.ts$/,
  native: /src[\\/]server[\\/]messages-native\.ts$/,
  verdict: /src[\\/]claude[\\/]failure-verdict\.ts$/,
};
const filterChecks = Object.fromEntries(Object.entries(filters).map(([name, filter]) => {
  const suffix = name === "upstream" ? "src/server/claude-messages.ts" : name === "native" ? "src/server/messages-native.ts" : "src/claude/failure-verdict.ts";
  return [name, { forward: filter.test("/fixture/" + suffix), backward: filter.test("C:\\fixture\\" + suffix.replaceAll("/", "\\")) }];
}));
Bun.plugin({ name: "Messages refusal boundary fixture", setup(build) {
  build.onLoad({ filter: filters.upstream }, ({ path }) => {
    hooks.upstreamLoads++;
    return { loader: "ts", contents: replaceOnce(readOriginal(path),
      "const upstream = await handleResponses(internalReq, {",
      "const upstream = globalThis.__localRefusalReply ? (globalThis.__fixtureHooks.upstreamHits++, globalThis.__localRefusalReply) : await handleResponses(internalReq, {") };
  });
  build.onLoad({ filter: filters.native }, ({ path }) => {
    hooks.nativeLoads++;
    return { loader: "ts", contents: replaceOnce(readOriginal(path),
      "const proactiveKeyProvider = selectProactiveApiKeyTransport(config, route.providerName, route.provider);",
      "const proactiveKeyProvider = globalThis.__nativePacingPreflight ? (() => { globalThis.__fixtureHooks.nativeHits++; throw globalThis.__nativePacingPreflight; })() : selectProactiveApiKeyTransport(config, route.providerName, route.provider);") };
  });
  build.onLoad({ filter: filters.verdict }, ({ path }) => {
    hooks.verdictLoads++;
    const admission = "  if (sink) (sink.delivered ??= []).push({ client: JSON.stringify(client), legacy });";
    const observed = replaceOnce(readOriginal(path), admission,
      "  globalThis.__fixtureHooks.admissions.push(Boolean(sink));\n  if (sink) (globalThis.__observedSinks ??= []).push(sink);\n" + admission
      + "\n  if (sink) globalThis.__fixtureHooks.admittedRecords += sink.delivered?.length ?? 0;");
    return { loader: "ts", contents: replaceOnce(observed,
      "    sink.collectedProjection = true;",
      "    sink.collectedProjection = true;\n    if (sink.collected === next.legacy) globalThis.__fixtureHooks.collectedMatches++;") };
  });
} });
const { handleClaudeMessages, handleClaudeCountTokens } = await import("../../src/server/claude-messages");
const { markProxyError } = await import("../../src/lib/client-error-body");
const { formatErrorResponse } = await import("../../src/bridge/errors");
const { saveConfig } = await import("../../src/config");
const KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
let config: any = { defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", apiKey: "synthetic", baseUrl: "http://127.0.0.1:1", allowPrivateNetwork: true, models: ["model"] } } };
let model = "fixture/model"; let absent = KEY; let produced: Response | undefined;
let expectedBody: string | undefined;
if (kind.startsWith("native-pacing")) {
  (await import("./owned-spend-home")).acquireOwnedSpendHome();
  const { RequestPacingQueueOverloadError } = await import("../../src/providers/request-pacing");
  const error = new RequestPacingQueueOverloadError("anthropic", "queue_full", 1);
  absent = "provider 'anthropic'";
  config.providers.fixture.adapter = "anthropic"; config.providers.fixture.authMode = "key";
  config.providers.fixture.fetch = async () => { throw error; };
  config.protocols = { rollout: { managedMessagesNative: true } };
  if (kind === "native-pacing-preflight") (globalThis as any).__nativePacingPreflight = error;
} else if (kind === "deep" || kind === "usage" || kind.startsWith("body-")) {
  expectedBody = kind === "deep" ? '{"data":' + '['.repeat(100000) + '0' + ']'.repeat(100000) + '}' : '{"usage":{"input_tokens":42,"output_tokens":7}}';
  config = { providers: {}, claudeCode: { anthropicBaseUrl: "http://127.0.0.1:1", ...(kind.startsWith("body-overflow") ? { bodyMaxBytes: 314159 } : {}), ...(kind === "body-stall" ? { bodyStallSec: 1 } : {}) } }; model = "claude-sonnet-4-6";
  if (kind.startsWith("body-overflow")) { expectedBody = "x".repeat(314160); absent = "314159"; }
  if (kind === "body-stall") absent = "1s";
  globalThis.fetch = (async () => new Response(kind === "body-stall" ? new ReadableStream({ pull() {} }) : expectedBody, { headers: { "content-type": "application/json" } })) as typeof fetch;
} else if (kind === "sink") {
  produced = new Response('event: response.failed\ndata: '+JSON.stringify({ type: "response.failed", response: { error: { message: KEY, type: "server_error" } } })+'\n\n', { headers: { "content-type": "text/event-stream" } });
} else if (kind === "sink-direct") {
  // The delivery layer chooses whether collection owns a legacy-record sink.
} else if (kind.startsWith("roster") || kind === "chat-roster" || kind === "oauth-login") {
  const { saveCredential, getAccountSet } = await import("../../src/oauth/store");
  const { recordAntigravityAccountRoster } = await import("../../src/providers/antigravity-account-roster");
  const { setCached } = await import("../../src/codex/model-cache");
  const provider = "google-antigravity"; model = `${provider}/${KEY}`;
  config = { defaultProvider: provider, providers: { [provider]: { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist", fetch: async () => { throw new Error("Fixture must not dispatch"); } } } };
  if (kind !== "oauth-login") {
    await saveCredential(provider, { access: "synthetic", refresh: "synthetic-refresh", expires: Date.now() + 3600000, projectId: "synthetic-project", source: "oauth" });
    recordAntigravityAccountRoster(provider, getAccountSet(provider)!.activeAccountId, [{ id: "other", wireModelId: "other" } as never]);
    setCached(provider, [{ id: KEY } as never]);
  } else absent = provider;
} else if (kind === "scope-direct") {
  model = `fixture/${KEY}`; config.providers.fixture.models = [KEY];
  config.apiKeys = [{ id: "scoped", name: "fixture", key: "synthetic-scope", createdAt: "2026-01-01T00:00:00Z", allowedModels: ["other"], allowedProviders: [] }];
} else if (kind === "copilot") {
  (await import("./owned-spend-home")).acquireOwnedSpendHome();
  const calls: string[] = []; (globalThis as any).__copilotCalls = calls;
  const executor = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === "/models") return Response.json({ data: [{ id: "gpt-4o", model_picker_enabled: false, supported_endpoints: ["/chat/completions"] }] });
    if (path === "/models/session") return Response.json({ error: KEY }, { status: 403 });
    throw new Error("Unexpected Copilot fixture dispatch");
  }) as typeof fetch;
  config = { defaultProvider: "github-copilot", providers: { "github-copilot": { adapter: "openai-chat", authMode: "key", apiKey: "synthetic", baseUrl: "https://api.githubcopilot.com", models: ["auto"], fetch: executor } } };
  globalThis.fetch = executor; model = "github-copilot/auto"; absent = "403";
} else if (kind === "kiro-continuation") {
  const { createAdapterContinuations } = await import("../../src/server/responses/adapter-continuation");
  const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
  const { AdmissionModelDeniedError, admissionModelDeniedResponse } = await import("../../src/server/admission-model-scope");
  const { clientFacingModelLabel } = await import("../../src/lib/error-destination");
  const { encodeAnthropicMessageSse } = await import("../../src/protocols/encoders/messages");
  const translatorBudget = createTranslatorBudget(); const logCtx = {}; const parsed: any = { modelId: "fixture", stream: true, options: {}, context: { messages: [] } };
  const route = { providerName: "kiro", modelId: "fixture", provider: { adapter: "anthropic", authMode: "key", apiKey: "synthetic", baseUrl: "https://kiro.fixture.test" } };
  const refused = admissionModelDeniedResponse(new AdmissionModelDeniedError(clientFacingModelLabel(KEY), { providerName: "kiro", modelId: "fixture" }));
  let fetched = 0;
  const continuations = createAdapterContinuations({ options: {}, config: { providers: {} }, logCtx } as any,
    { route, translatorBudget, inboundWire: "messages", parsed, selectedForwardHeaders: new Headers() } as any,
    { activeAdapter: { name: "anthropic", buildRequest: () => ({ url: route.provider.baseUrl, method: "POST", headers: {}, body: "{}" }), fetchResponse: async () => { fetched++; return refused; } }, imageTierBias: 0, oauthDispatch() {}, noteRoutedAttemptSend() {} } as any,
    {} as any, { sendBudgetExhausted: () => false } as any,
    { upstream: new AbortController(), connectMs: 0, rateLimitPolicy: null, thinkingSignatureRecovery: { prepareHttp: async () => false } } as any);
  const response = new Response(encodeAnthropicMessageSse(continuations.fetchTerminalGuardContinuation(parsed), { model: "fixture", translatorBudget, proxyErrorContext: logCtx }));
  const text = await response.text(); translatorBudget.dispose();
  console.log("REFUSAL_RESULT " + JSON.stringify({ status: response.status, text, absent: KEY, code: null, fetched, hooks })); process.exit(0);
} else if (kind === "discovery" || kind === "muse") {
  const oauth = await import("../../src/oauth");
  const { AntigravityProjectDiscoveryError } = await import("../../src/oauth/antigravity-discovery-diagnostics");
  const { MuseLoginError } = await import("../../src/oauth/meta-muse-errors");
  const error = kind === "muse" ? new MuseLoginError("validation-http", 418) : new AntigravityProjectDiscoveryError();
  if (error instanceof AntigravityProjectDiscoveryError) error.observe("loadCodeAssist", 418, {});
  produced = (markProxyError as any)(formatErrorResponse(401, "authentication_error", oauth.publicOAuthAuthenticationErrorMessage(error)), (oauth as any).publicOAuthErrorPresentation?.(error)); absent = "418";
} else if (kind === "native-usage") {
  const { runMessagesOverflowCase } = await import("./messages-overflow-case");
  const row = await runMessagesOverflowCase("native-http", { id: "local-usage", message: "fixture", fault: "usage-limit", classification: { "native-http": "error" }, recovery: { "native-http": false } });
  console.log("REFUSAL_RESULT " + JSON.stringify({ status: row.status, text: row.text, absent: "1970", code: row.code ?? null, hooks })); process.exit(0);
} else if (kind === "provider") {
  produced = Response.json({ error: { type: "permission_error", message: KEY }, proxyAuthored: true, presentation: "roster" }, { status: 403 });
} else if (kind === "pacing") {
  const { requestPacingOverloadResponse } = await import("../../src/server/responses/pacing-overload");
  const { RequestPacingQueueOverloadError } = await import("../../src/providers/request-pacing");
  produced = requestPacingOverloadResponse(new RequestPacingQueueOverloadError("anthropic", "queue_full", 1))!; absent = "anthropic";
} else if (kind === "scope") {
  const { AdmissionModelDeniedError, admissionModelDeniedResponse } = await import("../../src/server/admission-model-scope");
  const { clientFacingModelLabel } = await import("../../src/lib/error-destination");
  produced = admissionModelDeniedResponse(new AdmissionModelDeniedError(clientFacingModelLabel(KEY), { providerName: "fixture", modelId: "model" }));
} else if (kind === "combo-count") {
  const { comboUnavailable } = await import("../../src/server/responses/core-errors");
  produced = comboUnavailable(KEY, Date.now(), "provider disabled: 3" as never); absent = "3";
} else if (kind === "combo") {
  const { comboUnavailable } = await import("../../src/server/responses/core-errors"); produced = comboUnavailable(KEY);
} else if (kind === "config") {
  const { UnsupportedOAuthProviderError } = await import("../../src/oauth/oauth-errors");
  const error = new UnsupportedOAuthProviderError(KEY);
  produced = (markProxyError as any)(formatErrorResponse(400, "invalid_request_error", `${error.message}. Remove or reconfigure provider '${KEY}' in the OpenCodex configuration.`), "config");
} else if (kind === "workflow" || kind === "workflow-unbound") {
  const { workflowRefusalResponse } = await import("../../src/server/workflow-refusal");
  produced = workflowRefusalResponse("workflow-spend-exhausted", undefined, undefined, undefined, { scope: "identity", limit: 987654321, projected: 987654322, ...(kind === "workflow-unbound" ? { includesUnboundPoolHistory: true } : {}) }); absent = "987,654,321";
} else if (["cooldown", "cooldown-unpinned", "hard-lock", "recovery"].includes(kind)) {
  const { mapCodexAuthContextErrorToResponse } = await import("../../src/server/responses/codex-auth-error");
  const { CodexAccountCooldownError, CodexMainAccountHardLockError, CodexRecoveryWithheldError } = await import("../../src/codex/auth-context");
  const until = Date.now() + 100000;
  const error = kind === "hard-lock" ? new CodexMainAccountHardLockError(until, { short: 71, long: 93 }) : kind === "recovery" ? new CodexRecoveryWithheldError(KEY, until) : new CodexAccountCooldownError(KEY, until);
  produced = mapCodexAuthContextErrorToResponse(error, { accountSelector: kind === "cooldown" ? KEY : undefined, now: Date.now() })!;
  if (kind === "hard-lock") absent = "71%";
  else if (kind !== "cooldown") absent = new Date(until).toISOString();
} else if (kind === "pool-refresh") {
  const { poolCredentialRefreshIncompleteResponse } = await import("../../src/server/responses/core-auth");
  produced = poolCredentialRefreshIncompleteResponse({ authCtx: { accountId: "fixture" } as never, config: {}, accountSelector: KEY });
} else if (kind === "storage") {
  const { SpendLedgerFileRefusedError } = await import("../../src/lib/spend-reservation-ledger");
  const { spendLedgerStorageErrorResponse } = await import("../../src/server/responses/spend-storage-error");
  produced = spendLedgerStorageErrorResponse(new SpendLedgerFileRefusedError("journal", "extra-hard-link"))!;
} else if (kind === "model") {
  const { CodexModelAvailabilityError } = await import("../../src/codex/auth-context");
  const { codexModelAvailabilityErrorResponse } = await import("../../src/server/responses/codex-auth-error");
  produced = codexModelAvailabilityErrorResponse(new CodexModelAvailabilityError("unsupported", `The requested model ${KEY} is unavailable`));
} else if (kind === "input") {
  config.providers.fixture.contextWindow = 16;
} else {
  const table: Record<string, [number, string, string]> = {
    outbound: [413, "outbound_body_too_large", `Request body exceeds the configured byte limit ${KEY}`],
    inbound: [413, "inbound_body_too_large", `Request body exceeds the configured byte limit ${KEY}`],
    send: [429, "request_send_budget_exhausted", `request send budget exhausted before dispatch (${KEY})`],
    model: [400, "invalid_request_error", `The requested model ${KEY} is unavailable`],
    storage: [503, "spend_ledger_storage_unavailable", `Spend-ledger storage could not be opened safely (${KEY})`],
  };
  const [status, code, message] = table[kind]!;
  produced = (markProxyError as any)(formatErrorResponse(status, code, message), kind === "model" ? "model_availability" : kind);
}
if (produced) (globalThis as any).__localRefusalReply = produced;
const collectedUpstream = kind === "sink" ? produced?.clone() : undefined;
saveConfig(config);
const logCtx: any = { model: "fixture", provider: "fixture" };
const req = new Request(`http://localhost/v1/messages${["roster-count", "body-overflow-count"].includes(kind) ? "/count_tokens" : ""}`, { method: "POST", headers: { "content-type": "application/json", ...((kind === "deep" || kind === "usage" || kind.startsWith("body-")) ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}) }, body: JSON.stringify({ model, max_tokens: 16, stream: kind === "sink", messages: [{ role: "user", content: kind === "input" ? "a".repeat(4000) : "fixture" }] }) });
const direct = kind === "sink-direct" ? await (async () => {
  const { deliverClientEncodedResponse } = await import("../../src/server/inference/client-encoder-delivery");
  const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
  return deliverClientEncodedResponse({ encoder: { protocol: "messages", stream: true, model: "fixture" }, events: (async function* () { yield { type: "error", status: 500, message: KEY } as any; })(), translatorBudget: createTranslatorBudget(), logCtx, responseModelId: "fixture", adapterName: "openai-chat", fold: {}, stopUpstream() {}, onStreamDone() {}, onCompletedResponse() {}, bindUsage() {} });
})() : undefined;
const chat = kind === "chat-roster" ? await (await import("../../src/server/chat-completions")).handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "fixture" }], stream: false }) }), config, logCtx) : undefined;
const response = chat ?? direct ?? (["roster-count", "body-overflow-count"].includes(kind) ? await handleClaudeCountTokens(req, config) : await handleClaudeMessages(req, config, logCtx, kind === "scope-direct" ? { requestId: crypto.randomUUID(), start: Date.now(), admission: { kind: "configured", keyId: "scoped", source: "bearer" } } : undefined));
const text = await response.text();
const observations = globalThis as typeof globalThis & { __localRefusalReply?: Response; __observedSinks?: { delivered?: unknown[] }[]; __copilotCalls?: string[] };
const retainedCount = () => [...new Set(observations.__observedSinks ?? [])].reduce((n, sink) => n + (sink.delivered?.length ?? 0), 0);
const streaming = kind.startsWith("sink") ? { admissions: [...hooks.admissions], retained: retainedCount() } : undefined;
let collected: { status: number; textLength: number } | undefined;
if (collectedUpstream) {
  observations.__localRefusalReply = collectedUpstream;
  const collectedRequest = new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }),
  });
  const collectedResponse = await handleClaudeMessages(collectedRequest, config, { model: "fixture", provider: "fixture" });
  collected = { status: collectedResponse.status, textLength: (await collectedResponse.text()).length };
}
console.log("REFUSAL_RESULT " + JSON.stringify({ status: response.status, text, absent, code: kind.startsWith("sink") ? null : JSON.parse(text).error?.code ?? null, retained: retainedCount(), expectedBody, copilotCalls: observations.__copilotCalls, usage: logCtx.usage, hooks, filterChecks, streaming, collected }));
