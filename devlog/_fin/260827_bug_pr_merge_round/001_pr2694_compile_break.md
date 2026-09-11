# #2694 — SenseNova code-mode exec alias: does not compile

Head: `d6b2433453` (branch `fix/sensenova-code-mode-exec-alias`, author yxr1995-maker).
GitHub shows all five checks green and the PR is marked review-ready with 4/4 boxes
ticked, including "All CI tests are green on my local testing." That claim is false.

## Evidence

```
$ cd /tmp/ocx-pr2694 && bun x tsc --noEmit
src/bridge.ts(645,13): error TS2554: Expected 2-3 arguments, but got 1.
src/bridge.ts(647,11): error TS2304: Cannot find name 'failMalformedCodeModeExecCommand'.
src/server/responses/collaboration.ts(173,9): error TS2304: Cannot find name 'ToolBridgeMaps'.
src/server/responses/core.ts(2946,11): error TS2353: Object literal may only specify known
  properties, and 'requestId' does not exist in type '{ code?: ...; retryAfter?: ... }'.
src/server/responses/core.ts(2946,37): error TS2339: Property 'requestId' does not exist on
  type 'OcxRequestOptions'.
```

Four distinct defects:

1. `failMalformedCodeModeExecCommand()` is CALLED at `src/bridge.ts:647` and defined
   nowhere in the branch — `git grep -n 'failMalformed' pr2694-check -- src/` returns
   exactly the one call site. It does not exist on dev either.
2. `freeformInput` takes `(args, toolName, namespace)` on dev (`src/bridge.ts:247`);
   the PR calls it with one argument.
3. `ToolBridgeMaps` is used as a parameter type in the new exported function but is
   never imported or declared. `buildToolBridgeMaps` returns an inline object type on
   dev, so there is no such named type to import.
4. `formatErrorResponse(..., { requestId })` — that options bag has no `requestId`,
   and `OcxRequestOptions` has no such property.

## Why CI did not catch it

The PR ran only `CodeRabbit`, `enforce-target`, `hygiene`, `label`, `resolve-pr`.
None of those compile or test the tree.

An earlier version of this note claimed the full matrix "only appears on
maintainer-authored PRs." That was wrong — see 007, finding 6. #2639 carries all 27
checks and its author is not a maintainer, and `ci.yml` is `pull_request: {}` with no
draft gating. Why some PRs here get five checks and others twenty-seven is not
established; do not guess at it again.

## Second problem: the provider id is wrong

`src/server/responses/core.ts` gates the alias on `route.providerName === "sensenova"`.
There is no `sensenova` provider in `src/providers/registry.ts`. The id appears only in
`src/providers/free-directory.ts:141` as a free-directory entry
(`https://token.sensenova.cn/v1`). Whether `route.providerName` ever equals
`sensenova` for such a provider is unverified by the PR — it ships no test that
exercises the gate. Its single test calls `bridgeToResponsesSSE` directly with a
hand-built `toolNsMap`, so it never touches `enableSensenovaCodeModeExecCommandAlias`
at all, and would pass even if the gate never fires in production.

## Lane

**L4 — reimplement.** The diagnosis (a provider emitting bare `exec_command` instead of
the code-mode `exec` wrapper) is plausible and #2663 is independently solving the
general version of it. This branch cannot be committed-and-merged because it does not
build, and the missing function means there is no "small fix": the malformed-input
failure path was never written. Sequence it AFTER #2663 lands and re-evaluate whether
anything is still needed.
