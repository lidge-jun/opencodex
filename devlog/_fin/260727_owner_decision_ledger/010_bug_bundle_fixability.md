# 010 — 버그 묶음 해결가능성 판정

측정: 2026-07-28, `origin/dev` = `461de3961`
범위: `bug` 라벨이 붙은 **열린 PR 6건 + 열린 이슈 7건**
방법: 두 개의 read-only 판정 워커 병렬 + 주요 주장 직접 재확인

## 한눈에

| 구분 | 총 | 우리가 지금 할 수 있음 | 보안 리뷰 필요 | 의존/차단 |
| --- | --- | --- | --- | --- |
| PR | 6 | **1** (#527) | 3 (#557, #447, #429) | 2 (#533, #528) |
| 이슈 | 7 | **2** (#553, #545 — 부분) | 0 | 5 |

**즉답: 지금 당장 우리 손으로 진행 가능한 건 3건이다** — PR #527, 이슈 #553,
이슈 #545. 여기에 #557은 코드 작업이 0이고 보안 경계 판단만 남았으므로,
오너가 그 판단을 내리면 즉시 4건이 된다.

## PR 6건

### 착지 가능 — 1건

**#527** `WE-CAN-LAND` · 규모 M
base가 `codex/catalog-written-signal`이라 target 검사가 설계상 실패한다. 다만
**리타깃만으로는 안 된다** — 이 PR의 두 커밋 중 `1ba588eff`는 이미 dev에
`9dd3c42da`로 들어갔다. 그 중복이 DIRTY의 원인이다.

충돌은 `tests/codex-refresh.test.ts`, `tests/injection-model-api.test.ts` 두
파일뿐이고 나머지 19개 파일(i18n 6개 로케일, `src/codex/*`, `src/cli/*`, 문서)은
자동 병합된다. 오너 본인 작성이라 기여자 의존이 없고 보안 경계 파일도 없다.

할 일: dev 위로 리베이스하며 이미 반영된 커밋을 버리고, 두 테스트 파일을
dev의 `9dd3c42da` 쪽으로 정리한 뒤 base를 dev로 바꾸고 CI 재실행.

### 보안 경계 — 3건

**#557** `NEEDS-SECURITY-REVIEW` · 규모 S · **코드 작업 없음**
미해결 리뷰 스레드 0건, 전체 매트릭스 초록(head `b0434ea5`: ubuntu/macos/windows
+ npm-global 3종 + react-doctor 전부 SUCCESS). 기술적으로 남은 게 없다.

그런데 diff가 자기 업데이트 설치 경로를 소유한다 — `src/update/install-process.mjs`
(npm install 수행), `src/update/npm-cache-preflight.mjs`(accessSync R/W/X 게이트),
`src/update/job.ts`(`sanitizeUpdateJobState` — 영속 로그에서 홈/캐시 경로와
uid/gid 제거), `src/config.ts`, `bin/ocx.mjs`. AGENTS.md 기준 "의존성 설치" +
크리덴셜 인접 로그 편집이다. 작성자 본인이 PR 본문에서 설치 실패 시 복구 정책을
메인테이너 판단으로 남겨뒀고 자동 머지 금지를 명시했다.

**즉, 이건 "고칠 게 남은 PR"이 아니라 "오너가 경계 판단만 내리면 되는 PR"이다.**

**#447** `NEEDS-SECURITY-REVIEW` · 규모 M
`src/oauth/kiro.ts`, `kiro-credentials.ts`, `index.ts`, `store.ts`, `types.ts` —
인증 경계 정중앙. 기계적으로는 기여자 PR 중 가장 건강하다(MERGEABLE/CLEAN,
체크 전부 초록, 07-27 재리뷰에서 이전 차단 2건 해소 확인).

남은 4건은 설계급이다: P1 하나(`kiro.ts:369`가 env 크리덴셜에 빈 계정 마커를
강제해 `KIRO_REGION`이 무시되고 갱신이 us-east-1로 잘못 감), P2 셋(상위 스토어
캡처 실패 후 폴백 스냅샷 수용, `saveConfig` 실패 시 크리덴셜 롤백 없음, stale
복구 마커 삭제의 동시성 미직렬화). 넷 다 **살아있는 크리덴셜 저장소가 파괴되거나
잘못된 계정이 활성화되는** 지점을 다룬다.

**#429** `NEEDS-SECURITY-REVIEW` · 규모 M
가장 작은 diff(+48/-37, 5파일)인데 **가장 적용이 안 된다**. #402의 dual-alias
계약보다 앞선 PR이라, dev가 지금 쓰고 있는 심볼을 지운다 —
`CODEX_SHELL_COMMAND_TOOL`, `CODEX_SHELL_BRIDGE_TOOL_NAMES`,
`CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA`. `tool-definitions.ts` 한 파일에만
**live 참조 11곳**(직접 확인). 07-25 merge-base 이후 cursor 경로에 커밋 10개가
들어와 충돌이 텍스트가 아니라 구조적이다 — 리베이스가 아니라 재구현이다.

더해서 빈 `exec_command` 거부 가드는 모델이 낸 인자가 셸 실행 도구로 넘어가는
지점에 검증을 추가한다. 오너가 이미 그 근거로 공개 보류한 PR이다.

### 의존 차단 — 2건

**#533** `BLOCKED-BY-DEPENDENCY` · #557이 대체
파일 목록 23개가 #557과 동일하다. 조상 관계가 아니라 **더 새 dev 위에 리베이스된
별도 작업**이고, #533에 없는 두 수정(preflight 권한 게이트, job 상태 살균)을
#557이 갖고 있다. #533은 Windows 테스트 2건이 실제로 실패했고 크로스플랫폼
매트릭스를 돈 적이 없다. 지금 #533을 넣으면 알려진 Windows 결함이 나간다.

처리: #557을 넣고 #533은 WZBbiao 크레딧과 인수 경위를 남기며 닫는다.

**#528** `BLOCKED-BY-DEPENDENCY` · 규모 L
#424(Grok 이미지 브리지)가 아직 안 들어갔는데 그 위에 얹은 P2 후속이다. 미해결
리뷰 19건으로 6건 중 최다이고 P1이 5건 — 이미지 다운로드 DNS 미고정,
`destination-policy.ts:235`의 비전역 IPv6 수용, 턴당 유료 이미지 호출 상한 부재,
이미지 루프에서 `provider.fetch` 전송 누락, `core.ts:1634`에서 미지원 웹검색
경로로 runTurn 어댑터 유입. SSRF 계열이 섞여 있다.

참고: windows-latest 실패는 이 PR 탓이 아니다 — 같은 테스트가 dev 자체 실행에서도
동일하게 실패하는 선재 flake다.

## 이슈 7건

### 부분 해결 가능 — 2건

**#553** GitHub Copilot 502 / TLS 호스트명 불일치 · `FIXABLE-PARTIAL`
우리 URL 구성은 옳다 — `src/oauth/github-copilot.ts:136`이 `*.githubcopilot.com`을
허용하므로 신고된 호스트는 정상이다. 진짜 원인은 리포터 환경의 TLS/DNS(가로채기,
VPN, 프록시)일 가능성이 높고 그건 우리 것이 아니다.

**우리가 할 수 있는 것**: 지금 `Provider unreachable:` 문자열이
`src/server/responses/core.ts`의 세 지점(1197, 1746, 1788)에서 똑같이 나온다.
`ERR_TLS_CERT_ALTNAME_INVALID`를 따로 분기해 DNS/VPN/TLS 가로채기를 지목하고
`openssl s_client` 복구 명령을 주면, 지금처럼 "어댑터 URL 버그"로 읽히지 않는다.
사용자 대면 오류가 정확한 복구 명령을 담아야 한다는 우리 원칙에 정확히 맞는 일이다.

**#545** Claude Desktop 3P Auto Mode 분류기 재시도 · `FIXABLE-PARTIAL`
`src/adapters/anthropic.ts:616-621`에서 OAuth 경로일 때 `CLAUDE_CODE_SYSTEM_INSTRUCTION`을
**무조건** 맨 앞에 넣는다(직접 확인). 인바운드 system이 이미 Claude Code 정체성을
갖고 있는지 검사하지 않으므로, `skipSystemPromptPrefix`로 온 분류기 요청조차
요청하지 않은 system 블록을 하나 더 받는다. 중복 방지 가드는 실제로 범위가
분명한 수정이다.

다만 리포터의 나머지 두 주장은 **성립하지 않는다**(워커가 왕복 추적):
`max_tokens`→`max_output_tokens`(`src/claude/inbound.ts:435`),
`stop_sequences`→`stop`(`:440`), `thinking.type:"disabled"`(`:479`) 모두 보존된다.
"effort 손실"은 클라이언트가 thinking을 끈 결과지 번역 손실이 아니다.
그리고 Part C는 이미 고쳐져 머지됐다(`7fcaa9119`).

### 정보 대기 — 2건

**#543** Kiro opus-5 mid-turn 큐 무시 · `BLOCKED-NEEDS-INFO`
같은 프록시·같은 클라이언트·같은 세션에서 `kiro/claude-opus-4.8`은 steer를 정상
전달한다. 이 대조가 "번역기가 항상 떨군다"를 배제한다. 필요한 건 opus-5의
인바운드 `POST /v1/messages` 본문에 steer 텍스트가 있었는지 하나뿐이고, 대체
수단이 없다 — 우리는 HTTP 본문만 보지 Claude Code의 로컬 JSONL을 못 본다.

다만 잠재 결함 하나는 확인됐다: `src/claude/inbound.ts:281`의 `default: break`가
인식 못 하는 user content-block 타입을 **조용히 버린다**. 캡처가 "있는데 미지의
블록으로 왔다"로 나오면 즉시 FIXABLE-NOW가 된다.

**#418** V2 custom-parent→child 위임 실패 · `BLOCKED-NEEDS-INFO`
**#92와 다른 버그다**(중복 아님을 코드 경로로 확인). #418은 자식이 생기기 전
부모 인자 검증에서 실패하고, #92는 자식 쪽 암호문 가드에서 막힌다. 리포터의
대조 트레이스가 우리 어댑터의 일반적 인자 손실을 이미 배제했고(같은 2.7.39에서
224/451/468바이트 인자가 온전히 통과), 계측은 실패 실행 이후에 설치돼 해당 런의
기록이 없다.

### 업스트림 차단 — 3건

**#92** V2 교차 프로바이더 서브에이전트가 `NEW_TASK` 본문 상실
Codex 클라이언트가 본문을 네이티브 백엔드용 Fernet 암호문으로 만든다. 라우팅된
프로바이더는 그 키가 없으므로 **복호가 원리적으로 불가능**하다. 우리 쪽 완화는
이미 다 들어가 있다 — `encrypted-payload.ts:262`의 살균(진짜 암호문은 바이트
단위로 보존), `core.ts:998`의 fail-fast(빈 프롬프트를 보내지 않고 먼저 실패).

**#241** 라우팅 모델이 Desktop 모델 피커에 안 뜸
우리 카탈로그 쪽은 검증됐다 — app-server의 `model/list`와 `codex debug models`가
13개 라우팅 항목을 전부 반환한다. 거르는 주체는 그 **뒤의 Desktop 렌더러**이고,
우리 프록시는 거기 닿지 않는다.

**#417** 한국어 실시간 음성 U+FFFD
`openai/codex#35161` 여전히 OPEN(07-24 갱신). 릴레이 투명성은 입증됐고
포렌식 훅(`OCX_LIVE_FRAME_LOG`)도 이미 있다. 오너 본인이 연 추적 이슈다.

## 권고 순서 (실행 미승인)

1. **#557 경계 판단** — 코드 0, 판단만. 끝나면 #533도 같이 정리된다 (2건 소진)
2. **#527 리베이스+리타깃** — 순수 기계 작업, 기여자 의존 없음
3. **#553 TLS 오류 분기** — 작고 사용자 체감이 크다
4. **#545 중복 prepend 가드** — 범위 분명

#447·#429·#528은 보안 리뷰나 선행 PR이 먼저다. #92·#241·#417은 우리가 닫을 수
없고, #543·#418은 리포터 캡처를 기다린다.

## 감사 이력

2026-07-28, `mind_bug_triage_issues` + `mind_bug_triage_prs` 병렬 1회.
직접 재확인한 것: #557 체크 상태와 파일 목록, #429의 live 참조 11곳,
#527의 base 브랜치와 `9dd3c42da` 선행 머지, #545의 무조건 prepend 코드,
`origin/dev` = `461de3961`.
