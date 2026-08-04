# Sol 적대적 리뷰 종합 — 2026-07-22

리뷰어: Sol (gpt-5.6-sol, high effort) — `gh pr diff` 기반 실제 diff 검증
메인 에이전트: 코드베이스 교차 검증 (rg 기반 현재 상태 확인)

## 판정 변경 (초기 → 최종)

| # | 초기 판정 | Sol 판정 | 최종 판정 | 변경 사유 |
|---|-----------|----------|-----------|-----------|
| 215 | MERGE-READY | MERGE-READY | **MERGE-READY** | 일치 |
| 224 | MERGE-READY | MERGE-READY | **MERGE-READY** | 일치 |
| 219 | MERGE-READY | MERGE-WITH-FIXES | **MERGE-WITH-FIXES** | dev에 이미 1060 수정 있음, Buffer/message hardening만 유용 |
| 211 | MERGE-READY | MERGE-WITH-FIXES | **MERGE-WITH-FIXES** | dev에 이미 956/956 키 패리티, wording/docs refresh만 남음 |
| 213 | MERGE-READY | REJECT | **REJECT** | dev의 f2fa0c20이 이미 더 안전한 구현으로 해결 |
| 220 | MERGE-READY | NEEDS-REWORK | **NEEDS-REWORK** | dev에 이미 Gemini 3.6 있음, 3.5 Flash-Lite만 유용 |
| 223 | MERGE-WITH-FIXES | MERGE-WITH-FIXES | **MERGE-WITH-FIXES** | 접근은 타당하나 unsafe fallback + no-op on probe failure |
| 225 | MERGE-WITH-FIXES | NEEDS-REWORK | **NEEDS-REWORK** | maintainer 수동 클로즈를 bot이 reopen하는 결함 |
| 214 | MERGE-WITH-FIXES | NEEDS-REWORK | **NEEDS-REWORK** | /v1/models alias 중복, RU 키 누락 |
| 226 | NEEDS-REWORK | NEEDS-REWORK | **NEEDS-REWORK** | RU 패리티, restart 비동기 에러, source-string-only 테스트 |
| 221 | NEEDS-REWORK | REJECT | **REJECT** | 90파일 오염 브랜치, unreachable code, generation race |

## Sol 핵심 발견 (메인 검증 포함)

### #221 REJECT — 오염된 브랜치

Sol: 29커밋/90파일. OAuth 핵심에 unreachable code(store.ts:291-296),
markAccountNeedsReauthIfGeneration의 unlocked read-then-mark(:433-441).
테스트가 fresh process 시뮬레이션 없음.

메인 검증: `rg needsReauth src/oauth/store.ts`로 disk persistence 확인.
90파일 중 needsReauth 관련 ~10개, 나머지 80+는 무관한 변경.
**판정 동의: REJECT. 분리 PR 요청.**

### #213 REJECT — 이미 해결됨

Sol: 현재 dev의 `AddProviderModal.tsx:478-486`이 이미 체크박스 노출.
f2fa0c20에서 더 안전하게 구현됨.

메인 검증: bug sweep devlog(003_rca_n_allow_private_network.md)에서
이미 수정 완료된 이슈. **판정 동의: REJECT (close as resolved).**

### #220 NEEDS-REWORK — 부분 중복

Sol: 현재 dev registry.ts:641-654에 이미 Gemini 3.6 있음.
3.5 Flash-Lite만 유용한 delta.

**판정 동의: 3.5 Flash-Lite만 추출해서 별도 PR.**

### #225 NEEDS-REWORK — 재오픈 결함

Sol: enforce-issue-quality.yml:422-435에서 bot marker 기반으로만
reopen 판단. maintainer가 수동으로 닫은 이슈도 bot이 다시 열 수 있음.
또한 :54-57에서 bug도 타겟함 (설명과 다름).

**판정 동의: 수동 클로즈 오너십 추적 필요.**

### #223 MERGE-WITH-FIXES — unsafe fallback

Sol: clamp 로직은 타당하나, 전부 unsupported인 ladder를 그대로 보존하고
probe 실패 시 no-op. codex debug models --bundled는 실제 존재 확인.

메인 검증: `rg clampCatalogModels src/codex/catalog.ts` → 미구현 확인.
ensureUltraReasoningLevel은 존재. **판정 동의: safe fallback 추가 필요.**

### #214 NEEDS-REWORK — /v1/models 중복

Sol: alias collision handling이 catalog shape(client_version)에서만 작동.
일반 /v1/models는 중복 ID 발행 가능. RU 키 누락.

**판정 동의: 양쪽 model-list shape 모두 dedup 필요.**

## 최종 병합 전략 (수정)

### Phase 1: 즉시 병합 (dev)

1. **#215** — agent_message strip (3줄, 독립적)
2. **#224** — prompt_cache_key 전달 (opt-in, 독립적)

### Phase 2: rebase 후 병합 (dev)

3. **#211** — RU wording/docs refresh (rebase + retitle)
4. **#219** — Buffer/message hardening (rebase, 기존 1060 수정 위)

### Phase 3: 수정 후 병합

5. **#223** — safe fallback 추가 후 dev에 병합 (base 변경)
6. **#220** — 3.5 Flash-Lite만 추출, 별도 PR

### Phase 4: 재설계 필요

7. **#214** — /v1/models dedup + RU + backend/GUI 분리
8. **#226** — RU + restart 에러 처리 + dev 경유
9. **#225** — 수동 클로즈 오너십 + 테스트

### Close/Reject

10. **#221** — REJECT, 분리 PR 요청
11. **#213** — REJECT, f2fa0c20으로 이미 해결

## AI 생성 PR 플래그

| PR | 생성 표시 | 품질 | 판단 |
|----|-----------|------|------|
| #221 | 강한 AI 미리뷰 징후 | 낮음 | REJECT |
| #223 | Claude Code 명시 | 중간 | 수정 후 수용 |
| #226 | source-string-only 테스트 | 중간 | 재설계 필요 |
| #215 | Claude Code 명시 | 높음 | 소형+독립 검증, 수용 |
