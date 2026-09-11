# Audit corrections to the intake (A-gate round 1)

An independent reviewer audited the unit at c3ef63023 and produced two findings that
the plan got wrong. Both are confirmed here by direct command output, and the affected
documents are corrected rather than defended.

## Correction 1 — the compile gate ran against stale heads

Every PR head is behind current dev, some by a lot:

```
$ for n in ...; do git rev-list --count pr${n}-check..origin/dev; done
2694 26   2693 26   2690 4    2684 84
2674 87   2672 87   2671 87   2663 96
2647 84   2639 4    2638 87   2497 294
```

So `TYPECHECK_OK` on a PR head proved that head compiles, not that the MERGED tree
compiles. That is the number a merge round actually needs.

Re-ran the gate on the merge result (`git merge origin/dev + pr<n>-check`, then
`bun x tsc --noEmit`), recorded in `/tmp/ocx-merged-typecheck.txt`:

```
2672 MERGED_TYPECHECK_OK   2671 MERGED_TYPECHECK_OK
2684 MERGED_TYPECHECK_OK   2663 MERGED_TYPECHECK_OK
2690 MERGED_TYPECHECK_OK   2639 MERGED_TYPECHECK_OK
2638 MERGED_TYPECHECK_OK
```

The conclusions in 000 survive, but they now rest on the right evidence. #2694's
failure is unaffected: a call to an undefined function does not become defined by
merging dev.

## Correction 2 — #2684 and #2690 DO conflict

020 stated they "do not textually conflict (different helper, different call site)."
That is false:

```
$ git merge-tree --write-tree pr2684-check pr2690-check
exit=1
100644 ... 1  src/adapters/openai-chat.ts
100644 ... 2  src/adapters/openai-chat.ts
100644 ... 3  src/adapters/openai-chat.ts
```

The reason is structural, not incidental. #2690 DELETES the region #2684 edits:

```
$ git diff origin/dev...pr2690-check -- src/adapters/openai-chat.ts
@@ -922,16 +927,6 @@   -function isXaiSchemaTarget(...)
@@ -1212,265 +1207,6 @@  -function normalizeXaiToolParameters(...)  (+14 more)
```

#2690 moves ~269 lines of xAI schema logic out of `openai-chat.ts` into the new
`src/adapters/xai-tool-schema.ts`, while #2684 adds its Azure helper right beside
`shouldSanitizeZenToolParameters` in the same file and rewrites
`toolsToChatFormatForProvider`, which #2690 also touches.

Consequence for sequencing: whichever lands second must be re-applied by hand, not
merged. Land #2684 FIRST — it is 92 lines with a containment test and a merged-tree
OK — then rebase #2690's extraction on top, where the conflict is resolved once by the
party doing the extraction. The L3 plan for #2690 (take the normalization, leave the
refactor) becomes more attractive, since the refactor is exactly the conflicting half.

## Correction 3 — "#2663 CI green" means less than it sounds

The reviewer turned the plan's own #2694 argument back on it. 030 justifies squashing
#2663 partly on "CI is green". But #2663 ran EXACTLY the same five checks #2694 did:

```
$ gh pr checks 2663
CodeRabbit=pass  enforce-target=pass  hygiene=pass  label=pass  resolve-pr=pass
```

None of those compile or test the tree — which is precisely why #2694 shipped five tsc
errors behind five green checks. So "#2663 is CI green" is not evidence of health; it
is the same non-evidence, and the plan should not have leaned on it.

What IS evidence for #2663: it typechecks at its head (`TYPECHECK_OK`) and in the
merged tree (`MERGED_TYPECHECK_OK`). That covers compilation, not behavior. Its 12-file
diff touching `src/server/responses/core.ts` still needs the full suite green on the
merged tree before the squash lands, per 030's own gate — that gate is now the ONLY
thing standing behind this PR, so it is not optional.

Note for whoever runs it: `bun test` here takes a machine-wide lock
(`bare Bun worker N is waiting for test run pid M to release the machine lock`), so
concurrent suite runs serialize. Run the full suite once, on `ssh lidge-ai` via
`ocx-run`, rather than racing several locally.

## What this says about the round

Three claims were wrong in the plan, all in the same direction: stated more confidently
than the evidence supported. The lane assignments themselves survive, but three rules
now bind the rest of the round:

1. The merged-tree compile gate is the standard, not the PR-head gate.
2. Cross-PR conflicts are checked pairwise with `git merge-tree` before any merge,
   never inferred from "different helper, different call site."
3. "Checks are green" is never evidence of health on this repository unless the check
   list actually includes `ci` / `test N/4` / `macos`. For draft and contributor PRs
   it usually does not.
