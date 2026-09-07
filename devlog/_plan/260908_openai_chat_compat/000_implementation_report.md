# K3 Codex 适配 Phase 0–3 Implementation Report

日期：2026-09-08 · 仓库：/Users/earan/work/opencodex-k3-adapt · 分支 k3-codex-compat · 基线 upstream dev @ b3dec89

## Phase 0 审计结论（数据流 Codex -> OpenCodex -> K3 -> OpenCodex -> Codex）

K3（kimi provider, openai-chat adapter, api.kimi.com/coding/v1）当前已具备：image input（modelInputModalities）、reasoning ladder low/high/max（modelReasoningEffortMap medium->high, xhigh->max）、preserveReasoningContentModels 多轮回放、Moonshot draft-07 $ref schema 规范化、apply_patch 信封修复、terminal-guard/empty-completion-guard。instructions 在转发链中完整保留（systemPrompt 首位 + developer 消息并入 system），无覆盖/截断。

确认的工具能力退化点（全部为机制层面，非模型层面）：

1. **parallel tool calls 双闸均未开**：provider 未设 parallelToolCalls（wire 层省略该字段，openai-chat.ts:1598-1610 注释"kimi rejects true"），catalog 层 supports_parallel_tool_calls=false（parsing.ts:764）。
2. **生成式 metadata 表缺 k3**：moonshot bundle 只有 kimi-k2.5，kimi/k3 行的 context/input 无权威来源（generatedModelMetadata 未命中）。
3. **freeform 工具降级**：custom/freeform（exec、apply_patch）在 parser-tools.ts:67-115 被降为单 string input 的 function，K3 需被告知该 wire 形态。
4. **hosted web_search 被丢弃**后由 sidecar 重注入；**namespace 展平为 ns__name**；encrypted 标记剥离。
5. EOF fail-closed（openai-chat.ts:2007）与 empty-completion 默认静默成功，长任务可能误判截断或无声停止。
6. sub-agent：multiAgentMode=default 下 routed 行无 v2 pin -> codex-rs 视 K3 为 leaf agent；roster 取 priority 前 5。

## Phase 1：K3 Codex compatibility benchmark

新增 tests/adapters/openai/k3-compat.test.ts（14 用例，全部通过）。覆盖：

- registry/路由层：kimi provider parallelToolCalls 传播、stale persisted config 继承；
- 指令面：appendix 追加在原始 instructions 与 tool-catalog nudge 之后、非 K3 模型/非 kimi host 不注入、k3[1m] selector 覆盖、token 预算 <800；
- 工具线形：freeform {input:string}、hosted web_search 丢弃、parallel_tool_calls true/false、image_url part、tool result role:tool 与 premature-termination 指导存在性；
- guard：nudge 与 appendix 互补不重复。

基线（修改前）关键值：parallel_tool_calls 字段省略；catalog supports_parallel_tool_calls=false；无 K3 appendix；moonshot metadata 无 k3 行。修改后：全部翻转。对比汇总见下表。

| 指标 | 修改前 K3 | 修改后 K3 |
|---|---|---|
| wire parallel_tool_calls | 省略 | true（可请求级关闭） |
| catalog supports_parallel_tool_calls | false | true |
| K3 指令 appendix | 无 | 追加（~470 词） |
| moonshot metadata k3 行 | 缺失 | 262144 ctx / text,image |
| 原始 instructions 保留 | 是 | 是（appendix 纯追加） |

原生 GPT baseline 未采集（本机无可用 ChatGPT 配额，标注未获取）。

## Phase 2：K3 Enhanced Model Profile（最小 diff，未伪造 OpenAI 私有协议）

- src/providers/registry.ts：kimi provider 增加 parallelToolCalls: true（带 260908 live-canary 注释与 devlog 证据指针）。未启用 use_responses_lite、code_mode_only 变更、multi_agent_v2 stamping 或 collaboration namespace——这些 GPT 专属行为按任务要求保持关闭。
- scripts/model-metadata.source.json + src/generated/model-metadata.ts：moonshot bundle 增加 kimi-k3（contextWindow 262144、maxTokens 262144、input text+image、reasoning、按 KIMI 定价 3/15/0.3）。走标准 generate:model-metadata 流程，model-metadata-sync guard 通过。注意：这是 moonshot PAYG bundle 的 k3 行；kimi coding 的 k3/k3[1m] 行继续由 registry 的 KIMI_CODING_* 常量权威供给（两者并存是既有设计，jawcodeBundle: moonshot 别名只影响缺行时的 metadata 补全）。

## Phase 3：K3 Instruction Adapter

src/adapters/openai-chat.ts：

- isKimiK3AppendixTarget：仅 api.kimi.com host + wire id 为 k3（含 k3[1m] bracket-strip 后命中）。api.moonshot.* 与 k2.x 不受影响。
- kimiK3CompatibilityAppendix()：8 句、英文、约 470 词（<800 token 预算），内容覆盖任务书要求：工具皆真实可执行、有工具优先调用、不得声称不可用、freeform input 形态与 apply_patch 信封、ns__name 命名、code-mode exec 的 tools.* 嵌套 helper 与 ALL_TOOLS、inspect before edit、定点 patch 优先、改后跑测试、独立调用并行、参数错误修正重试、tool result 后继续完成任务、node_repl/exec 用于程序化编排。
- 注入位置：systemParts 尾部，Codex 原始 instructions 与既有 tool-catalog nudge 全部保留在前。

## 验证

- bun run typecheck：exit 0。
- 新增 k3-compat.test.ts：14/14 通过。
- 受影响域聚焦测试：parallel-tool-calls-optin、openai-chat-hardening、openai-chat-eof、openai-chat-parallel-stream、tool-catalog-nudge：174/174；model-metadata-sync：1/1；selected-models + multi-agent-compat：68/68；codex-catalog：308/308。共 565 通过 / 0 失败。
- 完整 read->edit->test 工具循环与 MCP/plugin/node_repl 工作流为运行时行为，需在装有 K3 凭据的 OpenCodex 实例上做 live canary（本环境无凭据，未获取）。

## 剩余差距与下一阶段建议

1. **EOF fail-closed / empty-completion 静默**：建议 K3 专属 live canary 统计 adapter_eof 率与 empty completion 率，再决定是否给 kimi provider 开 openaiChatEofTolerance 或 emptyCompletionRetry。
2. **Sub-agent v2**：multiAgentMode=default 下 K3 是 leaf。若 live canary 证明 K3 能稳定处理 plaintext child task，可考虑对 kimi/k3 行显式 stamp multi_agent_version=v2（parsing.ts applyMultiAgentMode），进入 Phase 4 Router 范畴。
3. **Kimi Responses 端点**：用户提示 Kimi 现已支持 OpenAI Responses 格式。已探测 https://api.kimi.com/coding/v1/responses 存在（未认证 401，与 /models 一致；/coding/responses 404）。若官方确认兼容，把 kimi provider 切到 openai-responses adapter 可消除 Phase 0 所列多数翻译层退化点（freeform 降级、web_search 丢弃、reasoning_content 回放、EOF 误判），但需先实测流式 tool_call 事件、加密 function_call_output、image input 与 catalog 语义，再动 adapter 路由。
4. tool-catalog-nudge 与 appendix 有轻微主题重叠（都在教 wire 形态），目前互补；若后续 Kimi Responses 落地，appendix 可瘦身。
