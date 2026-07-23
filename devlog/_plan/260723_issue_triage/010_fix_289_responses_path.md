# 010 — Fix issue #289: configurable Responses resource path

- **Issue:** #289, Volcengine Ark Agent Plan key-auth Responses URL gets an extra `/v1`
- **Implementation branch:** `codex/fix-289-responses-path` from `dev`
- **Work class:** C2 — optional provider contract field across type, persisted-config validation,
  one adapter branch, focused tests, and synchronized reference docs
- **Decision:** add optional relative `responsesPath?: string`; do not infer from a hostname or
  reinterpret `baseUrl`
- **Implementation change count:** 15 files, all `MODIFY`; no implementation `NEW` or `DELETE`
- **Focused test count:** 6

## Required outcome

A key-auth `openai-responses` provider may configure a provider-specific resource path:

```json
{
  "adapter": "openai-responses",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
  "responsesPath": "/responses",
  "authMode": "key"
}
```

The adapter must send that provider to:

```text
https://ark.cn-beijing.volces.com/api/plan/v3/responses
```

When `responsesPath` is absent, the existing key-auth expression remains the executed code and
continues to produce `/v1/responses`. The `forward` branch remains unchanged.

## Exact change map and dependency order

| Order | Operation | Path | Responsibility |
| --- | --- | --- | --- |
| 1 | MODIFY | `src/types.ts` | Add the optional provider contract field. |
| 2 | MODIFY | `src/config.ts` | Parse and validate the relative path at persisted-config ingress. |
| 3 | MODIFY | `src/adapters/openai-responses.ts` | Select the legacy URL algorithm when absent and the configured path algorithm when present. |
| 4 | MODIFY | `tests/config.test.ts` | Prove accepted and rejected persisted values. |
| 5 | MODIFY | `tests/openai-responses-passthrough.test.ts` | Prove legacy, configured, and Ark URL construction. |
| 6 | MODIFY | `docs-site/src/content/docs/reference/configuration.md` | Document the English provider field and constraints. |
| 7 | MODIFY | `docs-site/src/content/docs/ja/reference/configuration.md` | Keep Japanese provider configuration reference synchronized. |
| 8 | MODIFY | `docs-site/src/content/docs/ko/reference/configuration.md` | Keep Korean provider configuration reference synchronized. |
| 9 | MODIFY | `docs-site/src/content/docs/ru/reference/configuration.md` | Keep Russian provider configuration reference synchronized. |
| 10 | MODIFY | `docs-site/src/content/docs/zh-cn/reference/configuration.md` | Keep Simplified Chinese provider configuration reference synchronized. |
| 11 | MODIFY | `docs-site/src/content/docs/reference/adapters.md` | Explain default and override URL construction in English. |
| 12 | MODIFY | `docs-site/src/content/docs/ja/reference/adapters.md` | Remove the Japanese fixed-URL contradiction. |
| 13 | MODIFY | `docs-site/src/content/docs/ko/reference/adapters.md` | Remove the Korean fixed-URL contradiction. |
| 14 | MODIFY | `docs-site/src/content/docs/ru/reference/adapters.md` | Remove the Russian fixed-URL contradiction. |
| 15 | MODIFY | `docs-site/src/content/docs/zh-cn/reference/adapters.md` | Remove the Simplified Chinese fixed-URL contradiction. |

No registry entry, migration, management route, dashboard type, dashboard form, or generated GUI
asset changes in this PR.

## Diff-level design

### 1. MODIFY `src/types.ts`

Current anchor: `OcxProviderConfig` begins at current-tree line 638; `baseUrl` is line 640.
Place the field directly after `baseUrl` because both fields define the upstream URL contract.

Before:

```ts
export interface OcxProviderConfig {
  adapter: string;
  baseUrl: string;
  /**
   * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
   * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
   */
  allowPrivateNetwork?: boolean;
```

After:

```ts
export interface OcxProviderConfig {
  adapter: string;
  baseUrl: string;
  /**
   * Optional relative resource path for key-auth openai-responses requests. Must start with `/`
   * and must not include a URL scheme, query string, or fragment. When omitted, the adapter keeps
   * the legacy `/v1/responses` construction.
   */
  responsesPath?: string;
  /**
   * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
   * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
   */
  allowPrivateNetwork?: boolean;
```

### 2. MODIFY `src/config.ts`

Validation belongs at config ingress, before routing can construct an outbound request. Keep the
schema optional so old config files require no migration. Add one focused validator beside
`providerBaseUrlConfigError`, then attach its result to the exact provider field in
`configSchema.superRefine`.

#### 2a. Parse the typed field

Current anchor: `providerConfigSchema` is current-tree lines 329-339.

Before:

```ts
const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  allowPrivateNetwork: z.boolean().optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
```

After:

```ts
const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  responsesPath: z.string().min(1).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
```

#### 2b. Add the relative-path validator

Current anchor: `providerBaseUrlConfigError` ends at current-tree line 375 and
`providerHeadersConfigError` starts at line 377.

Before:

```ts
export function providerBaseUrlConfigError(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "baseUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "baseUrl must not include embedded credentials";
    if (parsed.search || parsed.hash) return "baseUrl must not include query strings or fragments";
  } catch {
    return "baseUrl must be a valid URL";
  }
  return null;
}

export function providerHeadersConfigError(headers: unknown): string | null {
```

After:

```ts
export function providerBaseUrlConfigError(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "baseUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "baseUrl must not include embedded credentials";
    if (parsed.search || parsed.hash) return "baseUrl must not include query strings or fragments";
  } catch {
    return "baseUrl must be a valid URL";
  }
  return null;
}

function providerResponsesPathConfigError(responsesPath: string | undefined): string | null {
  if (responsesPath === undefined) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(responsesPath) || responsesPath.includes("://")) {
    return "responsesPath must be a relative path without a URL scheme";
  }
  if (!responsesPath.startsWith("/")) return "responsesPath must start with /";
  if (responsesPath.includes("?") || responsesPath.includes("#")) {
    return "responsesPath must not include query strings or fragments";
  }
  return null;
}

export function providerHeadersConfigError(headers: unknown): string | null {
```

The explicit `://` check also rejects a scheme hidden after the required leading slash, such as
`/https://other-origin.example/responses`; the leading-scheme regex gives a specific error for a
full URL. Query and fragment bytes are forbidden because this field owns only a resource path.

#### 2c. Wire validation into the provider field path

Current anchor: base URL and destination validation occupy current-tree lines 450-466; header
validation starts at line 467.

Before:

```ts
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "baseUrl"],
          message: destinationError,
        });
      }
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
```

After:

```ts
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "baseUrl"],
          message: destinationError,
        });
      }
    }
    const responsesPathError = providerResponsesPathConfigError(provider.responsesPath);
    if (responsesPathError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "responsesPath"],
        message: responsesPathError,
      });
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
```

Do not add an adapter-name restriction. The field is harmless when unused, and config validation
should enforce its shape consistently if it is present. Runtime consumption remains limited to the
key-auth Responses branch described below.

### 3. MODIFY `src/adapters/openai-responses.ts`

Current anchor: `createResponsesPassthroughAdapter` starts at current-tree line 413; the key-auth
branch is lines 442-447. Preserve the forward branch byte-for-byte.

Before:

```ts
      } else {
        const base = provider.baseUrl.replace(/\/v1\/?$/, "");
        url = `${base}/v1/responses`;
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }
```

After:

```ts
      } else {
        if (provider.responsesPath === undefined) {
          const base = provider.baseUrl.replace(/\/v1\/?$/, "");
          url = `${base}/v1/responses`;
        } else {
          const base = provider.baseUrl.replace(/\/$/, "");
          url = `${base}${provider.responsesPath}`;
        }
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }
```

The check must be `=== undefined`, not a truthiness check. Config validation makes an explicitly
present empty value invalid, and the adapter branch should model presence versus absence exactly.
The configured branch removes one terminal slash, as required by the investigation direction, then
concatenates the already-validated leading-slash path. Do not use `new URL()` for joining: URL
resolution would introduce different normalization semantics from the explicit string contract.

### 4. MODIFY `tests/config.test.ts`

Add one small writer beside the existing `writeConfig` helper, then add three tests in
`describe("opencodex config defaults", ...)` immediately after the current
`responsesItemIdRepair` config-shape test.

#### 4a. Add the focused config fixture writer

Before:

```ts
function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

describe("opencodex config defaults", () => {
```

After:

```ts
function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

function writeResponsesPathConfig(responsesPath: string): void {
  writeConfig({
    port: 12345,
    providers: {
      custom: {
        adapter: "openai-responses",
        baseUrl: "https://example.test/api/v3",
        responsesPath,
      },
    },
    defaultProvider: "custom",
  });
}

describe("opencodex config defaults", () => {
```

#### 4b. Add three persisted-config tests

Before insertion anchor:

```ts
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesItemIdRepair");
  });

  test("reads valid config diagnostics without mutation", () => {
```

After:

```ts
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesItemIdRepair");
  });

  test("accepts a relative responsesPath", () => {
    writeResponsesPathConfig("/responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.providers.custom.responsesPath).toBe("/responses");
  });

  test("rejects responsesPath without a leading slash", () => {
    writeResponsesPathConfig("responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("responsesPath must start with /");
  });

  test("rejects responsesPath containing a URL scheme, query, or fragment", () => {
    for (const [responsesPath, expectedError] of [
      ["https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/responses?api-version=v1", "responsesPath must not include query strings or fragments"],
      ["/responses#section", "responsesPath must not include query strings or fragments"],
    ] as const) {
      writeResponsesPathConfig(responsesPath);

      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain(expectedError);
    }
  });

  test("reads valid config diagnostics without mutation", () => {
```

**ACTIVATION SCENARIO — validation reject:** each invalid value is persisted into an otherwise
valid provider and loaded through `readConfigDiagnostics()`. `source === "fallback"` plus the
field-specific error proves `configSchema.superRefine` rejected the file before routing or outbound
request construction. The table activates all required rejection branches: missing leading slash,
scheme, query, and fragment.

### 5. MODIFY `tests/openai-responses-passthrough.test.ts`

Add a URL-only request helper and a focused describe block between the existing forward-provider
fixture and `OpenAI Responses passthrough sanitization`. This file already imports the exact adapter
factory, so no import change is needed.

Before:

```ts
const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

describe("OpenAI Responses passthrough sanitization", () => {
```

After:

```ts
const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

function buildKeyAuthUrl(baseUrl: string, responsesPath?: string): string {
  const adapter = createResponsesPassthroughAdapter({
    adapter: "openai-responses",
    baseUrl,
    authMode: "key" as const,
    apiKey: "sk-test",
    ...(responsesPath === undefined ? {} : { responsesPath }),
  });
  return adapter.buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, { headers: new Headers() }).url;
}

describe("OpenAI Responses key-auth URL construction", () => {
  test("BUG-R289 preserves legacy /v1/responses URL when responsesPath is absent", () => {
    for (const [baseUrl, expectedUrl] of [
      ["https://api.openai.example", "https://api.openai.example/v1/responses"],
      ["https://api.openai.example/v1", "https://api.openai.example/v1/responses"],
      ["https://api.openai.example/v1/", "https://api.openai.example/v1/responses"],
    ] as const) {
      expect(buildKeyAuthUrl(baseUrl)).toBe(expectedUrl);
    }
  });

  test("BUG-R289 appends responsesPath to a baseUrl with one trailing slash", () => {
    expect(buildKeyAuthUrl("https://gateway.example/api/v3/", "/responses"))
      .toBe("https://gateway.example/api/v3/responses");
  });

  test("BUG-R289 routes Volcengine Ark Agent Plan to /api/plan/v3/responses", () => {
    expect(buildKeyAuthUrl(
      "https://ark.cn-beijing.volces.com/api/plan/v3",
      "/responses",
    )).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });
});

describe("OpenAI Responses passthrough sanitization", () => {
```

**ACTIVATION SCENARIO — absent-field fallback:** `buildKeyAuthUrl(baseUrl)` omits the property
entirely through the conditional object spread. The three exact URL assertions prove the
`provider.responsesPath === undefined` branch ran and retained the old host-only, `/v1`, and
`/v1/` outputs. A configured-path assertion cannot satisfy this proof because it exercises the
opposite branch.

The second test proves one-terminal-slash normalization in the present-field branch. The third is
the named issue regression and must retain the reporter's exact Ark Agent Plan base/path pair.

### 6-10. MODIFY localized provider configuration references

Insert one row immediately after `baseUrl` in every locale. These are literal row replacements,
not an instruction to regenerate translations.

#### `docs-site/src/content/docs/reference/configuration.md`

Before:

```md
| `baseUrl` | `string` | Upstream API base URL. |
| `disabled?` | `boolean` | Keep the provider on disk but exclude it from routing and model/catalog listings. |
```

After:

```md
| `baseUrl` | `string` | Upstream API base URL. |
| `responsesPath?` | `string` | Optional relative resource path for key-auth `openai-responses` requests. It must start with `/` and contain no URL scheme, query, or fragment. When omitted, the adapter keeps its legacy `/v1/responses` URL construction. |
| `disabled?` | `boolean` | Keep the provider on disk but exclude it from routing and model/catalog listings. |
```

#### `docs-site/src/content/docs/ja/reference/configuration.md`

Before:

```md
| `baseUrl` | `string` | 上流 API base URL。 |
| `disabled?` | `boolean` | 設定はディスクに残すがルーティングとモデル/カタログ一覧から除外します。 |
```

After:

```md
| `baseUrl` | `string` | 上流 API base URL。 |
| `responsesPath?` | `string` | `key` 認証の `openai-responses` リクエストに使う任意の相対 resource path。`/` で始め、URL scheme、query、fragment を含めてはいけません。省略時は従来の `/v1/responses` URL 構築を維持します。 |
| `disabled?` | `boolean` | 設定はディスクに残すがルーティングとモデル/カタログ一覧から除外します。 |
```

#### `docs-site/src/content/docs/ko/reference/configuration.md`

Before:

```md
| `baseUrl` | `string` | 업스트림 API base URL. |
| `disabled?` | `boolean` | 설정은 디스크에 남기되 라우팅과 모델/카탈로그 목록에서 제외합니다. |
```

After:

```md
| `baseUrl` | `string` | 업스트림 API base URL. |
| `responsesPath?` | `string` | `key` 인증 `openai-responses` 요청에 사용할 선택적 상대 resource path. `/`로 시작해야 하며 URL scheme, query, fragment를 포함할 수 없습니다. 생략하면 기존 `/v1/responses` URL 구성을 유지합니다. |
| `disabled?` | `boolean` | 설정은 디스크에 남기되 라우팅과 모델/카탈로그 목록에서 제외합니다. |
```

#### `docs-site/src/content/docs/ru/reference/configuration.md`

Before:

```md
| `baseUrl` | `string` | Базовый URL вышестоящего API. |
| `disabled?` | `boolean` | Провайдер остаётся на диске, но исключается из маршрутизации и списков моделей/каталога. |
```

After:

```md
| `baseUrl` | `string` | Базовый URL вышестоящего API. |
| `responsesPath?` | `string` | Необязательный относительный путь ресурса для запросов `openai-responses` с аутентификацией `key`. Должен начинаться с `/` и не содержать схему URL, query или fragment. Если поле опущено, сохраняется прежнее построение URL `/v1/responses`. |
| `disabled?` | `boolean` | Провайдер остаётся на диске, но исключается из маршрутизации и списков моделей/каталога. |
```

#### `docs-site/src/content/docs/zh-cn/reference/configuration.md`

Before:

```md
| `baseUrl` | `string` | 上游 API base URL。 |
| `disabled?` | `boolean` | 配置保留在磁盘上，但从路由和模型/目录列表排除。 |
```

After:

```md
| `baseUrl` | `string` | 上游 API base URL。 |
| `responsesPath?` | `string` | `key` 认证的 `openai-responses` 请求可选相对 resource path。必须以 `/` 开头，且不得包含 URL scheme、query 或 fragment。省略时保留原有的 `/v1/responses` URL 构造。 |
| `disabled?` | `boolean` | 配置保留在磁盘上，但从路由和模型/目录列表排除。 |
```

### 11-15. MODIFY localized adapter references

Replace the existing fixed key-auth URL bullet in every locale with the default-plus-override
contract. The Ark example is identical across locales so users can copy it directly.

#### `docs-site/src/content/docs/reference/adapters.md`

Before:

```md
- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`.
```

After:

```md
- `forward` URL → `{baseUrl}/responses`. A `key` provider defaults to the legacy `{baseUrl}/v1/responses` construction.
- A `key` provider may set a validated relative `responsesPath`; the adapter removes one trailing slash from `baseUrl` and sends `{trimmedBaseUrl}{responsesPath}`. For Ark Agent Plan, use `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` with `responsesPath: "/responses"`.
```

#### `docs-site/src/content/docs/ja/reference/adapters.md`

Before:

```md
- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`。
```

After:

```md
- `forward` URL → `{baseUrl}/responses`。`key` provider はデフォルトで従来の `{baseUrl}/v1/responses` 構築を使います。
- `key` provider は検証済みの相対 `responsesPath` を設定できます。adapter は `baseUrl` 末尾の `/` を 1 つ除き、`{trimmedBaseUrl}{responsesPath}` に送信します。Ark Agent Plan では `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` と `responsesPath: "/responses"` を使います。
```

#### `docs-site/src/content/docs/ko/reference/adapters.md`

Before:

```md
- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`.
```

After:

```md
- `forward` URL → `{baseUrl}/responses`. `key` provider는 기본적으로 기존 `{baseUrl}/v1/responses` 구성을 사용합니다.
- `key` provider는 검증된 상대 `responsesPath`를 설정할 수 있습니다. adapter는 `baseUrl` 끝의 `/` 하나를 제거하고 `{trimmedBaseUrl}{responsesPath}`로 전송합니다. Ark Agent Plan은 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"`와 `responsesPath: "/responses"`를 사용합니다.
```

#### `docs-site/src/content/docs/ru/reference/adapters.md`

Before:

```md
- URL для `forward` → `{baseUrl}/responses`; URL для `key` → `{baseUrl}/v1/responses`.
```

After:

```md
- URL для `forward` → `{baseUrl}/responses`. Провайдер с `key` по умолчанию сохраняет прежнее построение `{baseUrl}/v1/responses`.
- Провайдер с `key` может задать проверенный относительный `responsesPath`: адаптер удаляет один завершающий `/` из `baseUrl` и отправляет запрос на `{trimmedBaseUrl}{responsesPath}`. Для Ark Agent Plan используйте `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` и `responsesPath: "/responses"`.
```

#### `docs-site/src/content/docs/zh-cn/reference/adapters.md`

Before:

```md
- `forward` URL → `{baseUrl}/responses`；`key` URL → `{baseUrl}/v1/responses`。
```

After:

```md
- `forward` URL → `{baseUrl}/responses`。`key` provider 默认保留原有的 `{baseUrl}/v1/responses` 构造。
- `key` provider 可设置经过验证的相对 `responsesPath`；adapter 会移除 `baseUrl` 末尾的一个 `/`，并向 `{trimmedBaseUrl}{responsesPath}` 发送请求。Ark Agent Plan 使用 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` 和 `responsesPath: "/responses"`。
```

## Exact test plan

| # | File | Exact case name | Contract proved |
| --- | --- | --- | --- |
| 1 | `tests/openai-responses-passthrough.test.ts` | `BUG-R289 preserves legacy /v1/responses URL when responsesPath is absent` | Absent property executes the untouched fallback for host-only, `/v1`, and `/v1/` bases. |
| 2 | `tests/openai-responses-passthrough.test.ts` | `BUG-R289 appends responsesPath to a baseUrl with one trailing slash` | Present property removes one terminal slash and appends the validated path without inserting `/v1`. |
| 3 | `tests/openai-responses-passthrough.test.ts` | `BUG-R289 routes Volcengine Ark Agent Plan to /api/plan/v3/responses` | Reporter base plus `/responses` resolves to the exact expected Ark URL. |
| 4 | `tests/config.test.ts` | `accepts a relative responsesPath` | Persisted `/responses` survives schema parsing unchanged. |
| 5 | `tests/config.test.ts` | `rejects responsesPath without a leading slash` | Missing leading slash activates the custom validation issue and config fallback. |
| 6 | `tests/config.test.ts` | `rejects responsesPath containing a URL scheme, query, or fragment` | Full URL, query, and fragment inputs each activate the matching rejection and config fallback. |

Keep the existing `tests/openai-provider-option-e2e.test.ts` canonical API-key assertion unchanged;
its expected `https://api.openai.com/v1/responses` remains supplementary integration proof, not a
seventh new test.

## Backward compatibility: why existing `/v1` providers are byte-identical

1. `responsesPath` is optional in both TypeScript and Zod. Existing serialized provider objects
   parse without a new value, migration, default, or rewrite.
2. The absent-field adapter branch contains the current two URL lines verbatim:

   ```ts
   const base = provider.baseUrl.replace(/\/v1\/?$/, "");
   url = `${base}/v1/responses`;
   ```

   Therefore a host-only base, a terminal `/v1` base, and a terminal `/v1/` base produce the exact
   same URL string bytes as before.
3. Header construction remains after URL selection and is unchanged. Authorization casing,
   provider-header precedence, method, serialized body, stream handling, and response parsing are
   untouched.
4. The `forward` branch does not read `responsesPath` and remains byte-for-byte unchanged at
   `{baseUrl}/responses`.
5. No built-in registry seed receives `responsesPath`; the new path executes only when a user
   explicitly persists the field.

## Out of scope and follow-up boundary

- **Dashboard and management API field:** follow-up only. Do not add `responsesPath` to
  `src/server/management-api.ts` provider PATCH/POST field masks, GUI provider workspace types,
  forms, payload builders, or localized GUI strings in this PR. Config-file editing is the only
  supported write path for the new field initially.
- No Volcengine hostname, `/api/plan/v3`, or `/api/coding/v3` special-case in runtime code.
- No absolute `responsesUrl`; `baseUrl` remains the sole origin and destination-policy input.
- No change to model discovery URL construction, Chat Completions, Anthropic, compact, image, or
  WebSocket routing.
- No behavior change for `authMode: "forward"`.
- No config migration and no registry preset addition.

The follow-up for dashboard/API editing must independently add the management field mask, merged
provider validation, GUI workspace type/form/payload plumbing, API tests, and localized labels. It
must not be smuggled into this adapter bug-fix PR.

## Implementation and verification order

1. Apply `src/types.ts`, then `src/config.ts`.
2. Add config tests and run the focused config suite. Confirm invalid values fail for the expected
   field-specific reason.
3. Add the adapter branch and URL tests. For regression discipline, the Ark test should fail against
   the old adapter (`.../api/plan/v3/v1/responses`) and pass after the branch is added.
4. Update all ten reference-doc files exactly as mapped.
5. Run fresh gates from repository root:

   ```bash
   bun test --isolate ./tests/config.test.ts ./tests/openai-responses-passthrough.test.ts
   bun run typecheck
   bun run test
   bun run privacy:scan
   (cd docs-site && bun install --frozen-lockfile && bun run build)
   ```

6. Inspect `git diff --check` and `git diff --stat`; the implementation diff must contain exactly the
   15 mapped files and no management/API/GUI changes.

## Acceptance checklist

- [ ] `OcxProviderConfig.responsesPath?: string` exists with relative-path semantics.
- [ ] Config accepts `/responses` and rejects no-leading-slash, scheme, query, and fragment values.
- [ ] Absent field executes the current `/v1/responses` expression unchanged.
- [ ] Present field concatenates one-trailing-slash-trimmed `baseUrl` and validated path.
- [ ] Ark Agent Plan exact regression resolves to `/api/plan/v3/responses`.
- [ ] Six named focused tests pass; full typecheck, test, privacy, and docs build gates pass.
- [ ] English plus ja/ko/ru/zh-cn configuration and adapter references agree.
- [ ] Dashboard and management API exposure remains follow-up only.

## Open questions

None. The field name, validation contract, key-auth-only consumption, fallback semantics, docs
scope, and follow-up boundary are fixed by this design.
