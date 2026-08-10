# 010 — 열린 PR 27건 처분

기준 `7132828b3`. 동결 시각 2026-07-31T05:05Z. 판정 어휘와 `MERGE-NOW` 게이트는
`000`을 따른다.

luna-max 서브에이전트 2개를 겹치지 않는 구획으로 파견하고, 결론이 무거운 행은
메인 세션이 직접 재확인했다. 재확인에서 **하나가 뒤집혔다** — 아래 #781 항목.

## 요약

| 판정 | 건수 | PR |
|---|---|---|
| `MERGE-NOW (승인 대기)` | 0 | — |
| `NEEDS-REBASE` | 6 | #797 #793 #763 #715 #707 #569 #557 |
| `NEEDS-CHANGES` | 10 | #784 #782 #780 #776 #757 #751 #747 #746 #745 #653 #644 #611 #581 |
| `DEFER` (보안 리뷰/오너 판단) | 6 | #779 #750 #744 #693 #671 #616 |
| `CLOSE` | 0 | — |
| `SUPERSEDED` | 0 | — |

**전부 base=`dev`, 위반 0건.** draft 5건(#557 #569 #644 #747 #750).

`MERGE-NOW`가 0건인 것이 이 라운드의 핵심 사실이다. 기술적으로 깨끗한 PR은 여럿
있지만, `MAINTAINERS.md:30-31`이 요구하는 **메인테이너 승인**과 **현재 dev 기준
필수 CI**를 동시에 만족하는 건 없다. 대부분은 base가 낡아서 CI 기록이 현재 dev를
반영하지 못한다.

## 감사에서 뒤집힌 것: #781

서브에이전트는 #781을 "최종 head에 순 변경 없음, 빈 참조이므로 `CLOSE`"로 보고했다.
`gh pr diff`가 보여준 첫 패치만 보고 내린 판단으로 보인다. 직접 확인한 결과:

```
git diff origin/dev...pr781  --stat
 src/adapters/anthropic.ts                  |  37 ++++++++++
 src/bridge.ts                              | 113 ++++++++++++++++++++++++++---
 structure/01_runtime.md                    |   3 +
 tests/anthropic-stream-hardening.test.ts   |  88 ++++++++++++++++++++++
 tests/responses-stream-tool-events.test.ts |  43 +++++++++++
 5 files changed, 275 insertions(+), 9 deletions(-)
```

비어 있지 않다. 그리고 내용이 중요하다 — `src/bridge.ts`에 `failCurrentToolCall()`을
추가해, 열린 tool call이 터미널 에러로 끝날 때 `function_call_arguments.done`과
`status:"completed"`를 내보내지 **않고** `status:"incomplete"`로 취소한다. 주석이
이유를 정확히 말한다:

> Closing via closeCurrentToolCall() would emit function_call_arguments.done and
> status:"completed" BEFORE response.failed — the client still sees an issued call.

직전 라운드가 #658/#765 잔여의 진짜 수정 지점이 **어댑터가 아니라 bridge**라고
결론냈던 바로 그 자리다. `CLOSE`로 넘겼으면 그 작업을 버릴 뻔했다.

이 사례의 교훈: `gh pr diff`의 출력 앞부분만 보면 여러 번 force-push된 PR의 최종
상태를 오독한다. 순 변경은 `git diff origin/dev...<head>`로 봐야 한다.

## Windows CI 적색의 세 갈래

`000`이 세운 stale-base 절차를 27건에 적용한 결과, 인프라 실패가 한 종류가 아니었다.

| 클래스 | 증상 | 해당 |
|---|---|---|
| 런처 경로 | `ENOENT ... uv_spawn 'C:\Users\runneradmin\.bun\bin\bun.exe'` | #776 #784 #782 #750 |
| Bun 런타임 패닉 | `panic(thread N): Internal assertion failure` / `oh no: Bun has crashed` | #744 #693 |
| 무관한 테스트 | storage mutation coordinator, PowerShell 프로세스 열거 | #653 #750 |

전부 PR이 건드린 표면과 무관하다. **PR 고유 결함으로 분류된 Windows 실패는 0건이다.**

Bun 패닉은 별개 문제다. 런처 커밋 두 개로 안 풀린다. 이슈가 없으므로 `030`에 올린다.

## 전체 매트릭스

### 즉시 가치가 큰 것

| PR | 결함 @HEAD | CI | 판정 | 한 가지 |
|---|---|---|---|---|
| **#779** TLS Origin skew | 살아 있음 — `auth-cors.ts:105-110`이 프로세스 유래 origin 완전 일치만 허용 | **초록** (run `30605632691`) | `DEFER` | 보안 리뷰만 남음. 인증은 `management-auth.ts:195-210`에 그대로 |
| **#780** Windows 스케줄러 stop | 부분 — stop 검증은 `2d0c6a99c`/`5530b8c63`로 랜딩. 잔여: `winsw.ts:166-169`, `service.ts:1466-1474`, `proxy-liveness.ts:128-151` | **초록** (run `30604919789`) | `NEEDS-CHANGES` | 일부 테스트가 소스 텍스트를 검사한다. 실제 respawn/PID 동작 테스트 필요 |
| **#751** Hyperbolic preset | 살아 있음 — `registry.ts:829-832`에 canonical 항목 없음 | **초록** (run `30585251466`) | `NEEDS-CHANGES` | 코드·증거·CI 모두 최상. `CHANGES_REQUESTED` 상태를 오너가 갱신하면 끝 |
| **#781** anthropic + bridge | 부분 — `anthropic.ts:253-263`이 query/hash 입력 허용, `:808-810`이 빈 tool ID 허용 | 미검증 | `NEEDS-REBASE` | **감사 정정 대상.** bridge 수정이 #658 잔여의 실제 지점 |

### 리베이스면 되는 것

| PR | 결함 @HEAD | 판정 | 한 가지 |
|---|---|---|---|
| #797 Cursor Grok 4.5 Fast wire ID | 살아 있음 — `cursor/effort-map.ts:33-36`, `discovery.ts:68-77`, `request-builder.ts:126-130`이 구형 `fast-effort` 사용 | `NEEDS-REBASE` | 리베이스 + 전체 CI. 보안 표면 없음 |
| #763 picker 라벨 | 살아 있음 — `catalog/effort.ts:112-125`가 slug 유지, `sync.ts:181-205`가 `display_name = slug` | `NEEDS-REBASE` | base가 121커밋 뒤. 리베이스 + CI |
| #793 openai-chat EOF | 부분 — pending-tool 가드는 `38f711beb`로 랜딩, answer-content EOF는 `openai-chat.ts:840-867`에서 여전히 에러 | `NEEDS-REBASE` | **오너 판단 선행**: #773이 왜 리버트됐는지 기록 없음 |
| #715 계정 풀 선택 순서 | 살아 있음 — `codex/routing.ts:691`이 eligibility 필터 결과를 그대로 반환 | `NEEDS-REBASE` | GUI 10파일 의미 충돌. 백엔드만 먼저 뗄 수 있음 |
| #707 서비스/관리 경계 하드닝 | 부분 — `management-auth.ts:122`가 primary admin token만 초기화 | `NEEDS-REBASE` | `ApiKeys.tsx`, `scripts/test.ts`, `service.ts` 의미 충돌 3건 |
| #569 readiness `/readyz` | 살아 있음 — `server/index.ts:386`에 `/healthz`만 존재 | `NEEDS-REBASE` | 충돌 4건. 보안 표면 없음 |
| #557 npm 캐시 복구 | 살아 있음 — `update/job.ts:359,367`이 원문 명령·설치 출력을 그대로 영속화 | `NEEDS-REBASE` | 256커밋 뒤. preflight/redaction 두 조각으로 분할 권장 |

### 테스트·증거가 미달인 것

| PR | 결함 @HEAD | 판정 | 빠진 것 |
|---|---|---|---|
| #745 tool schema 루트 type | 살아 있음 — `responses/parser.ts:144`가 `(t.parameters ?? {})`를 루트 `type` 없이 전달 | `NEEDS-CHANGES` | **회귀 테스트 전무.** 우리가 쓸 수 있다 |
| #782 Windows ACL opt-in | 살아 있음 — `management-auth.ts:53-60`, `:62-72`가 fail-close | `NEEDS-CHANGES` | 디렉터리 타임아웃이 `aclUnverified`에 전파 안 됨. 그 회귀 테스트 |
| #784 로그 버퍼 + 페이지네이션 | 살아 있음 — `request-log.ts:129` `MAX_LOG_SIZE = 200`, `:741-763`에 limit/offset 없음, `logs-usage-routes.ts:126-128`이 맨 배열 반환 | `NEEDS-CHANGES` | 공유 헬퍼가 배열·엔벨로프 둘 다 받아 **엔벨로프 강제에 무력**. Actions 파일 변경으로 보안 리뷰 대상 |
| #776 Alibaba China baseUrl | 살아 있음 — `registry.ts:969-972`가 international URL만 노출 | `NEEDS-CHANGES` | 날짜 있는 1차 엔드포인트 증거 + 보안 리뷰 |
| #746 Copilot Responses 라우팅 | 부분 — `registry.ts:1182-1193`에 wire-default 맵 없음, `chat-completions.ts:86-95`가 모든 Responses 경로에서 `max_output_tokens` 제거 | `NEEDS-CHANGES` | 일반 복구는 이미 `responses/core.ts:2163-2222`에 있음. 중복 제거 후 리베이스 |
| #747 DeepInfra + Novita | 살아 있음 — `registry.ts:829-833`에 둘 다 없음 | `NEEDS-CHANGES` | ToS·법인·라우팅 권한·담당자·검증 날짜 |
| #653 Baseten canonical | 부분 — `free-directory.ts:124`에 inert 행만(`0856b0cb7`) | `NEEDS-CHANGES` | 인증 `GET /v1/models` 1차 출처, ToS/법인, 담당자, 검증 날짜 |
| #611 Volcengine Ark 3종 | 부분 — `free-directory.ts:127`에 일반 Doubao 행만 | `NEEDS-CHANGES` | 1차 엔드포인트 문서. `liveModels:false`라 인증 목록 증거는 불요 |
| #581 zh-TW | 살아 있음 — `gui/src/i18n/shared.ts:9`가 6개 로케일만 | `NEEDS-CHANGES` | 키 패리티·picker 테스트 전무. `.tmp-merge-dev.sh`가 diff에 포함됨 |
| #644 Windows tray home | 부분 — 공유 리졸버는 `codex/home.ts:143`에 있는데 `tray/windows.ts:78`, `service.ts:92`가 구형 중복 | `NEEDS-CHANGES` | diff에 `.codexclaw/`·`.DS_Store` 포함. 워크플로 권한 변경 |
| #757 GPT-5.6 Pro 브라우저 provider | 살아 있음 — `registry.ts:1182-1193`에 browser provider 없음 | `NEEDS-CHANGES` | 의미 충돌 12파일. `stream:false` fail-closed 테스트 없음 |

### 보안 리뷰 대기 6건

`MAINTAINERS.md`가 명시적 보안 리뷰를 요구하는 표면을 건드리는 PR들이다.
전부 `DEFER`. 리뷰는 메인테이너 판단이고 에이전트가 대신할 수 없다.

**#779, #750, #744, #693, #671, #616.**

표면별 상세 매핑은 이 문서에 적지 않는다. `AGENTS.md`의 규칙과
`tests/repo-hygiene.test.ts`의 트립와이어에 따라, 아직 리뷰가 끝나지 않은 항목의
경계 분석은 공개 devlog에 남기지 않는다. 스크래치:
`.tmp/260731-acceptance-boundary-notes.md`.

진행에 필요한 사실만 남긴다:

- **#779**는 CI 초록이고 코드도 준비됐다. 리뷰만 남았다.
- **#744**는 `registry.ts:799`에 `liveModels:false`가 없다는 결함 확인이 끝났다.
- **#671**은 `auth-context.ts:186`에 해당 선택자가 없다.
- **#750**은 테스트가 매우 강하다. draft 해제가 필요하다.
- **#693**과 **#616**은 리뷰 대기 상태 그대로다.

## 이 매트릭스에서 나오는 것

**우리가 직접 손댈 수 있는 것**은 셋이다. 나머지는 남의 승인이나 남의 증거를 기다린다.

1. **#745의 회귀 테스트를 우리가 쓴다.** 결함은 `parser.ts:144`에 확인됐고 수정
   방향도 맞다. 없는 건 테스트뿐이고 그건 기여자를 기다릴 이유가 없다.
2. **#782의 디렉터리 상태 전파 버그.** PR 자체 결함이지 정책 문제가 아니다.
3. **#784의 무력한 테스트.** 공유 헬퍼가 두 형태를 다 받아들이는 건 직전 라운드
   #790에서 정확히 같은 실패 모드였다.

상세는 `030`.

## 동결 이후 변동 (2026-07-31T05:30Z 재확인)

`000`이 정한 대로 동결 인벤토리는 고정하고, 그 뒤 변동만 여기 적는다.

### #780이 머지됐다

`merged=2026-07-31T05:17:31Z`. 위 표에서 `NEEDS-CHANGES`로 적은 근거 — 일부 테스트가
동작이 아니라 소스 텍스트를 검사한다는 것 — 는 여전히 유효하다. 이미 들어갔으므로
판정은 무의미해졌지만, **소스 텍스트를 grep하는 테스트가 dev에 들어갔다**는 사실은
남는다. `030`의 테스트 품질 항목으로 옮긴다.

### 새 PR 3건 — 전부 배치 정책 위반

`batuchek68-ux`가 05:20~05:27Z에 3건을 열었다. 셋 다 base가 `dev`가 아니다.

| PR | base | 규모 | 성격 |
|---|---|---|---|
| #798 | `codex/260729-security-md-reporting-path` | +145/-7, 3파일 | TLS hostname mismatch와 연결 불가를 구분 (#553 관련) |
| #799 | `codex/260728-tls-altname-diagnosis` | **+41839/-2746, 376파일** | diff가 API 한도 초과 |
| #800 | **`main`** | +2583/-159, 46파일 | `devlog/_plan/260731_pr_merge_round/**` — **우리가 이미 랜딩한 문서** |

`000`의 base 게이트를 적용한다. 규칙은 "base가 `dev`가 아니면 부모 PR이 열려 있는지
먼저 본다"이다.

- #798, #799의 base 브랜치(`codex/260729-*`, `codex/260728-*`)는 **열린 PR의 head가
  아니다.** 스택 자식이 아니라 잘못된 타깃이다.
- #800은 `main`을 직접 겨냥한다. `AGENTS.md` 브랜치 정책이 명시적으로 금지하는
  형태이고, `enforce-target`이 거부해야 하는 바로 그 케이스다. 게다가 내용이
  `7132828b3`으로 이미 dev에 들어간 devlog 문서라서 실질 변경도 없다.

셋 다 `NEEDS-CHANGES (retarget to dev)`로 둔다. 내용 심사는 리타깃 후다. #798의
주제(TLS hostname mismatch 구분)는 #553과 겹치므로 `020`에서 교차 확인한다.

이 세 건이 `000`에 base 게이트를 넣은 이유를 그대로 보여준다. 감사가 그 항목을
요구했을 때는 위반 0건이었는데, 30분 만에 3건이 생겼다.
