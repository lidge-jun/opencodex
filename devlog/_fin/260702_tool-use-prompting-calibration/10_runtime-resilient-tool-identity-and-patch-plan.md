# Runtime-resilient tool identity and patch plan

Date: 2026-07-02
Owner: Boss direction; Codex source + Spark-search comparison pass.
Status: patch implemented; Cursor-specific calibration plus shared non-OpenAI
provider catalog nudge are covered by targeted and full-suite verification.

## Request

The active Cursor prompt patch looks successful from the git tree: the Cursor
adapter now has concrete prompt/tool guidance and tests around `exec_command`,
generic tool-count demos, exact tool names, and Cursor return-path mapping.
That makes several prior hypotheses source-confirmed rather than speculative.

The new concern is the next layer: if we over-constrain the prompt with exact
tool names or provider quirks, a future runtime/tool catalog change can make
the prompt stale. We need a Codex-shaped identity and a compact meta-definition
of tools that stays correct even when the concrete catalog changes.

The user also asked for Spark-search comparison against other coding-agent
products to separate proven claims from intuitions.

## Short answer

The durable phrase is:

```text
Use the current tool catalog as ground truth.
```

For a shorter identity label:

```text
Catalog-grounded executor.
```

For a tool definition:

```text
Tools are typed capabilities.
```

The runtime prompt should avoid pretending the catalog is static. It should
not say "never use `glob`" as an absolute rule. It should say "do not invent
`glob` unless the current catalog exposes it." That one difference is the
thin but important line between helpful calibration and brittle doctrine.

## Source-confirmed local facts

### Cursor prompt/tool hardening exists in source

The current working tree already contains Cursor-specific tool prompt guidance:

- `src/adapters/cursor/tool-definitions.ts:10` adds an `exec_command` system
  note.
- `src/adapters/cursor/tool-definitions.ts:12` adds a generic tool-count demo
  hint that tells the model to satisfy those prompts with repeated harmless
  `exec_command` calls.
- `src/adapters/cursor/tool-definitions.ts:20` narrows the native exec schema
  to `cmd` plus optional `workdir`.
- `src/adapters/cursor/tool-definitions.ts:62` detects generic tool-use/count
  demo prompts, including Korean variants.
- `src/adapters/cursor/tool-definitions.ts:114` filters generic tool-count
  demos down to the native exec surface when the user did not ask for MCP,
  resources, plugins, or GitHub.
- `src/adapters/cursor/tool-definitions.ts:151` builds a Cursor system note
  from the currently advertised tool names and `tool_choice`.
- `src/adapters/cursor/protobuf-request.ts:46` appends Cursor shell/tool
  guidance into root prompt blobs.
- `src/adapters/cursor/protobuf-request.ts:278` appends active-turn hints only
  for user/developer turns.
- `src/adapters/cursor/live-transport.ts:233` advertises only the active
  prompt's visible tools to Cursor.
- `src/adapters/cursor/protobuf-events.ts:28` carries a Cursor wire-name to
  upstream Responses/Codex name map.
- `src/adapters/cursor/protobuf-events.ts:153` accepts Cursor-facing names but
  stores the upstream Responses name for emitted Codex events.

The focused tests confirm the behavior:

- `tests/cursor-blob.test.ts` checks exact-tool guidance, shell hints, and
  generic tool-count demo hints.
- `tests/cursor-tool-definitions.test.ts` checks exec schema narrowing, generic
  prompt detection, active tool filtering, and exact-name system guidance.
- `tests/cursor-protobuf-events.test.ts` checks Cursor tool-name mapping back
  to Responses/Codex events.
- `tests/cursor-tool-arg-decoding.test.ts` checks stateful synthetic native MCP
  exec mapping.

### Cursor live RCA already proved name/schema sensitivity

The live RCA showed that `cursor/composer-2.5` and
`cursor/claude-4.6-sonnet` could stall on the first turn when the shell tool
was exposed as raw Codex `exec_command`, while a Cursor-facing `run_shell`
shape with a compact `{cmd}` schema completed.

Source:

- `devlog/_plan/260702_cursor-toolcall-mcp-empty-rca/01_live-codex-exec-stall-alias-spec.md`

Important nuance: the current local diff uses `exec_command` as the
Cursor-facing name, not the `run_shell` alias described in that earlier RCA.
That means the devlog should record the RCA as proof that name/schema
sensitivity exists, not as proof that the current exact alias choice is final.

## Codex-native source facts

### Codex injects both instructions and tools

`codex-rs` source shows separate instruction and tool planes:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:260`
  has `ModelInfo`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:281`
  carries base instructions.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/protocol/src/openai_models.rs:289`
  and nearby fields carry tool capability metadata.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:539`
  through `:550` resolve base instruction priority.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/mod.rs:2638`
  through `:2863` build the dynamic initial context.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/session/turn.rs:897`
  through `:906` attach tool specs and parallel-tool capability to the prompt.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/client.rs:742`
  through `:779` serialize `instructions`, `input`, `tools`,
  `tool_choice`, and `parallel_tool_calls` into the Responses request.

Therefore the claim "Codex base prompt is injected" is correct, and the
follow-on "tools are injected too" is also correct, with the precision that
tools are not merely prose inside the prompt; they travel as structured model-
visible request data.

### Codex's tool surface is typed and dynamic

The `ToolSpec` enum includes function, namespace, hosted, and custom/freeform
tool shapes:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/tools/src/tool_spec.rs:17`
  through `:65`.

`spec_plan.rs` builds the visible spec list from runtime plans, provider/model
capabilities, feature flags, MCP tools, dynamic tools, extension tools, and
hosted tools:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:147`
  through `:225`.
- Shell registration:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:546`.
- Utility/edit/image registration:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:593`.
- Collaboration tools:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:649`.
- MCP runtime tools:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:746`.
- Dynamic tools:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:772`.
- Tool search:
  `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/spec_plan.rs:796`.

This is why the durable rule must say "current catalog" rather than "the
Codex tool list is X."

### Codex runtime also enforces tool policy

Parallelism is not only a prompt preference. Runtime locking distinguishes
parallel-capable and non-parallel handlers:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:31`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:36`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:88`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:115`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/parallel.rs:118`.

`apply_patch` is a grammar-shaped custom/freeform tool, not a generic JSON
function:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:7`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:18`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20`.

The handler accepts and verifies the custom payload:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:300`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:324`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:351`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:389`.

Shell-shaped `apply_patch` commands can also be intercepted and routed through
the same patch path:

- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:492`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/apply_patch.rs:504`.
- `/Users/jun/Developer/codex/121_openai-codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:222`.

## Official Codex manual facts

Fresh manual fetch:

- Manual path:
  `/var/folders/2r/ysbqgzpd2b7g8ymwz91gnm7w0000gn/T/openai-docs-cache/codex-manual.md`.
- Outline path:
  `/var/folders/2r/ysbqgzpd2b7g8ymwz91gnm7w0000gn/T/openai-docs-cache/codex-manual.outline.md`.
- Fetch result: local manual was updated on 2026-07-02.

The official manual says Codex works in a model/action loop: when a prompt is
submitted, Codex calls the model and performs actions indicated by model output,
including file reads, edits, and tool calls. Source section:

- `codex-manual.md:451` through `:581`.

The official manual says Codex gathers context from files, tool output, and an
ongoing record of its work, and can compact context automatically. Same section:

- `codex-manual.md:451` through `:581`.

The official manual recommends `gpt-5.5` for complex coding, computer use,
knowledge work, research workflows, planning, tool use, and follow-through.
Source section:

- `codex-manual.md:5474` through `:5742`.

The official manual says Codex supports first-party web search, MCP, slash
commands, subagents, approval modes, and feature flags. Source section:

- `codex-manual.md:5474` through `:5742`.

The official manual says Codex reads `AGENTS.md` files before work and builds
an instruction chain from global and project scopes, with deeper files later
in the combined prompt. Source section:

- `codex-manual.md:7577` through `:7708`.

The official manual describes customization layers as AGENTS, memories,
skills, MCP, and subagents. Source section:

- `codex-manual.md:7772` through `:7919`.

The official manual says skills use progressive disclosure: metadata is loaded
for discovery, `SKILL.md` only when chosen, and references/scripts only when
needed. Source section:

- `codex-manual.md:7772` through `:7919`.

The official manual says MCP servers can expose tools, resources, and prompts,
and Codex reads MCP server `instructions` alongside the server tools. Source
section:

- `codex-manual.md:7920` through `:8093`.

The official manual says subagents are explicitly triggered and useful for
parallel read-heavy exploration, tests, triage, and summarization. Source
section:

- `codex-manual.md:10556` through `:10647`.

The official manual says hooks can inject scripts into the agentic loop, with
events including `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`UserPromptSubmit`, `SubagentStart`, and `Stop`. Source section:

- `codex-manual.md:11050` through `:11293`.

## Spark-search comparison ledger

Spark agents were spawned with hardcoded `gpt-5.3-codex-spark` and the
`cxc-search` skill attached.

Lanes:

- Pascal: OpenAI Codex / codex-rs / OpenAI official docs.
- Socrates: Cursor Agent / CLI / rules.
- Ramanujan: Anthropic Claude Code.
- Nash: Google Gemini CLI / Gemini Code Assist.
- Bacon: OpenCode, Aider, OSS coding agents.

### Cursor

Primary official claims from Spark lane:

- Cursor rules are layered: team, project, user, `.mdc`, `AGENTS.md`, nested
  `AGENTS.md`, and remote imports. Source:
  `https://cursor.com/docs/rules.md`.
- Cursor describes agent behavior as the composition of system/rules prompt,
  toolset, and model. Source: `https://cursor.com/docs/agent/overview.md`.
- Cursor CLI shares agent modes and rule loading with the editor and exposes
  MCP plus slash-command controls. Sources:
  `https://cursor.com/docs/cli/overview.md`,
  `https://cursor.com/docs/cli/using.md`,
  `https://cursor.com/docs/cli/reference/slash-commands.md`.
- Cursor MCP supports multiple transports and exposes tool/resource/prompt
  classes with approvals/capability scoping. Source:
  `https://cursor.com/docs/mcp.md`.
- Cursor has foreground/background/cloud subagent concepts. Source:
  `https://cursor.com/docs/subagents.md`.

Local official-doc fetches also found:

- `https://cursor.com/docs/cli/using` describes Agent CLI prompting, MCP
  support, rule integration, worktrees, command approval, and non-interactive
  mode.
- `https://cursor.com/docs/rules` describes `.cursor/rules`, `AGENTS.md`, root
  and nested `AGENTS.md`, user rules, and rule import.
- `https://cursor.com/docs/agent/tools/terminal` says Cursor runs shell
  commands directly in the user's terminal and that run mode controls command
  execution and sandboxing.

Interpretation:

Cursor is not "raw model + our adapter." It has a substantial upstream rule and
tool identity of its own. Our prompt shim should align the Cursor-facing model
to the current bridge contract without erasing Cursor's own rule stack.

### Cursor still needs reinforcement despite tool-count success

Attachment evidence:

- `/Users/jun/.codex/attachments/4c992852-bbee-403c-a20c-4cb8fbb400e8/pasted-text.txt`.

Observed trace:

- User asked Cursor/composer: `tool use 10개해봐`.
- Cursor did use `exec_command` successfully, but split the task into two
  phases: first 3 commands, then "나머지 7개는 MCP exec_command로 이어서
  실행합니다."
- The UI summarized the second phase as "Listed files, ran 6 commands"; the
  final response still claimed 10 total `exec_command` calls.
- Cursor then offered to do the same with "Grep, Read, Glob" even though the
  prompt was a Codex-native `exec_command` demo and those names are neighboring
  agent-product vocabulary unless this turn's catalog lists them.
- In the native Codex comparison inside the same attachment, the agent handled
  the same request by selecting 10 harmless read-only `exec_command` calls and
  batching the independent calls in one parallel turn.

Interpretation:

This is a partial success, not a failure. Cursor no longer stalls and it can
complete the tool-count task. But it still shows awkwardness around Codex-style
tool use:

- it mislabeled a native exec path as `MCP exec_command`;
- it did not naturally choose the most Codex-shaped batch/parallel strategy for
  independent read-only calls;
- it leaked neighboring tool names such as `Grep`, `Read`, and `Glob` into the
  follow-up suggestion;
- it required post-hoc result accounting rather than starting from an exact
  "N tool results" discipline.

Therefore Cursor should stay in the strong-correction lane. The next patch
should reinforce exact native-tool labeling, exact result counting, and
catalog-bounded follow-up suggestions without hardcoding a permanently static
tool list.

### Gemini CLI / Gemini Code Assist

Primary official claims from Spark lane:

- Gemini CLI is documented as an open-source AI agent with a ReAct loop, built-
  in tools, and local/remote MCP servers. Source:
  `https://developers.google.com/gemini-code-assist/docs/gemini-cli`.
- The Gemini CLI tool reference exposes command-style interaction and active
  tool discovery via `/tools`; file and shell affordances include `@` and `!`.
  Source: `https://geminicli.com/docs/reference/tools/`.
- Official Gemini CLI tools include `glob`, `grep_search`, `read_file`,
  `read_many_files`, `replace`, and `write_file`. Source:
  `https://geminicli.com/docs/reference/tools/`.
- MCP configuration can append server instructions into prompt behavior.
  Source: `https://geminicli.com/docs/tools/mcp-server/`.
- Gemini behavior can be controlled via `GEMINI_SYSTEM_MD`, hierarchical
  `GEMINI.md`, permissions, `coreTools`, and `excludeTools`. Sources:
  `https://geminicli.com/docs/cli/system-prompt/`,
  `https://geminicli.com/docs/cli/gemini-md/`, and Google Code Assist agentic
  chat docs.

Interpretation:

The "Gemini tries `glob`" risk is not just a vague model personality claim.
Gemini's own official CLI product exposes a `glob` tool and related file-tool
names. If that model family or user context has been shaped by Gemini CLI, a
Codex bridge prompt should clearly say that only the current Codex-facing
catalog is valid.

### Claude Code

Primary official claims from Spark lane:

- Claude Code permission settings use `allow`, `ask`, and `deny` arrays; tool
  rules are shaped as `Tool` or `Tool(specifier)`, and MCP rules use
  `mcp__server__tool` naming. Source:
  `https://code.claude.com/docs/en/settings`.
- Claude Code hooks include `PreToolUse`, `PermissionRequest`, and
  `PermissionDenied`, with permission and mutation behavior before execution.
  Source: `https://code.claude.com/docs/en/hooks`.
- Claude Code custom commands/skills can carry `allowed-tools`,
  `disallowed-tools`, `model`, `effort`, and `hooks` frontmatter. Source:
  `https://code.claude.com/docs/en/slash-commands`.
- Claude Code MCP supports connect/add flows, push/list-changed style updates,
  scoped auth, and per-server tool timeout settings. Source:
  `https://code.claude.com/docs/en/mcp`.
- Claude Code exposes runtime model control and permission modes. Sources:
  `https://code.claude.com/docs/en/permission-modes` and settings docs.

Interpretation:

Claude Code has a strong permission/hook/skill-frontmatter worldview. When a
Claude-family model is hosted through Cursor or another bridge, it may be
comfortable with tool rules, but the names and schemas still need explicit
catalog grounding because the native Claude Code tool contract is not the same
as Codex's current Responses/Codex catalog.

### OpenCode and Aider

Primary official claims from Spark lane:

- OpenCode ships concrete built-in tools including `edit`, `write`, `read`,
  `bash`, `grep`, `glob`, and `apply_patch`. Source:
  `https://opencode.ai/docs/tools/`.
- OpenCode has prompt/rule hierarchy through `AGENTS.md`, `CLAUDE.md`,
  global/custom instruction files, and `opencode.json`. Source:
  `https://opencode.ai/docs/rules/`.
- Aider adds files to chat and uses in-chat commands such as `/run`, `/test`,
  and `/web`. Source: `https://aider.chat/docs/usage.html`.
- Aider uses a repository map to target relevant files rather than the same
  explicit file-tool catalog style. Source:
  `https://aider.chat/docs/repomap.html`.

Local fetch of the OpenCode tools page also confirmed:

- The page description is "Manage the tools an LLM can use."
- The tools page includes web search/retrieval tools, custom tools, MCP
  servers, and an internals note that `grep` and `glob` use ripgrep under the
  hood.
- The page footer showed last updated `2026-07-01T21:54:22.000Z`.

Interpretation:

OpenCode is the strongest proof that `glob` and `grep` are real product-level
tool names elsewhere. Therefore a Codex bridge should not assume that non-
OpenAI models hallucinate those names randomly; they may be transferring valid
tool habits from neighboring agent products into a Codex tool catalog where
those names may not exist.

### OpenAI Codex official docs

Primary official/manual facts from the main session:

- Codex works by calling the model and performing actions from model output:
  file reads, edits, and tool calls.
- Codex recommends `gpt-5.5` for stronger planning, tool use, and follow-
  through in complex coding/research workflows.
- Codex has AGENTS, skills, MCP, subagents, hooks, approval modes, first-party
  web search, image generation, and slash commands.
- Codex's official customization model is layered: AGENTS for repo guidance,
  skills for reusable workflows, MCP for external capabilities, subagents for
  delegation, hooks for lifecycle scripting.

Interpretation:

OpenAI can legitimately rely more on the native Codex/Responses contract for
OpenAI models than third-party bridge adapters can for non-native models. But
the formal implementation explanation should be "provider/model compatibility
prompting against the current tool contract," not an unverifiable statement
that "RL proves GPT tools better."

Additional official-source facts to carry into wording:

- OpenAI's GPT-5-Codex system-card addendum says GPT-5-Codex is optimized for
  agentic coding in Codex and was trained with reinforcement learning on real-
  world coding tasks. Source:
  `https://openai.com/index/gpt-5-system-card-addendum-gpt-5-codex/`.
- The API model page describes GPT-5-Codex as optimized for agentic coding
  tasks in Codex or similar environments and as Responses API-only. Source:
  `https://developers.openai.com/api/docs/models/gpt-5-codex`.
- The Codex config schema exposes `model_catalog_json` and
  `model_instructions_file`, and warns that overriding built-in model
  instructions will likely degrade performance. Source:
  `https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json`.
- OpenAI's API docs list first-party tool documentation for local shell and
  apply patch. Sources:
  `https://developers.openai.com/api/docs/guides/tools-local-shell` and
  `https://developers.openai.com/api/docs/guides/tools-apply-patch`.

Wording consequence:

It is now fair to state the limited official fact: GPT-5-Codex specifically was
trained with RL for agentic coding in Codex-like environments. It is still not
fair to generalize that into "all GPT models always use every current tool
correctly" or "RL alone proves correct bridge behavior." The implementation
claim should remain catalog-grounded and eval-backed.

## Proven vs hypothesis

### Proven

- Codex injects base instructions and dynamic context.
- Codex sends a structured tool catalog separately from instructions.
- Codex tool specs are typed, feature-gated, and runtime-built.
- Cursor has upstream rules, tool/mode surfaces, MCP, CLI, and agent
  infrastructure.
- Cursor local adapter now includes strong prompt/tool guidance and tests.
- Cursor live RCA proved that tool naming/schema can alter first-turn
  completion versus heartbeat-only stalls.
- The attached Cursor tool-count trace proves a useful middle state: Cursor can
  complete 10 native exec calls after the prompt patch, but still shows Codex-
  tool awkwardness through split batching, native exec mislabeling as MCP, and
  neighboring tool-vocabulary leakage.
- Gemini CLI and OpenCode officially expose `glob` and related file tools.
- Claude Code officially exposes permission, hooks, skills/commands, MCP, and
  `mcp__server__tool` conventions.
- Official Codex docs recommend GPT-5.5 for complex tool-use-heavy work.
- Official OpenAI material says GPT-5-Codex is optimized for agentic coding in
  Codex and was trained with RL on real-world coding tasks.

### Strong working hypotheses

- GPT-family Codex models are better calibrated to OpenAI Responses/Codex tool
  semantics than non-OpenAI models in bridged environments.
- Non-OpenAI models may import habits from their native agent products:
  Gemini/OpenCode-style `glob`, Claude-style `Bash`/`Read`/permission rules,
  Aider-style command loops, or Cursor's own shell/tool model.
- Prompt shims reduce invented-tool and wrong-schema rates when they are short,
  catalog-derived, and active-turn-aware.

### Claims to avoid wording as fact

- "OpenAI RL proves GPT uses our tools correctly."
- "GPT-5-Codex's RL training proves every OpenAI model or bridge route will use
  this exact runtime catalog correctly."
- "Other models are bad at tools."
- "Never use `glob`."
- "Cursor's tool name is always `run_shell`" or "always `exec_command`."

Better wording:

- "OpenAI-native models are the primary target for the Codex/Responses tool
  contract."
- "GPT-5-Codex has official RL/agentic-coding grounding for Codex-like work,
  but runtime correctness still depends on the current tool catalog and evals."
- "Other agent products expose different tool vocabularies, so bridged models
  need current-catalog grounding."
- "Do not call `glob` unless this turn's catalog exposes `glob`."
- "Use the provider-facing name currently advertised by the adapter."

## Codex identity framing

The prompt should not anthropomorphize or overfit "Codex self" into personality
copy. The useful identity is operational:

```text
I am Codex in this runtime: a catalog-grounded executor.
The current tool catalog is my capability boundary.
Tool names and schemas are runtime facts, not guesses.
```

This is more robust than a long list of do/don't examples because it tells the
model how to interpret any future catalog.

Recommended micro-glossary:

- `tool catalog`: the current turn's model-visible tools.
- `capability boundary`: if it is not in the catalog, the model cannot call it.
- `typed capability`: a callable operation with exact name and input shape.
- `provider-facing name`: the name the current adapter advertised to the model.
- `upstream name`: the Responses/Codex name emitted back to the core runtime.

Possible short labels:

1. `Catalog-grounded executor` - best identity label.
2. `Tool-contract first` - best rule label.
3. `Typed capabilities` - best tool definition.
4. `Current catalog wins` - best mnemonic.

## Runtime-resilient prompt strategy

### Principle 1: Derive, do not hardcode

Generate prompt examples from the actual current tool catalog:

- list only currently available tool names;
- mention shell only if a shell tool is present;
- mention edit/patch only if an edit/patch tool is present;
- mention MCP only if MCP tools or MCP discovery surfaces are present;
- mention hosted web/image only if those tools are present;
- mention aliases only if the adapter actually activated them.

### Principle 2: Negative examples must be conditional

Bad:

```text
Do not use glob.
```

Good:

```text
Do not call tools like `glob`, `Read`, `Bash`, or `LS` unless this turn's tool
catalog lists those exact names.
```

Even better when generated:

```text
This turn's valid tool names are exactly: ...
Other names are unavailable, even if another agent product uses them.
```

### Principle 3: Keep provider correction small

The universal block should be short enough to remain stable:

```text
Tool contract: use the current tool catalog as ground truth. Tools are typed
capabilities: call only listed names with listed argument keys. Do not invent
neighbor-agent tools. If a task needs search/read/shell/edit behavior, choose
the listed tool that provides that capability. Batch independent read-only
calls when supported; serialize writes. Verify before final.
```

Cursor strong block can be more explicit because Cursor has proven live
name/schema sensitivity and an upstream rule/tool stack:

```text
Cursor bridge: use the Cursor-facing tool names exactly as advertised for this
turn. The adapter may map them back to upstream Codex names after execution.
Do not use neighboring-agent names such as `glob`, `Read`, `Bash`, or `LS`
unless they are listed. For command-like requests, use the listed shell tool.
For generic tool-count demos, use harmless repeated calls to the listed native
exec tool when present. Do not count a tool call until a result returns.
```

### Principle 4: Separate identity prompt from task policy

Identity:

```text
Current catalog wins.
```

Task policy:

```text
For repo search, use available grep/read/search tools or shell `rg`.
```

Provider bridge:

```text
Cursor-facing name X maps back to upstream name Y.
```

These should be separate fragments. That lets future patches change the Cursor
alias without rewriting the universal Codex identity.

## Patch plan

### Phase 1 - Extract prompt fragment builder

Target files:

- `src/adapters/cursor/tool-definitions.ts`
- Possibly a new shared module such as
  `src/adapters/tool-calibration-prompt.ts` if the same logic is reused beyond
  Cursor.

Goal:

- Replace large static negative examples with catalog-derived fragments.
- Keep Cursor-specific active-turn hints local to Cursor.
- Make the builder explicit about inputs and outputs.

Candidate API:

```ts
interface ToolCalibrationInput {
  provider: string;
  modelId: string;
  tools: readonly Pick<OcxTool, "namespace" | "name" | "description" | "parameters">[];
  toolChoice?: OcxRequestOptions["toolChoice"];
  activeText?: string;
  aliases?: ReadonlyMap<string, string>;
  mode: "native" | "bridge-light" | "bridge-strong";
}

interface ToolCalibrationPrompt {
  systemNotes: string[];
  activeTurnSuffix?: string;
  visibleTools?: readonly OcxTool[];
}
```

### Phase 2 - Define capability tags from the catalog

Do not infer from model memory. Infer from tool names, namespaces, and known
adapter metadata:

- shell: `exec_command`, `write_stdin`, `shell_command`, provider alias;
- edit: `apply_patch`, `Edit`, `Write`, provider edit tool;
- discovery: `tool_search`, MCP resource/template readers;
- web: `web_search`, `web.run` style hosted tools;
- image: `image_generation`, `view_image`;
- MCP: names starting with `mcp__` or MCP resource helpers.

Use those tags to condition prompt lines:

- mention `rg` only when shell is available and no native file search tool is
  advertised;
- mention structured patch only when an edit/patch tool is available;
- mention MCP only when visible MCP tools or explicit MCP discovery surfaces
  are in the catalog.

### Phase 3 - Cursor strong correction stays but becomes runtime-aware

Keep the current successes:

- exact tool names from the active visible catalog;
- active-turn shell hint;
- generic tool-count demo hint;
- filtering generic demos to native exec when safe;
- return-path name map.

Adjust the brittle wording:

- change absolute "Codex does not expose Claude-style ..." to "This turn does
  not expose ..." unless the generated catalog truly lacks those names;
- keep examples as neighboring-agent examples, not as universal impossibilities;
- if a future catalog really includes `glob`, do not forbid `glob`.

Add Cursor-specific reinforcement for generic tool-count demos:

- when the user asks for N tool calls and the current catalog exposes a native
  exec/shell capability, prefer N harmless read-only/output-only calls;
- if the runtime supports parallel tool calls, batch independent read-only
  calls in one turn instead of drifting into multi-phase accounting;
- count only completed tool results, not planned calls;
- do not call the native exec path "MCP" unless the visible tool is actually an
  MCP tool;
- do not suggest `Grep`, `Read`, `Glob`, `Bash`, or similar neighbor-agent tool
  names unless the current catalog lists those exact names;
- for follow-up suggestions, speak in capability terms first: "search/read/shell
  tools currently listed" rather than product-specific names.

### Phase 4 - Add provider/model prompt presets

Suggested presets:

| Route | Prompt strength | Reason |
| --- | --- | --- |
| OpenAI native Responses/Codex | Light | Native target for Codex tool contract; avoid noise. |
| Cursor + OpenAI model | Medium | Cursor upstream stack still needs bridge grounding. |
| Cursor + Claude/Gemini/Grok/Kimi | Strong | Neighbor-agent vocab transfer risk; proven Cursor name/schema sensitivity. |
| Anthropic direct | Medium/Strong | Exact names and permissions are familiar, but Codex names differ. |
| Gemini direct/bridge | Medium/Strong | Official Gemini CLI exposes `glob`, `read_file`, `write_file`. |
| OpenCode bridge | Medium | Official OpenCode exposes `bash`, `read`, `grep`, `glob`, `apply_patch`. |
| Aider-like flow | Different | Emphasize repo map/add-file/test loop rather than function-call catalog. |

Non-OpenAI / non-ChatGPT provider rollout plan:

- Anthropic / Claude-family routes: add a medium-strength catalog note that
  maps Claude Code habits (`Read`, `Bash`, permission wording, `mcp__...`
  names) onto the current opencodex catalog. Do not suppress those terms
  globally; only say they are unavailable when the current wire names do not
  list them.
- Gemini / Antigravity / Google routes: add a stronger negative-transfer note
  for `glob`, `grep_search`, `read_file`, `write_file`, and ReAct-style shell
  habits. The prompt should say "choose the listed shell/search/read capability"
  rather than "use Gemini's native tool names."
- Kiro-style routes: keep the correction lighter and schema-focused first:
  exact function names, exact argument keys, complete tool-result accounting,
  and no fallback to imagined file tools. Escalate strength only if eval shows
  invented-tool or wrong-schema rates.
- OpenCode-compatible routes: explicitly guard against `bash`, `read`, `grep`,
  `glob`, and `apply_patch` transfer unless those exact names are advertised.
  If opencodex exposes `exec_command` and structured `apply_patch` instead,
  teach that mapping as capabilities, not as permanent aliases.
- Aider-like routes: do not force a function-call catalog worldview too hard.
  Emphasize repo-map/add-file/test-loop habits only as task strategy, while
  still requiring the model to call only current catalog tools for actual
  actions.

Implementation order for these providers:

1. Extract the catalog-grounding fragment from Cursor into a shared helper with
   provider strength presets.
2. Add provider-specific neighbor vocabulary lists, all conditional on absence
   from the current wire-name catalog.
3. Add one eval per provider family: tool-count, repo search, edit/patch,
   negative-transfer name, and tool-result continuation.
4. Keep Cursor strong as the first shipped preset, then add Anthropic/Gemini
   next because their native agent vocabularies are the clearest mismatch.
5. Add Kiro/OpenCode/Aider-style presets only after their current adapters have
   a stable catalog shape in this repo, so prompt text does not outrun runtime
   behavior.

### Phase 5 - Eval matrix

Run before and after:

1. Tool count: "Use any 10 tools."
2. Korean tool count: "아무 tool 10개 써봐."
3. Shell: "Run `echo OCX_TOOL_OK` and report stdout."
4. Repo discovery: "Find where Cursor tool definitions are built."
5. Parallel reads: "Inspect these three files and summarize the call path."
6. Edit: "Make a one-line docs change using the structured edit path."
7. MCP empty: "Continue usefully when no MCP tools are listed."
8. Tool continuation: tool call, tool result, final response.
9. Negative transfer: ask a Gemini/OpenCode-flavored model to "glob for files"
   when no `glob` exists and confirm it chooses the available search/shell path.
10. Cursor exact-count demo: ask `tool use 10개해봐` and verify 10 completed
    native exec results, no MCP mislabel, and no unlisted `Grep`/`Read`/`Glob`
    suggestion.
11. Future compatibility: inject a fake catalog that does include `glob` and
    confirm the prompt no longer forbids it.

Metrics:

- no-tool-call rate;
- invented-tool-name rate;
- neighbor-tool-vocabulary leakage rate;
- wrong-argument-schema rate;
- wrong provider-facing name rate;
- native-tool mislabeling rate, especially native exec described as MCP;
- completion-before-result rate;
- split-batch rate for independent read-only tool-count demos;
- exact requested-vs-completed tool-result count;
- shell fallback when structured edit/search exists;
- mutating shell-write rate;
- verification omission rate;
- heartbeat/stall rate in live Cursor routes.

### Phase 6 - Tests

Focused tests:

- builder lists only `tool_choice`-allowed names;
- builder omits empty notes when no tools are present;
- neighboring-agent examples are conditional on absence from the catalog;
- if `glob` is present, the prompt does not forbid `glob`;
- Cursor generic tool-count prompt filters to exec only when no MCP/resource
  intent exists;
- Cursor generic tool-count prompt tells the model not to describe native exec
  as MCP and not to suggest unlisted neighbor-agent tools;
- Cursor active-turn shell hint is idempotent;
- return-path map preserves upstream names in emitted events.

Suggested commands:

```bash
bun test tests/cursor-blob.test.ts tests/cursor-tool-definitions.test.ts tests/cursor-protobuf-events.test.ts tests/cursor-tool-arg-decoding.test.ts
bun test
```

## Open questions

1. Should Cursor-facing shell be `exec_command` or `run_shell` long-term?
   The earlier live RCA favors `run_shell` for some Cursor model routes, while
   the current local diff uses `exec_command`. This needs a fresh live eval
   after the latest patch.
2. Should the prompt builder be Cursor-local first or shared immediately?
   Cursor-local is safer; shared becomes worthwhile once a second provider
   uses the same fragments.
3. Should the universal identity line be injected globally or only for bridge
   providers?
   Recommendation: light universal line for all non-native bridge providers,
   no extra line for OpenAI-native unless eval shows benefit.
4. Should "Codex self" be stated as identity?
   Recommendation: operational identity only: "catalog-grounded executor."
   Avoid personality or brand-heavy prose in runtime prompts.

## Final patch recommendation

Do not make the next patch a bigger pile of static prompt text. Make it a
small prompt compiler:

```text
current catalog -> capability tags -> provider strength -> short prompt notes
```

This keeps the winning Cursor correction while making it resilient to future
tool/runtime changes.

## Implementation pass - 2026-07-02

Implemented the first Cursor-focused slice of this plan without restarting the
server or running external E2E:

- strengthened the generic tool-count hint so Cursor is told that
  `exec_command` is Codex native exec, not MCP;
- added exact count discipline for prompts such as `tool use 10개해봐`;
- strengthened batching guidance for independent read-only/output-only
  `exec_command` calls when the runtime supports parallel tool calls;
- made neighboring-agent tool warnings catalog-aware: `Read`, `Grep`, `Glob`,
  `Bash`, and `LS` are warned only as unavailable exact names for the current
  turn, and an advertised exact name is not forbidden;
- made discovery/resource guidance mention only discovery surfaces actually
  present in the advertised wire names;
- added regression tests for the stronger Cursor prompt, native exec mislabel
  prevention, catalog-grounded neighbor-tool wording, and future `Glob`
  compatibility.

Verification:

```bash
bun test tests/cursor-tool-definitions.test.ts tests/cursor-blob.test.ts tests/cursor-protobuf-events.test.ts tests/cursor-tool-arg-decoding.test.ts
bun x tsc --noEmit --pretty false
git diff --check
bun test ./tests/
```

Result:

- Cursor targeted suite: 51 pass, 0 fail.
- TypeScript: exit 0.
- Diff check: exit 0.
- Full test suite: 1212 pass, 0 fail.

## Implementation pass 2 - non-OpenAI provider nudge

Implemented the shared version of the user's proposed strategy: OpenAI /
ChatGPT native routes keep their existing tool contract, while non-OpenAI
provider routes receive a short catalog-grounding nudge alongside the provider
system instructions whenever tools are present.

Implementation shape:

- added `src/adapters/tool-catalog-nudge.ts` as the shared helper;
- injected the helper into Anthropic/Claude-family and Umans-style Anthropic
  wire requests, using the provider-facing tool names after compatibility
  transforms such as `cx_web_search`;
- injected the helper into Gemini / Vertex / Antigravity system instructions;
- injected the helper into Kiro's system prefix using Kiro-safe tool names;
- skipped Kiro replay/resume requests with `previousResponseId`, because those
  payloads already contain replayed assistant/tool context and adding a fresh
  system nudge there polluted the stream reconstruction path;
- injected the helper into OpenAI-compatible chat providers only when the
  configured base URL is not an OpenAI or ChatGPT host, so Kimi/xAI/OpenCode-
  style routes get the nudge but OpenAI hosts do not;
- left OpenAI Responses / ChatGPT forward and Azure OpenAI passthrough
  untouched.

The common nudge says, in effect:

```text
Use the current tool catalog as ground truth. Call only listed names with
listed argument keys. Do not invent neighboring-agent tool names unless this
turn's catalog lists those exact names. Count tool calls only after results.
```

Targeted verification:

```bash
bun test tests/tool-catalog-nudge.test.ts tests/adapter-usage.test.ts tests/umans-provider.test.ts tests/google-adapter.test.ts tests/kiro-adapter.test.ts tests/openai-chat-model-suffix.test.ts
bun x tsc --noEmit --pretty false
git diff --check
```

Result:

- Targeted suite: 77 pass, 0 fail.
- TypeScript: exit 0.
- Diff check: exit 0.

Full-suite verification after the Kiro resume-path guard:

```bash
bun test ./tests/
```

Result:

- Full test suite: 1220 pass, 0 fail.

## Change documentation

### `10_runtime-resilient-tool-identity-and-patch-plan.md` - runtime-resilient prompt plan

- **Changes**: Added a detailed devlog entry for Cursor prompt success evidence,
  Codex-native prompt/tool injection, official Codex manual facts, Spark-search
  cross-product comparison, attached Cursor tool-count awkwardness evidence,
  runtime-resilient Codex/tool identity, official GPT-5-Codex RL wording
  boundaries, and a phased patch plan.
- **Impact**: No runtime code impact. Future implementation likely touches
  Cursor prompt/tool guidance and may introduce a shared prompt calibration
  builder.
- **Verification**: Verified local Cursor diff with `git diff`, source anchors
  with `nl -ba`/`sed`, Codex official manual via
  `node /Users/jun/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs`,
  external comparison via five Spark-search subagents plus official docs
  fetches, and the attached Cursor/native Codex tool-count transcript at
  `/Users/jun/.codex/attachments/4c992852-bbee-403c-a20c-4cb8fbb400e8/pasted-text.txt`.

### `src/adapters/cursor/tool-definitions.ts` - Cursor tool-use prompt calibration

- **Changes**: Reinforced generic tool-count guidance around native
  `exec_command` counting, batching, MCP mislabel prevention, and
  neighboring-agent vocabulary leakage. Reworked the system guidance to derive
  unavailable neighbor-tool examples and discovery/resource notes from the
  advertised wire-name catalog.
- **Impact**: Cursor bridge prompts become stricter for the observed awkward
  `tool use 10개` flow while staying resilient if future catalogs expose names
  such as `Glob`.
- **Verification**: `bun test ./tests/` passed: 1212 pass, 0 fail.

### `tests/cursor-tool-definitions.test.ts`, `tests/cursor-blob.test.ts` - prompt regressions

- **Changes**: Added/updated assertions for native exec wording, exact count
  discipline, no native-exec-as-MCP language, conditional neighbor-tool
  warnings, and advertised `Glob` compatibility.
- **Impact**: Locks the Cursor prompt behavior that the attached transcript
  showed was still awkward after the first successful patch.
- **Verification**: `bun test tests/cursor-tool-definitions.test.ts tests/cursor-blob.test.ts tests/cursor-protobuf-events.test.ts tests/cursor-tool-arg-decoding.test.ts`
  passed: 51 pass, 0 fail.

### `src/adapters/tool-catalog-nudge.ts` - shared non-OpenAI tool contract nudge

- **Changes**: Added a shared helper that turns the current provider-facing
  tool names into a compact catalog-grounding system note. It filters by
  `tool_choice`, conditionally warns about neighboring-agent names, and skips
  OpenAI/ChatGPT hosts where applicable.
- **Impact**: Non-OpenAI provider adapters can share the same runtime-resilient
  tool discipline instead of each carrying bespoke prompt text.
- **Verification**: `bun test tests/tool-catalog-nudge.test.ts` passed.

### `src/adapters/anthropic.ts`, `src/adapters/google.ts`, `src/adapters/kiro.ts`, `src/adapters/openai-chat.ts` - non-OpenAI provider nudge wiring

- **Changes**: Wired the shared nudge into Anthropic, Google/Gemini/
  Antigravity, Kiro, and non-OpenAI OpenAI-compatible chat routes. OpenAI /
  ChatGPT hosts and Responses passthrough remain excluded. Kiro resume/replay
  requests are also excluded so restored assistant/tool context is not mutated.
- **Impact**: Claude/Gemini/Kiro/Kimi/xAI/OpenCode-style provider routes now
  get a few explicit catalog-grounding sentences in addition to structured
  tool definitions.
- **Verification**: Targeted provider suite passed: 77 pass, 0 fail. Full suite
  passed after the replay guard: 1220 pass, 0 fail.
