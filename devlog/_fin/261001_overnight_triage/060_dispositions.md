# wp2 dispositions

| Item | Outcome | Evidence |
|---|---|---|
| #6339 | carried by #6341 (6f2f6ae9cf), then #6343 (a8c6c3f0d0) moved to 1.0.46 | Aside: `https://x.ai/cli/stable` serves 1.0.46; changelog lists v1.0.44 |
| #6342 | merged (7ea77aaaf5) | TokenLab guide link requested in WORKS mail 554 (2026-10-01) |
| #6299 | carried by #6344 (ee3845fb10) | translations reviewed |
| #6278 | carried by #6345 (8ad261e000) | GUI tests, browser regression, screenshots |
| #6336 | open, comment posted | missing resale/routing authorization; structure doc over budget |
| #6335 | open, comment posted | shell/runtime version-skew zoom ownership |

Reviews: independent `gpt-6.1-sol` reviewers per PR plus a combined verdict on #6343/#6342/#6299 translations (all pass).

`dev` after wp2: 8ad261e000 (#6345).

#6338: fixed by #6346 (09a86e1ab3), issue closed.

#6340: fixed by #6347 (c4a521985a), security review PASS, issue closed.

Final dev CI: run 36806598410 failed (stale oracles after #6347), fixed by #6349 (82a4955196); run 36808122713 success on 82a4955196 (39 success, 1 skipped). Release candidate: 82a4955196.

Release 2.75.0: pre-move #6351 (dev 2.76.0); preview #6352 dc1a1b0cc9, main #6353 ef0297f86c; push CPCI 36810974932 / 36811000613 and Service lifecycle 36810974949 / 36811000614 success; release runs 36812938867 (preview) and 36814374365 (stable) success; npm latest=2.75.0, preview=2.75.0-preview.20261001, gitHead verified; releases have 25 assets; latest.json 2.75.0 with 5 signed platforms.
