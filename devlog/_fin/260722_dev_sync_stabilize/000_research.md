# 260722 dev 원격 동기화 + 안정화 조사 (docs-first)

## 배경

메인테이너 팀(Wibias, Ingwannu, Lami)이 커뮤니티 PR을 대량 처리했다. 로컬 dev(c5e5b6d2)는
origin/dev 대비 21커밋 behind였고, `git pull --ff-only`로 3a5f984d에 동기화 완료(로컬 유일
커밋들은 이미 원격에 머지되어 있어 ahead 없음).

## 원격 신규 커밋 (897bdcca..3a5f984d, 21커밋)

| 커밋 | PR | 내용 | 위험도 |
|------|----|------|--------|
| 2aa4430c | — | auth/provider 이슈 일괄 해결: anthropic adaptive max_tokens 리사이즈 + stop_reason→incomplete 플럼빙(bridge.ts), oauth alias, expireCodexAuthFlow(null)→모든 pending 만료, CLI `account alias` | 높음 (가장 큼, 42파일) |
| afce7cf6 | #230 | combo child에서 content-encoding/length 제거 | 중간 |
| fdacd146 | — | 머지 후 안정화: buildComboChildHeaders 리팩터, ja.ts 45줄 추가, 테스트 수정 | 중간 |
| c3517cee | #258 | config 마이그레이션 backup 존재 시 크래시 대신 교체 | 중간 |
| a1fdbdc2 | #244 | 일본어 로컬라이즈 (gui ja.ts 984줄 + docs-site ja 전체) | 중간 (키 싱크) |
| 4d61025e | #231 | GUI Accounts 탭 API-key 행 제거 (Providers.tsx) | 낮음 (#259와 충돌 가능성 점검) |
| 07d7b919 | #229 | issue intake CI + wrong-branch 리타겟 핑 | 낮음 |
| 897bdcca/#235 | OpenRouter provider routing (신규 파일 + 테스트) | 중간 |
| 86f887a8/#251 | google-tool-schema required dedupe | 낮음 |
| 38f3789a/#250 | Kimi root object type 정규화 (openai-chat.ts, api.kimi.com 한정) | 중간 |
| ad51994e/#248 | v1 compact reasoning sanitize (responses.ts) | 중간 |
| b99bc416/#232 | Kiro OAuth resolve-before-paste | 중간 |
| 04dfc7fc/#262 | ocx init openai passthrough 유지 (#261) | 중간 |
| 3a5f984d/#264 | MAINTAINERS.md + CODEOWNERS 문서화 | 없음 |

닫힌(머지 안 된) PR: #260, #254, #243, #237, #233, #226, #225, #223, #221, #220.
열린 PR: #256(anthropic adaptive max_tokens — 2aa4430c와 겹침 주의), #255, #249, #247, #238.

## 원격 CI 상태

- Cross-platform CI: fdacd146에서 success (3a5f984d는 docs-only라 이전 그린 유효 여부 확인 필요).
- Issue quality tests: 07d7b919 success.
- service-lifecycle.yml: preview 브랜치에서만 최근 실행(success), dev 트리거 조건 확인 필요.

## 검증 계획

1. sol 적대 리뷰 (Meitner 서브에이전트): 8개 공격 각도 — adaptive max_tokens 회귀,
   expireCodexAuthFlow(null) 동시성, 스키마 정규화 이중 적용, combo 헤더 리팩터 충실성,
   ja 키 싱크, config backup 데이터 손실, openrouter 누수, 로컬 머지 클로버.
2. bun test --isolate tests (릴리즈 게이트) — 백그라운드 실행 중.
3. tsc / build 그린 확인.
4. 결함 발견 시 dev 위에 pathspec 스코프 수정 커밋.
5. preview(42커밋 diff)/main(49커밋 diff) 머지 readiness 판정 보고.
