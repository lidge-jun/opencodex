# 020 — 이슈 처분 (WP2)

`010_live_snapshot.md` §5의 대조 결과를 실제 GitHub 상태 변경으로 옮긴다.

## 원칙

클로즈는 **머지된 커밋 + 그 동작을 고정하는 테스트**가 둘 다 있을 때만.
"고쳐졌을 것 같다"는 클로즈 사유가 아니다. 나머지는 현재 상태 코멘트만 남기고
열어 둔다 — 침묵보다 낫고, 오판 클로즈보다 훨씬 낫다.

## A. 클로즈 후보 → **오너 판단으로 이관** (A 게이트 정정)

### #570 Port-remapped tunnels rejected by the loopback Host check

근거 체인:

| 항목 | 값 |
| --- | --- |
| 수정 커밋 | `e2da6f6df` fix(server): treat forwarded loopback ports as loopback |
| 머지 커밋 | `3a2b2ea8c` Merge pull request #573 |
| 브랜치 | `origin/dev` 포함 확인 (`git branch --contains e2da6f6df`) |
| 코드 | `src/server/auth-cors.ts:37-52` — 포트 비교 제거, hostname만 신뢰 경계 |
| 테스트 | `tests/server-loopback-host-gate.test.ts:16-26` |

테스트가 고정하는 것: `localhost:20100`, `127.0.0.1:20100`, `[::1]:20100`이 전부
loopback으로 통과하고, 비루프백 hostname은 여전히 거부된다.

### 왜 닫지 않는가 — A 게이트 블로커 1 (High)

#570은 단일 결함 리포트가 아니라 **6항목 하드닝 계획**이다. 머지된 것은 항목
1(a)과 항목 2뿐이다.

| 항목 | 상태 |
| --- | --- |
| 1(a) Host를 Origin과 정렬 | **머지됨** (`e2da6f6df`) |
| 1(b) `trustedRequestHosts` 허용목록 | 미착수 — 설계 결정 |
| 1(c) 루프백 바인드 인증 opt-in | 미착수 — 설계 결정 |
| 2 회귀 테스트 | **머지됨** |
| 3 base URL 보고 (`api-access.ts:72-75`, `api-keys-utils.ts:18-24`) | 미착수 |
| 4 hostname alias (`myhost.lan`) | **여전히 403** — `auth-cors.ts:51`이 hostname만 보고 alias는 loopback이 아님 |
| 5 docs "Remote access" SSH 레시피 | 미착수 |
| 6 터널 위 OAuth (`CALLBACK_PORT = 1455`) | 미착수 |

리포터가 측정한 `ALIAS | Host=myhost.lan:56030 -> 403`은 지금도 재현된다.
게다가 `src/server/auth-cors.ts`는 CODEOWNERS 인증 경계이고 항목 4는 이슈 본문이
"Decide explicitly whether ... are in scope"라고 적은 **오너 결정**이다.

→ 처분: 상태 코멘트만 남기고 **열어 둔다**. 클로즈 여부는 `NEEDS_HUMAN`.

코멘트 골자 (영문, 리뷰 언어 규칙):

- 항목 1(a)/2가 `e2da6f6df` (PR #573)로 머지됐고 `origin/dev`에 있다
- 바뀐 predicate와 이유 (포트는 신뢰 경계가 아니다), 회귀 테스트 파일:라인
- 항목 3/4/5/6은 미해결이며 alias 케이스는 여전히 403이라는 점을 명시
- 잔여 항목을 별도 이슈로 쪼갤지, 이 이슈를 열어 둘지는 메인테이너 결정

## B. 상태 코멘트만 — 클로즈하지 않음

| 이슈 | 코멘트 내용 | 클로즈 안 하는 이유 |
| --- | --- | --- |
| #606 | PR #610이 프로브 **재사용/메모이제이션**을 고친다 (cacheKey 도출 순서는 저자가 의도적으로 유지 — PR 본문 "I left the ordering alone to keep this change minimal"). 측정된 개선: warm 6300ms → ~25ms | 수정 미머지 |
| #608 | `src/service.ts:1080` + `taskXmlString()` 이스케이프 불일치를 근본 원인으로 확인, 결정 불요 수정으로 분류 | 수정 미작성 |
| #612 | `src/lib/windows-secret-acl.ts:79` 동기 spawnSync 확인, tmp 경로 키잉 문제도 재현 | 수정 미작성 |
| #586 | PATCH `/api/providers?name=openai`는 존재(`provider-routes.ts:137-167`), GUI 컨트롤만 부재 | GUI 설계 결정 필요 |
| ~~#591~~ | **코멘트하지 않음** — Ingwannu가 이미 ccswitch 충돌 부정 + 정보 요청 코멘트를 남겼고 `needs-info` 라벨도 있다. 리포터는 관리자 권한 설치에 이미 성공했다고 답했으므로 "관리자로 재시도" 안내는 틀린 조언이다 | 중복 코멘트 회피 |
| #553 | PR #575(OPEN, MERGEABLE/CLEAN)는 오류 **귀속**만 개선한다 — 연결 불가와 TLS hostname 불일치를 구분해 보여줄 뿐, `ERR_TLS_CERT_ALTNAME_INVALID` 자체는 그대로다. #575가 머지돼도 이 이슈는 닫히지 않는다 | 머지 대기 + 잔여 결함 |

## C. 손대지 않음

`#604`(리포터 캡처 대기), `#543` `#418`(리포터 대기), `#545`(오너 판정),
`#92` `#241` `#417` `#462`(업스트림). 이미 각 이슈에 최신 트리아지 코멘트가 있다.

## 검증

`gh issue view 570 --json state,closedAt` 및 각 코멘트 URL 회수.
