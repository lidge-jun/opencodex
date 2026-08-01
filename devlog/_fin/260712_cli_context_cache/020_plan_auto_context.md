# 020 — diff-level 플랜: auto-context (조건부 [1m] + AUTO_COMPACT_WINDOW 350k)

## Loop-spec (C2, 단일 work-phase)
- Trigger: 사용자 확정 — "if 200k 이상 [1m] 마킹, 기본 350k, GUI 조정 시 GPT 모델 경고".
- 근거 (Tier 2, 본 세션 바이너리 실측): 2.1.207 `KV()` = `min(sw(model), max(floor, env))`.
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(14 hits)·`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`(3 hits) 실존.
  env가 settings보다 우선(경고 문구 바이너리 확인). → env 하나가 모델별 min처럼 동작:
  [1m] 모델은 350k에서 컴팩션, 비마킹(200k 회계) 모델은 200k 규칙 유지.
- Goal: 400k급 GPT 라우트가 CLI에서 350k 자연 컨텍스트 + 컴팩션 생존.
- Non-goals: PCT_OVERRIDE 노출, per-model env(불가 확인), Desktop 3P(별도 브랜치).
- Verifier: tsc / bun test / gui build 게이트 + 활성화 테스트.

## 설계 결정
- 마킹 술어 `shouldMarkOneMillion(window, auto)`:
  `window >= 1M` → 항상 마킹(기존). 그 외 `auto.enabled && window > 200_000 &&
  window >= auto.compactWindow` → 마킹. 가드 이유: compactWindow보다 작은 실윈도우에
  [1m]을 붙이면 컴팩션(안전망)이 실제 한도 뒤에 서서 세션 중 400 오류.
- `autoContext` 활성 조건: `claudeCode.autoContext !== false` **AND**
  `maxContextTokens` 미설정 (rule-1 DISABLE_COMPACT 조합이 걸리면 AUTO_COMPACT_WINDOW·
  [1m] 회계 모두 무의미 — 레거시 수동 오버라이드가 이기게 둠).
- 기본값 350_000 (`autoCompactWindow` 미설정 시). 400k 실윈도우 기준 출력여유 50k.

## Diff 목록
1. `src/types.ts` — `claudeCode.autoContext?: boolean`, `autoCompactWindow?: number` + doc.
2. `src/claude/context-windows.ts` — `AUTO_COMPACT_WINDOW_DEFAULT=350_000`,
   `AUTO_CONTEXT_FLOOR=200_000`, `resolveAutoContext(cc)` (enabled+compactWindow),
   `shouldMarkOneMillion(window, auto)`, `withOneMillionMarker`에 auto 인자,
   `effectiveModelEnv` 내부에서 resolveAutoContext 사용.
3. `src/claude/model-info.ts` — `buildAnthropicModelInfos(..., auto?)`: 변형 행 술어를
   공용 술어로 교체. 표시: >=1M은 `· 1M` 유지, auto-마킹은 `· <real>k` (정직 표기,
   max_input_tokens도 real 유지 — CLI 공개빌드는 이 필드 미소비 확인).
4. `src/server/index.ts` — /v1/models anthropic flavor에서 auto 전달.
5. `src/cli/claude.ts` — `buildClaudeEnv`: auto 활성 시
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` setDefault(user-wins).
6. `src/server/system-env.ts` — injectLever + shell conditional export 동일 계약.
7. `src/server/management-api.ts` — GET: `autoContext`/`autoCompactWindow` 노출,
   PUT: boolean / positive-int-or-null 검증. effectiveModelEnv는 자동 반영.
8. GUI `ClaudeCode.tsx` — 토글+숫자 입력(placeholder 350000), 커스텀 값일 때 빨간 경고
   "GPT 모델 동작이 제대로 되지 않을 수 있음" + i18n 4로케일(en/ko/zh/de).
9. 테스트 — context-windows(술어/enabled 분기), model-info(변형/표시), cli(env 주입/
   skip/user-wins), management-api(왕복 검증).

## 게이트
bun x tsc --noEmit / bun test / gui build.
