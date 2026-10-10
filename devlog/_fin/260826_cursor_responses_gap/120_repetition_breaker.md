# 120 — Repetition breaker + final stack (r1, gap-9)

## Defect

User screenshot (kimi-k3 app session): byte-identical commentary "원격
ocx 상태를 다시 확인합니다" + same ssh probe emitted 6+ consecutive
times. Same class as S2a's 180x tool-call loop and the 차단/전환 echo:
external full-replay presents N identical rounds as N identical lines,
priming line N+1.

## Fix (gap-9, PR #2667)

protobuf-request.ts external replay assembly: consecutive duplicate
assistant/tool-result entries collapse to one entry +
"[note: this exact output was produced N times in a row]"; runs >=3 add
one imperative context note ("Repeating it again is a failure. Take a
DIFFERENT action now..."). User messages reset runs; native models and
structured pairing untouched. 5 regression tests; 211-test suite green.

## Live proof

Probe: history primed with 5 identical assistant rounds -> model reply:
"이전에 같은 상태 확인만 반복했으니, 이번에는 코드와 원격 OCX 설정을
직접 찾아서 최신 버전으로 올립니다." — loop broken on first response.
(/tmp/ocx-wire/rep-out.json; service pid 54225 on gap-9.)

## Final stack (gap-1..gap-9)

| PR | Branch | Fix |
|---|---|---|
| #2650 | cursor-gap-1 | call_id single-line codec + response.in_progress |
| #2651 | cursor-gap-2 | bare-caller default catalog suppression (token floor) |
| #2652 | cursor-gap-3 | tool-suspended checkpoint commit (external) |
| #2653 | cursor-gap-4 | dead-model catalog quarantine |
| #2654 | cursor-gap-5 | ultra toggle kimi-k3-1m + Max Mode wire flag |
| #2656 | cursor-gap-6 | blob integrity diagnostic + G2 capture procedure |
| #2662 | cursor-gap-7 | empty exec explanation + code-mode native ban |
| #2665 | cursor-gap-8 | silent-redirect denials + commentary/shell-write bans |
| #2667 | cursor-gap-9 | repetition breaker (this) |

Merge order: #2650 first; each child retargets to dev after its parent
lands (enforce-target skips stacked children).
