# WP6 — 스윕 종료 통합 검증

구현 phase가 아니라 검증 phase다. 코드 변경은 앞선 work-phase에서 발견된 회귀를 고치는
경우에만 발생한다.

## 목적

WP1~WP5의 수정을 모두 쌓은 트리에서 기존 테스트가 깨지지 않았음을 증명하고, 스윕 결과를
기록한다.

## 절차

### 1. 정적 검사

```bash
bun run typecheck
```

종료코드 0이어야 한다. 실패 시 해당 work-phase로 되돌아간다.

### 2. 전체 스위트

```bash
bun run test
```

기준선과 대조한다. 각 work-phase에서 확인한 부분 기준선은 다음과 같다.

| 파일 | 기준선 |
|---|---|
| `tests/codex-routing.test.ts` | 59 pass / 0 fail |
| `tests/responses-compaction.test.ts` + `openai-responses-passthrough.test.ts` | 46 pass / 0 fail |
| `tests/service.test.ts` | 34 pass / 0 fail |

신규 실패가 하나라도 있으면 원인 work-phase를 특정해 되돌아간다. 전체 스위트가 처음부터
실패하던 항목이 있으면 그건 우리 변경과 무관함을 커밋 SHA로 대조해 증명한다.

### 3. 프라이버시 스캔

```bash
bun run privacy:scan
```

`AGENTS.md`가 CI 게이트로 명시한 항목이다. WP1이 계정 상태를, WP4가 usage 추정을
다루므로 요청 본문·토큰·계정 식별자 로깅이 새로 들어가지 않았음을 확인한다.

### 4. 보안 경계 재확인

`MAINTAINERS.md`의 보안 검토 대상에 걸리는 두 항목을 명시적으로 점검한다.

- **WP1**: probe lease가 계정당 동시 1개인가. lease 간격이 상한보다 짧아질 수 없는가.
  실패한 probe가 반드시 cooldown을 연장하는가.
- **WP5**: override가 `apiKey`/`authMode`/`baseUrl`을 바꾸지 않는가. 허용 목록 밖 값이
  config·관리 API·resolver 세 층에서 모두 거부되는가.

### 5. 종료 요약 작성

이 문서 하단에 결과를 append한다.

- work-phase별 커밋 SHA와 한 줄 요약
- 각 criteria의 capturedEvidence (테스트 파일 경로 + 통과 출력 tail)
- DONE / NOOP / BLOCKED / NEEDS_HUMAN으로 종료한 항목과 그 근거
- 범위 밖으로 남긴 후속 작업

## 예상 후속 작업 (이번 스윕 범위 밖)

- #433 이슈 제안 3·4번: `ocx account clear-cooldown` CLI와 cooldown 상태 가시화.
  CLI/GUI 표면이라 별도 unit이 필요하다.
- #418: 제보자가 provider를 비공개해 재현 경로가 없다. raw `spawn_agent` trace가
  확보되면 그때 착수한다.
- #404 후속: 허용 adapter 확대는 adapter별 credential threat model이 선행되어야 한다.
- 열린 PR과의 정합: #436, #430은 각각 #435, #420을 커버하므로 이 스윕이 건드리지 않았다.
  머지 순서에 따라 충돌 여부를 재확인한다.

## 결과

_(WP6 실행 시 작성)_

### 수정된 버그

| 이슈 | 커밋 | 요약 |
|---|---|---|
| #433 | `c71defc4` | 회복된 계정을 재시작 없이 다시 쓰도록 probe lease 도입, reset 파생 cooldown 상한 분리 |
| #432 | `c00b9c0c` | 생략된 Task Scheduler 기본값을 기본값으로 읽고, 판정을 한 owner로 통합 |
| #422 | `e2626eb6` | Responses wire를 compaction-trigger 지원으로 오인하지 않도록 capability gate 교체 |
| #373 | `cb22b7ee` | 재시작 후 checkpoint가 없을 때 전송 payload에서 파생한 estimate 보고 |
| #404 | `359e2ecd` | 혼합 게이트웨이에서 모델별 wire override 허용 |

계획 문서 커밋: `cddc86f9` `961fa431` `86de6069` `c349c758` `48ae2028` `dc4de1c0` `5051fa98`

### 검증

```
bun run typecheck                      exit 0
bun run test                           4132 pass / 2 fail / 2 errors
bun run privacy:scan                   통과
```

기준선(변경 전 동일 명령, 변경분 stash 후 측정): **4079 pass / 2 fail / 2 errors**.

증가분 +53은 전부 이번 스윕의 신규 회귀 테스트다. 실패 2건은 이 워크트리에 GUI 의존성이
설치되지 않아 `gui/src`의 `react/jsx-dev-runtime`이 해결되지 않는 것으로, 변경 전후가 동일하며
수정과 무관하다.

### 교차 영향 확인

#422와 #404가 모두 `core.ts`의 provider/adapter 판단을 건드리므로 직접 확인했다.

- canonical forward provider는 override 해석 이후에도 canonical로 남는다 → #422의
  compaction gate가 정상 동작한다.
- key 게이트웨이가 override로 responses wire를 받아도 canonical로 오인되지 않는다 →
  synthetic compaction 경로가 유지된다.
- #433의 probe lease는 최종 트리에서 429 → lease 획득 → leased success → cooldown 해제까지
  end-to-end로 동작한다.

### 보안 검토 (MAINTAINERS.md)

- **#433**: lease는 계정당 동시 1개, `Retry-After` 유래 cooldown은 probe 대상 제외,
  세대 불일치 lease는 새 cooldown을 해제하지 못함, 실패한 probe는 interval을 재시작.
  각각 회귀 테스트로 고정.
- **#404**: override 허용 값을 `openai-chat`/`openai-responses`로 한정. canonical forward
  provider는 override를 거부(chat adapter가 forwarded credential을 쓰지 않으므로).
  `apiKey`/`authMode`/`baseUrl`이 보존됨을 테스트로 고정.
- 요청 본문·토큰·계정 식별자 로깅 추가 없음 (privacy scan 통과).

### 범위 밖으로 남긴 것

- #433 이슈 제안 3·4번(`ocx account clear-cooldown` CLI, cooldown 상태 가시화) — CLI/GUI 표면
- #418 — 제보자가 provider를 비공개해 재현 경로 없음
- #417 / #241 — upstream-tracking, ocx 밖 원인
- #435 / #420 — 각각 PR #436, #430이 이미 커버
- Cursor용 Grok 토큰 비율 정확도 — 근거를 갖춘 별도 unit이 필요 (#373 참조)

### 상태

로컬 커밋만 쌓여 있다. `git push`는 사용자 승인 전까지 하지 않는다.
