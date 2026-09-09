# 010 — wp1: anonymize leaked remote home paths on origin/dev

Depends on: wp0 (this unit exists). Independent of #3190's unique commits.

## Defect

`scripts/privacy-scan.ts` matches `/Users/<username>/` and fails any username that is not the maintainer account or the allowlist `u` / `user` / `me` / `test`. After #3181, `devlog/_plan/260902_multiplatform_qa_and_gui/091_wp6_merge_outcome.md` quotes two remote macOS home prefixes as the example of what the scan caught. That citation re-introduces the same shape, so every later PR whose GitHub merge commit includes current `dev` fails `gates` / Privacy scan. This is why #3190's matrix is red even though #3190 itself does not contain that file.

CI evidence (Cross-platform CI run 33538646261, job 99959406196, head `5f8cd24dd`):

```
Privacy scan failed:
devlog/_plan/260902_multiplatform_qa_and_gui/091_wp6_merge_outcome.md:13 home-path: /Users/<remote-a>/
devlog/_plan/260902_multiplatform_qa_and_gui/091_wp6_merge_outcome.md:13 home-path: /Users/<remote-b>/
```

Do not paste the real usernames into this unit. The scanner would fail this file the same way.

A second candidate is line 29 of `020_wp3_wp5_deploy_qa.md`, the Windows npm prefix under `/c/Users/user/...`. Username `user` is allowed. Confirm with a live `bun run privacy:scan` rather than assuming; if it is clean, leave 020 untouched.

## Diff (MODIFY only)

File: `devlog/_plan/260902_multiplatform_qa_and_gui/091_wp6_merge_outcome.md`

Before (line 13-15, sense only — do not restore the forbidden shape):

```
두 번째가 제일 의미 있다. 문서에 <two remote macOS homes>,
<posix home>, <windows npm prefix>를 실측 그대로 적었는데, 그건 다른 사람의
홈 경로다. 스캔이 정당하게 잡았고 `~/`로 바꿨다.
```

After:

```
두 번째가 제일 의미 있다. 문서에 원격 macOS 홈 경로 두 개,
POSIX 홈, Windows npm 접두를 실측 그대로 적었는데, 그건 다른 사람의
홈 경로다. 스캔이 정당하게 잡았고 `~/`로 바꿨다.
```

No other files. Do not edit `scripts/privacy-scan.ts` to widen the allowlist. The detector is correct; the citation is the bug.

## Steps

1. `git fetch origin && git switch -C codex/260902-privacy-091 origin/dev` if the current branch already carries later work; otherwise stay on `codex/260902-admin-merge-3190` while it still equals `origin/dev` plus this unit's docs.
2. Apply the 091 edit. Confirm `git grep -n '/Users/' -- devlog/_plan/260902_multiplatform_qa_and_gui` no longer prints a forbidden username.
3. `bun run privacy:scan` — exit 0. If it still names 091, the replacement still matches the regex; rewrite again without the `/Users/<name>/` shape.
4. Commit: `docs(devlog): drop remote home-path citations the privacy scanner flags`.
5. Push `--no-verify`. Open a PR targeting `dev`. Fill the template. This PR does not mention `gui` in title or body, so no screenshot gate.
6. Exact-head CI. `gates` / Privacy scan must be SUCCESS on this head. Other jobs may still be in flight; do not merge on a red privacy scan.
7. Admin squash merge with rationale: docs-only, privacy-scan self-repair, no production surface.
8. Proof: `git fetch origin && git merge-base --is-ancestor <merge> origin/dev`.

## Accept

- `bun run privacy:scan` exit 0 on the repair head.
- 091 no longer contains a `/Users/<other>/` token.
- The merge commit is an ancestor of `origin/dev`.
- `scripts/privacy-scan.ts` is unchanged.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

Trigger: run `bun run privacy:scan` on a tree that includes the edited 091. Observable: stdout `Privacy scan passed`, exit 0. Negative: restoring the old 091 line must fail again — do not restore it; the CI log of run 33538646261 is the red proof.
