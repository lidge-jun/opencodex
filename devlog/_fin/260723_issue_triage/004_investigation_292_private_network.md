# Issue #292 investigation — private-network policy and model discovery

Date: 2026-07-23  
Scope: source/test inspection only; no implementation  
Issue: `allowPrivateNetwork: true` allegedly ignored by custom-provider `GET /v1/models` discovery

## Executive finding

The reported user-visible failure is credible, but the proposed cause is not present in the current `origin/dev` code. Model discovery does **not** call the destination policy at all, and the complete provider object (including `allowPrivateNetwork`) survives config loading and discovery enrichment. A discovery call made against `198.18.0.1` is attempted whether the flag is `true` or `false`. Therefore #292 is **not confirmed as an “allowPrivateNetwork ignored by the discovery guard” bug**.

There are two adjacent OpenCodex defects:

1. discovery has the opposite policy-parity problem: it performs a raw fetch without any destination-policy check; and
2. a successful HTTP response with a non-JSON body is parsed with `Response.json()`, then reduced to the unhelpful log label `SyntaxError`.

The second defect exactly explains the reported symptom. It indicates a 2xx non-JSON response (for example from a proxy, WAF, or block page), not an exception thrown by OpenCodex's destination guard.

## Evidence anchors

### A1 — blocked destination classes

`src/lib/destination-policy.ts:49-68`:

```ts
function classifyIpv4(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV4.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const octets = parseIpv4(hostname);
  if (!octets) return { kind: "public", detail: "public IP" };
  const [a, b, c] = octets;
  if (a === 127) return { kind: "loopback", detail: "loopback address" };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return { kind: "private", detail: "private-network address" };
  }
  if (a === 169 && b === 254) return { kind: "link-local", detail: "link-local address" };
  if (a === 0) return { kind: "unspecified", detail: "unspecified address" };
  // Reserved / non-public ranges (review finding, PR #96): protocol-assignment,
  // documentation, benchmark, multicast, and reserved-future space never name a
  // legitimate provider endpoint.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return { kind: "private", detail: "reserved address" };
  if (a === 198 && (b === 18 || b === 19)) return { kind: "private", detail: "benchmark address" };
  if (a === 198 && b === 51 && c === 100) return { kind: "private", detail: "documentation address" };
  if (a === 203 && b === 0 && c === 113) return { kind: "private", detail: "documentation address" };
  if (a >= 224) return { kind: "private", detail: "multicast/reserved address" };
  return { kind: "public", detail: "public IP" };
}
```

This blocks IPv4 loopback (`127/8`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`), unspecified (`0/8`), selected protocol/documentation ranges, `198.18.0.0/15` benchmarking space, and multicast/reserved space (`224/4`). The exact metadata IPs are listed separately at `src/lib/destination-policy.ts:12-20`:

```ts
const BLOCKED_METADATA_IPV4 = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
]);

const BLOCKED_METADATA_IPV6 = new Set([
  "fd00:ec2::254",
]);
```

IPv6 loopback, unspecified, unique-local, link-local, and IPv4-mapped forms are classified at `src/lib/destination-policy.ts:78-88`:

```ts
function classifyIpv6(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV6.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedIpv4) return classifyIpv4(mappedIpv4);
  if (hostname === "::1") return { kind: "loopback", detail: "loopback address" };
  if (hostname === "::") return { kind: "unspecified", detail: "unspecified address" };
  const hextet = firstIpv6Hextet(hostname);
  if (hextet === null) return { kind: "public", detail: "public IP" };
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return { kind: "private", detail: "private-network address" };
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return { kind: "link-local", detail: "link-local address" };
  return { kind: "public", detail: "public IP" };
}
```

### A2 — the opt-in bypass is explicit

`src/lib/destination-policy.ts:113-125`:

```ts
export function providerDestinationConfigError(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): string | null {
  const assessment = assessDestination(provider.baseUrl);
  if (!assessment) return null;
  if (assessment.kind === "public" || assessment.kind === "hostname") return null;
  if (assessment.kind === "metadata") return "baseUrl targets a blocked metadata endpoint";
  if (registryAllowsPrivateNetwork(name)) return null;
  if (provider.allowPrivateNetwork === true) return null;
  return `baseUrl points to a ${assessment.detail}; set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
}

export function assertProviderDestinationAllowed(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): void {
  const error = providerDestinationConfigError(name, provider);
  if (error) throw new Error(`provider ${name} ${error}`);
}
```

The explicit opt-in bypasses non-metadata literal destinations. A direct metadata hostname/IP remains blocked because the metadata check precedes the opt-in. Built-in local/self-hosted presets have a separate registry bypass; examples are verbatim at `src/providers/registry.ts:667-669`:

```ts
{ id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
{ id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
{ id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — no key needed" },
```

The asynchronous write-time check also short-circuits before DNS when the opt-in is set. `src/lib/destination-policy.ts:149-164`:

```ts
if (!hostname || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost")) {
  return null; // literals and localhost are fully handled by the sync path
}
if (registryAllowsPrivateNetwork(name) || provider.allowPrivateNetwork === true) return null;
let addresses: { address: string }[];
try {
  addresses = await lookup(hostname, { all: true, verbatim: true });
} catch {
  return null; // unresolvable now ≠ malicious; the provider simply won't connect
}
for (const { address } of addresses) {
  const ipKind = isIP(address);
  const assessment = ipKind === 4 ? classifyIpv4(address) : ipKind === 6 ? classifyIpv6(normalizeHostname(address)) : null;
  if (!assessment || assessment.kind === "public") continue;
  if (assessment.kind === "metadata") return `baseUrl hostname ${hostname} resolves to a blocked metadata endpoint (${address})`;
  return `baseUrl hostname ${hostname} resolves to a ${assessment.detail} (${address}); set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
}
```

Security caveat: because the opt-in check is before DNS lookup, an opted-in ordinary hostname that resolves to a metadata IP is not examined. Only literal/known metadata destinations are unconditionally blocked. That is existing behavior, not introduced by #292.

### A3 — data-plane request path honors the opt-in

For a custom provider, routing calls the guard with the original provider object. For a registry provider, it calls the guard with the effective base URL and the persisted flag. `src/router.ts:120-125` and `src/router.ts:161-165`:

```ts
function routedProviderConfig(providerName: string, provider: OcxProviderConfig): OcxProviderConfig {
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  if (!registryEntry) {
    assertProviderDestinationAllowed(providerName, provider);
    return { ...provider, apiKey: resolveEnvValue(provider.apiKey) };
  }
```

```ts
// Registry template URLs are presets; local/self-hosted entries opt in explicitly.
const baseUrl = (registryBaseUrlIsTemplate || registryEntry.allowBaseUrlOverride) && userBaseUrlIsResolved
  ? userBaseUrl
  : registryEntry.baseUrl;
assertProviderDestinationAllowed(providerName, { baseUrl, allowPrivateNetwork: provider.allowPrivateNetwork });
```

The selected route carries that guarded provider into the actual upstream request. `src/router.ts:227-233`:

```ts
function routeResult(providerName: string, provider: OcxProviderConfig, modelId: string): RouteResult {
  const codexAccountMode = providerCodexAccountMode(providerName, provider);
  return {
    providerName,
    provider: routedProviderConfig(providerName, provider),
    modelId,
    ...(codexAccountMode ? { codexAccountMode } : {}),
```

`src/server/responses.ts:1138-1145`:

```ts
upstreamResponse = await fetchWithTransientRetry(
  recovery => {
    noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
    return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
      method: request.method,
      headers: request.headers,
      body: request.body,
    }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
```

Thus the data plane does not evaluate a reduced/different custom-provider shape: `allowPrivateNetwork: true` reaches the literal destination check and bypasses it. Hostname DNS classification is a management write-time check, not a router hot-path check.

## Discovery call graph

### `ocx sync`

The CLI dispatch is `src/cli/index.ts:550-552`:

```ts
case "sync": {
  await syncModelsToCodex((await findLiveProxy())?.port);
  break;
}
```

The sync operation refreshes the catalog at `src/codex/sync.ts:29-46`:

```ts
export async function syncModelsToCodex(
  port?: number,
  config: OcxConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
): Promise<CodexSyncResult> {
  applyProxyEnv(config); // `ocx ensure`/`ocx sync` fetch provider models outside the server process
  const p = port ?? config.port ?? 10100;
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let cacheSynced = false;
  let warning: string | undefined;

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
```

`refreshCodexModelCatalog` calls `syncCatalogModels`, and the latter calls model gathering. `src/codex/refresh.ts:37-45` and `src/codex/catalog.ts:2167-2175`:

```ts
export async function refreshCodexModelCatalog(
  config: OcxConfig,
  deps: RefreshDeps = defaultDeps,
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config);
  const catalogExists = deps.existsSync(result.path);
  if (!catalogExists) return { ...result, catalogExists, cacheSynced: false };
  deps.invalidateCodexModelsCache();
  return { ...result, catalogExists, cacheSynced: true };
}
```

```ts
export async function syncCatalogModels(config: OcxConfig): Promise<{ added: number; path: string }> {
  const catalogPath = readCodexCatalogPath();
  const catalog = loadCatalogForSync(catalogPath);
  if (!catalog) return { added: 0, path: catalogPath };

  const template = findNativeTemplate(catalog);

  const goModels = await gatherRoutedModels(config);
```

### Dashboard refresh and proxy `/v1/models`

Dashboard `GET /api/models` calls the same aggregate. `src/server/management-api.ts:789-791`:

```ts
if (url.pathname === "/api/models" && req.method === "GET") {
  const models = await fetchAllModels(config);
  const disabled = new Set(config.disabledModels ?? []);
```

The aggregate delegates to the canonical gatherer at `src/server/management-api.ts:1872-1880`:

```ts
/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/codex endpoints
 * share the same fetch, the same per-provider cache (dedups Codex's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
export async function fetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("../codex/catalog");
  return gatherRoutedModels(config);
}
```

The proxy's public model endpoint also calls `fetchAllModels`. `src/server/index.ts:250-257`:

```ts
if (url.pathname === "/v1/models" && req.method === "GET") {
  const apiAuthError = requireApiAuth(req, config, "data-plane");
  if (apiAuthError) return withCors(apiAuthError, req, config);
  if (!isAllowedRequestOrigin(req, config)) {
    return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
  }
  const goModels = await fetchAllModels(config);
```

### Where the provider shape goes

The gatherer clones each complete provider with object spread, enriches registry defaults in place, and passes that same object to `fetchProviderModels`. `src/codex/catalog.ts:1563-1579`:

```ts
export async function gatherRoutedModels(config: OcxConfig): Promise<CatalogModel[]> {
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  // Persisted provider entries can predate newer registry fields (noVisionModels,
  // modelInputModalities, ...). The ROUTER merges registry seeds at request time
  // (routedProviderConfig), so the proxy behaves correctly — the catalog listing must see the
  // same merged view or its advertisements drift from actual proxy behavior (e.g. a
  // vision-sidecar model advertised text-only, blocking image attachments app-side).
  // Enrich a CLONE: hydrated defaults must never leak into the persisted config.
  const activeProviders = Object.entries(config.providers)
    .filter(([, prov]) => prov.disabled !== true)
    .map(([name, prov]): [string, OcxProviderConfig] => {
      const enriched = { ...prov };
      enrichProviderFromRegistry(name, enriched);
      return [name, enriched];
    });
  const lists = await Promise.all(
    activeProviders.map(([name, prov]) => fetchProviderModels(name, prov, ttlMs, providerContextCap(config, name))),
```

For a custom provider, registry enrichment exits without modifying it. `src/providers/derive.ts:200-203`:

```ts
export function enrichProviderFromRegistry(name: string, prov: OcxProviderConfig): void {
  const entry = PROVIDER_REGISTRY.find(row => row.id === name);
  if (!entry) return;
  const seed = providerConfigSeed(entry);
```

The flag is also part of the persisted schema. `src/config.ts:329-339`:

```ts
const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  allowPrivateNetwork: z.boolean().optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
  responsesItemIdRepair: z.object({
    message: z.array(z.string().min(1)).optional(),
    reasoning: z.array(z.string().min(1)).optional(),
    repairMissingTerminalIds: z.boolean().optional(),
  }).strict().optional(),
}).passthrough();
```

Therefore there is no alternate discovery shape that drops the flag.

### Where the destination guard is applied on discovery

It is not applied. `fetchProviderModels` builds the request from the full provider and calls global `fetch` directly. `src/codex/catalog.ts:1432-1455`:

```ts
const fresh = getFreshCached(name, ttlMs);
if (fresh) return withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap)); // dedups Codex's frequent /v1/models polling within the TTL
if (isModelsFetchCoolingDown(name)) {
  // A recently-failed provider (unreachable API, missing proxy, bad key) must not re-pay the
  // fetch timeout on every catalog poll — the dashboard polls this path per page load.
  const stale = getStaleCached(name);
  return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : configured;
}
const { url, headers } = buildModelsRequest(prov, apiKey, name);
const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
  ? "vertex-aiplatform"
  : "provider-models";
try {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    markModelsFetchFailure(name);
    const stale = getStaleCached(name);
    const fallback = stale ? "stale" : "configured";
    console.warn(
      `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
    );
    return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : configured;
  }
  const json = await res.json() as unknown;
```

No destination-policy function is called between the actual request URL construction and `fetch`. Consequently `allowPrivateNetwork` cannot be “ignored by the guard” there: neither `true` nor `false` is consulted.

## `SyntaxError` causal chain

The non-2xx branch returns before JSON parsing, so `Response.json()` runs only for an HTTP-success response. The parser line is `src/codex/catalog.ts:1455`:

```ts
const json = await res.json() as unknown;
```

Any 2xx HTML/text block response throws a JavaScript `SyntaxError`. The catch reduces every exception to its class name. `src/codex/catalog.ts:1505-1512`:

```ts
} catch (error) {
  markModelsFetchFailure(name);
  const stale = getStaleCached(name);
  const fallback = stale ? "stale" : "configured";
  console.warn(
    `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
  );
  return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : configured;
}
```

By contrast, the destination policy throws a plain `Error`, not a `SyntaxError` (`src/lib/destination-policy.ts:123-125`):

```ts
export function assertProviderDestinationAllowed(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): void {
  const error = providerDestinationConfigError(name, provider);
  if (error) throw new Error(`provider ${name} ${error}`);
}
```

Therefore the reported log text is positive evidence against the stated guard-block hypothesis. It is positive evidence that an HTTP-success body failed JSON decoding.

## Hypotheses and falsifiers

### H1 — discovery invokes the guard with `allowPrivateNetwork` missing

Falsifier: trace the exact object into the fetch and find either a policy call or a projection that drops the field.

Result: rejected. The provider is cloned with `{ ...prov }`, custom registry enrichment is a no-op, and `fetchProviderModels(name, prov, ...)` receives the complete object (`src/codex/catalog.ts:1571-1579`, quoted above). The network call is direct with no policy invocation (`src/codex/catalog.ts:1440-1455`, quoted above).

### H2 — config loading or CLI creation drops the opt-in

Falsifier: find the field in the schema and at the CLI assignment.

Result: rejected. The schema includes `allowPrivateNetwork` (`src/config.ts:329-339`, quoted above), and CLI provider add assigns it before saving. `src/cli/provider.ts:191-195`:

```ts
config.providers[name] = provConfig;
if (allowPrivateNetwork) provConfig.allowPrivateNetwork = true;
if (setDefault) config.defaultProvider = name;

validateAndSave(config);
```

### H3 — discovery receives a 2xx non-JSON response and `Response.json()` throws

Falsifier: show that parsing is skipped for 2xx or that the warning is emitted by a different callsite.

Result: confirmed by source. `res.ok` is checked before `res.json()`, and the surrounding catch logs only `error.name` (`src/codex/catalog.ts:1445-1455`, `1505-1512`, quoted above). A local no-write Bun probe with `new Response("<html>blocked</html>", { status: 200 }).json()` produced `SyntaxError`.

### H4 — the destination policy itself blocks a hostname resolving to `198.18/15` despite opt-in

Falsifier: exercise the existing resolved-policy test and inspect whether DNS is called.

Result: rejected. The test explicitly expects the opt-in to return null without DNS. `tests/destination-policy-resolved.test.ts:66-70`:

```ts
test("respects allowPrivateNetwork opt-in (no DNS enforcement)", async () => {
  lookupMock.mockClear();
  expect(await providerDestinationResolvedError("custom", provider("https://lan.example.com/v1", true))).toBeNull();
  expect(lookupMock).not.toHaveBeenCalled(); // opt-in short-circuits before DNS
});
```

Fresh proof: `bun test tests/destination-policy-resolved.test.ts` returned `17 pass, 0 fail`. A no-write `gatherRoutedModels` probe with mocked fetch attempted `http://198.18.0.1/v1/models` and returned the live fixture model for both `allowPrivateNetwork: true` and `false`, proving that discovery currently consults neither value.

## Minimal patch and regression points

The issue should not be patched by merely “threading `allowPrivateNetwork`” into `buildModelsRequest`: `fetchProviderModels` already owns the full provider object. The smallest correct patch is at the actual discovery boundary in `src/codex/catalog.ts`, immediately after `buildModelsRequest` produces the effective URL and before line 1445 fetches it.

Two narrowly separated changes are recommended:

1. **Policy parity/security:** call `providerDestinationResolvedError(name, { baseUrl: url, allowPrivateNetwork: prov.allowPrivateNetwork })` at that boundary. Use the effective request URL, not only `prov.baseUrl`, because transport resolution can change provider endpoints. On rejection, mark model-fetch failure and return the existing stale/configured fallback. This makes `false` meaningful while preserving the existing `true` bypass.
2. **Actionable diagnostics:** read/parse a 2xx response through a safe helper that distinguishes invalid JSON from malformed JSON shape. Log only safe metadata (`status`, sanitized URL class, and content type), never the response body or credentials. This replaces `threw SyntaxError` with an actionable “2xx non-JSON response” diagnostic. It will identify, but cannot itself repair, an external proxy/WAF block response.

The direct provider test endpoint has the same raw-fetch shape and should reuse the same boundary helper if included in the patch. `src/server/management-api.ts:732-740`:

```ts
const { url: modelsUrl, headers } = buildModelsRequest(prov, apiKey, name);
const started = Date.now();
try {
  const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return jsonResponse({ ok: false, latencyMs, error: `upstream /models returned ${res.status}` });
  }
  const json = await res.json().catch(() => null) as { data?: unknown; models?: unknown } | null;
```

Regression points:

- `tests/codex-catalog.test.ts`: custom provider at `http://198.18.0.1/v1`; without opt-in, assert no fetch and configured/stale fallback; with opt-in, assert one fetch and discovered model.
- `tests/codex-catalog.test.ts` or the existing discovery diagnostics suite: 200 `text/html` must report a safe non-JSON diagnostic rather than `threw SyntaxError`, with no body leakage.
- `tests/destination-policy-resolved.test.ts`: retain the existing DNS short-circuit test and add an explicit `198.18.x.x` resolved case for both flag states if the shared helper is used.
- Management API test coverage: verify dashboard `/api/models` and `/api/providers/test` obey the same private-network decision and diagnostic contract.

## Verdict

**OpenCodex bug, partially confirmed — but not with the issue's stated root cause.** The “discovery guard ignores `allowPrivateNetwork`” claim is false on current `origin/dev`: discovery has no guard, and the flag is neither dropped nor evaluated against a different shape. The user-visible empty-model/SyntaxError behavior is an OpenCodex diagnostic defect consistent with a 2xx non-JSON intermediary response. Separately, discovery's complete omission of destination-policy enforcement is a real policy-parity/security defect.

## Recommended direction

Patch `fetchProviderModels` at `src/codex/catalog.ts:1440-1445`: validate the effective model URL with the full `{ baseUrl, allowPrivateNetwork }` decision before fetch, then add content-type-aware/safe JSON failure diagnostics. Do not claim this alone restores the reporter's provider; request a same-process response status/content-type trace after the diagnostic patch because the existing `SyntaxError` points to an intermediary response, not an OpenCodex guard rejection.

## Effort estimate

**Small (S), approximately 0.5 developer day.** Expect one catalog callsite/helper change plus 3-4 focused regression cases; add another 0.25 day if `/api/providers/test` is unified in the same patch. No GUI change should be required.
