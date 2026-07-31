# 040 — 보류 건과 인계

이 라운드에서 태우지 않는 건들. 왜 안 태우는지와 무엇이 있어야 풀리는지를 남긴다.
"나중에 보자"로 끝내면 다음 사람이 같은 조사를 다시 한다.

## 보안 리뷰가 필요한 6건

`MAINTAINERS.md`는 인증·자격증명·OAuth·Actions·릴리스 자동화·의존성 설치를
건드리는 변경에 **명시적 보안 리뷰**를 요구한다. 리뷰는 메인테이너 판단이지
에이전트가 대신할 수 있는 게 아니다. 그래서 분석만 남기고 브랜치에 안 올린다.

### #782 — Windows admin token ACL opt-in (#766 부분)

`OPENCODEX_ALLOW_UNVERIFIED_ADMIN_TOKEN_ACL`을 켜면 타임아웃으로 인한 NTFS ACL
검증 실패를 통과시킨다(`management-auth.ts:56-89`). 지금 HEAD는 모든 ACL 실패에
fail-close한다.

위협 모델: opt-in을 켜야만 열린다. 권한 없는 로컬 프로세스가 특권 Windows 서비스의
환경변수를 바꿀 수는 없다. 다만 다중 사용자 호스트에서 디렉터리/파일 ACL이 실제로
약한 상태로 이걸 켜면, 다른 로컬 사용자가 토큰 파일을 읽거나 재시작 전에 바꿔치기해
관리 API 전체를 얻는다. 네트워크 공격자는 여전히 토큰이 필요하다.

**리뷰 전에 고쳐야 할 버그**: 디렉터리 하드닝이 soft continue할 수 있는데
(`management-auth.ts:61-65`) 그 결과가 버려진다. `aclUnverified`를 세우는 건 파일
하드닝뿐이라(`:77-89`), 디렉터리 경계가 미검증인데
`/api/settings`가 `false`를 보고할 수 있다(`config-routes.ts:119`).
`assertSafeDirectory`가 상태를 반환하게 하고 파일 쪽 상태와 OR로 합쳐야 한다.
지금 테스트는 파일 타임아웃만 덮는다(`tests/server-management-auth.test.ts:445`).

### #779 — TLS 종단 Origin scheme skew (#760)

`https` Origin과 프로세스가 관측한 `http`의 차이를, 호스트가 같고 포트가 같거나
`443→80`일 때만 허용한다(`auth-cors.ts:92-144`).

분석상 인증 우회는 없다. `requireManagementAuth`가 먼저 돌고(`index.ts:391`)
토큰 경로는 constant-time 비교 뒤에만 통과한다(`management-auth.ts:195`).
세션 경로는 여전히 request/claimed/browser origin 완전 일치와 CSRF를 요구한다
(`:205`). 넓히는 건 문서화된 TLS 종단 형태의 CORS 수용이지 미인증 수용이 아니다.

그래도 CORS 수용 범위 변경이라 리뷰 대상이다. 준비된 상태로 대기.

### #775 — Ollama private-network discovery (#758)

registry/private-network 권한을 중앙화해 discovery 전송에 전달한다. 지금은
config 검증에서만 존중되고(`destination-policy.ts:133-140`) 아웃바운드 discovery는
`provider.allowPrivateNetwork`만 본다(`provider-outbound.ts:104-137`).

SSRF/destination policy 작업이다. 리뷰와 함께, built-in 기본값이 여전히
metadata/link-local/unspecified 목적지를 거부한다는 전송 계층 회귀 테스트를 요구한다.

### #778 — doctor의 provider API key 진단 (#762 부분)

provider와 환경변수 **이름만** 표시한다. 값은 안 찍는다. 그래도 자격증명 취급이라
리뷰 대상이다. 그리고 현재 프로세스만 검사하고 실행 중인 프록시의 해석 결과는
확인하지 않는데, 그 사실이 출력에 안 드러난다. "이 프로세스 기준, 서비스 프로세스는
미검증"을 명시하게 고쳐야 #762가 온전히 닫힌다.

### #693 — A6API 크레딧 사용량

Bearer 키를 새 목적지 2곳으로 보낸다. 자격증명 목적지 변경이므로 하드 게이트다.
테스트는 좋다 — canonical 호스트에만 키를 보내는지, `redirect: "error"`,
깨진 페이로드, 캐시 키 회전, stale 행 억제까지 216줄로 덮는다.

### #616 — hosted image tool 설정 보존

`src/server/auth-cors.ts:289-357`의 management validation과 요청 도구 디스패치를
바꾼다. 819줄. 깨끗하게 붙지만 리뷰 대상이다.

### #744 — Antigravity 카탈로그 static 고정 (#723)

원래 배치 A에 넣었다가 감사에서 되돌렸다. "카탈로그를 static으로 고정"이라는
요약이 실제 변경 범위를 가렸다. 커밋 `59d95c0e4`와 `39543a3c0`이 OAuth 재조정,
provider 설정 영속화, 토큰 해석 순서(static 분기 앞뒤)를 바꾼다.

결함은 진짜다: `src/providers/registry.ts:799`에 static 플래그가 없어서 지원하지
않는 `GET /models`를 프로브하고 영구 discovery 실패를 보고한다. 테스트도 좋다.
리뷰만 통과하면 다음 라운드 1순위다. import 충돌 해소 방법은 `020`에 남겨뒀다.

### #750 — Codex 계정 풀 plan 영속화 (#724)

HEAD는 `freshPlan`을 읽고도(`src/codex/auth-api.ts:456-470`) 저장된 계정 그대로
DTO를 만든다(`:541-550`). 결함은 남아 있다. 테스트가 특히 좋다 — 동시 refresh의
토큰 회전 공유, 삭제 후 재생성된 계정, 교체 자격증명 격리까지 덮는다.
자격증명·토큰 생성 경합·계정 상태 영속화를 건드리므로 하드 게이트. draft 상태.

### #746 — GitHub Copilot Responses 라우팅 (#748)

모델별 wire default 맵을 들이고 Responses 전용 모델 계열을 `openai-responses`로
해석한다. OAuth 갱신과 키 풀 복구 경로를 바꾼다. 이슈 #748은 이미 닫혔지만
수정은 HEAD에 없다. 리베이스 + 보안 리뷰 + 신규 CI.

### #644 — Windows tray가 활성 Codex home을 따라가게

draft. 두 가지가 걸린다. 첫째, `.github/workflows/pr-labeler.yml`과
`.github/scripts/pr-labeler.test.cjs`를 바꾼다 — Actions 변경은 보안 리뷰 대상이다.
둘째, diff에 `.codexclaw/goalplans/**`(에이전트 상태 파일)와 `devlog/.DS_Store`,
`devlog/_plan/.DS_Store`가 들어 있다. 저장소 위생 문제라 그대로는 못 받는다.
기여자에게 그 파일들을 빼달라고 요청해야 한다.

## provider preset — 증거 미달 5건

`MAINTAINERS.md`의 canonical preset 증거 요건: 문서화된 OpenAI 호환 엔드포인트
(`liveModels`를 선언하면 인증된 `GET /v1/models` 포함), ToS와 운영 법인,
중개업체면 재판매·라우팅 권한, 지명된 유지보수 담당자, 인용 가능한 검증 날짜.

| PR | 위치 | 빠진 것 |
|---|---|---|
| #751 Hyperbolic | canonical, `liveModels: true` | **없음.** 증거표가 완비돼 있다. 남은 건 그 표보다 앞선 CHANGES_REQUESTED 리뷰를 메인테이너가 갱신하는 것뿐 |
| #747 DeepInfra + Novita | canonical ×2, `liveModels` | ToS/법인, 두 중개업체의 라우팅 권한, 담당자, 검증 날짜 |
| #653 Baseten Model APIs | canonical, `liveModels` | 엔드포인트·인증 모델목록의 날짜 있는 1차 출처, ToS/법인, 담당자, 보안 승인 |
| #611 Volcengine Ark | canonical ×3, `liveModels: false` | 1차 엔드포인트 문서, ToS/법인, 번들된 서드파티 모델의 라우팅 권한, 담당자, 검증 날짜 |
| #776 Alibaba China Coding Plan | 기존 provider에 baseUrl 선택지 추가 | 새 자격증명 목적지다. 1차 출처와 보안 리뷰 필요. registry의 Alibaba 데이터에는 아직 "docs unverified" 표시가 있다(`registry.ts:969-972`) |

#751은 사실상 통과 상태다. 오너가 리뷰만 갱신하면 다음 라운드에서 태울 수 있다.

## 자체 사이클이 필요한 대형 건 7건

분량이 아니라 블라스트 반경과 리뷰 표면 때문이다.

- **#757** GPT-5.6 Pro 라우팅, 40파일 +1553. 브라우저 자동화 provider를 새로
  들인다. 로그인된 세션 사용, 프로세스 제어, 도구 스키마, 과금 의미까지 걸린다.
- **#581** zh-TW 로케일, 59파일 +5813. i18n 키 패리티가 엄격한 표면이고
  docs 라우팅에 `zh-tw`가 전역 추가된다. CHANGES_REQUESTED 상태.
- **#715** 계정 풀 선택 순서, 62파일 47커밋. pin/preemption 상태와 HEAD의 GUI
  hydration/polling 제어를 **하나의 동작으로** 화해시켜야 한다. hunk 단위로
  고를 수 있는 충돌이 아니다.
- **#707** 외부 기여자의 서비스/관리 경계 하드닝, 88파일 +7928. 보안 경계 작업이다.
  랜딩 전에: 리베이스, 명시적 위협 모델, 작성자가 아닌 메인테이너의 보안 리뷰,
  ACL/토큰 초기화 실패가 관리 접근을 열지 않는다는 **부정 테스트**, 그리고 신규 CI.
- **#671** exact account routing, 21파일. 풀 밸런싱을 의도적으로 우회하고
  cooldown 계정에 fail-close한다(`auth-context.ts:202-278`). 자격증명-모델 라우팅
  변경이다.
- **#569** readiness 계약(`/readyz`, `ocx ready --wait`), draft.
- **#557** npm 캐시 복구, draft, 256커밋 뒤. 의존성 설치/프로세스/경로 신뢰 경계
  재작성이다. #737이 이걸 대체하지 않는다 — #737은 `src/update/job.ts` 86줄뿐이다.

## 개별 판단

- **#745** — tool schema 루트에 `type: "object"`를 채우는 정규화. 방향은 맞고
  결함도 남아 있다(`src/responses/parser.ts:137-151`). 그런데 **회귀 테스트가
  없다.** 기존 테스트는 `{}`를 쓰지만 정규화된 출력을 검증하지 않는다.
  다음 라운드에서 우리가 테스트를 쓰고 태운다.
- **#763** — picker 라벨에 native 모델 이름 우선. 코드도 테스트도 괜찮다
  (`tests/codex-catalog.test.ts`에 collision 케이스가 있다). 필수 CI 기록이 없다.
  restack + CI면 통과.
- **#793** — #773을 되살린다. #773은 머지됐다가 #792로 리버트됐는데 **왜
  리버트됐는지 기록이 없다.** #792 본문은 "Reverts #773" 한 줄이고 논의도 없다.
  이유를 모르는 채로 같은 걸 되돌리는 건 안 된다. 오너 판단이 필요하다.
  별개로 실제 결함도 있다: pending tool call을 스냅샷한 뒤 truncation 에러를
  반환하기 **전에** `tool_call_end`를 내보낸다(`refs/prs/793:src/adapters/openai-chat.ts:807-821`).
  잘린 tool call에 완료 이벤트가 안 나가는지 확인하는 테스트가 없다.

## 열린 PR 전체 대조

감사가 세 건 누락을 잡았다(#750, #746, #644). 지금은 `gh pr list`가 반환하는
43건 전부에 처분이 달려 있다. 다음 라운드에서 이 문서를 이어받을 때는
`gh pr list --state open`을 다시 돌려 새로 열린 PR부터 확인할 것.

## 이슈 상태

랜딩 전까지 열어두는 것: #572, #759, #765, #764, #766, #758, #762, #756,
#748, #724, #719, #690, #658, #657, #656, #650, #586, #570, #561, #553,
#545, #540, #425, #418, #417, #415, #414, #386, #241, #201, #178, #177,
#95, #92.

upstream-tracking(#417, #241, #92, #418)은 오래됐다고 닫지 않는다. 추적 목적이
살아 있고 업스트림이 미해결이다.
