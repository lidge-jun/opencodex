# 020 — WP2 SMALL-SAFE non-GUI 병합 실행 계획

## GUI-touch 실측 (2026-07-22, gh pr view --json files)

| PR | GUI 파일 | 판정 |
|---|---|---|
| #248 | 없음 (src/adapters/openai-responses.ts, src/server/responses.ts) | 병합 가능 |
| #250 | 없음 (src/adapters/openai-chat.ts) | 병합 가능 |
| #251 | 없음 (src/adapters/google-tool-schema.ts + test) | 병합 가능 |
| #230 | 없음 (src/server/responses.ts + test) | 병합 가능 |
| #232 | 없음 (src/oauth/kiro.ts) | 병합 가능 — WP2로 승격 (기존 조사에선 SMALL-SAFE) |
| #231 | **gui/src/pages/Providers.tsx** | **병합 금지** → WP4 (허락 필요) |
| #262 | 없음 (src/cli/init.ts, src/router.ts) | 병합 가능 — 감사 중 신규 발견, WP2 편입 (이슈 #257/#261 인접 UX) |

## 절차 (one-at-a-time)

각 PR: sol 적대 리뷰(priority) → PASS 시 `gh pr merge <n> --merge` → 연결 이슈 영어 코멘트+클로즈 → 다음.

순서: #248(→이슈 #234) → #250(→#228) → #251 → #230 → #232 → #262

주의(sol 감사): #248과 #230은 둘 다 src/server/responses.ts 터치 — hunk가 ~1787 vs ~631로 떨어져 있어 순차 병합 시 클린 예상, #248 병합 후 #230 mergeable 재확인.

병합 후 dev CI(ci.yml) 상태 확인. 충돌/CI 빨강 시 해당 건 BLOCKED 기록 후 다음 진행.

## 결과 (실행 후 기입)

### 2026-07-22 06:22Z 실행 결과

| PR | sol 판정 | 결과 |
|---|---|---|
| #248 | MERGE | **MERGED** 06:21:35Z → 이슈 #234 영어 코멘트+클로즈 (issuecomment-5042586099) |
| #250 | MERGE | **MERGED** 06:22:04Z → 이슈 #228 영어 코멘트+클로즈 (issuecomment-5042589546) |
| #232 | MERGE | **MERGED** 06:22:30Z |
| #262 | MERGE | **MERGED** 06:22:47Z (#257 미해결 주의 — sol note) |
| #251 | BLOCK (full CI 미실행) | CI 3 runs 승인 + 영어 리뷰 코멘트 (pull/251#issuecomment-5042599173). green 후 재평가 |
| #230 | BLOCK (false-confidence test) | CI 3 runs 승인 + 테스트 재작업 요청 영어 코멘트 (pull/230#issuecomment-5042599032) |

dev CI: merged tip 04dfc7fc Cross-platform CI in_progress (직전 c5e5b6d2 success). 중간 tip 3건은 자동 cancelled(순차 병합에 의한 supersede).
