# 100 — wp: 후속 라운드 3 (#700 클로즈 / #646 리뷰 / #653 재판정)

계획 겸 결과. PABCD 1사이클, 터미널 결과 DONE (단 #653은 CI 진행 중으로 다음 사이클 이관).

## 1. #700 클로즈 — 완료

`091`에서 "다음 라운드에서 확인"으로 남긴 항목. #711이 `d24c5233f`로 `origin/dev`에
반영됐음을 확인하고, 신고자의 컨트롤 매트릭스 3항목이 실제로 커버되는지 검증했다.

`origin/dev` detached 워크트리에서 `tests/claude-outbound.test.ts` 실행:

```
(pass) data-only Responses frames infer event names from payload types
(pass) explicit and data-only Responses frames can interleave
(pass) data-only Responses frames survive non-streaming aggregation
(pass) explicit event names override payload types and untyped data-only frames stay ignored
(pass) data-only [DONE] without a Responses terminal frame still fails closed
30 pass / 0 fail
```

마지막 케이스가 중요하다. 파서를 느슨하게 하면서도 truncation 감지 자체는 유지한다 —
`[DONE]`만 오고 terminal frame이 없으면 여전히 실패한다. 원래 검사가 존재한 이유를
약화시키지 않았다는 증거이며, 클로즈 코멘트에 이 점을 명시했다.

수정 지점: `src/claude/outbound.ts:462`

```ts
const resolvedEventName = eventName || (typeof data.type === "string" ? data.type : "");
```

상류 근거(Luna 레인, 1차 출처): WHATWG event-stream 문법은 `data`만 있는 블록을 허용하고,
OpenAI 파이썬 SDK도 `sse.event`가 아니라 디코드된 payload의 `type`으로 라우팅한다.
즉 data-only 프레임은 정상 입력이고 우리 파서가 과하게 엄격했다.

## 2. #646 리뷰 — 실행 가능한 블로커 전달

기여자 PR이라 직접 수정하지 않고 정확한 변경을 지정하는 리뷰를 남겼다.

확인한 사실: 티어 데이터 `["low","high","max"]`는 Cursor 공식 CursorBench 페이지와
Moonshot 공식 모델카드 양쪽에 일치. `medium`은 존재하지 않는다. 테스트도 로컬 재현 통과
(18 pass, 182 pass, tsc clean).

블로커는 Codex 리뷰의 P2가 실재한다는 것. 브랜치에서 직접 재현:

```
cursorModelEffortLadder("kimi-k3")            -> ["low","high","max"]
cursor registry modelDefaultReasoningEfforts  -> null
default_reasoning_level would be              -> high
```

`applyReasoningLevels`는 `medium` 없으면 `high`를 고른다. 그래서 픽커 요청이 `high`를
명시 전송하고 request-builder의 no-effort → `kimi-k3-max` 폴백에 도달하지 못한다.
`origin/dev:src/providers/registry.ts:660`의 `opencode-go` 엔트리는 이미
`modelDefaultReasoningEfforts: { "kimi-k3": "max" }`를 갖고 있어 일관성도 깨진다.

요청한 것: cursor 엔트리에 같은 한 줄 + 카탈로그 레벨 회귀 단언 + docs-site Cursor
커버리지 갱신 + draft 해제. 기존 effort-suffix 테스트가 이 한 줄 없이도 통과하기 때문에
P2가 빠져나갔다는 점을 명시했다.

## 3. #653 — 다음 사이클로 이관

선행 #652가 랜딩됐으므로 재판정 가치가 생긴 상태. 실측:

- `windows-latest` `conclusion=failure` (라운드 1 기록대로 진짜 실패, cancelled 아님).
  실패 스텝은 `Test`.
- `gh run rerun 30476667108 --failed` 디스패치 → 이 사이클 종료 시점까지 `pending`.
- 로컬 검증은 깔끔하다: `tests/baseten*.test.ts` + parity + discovery-contract
  38 pass / 0 fail, `bun x tsc --noEmit` rc=0.

로컬이 통과하는데 Windows만 실패한다는 조합은 라운드 1의 #610 패턴(`EEXIST: epoll_ctl`
Bun 러너 크래시)과 같은 계열일 가능성이 있다. Luna 레인 조사에서 대응 Bun 이슈를
찾지 못했으므로 알려진 회귀로 단정하지 않는다. 재실행 결과가 나오면 판정한다.

## 4. #696 사전 실측 (다음 사이클 근거 확보)

`origin/dev:src/tray/windows.ts` 확인:

- `RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"` 단일 경로
- `buildWindowsTrayRunCommand`가 PowerShell 경로 + 5개 경로 인자(`-File`, `-BunPath`,
  `-CliPath`, `-CodexHome`, `-OpenCodexHome`)를 그대로 결합
- 길이 검사 없음, 바로가기(`.lnk`)나 스케줄러 대안 경로도 없음

신고자 실측 493자 / MS 문서상 한도 260자. 미수정 확정.

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | #700 해결 검증 후 클로즈 | PASS | `CLOSED/COMPLETED`, 5개 회귀 케이스 통과 확인 |
| 2 | #646 블로커를 재현 근거와 함께 전달 | PASS | comment 5124315663, 재현 출력 포함 |
| 3 | #653 실패 성격 판정 | PARTIAL | 진짜 실패 확인 + 로컬 통과 확인, CI 재실행 진행 중 |
| 4 | 사용자 작업분 무손상 | PASS | 4개 unstaged 유지, 커밋 `14d58ec1d`는 사용자 본인 |
| 5 | 푸시 없음 | PASS | `gh pr merge`만 사용, 로컬 푸시 0회 |

## 다음 사이클 후보 (우선순위)

1. #653 재실행 결과 판정 — 이관됨. green이면 랜딩, fail이면 로그 기반 분류
2. #696 — 근거 확보 완료. Run 값 길이 초과. 수정 방향은 바로가기 기반 자동시작 또는
   래퍼 스크립트로 인자 축약. 오너 판단 필요(Windows 설치 경로 정책)
3. #701 — dotenv가 구독 인증 덮음. 정책 판단 섞임 (작업 디렉터리 파일이 로그인을
   덮어써도 되는가)
4. #702 — 재개 시 컨텍스트 조용히 유실. 85,073 → 22 토큰인데 HTTP 200. 설계 문제
