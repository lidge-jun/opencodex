# 030 — Preserve Cursor executable tool schemas (#3628)

## Loop specification

- Class: C3 adapter contract carry across the current module split; spec-satisfaction, one implementation PABCD cycle.
- Trigger: bare exec_command advertisement omits supported execution fields, and freeform tools advertise an empty parameter object.
- Goal: preserve shell fields and a required string freeform input through advertisement and argument normalization, with reserved shell-name rejection.
- Non-goals: executing commands, changing approval/sandbox policy, nativeLocalExec defaults, OAuth or transport changes, changing generated protobuf code, rejoining split modules.
- Verifier: exact delivered-head hosted focused Cursor regressions, typecheck/full-suite, privacy and docs build. NO local tests, suites, typecheck or test:changed. Commands in this document run only on CI runners.
- Stop/outcomes: DONE only after acceptance rows, current-head required jobs and independent review pass and main proves dev integration. NOOP requires equivalent current-dev implementation plus evidence; external validation/permission gaps are BLOCKED/NEEDS_HUMAN, never success.
- Memory: this document plus the main-owned research/CI ledger. Main owns goals and FSM; this planning delegate does not alter either.
- Escalation: changed contracts/conflicts return to main at P; two failed distinct worker packets cause main reclaim. Further downward delegation is a P amendment.
- Resource/write scope: read local refs and supplied PR JSON, write only the two delegated roadmap files during this task; later implementation is restricted to the exact map below. Main owns authorized GitHub credentials, publication/merge and session resource bounds. No paid endpoint probes or tool execution are required.

## Provenance, owner migration and blockers

Inspected baseline `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c` on 2026-09-06 KST.
Source `origin/d-source-3628` is `37e6115c8a2ad3ffe20fee1e5a1e79a054625a56`.
Carry both original commits, in order:

1. `1b29236c5bee9dd166b9d23983a2f1f1c2f0b793` — preserve executable tool schemas.
2. `37e6115c8a2ad3ffe20fee1e5a1e79a054625a56` — reject reserved freeform shell names.

Both are authored by **SB Yoon <44089734+yansigit@users.noreply.github.com>** (`yansigit`). Preserve original authorship and add `Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>` to the eventual squash commit/description.

`.tmp/d-delivery/pr-3628.json:133` records source head, `:134` CONFLICTING. Its body reports 32 focused tests/full-suite success on source head; this is not candidate CI proof. The earlier reviewer finding at old `tool-definitions.ts:429` rejects bare freeform exec_command/shell_command. The author comment references pre-rebase `ae871bd19`; the fetched source's actual second commit above contains the correction. Carrying only the first commit would reintroduce the finding. Refresh actual current threads at integration; the supplied reviews/comments snapshot is not a complete unresolved-thread query.

Current schema owner is **`src/adapters/cursor/tool-schemas.ts`**, moved by `3435d03983fdec305c6f2f4633650a15699a28e0` (split S04 L1/5). `tool-definitions.ts:6` imports schemas and `:8` preserves the public re-export facade. Do not cherry-pick a whole stale file over the split. Translate original schema hunks by symbol, retain current helpers, and add the new constant to the facade.

## Exact file change map

| Operation | Path | Change |
|---|---|---|
| MODIFY | `src/adapters/cursor/tool-schemas.ts` | All original production schema additions and both freeform guards, adapted from old tool-definitions.ts. |
| MODIFY | `src/adapters/cursor/tool-definitions.ts` | Add CURSOR_FREEFORM_INPUT_SCHEMA to the existing line-8 re-export only. |
| MODIFY | `tests/providers/cursor/cursor-tool-definitions.test.ts` | Port both source commits' complete regression hunks, preserving current file additions. |
| MODIFY | `docs-site/src/content/docs/reference/adapters.md` | Add exact Cursor contract bullet below under existing cursor section. |
| MODIFY | `structure/04_transports-and-sidecars.md` | Add schema ownership/normalization contract below. |
| NEW | none | Reuse existing file and test registration; no dependency or generated protobuf changes. |

Read-only consumers: `tool-naming.ts:76` isBareCodexShellBridgeTool (`!namespace` plus reserved name), `tool-definitions.ts:80` buildCursorToolDefinitions and `:92` schema encoding, `live-transport.ts:672` toolSchemas normalization map, `arg-normalize.ts:69` normalizeArgKeys. Existing tool choice filtering and namespaced names must remain unchanged. Configuration/NOOP cannot supply missing schema declarations; reuse existing schema owners rather than add a parallel abstraction.

## Exact patch references and adaptation

The authoritative complete patch is:

```sh
git diff 6b85485f32f783bafc61c79185d0cb937848859d 37e6115c8a2ad3ffe20fee1e5a1e79a054625a56 -- src/adapters/cursor/tool-definitions.ts tests/providers/cursor/cursor-tool-definitions.test.ts
```

Apply all production hunks from the old path to these current symbols in `tool-schemas.ts`:

1. `CURSOR_EXEC_COMMAND_INPUT_SCHEMA` at line 4: after max_output_tokens, add the original sandbox_permissions string enum (`use_default`, `require_escalated`), justification string, prefix_rule string array, login boolean, including original descriptions. Preserve required `["cmd"]` and additionalProperties false.
2. Add immediately after that constant:

```ts
/** Cursor represents a Responses freeform tool body as one string-valued input field. */
export const CURSOR_FREEFORM_INPUT_SCHEMA = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
} as const;
```

3. `CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA` at line 64: add the same four property shapes from the source diff, keeping command as the canonical fallback and preserving max_output_chars.
4. At the start of BOTH `cursorToolInputSchema` (line 80) and `cursorToolArgNormalizeSchema` (line 89), insert this complete block before the current shell/function fallback:

```ts
if (tool.freeform) {
  if (isBareCodexShellBridgeTool(tool)) {
    throw new Error(`freeform Cursor tools cannot use reserved shell bridge name ${tool.name}; use a namespace`);
  }
  return CURSOR_FREEFORM_INPUT_SCHEMA;
}
```

5. Add `CURSOR_FREEFORM_INPUT_SCHEMA` to the existing `export { ... } from "./tool-schemas"` facade at tool-definitions.ts:8. Existing tests import through that facade; do not introduce a second definition or silently change the public import surface.
6. Port original test imports for CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA and CURSOR_FREEFORM_INPUT_SCHEMA and the complete 94-line regression addition. Imports remain `../../../src/...` in the existing providers/cursor test directory. Existing manifests already register this file (layout.json:554, test-layout-expected.json:391).

Before: bare exec advertisement lacks four fields; normal/freeform schema lookup falls through to `parameters ?? {}`. After: both normalization and advertisement use one input string for freeform; bare reserved freeform names are rejected before either can acquire shell semantics. Namespaced shell-like tools stay ordinary freeform. Ordinary shell_command converts cmd to command; caller-supplied cmd-only exec_command stays cmd-only via existing shellBridgeArgNormalizeSchema. Keep this helper and current required-command validation intact.

## Regression activation scenarios

| Constructible input | Observable assertion |
|---|---|
| Bare non-freeform exec_command passed to buildCursorToolDefinitions | Decode protobuf ValueSchema and verify cmd schema plus enum/string/array/boolean field shapes; required cmd and additionalProperties false remain. |
| Freeform apply_patch with parameters `{}` | Both schema functions and decoded protobuf require a string input. |
| Freeform bare exec code-mode tool without parameters | Both schema functions return the same required-input contract. |
| Bare freeform exec_command and shell_command, each through both schema functions and buildCursorToolDefinitions | Throw the explicit reserved-shell-name error; include both names, not one representative. |
| Namespaced freeform exec_command under mcp__custom | Accepted required-input schema; never interpreted as bare shell bridge. |
| Bare ordinary function exec_command with cmd-only parameters | Advertised Cursor exec schema; normalization retains original cmd-only schema. |
| shell_command declared with command, receive cmd plus sandbox_permissions=require_escalated, justification, prefix_rule, login=false | Only cmd rewrites to command; all four values survive exactly, especially false. |
| exec_command declared cmd-only, same fields | cmd remains cmd, other values survive; no added command key. |
| Existing canonical command and an alias simultaneously | Existing normalizeArgKeys canonical precedence remains covered by adjacent tests. |

Use literal expected contracts and decoded protobuf values, not only equality against the newly added constant (both could be wrong together). Strengthen the ported freeform test with literal `{type:"object", properties:{input:{type:"string"}}, required:["input"], additionalProperties:false}`. Verify both ordinary shell directions already at current test lines 131 and 159. Existing code-mode/structured-edit tests later in the file protect unchanged routing and tool-choice behavior.

Optional additional hosted mutation experiment (not a completion prerequisite): with final tests and baseline schema code, observe missing-property/freeform assertions fail; restore final schema code and obtain green. Separately remove only the reserved-name guard in an isolated runner checkout to prove both rejection tests fail, then restore and rerun. Do not claim RED before these logs exist.

Runner-only commands:

```sh
bun test tests/providers/cursor/cursor-tool-definitions.test.ts
bun test tests/providers/cursor
```

Follow with existing hosted typecheck, full-suite, privacy scan and docs build. Capture exact head and actual executed jobs; label/hygiene green or action_required does not establish validation. Preserve no-local policy even on failure; inspect CI artifacts and repair the specific defect. Main uses authorized --no-verify pushes to avoid local prepush, not server policy. No workflow edits are planned.

## User and architecture documentation patch

The source body's claim that no user documentation is needed is not adopted: the advertised tool contract changes and the root instructions require documentation sync.

Append this bullet inside `## cursor` (`docs-site/src/content/docs/reference/adapters.md:304`), before `## azure-openai`:

```md
- Codex-compatible shell schemas retain sandbox permissions, justification, reusable
  prefix rules and login mode. Freeform tools expose one required string `input`;
  bare `exec_command` and `shell_command` names are reserved for non-freeform shell
  bridges. Namespace a custom freeform tool that uses either name. These schema
  declarations do not grant approval or change execution policy.
```

Append this block to the existing transport SOT, preserving 020 and peer additions:

```md
## Cursor executable tool schema ownership

`src/adapters/cursor/tool-schemas.ts` owns advertised and argument-normalization
schemas; `tool-definitions.ts` remains the public facade and protobuf encoder.
Advertisement and normalization intentionally differ for shell bridges: Cursor may
emit `cmd`, while the declared Responses contract decides whether it becomes
`command`. Both paths preserve execution-control fields. Freeform tools use one
required string `input`; bare shell bridge names are rejected on the freeform path.
Namespaced tools do not acquire bare-shell behavior. Regression coverage lives in
`tests/providers/cursor/cursor-tool-definitions.test.ts`.
```

Inspect directly affected translated adapter sections at P; add exact locale paths to this map if they contradict the English contract. No locale edit is justified solely by adding optional detail. Docs build remains CI-only.

## Integration handoff

030 follows 020 in the requested D stack; their runtime paths are independent, but the adapter reference and SOT are shared. Cascade stack updates after lower-layer changes, preserve each layer's review delta and attribution, and do not overwrite new split-owner behavior while resolving source conflicts. Main refreshes reviews and exact-head CI, merges bottom-up, verifies the landed commit is an ancestor of fetched dev, then promptly closes superseded #3628. Do not close on carry creation or CI success alone. This planning task writes no production code and performs no Git/GitHub mutations.

## Roadmap lock clarification

The implementation cycle certifies its published current-head candidate. Every dev-ancestry and original-closeout obligation remains mandatory in the separate landing work-phase, allowing the owner-requested stack to exist without treating publication as dev integration. Eligible lower layers may land early and are closed immediately after ancestry proof.

## External review amendment: closed freeform object

The advertised freeform schema must include additionalProperties:false, matching the existing custom-tool compatibility envelope. Include this literal property in schema and protobuf assertions; preserve ordinary named function schemas and reserved-name guards.
