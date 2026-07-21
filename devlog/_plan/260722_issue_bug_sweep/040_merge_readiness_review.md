# 040 — 머지-레디 검증 (6개 패치, sol 2인 리뷰 + main 교차검증)

- 날짜: 2026-07-22
- 범위: dev의 6개 구현 커밋 판정. 새 이슈/PR 제외(사용자 지시).
- 방법: sol 리뷰어 2인 병렬(클러스터별) + main이 코드로 교차검증 + 정식 전체 스위트.

## 전체 테스트 베이스라인 (결정적)

`bun run test`(= `bun test --isolate ./tests/`) → **3344 pass / 0 fail** (284 files, 78.6s).
주의: `--isolate` 없이 `bun test`를 직접 돌리면 공유 상태 오염으로 58 fail이 나오지만,
이는 실행방식 아티팩트이며 정식 스크립트로는 완전 green. tsc(`bun x tsc --noEmit`) exit 0.

## 이슈별 판정

| 이슈 | 커밋 | 머지-레디 | 근거 |
|------|------|-----------|------|
| #216 | fbd96c12 | ✅ yes | `\b1060\b` 로케일 독립 매칭이 pt-BR/Bun 증상 재현·해결, 그 외는 fail-closed 유지 |
| #199 | fbd96c12 | ✅ yes | status 36 + 로컬라이즈드 1060 처리, lifecycle 가드가 unknown/absence 안전 구분 |
| #212 | f2fa0c20 | ✅ yes | built-in preset opt-in 노출, reserved openai 제외·기본 false·metadata 차단 유지(보안 검토 통과) |
| #183 | 0d7fd985 | ✅ yes | pending-flow 엔드포인트가 공유 submitManualLoginCode에만 위임, PKCE/state·raw-import 403 게이트 불변 |
| #186 | 87be0d84 | 🟡 yes-with-nits | mid-stream reset→failed+502, cancel 무페널티, 유니언 불변 — 단 scope-drift nit |
| #179 | 87501f10 | 🟡 yes-with-nits | effort nullable+capability-aware는 실효 경로 해결; 광범위 안정성은 재현 부재로 방어적 연기 |
| #202 | 87501f10 | ❌ no (BLOCKER) | 진단 로그만 추가, 실제 증상 미해결 |
| #209 | a626a5b7 | ❌ no (BLOCKER) | stale refresh-lock 재전송 리스크 |

## 블로커 (후속 수정 사이클 필요)

### B1 — #202 Vertex: 진단만, 실제 미노출 미해결 (High)

> **해결됨 (2026-07-22, WP-fix-1)**: `catalog.ts fetchProviderModels`에서 adapter=google·googleMode=vertex·models 없음·defaultModel 있음 4조건일 때 defaultModel을 configured에 시드하고, `withVertexDefaultSeed()`로 5개 캐시 fallback(fresh/cooldown/non-2xx/malformed/thrown) + authoritative-empty 분기 모두에 보존. 회귀 테스트(defaultModel-only + 빈 캐시 fresh/stale)는 수정 전 RED. 리뷰어 2라운드(FAIL→PASS). `bun test tests/vertex-catalog.test.ts` 10 pass, tsc 0.

- 위치: `src/codex/catalog.ts:1243` — `configured`는 `prov.models ?? []`에서만 생성, `defaultModel` fallback 없음.
- 트리거: 이슈 그대로 `defaultModel`만 있고 `models` 배열이 없는 Vertex provider.
- 영향: discovery 실패 후 configured가 비어 default Gemini가 여전히 대시보드·`/v1/models`에 미노출.
- 증거: `tests/vertex-catalog.test.ts`가 `models: ["publisher-model-a"]`를 명시 → 실제 증상 미재현.
- 수정 방향: discovery 실패·models 부재 시 `defaultModel`을 configured fallback에 포함(per-provider opt-in), 또는 연기했던 정적 Vertex seed 구현. `defaultModel: "gemini-2.5-pro"`만으로 노출되는지 회귀 테스트 추가.

### B2 — #209 Anthropic: stale-lock이 소모된 회전 토큰 재전송 (High)

- 위치: `src/oauth/index.ts:320` 인접 + 락 프리미티브 `src/oauth/store.ts:79-85`.
- 트리거: Anthropic이 회전 토큰을 소모한 뒤 `mergeAccountCredential` persist 전에 프로세스 종료/120s 락 stale.
- 영향: 이후 프로세스가 stale 락 제거 후 옛 토큰 재제출 → invalid_grant로 영구 needsReauth, 이슈 재현·no-blind-replay 위반.
- 증거: refresh intent가 제거 가능한 파일 락으로만 표현, 소모/불확실 generation의 durable 기록 부재.
- 수정 방향: 교환 전 generation-bound refresh-intent 상태를 durable 기록, stale/불확실 intent는 그 generation 재전송 없이 해소(신규 Claude 자격 채택 or 복구/재로그인 요구). 크래시-창/stale-락 회귀 테스트 추가.

## Nit (비블로커)

- #186 scope-drift: `src/server/responses.ts`의 `supportedLadderFor`(combo effort, 021 소관)가 030 커밋에 혼입. 기능 회귀는 없으나 소관 커밋으로 분리 권장.

## 결론

- **머지 레디: 4/6 이슈 (#216, #199, #212, #183) + 조건부 2 (#186, #179 nits 수용 시)**.
- **머지 차단: #202, #209** — 각각 별도 후속 PABCD 수정 사이클 필요.
- 전체 스위트·tsc는 green이므로 브랜치 자체는 빌드/테스트 건전. 차단은 "해당 이슈가 실제로 닫히는가" 기준의 기능 갭.
