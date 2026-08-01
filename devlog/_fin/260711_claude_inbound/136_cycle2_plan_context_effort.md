# 136 — 사이클 2 플랜: Desktop 컨텍스트 윈도우 + 추론 강도 제어

## 사용자 실측 확정 (2026-07-12 02:0x)
- 모델명/별칭 전면 반영 완료: `claude-opus-4-8-{code}` 별칭이 Desktop 피커에 전부 표시되고
  요청이 올바른 라우팅 모델로 도달한다 (사이클 1 성과).
- **남은 레버는 정확히 두 개**: (1) 컨텍스트 윈도우 — Desktop이 전부 200k로 취급,
  (2) 추론 강도 — effort UI가 opus 매칭에 의해서만 뜨고 우리 광고(capabilities)는 무시됨.
- **추가 단서 (02:2x)**: Anthropic 모델로 들어간 요청은 claude→ocx→claude 전 경로에서
  추론강도가 전부 동작했다. 라이브 로그에서도 opus 형태 별칭(luna)에 high/xhigh가 wire까지
  도달함을 확인 — **opus 형태 id는 effort 직렬화가 이미 된다**. 따라서 effort의 잔여 문제는
  "opus 매칭이 안 되는 실제 anthropic 비-opus id"뿐이고(정상 동작), 핵심 미해결은 컨텍스트.
  → B6의 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`는 기본 주입 불필요, opt-in으로 강등 (감사 #4와 합치).

## 근거 요약 (135 상세, 전부 Tier 2)
- CLI 공식 명세: /v1/models에서 id/display_name만 소비 → **capabilities 광고(B4b)는 무효**
  (무해하므로 존치하되 효과 기대 금지).
- Desktop effort/컨텍스트는 id 내장 카탈로그 매칭이 지배. 1M의 유일한 문서화된 제어점은
  **정적 `inferenceModels[].supports1m`** ("capability assertion").
- CCR 실전 패턴: configLibrary에 **정적 목록(supports1m 포함) + `modelDiscoveryEnabled:true`
  병기**. 비-Claude 모델은 `claude-ccr-h{hex}`로 위장 (우리와 동일 발상).
- CLI 전용 env 레버(공식 문서): `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`(custom id에 effort 전송),
  `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`(custom id 컨텍스트 override),
  인식된 claude id는 `DISABLE_COMPACT=1` 병행 필요 (R2 #3 교정: CLAUDE_CODE_ 접두 없음).
  `[1m]` suffix → `anthropic-beta: context-1m-2025-08-07` 변환은 클라이언트가 수행.
- 반례 경계: Desktop 200k 고정 보고(#55504)가 있어 supports1m가 accounting까지 뚫는지 미확정.

## 미확정 (ChatGPT Pro 백그라운드 질의 중 — 137)
- Desktop 프로세스가 CLAUDE_CODE_* env를 읽는지 (같은 코어 내장).
- 정적+discovery 병기 시 병합 규칙.
- supports1m 선택 시 wire에 실리는 것([1m] vs beta 헤더)과 실제 accounting 상승 여부.
- opus 매칭으로 뜬 effort 선택값이 게이트웨이 모델에도 output_config.effort로 직렬화되는지
  (이건 B1 캡처 링으로도 실측 가능 — 사용자 슬라이더 실험).

## 계획 (diff-level) — Pro 답변 불요 부분부터

> A-라운드 1 (Gibbs, FAIL, 블로커 8) 합성 반영판. 처분 표는 139.

### B5 — Desktop config: CCR 패턴으로 전환 (정적 목록 + discovery 병기 + supports1m)
- `src/claude/desktop-3p.ts`:
  - **(감사 #6)** `Desktop3pConfigMode = "hybrid" | "discovery" | "static"` 3값으로 명시.
    기본 "hybrid": `modelDiscoveryEnabled: true` **그리고** `inferenceModels` 둘 다 기록
    (CCR 실전 패턴). CLI 플래그 `--discovery-only` / `--static` 상호배타 — 동시 입력 시
    에러 종료, 미지 플래그는 에러.
  - `Desktop3pModelEntry`에 `supports1m?: true` 추가: **(감사 #1)** routed DTO를
    `{provider, id, contextWindow?}`로 확장해 `fetchAllModels()`의 authoritative
    `CatalogModel.contextWindow`를 소실 없이 전달(호출자 2곳: src/cli/index.ts 시작부/desktop
    명령, src/server/index.ts /v1/models 분기 — registry 빌더 시그니처 공유). `contextWindow
    >= 1_000_000`일 때만 supports1m (추측 금지; cursor luna/sol/terra/glm/gemini 1M 실보고 확인).
- `src/cli/index.ts`: 상호배타 인자 파서 + 안내 문구.
- 활성화 시나리오 (모드별 4분기): (i) hybrid — inferenceModels+discovery 공존 + 1M 모델만
  supports1m + 비-1M 필드 부재, (ii) discovery-only — inferenceModels 부재, (iii) static —
  discovery false + 목록 존재, (iv) 플래그 충돌 — 에러. 각각 테스트 1건.

### B6 — 컨텍스트/effort env 레버 (opt-in)
- **(감사 #4 + 사용자 단서)** effort는 opus 형태 별칭에서 이미 wire 도달 확인 →
  `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`는 기본 주입하지 않는다. config
  `claudeCode.alwaysEnableEffort?: boolean`(기본 false, opt-in)일 때만 런처 env에 주입.
- **(감사 #4 방어)** 인바운드 안전판: `src/server/claude-messages.ts` 라우티드 경로에서
  **(R2 #2 계약 고정)** `supportedLadderFor(route)`(src/server/effort-policy.ts, registry/config
  기반)가 **`[]`(확정적 무-effort)를 반환할 때만** `internalBody.reasoning` 제거. `undefined`
  (unknown)는 통과 — opt-in 사용자의 의도 존중, 오탐 제거 금지. live catalog 조회는 추가하지
  않는다(요청 경로 비용).
  활성화 시나리오: (i) ladder [] 라우트 → reasoning 제거 단언, (ii) unknown 라우트 → 보존 단언.
- **(감사 #5)** config `claudeCode.maxContextTokens?: number` 신설. 설정 시 런처 env에
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<값>` **과 `DISABLE_COMPACT=1`을 함께** 주입
  (공식 변수명 교정: `DISABLE_COMPACT`, CLAUDE_CODE_ 접두 아님. opus 형태 별칭은
  "recognized claude id"로 취급될 개연성이 높아 쌍 주입이 필요). GUI/문서에 compaction
  상실 경고 명시. 기본 미설정. 적용 여부는 라이브 스모크로 게이트(사용자 /context 확인).
- **(감사 #2)** maxContextTokens/alwaysEnableEffort의 전체 왕복 명시: `src/types.ts`
  OcxClaudeCodeConfig 필드 → management-api GET(/api/claude-code 반환) + PUT(양의 정수 검증,
  0/음수/비수치 400, 빈 값 clear) → `gui/src/pages/ClaudeCode.tsx` state/저장 + i18n 4로케일 →
  회귀 테스트(tests/claude-management-api.test.ts).
- **(감사 #3 + R2 #1)** systemEnv 경로 하드닝: 신규 키 주입 전 `launchctlGetenv`로 기존 사용자
  값 존재 시 해당 키 스킵(user-wins), `injectedKeys`에는 실제 주입한 키만 기록, shell env
  파일도 스킵된 키는 미기록. **추가로 shell env 파일의 신규 키 export는 조건부 형식**
  (`[ -z "${VAR+x}" ] && export VAR=...`)으로 작성해 launchctl에 없고 shell에만 있던 사용자
  값도 덮지 않는다. 회귀 테스트: revert가 선존 키를 지우지 않음 + 조건부 export 형식 단언.
- **(감사 #7 + R2 #4/#5) 활성화 매트릭스**: (a) 런처 env — 기본(미주입)/opt-in(주입)/사용자
  선존값 존중 3분기, (b) systemEnv — 주입/스킵(user-wins)/revert 보존/조건부 export 4분기,
  (c) management API — maxContextTokens 정상/0/음수/clear 4분기 + alwaysEnableEffort
  true/false 왕복 + 비boolean 400, (d) GUI 저장 왕복, (e) reasoning 제거 — ladder []/unknown
  2분기, (f) CLI 파서 — hybrid/discovery-only/static/충돌/**미지 플래그** 5분기.

### B7 — (Pro 답변 게이트) Desktop 앱 env/플래그 주입
- Pro가 Desktop 프로세스의 env/managed-settings 소비를 확정하면: `ocx claude desktop`이
  안내 또는 주입 경로 추가. 확정 전 코드 변경 없음.

## 기록 예약 (감사 #8)
- 138: Pro 답변 수신 기록, 139: 사이클 2 감사 합성, 140: 사이클 2 B/C 기록.

## 게이트
`bun x tsc --noEmit` / `bun test` / `cd gui && bun run build` / docs 변경 시 docs-site build.

## 스코프
- IN: B5, B6 (+ B7은 Pro 확정 후), 테스트, i18n, devlog.
- OUT: Desktop 앱 바이너리 수정/asar 패치, 미확정 supports1m 의미론에 의존하는 UI 약속.
