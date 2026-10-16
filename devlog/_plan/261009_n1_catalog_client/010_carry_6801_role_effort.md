# 010 — wp1: carry #6801 (LazyCodex role reasoning effort)

Branch `codex/n1-lazycodex-role-effort` from `origin/dev` `730d898457`.

## Carry

```sh
git -C <lane> fetch origin pull/6801/head
git -C <lane> switch -c codex/n1-lazycodex-role-effort origin/dev
git -C <lane> cherry-pick 3771131fa7 c684e3981a f904047cf4 329ace492a
```

Independent review (sol, read-only) confirmed `git apply --check` and `merge-tree` are clean on
`730d898457`; the four commits produce ten changed files. Carried behaviour:

- `GET /api/codex-agent-roles` adds `effort` (root `model_reasoning_effort` or `null`).
- `PUT /api/codex-agent-roles/{role}` with `effort` also writes
  `"[codex]".agents.<role>.reasoning` in omo.jsonc through `omoReasoningFor`
  (`none → off`; `ultra` has no LazyCodex level, so `null` deletes a stale `reasoning`).
  A model-only PUT passes `undefined` and keeps any existing `reasoning`.
- `ocx agent roles set <role> <model> --effort <level>`; `ocx agent roles` prints the effort.

## Fix 1 — empty `--effort` must not become a model-only write (MODIFY `src/cli/agent.ts`)

`takeOption` returns `""` for `--effort ""`, and the carried body expression drops it, so the
command changes the model and silently ignores the supplied flag.

```diff
   const effort = takeOption(args, "--effort");
+  if (effort !== undefined && effort.trim() === "") {
+    throw new CliUsageError("--effort needs a reasoning level", USAGE);
+  }
   const role = args.shift();
@@
-    { method: "PUT", body: JSON.stringify(effort ? { model, effort } : { model }) },
+    { method: "PUT", body: JSON.stringify(effort !== undefined ? { model, effort } : { model }) },
```

Regression: `tests/cli/cli-headless-parity.test.ts` (near :991, the documented CLI resource cases) asserts that
`--effort ""` throws `CliUsageError` with no request sent, and that `--effort high` sends
`{ model, effort: "high" }`.

## Fix 2 — owning contract text (MODIFY `structure/clients/integrations.md`)

The omo role-model paragraph still says the write "changes one value the user just chose". Rewrite
that sentence in place (file is at 598/600 lines; no net new lines):

```diff
-snapshot, or journal. It changes one value the user just chose and leaves every other key as it
-was, re-serialized with the file's indentation, line endings, and BOM.
+snapshot, or journal. It changes the role's `model` and, when the request carries an effort, its `reasoning` (`none` becomes `off`; a level LazyCodex lacks, such as `ultra`, removes a stale `reasoning`; no effort keeps it), and leaves every other key as it
+was, re-serialized with the file's indentation, line endings, and BOM.
```

## Route regression (MODIFY `tests/server/codex-agent-role-routes.test.ts`)

Add a case: an omo.jsonc entry with `reasoning: "high"` survives a model-only PUT (TOML effort
untouched, omo `reasoning` unchanged).

## Commit and PR

One fix commit on top of the four carried commits, with trailer
`Co-authored-by: LilMGenius <smsmeee@naver.com>`. PR title
`feat(codex): carry each LazyCodex role's reasoning effort into omo.jsonc (carry #6801)`; template
sections filled; Verification lists exact commands and the CI-left coverage.

## P re-verification (wp1 entry)

`origin/dev` moved to `bb36029ef9` (#6820, Codex restore on a missing home). It touches none of the
carried files, the CLI test, or `structure/clients/integrations.md`; #6801's head is still
`329ace492a`. The branch starts from `bb36029ef9`; the plan above is unchanged. Merge authority was
granted afterwards by the coordinator: squash-merge with `--admin` after the gate, then close #6801
with a credit comment.
