# 001 — 오픈 이슈 전수 인벤토리 (2026-07-22)

수집 방법: `gh issue list --state open --limit 100 --json number,title,labels,author` +
버그성 후보 10건은 `gh issue view <n> --json body,comments`로 본문·코멘트 직접 열람.
총 **18건 오픈** (2026-07-22 KST 기준).

## 버그성 (10건) — 본 유닛 조사 대상

| # | 제목 | 라벨 | 분류 근거 | 클러스터 |
|---|------|------|-----------|----------|
| 216 | Windows(non-EN/Bun): `probeScmRegistration`이 ERROR_SERVICE_DOES_NOT_EXIST(1060) 미탐지 → `ocx service`/`ocx update` abort | — | pt-BR 로케일에서 `sc.exe` 1060을 `unknown`으로 분류, 설치 거부. 명확한 오동작 | W |
| 199 | localized Windows `sc.exe` 1060이 WinSW service conflict로 오분류 | — | ko 로케일 + Bun exit 36(=1060&0xff) 미인식. #216과 동일 함수 계열 | W |
| 212 | built-in cloud preset add 흐름이 fake-IP DNS에서 private-network opt-in을 숨김 | — | `AddProviderModal.tsx`가 `(isCustom \|\| isLocal)`일 때만 opt-in 렌더 → 정상 클라우드 preset이 벤치마크 대역 오탐 시 탈출구 없음 | N |
| 175 | localhost provider 경고가 `allowPrivateNetwork` 옵션을 안내하지만 대시보드에 미노출 | bug | **dev에서 이미 해결됨**: 커밋 109b7672가 GUI(custom/local 토글, `AddProviderModal.tsx:478-482`), API PATCH(`src/server/management-api.ts:668-671`), CLI(`src/cli/provider.ts:146` `--allow-private-network`)를 모두 노출. 이슈 본문·코멘트의 "부재" 주장은 구버전(2.7.27) 기준. 잔여 패치 대상 아님 — close 후보로 추적만 | N (resolved-in-dev) |
| 209 | Windows 재부팅 후 Anthropic OAuth 계정 needsReauth + 모델 소실 | — | refresh token이 지속되어야 하는데 재부팅마다 재로그인 필요. 지속성/갱신 경로 버그 | O |
| 183 | codex-auth 계정 추가 모달에 리다이렉트 URL/코드 수동 붙여넣기 입력창 누락 | — | 백엔드 `onManualCodeInput`은 provider/codex 공통 지원인데 GUI codex-auth 모달만 입력창 누락 — 헤드리스 환경 로그인 불가. 기능 요청 형식이지만 실질은 GUI 갭 버그 | O |
| 202 | Google Vertex AI 모델이 Models 대시보드·`/v1/models`에 미노출 | bug | `ocx models`는 인식하는데 레지스트리/API 출력에서 누락 — 일관성 버그 | R |
| 179 | Cursor effort 미지원 모델에 대시보드가 effort 강제 → 모델 파손 | — | 안정성 개선 + capability-aware effort. 제목은 개선이지만 "effort 강제로 요청 파손"은 버그 성격 | R |
| 186 | 대화 첫 502 이후 같은 세션에서 502 빈발 | bug | #194/#195/#205 랜딩 후에도 계정풀 round-robin 5세션 테스트에서 잔존 보고(코멘트 실측) — 재검증 필요 | S |
| 92 | V2 cross-provider sub-agent가 NEW_TASK 본문을 encrypted_content로 소실 | — | maintainer 코멘트가 "root cause is client-side(Codex CLI)"로 판정, 프록시는 Fernet ciphertext 복호화 불가(`src/server/responses.ts:350-365` ciphertext 보존, `src/responses/parser.ts:192-194` opaque 생략). 007에서 ours/upstream 책임 경계 판정 — 로컬 완화가 증명될 때만 패치 계획(031) 포함 | V (conditional) |

## 기능성/개선 (8건) — 본 유닛 범위 밖

| # | 제목 | 비고 |
|---|------|------|
| 210 | thinking/reasoning을 비-Codex Responses API 클라이언트에 opt-in 노출 | feature |
| 208 | api 섹션에 chat/completions 호환 기능 추가 | enhancement 라벨 |
| 206 | Russian 로컬라이제이션 추가 | d55b2215로 ru GUI 랜딩됨 — 잔여 범위 확인은 별건 |
| 201 | TRAE International provider 추가 | 신규 provider |
| 178 | Factory provider 추가 | 신규 provider |
| 177 | Warp provider 추가 | 신규 provider |
| 95 | 다중 사용자 proxy + LiteLLM 통합 | 아키텍처 제안 |
| 42 | Storage page (세션 사용량/정리 정책) | 기존 유닛 `500_storage-page-session-cleanup` 존재 |

## 경계 판단 노트

- **179**: 제목은 "improve stability"지만 본문 핵심은 "미지원 모델에 effort 강제 시 파손" — 버그로 분류. 안정성 일반 개선 부분은 패치 계획에서 최소 범위로 다룬다.
- **183**: 요청 형식이지만 backend는 이미 지원하는 기능의 GUI 표면 누락이므로 갭 버그로 분류.
- **92**: 코멘트 진단상 근본 원인은 upstream(Codex CLI)이 우세하다. RCA(007)에서 "우리쪽/사용자쪽/upstream" 책임 경계를 명시하고, 프록시측 완화가 증명되지 않으면 031은 명시적 no-patch/upstream-tracking 결론 문서가 된다.
- **175**: 리뷰어 검증(2026-07-22)으로 dev 트리에서 GUI/PATCH/CLI 3면 모두 해결 확인. N 클러스터의 실제 잔여 갭은 #212(built-in preset 흐름의 opt-in 미노출)뿐이다.
- **206**: ru 로컬라이제이션은 dev에 이미 커밋(d55b2215, ec9ad21b)되어 있어 사실상 처리 중 — 버그 아님.

## 상태 검증

- 위 표는 2026-07-22 `gh issue list` 실측이며 전건 `state=open`.
- 186 관련 선행 PR: #194(soft-avoid affinity), #195(GUI logs persist), #205(semantic terminal status rework) — 모두 dev에 merge됨 (`git log`: e8a48a60, 477f6dd1, 51a27c18, 0b8e81d8 확인). 잔존 증상은 006에서 현재 코드 기준으로 재조사.
- 175 관련 선행 커밋: 109b7672 (GUI/API/CLI allowPrivateNetwork opt-in) — dev에 존재 확인.
