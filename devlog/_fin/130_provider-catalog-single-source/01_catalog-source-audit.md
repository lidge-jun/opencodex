# 130.01 — Provider Catalog Source Audit

Independent read of all three catalogs at authoring time. Every row in the divergence matrix
below is backed by a file:line citation from the repo (not from training data).

## Surface A — GUI (`AddProviderModal.tsx`)

### Static `PRESETS` (quick-pick, always present)

Defined at `gui/src/components/AddProviderModal.tsx:29-43`:

| id | label | adapter | baseUrl | defaultModel | auth |
|----|-------|---------|---------|--------------|------|
| `openai` | OpenAI (ChatGPT login) | `openai-responses` | `https://chatgpt.com/backend-api/codex` | — | forward |
| `xai` | xAI Grok | `openai-chat` | `https://api.x.ai/v1` | `grok-4.3` | oauth (`oauthProvider: xai`) |
| `anthropic` | Anthropic Claude | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-5` | oauth |
| `kimi` | Kimi | `openai-chat` | `https://api.moonshot.ai/v1` | `kimi-k2.6` | oauth |
| `openai-apikey` | OpenAI (API key) | `openai-responses` | `https://api.openai.com/v1` | `gpt-5.5` | key |
| `opencode-go` | opencode go | `openai-chat` | `https://opencode.ai/zen/go/v1` | `kimi-k2.6` | key |
| `openrouter` | OpenRouter | `openai-chat` | `https://openrouter.ai/api/v1` | — | key |
| `groq` | Groq | `openai-chat` | `https://api.groq.com/openai/v1` | — | key |
| `google` | Google Gemini | `google` | `https://generativelanguage.googleapis.com` | `gemini-3-pro` | key |
| `azure-openai` | Azure OpenAI | **`azure-openai`** | Azure deployment URL template | — | key |
| `ollama` | Ollama (local) | `openai-chat` | `http://localhost:11434/v1` | — | key |
| `vllm` | vLLM (local) | `openai-chat` | `http://localhost:8000/v1` | — | key |
| `lm-studio` | LM Studio (local) | `openai-chat` | `http://localhost:1234/v1` | — | key |
| `custom` | Custom provider | `openai-chat` | `""` | — | key |

### Runtime merge (`/api/key-providers`)

`AddProviderModal.tsx:86-100` fetches `GET /api/key-providers` (served from
`listKeyLoginProviders()` → `KEY_LOGIN_PROVIDERS`) and appends any id **not** already in static
`PRESETS`, keeping `custom` last. Effective GUI list when proxy is running: **13 static (excl. `custom`) + 30 key-login rows not
already in static** (`opencode-go` deduped at `AddProviderModal.tsx:95-96`) → **43 selectable
presets** — same cardinality as `buildInitProviders()`, plus a `custom` escape hatch.

When the proxy is **not** running, the fetch fails silently (`AddProviderModal.tsx:90`) → GUI
shows only the **13 non-custom static presets**. CLI `ocx init` still lists all 43 built-in rows.

## Surface B — CLI / registry

### `KEY_LOGIN_PROVIDERS` (`key-providers.ts:26-91`)

31 API-key catalog entries (post–BUG A hotfix). Full id list:

`deepseek`, `cerebras`, `together`, `fireworks`, `firepass`, `moonshot`, `huggingface`,
`nvidia`, `venice`, `zai`, `nanogpt`, `synthetic`, `qwen-portal`, `qianfan`, `alibaba`,
`parallel`, `zenmux`, `litellm`, `ollama-cloud`, `mistral`, `minimax`, `minimax-cn`,
`kimi-code`, `opencode-zen`, `opencode-go`, `vercel-ai-gateway`, `xiaomi`, `kilo`,
`cloudflare-ai-gateway`, `github-copilot`, `gitlab-duo`.

`enrichProviderFromCatalog` (`key-providers.ts:99-106`) only consults this map — **no OAuth
ids**, no hardcoded init ids.

### `OAUTH_PROVIDERS` (`oauth/index.ts:19-65`)

| id | adapter | baseUrl | defaultModel (registry) | defaultModel (providerConfig) |
|----|---------|---------|-------------------------|-------------------------------|
| `xai` | `openai-chat` | `https://api.x.ai/v1` | `grok-4.3` | `grok-4.3` (`:36`) |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-6` | `claude-sonnet-4-6` (`:49`) |
| `kimi` | `openai-chat` | **`https://api.kimi.com/coding/v1`** | `kimi-k2.6` | `kimi-k2.6` (`:61`) |

### `buildInitProviders()` assembly (`init.ts:38-61`)

| Segment | ids | Source lines |
|---------|-----|--------------|
| Forward | `openai` | `init.ts:41` |
| OAuth | `xai`, `anthropic`, `kimi` | `init.ts:43-45` ← `OAUTH_PROVIDERS` |
| Hardcoded key | `openai-apikey`, `openrouter`, `groq`, `google`, `azure-openai` | `init.ts:48-52` |
| Key catalog | all `KEY_LOGIN_PROVIDERS` keys | `init.ts:54-55` |
| Local | `ollama`, `vllm`, `lm-studio` | `init.ts:58-60` |

**Total: 43 init rows.** Hardcoded key block duplicates static GUI presets for the same five ids
instead of importing a shared constant.

## Surface C — Bundled metadata

### `PROVIDER_ALIASES` (`generate-jawcode-metadata.ts:4-17`)

| opencodex id (alias key) | jawcode bundle id |
|--------------------------|-------------------|
| `xai` | `xai` |
| `anthropic` | `anthropic` |
| `google` | `google` |
| `gemini` | `google` |
| `moonshot` | `moonshot` |
| `kimi` | `moonshot` |
| `openrouter` | `openrouter` |
| `opencode-go` | `opencode-go` |
| `minimax` | `minimax` |
| `minimax-cn` | `minimax` |

`allowedProviders` = unique alias targets (`generate-jawcode-metadata.ts:34`). Generated
`DATA` keys in `jawcode-model-metadata.ts:28-35`: `anthropic`, `google`, `minimax`, `moonshot`,
`opencode-go`, `openrouter`, `xai`.

### Consumption path (`codex-catalog.ts:90-99`)

```90:99:src/codex-catalog.ts
function applyJawcodeCatalogMetadata(entry: RawEntry, slug: string): void {
  const slash = slug.indexOf("/");
  if (slash < 0) return;
  const provider = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  const jawcodeProvider = resolveJawcodeProvider(provider);
  if (!jawcodeProvider) return;
  const meta = getJawcodeModelMetadata(jawcodeProvider, modelId);
  if (!meta) return;
```

Lookup is **exact string match** on `modelId` (`jawcode-model-metadata.ts:42-43`:
`DATA[provider]?.find(r => r[0] === modelId)`).

**Casing example (minimax):** `KEY_LOGIN_PROVIDERS.minimax.defaultModel` is `MiniMax-M2.5`
(`key-providers.ts:71`). Generated minimax rows use CamelCase ids (`jawcode-model-metadata.ts:31`:
`MiniMax-M2.5`, …). The `opencode-go` bundle also lists lowercase routed ids such as
`minimax-m2.5` (`jawcode-model-metadata.ts:33`). A catalog slug `minimax/minimax-m2.5` resolves
the provider alias but **misses** metadata because `modelId` casing differs.

**jawcode naming (external):** jawcode `models.json` defines separate provider keys
`minimax`, `minimax-code`, `minimax-code-cn` (e.g. `models.json:37381`, `:37821`). opencodex
maps only `minimax` / `minimax-cn` → jawcode `minimax` (not `minimax-code*`).

---

## Complete divergence matrix

Legend: **✓** = present / aligned · **—** = intentionally absent · **✗** = mismatch · **△** =
structural asymmetry (not necessarily a bug).

### 1 — ID presence across surfaces

| id | GUI static PRESETS | GUI (proxy up) | `KEY_LOGIN` | `buildInit` | metadata alias | Notes |
|----|-------------------|----------------|-------------|-------------|----------------|-------|
| `openai` | ✓ `:30` | ✓ | — | ✓ forward `:41` | — | forward; no metadata needed |
| `xai` | ✓ oauth `:31` | ✓ | — | ✓ oauth `:43-45` | ✓ alias `:5` | OAuth registry |
| `anthropic` | ✓ oauth `:32` | ✓ | — | ✓ oauth | ✓ alias `:6` | OAuth registry |
| `kimi` | ✓ oauth `:33` | ✓ | — | ✓ oauth | ✓ `kimi`→`moonshot` `:10-11` | OAuth id; see field mismatches |
| `openai-apikey` | ✓ `:34` | ✓ | — | ✓ hardcoded `:48` | — | Duplicated hardcoded |
| `opencode-go` | ✓ `:35` | ✓ | ✓ `:75-77` | ✓ key-login | ✓ alias `:12` | **BUG A** was ✗ in `KEY_LOGIN` (fixed) |
| `openrouter` | ✓ `:36` | ✓ | — | ✓ hardcoded `:49` | ✓ alias `:11` | Hardcoded + alias |
| `groq` | ✓ `:37` | ✓ | — | ✓ hardcoded `:50` | — | Hardcoded only |
| `google` | ✓ `:38` | ✓ | — | ✓ hardcoded `:51` | ✓ `google` alias `:7` | id `google` not `gemini` |
| `azure-openai` | ✓ `:39` | ✓ | — | ✓ hardcoded `:52` | — | **adapter mismatch** (below) |
| `ollama` | ✓ local `:40` | ✓ | — | ✓ local `:58` | — | Local server |
| `vllm` | ✓ `:41` | ✓ | — | ✓ local `:59` | — | Local server |
| `lm-studio` | ✓ `:42` | ✓ | — | ✓ local `:60` | — | Local server |
| `custom` | ✓ `:43` | ✓ | — | — | — | GUI-only manual entry |
| `deepseek` | — | ✓ via API | ✓ `:27` | ✓ | — | No metadata alias |
| `cerebras` | — | ✓ | ✓ `:28` | ✓ | — | |
| `together` | — | ✓ | ✓ `:29` | ✓ | — | |
| `fireworks` | — | ✓ | ✓ `:30` | ✓ | — | |
| `firepass` | — | ✓ | ✓ `:31` | ✓ | — | Same baseUrl as fireworks |
| `moonshot` | — | ✓ | ✓ `:32` | ✓ | ✓ `moonshot` alias `:9` | **Different endpoint from oauth `kimi`** |
| `huggingface` | — | ✓ | ✓ `:33` | ✓ | — | |
| `nvidia` | — | ✓ | ✓ `:34` | ✓ | — | |
| `venice` | — | ✓ | ✓ `:35` | ✓ | — | |
| `zai` | — | ✓ | ✓ `:36` | ✓ | — | |
| `nanogpt` | — | ✓ | ✓ `:37` | ✓ | — | |
| `synthetic` | — | ✓ | ✓ `:38` | ✓ | — | |
| `qwen-portal` | — | ✓ | ✓ `:39` | ✓ | — | |
| `qianfan` | — | ✓ | ✓ `:40` | ✓ | — | |
| `alibaba` | — | ✓ | ✓ `:41` | ✓ | — | |
| `parallel` | — | ✓ | ✓ `:42` | ✓ | — | |
| `zenmux` | — | ✓ | ✓ `:43` | ✓ | — | |
| `litellm` | — | ✓ | ✓ `:44` | ✓ | — | |
| `ollama-cloud` | — | ✓ | ✓ `:51-65` | ✓ | — | Rich `models` / `noVisionModels` seed |
| `mistral` | — | ✓ | ✓ `:70` | ✓ | — | |
| `minimax` | — | ✓ | ✓ `:71` | ✓ | ✓ alias `:15` | **BUG B** was ✗ alias (fixed); casing risk |
| `minimax-cn` | — | ✓ | ✓ `:72` | ✓ | ✓ alias `:16` | **BUG B** was ✗ alias (fixed) |
| `kimi-code` | — | ✓ | ✓ `:73` | ✓ | — | Same host as oauth `kimi`; diff defaultModel |
| `opencode-zen` | — | ✓ | ✓ `:74` | ✓ | — | Sibling endpoint to `opencode-go` |
| `vercel-ai-gateway` | — | ✓ | ✓ `:78` | ✓ | — | |
| `xiaomi` | — | ✓ | ✓ `:80` | ✓ | — | `anthropic` adapter |
| `kilo` | — | ✓ | ✓ `:87` | ✓ | — | |
| `cloudflare-ai-gateway` | — | ✓ | ✓ `:88` | ✓ | — | `anthropic` adapter; URL template |
| `github-copilot` | — | ✓ | ✓ `:89` | ✓ | — | |
| `gitlab-duo` | — | ✓ | ✓ `:90` | ✓ | — | |
| `gemini` | — | — | — | — | ✓ alias only `:8` | **No catalog id `gemini`** — alias unused unless user names provider `gemini` |

**Summary counts**

| Set | Count |
|-----|-------|
| GUI static preset ids (excl. `custom`) | 13 |
| `KEY_LOGIN_PROVIDERS` ids | 31 |
| `buildInitProviders` rows | 43 |
| `PROVIDER_ALIASES` keys | 10 |
| Key-login ids **without** metadata alias | 28 |
| Init/hardcoded ids with metadata alias but not in `KEY_LOGIN` | 5 (`xai`, `anthropic`, `kimi`, `google`, `openrouter`) |

### 2 — Field mismatches (same id, different surfaces)

| id | Field | GUI static (`AddProviderModal.tsx`) | CLI / registry | Severity |
|----|-------|-------------------------------------|----------------|----------|
| `anthropic` | `defaultModel` | `claude-sonnet-4-5` (`:32`) | `claude-sonnet-4-6` (`oauth/index.ts:49`, `init` via oauth `:45`) | ✗ User picks older default in GUI OAuth pane |
| `kimi` | `baseUrl` | `https://api.moonshot.ai/v1` (`:33`) | `https://api.kimi.com/coding/v1` (`oauth/index.ts:58`) | ✗ **Different API hosts** for same OAuth id |
| `kimi` | vs `moonshot` KEY_LOGIN | moonshot.ai in GUI preset | `moonshot` key-login uses moonshot.ai (`key-providers.ts:32`) but oauth `kimi` uses kimi.com (`oauth/index.ts:58`) | △ Two "Kimi" entry points |
| `azure-openai` | `adapter` | `azure-openai` (`:39`) | `azure` (`init.ts:52`) | ✗ Saved config adapter string differs by surface |
| `kimi-code` | `defaultModel` | — | `kimi-k2.5` (`key-providers.ts:73`) vs oauth `kimi-k2.6` (`oauth/index.ts:61`) | △ Same coding API host, different seed default |
| `minimax` | `defaultModel` vs metadata | `MiniMax-M2.5` (`key-providers.ts:71`) | metadata row id `MiniMax-M2.5` (`jawcode-model-metadata.ts:31`) | ✓ aligned, but routed lowercase ids miss lookup |
| `opencode-go` | all fields | `:35` | `key-providers.ts:75-77` | ✓ aligned post–BUG A |

### 3 — Structural asymmetries (by design today, still drift vectors)

| ID | Issue | Evidence |
|----|-------|----------|
| **GUI offline** | 28 key-login providers invisible without running proxy | `AddProviderModal.tsx:86-90` silent catch; init always complete (`init.ts:54-55`) |
| **Triple duplication** | `openai-apikey`, `openrouter`, `groq`, `google`, `azure-openai` exist in GUI `PRESETS` **and** `init.ts:48-52` **outside** `KEY_LOGIN_PROVIDERS` | Two edit sites for the same five ids |
| **`opencode-go` double seed** | Listed in static GUI `PRESETS` **and** `KEY_LOGIN_PROVIDERS` | `:35` + `key-providers.ts:75-77` — deduped at runtime (`:95-96`) but two authoring locations |
| **Metadata optional** | 28/31 key-login ids have no jawcode alias — catalog enrichment silently skipped | `applyJawcodeCatalogMetadata` no-op when `resolveJawcodeProvider` returns undefined (`codex-catalog.ts:95-96`) |
| **`enrichProviderFromCatalog` scope** | Only `KEY_LOGIN_PROVIDERS`; OAuth providers never enriched | `key-providers.ts:99-106` |
| **Parity contract** | Claims GUI parity via shared registries but GUI also relies on separate static `PRESETS` | `init.ts:33-36` vs `AddProviderModal.tsx:29-43` |

### 4 — Hotfixed drift (documented for regression guard)

| Bug | Before hotfix | After hotfix | Evidence |
|-----|---------------|--------------|----------|
| **A — `opencode-go`** | In GUI `:35` + metadata `:12`; missing `KEY_LOGIN` → init/enrich no-op | Entry at `key-providers.ts:75-77` | Comment at `:75-76` cites GUI parity |
| **B — `minimax`** | In `KEY_LOGIN` `:71-72`; no metadata alias | Aliases `:15-16` in generator; rows in `jawcode-model-metadata.ts:31` | Comment at `generate-jawcode-metadata.ts:13-14` |

---

## Audit conclusions

1. **ID parity** between `buildInitProviders()` and GUI-with-proxy is now **43 vs 43** (excluding
   GUI `custom`), but **static GUI alone** matches only **13** ids — a user adding providers from
   a cold GUI sees a much smaller list than `ocx init`.
2. **Field parity** is broken for **`kimi` (baseUrl)**, **`anthropic` (defaultModel)**, and
   **`azure-openai` (adapter)** even when ids align.
3. **Metadata coverage** is intentionally sparse (7 jawcode bundles) but **alias maintenance is
   manual** and orthogonal to catalog membership — BUG B proved that.
4. **Exact `modelId` matching** makes metadata enrichment fragile for providers whose live `/models`
   ids use different casing than jawcode `models.json` (minimax is the concrete example today).

These findings drive the single-source design in `02_single-source-design.md`.
