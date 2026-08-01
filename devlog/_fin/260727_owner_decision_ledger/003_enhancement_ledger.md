# 003 — enhancement 전수 판단

대상: `enhancement` 라벨이 붙은 열린 이슈 **13건**
(`[540,476,425,415,414,401,386,294,201,178,177,95,42]`) + 라벨 없는 신규 2건
(#545, #546).

## 판단 축

enhancement에 대한 오너 결정은 세 가지 중 하나로 수렴한다:

- **ACCEPT-CYCLE**: 받아들이고 자체 사이클(P/A/B/C/D)을 배정한다
- **ACCEPT-GATED**: 받아들이되 외부 조건(업스트림 허가, 계약, 수요)이 풀릴 때까지 착수 안 함
- **DECLINE**: 명시적으로 안 한다고 밝히고 닫는다

가장 나쁜 상태는 셋 중 어느 것도 아닌 채 열려 있는 것이다. 사용자는 기다리고,
우리는 안 하고, 아무도 그 사실을 모른다.

## 원장

| # | 제목 | 라벨 | 현재 상태 | 결정 필요 지점 |
| --- | --- | --- | --- | --- |
| 42 | Storage 페이지 + 세션 정리 정책 | enhancement, roadmap | Phase 1·2 완료 (**#529 MERGED**) | Phase 2.1(복원 UI) / Phase 3(자동 정책) 착수 여부 |
| 95 | 멀티유저 프록시 + LiteLLM | enhancement, roadmap | 07-22 "long-term roadmap" 확정 | 프로젝트 사이클 배정 시점. **아래 A 참조** |
| 177 | Warp 프로바이더 | enhancement, roadmap | 07-22 roadmap 일괄 라벨 | 인증 경로 실재 여부 미조사 |
| 178 | Factory 프로바이더 | enhancement, roadmap | 07-22 roadmap 일괄 라벨 | 동일 |
| 201 | TRAE International 프로바이더 | enhancement, roadmap | 07-22 roadmap 일괄 라벨 | 본문이 "공식 인증 경로"를 명시 요구. 조사 필요 |
| 294 | Claude 계정 풀 (ChatGPT 패리티) | enhancement, roadmap | roadmap | PR #493(per-account 한도)이 선행 조각. **아래 B 참조** |
| 386 | macOS 메뉴바 컴패니언 | enhancement | 별도 워크트리 `opencodex-macos-app` 진행 중 | 릴리스 에셋 편입 시점 |
| 401 | voice chat 모델 변경 | enhancement, upstream-tracking | 업스트림 티켓 없음 | 002 참조 |
| 414 | Exa 등 검색 프로바이더 사이드카 | enhancement | 자체 제출 (#398 분할) | 착수 순서 |
| 415 | Gemini 등 자체 검색 API 사이드카 | enhancement | 자체 제출 (#398 분할) | 414와 선후 관계. **아래 C 참조** |
| 425 | Codex 계정 네임스페이스 | enhancement | PR #512가 foundation 담당 | 나머지 레이어 착수 |
| 476 | 카탈로그 변경이 running app-server 미반영 | enhancement | PR #526/#527 승계 | #527 base 수동 리타깃 (순서 의존 없음) |
| 540 | WordPress Studio Code 프로바이더 | enhancement, provider-compat, roadmap | 07-27 ACCEPT-GATED 확정 | **이미 결정 완료** — 모범 사례 |

### 라벨 없는 신규 2건

| # | 제목 | 라벨 | 현재 상태 | 결정 필요 지점 |
| --- | --- | --- | --- | --- |
| 545 | Auto Mode 권한 분류기 64토큰 절단 | **없음** | 미분류, 응답 없음 | 라벨 + 조사 착수. bug 후보 |
| 546 | Desktop 3P 모델 피커 미반영 | **없음** | 미분류, 응답 없음 | 라벨 + 문서 수정 경로 채택 여부 |

> `roadmap` 라벨 7건(`[540,294,201,178,177,95,42]`)은 아래 세 판단 축 중
> 어디에도 속하지 않는 상태다. 이 자기모순은 묶음 G에서 다룬다 —
> `001_decision_bundles.md` G, `006_corrections.md` S5.

## A — 프로바이더 요청군의 구조적 문제 (#177 / #178 / #201 / #540)

네 건은 같은 형태다: "X를 프로바이더로 추가해달라". 그런데 #540만 실제로
판단됐다. 2026-07-27 코멘트에서 공식 문서를 확인하고, OAuth 클라이언트 ID
재사용을 거부하고, "written Automattic confirmation 또는 OpenCodex 전용 OAuth
등록이 선행 조건"이라고 명시했다.

#177/#178/#201은 2026-07-22에 `roadmap` 라벨이 **일괄로** 붙었을 뿐,
#540 수준의 인증 경로 조사가 없다. 실제로 #201 본문은 커뮤니티 우회책이
"IDE 크리덴셜 추출, 사설 헤더 캡처, 미문서화 엔드포인트 호출"에 의존한다고
스스로 밝히고 있다 — #540에서 우리가 거부한 바로 그 패턴이다.

**결정 지점**: #540에서 세운 기준(공식 인증 경로 없으면 구현 안 함)을
#177/#178/#201에도 소급 적용할 것인가. 적용하면 세 건 중 일부는 DECLINE 또는
ACCEPT-GATED로 재분류된다. 적용하지 않으면 기준이 케이스마다 달라진다.

## B — Claude 계정 풀 (#294) 과 PR #493의 관계

#294는 "ChatGPT/Codex 계정 풀과 동등한 Claude 계정 풀"을 요구한다. PR #493은
그 일부인 **per-account rate limit 조회**를 이미 구현했다 — "Anthropic reports
OAuth usage per credential, so every logged-in Claude account can be probed with
its own bearer token".

즉 #294의 가장 어려운 전제(계정별 헤드룸을 알 수 있는가)가 PR #493에서 이미
풀렸다. 그런데 #493은 draft + CONFLICTING + CHANGES_REQUESTED로 멈춰 있고,
#294는 roadmap으로 대기 중이다. 둘이 연결돼 있다는 기록이 어느 쪽에도 없다.

**결정 지점**: #493을 #294 사이클의 첫 조각으로 승격할 것인가, 아니면 독립
quota 개선으로 따로 처리할 것인가.

## C — 사이드카 백엔드 확장 (#414 / #415)

둘 다 오너 본인이 #398에서 분할 제출했다. 결정 축은 **어느 쪽이 먼저인가**다.

- #414 (Exa): 전용 검색 벤더. 별도 API 키 필요 → 사용자에게 새 비용
- #415 (Gemini grounding): 사용자가 **이미 가진** 계정 재사용 → 새 비용 없음

#414 본문이 지적한 원래 문제는 "메인 모델이 non-OpenAI/Anthropic일 때 검색이
두 계정 중 하나를 빌려야 하고, 그 계정이 소진되면 검색이 degrade된다"다.
이 문제에 대해서는 #415가 더 직접적인 해답이다 — Gemini로 라우팅 중인
사용자는 이미 Gemini 계정이 있다.

**결정 지점**: #415를 먼저 할 것인가. 기록상 두 이슈는 동등한 형제로만 남아
있고 우선순위 판단이 없다.

## D — 라벨 없는 신규 이슈 2건 (#545 / #546)

2026-07-27 09:23Z 제출, 라벨 미부착, 응답 없음. 둘 다 같은 제보자(PBJ-2),
같은 환경(Desktop 3P + gateway key).

### #546 — 모델 피커 변경이 세션에 미반영

제보자가 스스로 대안을 제시했다: "대응이 어렵다면 README의 Claude Desktop
섹션에 `/model` 커맨드 안내 추가". 즉 **문서 수정만으로 닫을 수 있는 경로**가
제보자 동의 하에 열려 있다.

주의: #241(라우팅 모델이 Desktop 피커에 미표시)과 표면이 비슷하지만 다르다.
#241은 **Codex** Desktop, #546은 **Claude** Desktop 3P다. `001_issue_triage_matrix.md`가
#539에서 같은 혼동을 한 번 겪고 철회한 이력이 있으므로 여기서도 분리 유지.

### #545 — Auto Mode 권한 분류기가 64토큰에서 잘리고 5회 반복

이쪽은 정량 데이터가 강하다: `outputTokens:64`에서 502로 끊긴 요청 **1,084건**,
64 미만 정상 종료 143건, 동일 입력 연속 클러스터 232개. 도구 승인 1건당
12~22초.

`max_output_tokens` 초과로 incomplete 처리되는 경로이므로, 우리 쪽 번역
경로에서 `max_tokens`를 어떻게 전달/클램프하는지에 따라 우리 결함일 수 있다.
**enhancement가 아니라 bug일 가능성이 높다.**

**결정 지점**: 두 건의 라벨 부착과 우선순위. #545는 1,084건의 실패가 이미
쌓인 상태이므로 방치 비용이 큰 편이다.
