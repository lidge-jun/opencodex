# 010 — wp1: pre-call host contract sentence and its three injection sites

Depends on 000_plan.md (rev 2). Class C2. Anchors verified against ec799db26. Ends with an
authorized push and a draft PR so exact-head CI exists for this and later heads.

## MODIFY `src/adapters/exec-tool-result-normalize.ts`

Insert after the `CODE_MODE_RESULT_ECHO_SENTENCE` declaration (its closing `;` is at line 116):

```ts

/**
 * Host rules a routed model most often breaks on its first code-mode edit or wait, stated BEFORE
 * the call. Wording tracks the Codex host (0.153.2), probed live on 2026-09-07: a non-string
 * argument to `apply_patch` throws "expects a string input"; a body whose first line is not the
 * bare marker (decorated `*** Begin Patch ***`, a code fence, prose) throws "The first line of the
 * patch must be '*** Begin Patch'" — surrounding newlines are tolerated; ES imports throw
 * "Unsupported import in exec"; a command that outlives `yield_time_ms` returns `session_id` for
 * `write_stdin` polling. xai/grok-4.6 hit the first two, abandoned apply_patch for heredoc writes,
 * blocked a turn in a shell sleep loop, and died once on an import. None of that is repairable in
 * the proxy (devlog/_plan/260905_apply_patch_envelope_gap/010 MODE B); it is a contract the proxy
 * had not stated.
 */
export const CODE_MODE_HOST_CONTRACT_SENTENCE =
  "Host contract for the nested helpers: `tools.apply_patch(patch)` takes exactly one string, never an object such as `{input: ...}`; the patch text opens with the bare marker line `*** Begin Patch` and closes with the bare marker line `*** End Patch`, written without a code fence, prose, or extra asterisks on those lines (blank lines or indentation around the markers are tolerated; a decorated or missing marker is rejected). The isolate has no `import`, `require`, or module loader; use the globals the exec tool description lists (for example `tools`, `text`, `notify`, `store`/`load`, `ALL_TOOLS`). For a command that may outlive `yield_time_ms`, let `tools.exec_command` return a `session_id` and poll it on later calls with `tools.write_stdin({session_id, chars: \"\"})` instead of blocking a shell in a sleep loop.";
```

## MODIFY `src/adapters/tool-catalog-nudge.ts`

Line 8 BEFORE:
```ts
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "./exec-tool-result-normalize";
```
AFTER:
```ts
import { CODE_MODE_HOST_CONTRACT_SENTENCE, CODE_MODE_RESULT_ECHO_SENTENCE } from "./exec-tool-result-normalize";
```

Line 124 is one 1035-byte string ending in `rejected by Codex before the file is touched."`.
BEFORE (tail):
```ts
OpenCodex does not rewrite JavaScript inside exec, so extra asterisks on a marker line are rejected by Codex before the file is touched."
```
AFTER (tail):
```ts
OpenCodex does not rewrite JavaScript inside exec, so extra asterisks on a marker line are rejected by Codex before the file is touched. " + CODE_MODE_HOST_CONTRACT_SENTENCE
```
The flat-catalog branch (`"If a listed tool exposes nested helpers such as a tools.* API…"`) is unchanged.

## MODIFY `src/adapters/cursor/tool-guidance.ts`

Line 2 BEFORE:
```ts
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";
```
AFTER:
```ts
import { CODE_MODE_HOST_CONTRACT_SENTENCE, CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";
```

Lines 189-191 BEFORE (4-space indent as in source):
```ts
    codeMode
      ? CODE_MODE_RESULT_ECHO_SENTENCE + " There is no `require`, no `module`, and no filesystem or network globals; reach the host only through the nested helpers."
      : undefined,
```
AFTER:
```ts
    codeMode
      ? CODE_MODE_RESULT_ECHO_SENTENCE + " There is no `require`, no `module`, and no filesystem or network globals; reach the host only through the nested helpers. " + CODE_MODE_HOST_CONTRACT_SENTENCE
      : undefined,
```

## MODIFY `src/adapters/responses-code-mode.ts`

Line 3 BEFORE:
```ts
import { CODE_MODE_RESULT_ECHO_SENTENCE, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
```
AFTER:
```ts
import { CODE_MODE_HOST_CONTRACT_SENTENCE, CODE_MODE_RESULT_ECHO_SENTENCE, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
```

Insert before `/** Native routed Responses needs the same first-call/output contract… */` (line 32):
```ts
/** Append each sentence a replayed instructions string does not already carry, in order. */
function appendMissing(instructions: string, sentences: readonly string[]): string {
  return sentences.reduce(
    (acc, sentence) => acc.includes(sentence) ? acc : [acc, sentence].filter(Boolean).join("\n\n"),
    instructions,
  );
}
```

Lines 45-46 BEFORE (4-space indent):
```ts
    instructions: instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)
      ? instructions : [instructions, CODE_MODE_RESULT_ECHO_SENTENCE].filter(Boolean).join("\n\n"),
```
AFTER:
```ts
    instructions: appendMissing(instructions, [CODE_MODE_RESULT_ECHO_SENTENCE, CODE_MODE_HOST_CONTRACT_SENTENCE]),
```

The exec `input` parameter description (line 27) keeps only the echo sentence; the contract belongs in
`instructions`, which the existing test asserts byte-exactly.

Activation: routed native Responses request whose visible catalog has a bare freeform `exec` and no
bare shell bridge, non-OpenAI destination, not a compaction request (gate at lines 35-37).
Observable: `wire.instructions` ends with the contract sentence.

## TESTS (in place; no new file in wp1)

`tests/adapters/tool-catalog-nudge.test.ts`
- Line 7 import becomes `import { CODE_MODE_HOST_CONTRACT_SENTENCE, CODE_MODE_RESULT_ECHO_SENTENCE, EMPTY_EXEC_OUTPUT_MESSAGE } from "../../src/adapters/exec-tool-result-normalize";`
- In `"defines nested helper names as non-callable unless separately listed"` append:
```ts
    // The host contract rides the same code-mode branch as the echo rule (Grok 2026-09-07).
    expect(note).toContain(CODE_MODE_HOST_CONTRACT_SENTENCE);
    expect(note).toContain("takes exactly one string");
    expect(note).toContain("write_stdin({session_id, chars: \"\"})");
```
- In `"keeps the generic nested-helper parent-tool rule when exec is not listed"` append:
```ts
    expect(note).not.toContain("Host contract for the nested helpers");
```

`tests/providers/cursor/cursor-tool-definitions.test.ts`
- In `"teaches the nested-helper contract instead of a top-level shell bridge"` (starts line 754) append
  after the `"OpenCodex does not rewrite JavaScript inside exec"` assertion:
```ts
    expect(note).toContain("Host contract for the nested helpers");
    expect(note).toContain("takes exactly one string");
    expect(note).toContain("write_stdin");
```
- In `"keeps flat-catalog shell-bridge guidance when a bare bridge is advertised"` append:
```ts
    expect(note).not.toContain("Host contract for the nested helpers");
```

`tests/responses/openai-responses-passthrough.test.ts`
- Line 6 import adds `CODE_MODE_HOST_CONTRACT_SENTENCE`.
- Line 54 BEFORE:
```ts
    expect(wire.instructions).toBe(`Keep this instruction.\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`);
```
  AFTER:
```ts
    expect(wire.instructions).toBe(`Keep this instruction.\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}\n\n${CODE_MODE_HOST_CONTRACT_SENTENCE}`);
```
- New test after `"does not duplicate instructions or explain an unpaired or unrelated result"`:
```ts
  test("a replayed body that already carries the echo rule gains only the missing contract sentence", () => {
    const body = { ...raw(), instructions: `Keep this instruction.\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}` };
    const parsed = parseRequest(body);
    const first = normalizeResponsesCodeMode(body, parsed, routed) as typeof body;
    expect(first.instructions).toBe(`${body.instructions}\n\n${CODE_MODE_HOST_CONTRACT_SENTENCE}`);
    expect(first.instructions.split(CODE_MODE_RESULT_ECHO_SENTENCE).length).toBe(2);
    const second = normalizeResponsesCodeMode(first, parsed, routed) as typeof body;
    expect(second.instructions).toBe(first.instructions);
  });
```
- In `"official OpenAI and non-code-mode catalogs remain untouched"`, inside the `for (const native…)` loop
  append `expect(JSON.stringify(wire)).not.toContain("Host contract for the nested helpers");`.

`tests/providers/kiro/kiro-adapter.test.ts`
- In `"names ALL_TOOLS when a freeform exec is advertised without a bare shell bridge"` (line 1817) append:
```ts
    // Survives Kiro's 16 384-char injected-instruction bound on the real wire prompt.
    expect(content).toContain("Host contract for the nested helpers");
```

## Delivery for this phase

`git add` only the files above; `git diff --cached --stat` first; commit `--no-verify`; then
`git push --no-verify -u origin codex/code-mode-host-contract` and
`gh pr create --draft --base dev --title "fix(code-mode): state the host contract for nested helpers and annotate host failures" --body-file .tmp/pr-body.md`
(body per template; Verification section says local checks NOT RUN, hosted CI is the verifier;
wp2/wp3 will extend it).

## Verification (C, hosted only)

NOT RUN locally by instruction. Poll `gh run list --branch codex/code-mode-host-contract --json databaseId,headSha,status,conclusion,name`
in short `exec_command` calls; when the Cross-platform CI run for `git rev-parse HEAD` completes,
`cxc receipt test --session <id> --cwd <worktree> -- gh run view <id> --exit-status`.
