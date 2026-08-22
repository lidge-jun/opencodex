# Undeclared tool invocation contract: research trace

Date: 2026-08-16
Status: implementation in review
Issue: https://github.com/lidge-jun/opencodex/issues/1795
Branch base: `lidge-jun/opencodex@65eda6c28a480a15b245af50fd533687f3317956`

## Problem statement

Routed non-OpenAI models can emit a top-level tool call whose name was never declared in the current request-visible tool catalog. OpenCodex intentionally rejects that at the final bridge boundary with an explicit compatibility error instead of allowing an invented client-executable action through.

The remaining bug is upstream of that guard: some routed turns contain enough conflicting instruction/tool metadata for models to infer that a name mentioned inside instructions or a nested helper surface is also a valid top-level tool call.

Two concrete forms are now reproduced:

1. SenseNova emits top-level `exec` in a subagent turn whose request catalog does not declare `exec`.
2. Kimi K3 emits top-level `apply_patch` in Codex Code Mode where patching is available only as the nested `exec -> tools.apply_patch(...)` helper.

The correct fix must reduce those invalid generations without weakening the final fail-closed enforcement boundary.

## Historical trace

### #1544: DeepSeek CodeModeOnly top-level apply_patch

Issue #1544 reported that DeepSeek V4 Flash could emit a top-level `apply_patch` call even though the request-visible top-level tools did not contain `apply_patch`. The supported control path in the same conversation was:

```text
exec -> tools.apply_patch(...) -> {}
```

That established the core distinction: patch capability can exist without top-level `apply_patch` being callable.

Reference: https://github.com/lidge-jun/opencodex/issues/1544

### #1699 / #1700: native Responses leaked undeclared apply_patch

The OpenCode Go native Responses path later reproduced the same semantic mismatch. A top-level `apply_patch` item could reach Codex even though the request-visible catalog contained `exec`, `wait`, and `request_user_input`, not `apply_patch`. Codex displayed `aborted`; the nested Code Mode path still worked.

Those reports strengthened the requirement that the proxy must validate returned tool names against what the caller actually declared rather than trusting model output or prompt guidance.

References:

- https://github.com/lidge-jun/opencodex/issues/1699
- https://github.com/lidge-jun/opencodex/issues/1700

### Fail-closed bridge decision

`structure/04_transports-and-sidecars.md` records the resulting architecture decision:

- retain the request-visible allowed wire-name set;
- validate at the final bridge;
- fail the turn before emitting any undeclared tool item;
- do not rely on model guidance as an enforcement boundary;
- do not automatically translate an undeclared tool into another executable action.

The reason is semantic, not cosmetic. Dropping a tool call loses a requested action while making the turn appear successful. Translating an undeclared call invents executable caller intent and arguments after generation.

This PR preserves that decision unchanged.

### Prior nudge bug: blanket apply_patch prohibition

OpenCodex previously included `apply_patch` in the neighboring-agent deny list. That was incorrect for Codex Code Mode: `apply_patch` is Codex-owned and can be reachable as a nested `tools.apply_patch(...)` helper inside the declared `exec` tool even when it is absent from the flat top-level catalog.

The blanket prohibition made routed models avoid the intended patch path and fall back to Python heredocs or `sed` edits. Commit `0325a5afd16204e2300b432aeb273412d32cbf68` removed `apply_patch` from that deny list and fixed the wire-name coordinate mismatch for prefixed tool catalogs.

Reference: https://github.com/lidge-jun/opencodex/commit/0325a5afd16204e2300b432aeb273412d32cbf68

Consequence for this fix: do **not** reintroduce a sentence saying that `apply_patch` is forbidden or unavailable. The model needs an invocation-level distinction, not a capability denial.

## #1795 discussion

Issue #1795 reports 31 SenseNova failures in subagent/shadow-call traffic. The subagent catalog contained a limited read/search surface and omitted `exec`, while the system/instruction stack still mentioned `exec` capability. SenseNova then emitted top-level `exec`; the final bridge correctly rejected it:

```text
routed provider emitted undeclared client tool "exec"; only request-declared tools may be called
```

The issue initially proposed dropping the undeclared tool call and continuing the stream.

A follow-up comment correctly pointed out that this contradicts the repository's recorded fail-closed decision and would make bridged and native Responses paths diverge again. It reframed the bug as a prompt/catalog mismatch: the model sees a name in instructions that is not callable in the current catalog.

Reference: https://github.com/lidge-jun/opencodex/issues/1795#issuecomment-5305003614

## Kimi K3 v2.14.2 reproduction and v2.22.0 re-check

A second reproduction was captured with Teamwicked Kimi K3 on OpenCodex v2.14.2. It showed the same semantic mismatch at the Codex-native Code Mode helper boundary. That run was initially misidentified as v2.22.0 because it came from a different worktree that was still running v2.14.2.

Observed request characteristics:

- provider/model: `teamwicked-kimi-k3/teamwicked-kimi-k3`
- adapter: `openai-chat`
- route: explicit provider namespace
- requested/effective effort: `xhigh`
- result: HTTP 502 / `upstream_server_error`
- duration: about 31.5 s
- first output: about 28.0 s
- usage: unreported because the turn failed at the compatibility boundary

OpenCodex recorded:

```text
routed provider emitted undeclared client tool "apply_patch"; only request-declared tools may be called
```

The request/conversation identifiers were intentionally omitted from the public issue comment.

References:

- original repro: https://github.com/lidge-jun/opencodex/issues/1795#issuecomment-5305779307
- version correction: https://github.com/lidge-jun/opencodex/issues/1795#issuecomment-5306871615

Re-running the same Kimi K3 / `openai-chat` / `xhigh` Code Mode scenario on actual v2.22.0 has not reproduced the undeclared top-level `apply_patch` failure so far. The live v2.22.0 Kimi case therefore remains unconfirmed.

That does not remove the separate static metadata defect addressed by this PR: v2.22.0/current dev still applies `apply_patch`-specific `input` guidance to non-`apply_patch` Responses custom tools, and the non-OpenAI catalog nudge still does not explicitly distinguish the top-level invocation surface from nested helper APIs.

The v2.14.2 reproduction still matters because Code Mode deliberately exposes patching through the declared `exec` surface with a nested helper:

```text
exec
  -> tools.apply_patch(...)
```

Top-level `apply_patch` is therefore not equivalent to the supported nested helper call.

## Root cause found in current dev

There are two complementary guidance defects.

### 1. Custom-tool parser leaks apply_patch-specific argument help into every custom tool

`src/responses/parser.ts::buildTools()` lowers each Responses `custom` tool to a chat-compatible function with one string `input` field.

Before this PR, every custom tool received this same argument description regardless of its name:

```text
Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` ...
```

That means the Code Mode `exec` custom tool can reach a routed chat model with all of the following at once:

- top-level tool name: `exec`
- tool description: JavaScript execution plus nested `tools.apply_patch(...)`
- `exec.input` argument description: explicit `apply_patch` patch-envelope instructions

The parser therefore injects patch-specific metadata into a tool that is not `apply_patch`. For a model already exposed to Codex instructions that say to use `apply_patch` for edits, this increases the chance that the nested helper name is promoted into a top-level tool call.

The defect is generic: any non-patch custom tool receives the same irrelevant patch syntax.

### 2. The non-OpenAI catalog nudge defines names but not invocation levels

The shared nudge already says that the current catalog is ground truth and lists exact valid names. That is necessary but does not explicitly explain what to do with names that appear only inside:

- system/developer instructions;
- tool descriptions;
- argument descriptions;
- nested helper APIs such as `tools.*`.

The SenseNova case shows a model preferring a prompt-mentioned `exec` over the structured catalog. The Kimi case shows a model promoting nested `tools.apply_patch` capability to top-level `apply_patch`.

The missing concept is therefore not another deny list. It is the distinction between **top-level callable names** and **names that exist only inside the metadata or input language of a declared parent tool**.

## Implemented design

### Scope patch-specific input guidance to apply_patch

For `custom` tools:

- logical tool `apply_patch` keeps the patch-envelope help;
- every other custom tool gets neutral input help: `Raw freeform input for this tool.`

This preserves the existing freeform lowering contract and custom-tool restoration. It changes only misleading model-facing argument metadata.

### Define the complete top-level invocation surface

The non-OpenAI nudge now says:

- the listed catalog names are the valid **top-level** tool names for the turn;
- names mentioned only in instructions or tool metadata are not additional top-level tools;
- nested helpers must be used only inside the input of their listed parent tool.

The wording is generic. It does not special-case or ban `apply_patch`, so it does not reintroduce the heredoc regression fixed by `0325a5a`.

### Keep final enforcement unchanged

`bridge.ts` remains fail-closed. If a routed provider still emits a top-level name outside `declaredToolNames`, the turn continues to fail with the explicit compatibility error.

## Rejected alternatives

### Drop undeclared calls and continue

Rejected because the model requested an action that never happened. A successful-looking text continuation can then claim work was completed when the action was silently discarded. It also conflicts with the recorded bridge/native Responses contract.

### Automatically translate apply_patch into exec

Rejected because a raw patch body is not itself an `exec` program. OpenCodex would have to manufacture executable source such as an invocation of `tools.apply_patch`, changing the model's generated action after the fact.

### Add apply_patch or exec to declaredToolNames

Rejected because `declaredToolNames` represents the actual request-visible top-level contract. Adding names that were not declared defeats the enforcement invariant rather than fixing the guidance mismatch.

### Blanket-ban Codex-native helper names

Rejected because prior live evidence already showed the failure mode: explicitly banning `apply_patch` made routed models switch to ad-hoc shell/Python file rewrites instead of using the supported Code Mode path.

### Retry the turn automatically after an undeclared call

Not part of this PR. The Kimi reproduction produced client-visible output before the undeclared tool failure. A transparent retry after downstream output has begun can duplicate text/reasoning and violates the existing no-post-commit-retry direction. A future recovery mechanism would need a strict pre-commit condition and separate design review.

## Regression coverage

`tests/responses-custom-tool-guidance.test.ts` locks the parser boundary:

- `apply_patch` retains `*** Begin Patch` help;
- `exec` receives neutral freeform input help;
- an unrelated custom tool receives neutral freeform input help;
- neither non-patch tool's input description mentions `apply_patch`.

`tests/tool-catalog-nudge.test.ts` locks the invocation-level contract:

- the listed names are explicitly called the valid top-level names;
- instruction/tool/argument/nested-helper mentions do not create top-level tools;
- nested helpers are used through the listed parent tool;
- `apply_patch` is still never placed in the neighboring-agent prohibition.

Existing bridge and adapter conformance coverage remains responsible for the fail-closed returned-name boundary and for preserving Code Mode's nested `apply_patch` helper in final provider requests.

## Acceptance criteria

1. No non-`apply_patch` custom tool receives patch-envelope argument guidance.
2. Non-OpenAI routed requests distinguish top-level callable names from nested/helper names.
3. Code Mode requests still expose the nested `tools.apply_patch(...)` helper through `exec`.
4. The nudge still never blanket-forbids `apply_patch`.
5. An actually undeclared returned top-level name still fails closed at the bridge.
6. Focused tests, typecheck, and the shared adapter/runtime suite are green before review-ready status.
