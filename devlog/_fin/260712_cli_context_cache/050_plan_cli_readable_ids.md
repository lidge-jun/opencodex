# 050 — diff-level 플랜: CLI 표면 bare/가독형 id + Desktop 해시 별칭 모듈 격리

## Loop-spec (C2, 단일 work-phase, HITL)
- Trigger: 사용자 확정 — "desktop 계열 모듈 완전 분리, CLI는 완전 bare로".
- 근거 (전부 본 세션 Tier 2 실측):
  - effort는 id 모양과 무관 (opus해시/claude-ocx/bare 3종 모두 `output_config.effort` 탑재).
  - 픽커 필터 `/^(claude|anthropic)/i` (2.1.207 바이너리) → 진짜 bare(`gpt-5.6-sol`)는
    디스커버리에 못 실림. CLI의 "bare"는 가독형 `claude-ocx-*` + 수동 `--model` bare 병행.
  - CLI 디스커버리 fetch UA는 `claude-code/<version>` (n_() 바이너리 확인).
- Goal: /v1/models가 표면별 id를 서빙 — CLI(claude-code UA 또는 ?ids=cli)는
  `claude-ocx-<provider>--<model>` / `claude-ocx-native--<slug>`, Desktop(기타 UA 또는
  ?ids=desktop)은 기존 `claude-opus-4-8-<code>` 해시. anthropic canonical은 양쪽 passthrough.
- Non-goals: desktop-3p.ts 내부 변경(레지스트리/디코드 그대로), 픽커 필터 우회 시도,
  기존 저장된 id 마이그레이션(양 계열 모두 계속 디코드됨 — 호환 유지).
- Verifier: tsc / bun test / gui build + 라이브 /v1/models?ids=cli 대조.

## Diff 목록
1. `src/claude/model-info.ts` — `AnthropicIdStyle = "desktop3p" | "readable"` 파라미터.
   readable: native→aliasForNative, routed→(anthropic claude-* passthrough) ?? aliasForRoute,
   표현 불가(null) 행은 스킵하지 말고 desktop3p 해시로 폴백(모델 누락 금지).
   [1m] 변형/auto-context 술어는 스타일 무관 동일.
2. `src/server/index.ts` — /v1/models anthropic flavor에서
   `ids=cli|desktop` 쿼리 우선, 없으면 UA `/^claude-code\//i` → readable, 기타 → desktop3p.
   Desktop3p 레지스트리 빌드는 계속 무조건(양 계열 디코드 유지).
3. `src/claude/gateway-cache.ts` — 프록시 fetch에 `?ids=cli` 명시(UA 오탐 무관 결정적).
4. `src/server/management-api.ts` — GET /api/claude-code `aliases`를 readable 스타일로
   (Claude 페이지는 CLI 표면 안내). contextWindows는 이미 양 계열 키 등록 — 불변.
5. 테스트 — model-info 스타일 분기(readable/폴백/anthropic passthrough/[1m] 변형 id),
   디스커버리 UA·쿼리 분기, gateway-cache가 readable id를 기록.
6. docs en/ko/zh — CLI 픽커 id가 `claude-ocx-*`로 보임 + `--model gpt-5.6-sol` bare 지원 명시.

## 게이트
bun x tsc --noEmit / bun test / gui build / 라이브 스모크(픽커 캐시 재기록 후 readable 행 확인).
