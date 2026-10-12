# 001 — Cursor Private Inference bundle protocol

Scope: static inspection of Cursor Private Inference 3.18.25. Evidence comes from the installed macOS bundle; Windows/Linux layout is derived from the repository’s existing install detector, not from inspected binaries.

## Build identity and bundle paths

`product.json` reports:

```json
{
  "nameLong": "Cursor Private Inference",
  "version": "3.18.25",
  "quality": "stable",
  "commit": "280eca2911f1774689696e5f1efa5a4f97a87af0",
  "realCommit": "280eca2911f1774689696e5f1efa5a4f97a87af3",
  "date": "2026-08-31T23:07:17.484Z",
  "applicationName": "cursor",
  "dataFolderName": ".cursor"
}
```

`buildFlags` and `releaseTrack` are absent. `quality: "stable"` is the only release-channel field. The workbench bundle, not `product.json`, enables the build:

```js
fl={...,localMode:!1},fl.localMode=!0
```

Paths relative to the install root:

| Platform | product.json | agent bundle |
|---|---|---|
| macOS | `Contents/Resources/app/product.json` | `Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js` |
| Windows | `resources/app/product.json` | `resources/app/extensions/cursor-agent-exec/dist/main.js` |
| Linux package/extracted AppImage | `resources/app/product.json` | `resources/app/extensions/cursor-agent-exec/dist/main.js` |

The inspected bundle is 9,932,774 bytes, MD5 `c2b57b0141b05e7e6e56cdcc206b95a5`. Regular Cursor 3.18.25 has a byte-identical `cursor-agent-exec` bundle; local-mode activation differs in the workbench.

## Configuration inputs

Workbench provider resolution precedence for both API key and Base URL is:

1. requested model credentials: `modelDetails.apiKey`, `modelDetails.openaiApiBaseUrl`, or `modelDetails.apiKeyCredentials.{apiKey,baseUrl}`;
2. stored secret `openAIKey` and application storage `openAIBaseUrl`;
3. `CURSOR_LOCAL_AGENT_API_KEY` / `CURSOR_LOCAL_AGENT_BASE_URL`;
4. compatibility variables `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`.

Therefore environment variables do not override an already-saved gateway. A URL whose path is `/` becomes `/v1`; trailing slashes are removed.

Provider-specific environment variables:

| Variable | Reader/effect |
|---|---|
| `CURSOR_LOCAL_AGENT_BASE_URL` | fallback Base URL |
| `CURSOR_LOCAL_AGENT_API_KEY` | fallback API key |
| `CURSOR_LOCAL_AGENT_HEADERS` | custom headers; newline-separated `Name: value`, not `key=value` |
| `CURSOR_LOCAL_AGENT_ALLOW_CURSOR_HOST` | comma-separated hosts for which an Anthropic `/messages` Base URL is stripped before SDK construction |
| `CURSOR_LOCAL_AGENT_INFERENCE_METADATA` | outgoing `x-cursor-metadata` header |
| `CURSOR_AGENT_LOCAL_REQUEST_LOG` | JSONL request log path; `0`, `false`, or `off` disables |
| `CURSOR_AGENT_LOCAL_REQUEST_LOG_HTML` | companion rendered-log path |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | lowest-precedence compatibility fallback |

`CURSOR_LOCAL_AGENT_HEADERS` rejects invalid HTTP names/values, `User-Agent`, and unresolved `{...}` placeholders. It expands `{gitOrgRepo}` and `{gitBranch}`.

Persistent settings/state read by the desktop path include `useOpenAIKey`, `openAIBaseUrl`, secure `openAIKey`, `availableDefaultModels2`, `localProviderModelIds`, `localProviderAgentModelIds`, `modelPickerDisplayConfiguration`, and `aiSettings.modelConfig.composer`.

The agent library also supports:

```ts
localProvider: {
  kind: "http",
  endpoints: Array<{
    baseUrl: string;
    apiKey?: string;
    apiKeyHelper?: { scriptPath: string; ttlMs: number };
  }>;
}
customHeaders?: Record<string, string>;
```

`apiKeyHelper` runs the readable script through `/bin/sh`, caches stdout by `scriptPath + ttlMs`, and sets both `Authorization: Bearer ...` and `X-Api-Key`. The desktop IPC currently constructs exactly one endpoint and passes no `apiKeyHelper`; these are library capabilities, not exposed desktop settings.

## `/models` discovery, cache, fallback, and endpoint selection

There are two fetch paths:

- `spe`, the per-turn metadata probe, uses `Vme=2e3`: a 2-second abort timeout.
- `vye` / `fetchLocalProviderModels`, used for full picker enrichment, has no explicit timeout.

Both send `GET {normalizedBaseUrl}/models`, `User-Agent: Cursor/<version>`, custom headers, and `Authorization: Bearer <apiKey>`. A helper-derived key additionally sends `X-Api-Key`.

`npe` caches successful raw catalogs forever by Base URL string only. `rpe` deduplicates concurrent probes. A full enrichment fetch overwrites `npe`; per-turn probes never revalidate it.

The curated fallback list is verbatim:

```js
const P=["claude-opus-4-8","claude-sonnet-5","claude-sonnet-4-6","gemini-3-pro-preview","grok-4.5"];
```

It is used only when discovery fails for `inference.tesla.com` or a subdomain. Generic gateways do not receive this fallback; they retain persisted/local companion models where available.

For multiple endpoints, all are probed concurrently. Model resolution attempts:

1. exact full-id match;
2. Composer compatibility aliases;
3. a unique match after stripping the prefix before the last `/`;
4. a unique `-preview` suffix match.

An exact requested id across endpoints wins; otherwise the first resolved candidate in endpoint order wins. If the selected catalog id differs, `remappedModelId` replaces the request’s model id. If none resolve, the first endpoint is used.

## Wire API selection and request rewriting

A Base URL ending in `/messages` forces `anthropic_messages`.

Otherwise:

- only `anthropic_messages`, with no OpenAI-family entry, selects Anthropic Messages;
- `responses` or `openai_responses` selects Responses;
- otherwise `chat_completions` or `openai_chat` selects Chat Completions;
- Responses wins when both Responses and Chat are advertised;
- an explicit caller `apiType` overrides discovery.

Effort rewriting reads model parameter ids `reasoning`, `effort`, or `thought_level`:

| Selected wire | Request fields |
|---|---|
| Responses | `reasoning: { ...existing, effort }`; remove `reasoning_effort` |
| Chat Completions | `reasoning_effort: effort` |
| Anthropic Messages | `thinking:{type:"adaptive",display:"summarized"}` and `output_config.effort`; remove `top_p` and `top_k` |

The selected value must occur in Cursor’s hard-coded ladder. `output_config.effort` is accepted only on Anthropic Messages; `reasoning_effort` families are accepted only on OpenAI-compatible wires. Unsupported combinations have both `reasoning` and `reasoning_effort` removed.

Consequently, with the documented `/v1` Base URL, Claude controls can render but their `output_config.effort` is removed because Responses is selected. A `/v1/messages` Base URL enables Claude effort but removes GPT/Grok/Gemini effort. The desktop’s singleton endpoint cannot automatically split these families.

For Anthropic Messages only, `max_tokens` is overwritten when extended capabilities were detected:

```js
family.outputCap !== undefined
  ? family.outputCap
  : advertised capabilities.max_output_tokens
```

Known Claude families therefore prefer Cursor’s hard-coded 32K/64K/128K cap over the advertised value. OpenAI-compatible requests do not consume the advertised maximum in this rewrite layer.

## Extended-capability schema and optional-field sources

Exact schema fragment:

```js
const lme=new Set(["chat_completions","responses","openai_chat","openai_responses","anthropic_messages"]);
const mme=on.KC([on.g1(on.L5()),on.YO(on.g1(on.L5()))]);
const pme=on.Ik({
  context_length:on.ai().finite().positive().optional(),
  max_output_tokens:on.ai().finite().positive().optional(),
  output_modalities:on.YO(on.Yj()).optional(),
  input_modalities:on.YO(on.Yj()).optional(),
  supports_tool_use:on.zM().optional(),
  supports_streaming:on.zM().optional(),
  supports_reasoning:on.zM().optional(),
  supports_vision:on.zM().optional(),
  reasoning_effort:on.YO(on.Yj()).optional(),
  cost:mme.optional()
});
const fme=on.Ik({
  api_types:on.YO(on.Yj().min(1)).min(1).refine(e=>e.some(e=>lme.has(e))),
  capabilities:pme.optional(),
  cost:mme.optional()
});
```

`extendedCapabilitiesDetected = data.some(row => fme.safeParse(row).success)`. One qualifying row flips the endpoint globally.

When extended mode is true, an individual picker row requires `api_types`, `capabilities`, a supported API type, `supports_tool_use === true`, `supports_streaming === true`, and `output_modalities` containing `"text"`. Mixed legacy/extended catalogs can therefore lose otherwise valid rows.

Optional-field normalization:

- `context_length`: `capabilities.context_length` wins; top-level `context_length` fills it only when absent.
- `max_output_tokens`: read only from `capabilities.max_output_tokens`.
- modalities, support booleans, reasoning ladder: read only from `capabilities`.
- long-context threshold precedence:
  1. `cost.long_context.threshold_tokens`;
  2. `capabilities.cost.long_context.threshold_tokens`;
  3. smallest positive `pricing.overrides[].min_prompt_tokens`.
- Raw top-level `long_context_threshold_tokens` is not read. The parser creates its internal top-level field only from the three sources above.
- Nested `cost.long_context` conflicts with `mme`’s numeric-record schema and can prevent that row from satisfying `fme`. `pricing` is outside `fme`, making it the safe encoding currently used by OpenCodex.

## Feature toggles gated by extended capabilities

Direct uses found across all 34 occurrences:

- expose the model-family Reasoning parameter;
- switch local web-search requests from `web_search_preview` to `web_search`;
- enable strict row admission during picker enrichment;
- allow Anthropic `max_tokens` injection from family/advertised limits;
- carry the flag into request rewriting and picker metadata.

No additional image, MCP, ordinary function-tool, streaming, or vision feature toggle is directly keyed on this flag.

## Unsupported reasoning drift

`findUnsupportedReasoningModelIds` normalizes ids exactly like the effort table, deduplicates them, and reports ids whose row has `supports_reasoning === true` but matches neither a table family nor bare GPT-5.

After a successful non-empty local picker enrichment, the workbench emits one structured `transport` error per id:

> Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family; reasoning controls will be unavailable until it is added to bottlerocket-families

Malformed/dropped rows and failed enrichment do not reach this log.

## Effort table, verbatim

```js
const w={param:"reasoning_effort",values:["low","medium","high","xhigh"],defaultValue:"medium"};
function _(e){const t=function(e){let t=e.trim().toLowerCase();const n=t.lastIndexOf("/");-1!==n&&(t=t.slice(n+1));const r=t.indexOf("@");return-1!==r&&(t=t.slice(0,r)),t}(e);if(/^gpt-5(?:\.\d+)?$/u.test(t))return w}
const T={param:"output_config.effort",values:["low","medium","high","max"],defaultValue:"high"};
const k={param:"output_config.effort",values:["low","medium","high","xhigh","max"],defaultValue:"high"};
const S={param:"reasoning_effort",values:["minimal","low","medium","high","xhigh"],defaultValue:"high"};
const b=[
{id:"anthropic-opus-5",matches:e=>/^claude-opus-5$/u.test(e),effort:k,outputCap:128e3},
{id:"anthropic-opus-4-7-4-8",matches:e=>/^claude-opus-4[-.](?:7|8)$/u.test(e),effort:k,outputCap:128e3},
{id:"anthropic-opus-4-6",matches:e=>/^claude-opus-4[-.]6$/u.test(e),effort:T,outputCap:128e3},
{id:"anthropic-opus-4-5",matches:e=>/^claude-opus-4[-.]5$/u.test(e),effort:T,outputCap:64e3},
{id:"anthropic-sonnet-4-6",matches:e=>/^claude-sonnet-4[-.]6$/u.test(e),effort:T,outputCap:64e3},
{id:"anthropic-sonnet-5",matches:e=>/^claude-sonnet-5$/u.test(e),effort:k,outputCap:128e3},
{id:"anthropic-sonnet-no-effort",matches:e=>/^claude-sonnet-4(?:[-.]5)?$/u.test(e),outputCap:64e3},
{id:"anthropic-haiku-4-5",matches:e=>/^claude-haiku-4[-.]5$/u.test(e),outputCap:32768},
{id:"grok-4.3",matches:e=>/^grok-4[.-]3$/u.test(e),effort:S},
{id:"grok-4.5",matches:e=>/^grok-4[.-]5(?:-(?:batch|build|nocomp))?$/u.test(e),effort:S},
{id:"grok-4.6",matches:e=>/^grok-4[.-]6(?:-(?:batch|build|nocomp))?$/u.test(e),effort:S},
{id:"grok-build-latest",matches:e=>/^grok-build-latest$/u.test(e),effort:S},
{id:"grok-reasoning-no-effort",matches:e=>/^grok-(?:composer(?:-2\.5(?:-fast)?)?|4\.20-0309-reasoning|4\.20-multi-agent-0309|420-clanker-reasoning)$/u.test(e)},
{id:"gpt-5.6",matches:e=>/^gpt-5[.-]6-(?:luna|sol|terra)$/u.test(e),effort:{param:"reasoning_effort",values:["low","medium","high","xhigh"],defaultValue:"medium"}},
{id:"gemini-no-effort",matches:e=>/^gemini-3\.[1-9].*flash-lite/u.test(e)},
{id:"gemini",matches:e=>/^gemini-/u.test(e),effort:{param:"reasoning_effort",values:["minimal","low","medium","high"],defaultValue:"medium"},effortRequiresReasoningCapability:!0}
];
```

## Diff-level implications for wp2

Do not add top-level `long_context_threshold_tokens`; this build ignores the raw field. Keep `pricing.overrides[].min_prompt_tokens`.

Modify `src/server/models-capabilities.ts`.

Before:

```ts
export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  longContextWindow?: number;
  inputModalities?: readonly string[];
}
```

After:

```ts
export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  longContextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: readonly string[];
}
```

Add `max_output_tokens?: number` to `ModelCapabilityFields.capabilities`, compute `const maxOutputTokens = positiveInt(input.maxOutputTokens)`, and spread it into `capabilities` only when defined.

Modify `src/server/index.ts`:

```ts
import { modelRecordValue } from "../reasoning-effort";
```

Routed-row call, before:

```ts
contextWindow: m.contextWindow,
inputModalities: m.inputModalities,
```

After:

```ts
contextWindow: m.contextWindow,
maxOutputTokens: provider
  ? modelRecordValue(provider.modelMaxOutputTokens, m.id) ?? provider.defaultMaxOutputTokens
  : undefined,
inputModalities: m.inputModalities,
```

Do not invent native limits where OpenCodex has no authoritative output-limit source.

Modify `tests/cursor-local-models-schema.test.ts`:

- Add test `"max_output_tokens is emitted only from an authoritative provider output limit"`.
- Extend `capabilityConfig()` with `defaultMaxOutputTokens: 16000` and `modelMaxOutputTokens: { k3: 32768 }`.
- Assert `k3.capabilities.max_output_tokens === 32768`.
- Assert `kimi-for-coding.capabilities.max_output_tokens === 16000`.
- Assert native `gpt-5.6-sol` omits `max_output_tokens`.
- In `"a larger opt-in window becomes context_length with the default window as the long-context threshold"`, assert no top-level `long_context_threshold_tokens` is emitted and retain the `pricing` assertion.

Focused verifier:

```sh
bun run typecheck
bun test tests/cursor-local-models-schema.test.ts tests/grok-models-effort-list.test.ts tests/server-combo-failover-e2e.test.ts
```

## Diff-level implications for wp6

Modify `docs-site/src/content/docs/guides/cursor-private-inference.md`.

Replace the `CURSOR_LOCAL_AGENT_HEADERS` claim that it uses `key=value` pairs with:

```md
`CURSOR_LOCAL_AGENT_HEADERS` is optional. Its value is newline-separated HTTP header
lines (`Header-Name: value`). It rejects `User-Agent` and invalid or unresolved values.
```

Add gateway precedence immediately after the environment block:

```md
Saved Gateway settings and per-model credentials take precedence over these environment
variables. Clear the saved gateway first if you intend to switch it through the environment.
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are lower-precedence compatibility fallbacks.
```

Correct the wire section:

```md
With a `/v1` Base URL, Cursor prefers Responses. GPT/Grok/Gemini effort is sent on that
wire, but Claude's `output_config.effort` is removed because it is Messages-only. A Base URL
ending in `/messages` reverses that behavior: Claude effort is sent, while OpenAI-family
effort fields are removed. One desktop gateway cannot split both families automatically.
```

Add an “Identify the installed build” subsection containing the platform-relative bundle paths, `nameLong`, `version`, `quality`, and the fact that `localMode` is in the workbench bundle rather than `product.json`.

Update troubleshooting to say the cache has no TTL; Refresh performs full discovery, while restart or a changed Base URL is the fallback if stale metadata remains.

Verification:

```sh
cd docs-site && bun run build
bun run privacy:scan
rg -n 'downloads.cursor.com|cursor-local/' docs-site/src/content/docs/guides/cursor-private-inference.md
```

## RISKS

- This is an undocumented, minified private protocol and can change without schema versioning.
- Static bundle inspection does not prove every provider/wire combination end to end.
- One extended row globally enables strict filtering and can make mixed legacy rows disappear.
- Cursor’s hard-coded Claude output cap overrides the gateway-advertised maximum; OpenCodex must still enforce its own limit.
- The desktop exposes only one endpoint even though the library supports several.
- Windows/Linux bundle contents were not inspected; only their repository-defined layout is recorded.
- `apiKeyHelper` hard-codes `/bin/sh`, making its cross-platform behavior doubtful even if a future desktop path exposes it.

## OPEN QUESTIONS

- Should wp2 advertise provider output limits now, given that known Claude families ignore them in favor of Cursor’s cap?
- Should wp6 document `/messages` as a supported Claude-only profile, or only warn that Claude effort is inert on `/v1`?
- Does OpenCodex’s Messages ingress preserve `thinking + output_config.effort` for every routed Claude provider?
- Does Refresh reliably overwrite `npe` in all desktop flows, or are restart/Base-URL changes still required in practice?
- Are Windows and Linux 3.18.25 bundles byte-identical to the inspected macOS bundle?


