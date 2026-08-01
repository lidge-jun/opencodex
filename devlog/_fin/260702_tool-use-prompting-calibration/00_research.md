# Tool-use prompting calibration — Codex-native baseline, Cursor hardening, non-OpenAI model compensation

Date: 2026-07-02
Owner: Boss direction; Codex source/local Cursor evidence pass.
Status: research + prompt strategy SOT. No production code change yet.

## Why this exists

The current Cursor-provider/tool-call work shows a wider pattern:

1. Codex-native turns are not just "chat plus tools". Codex injects model/base
   instructions, dynamic developer/context sections, and a model-visible tool catalog
   into each Responses request.
2. Cursor and other agent CLIs also inject their own upstream rule/context layers.
3. GPT-family models are expected to be relatively well aligned to OpenAI Responses tool
   semantics, exact tool names, hosted tools, `custom`/freeform tools, and the Codex
   default prompt.
4. Non-OpenAI models may have different tool-use training and product priors. In practice
   they can drift toward generic coding-agent commands or invented helpers such as
   `glob`, `read_file`, `list_dir`, or shell-ish patterns when the actual exposed catalog
   does not contain those tools.
5. Therefore Cursor needs strong, explicit correction. Other providers should receive a
   lighter but still concrete tool-contract prompt layer.

This document records the evidence and the intended prompting policy.

## Executive conclusion

Yes: Codex has a native prompt/tool injection plane.

The critical distinction is that `instructions` and `tools` travel as separate request
fields. The model sees both the behavioral prompt and a structured tool catalog. The
request also carries `tool_choice: "auto"` and the model-specific
`parallel_tool_calls` flag.

For Cursor and non-OpenAI backends, merely forwarding the raw Codex tool schema is not
enough. Some models need a compatibility shim that says, in plain language:

- use only the tools actually exposed in this turn;
- call exact tool names and exact argument keys;
- do not invent helper tools like `glob` unless the catalog contains one;
- for repo search, use the available grep/search/read surface or shell `rg`;
- for shell, use the provider-facing shell alias if one exists;
- for edits, use the editing/patch tool surface rather than ad hoc shell writes;
- verify with the smallest relevant command before claiming completion.

Cursor should receive the strongest version because it now has a broad tool surface and
its own rule system, worktrees, MCP, worker bridge, and mode controls. Other providers
should receive a compact generic correction unless live evals show drift.

## Evidence ledger

### Codex base instructions are resolved per session

`ModelInfo` contains `base_instructions` and model tool capability metadata:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:260`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:281`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:289`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:293`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:320`

Session startup resolves the base instruction priority:

1. explicit `config.base_instructions`;
2. conversation history `session_meta.base_instructions`;
3. current model instructions.

Source:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:539`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:546`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:550`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:573`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:581`

### Codex also injects dynamic developer/context instructions

`build_initial_context` adds policy/context layers before the user's live task:

- permission instructions;
- configured developer instructions;
- collaboration-mode instructions;
- realtime/context updates;
- personality spec when not already baked into model instructions;
- app/connector instructions;
- available skills instructions;
- available plugin instructions;
- extension-contributed developer/context fragments;
- user instructions;
- environment context with shell and subagent state.

Sources:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2638`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2669`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2693`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2698`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2729`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2743`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2771`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2798`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2815`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2825`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2863`

Interpretation: the "default prompt" is not a single static string. It is a composed
instruction stack: model/base instructions plus turn/session context.

### Codex sends the tool catalog with the request

`build_prompt` attaches the router's model-visible tool specs and the model's parallel
tool-call capability:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/turn.rs:897`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/turn.rs:903`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/turn.rs:905`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/turn.rs:906`

`client.rs` converts those specs to Responses JSON and creates the actual request:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:742`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:745`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:770`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:772`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:774`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:775`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:776`

This proves the key request shape:

```text
instructions = prompt.base_instructions.text
input        = formatted conversation/context
tools        = create_tools_json_for_responses_api(prompt.tools)
tool_choice  = "auto"
parallel_tool_calls = prompt.parallel_tool_calls
```

### Codex native tool surface is structured and feature-gated

The model-visible tool spec enum includes:

- `function`
- `namespace`
- `tool_search`
- `image_generation`
- `web_search`
- `custom` / freeform

Sources:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:17`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:22`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:28`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:36`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:49`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:53`

`spec_plan.rs` builds the visible specs and registry from planned runtimes, hosted specs,
MCP, dynamic tools, extension tools, feature flags, provider capabilities, and model
metadata:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:147`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:155`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:178`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:185`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:195`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:203`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:217`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:218`

Notable native surfaces:

- shell: `exec_command` + `write_stdin`, or legacy `shell_command`;
- edit: freeform `apply_patch`;
- planning/input: `update_plan`, `request_user_input`, optional permission/goal/plugin tools;
- image: `view_image`, hosted `image_generation`;
- web: hosted `web_search`;
- discovery: `tool_search`;
- MCP: dynamic namespace tools plus MCP resource helpers;
- collaboration: multi-agent spawn/message/wait/close/list surfaces.

Relevant source anchors:

- shell registration: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:546`
- utility/apply_patch/view_image registration: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:593`
- collaboration tools: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:649`
- MCP runtime tools: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:746`
- dynamic tools: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:772`
- tool search: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:796`

### Codex has runtime-level parallel policy

Codex does not leave all parallelism to the model. `ToolCallRuntime` stores an
`RwLock`; parallel-capable handlers take a read lock, non-parallel handlers take a write
lock.

Sources:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:31`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:36`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:88`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:115`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:118`

Implication for prompting: the prompt can recommend parallel independent reads, but the
runtime still needs hard guarantees for unsafe tools. Cursor/other adapters should not
assume the model will self-serialize mutating work correctly.

### `apply_patch` is a grammar-shaped custom tool

Codex exposes `apply_patch` as a freeform custom tool with Lark grammar, not as ordinary
JSON function calling:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:7`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:18`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20`

The handler accepts `ToolPayload::Custom`, parses and verifies the patch, then routes
through sandbox/approval/runtime orchestration:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:300`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:324`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:329`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:351`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:389`

It also intercepts shell-shaped `apply_patch` commands and sends them through the same
verified patch path:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:492`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:504`
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:222`

Implication for non-OpenAI models: if the model was not trained or tuned on this exact
freeform patch contract, the adapter should include a short explicit instruction and/or
fall back to provider-native edit tools only after an eval proves better behavior.

## Cursor evidence and interpretation

Local Cursor Agent is currently:

```text
cursor-agent --version => 2026.06.26-7079533
```

The installed CLI help exposes:

- `--print` with write and shell access;
- `--output-format text|json|stream-json`;
- `--mode plan` and `--mode ask` as read-only modes;
- `--force` / `--yolo`;
- `--auto-review`;
- `--sandbox enabled|disabled`;
- `--approve-mcps`;
- `--workspace`;
- `--plugin-dir`;
- `--worktree`;
- `mcp list`, `mcp list-tools`, `mcp enable`, `mcp disable`;
- `generate-rule|rule`;
- private worker mode.

Local reference:

- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:102`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:106`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:108`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:109`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:110`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:112`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:113`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:114`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:115`

Cursor runtime/tool modules already include shell/read/grep/MCP/web-search/task UI and
approval/lazy MCP scope machinery:

- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:232`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:234`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:235`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:236`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:237`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:238`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:239`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:242`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:243`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:244`
- `/Users/jun/Developer/codex/003_tool-runtime/03_cr_tool.md:245`

Cursor official docs were checked for:

- CLI usage and worktrees: `https://cursor.com/docs/cli/using`
- rules and AGENTS.md: `https://cursor.com/docs/rules`

Observed official-doc points:

- CLI supports rules integration and the same Agent modes as the editor.
- CLI worktrees run the agent in a new Git worktree under `~/.cursor/worktrees/...`.
- Project rules are stored under `.cursor/rules`.
- `AGENTS.md` can be used as plain markdown agent instructions and supports nested
  directory-specific instructions.

Interpretation: Cursor already has the raw ingredients. The missing piece is a strong
tool-use rule pack that bridges Codex's Responses tool contract to Cursor's model and
tool runtime.

## GPT vs non-OpenAI model statement

### What is proven

Proven from source:

- Codex sends OpenAI-style `instructions`, structured `tools`, `tool_choice`, and
  `parallel_tool_calls`.
- Codex tool names and shapes include OpenAI/Codex-specific surfaces such as
  `exec_command`, `write_stdin`, `tool_search`, hosted `web_search`,
  hosted `image_generation`, and freeform `apply_patch`.
- Cursor has its own upstream tool/runtime/rules surfaces and can run non-OpenAI models.

### What is a working hypothesis

This statement should be treated as a working hypothesis, not a source-proven fact:

> GPT-family models are better calibrated to the OpenAI Responses/Codex tool contract
> because their product training/RL likely covered those exact tool surfaces. Non-OpenAI
> models may have different RL and may reach for generic coding-agent tools or commands.

Reasonable operational basis:

- GPT models are the primary native target for OpenAI Responses tool semantics.
- Cursor routes many model families through a product-specific agent runtime.
- Live Cursor investigations already showed model/tool-name sensitivity around
  `exec_command` and the `run_shell` alias strategy:
  `/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260702_cursor-toolcall-mcp-empty-rca/01_live-codex-exec-stall-alias-spec.md`
- Non-native model families often need exact-name and schema hints in adapters, even
  when the structured tool schema is technically present.

Required caution:

- Do not write "RL proves X" in product docs without eval data.
- In implementation comments, call this "tool contract calibration" or "provider/model
  compatibility prompting", not "RL mismatch" unless backed by a benchmark.

## Prompting policy

### Layer 0 — Preserve upstream platform prompts

Do not try to replace Codex or Cursor's platform prompt. Treat upstream prompts/rules as
the foundation:

- Codex model/base instructions and tool specs;
- Codex developer/context sections;
- Cursor project rules, user/team rules, `.cursor/rules`, `AGENTS.md`;
- provider-specific safety and approval text.

Our adapter prompt should be a narrow compatibility shim layered after those, not a new
agent constitution.

### Layer 1 — Universal tool contract shim

Add this class of instruction for providers/models that need correction:

```md
Use only the tools listed for this turn. Tool names and argument keys must match exactly.
Do not invent tools such as glob, read_file, list_dir, grep_files, or apply_patch unless
they are explicitly present in the tool catalog.

For repository discovery, prefer the available read/grep/search tools. If shell is the
available route, use `rg`/`rg --files` with a bounded working directory and bounded output.
For independent read-only inspection, batch or parallelize when the runtime supports it.
For mutating edits, use the available edit/patch tool surface; avoid shell redirection or
ad hoc file writes when a patch/edit tool exists.
Before finalizing, run the smallest relevant verification command and report the result.
```

This should be short enough to survive context pressure but explicit enough to stop
invented `glob`-style calls.

### Layer 2 — Cursor strong correction pack

Cursor should receive the strongest variant:

```md
Cursor tool-use compatibility:

- Use only the current Cursor-facing tools. Do not call non-existent helper tools.
- File discovery: use Cursor grep/read tools when available; otherwise shell `rg` or
  `rg --files`. Do not invent `glob`.
- Shell: when the adapter exposes `run_shell`, use `run_shell` with `{ "cmd": "...",
  "workdir": "..." }`. If the Responses-side name is `exec_command`, the adapter maps
  it; the Cursor-facing model should still use the Cursor-facing shell name.
- Edits: prefer the available edit/patch tool. Do not use `cat > file`, heredocs, or
  broad shell rewrites when a structured edit path exists.
- MCP: use MCP tools only when they are listed or approved. If MCP is empty, continue
  with native grep/read/shell rather than waiting for invisible MCP tools.
- Read-only analysis: use plan/ask mode semantics; inspect first, then mutate.
- Parallelism: batch independent read-only searches/reads; serialize writes and tool
  result continuations.
- Verification: after edits, run the targeted test/typecheck/build command before
  completion.
```

Why strong Cursor correction is justified:

- Cursor CLI now has worktrees, MCP, plugins, worker bridge, rules, and auto-review.
- The raw surface is broad enough that model priors can choose the wrong path.
- Live Cursor work already found `exec_command` name/schema sensitivity; aliasing and
  prompt hints are cheap compared with protocol-level retries.

### Layer 3 — Provider/model presets

Proposed routing:

| Provider/model class | Prompt strength | Notes |
| --- | --- | --- |
| OpenAI GPT on native Responses | Light | Native tool schema + Codex base prompt should carry most behavior. Add only repo-specific rules. |
| Cursor Composer/GPT-backed | Medium | Add exact tool-name and `rg`/patch discipline. |
| Cursor Claude/Gemini/Grok/Kimi | Strong | Add Cursor strong correction pack, shell alias note, and no-invented-tools rule. |
| Anthropic direct | Medium/Strong | Exact tool names, no invented tools, edit/patch discipline, shell command shape examples. |
| Gemini CLI style | Medium | Make parallel vs serial intent explicit; respect any provider `wait_for_previous` semantics if present. |
| OpenCode | Medium | Preserve provider tool definitions; add bounded output/truncation and edit choice guidance. |
| Aider | Different axis | It is edit-loop oriented, not structured tool-runtime oriented. Reinforce lint/test loop and command discipline rather than tool catalog rules. |

## Recommended implementation direction

### 1. Add a provider/model tool-calibration prompt builder

Create a small adapter-side builder rather than hardcoding text in many places.

Inputs:

- provider id;
- model id/family;
- exposed tool names;
- whether shell is present;
- whether edit/patch tool is present;
- whether MCP tools are present;
- whether provider-facing aliases are active.

Output:

- no prompt for fully native/known-good cases;
- compact universal shim for medium-risk cases;
- Cursor strong correction pack for Cursor non-native model families.

### 2. Keep the prompt evidence-driven

The builder should not say a tool exists unless it is in the catalog. If the catalog has
no `glob`, say "do not invent `glob`"; if the catalog has a real glob tool in some future
provider, do not forbid it.

### 3. Alias only at provider boundary

If Cursor performs better with `run_shell`, keep the alias Cursor-facing and map back to
Responses/Codex names on the return path. Do not change the upstream Codex contract
unless there is a separate migration.

Related active plan:

- `/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260702_cursor-toolcall-mcp-empty-rca/01_live-codex-exec-stall-alias-spec.md`

### 4. Evaluate before broad rollout

Use a small model/provider eval matrix:

1. Shell command: "Run `echo OCX_TOOL_OK` and report stdout."
2. File discovery: "Find where Cursor tool definitions are built."
3. Read batching: "Inspect three files and summarize the call path."
4. Edit: "Make a one-line text/doc change using the structured edit path."
5. MCP empty: "Continue usefully when no MCP tools are listed."
6. Parallel read-only: "Run independent repository searches without serial dithering."
7. Tool continuation: "Emit a function call, accept tool output, then continue."

Metrics:

- no-tool-call rate;
- invented-tool-name rate;
- wrong-argument-schema rate;
- shell fallback when structured tool exists;
- mutating shell-write rate;
- completion-without-verification rate;
- timeout/heartbeat-only rate.

### 5. Keep final user-visible rules concise

The detailed doctrine belongs here. The runtime prompt should be short. Too much prompt
turns into noise and can weaken the exact tool examples.

## Draft prompt blocks

### Universal compact block

```md
Tool discipline:
Use only this turn's listed tools with exact names and argument keys. Do not invent
helpers such as `glob`, `read_file`, or `list_dir` unless they are listed. For repo
search use available grep/read/search tools, or shell `rg`/`rg --files` with bounded
output. Use structured edit/patch tools for file changes. Batch independent read-only
inspection; serialize writes. Verify with the smallest relevant command before final.
```

### Cursor strong block

```md
Cursor tool discipline:
Use the Cursor-facing tool names exactly. If shell is exposed as `run_shell`, call
`run_shell` with `cmd` and optional `workdir`; the adapter maps it back upstream. Do not
call `glob` or other helper tools unless present. For search, use Cursor grep/read or
shell `rg`; for edits, use the edit/patch path instead of shell rewrites. If MCP is empty
or unapproved, proceed with native tools. Batch read-only inspections, serialize writes
and continuations, and run focused verification before final.
```

### Cursor shell alias hint for command-like active user turns

Use only when:

- `exec_command` is present upstream;
- Cursor-facing shell alias is active;
- active user text is command-like;
- user text does not already mention the alias.

```md
For this shell-command request, use `run_shell`.
```

This is intentionally tiny. It should be appended near the active turn, not buried in a
large system block.

## Risks

1. Overprompting can fight the provider's native agent behavior.
2. Hardcoded negative examples can become wrong if a future provider actually exposes
   `glob`.
3. Provider-facing aliases can confuse logs unless the return path preserves upstream
   names and metadata.
4. A prompt-only fix cannot repair a broken wire protocol. Keep protocol fixes and prompt
   shims separate.
5. "GPT uses tools better because RL" is useful shorthand in discussion, but should not
   be the formal explanation without eval evidence.

## Acceptance criteria for a future implementation pass

- Provider/model prompt builder is small and table-driven.
- Cursor strong block is emitted only for Cursor routes that need it.
- Prompt text is conditioned on actual exposed tools and aliases.
- Existing OpenAI native behavior is unchanged or receives only the compact block.
- Tests cover prompt inclusion/exclusion and alias hint gating.
- Live eval shows reduced no-tool-call and invented-tool rates for Cursor non-native
  models.
- Devlog/eval record captures before/after traces for at least Cursor Composer,
  Cursor Claude/Sonnet, and one OpenAI-native GPT route.

## Change documentation for this devlog entry

### `00_research.md` — tool-use prompt calibration SOT

- **Changes**: added this source-of-truth research note for Codex-native prompt/tool
  injection, Cursor upstream rule injection, GPT vs non-OpenAI tool-use calibration
  hypothesis, and concrete prompt-block proposals.
- **Impact**: no runtime code impact. Future affected areas are likely Cursor adapter
  prompt construction, provider/model routing, and tests around tool prompt inclusion.
- **Verification**: source anchors were checked with `rg`, `nl -ba`, `cursor-agent
  --help`, `cursor-agent --version`, and Cursor official docs fetches. File existence and
  git diff should be verified after creation.
