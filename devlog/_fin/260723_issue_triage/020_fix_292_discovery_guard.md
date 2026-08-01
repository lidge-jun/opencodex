# Fix #292 — model-discovery destination guard and safe JSON diagnostics

Status: implementation-ready design only  
Target branch: `codex/bucket2-fixes-260723` (stacked; originally planned `codex/fix-292-discovery-guard`)  
Issue: #292

## 1. Required outcome

Model discovery must validate the effective URL returned by `buildModelsRequest` before `fetch` and must degrade safely when a 2xx response is not valid JSON.

Security contract:

- Discovery currently performs no destination-policy check at `src/codex/catalog.ts:1440-1445`; the patch must close that gap.
- The effective discovery request must pass `{ baseUrl: url, allowPrivateNetwork: prov.allowPrivateNetwork }` to `providerDestinationResolvedError` before `fetch`.
- `providerDestinationResolvedError` starts with `providerDestinationConfigError` (`src/lib/destination-policy.ts:137-142`), the same policy decision reached by the data plane through `assertProviderDestinationAllowed` (`src/router.ts:120-125`, `src/router.ts:161-165`). Discovery additionally uses the existing resolved-host check because its boundary is asynchronous.
- Default behavior is fail-closed for literal or DNS-resolved private/reserved destinations. `allowPrivateNetwork: true` continues to opt into non-metadata private destinations exactly as the existing policy defines (`src/lib/destination-policy.ts:149-164`).
- Do not modify `src/router.ts` or `src/lib/destination-policy.ts`; data-plane behavior and policy semantics are unchanged.
- A policy rejection, HTTP failure, invalid JSON, malformed JSON shape, or thrown fetch error must mark the provider fetch as failed and return last-known-good stale models when present, otherwise configured models.
- Diagnostics may include provider name, HTTP status, normalized media type, destination-policy reason, `urlClass`, and fallback class. Never log the response body, request headers, API key, full URL, query string, or thrown JSON parser message.

## 2. Dependency-ordered file change map

| Order | Action | Path | Exact change |
|---:|---|---|---|
| 1 | MODIFY | `src/codex/catalog.ts` | Import `providerDestinationResolvedError`; centralize the existing failed-discovery stale/configured degradation in a local closure; guard the effective models URL before `fetch`; replace bare `res.json()` with body parsing that emits content-type-aware, body-safe diagnostics. |
| 2 | MODIFY | `tests/codex-catalog.test.ts` | Add six public-seam regressions through `gatherRoutedModels`: default block, explicit opt-in, non-JSON diagnostic, stale-cache preservation, HTTP non-OK fallback, and thrown-fetch fallback. |

No new production module, helper file, type, config field, endpoint, or dependency is required. `tests/destination-policy-resolved.test.ts:11-82` remains unchanged and continues to own unit coverage of literal ranges, DNS resolution, metadata blocking, opt-in short-circuiting, and advisory DNS failure.

## 3. `src/codex/catalog.ts`

### 3.1 Import the existing resolved policy

Anchor: current imports at `src/codex/catalog.ts:28-30`.

Before:

```ts
import type { NormalizedComboConfig } from "../combos/types";
import { redactSecretString } from "../lib/redact";
import upstreamModelsSnapshot from "./data/upstream-models.json";
```

After:

```ts
import type { NormalizedComboConfig } from "../combos/types";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import { redactSecretString } from "../lib/redact";
import upstreamModelsSnapshot from "./data/upstream-models.json";
```

### 3.2 Add one local degradation owner and guard the effective URL

Anchor: replace the current block beginning at `src/codex/catalog.ts:1440` and ending immediately before `const data` at current line 1456.

Before:

```ts
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

After:

```ts
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  const failedDiscoveryFallback = (): { models: CatalogModel[]; fallback: "stale" | "configured" } => {
    markModelsFetchFailure(name);
    const stale = getStaleCached(name);
    return {
      models: stale
        ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
        : configured,
      fallback: stale ? "stale" : "configured",
    };
  };
  try {
    const destinationError = await providerDestinationResolvedError(name, {
      baseUrl: url,
      allowPrivateNetwork: prov.allowPrivateNetwork,
    });
    if (destinationError) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" was blocked by destination policy: ${destinationError} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const contentType = (
      res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "missing"
    ).slice(0, 80);
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      const { models, fallback } = failedDiscoveryFallback();
      const diagnostic = contentType === "application/json" || contentType.endsWith("+json")
        ? "returned invalid JSON in a 2xx response"
        : "returned a non-JSON 2xx response";
      console.warn(
        `[opencodex] Provider model discovery for "${name}" ${diagnostic} [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
```

Why this exact placement is required:

- `buildModelsRequest` resolves provider transport and constructs adapter-specific paths (`src/oauth/index.ts:431-458`), so guarding `prov.baseUrl` earlier could validate a different destination from the one fetched.
- The policy receives both fields that define the decision. Passing only `{ baseUrl: url }` would silently discard the explicit opt-in and recreate the issue's alleged failure mode.
- Parsing text explicitly permits one controlled parse failure path. The body is never interpolated into a log, while the normalized media type distinguishes an HTML/text intermediary response from malformed JSON advertised as JSON.
- JSON remains accepted even when a provider omits or mislabels `Content-Type`; media type changes the diagnostic only, not acceptance.

### 3.3 Route malformed-shape failure through the same fallback closure

Anchor: replace current `src/codex/catalog.ts:1459-1466` after the preceding insertion shifts it.

Before:

```ts
    if (!isProviderModelsApiItems(data)) {
      markModelsFetchFailure(name);
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned malformed 2xx data; using stale/static catalog degradation.`,
      );
      const stale = getStaleCached(name);
      return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : configured;
    }
```

After:

```ts
    if (!isProviderModelsApiItems(data)) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned malformed 2xx data [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
```

This retains the semantic distinction between valid JSON with the wrong schema and a body that cannot be parsed as JSON.

### 3.4 Route the outer catch through the same fallback closure

Anchor: replace current `src/codex/catalog.ts:1505-1512`.

Before:

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

After:

```ts
  } catch (error) {
    const { models, fallback } = failedDiscoveryFallback();
    console.warn(
      `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
    );
    return models;
  }
```

The outer catch remains responsible for actual policy/fetch/body-read exceptions. JSON parse failures no longer reach it, so a 2xx HTML/text response cannot collapse to the bare `SyntaxError` diagnostic.

## 4. `tests/codex-catalog.test.ts`

Insert the following six tests inside `describe("Codex catalog routed normalization", ...)`, immediately before the current malformed-2xx test at `tests/codex-catalog.test.ts:1225`. The existing file-level `afterEach` at lines 22-26 restores `fetch` and clears cache state.

```ts
  test("model discovery blocks a private destination by default before fetch", async () => {
    const provider = "discovery-private-blocked";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: "must-not-fetch" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "http://198.18.0.1/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(fetchCalls).toBe(0);
      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("blocked by destination policy");
      expect(warningText).toContain("benchmark address");
      expect(warningText).toContain("fallback=configured");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("model discovery allows a private destination with allowPrivateNetwork opt-in", async () => {
    const provider = "discovery-private-opt-in";
    let requestedUrl: string | undefined;
    globalThis.fetch = (async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "live-private-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "http://198.18.0.1/v1",
            allowPrivateNetwork: true,
            apiKey: "sk-test",
          },
        },
      });

      expect(requestedUrl).toBe("http://198.18.0.1/v1/models");
      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/live-private-model`,
      ]);
    } finally {
      clearModelCache(provider);
    }
  });

  test("2xx non-JSON discovery emits safe diagnostics instead of SyntaxError", async () => {
    const provider = "discovery-non-json";
    const bodyMarker = "PRIVATE-UPSTREAM-BODY-MARKER";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(`<html>${bodyMarker}</html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("returned a non-JSON 2xx response");
      expect(warningText).toContain("status=200");
      expect(warningText).toContain("contentType=text/html");
      expect(warningText).toContain("fallback=configured");
      expect(warningText).not.toContain("SyntaxError");
      expect(warningText).not.toContain(bodyMarker);
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("invalid 2xx JSON preserves and returns the stale discovery cache", async () => {
    const provider = "discovery-invalid-json-stale";
    const stale = [{ provider, id: "last-known-good" }];
    setCached(provider, stale);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        modelCacheTtlMs: 0,
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/last-known-good`,
      ]);
      expect(getStaleCached(provider)).toEqual(stale);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("returned invalid JSON in a 2xx response");
      expect(warningText).toContain("contentType=application/problem+json");
      expect(warningText).toContain("fallback=stale");
      expect(warningText).not.toContain("SyntaxError");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("HTTP non-OK discovery returns configured models with status diagnostics", async () => {
    const provider = "discovery-http-503";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("failed with HTTP 503");
      expect(warningText).toContain("fallback=configured");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("thrown fetch discovery returns configured models without SyntaxError conflation", async () => {
    const provider = "discovery-fetch-throw";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("threw TypeError");
      expect(warningText).toContain("fallback=configured");
      expect(warningText).not.toContain("SyntaxError");
      expect(warningText).not.toContain("fetch failed");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });
```

### Activation matrix

| Test | Conditional path activated | Required proof |
|---|---|---|
| Default private block | Effective URL is literal `198.18.0.1`; opt-in absent; sync portion of resolved policy rejects; no stale cache exists. | `fetchCalls === 0`, configured model returned, policy reason and `fallback=configured` logged. |
| Explicit opt-in | Same effective private URL; `allowPrivateNetwork === true`; policy returns `null`. | Exactly the effective `/v1/models` URL reaches mocked fetch and live model is authoritative. |
| 2xx non-JSON | Public literal skips DNS; fetch returns status 200, media type `text/html`, invalid JSON body; no stale cache exists. | New non-JSON/status/content-type diagnostic, configured fallback, no `SyntaxError`, no body-marker leakage. |
| Stale preservation | Public literal skips DNS; fetch returns status 200, `application/problem+json`, invalid JSON; stale entry is forced stale with `modelCacheTtlMs: 0`. | Stale model returned unchanged, stale cache retained, JSON-media-type diagnostic and `fallback=stale`. |
| HTTP non-OK | Fetch resolves with status 503, empty body; no stale cache exists. | `markModelsFetchFailure` runs, `failed with HTTP 503` warning with `fallback=configured`, configured model returned — degradation identical to current behavior. |
| Fetch throw | Mocked fetch rejects with `TypeError: fetch failed`; no stale cache exists. | Outer catch logs the error name (no bare `SyntaxError` conflation), `fallback=configured`, configured model returned. |

The first and fourth tests activate both branches of the shared `failedDiscoveryFallback` closure (`configured` and `stale`). The third and fourth tests activate both parse-diagnostic branches (non-JSON media type and JSON media type). The fifth and sixth tests cover the non-OK and thrown-fetch degradation promised in §1, which the refactor of the outer catch at `src/codex/catalog.ts:1505-1512` must preserve byte-for-byte in behavior.

## 5. Verification gates

Run in this order after implementation:

```bash
bun test tests/destination-policy-resolved.test.ts tests/codex-catalog.test.ts
bun run typecheck
bun run privacy:scan
bun run test
```

Acceptance checks:

1. Six new tests pass and existing malformed-shape/stale tests remain green.
2. The focused destination-policy suite remains unchanged and green.
3. Typecheck reports no error from the new import, local closure, or `unknown` JSON handling.
4. Privacy scan remains green; no body, credential, header, full URL, or query value is emitted.
5. Full suite is green because `gatherRoutedModels` feeds `/api/models`, `/v1/models`, and catalog sync.
6. `git diff -- src/router.ts src/lib/destination-policy.ts` is empty, proving no data-plane or policy-semantic change.

## 6. Out of scope / follow-up

- Do not unify `POST /api/providers/test` in this patch. It still performs an independent raw fetch and `res.json().catch(() => null)` at `src/server/management-api.ts:704-762`. Open a follow-up to route that endpoint through the same destination decision and safe response-diagnostic helper after the catalog fix lands.
- No GUI/dashboard change. Existing consumers receive the same model arrays and fallback behavior.
- No config/schema/CLI change. `allowPrivateNetwork` already reaches `fetchProviderModels` on the complete provider object.
- No router/data-plane change and no expansion of the current metadata/private-network policy.
- No claim that this patch makes the reporter's upstream return JSON. It makes the intermediary/non-JSON condition actionable and preserves catalog degradation.

## 7. Open questions

None. The management test-endpoint parity work is explicitly deferred rather than blocking this patch.
