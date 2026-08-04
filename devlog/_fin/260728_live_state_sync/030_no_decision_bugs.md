# 030 — 오너 결정 없이 고칠 수 있는 버그 (WP3)

"결정 불요"의 정의: 동작이 무엇이어야 하는지에 이견이 없고, 수정 범위가 국소적이며,
CODEOWNERS 보안 경계 밖이고, 회귀 테스트를 쓸 수 있는 것. 셋 중 하나라도 어긋나면
오너 판단 항목으로 분류한다.

## 판정 기준표

| 축 | 통과 조건 |
| --- | --- |
| 기대 동작 | 명세·주석·기존 테스트가 정답을 이미 규정 |
| 범위 | 단일 모듈, 공개 계약 변경 없음 |
| 경계 | `.github/CODEOWNERS` 보호 경로가 아니고, `MAINTAINERS.md`의 주제별 보안 리뷰 대상(인증·크리덴셜 처리·GitHub Actions·릴리스 자동화·의존성 설치)도 아님 |
| 검증 | 분기를 실제로 발화시키는 테스트 작성 가능 (C-ACTIVATION-GROUNDING-01) |

## 결정 불요 — 1건 (A 게이트에서 3 → 1로 축소)

### 1. #608 Windows scheduler task가 영구 stale로 보고됨

| 항목 | 값 |
| --- | --- |
| 원인 | `src/service.ts:1080` — 등록 XML을 `taskXmlString()`으로 이스케이프한 문자열과 `includes()` 비교. `taskXmlString`(`:886`)은 `"`를 `&quot;`로 바꾸지만 Task Scheduler 내보내기는 리터럴 `"`를 준다 |
| 기대 동작 | 이견 없음. 등록한 값과 같으면 healthy |
| 범위 | `src/service.ts` 단일 함수. `taskXmlOptionalValueEquals`(#432 수정)와 같은 층 |
| 경계 | CODEOWNERS 밖 |
| 수정 | `<Arguments>` 텍스트를 XML 언이스케이프한 뒤 비교하는 헬퍼 추가 (`&quot;`/`&amp;`/`&lt;`/`&gt;`/`&apos;` 역변환) |
| 활성화 증거 | 이스케이프된 XML과 canonical XML 둘 다 healthy=true, 실제로 다른 launcher 경로면 false |
| 영향 | stale 래치 → `viable=false` → 스케줄러 백엔드 포기. 사용자가 재설치로 못 고침 |

## 결정 필요 — 오너 몫

### #612 Windows ACL 하드닝이 이벤트 루프를 막음 — `NEEDS_HUMAN` (A 게이트 블로커 3)

원인 분석 자체는 유효하다: `src/lib/windows-secret-acl.ts:79`의 `Bun.spawnSync`가
`hardenSecretPath`(`:311`) → `atomicWriteFile` 경로에서 동기 실행되고, 타임아웃
캐시가 매번 달라지는 임시 파일명으로 키잉된다.

그런데 결정 불요가 아니다:

- `hardenSecretPath`는 크리덴셜 파일 보호 장치다. `MAINTAINERS.md`가 "Authentication,
  credential handling ... require explicit security review"라고 규정한 주제에 정확히
  해당한다. 경로 글로브만 보고 CODEOWNERS 밖이라 판정한 것이 오류였다.
- 초안이 제안한 "캐시 키를 대상 디렉터리로 완화"는 이슈 본문이 명시적으로 거부한
  방향이다: 부모 디렉터리가 더 넓은 ACE를 허용할 수 있어 파일 단위 하드닝을 건너뛰면
  안 된다고 리포터가 적었다.
- 리포터가 제안한 안전한 방향(비동기 ACL 러너 + single-flight 큐 + 종료 시 flush)은
  네 단계짜리 설계 변경이다.

→ 수정 자체는 가치가 있으나 착수 전에 보안 리뷰 결정이 필요하다.

### #606 — 중복 구현 금지, PR #610 리뷰가 정답

`src/codex/catalog/bundled.ts:146-170`에서 cacheKey가 프로브 결과로 만들어지는
구조는 사실이다. 다만 PR #610이 고치는 것은 그 **순서**가 아니라 프로브 메모이제이션이다
(저자 본문: "I left the ordering alone to keep this change minimal"). 저자가 순서
변경을 후속 제안으로 따로 적어 두었으므로, 우리가 별도 수정을 얹는 것은 충돌만 만든다.

### 그 밖에 오너 결정이 필요한 항목

| 이슈 | 필요한 결정 |
| --- | --- |
| #586 | Providers 페이지에 모드 전환 UI를 넣을지 / Codex Auth 배너를 컨트롤로 승격할지 — GUI 정보구조 결정 |
| #545 | Anthropic OAuth identity 블록 처리 — 메인테이너가 이미 "안전한 수정 아님" 판정 |
| #604 | Cursor Auto 루프 — 재현 환경 확보 + 어댑터 정책 결정 |
| #591 | 관리자 권한 설치는 이미 성공. 그 이후 실패 원인 미상 — 리포터 응답 대기 |
| #553 | PR #575 머지 여부 (진단 메시지 정책) |
| #570 | 항목 1(a)/2만 머지됨. alias(항목 4)·base URL(항목 3)·터널 OAuth(항목 6)는 미해결이고 인증 경계 결정 |

## 보안 경계 확인

경계 판정은 두 축으로 한다. `.github/CODEOWNERS`의 **경로 글로브**와
`MAINTAINERS.md`의 **주제별 보안 리뷰 규정**(인증·크리덴셜 처리·GitHub Actions·
릴리스 자동화·의존성 설치). 경로만 보면 놓친다 — #612가 그 사례였다.

| 항목 | 경로 경계 | 주제 경계 | 결론 |
| --- | --- | --- | --- |
| #608 `src/service.ts` | 밖 | 밖 (Task Scheduler XML 비교) | 결정 불요 |
| #612 `src/lib/windows-secret-acl.ts` | 밖 | **안** (크리덴셜 파일 보호) | NEEDS_HUMAN |
| #570 `src/server/auth-cors.ts` | **안** | **안** | NEEDS_HUMAN |
