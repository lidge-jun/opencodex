# 010 — diff-level 플랜: CLI 컨텍스트·캐싱·티어슬롯 하드닝 (P, 감사 R1 반영판)

## Loop-spec (C3, 단일 work-phase)
- Archetype: spec-satisfaction. Trigger: CLI 200k 고정 + 캐시 저적중(사용자 실측).
- Goal: 1M 라우트의 자연 컨텍스트 + 서브에이전트 티어 라우팅 + count_tokens/캐시 정밀화.
- Non-goals: Desktop 3P 신규(claudedesktop), GPT-5.6+ breakpoint 변환, MAX_CONTEXT auto env.
- Verifier: tsc/test/gui/docs 게이트 + 활성화 테스트 + 사용자 라이브 스모크(피커→캡처).
- Stop: 게이트 green+커밋 / 3회 동일실패 시 재계획. B1→B2→B3/B4→B5 의존 순서(단일 사이클 내
  서브태스크 — 다중 work-phase 로드맵 아님, 감사 #5는 loop-spec 명시+예약번호 정정으로 처분).
- Memory artifact: 본 유닛 문서(000-012, 090) + goalplan ledger. Terminal outcomes:
  DONE(게이트+커밋) / NEEDS_HUMAN(라이브 스모크만 잔존) / BLOCKED([1m] id 픽커 거부 시 B1
  축소 기록). Escalation: 상향 — 동일 게이트 3회 실패 시 P 재계획; 하향 — 조사/검증만
  위임, 코드 변경은 메인 소유. 유닛 경로는 레포 컨벤션(날짜 최상위, 기존 유닛 15+개 동형)
  준수 — `_plan/`은 이 레포에서 로드맵 초안 전용 (R2#4 부분 반박 + 헤더 보완 수용).

근거: 001/002 (전부 Tier 2). 스코프: claudecode 브랜치, CLI 표면. Desktop 신규 기능 OUT.

## B1 — `[1m]` 픽커 변형 (1M 자연 컨텍스트, 핵심)
- `src/claude/model-info.ts` `buildAnthropicModelInfos`: **(감사 #1) native 포함** —
  native는 `nativeOpenAiContextWindow(slug)`, routed는 `m.contextWindow`가 >=1M이면
  두 번째 항목 `{ id: \`${alias}[1m]\`, display_name: \`... · 1M\` }` 추가
  (capabilities 재사용, max_input_tokens=1M). **(감사 #11)** variant id도 동일 `seen`
  dedupe 집합 통과 + base id에 이미 `[1m]` 포함 시 variant 미생성. 충돌 테스트 추가.
- 디코드: `resolveInboundModel`의 기존 [1m] 스트립(738)이 별칭 해석 전에 이미 동작 —
  추가 코드 불필요. 활성화: `resolveInboundModel("<alias>[1m]") === route` 단언 테스트.
- 활성화 시나리오: /v1/models 응답에 1M 모델만 [1m] 행 존재 + 비-1M 부재 단언;
  [1m] id로 /v1/messages 요청 → 올바른 라우팅(기존 endpoint 테스트 확장).
  **(R2#6)** [1m] 스트립→라우트 단언 두 별칭 계열 각각: `claude-ocx-*[1m]`(순수 디코드) /
  `claude-opus-4-8-*[1m]`(buildDesktop3pRegistry 선행) 2테스트.
- **(감사 #6) 라이브 E2E 게이트(C, HOTL 사용자 확인)**: 2.1.207 실물에서 픽커에 [1m] 행
  표시 → 선택 → /context 1M 표시 + 프록시 로그에 정상 라우팅 캡처. 픽커가 대괄호 id를
  거부하면 B1은 실험 실패로 기록하고 대안(슬롯 [1m] 자동부여만 유지)으로 축소.

## B2 — 티어 슬롯 (서브에이전트 별칭 라우팅)
- `src/types.ts` `claudeCode.tierModels?: { opus?: string; sonnet?: string; haiku?: string; fable?: string }`.
- `src/cli/claude.ts` `buildClaudeEnv`: 각 슬롯 → `ANTHROPIC_DEFAULT_<TIER>_MODEL` setDefault
  (user-wins 유지). **(감사 #8) effective-haiku 계약**: `tierModels.haiku ?? smallFastModel`
  단일 값을 `ANTHROPIC_DEFAULT_HAIKU_MODEL`과 legacy `ANTHROPIC_SMALL_FAST_MODEL` **둘 다에**
  user-wins로 주입.
- **[1m] 자동 부여**: 슬롯 값(및 `claudeCode.model`)이 1M 라우팅 모델이면 `[1m]` 접미사
  자동 부여(이미 붙어 있으면 그대로). `buildClaudeEnv(config, port, base, contextWindows?)`
  4번째 인자(Map<string, number>, 키=슬롯에 적힌 문자열 그대로)로 전달(순수성 유지).
  **(감사 #2+#7 → R2#1/#2) 조회 소스는 관리 API GET /api/claude-code 확장**: 응답에
  `contextWindows: Record<string, number>` 추가 — 각 모델을 **bare native slug,
  provider/id, desktop3pAlias, **그리고 legacy `claude-ocx-*`(aliasForNative/aliasForRoute,
  R3#1)** 네 형식 키 전부로 등록(슬롯이 어느 형식을 저장했든 exact 매칭). 키 등록은
  **first-wins dedupe(R3#4)** — desktop3p 레지스트리와 동일 정책을 공유 헬퍼
  (`buildClaudeContextWindows`)에 고정, 충돌 테스트 포함. **(R3#2→R4#1)** cmdClaude의
  GET 헤더는 기존 관리 호출 관례대로 **`OPENCODEX_API_AUTH_TOKEN` env 우선, config
  apiKeys fallback**으로 구성. **(R3#3→R4#2)** 요청은 3초 bounded timeout(AbortSignal) —
  활성화 테스트는 3초 초과 지연 fetch fixture로 AbortError 분기를 결정적으로 관측 +
  무부여 단언. **(R4#3)** system-env의 in-process 조회도 동일 3초 bound를
  Promise.race로 공유(초과 시 티어 키 미주입) — 공유 bounded acquisition 헬퍼 1곳.
  [1m] 선제 스트립 후 매칭.
- **(감사 #3) plain `claude` 경로 반영**: `src/server/system-env.ts` — 티어 슬롯 4키를
  launchctl injectLever(user-wins, injectedKeys 추적)와 shell env 파일 조건부 export에
  동일 계약으로 추가. **(R2#3 순서 고정)**: injectSystemEnv는 데몬 내부라 HTTP 불요 —
  같은 contextWindows 헬퍼를 in-process 호출: catalog 웜업 후 계산 → effective 슬롯([1m]
  부여 포함) 산출 → launchctl+shell 공용 주입. 계산 실패 시 티어 키 미주입(부분 실패 허용).
  GUI 수동 안내 블록(manualEnv)에도 표기.
- management-api GET/PUT: tierModels 왕복(문자열/빈값 clear 검증, 비문자열 400).
- GUI ClaudeCode.tsx: 기존 model/smallFastModel 픽커 옆에 opus/sonnet/fable 슬롯 3개 추가
  (haiku는 기존 smallFastModel 라벨을 티어 개념으로 설명 보강) + i18n 4로케일.
  **(R3#5→R4#4)** 수동 env 안내(manualEnv)는 raw 설정값이 아니라 contextWindows로 계산한
  **effective 값([1m] 부여 적용 후)**을 표시 — GET 응답에 `effectiveModelEnv` 맵
  (정확한 키: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`)을
  반환해 GUI가 그대로 렌더 + manualEnv 렌더 단언 테스트.
- 활성화: buildClaudeEnv 6분기(주입/미설정/user-wins/1M 자동부여/이미 [1m]/haiku 우선) +
  system-env 티어 키 주입/스킵/조건부 export 3분기 + API 왕복.

## B3 — count_tokens 정확도 (CCR·LiteLLM 우위 굳히기)
- `src/lib/token-estimate.ts`: **(R2#7 규칙 고정)** CJK(한중일) 비율 30% 초과 시
  `effectiveRatio = min(모델별 기존 ratio, 2.5)` — 항상 하향만(Claude 3.5, Kiro 특례와
  충돌 없음). 경계 테스트: Claude-shaped CJK / Kiro CJK / 영문(모델 ratio 유지) 3분기.
- 활성화 **(감사 #9)**: estimator 3케이스 + **endpoint 레벨** — 한국어 바디
  count_tokens 응답이 영문 동길이 대비 유의미하게 큼 단언 + cursor 라우트
  usageLogInputTokens 병합에 CJK 추정 반영 단언.

## B4 — 캐시 코호트 키 확장 (P0)
- `src/claude/inbound.ts` system fallback prompt_cache_key: sha256(**resolved model
  (resolveInboundModel 결과, 감사 #10 — 별칭 표기 차이로 코호트 분리 방지) + "\n" +
  systemParts + "\n" + 번역된 tools의 **재귀 canonical JSON**(키 재귀 정렬, R2#5) 이름
  오름차순 배열, 감사 #4 — 동명이스키마 충돌 방지**). metadata.user_id 경로 불변.
- 배포 시 기존 fallback 키 1회 콜드스타트(문서화) + 적용 후 라이브 cached_tokens 관측 기록.
- 활성화: 동일 입력→동일 키 / model만 상이→상이 키 / 동명이스키마 도구→상이 키 /
  **동일 스키마·상이 키순서→동일 키(R2#5)** 4단언 + 기존 3분기 테스트 갱신.

## B5 — 기록/문서
- docs-site claude-code.md (en/ko/zh): [1m] 픽커 행, 티어 슬롯, maxContextTokens 경고 정리.
- devlog **(감사 #5 정정)**: 011(감사 합성)/012(Pro 검토 반영)/090(B/C 기록). 이 유닛은
  단일 work-phase라 phase decade 로드맵 비적용 — loop-spec 헤더로 대체(상단).

## 게이트
bun x tsc --noEmit / bun test / gui build / docs-site build.

## OUT (기록만)
- GPT-5.6+ prompt_cache_breakpoint/ttl 변환 (provider capability probe 필요 — 차기 유닛).
- MAX_CONTEXT auto env 주입 (claude- 접두 별칭에 무효 확인 — 수동 옵션만 존치).
- anthropic 라우팅 cache_control 보존 (verbatim relay는 claudedesktop 유닛에서 다룸).
