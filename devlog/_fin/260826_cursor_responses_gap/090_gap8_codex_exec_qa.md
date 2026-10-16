# 090 — gap-8 silent-redirect + codex exec adversarial QA (w2)

Service: gap-8 stack, restarted per round (final pid after d9752bc0e).
Instrument: `codex exec -m cursor/grok-4.6` non-interactive, scratch cwds
under /tmp/ocx-qa-JStBBM. Transcripts: s1.log-s5b.log in that scratch.

## Results

| Scenario | Round | Result | Evidence |
|---|---|---|---|
| S1 ten tool calls | 1 | PASS | 10/10 separate bridge execs (pwd,ls,date,whoami,hostname,uname-s,ls,id,echo HOME,uname-m); narration grep hits=0 |
| S2 native-tool bait | 1 | INCONCLUSIVE | run produced no agent output (0-byte response; separate G2-class incident) |
| S2b native-tool bait retry | 2 | PASS* | zero 차단/전환 narration; both requests answered via bridge on first attempt. Residual: model duplicated its commentary line + repeated the 2-call batch twice (double-batch echo, no user-visible harm) |
| S3 mixed read/edit | 1 | PASS | notes.txt ALPHA->BETA lifecycle completed; narration=0 |
| S4 5-step chain | 1-2 | FAIL | stalled after step 1-2, files missing; "이전 호출은 출력이 비어 있어... 처음부터" restart loop observed |
| repair: extend empty-result normalization to codex CLI native names (shell/local_shell/container.exec) | commit d9752bc0e | — | root cause: gap-7 fix keyed on bridge tool NAMES; codex exec advertises the native `shell` tool, so empty results were unexplained again |
| S4d 5-step chain re-run | 3 | PASS* | all 5 steps done, data.csv+avg.txt=84 correct; restart-narration grep=0; model still self-recovered from two empty-looking intermediate results but WITHOUT surface-switch framing and completed |
| S5 image via /v1/responses | 1 | PASS | 32x32 red PNG -> "Red", in=12036 |
| S5b image via codex exec -i | 1 | PASS | blue.png -> "파랑", tokens 45489 |

## Verdicts

- Silent-redirect (gap-8 core): narration '차단/전환/막혀' = 0 across all
  passing rounds; native-bait prompt answered bridge-first without
  announcing a switch. Fix effective.
- Empty-result loop: root-caused twice (bridge names at gap-7, codex CLI
  native names at gap-8 QA round 2); after d9752bc0e the 5-step chain
  completes. Residual: intermediate tool results still occasionally
  ARRIVE empty on the wire (model sees nothing and retries once) — that
  delivery gap is the remaining G2-class defect, now non-fatal because
  the retry succeeds without derailing.
- Image input: healthy at both API and codex exec layers. The reported
  app-session failure (repeated "Viewed an image" then giving up) did
  not reproduce here; needs an app-session capture with the actual
  clipboard file — recorded as UNKNOWN with repro steps pending.

## Open follow-ups

1. Wire-level empty tool-result delivery (why some exec outputs arrive
   blank upstream) — needs protobuf frame capture of an affected round.
2. App-session image loop repro.
3. S2b double-batch echo (duplicate commentary + repeated batch).
