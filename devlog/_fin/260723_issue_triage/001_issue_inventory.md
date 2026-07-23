# 001 — Issue Inventory (overnight 2026-07-22/23)

Source: `gh issue list --state open` + `gh issue view` on 2026-07-23 KST,
repo `lidge-jun/opencodex`. Overnight window: issues created 2026-07-22
12:41Z–20:39Z (= 21:41 KST – 05:39 KST+1), plus #280 which received its
resolving comment overnight (11:20Z).

## #280 —出现了codex无法通信的问题 (bug, question, needs-info) — rushidea

User had `cursor` as the only enabled provider; selecting bare `gpt-5.6-sol`
failed closed with "No enabled OpenAI provider". Owner walked through
`ocx provider add openai --sync` (preserving the Cursor config). Reporter
confirmed 2026-07-22 11:20Z: new + existing threads work; asked whether it was
their own misconfiguration. → Bucket 1: final answer + close.

## #287 — [Bug][Linux] Claude Code 자동 연결 미적용 — jhste102lab

GUI `/#claude` auto-connect saves `systemEnv: true` but no env injection
happens on Linux: no `ANTHROPIC_BASE_URL` in new shells, no
`~/.opencodex/claude-env.sh`. Reporter located the darwin-only guard in
`src/server/system-env.ts`. Open question: Linux support vs GUI honesty.
→ Bucket 2, lane 5.

## #288 — spawn_agent 拒绝自定义模型 (Ark/glm-5.2) — Kling0012

Codex Desktop on Windows; main session routes via OpenCodex to Volcengine ARK,
but `spawn_agent(model="Ark/glm-5.2")` fails instantly with
`Unknown model ... Available models: gpt-5.6-terra, gpt-5.6-sol` — before any
request reaches the proxy. Omitting `model` works (inherits parent).
→ Bucket 2, lane 6 (A-audit demoted it from bucket-1 candidate: OpenCodex's
catalog featuring influences the spawn_agent allowlist — boundary unresolved).

## #289 — Volcengine Ark Agent Plan Responses URL에 /v1 중복 — lijianmac

`openai-responses` adapter key-auth branch turns baseUrl
`https://ark.cn-beijing.volces.com/api/plan/v3` into
`.../api/plan/v3/v1/responses` → 404. `openai-chat` works on the same base.
Reporter proposes configurable responses path. → Bucket 2, lane 4.

## #290 — V2 custom-model parent emits empty spawn_agent arguments — brunoflma

Custom-model parent spawning custom-model child: tool router receives empty
args (`message` missing), rejects every attempt, parent retries until timeout.
v2.7.31. Needs opencodex-vs-upstream determination (#92 family?).
→ Bucket 2, lane 6.

## #291 — [Feature] Providers 페이지 edit 버튼 — str0203

Edit existing provider config in the dashboard instead of delete+re-add.
A-audit found the capability already exists (provider workspace Settings tab,
PATCH /api/providers). → Bucket 1: answer + close after reporter confirmation.

## #292 — allowPrivateNetwork 무시 (model discovery) — str0203

`allowPrivateNetwork: true` lets data-plane requests through but model
discovery (`GET /v1/models`) is still blocked for hosts resolving to reserved
ranges (e.g. 198.18.0.0/15); dashboard shows "—" models, `ocx sync` logs
SyntaxError. Manual curl succeeds. → Bucket 2, lane 3.

## #294 — [Feature] Claude account pool — str0203

Parity with ChatGPT pool. Corrected framing: multi-account Claude already
exists (manual switching); the gap is AUTOMATIC quota-aware routing, affinity,
cooldown/failover. Architecture-scale. → Bucket 3 (roadmap).

## #295 — Multi-agent guidance advertises rejected spawn models — mihneaptu

Default v2 guidance calls schema-visible args "hidden" and uses "never claim"
wording; roster (`gpt-5.6-sol, gpt-5.5, gpt-5.6-terra, gpt-5.6-luna`) diverges
from the runtime allowlist (`gpt-5.6-sol, gpt-5.6-terra`); models got
misclassified as prompt injection. Workaround: `subagentModels` +
`injectionPrompt` override. → Bucket 2, lane 2.

## #297 — catalog clamp strips max/ultra (regression b7ce5aad) — Wibias

`clampCatalogModelsToCodexSupport` derives the supported effort set from the
binary's bundled native entries (which stop at xhigh), then strips max/ultra
from EVERY catalog model as the last sync step, undoing
ensureGpt56ReasoningLevels/ensureUltraReasoningLevel. Three fix options
proposed by reporter. → Bucket 2, lane 1.

## #300 — Kill switch for multi-agent guidance injection — ildunari

Supported boolean (e.g. `multiAgentGuidanceEnabled: false`) that disables the
injected developer message while keeping v2 surface + roster. Current
containment: single-space `injectionPrompt` (undocumented). → Bucket 2,
lane 2 (same code as #295).
