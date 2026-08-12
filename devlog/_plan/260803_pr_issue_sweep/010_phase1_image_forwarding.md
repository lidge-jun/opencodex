# 010 — Phase 1: land #912, tool-result images to vision models

## Unit

PR #912 by @DevMello, head `d0a525d7226f2faedc14ed96270154ca5de7da24`, fixes
issue #888. Seven files, +207/−1.

## Verdict from audit

PASS, no blockers. The audit ran the merged tree in a scratch checkout:
typecheck exit 0, 42 image/EOF tests pass, 37 parser/vision tests pass. The
ablation is the part that matters — against unchanged `dev`, four
image-forwarding tests fail and the image-free control still passes. The test
is not tautological.

## The change

`src/adapters/openai-chat.ts` gains an image-part extractor and a deferred
carrier. Tool messages in the Chat Completions schema accept only strings or
text parts, so images cannot ride on the tool result itself. They are collected
while tool results are consumed and flushed as a following `user` message once
the tool round closes:

```ts
const flushToolResultImages = (): void => {
  if (pendingToolResultImageParts.length === 0) return;
  out.push({
    role: "user",
    content: [
      { type: "text", text: "[ocx] image output from the preceding tool result(s):" },
      ...pendingToolResultImageParts,
    ],
  });
  pendingToolResultImageParts = [];
};
```

Flush points: the parallel-round close in `flushPendingToolCalls`, the
last-matching-result branch, and the orphan-result branch.

This matches how the repository already carries tool-result images elsewhere —
`src/adapters/google.ts:196-208` puts `inline_data` beside the
`functionResponse` in a user turn, and `src/adapters/kiro.ts:511-531` uses the
same corresponding-user-carrier shape.

## Drift after #880

#880 inserted five response-side helpers before `messagesToChatFormat`, moving
every target region:

| Symbol | PR-era line | Merged line |
|---|---:|---:|
| `messagesToChatFormat` | ~80 | 195 |
| tool-round state | ~91 | 206–211 |
| deferred-barrier helper | ~109 | 222–242 |
| `flushPendingToolCalls` | ~122 | 247–259 |
| `toolResult` handling | ~232 | 360–402 |

The hunks still land in the right regions. #912 changes request construction
only; the stream parser starts around merged line 802, so #896's finish-less
EOF logic is untouched — verified by the 37 EOF/terminal checks passing on the
merged tree.

## Why this fixes #888

The reporter's route was traced end to end. Claude Code sends an Anthropic
`tool_result`; `src/claude/inbound.ts:96-113` preserves contained images as
`input_image`; `src/responses/parser.ts:547-555` converts to an internal
`toolResult` with structured image parts; Kimi OAuth
(`src/providers/registry.ts:712-741`) and Kimi API-key (`:1428-1444`) both
resolve to `openai-chat`. Current `dev` flattens that through
`contentPartsToText` — the `[image]` placeholder the reporter saw.

The secondary `deepseek-v4-pro` report in the same issue is a different path:
built-in DeepSeek V4 models sit in `noVisionModels`
(`src/providers/registry.ts:1013-1016`) and route through the vision sidecar,
not this carrier.

## Capability gating

The adapter forwards valid image parts unconditionally, which is correct
because gating happens upstream: `provider.noVisionModels` at
`src/server/responses/core.ts:1536-1553` either invokes the sidecar or strips
images fail-closed, and `carriesImages()` includes `toolResult`
(`src/vision/index.ts:187-194`). A provider that rejects image parts declares
itself in `noVisionModels`; that is the existing registry location, and no new
gate is needed.

## Plan

1. Wait for the PR's own CI. It runs the **old** workflow (single `ubuntu` /
   `windows` jobs) because the branch is 140 commits behind `dev`. That is
   expected and not a defect.
2. Merge. Do not force-push the contributor's branch; the merge commit rebases
   nothing and the audit already verified the merged tree.
3. Close #888 referencing the merge commit.

## Accept criteria

- `gh pr view 912 --json state` reports `MERGED`.
- The sharded lane is green on the resulting `dev` commit.
- `gh issue view 888 --json state` reports `CLOSED` with the commit named.

## Residual

Non-blocking: the five translated adapter doc bullets describe direct
`image_url` forwarding without noting that `noVisionModels` models receive
sidecar-generated text instead. Worth a follow-up sentence, not a merge
blocker.
