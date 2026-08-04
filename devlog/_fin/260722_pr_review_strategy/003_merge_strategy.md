# 실행 전략 — PR 병합 로드맵

## 원칙

- 모든 PR은 dev 경유. main 직접 병합 없음.
- dev → main 승격은 릴리스 게이트 통해서만.
- 오염된 PR(#221)은 분리 요청, superseded PR(#213)은 close.
- AI 생성 PR은 diff-level 검증 후 수용.

## 즉시 실행 (Phase 1)

### #215 — agent_message strip → dev 병합

```bash
gh pr merge 215 --squash --delete-branch
```

근거: 3줄 수정, production 브릭 버그, 테스트 충분, 충돌 없음.

### #224 — prompt_cache_key → dev 병합

```bash
gh pr merge 224 --squash --delete-branch
```

근거: opt-in 설계, 기존 parallelToolCalls 패턴 준수, 독립적.

## 단기 실행 (Phase 2)

### #211 — RU refresh → rebase 후 병합

저자 코멘트: "dev에 이미 956/956 키 패리티가 있어서 빌드 수정은
더 이상 필요 없습니다. rebase하면 wording/docs refresh만 남습니다.
retitle을 'fix(i18n): refresh RU wording + add ocx account docs'로
변경 부탁드립니다."

### #219 — winsw hardening → rebase 후 병합

저자 코멘트: "dev에 이미 1060 로컬라이즈 수정이 있습니다.
rebase하면 Buffer 디코딩 + e.message false-positive 방지만 남습니다.
retitle을 'fix(winsw): harden SCM probe against Buffer streams and
e.message false positives'로 변경 부탁드립니다."

## 중기 실행 (Phase 3)

### #223 — reasoning clamp → 수정 요청 후 dev 병합

저자 코멘트:
1. base를 dev로 변경 요청
2. 전부 unsupported ladder를 conservative fallback으로 교체 요청
3. probe 실패 시 no-op 대신 warning log 요청
4. syncCatalogModels + /v1/models 양쪽 boundary 테스트 요청

### #220 — Gemini 3.5 Flash-Lite → 분리 PR 요청

저자 코멘트: "dev에 이미 Gemini 3.6 Flash가 있습니다.
3.5 Flash-Lite만 추출해서 dev base로 별도 PR 부탁드립니다.
Antigravity wire set은 dev의 기존 라우팅을 따릅니다."

## 장기 실행 (Phase 4)

### #214 — combo alias → 재설계 요청

저자 코멘트:
1. /v1/models 일반 shape에서도 alias dedup 필요
2. RU 키 추가 (en.ts:902,941-975 대응)
3. backend aliasing/rename과 GUI 분리 검토
4. dev rebase 후 CI 재실행

### #226 — provider UI → 재설계 요청

저자 코멘트:
1. RU 로컬 키 추가
2. restart 비동기 에러 처리
3. source-string 테스트 → 렌더링 UI 테스트
4. dev 경유 필수

### #225 — issue quality CI → 수정 요청

저자 코멘트:
1. maintainer 수동 클로즈 시 bot reopen 방지 (closed_by 추적)
2. bug 타겟 제거 (feature request만)
3. 검증 로직을 테스트 가능한 스크립트로 추출

## Close/Reject

### #221 — REJECT + 분리 요청

저자 코멘트: "needsReauth 핵심 수정은 타당하지만, 90파일 브랜치가
무관한 변경(sidebar, combo, cursor, google, devlog 등)을 포함하고
있습니다. OAuth 핵심(store.ts, index.ts, anthropic.ts,
local-token-detect.ts + 관련 테스트)만 분리해서 새 PR 부탁드립니다.
또한 store.ts:291-296 unreachable code와
markAccountNeedsReauthIfGeneration의 unlocked read-then-mark
수정이 필요합니다."

### #213 — Close as resolved

저자 코멘트: "dev의 f2fa0c20에서 이미 더 안전한 구현으로
해결되었습니다. 기여 감사드리며, 이 PR은 close합니다."

## 교차 의존성 그래프

```
#215 ──→ (독립)
#224 ──→ (독립, #214/#220 전에)
#211 ──→ (#214/#226 i18n 전에)
#219 ──→ (독립)
#223 ──→ (#214 catalog 전에)
#220 ──→ (#224 registry 후에)
#214 ──→ (#223, #224, #211 후에)
#226 ──→ (#211 후에)
#225 ──→ (독립, 제품 릴리스와 분리)
#221 ──→ REJECT
#213 ──→ REJECT
```

## 검증 체크리스트

- [ ] #215 병합 후 `bun test tests/openai-responses-passthrough.test.ts`
- [ ] #224 병합 후 `bun test tests/openai-chat-hardening.test.ts`
- [ ] #211 rebase 후 `cd gui && bun run build`
- [ ] #219 rebase 후 `bun test tests/winsw.test.ts`
- [ ] #223 수정 후 `bun test tests/codex-catalog.test.ts` + e2e
- [ ] Phase 1-2 완료 후 전체 `bun run test` + `bun run typecheck`
