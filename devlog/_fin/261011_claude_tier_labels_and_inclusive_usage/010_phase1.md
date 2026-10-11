# 010 — Phase 1: tier labels and inclusive usage

## MODIFY / NEW / DELETE map

### MODIFY `src/claude/context-windows.ts`

Add after `effectiveModelEnv` (import `resolveAlias` from `./alias`):

```ts
export const CLAUDE_TIER_LABEL_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;
export function claudeTierDisplayName(selector: string): string | undefined
  // resolveAlias(stripOneMillionMarker(trimmed)); null -> undefined.
  // native (no "/"): "<slug> (native)"; a native "claude-*" slug -> "<slug>".
  // routed "<provider>/<model>": "<model> (<provider>)".  Same strings as discovery
  // (model-info.ts). "--fast" suffix -> " · Fast"; [1m] marker -> " · 1M".
export function claudeTierDisplayNameEnv(env): Record<string, string>
  // { "<SLOT>_NAME": label } for every CLAUDE_TIER_LABEL_SLOTS value that is an alias.
```

### MODIFY `src/cli/claude.ts`

- `buildClaudeEnv`: after the `effectiveModelEnv` loop,
  `for (const [name, label] of Object.entries(claudeTierDisplayNameEnv(env))) setDefault(name, label);`
  Labels are derived from the FINAL slot values, so a user-exported slot gets a label matching
  its own alias and a user-exported `_NAME` wins.
- `buildNativeClaudeEnv`: in the `MODEL_ENV_SLOT_NAMES` strip loop, when a tier slot is
  deleted also delete `<slot>_NAME` if it equals `claudeTierDisplayName(value)`.

### MODIFY `src/server/system-env.ts`

- `MANAGED_SYSTEM_ENV_NAMES`: add the four `ANTHROPIC_DEFAULT_*_MODEL_NAME`.
- `injectSystemEnv`: after the model-slot loop, inject labels only for slots this run owns
  (`injectedKeys.includes(slot)`), through `injectLever` (user-wins, tracked, unset when no
  longer produced).

### MODIFY `src/server/system-env-shell.ts`

- `writeShellEnvFile`: after the slot loop emit, per label,
  `[ -z "${NAME+x}" ] && [ "${SLOT-}" = '<value>' ] && export NAME='<label>'` so the label is
  set only when the shell's slot holds the value OpenCodex wrote.

### MODIFY `src/adapters/coding-agent/protocol.ts` (carry #6566)

- `usageFromAnthropicShape`: `inputTokens = fresh + cacheRead + cacheWrite`; counters must be
  finite and non-negative.
- `mergePartialUsage`: fold fresh input by maximum, then add folded cache read/write once.

### MODIFY docs `docs-site/src/content/docs/guides/claude-code.md`

- Env table: new row `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL_NAME`.

## TESTS

- `tests/claude-integration/claude-context-windows.test.ts`: label strings (native, routed,
  v2 escaped, [1m], --fast, claude-* native, non-alias -> none) and env map.
- `tests/claude-integration/claude-cli.test.ts`: launch env pairs label; user slot / user
  `_NAME` win; native launch drops our label with the slot.
- `tests/server/system-env.test.ts` (or claude-system-env-auto): shell file guarded label line.
- `tests/providers/codebuddy-protocol.test.ts`: carried expectation updates + the reported
  12 / 150,000 / 4,000 shape -> inputTokens 154,012 and non-null `normalizeCostTokens`.
- `tests/providers/codebuddy-tool-bridge-turn.test.ts`: carried expectation update.

## Verification (C)

- `bun run typecheck` (exit 0), `bun run structure:check` (exit 0), `bun run privacy:scan` (exit 0).
- No local tests (lane packet). Hosted CI on the exact PR head: every required check success.


## A-phase revisions (audit VERDICT FAIL -> addressed)

1. Attribution: the alias tier-row defect is confirmed from the 2.1.296 binary; it is the
   candidate explanation for #6926 (gateway rows already carry `display_name`). The PR uses
   "Refs #6926", and closure waits for a picker observation on the reporter's tier slot.
2. Ownership: labels pair only with slots OpenCodex assigned in this run.
   - `buildClaudeEnv`: `setDefault` reports whether it assigned; only assigned tier slots get
     `setDefault("<SLOT>_NAME", label)` (a user `_NAME` still wins).
   - shell file: the alias slot line becomes
     `[ -z "${SLOT+x}" ] && export SLOT=<shellValue(v)> && [ -z "${NAME+x}" ] && export NAME=<shellValue(label)>`,
     so the label is written only in the branch that writes the slot.
   - launchd: labels only for slots in `injectedKeys` after the slot loop, via `injectLever`.
3. Native `claude-*` slug (the Anthropic Fable picker alias): label `"<slug> (anthropic)"`,
   matching discovery (`claude-fable-5-1 (anthropic) · 1M`).
4. Shell quoting: `shellValue` for both the slot value and the label; a test with an apostrophe.
5. Docs: `structure/clients/claude-desktop.md` (routed aliases section) and
   `structure/providers-and-adapters.md:45` (inclusive usage sentence, no new line: 598/600 budget).
6. Carried expectation updates: codebuddy-protocol.test.ts 217 (12/17), 477-479 (200/200),
   489-491 (7/7), 526 (18/23), 533 (18/27), 540 (43/52); codebuddy-tool-bridge-turn.test.ts 345 (18/23).


## C-phase revision (final review VERDICT FAIL, P2)

- `claudeTierDisplayName` no longer turns a trailing `--fast` into ` · Fast`: a real model
  such as `fixture/foo--fast` (tests/codex-integration/fast-row-listing.test.ts) was relabelled
  `foo (fixture) · Fast`. The label keeps the exact model id; a synthetic Fast sibling reads
  `<model>--fast (<provider>)`. Test: "a trailing --fast stays in the label".
