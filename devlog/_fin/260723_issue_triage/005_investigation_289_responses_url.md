# 005 — Investigation: issue #289, Volcengine Ark Responses URL

Issue: https://github.com/lidge-jun/opencodex/issues/289  
Scope: current `codex/issue-triage-260723` tree (`origin/dev` at delegation time); source and tests were read-only.

## Reporter claim and upstream evidence

The reporter configures the key-auth `openai-responses` adapter with
`https://ark.cn-beijing.volces.com/api/plan/v3` and reports that Ark accepts
`/api/plan/v3/responses`, while OpenCodex sends `/api/plan/v3/v1/responses` and
gets 404. No credentialed upstream request was made in this investigation.

The linked official Responses documentation currently demonstrates the same
base-URL contract on Ark's public inference route: the SDK receives the
versioned base `https://ark.cn-beijing.volces.com/api/v3`, while curl targets
`https://ark.cn-beijing.volces.com/api/v3/responses`:
https://www.volcengine.com/docs/82379/1795150. The Agent Plan page was reachable
but its JS-rendered body could not be extracted reliably, so the Plan-specific
endpoint remains reporter evidence rather than an independently authenticated
live call. This limitation does not affect the repository-side URL-construction
finding below.

## Current URL construction

The issue's quoted key-auth logic is present verbatim. The regex removes only a
terminal `/v1` (plus an optional trailing slash), then `/v1/responses` is added
unconditionally:

> `src/adapters/openai-responses.ts:442-446`
> ```ts
>       } else {
>         const base = provider.baseUrl.replace(/\/v1\/?$/, "");
>         url = `${base}/v1/responses`;
>         if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
>         if (provider.headers) Object.assign(headers, provider.headers);
> ```

Therefore `/api/plan/v3` does not match the strip expression and deterministically
becomes `/api/plan/v3/v1/responses`. The same is true for any non-`/v1`
versioned base; this is not a Volcengine hostname check.

The forward/OAuth branch in the same adapter follows a different convention: it
treats `baseUrl` as the complete API base and appends only the resource path:

> `src/adapters/openai-responses.ts:420-425`
> ```ts
>       let url: string;
>
>       if (provider.authMode === "forward") {
>         // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
>         url = `${provider.baseUrl}/responses`;
>         if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
> ```

The generic OpenAI Chat adapter uses that same complete-base convention and
adds only `/chat/completions`:

> `src/adapters/openai-chat.ts:557-570`
> ```ts
>       if (parsed.stream) {
>         body.stream_options = { include_usage: true };
>       }
>
>       const url = `${provider.baseUrl}/chat/completions`;
>       const headers: Record<string, string> = { "Content-Type": "application/json" };
>       // Precedence preserved from pre-#128 behavior: apiKey Authorization first, then
>       // provider.headers may override (user/registry-configured headers win). Registry
>       // staticHeaders (e.g. opencode-free x-opencode-client) flow in via derive.ts and
>       // never carry Authorization, so keyless providers are unaffected.
>       if (hasCredential) headers["Authorization"] = `Bearer ${provider.apiKey}`;
>       if (provider.headers) Object.assign(headers, provider.headers);
>
>       return { url, method: "POST", headers, body: JSON.stringify(body) };
> ```

That convention already supports provider-specific version roots. For example,
the registry stores Z.AI and Tencent Coding Plan version paths directly in
`baseUrl`, both using `openai-chat`:

> `src/providers/registry.ts:739-745`
> ```ts
>   // 260710 GLM-5.2 context and path-specific ids: Tier-2 evidence in
>   // devlog/_plan/260710_provider_hardening/002_research_cn.md.
>   {
>     id: "zai", label: "Z.AI — GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", authKind: "key",
>     dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-5.2",
>     note: "GLM-5.2 coding subscription",
>     models: ["glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
> ```

> `src/providers/registry.ts:782-788`
> ```ts
>   {
>     id: "tencent-coding-plan",
>     label: "Tencent Cloud Coding Plan",
>     baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
>     adapter: "openai-chat",
>     authKind: "key",
>     dashboardUrl: "https://console.cloud.tencent.com/tokenhub/codingplan",
> ```

The Anthropic adapter is a sibling example of the fixed-protocol convention:
it strips only terminal `/v1` and always rebuilds `/v1/messages`. This confirms
that the current Responses behavior is an intentional fixed-version pattern,
not a shared general URL joiner:

> `src/adapters/anthropic.ts:674-679`
> ```ts
>       const base = provider.baseUrl.replace(/\/v1\/?$/, "");
>       const url = `${base}/v1/messages`;
>       const unresolvedPlaceholder = url.match(/\{[^}]*\}/)?.[0];
>       if (unresolvedPlaceholder) {
>         throw new Error(`anthropic baseUrl contains unresolved ${unresolvedPlaceholder}`);
>       }
> ```

## Existing configuration surface

Search performed:

```text
rg -n -i 'responses(path|url|endpoint)|endpoint(path|url)|baseurl.*mode|complete.*baseurl' \
  src tests gui
```

There is no `responsesPath`, `responsesUrl`, endpoint-path override, or
base-URL mode in `OcxProviderConfig`. The interface requires only `baseUrl` at
its URL boundary:

> `src/types.ts:638-645`
> ```ts
> export interface OcxProviderConfig {
>   adapter: string;
>   baseUrl: string;
>   /**
>    * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
>    * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
>    */
>   allowPrivateNetwork?: boolean;
> ```

The only existing Responses-prefixed provider setting repairs response item
IDs; it does not affect request URLs:

> `src/types.ts:761-768`
> ```ts
>   promptCacheKey?: boolean;
>   /**
>    * Provider-local passthrough SSE repair for broken openai-responses gateways that reuse exact
>    * placeholder message/reasoning ids or omit the terminal id after a stable added event.
>    * Disabled by default; function_call ids and call_id pairing are never rewritten.
>    */
>   responsesItemIdRepair?: ResponsesItemIdRepairConfig;
>   /** Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. */
> ```

`baseUrlChoices` is the nearest endpoint-selection feature, but it chooses among
whole base URLs and does not override an adapter's resource path:

> `src/providers/registry.ts:36-43`
> ```ts
>   allowBaseUrlOverride?: boolean;
>   /**
>    * Optional endpoint picker for providers with multiple official hosts
>    * (e.g. Qwen Cloud token plan vs pay-as-you-go). Requires `allowBaseUrlOverride`
>    * so the selected URL is honored at route time. A choice without `baseUrl` is "Custom".
>    */
>   baseUrlChoices?: readonly ProviderBaseUrlChoice[];
>   /** Static headers merged into every upstream request for this provider. */
> ```

The persisted config schema is passthrough, so adding an optional typed field
does not require migrating old config files; explicit validation should still
be added for the new relative path:

> `src/config.ts:329-339`
> ```ts
> const providerConfigSchema = z.object({
>   adapter: z.string().min(1),
>   baseUrl: z.string().min(1),
>   allowPrivateNetwork: z.boolean().optional(),
>   codexAccountMode: z.enum(["pool", "direct"]).optional(),
>   responsesItemIdRepair: z.object({
>     message: z.array(z.string().min(1)).optional(),
>     reasoning: z.array(z.string().min(1)).optional(),
>     repairMissingTerminalIds: z.boolean().optional(),
>   }).strict().optional(),
> }).passthrough();
> ```

Dashboard editing is not automatic: the management endpoint applies a field
mask and rejects a patch containing no currently recognized field. Exposing the
new setting in the dashboard therefore expands the change beyond adapter + type
to management API and GUI work:

> `src/server/management-api.ts:614-621`
> ```ts
>     // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
>     // provider (canonical-seed guard covers openai; local-guard covers registry key providers).
>     // API keys are never writable here — the api-keys endpoints own pool-integrated key writes.
>     if (Object.hasOwn(rawBody, "apiKey")) {
>       return jsonResponse({ error: "apiKey cannot be patched here; use the provider API-key endpoints" }, 400);
>     }
>     const next: OcxProviderConfig = { ...config.providers[name]! };
>     let touched = false;
> ```

> `src/server/management-api.ts:669-675`
> ```ts
>    if (Object.hasOwn(rawBody, "allowPrivateNetwork")) {
>      if (typeof rawBody.allowPrivateNetwork !== "boolean") return jsonResponse({ error: "allowPrivateNetwork must be a boolean" }, 400);
>      next.allowPrivateNetwork = rawBody.allowPrivateNetwork;
>      touched = true;
>    }
>
>     if (!touched) return jsonResponse({ error: "no recognized fields to update" }, 400);
> ```

## Proposal evaluation

| Proposal | Generality | Backward compatibility | Migration/config risk | Judgment |
| --- | --- | --- | --- | --- |
| 1. Optional `responsesPath` / `responsesUrl` | Highest. A relative path covers `/responses` and other nonstandard resource paths without vendor knowledge. | Strong if absence preserves the exact current key-auth resolver. Existing host-only and `/v1` bases continue to produce `/v1/responses`. | Low for an optional `responsesPath`; no existing config migration. A full `responsesUrl` is worse because it duplicates the origin in `baseUrl`, can drift from model discovery, and needs independent destination validation. | **Recommend `responsesPath`, not `responsesUrl`.** |
| 2. “baseUrl is complete” mode, append only `/responses` | Covers all providers whose endpoint is exactly `<versioned-base>/responses`. | Strong only as an opt-in; changing the default would break legacy host-only bases that currently rely on implicit `/v1`. | Low migration risk, but the mode is less expressive and introduces a semantic flag whose name must explain “complete API base” rather than “complete URL.” | Viable, but strictly less general than a path override for similar implementation cost. |
| 3. Volcengine `/api/plan/v3` and `/api/coding/v3` special-case | Solves the two known paths with the smallest local diff. | Existing providers remain untouched if matching is host-and-path exact. | No user migration, but high maintenance risk: vendor/path variants require code releases, and loose suffix matching could affect unrelated hosts. | Reject as adapter policy; it hard-codes provider identity into a generic compatibility adapter. |

The backward-compatibility baseline is already asserted for the canonical API-key
provider in the end-to-end suite:

> `tests/openai-provider-option-e2e.test.ts:426-441`
> ```ts
>       for (const row of apiHttpCases) {
>         const response = await post("/v1/responses", {
>           model: row.selected,
>           input: "api fixture",
>           stream: false,
>           reasoning: { effort: "high" },
>         }, { authorization: "Bearer fixture-caller-main" });
>         expect(response.status).toBe(200);
>         expect(await response.json()).toMatchObject({ model: row.wire });
>         const capture = captures.at(-1)!;
>         expect(capture).toMatchObject({
>           url: "https://api.openai.com/v1/responses",
>           authorization: "Bearer fixture-api-key",
>           accountId: null,
>           body: { model: row.wire },
>         });
> ```

## Regression test points

1. Add a focused URL matrix beside the existing API-key adapter construction in
   `tests/openai-responses-passthrough.test.ts`: legacy host-only base (still
   `/v1/responses`), legacy `/v1` base (still one `/v1`), Volcengine-style
   `/api/plan/v3` plus `responsesPath: "/responses"`, and trailing-slash
   normalization. This file already constructs the exact key-auth adapter:

   > `tests/openai-responses-passthrough.test.ts:261-267`
   > ```ts
   >   test("api-key mode drops previous_response_id only after proxy-expanded replay", () => {
   >     const adapter = createResponsesPassthroughAdapter({
   >       adapter: "openai-responses",
   >       baseUrl: "https://api.openai.example/v1",
   >       authMode: "key" as const,
   >       apiKey: "sk-test",
   >     });
   > ```

2. Keep `tests/openai-provider-option-e2e.test.ts:426-441` unchanged as the
   canonical no-regression proof for existing `/v1` providers. If the new field
   is exposed through config management, add config validation/round-trip tests
   and one management API field-mask test as separate contract coverage.

3. Do not use `tests/passthrough-override.test.ts` as the primary regression
   location: its fixture is forward mode and the tests assert header/account
   overrides, not key-auth URL selection:

   > `tests/passthrough-override.test.ts:5-13`
   > ```ts
   > const forwardProvider = { adapter: "openai-responses", baseUrl: "https://chat.openai.com/backend-api/codex", authMode: "forward" as const };
   >
   > describe("passthrough token override", () => {
   >   test("buildRequest uses original auth when no override", () => {
   >     const adapter = createResponsesPassthroughAdapter(forwardProvider);
   >     const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
   >     const req = adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers });
   >     expect(req.headers["authorization"]).toBe("Bearer original");
   >     expect(req.headers["chatgpt-account-id"]).toBe("main_acc");
   > ```

## Verdict

**OpenCodex bug.** The key-auth `openai-responses` adapter deterministically
injects `/v1` into a configured non-`/v1` versioned API base. The configurable
fix adds a small capability, but the issue should remain classified as a bug,
not be reclassified as a feature request.

## Recommended direction

Implement proposal 1 as an optional, relative `responsesPath?: string` on
`OcxProviderConfig`. When absent, execute the current lines 443-444 unchanged;
when present, trim one trailing slash from `baseUrl` and append a validated path
such as `/responses`. Require a leading `/` and reject schemes, query strings,
and fragments. Do not add a Volcengine hostname/path special-case, and do not
accept a second full origin via `responsesUrl`.

At minimum, update `src/types.ts`, `src/adapters/openai-responses.ts`, focused
tests, and user-facing configuration docs. If dashboard editing is required,
also update the management API field mask and provider workspace types/form.

## Effort estimate

**Small (about 0.5 day)** for config-file support, validation, adapter logic,
focused URL tests, and docs. **Medium (about 1 day total)** if the setting must
also be editable and visible in the dashboard/management API. No persisted
configuration migration is required because the field is optional and its
absence preserves the existing URL algorithm.
