# 030 — wp3: SoT sync, ready-for-review, exact-head CI receipt

Depends on 020. Class C2 for the docs. Push and PR creation are authorized by the user for this
branch ("no verify로 푸시", "pr올려봐"); the draft PR already exists from wp1. Merge is not authorized.

## MODIFY `structure/04_transports-and-sidecars.md`

Insert after the paragraph that ends "…or reconstruct output that the code-mode host never
emitted." (line 331), before the `[Decision Log]` that begins "목적과 의도: Keep Codex hosted web
search usable on xAI's public Responses endpoint…":

```
Routed code-mode turns also carry the host contract for the nested helpers, stated in the same three
injection sites as the result-emission rule (shared catalog nudge, Cursor code-mode guidance, native
routed Responses instructions): `tools.apply_patch` takes one string that opens and closes with the
bare patch marker lines (blank lines or indentation around them are tolerated; a decorated or missing
marker is rejected), the isolate has no `import`/`require`, and a command that outlives
`yield_time_ms` is polled through `write_stdin` with empty `chars` rather than a shell sleep loop.
When a code-mode exec result still carries one of the host's failure strings ("expects a string
input", "The first line of the patch must be", "The last line of the patch must be", "Unsupported
import in exec"), the native routed Responses, Kiro, and Cursor result paths append a one-line
recovery hint naming the broken rule; flat shell bridges and foreign MCP namespaces are never
annotated, Responses and Kiro additionally require the request's verified code-mode catalog, Cursor
matches the exact `exec` name under its `opencodex-responses` provider without catalog context, and
Cursor's error classification and Kiro's whitespace and failed-wrapper grouping are unchanged. Both
halves live in `src/adapters/exec-tool-result-normalize.ts`
so the pre-call and post-hoc wording cannot drift. This guidance and annotation change rewrites
neither the model's JavaScript nor its patch payload; the existing name-alias delimiter
normalization in `src/responses/code-mode-helper-compat.ts` is unchanged, and the host still rejects a
malformed call exactly as before. Anthropic, Google, OpenAI-chat and command-code result paths
have no exec-result seam today and are not annotated.

[Decision Log]
- 목적과 의도: Stop routed models from abandoning `apply_patch` after the Codex host rejects an object argument or a decorated marker, and from blocking a turn in a shell sleep loop when the host offers `session_id` polling.
- 기존 구현 및 제약 조건: The shared nudge, Cursor guidance and native Responses instructions already carry the result-emission rule from `exec-tool-result-normalize.ts`, but none stated the helper's argument type, the marker rule, the import ban, or the polling protocol; `260905_apply_patch_envelope_gap` refused to rewrite JavaScript bodies (MODE B), so payload repair is off the table.
- 검토한 주요 대안: Repair the argument shape inside the proxy (rejected: same body ambiguity as MODE B and it turns a rejected write into a performed one); Cursor-only guidance (rejected: the incident was native routed Responses on xAI); annotate every adapter's tool results (rejected: Anthropic/Google/OpenAI-chat/command-code have no exec-result seam and would need a new one).
- 선택한 방식: One pre-call sentence and one marker→recovery table in the module that already owns the echo pair; inject the sentence at the three existing code-mode sites; annotate at the three existing exec-result seams with an exec-gated, idempotent helper that never changes error status.
- 다른 대안 대신 이 방식을 선택한 이유: The safe repair for a host contract the model broke is to state it before the call and name it after the failure; keeping both halves in one file is what keeps them consistent.
- 장점, 단점 및 영향: Code-mode system prompts grow by roughly 600 characters on routed turns; OpenAI destinations, flat catalogs and compaction requests are untouched. An exec result that legitimately prints one of the four phrases gains a recovery line, which is additive text and never an error flip. The effect on the live Grok defect rate is unmeasured until a re-probe.
```

## MODIFY `docs-site/src/content/docs/guides/codex-integration.md`

Insert after the paragraph ending "…and unrelated native custom payloads stay unchanged." (line 331):

```
Routed code-mode turns are also told the host's rules for the nested helpers before the first
call: `tools.apply_patch` takes one string that opens and closes with the bare patch marker lines,
the isolate has no `import`, and long-running commands are polled through `write_stdin`. When a
code-mode exec result on the native routed Responses, Kiro, or Cursor path still carries one of the host's
failure messages, opencodex appends a one-line hint naming the rule. This change does not rewrite
the model's code or its patch text.
```

Translated locales (7 files) are not edited; the English source gains a paragraph they do not
contradict.

## Delivery steps (t3b)

1. Stage only `structure/04_transports-and-sidecars.md`, `docs-site/.../codex-integration.md` and this unit's
   devlog; inspect `git diff --cached --stat`; commit `--no-verify`; `git push --no-verify`.
2. Rewrite the PR body (`gh pr edit --body-file .tmp/pr-body.md`) to the final template: Summary
   (problem, before/after, the four host strings), Verification (hosted CI run ids per head; local
   suite/typecheck/build NOT RUN by instruction), Checklist ticked truthfully. No `gui` mention.
3. Poll `gh run list --branch codex/code-mode-host-contract --json databaseId,headSha,status,conclusion,name`
   in short `exec_command` calls (each < 30 s) until the Cross-platform CI run whose `headSha` equals
   `git rev-parse HEAD` completes; `gh run watch` is not used inside one call.
4. Receipt at phase C: `cxc receipt test --session <id> --cwd <worktree> -- gh run view <run-id> --exit-status`.
5. `gh pr ready <n>` only after that receipt exists. If the head moves later, a fresh run and fresh
   receipt are required before any further ready claim.

## Verification (C)

- `gh run view <id> --exit-status` exit 0 on the exact head; `gh pr view --json headRefOid` equals HEAD.
- `gh pr checks <n>` lists test 1/4..4/4, gates, storage policy, api usage as pass.
- Local suite / typecheck / build: NOT RUN (instruction).

## D record

Append `040_delivery_record.md` with PR number, head SHA, CI run id, per-job results, what did not
improve (LOOP-PESSIMIST-01: prose cannot force compliance; effect on real Grok defect rate is
unmeasured until a live re-probe), and the residual: Anthropic/Google/OpenAI-chat/command-code
tool-result paths do not annotate host failures because they have no exec-result seam today.
