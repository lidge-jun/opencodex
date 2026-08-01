# PR 리뷰 & 병합 전략 — 2026-07-22

## 현황

- 브랜치: `dev` (v2.7.31, 304a1eab)
- 열린 PR: 11개 (dev 대상 6, main 대상 5)
- 리뷰어: Sol 서브에이전트 (적대적 코드 리뷰) + 메인 에이전트 (통합 판단)

## PR 인벤토리

### dev 대상 (즉시 병합 가능 후보)

| # | 제목 | 저자 | 규모 | 리스크 | 1차 판정 |
|---|------|------|------|--------|----------|
| 215 | fix(responses): strip mismatched agent_message item ids | robin-main-hub | +3/-0, 2f | LOW | MERGE-READY |
| 219 | fix(winsw): detect sc.exe error 1060 under Bun truncation | Wibias | +34/-4, 2f | LOW | MERGE-READY |
| 224 | fix(adapters): forward prompt_cache_key through openai-chat | Wibias | +42/-0, 5f | LOW | MERGE-READY |
| 211 | fix(i18n): complete RU parity with dev en.ts | AnyCPU | +161/-13, 6f | LOW | MERGE-READY |
| 225 | ci: enforce issue quality for feature requests | Wibias | +453/-1, 3f | MEDIUM | MERGE-WITH-FIXES |
| 221 | fix(oauth): do not persist needsReauth across restarts | Wibias | +4434/-185, 90f | HIGH | NEEDS-REWORK |

### main 대상 (dev 경유 또는 직접)

| # | 제목 | 저자 | 규모 | 리스크 | 1차 판정 |
|---|------|------|------|--------|----------|
| 223 | fix(codex): clamp reasoning efforts to installed binary | Bricol1982 | +186/-5, 3f | MEDIUM | MERGE-WITH-FIXES |
| 220 | feat: add Gemini 3.6 Flash and 3.5 Flash-Lite | HaydernCenterpoint | +33/-3, 5f | LOW | MERGE-READY |
| 213 | fix(gui): expose private-network opt-in for presets | apple-ouyang | +13/-5, 2f | LOW | MERGE-READY |
| 214 | feat: rename combos + custom public model name | eachann1024 | +1028/-76, 24f | MEDIUM | MERGE-WITH-FIXES |
| 226 | Redesign provider setup + Codex restart | HaydernCenterpoint | +875/-198, 19f | HIGH | NEEDS-REWORK |

## 핵심 발견

### 1. #221 (needsReauth) — 범위 초과

PR 설명은 OAuth needsReauth 수정이지만, 실제 diff는 90개 파일에 devlog, GUI sidebar,
combo, cursor, google, catalog 등 무관한 변경을 포함. 이건 여러 작업이 하나의 PR에
섞인 것. needsReauth 핵심 수정(src/oauth/store.ts)은 타당하지만, 나머지 80+ 파일은
별도 PR로 분리해야 함.

**전략**: 저자에게 scope 분리 요청. needsReauth 핵심만 cherry-pick하거나,
분리 PR을 요청.

### 2. #223 (reasoning clamp) — 설계는 좋으나 base 브랜치 문제

Codex 0.133.0의 strict enum 파싱을 해결하는 clamp 로직은 정확하고, self-adapting
설계가 좋음. 다만 main 대상인데 dev의 catalog.ts와 충돌 가능성. dev에 먼저
병합하는 게 안전.

### 3. #226 (provider UI redesign) — 대형 UI 변경

875줄 추가, 19개 파일. Provider 페이지 전체 재설계 + restart 엔드포인트.
GUI 빌드/린트는 통과하지만, 기존 provider-workspace와의 상호작용을
깊이 검증해야 함. main 직접 대상이라 dev 경유가 안전.

### 4. #214 (combo alias) — 기능은 완전하나 검증 필요

combo rename + alias 기능. 1028줄, 24개 파일. 테스트 202개 통과 주장.
alias가 catalog, routing, log에 걸치는 만큼 통합 검증 필요.

### 5. #225 (issue quality CI) — 정책 판단 필요

low-quality 이슈 자동 클로즈. 기능적으로는 맞지만, 커뮤니티 정책 결정사항.
false-positive 위험 (짧지만 유효한 feature request). maintainer 판단 필요.

## 병합 전략

### Phase 1: 즉시 병합 (dev, low-risk)

순서: #215 → #219 → #224 → #211

이유: 모두 소형, 독립적, 테스트 충분, 충돌 없음.
- #215: 3줄 수정, production에서 확인된 브릭 버그 수정
- #219: Windows 서비스 감지, 기존 bug sweep(#216)의 후속
- #224: prompt_cache_key 전달, opt-in 설계로 안전
- #211: RU 빌드 깨짐 수정, dev GUI build 복구

### Phase 2: 검토 후 병합 (dev, medium-risk)

- #225: CI 워크플로우 — 정책 확인 후 병합
- #223: base를 dev로 변경 요청 후 병합 (catalog.ts 충돌 방지)

### Phase 3: 대형 PR 처리

- #221: scope 분리 요청 → needsReauth 핵심만 재제출
- #214: combo alias — dev에서 통합 테스트 후 병합
- #226: provider UI — dev 경유, 기존 workspace와 충돌 검증

### Phase 4: main 동기화

- #220 (Gemini 3.6): dev 경유 또는 main 직접 (독립적 catalog 추가)
- #213 (private network): dev 경유 (GUI 변경)

## 교차 충돌 분석

| PR 쌍 | 충돌 영역 | 심각도 |
|--------|-----------|--------|
| #221 ↔ #219 | winsw.ts (둘 다 수정) | MEDIUM — #219 먼저 |
| #221 ↔ #224 | types.ts, registry.ts | MEDIUM — #224 먼저 |
| #223 ↔ #221 | catalog.ts | HIGH — #221 분리 후 |
| #226 ↔ #213 | GUI provider 페이지 | MEDIUM — #213 먼저 |
| #214 ↔ #221 | combos/, catalog.ts | MEDIUM — #221 분리 후 |
| #211 ↔ #221 | i18n ru.ts | LOW — #211 먼저 |

## 다음 단계

1. Sol 에이전트 적대적 리뷰 결과 통합
2. Phase 1 PR들 dev에 순차 병합
3. #221 저자에게 scope 분리 코멘트
4. #223 base 브랜치 변경 요청
5. #225 정책 판단 (maintainer 결정)
