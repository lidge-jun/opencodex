# 130 — Desktop 3P 추론강도 매칭 + Claude 표면 usage/캐시 투명성 (P)

## 문제 (사용자 보고, 2026-07-12 00:35~00:46 라이브 로그)

1. **추론 강도**: CLI(`ocx claude`)에서는 모든 effort가 작동하는데, Claude Desktop 3P에서는
   라우팅 모델의 effort 변경이 반영되지 않는 것으로 보인다.
2. **usage/캐시 불투명**: Claude 표면(luna 등) 요청의 로그에 캐시 토큰이 전혀 없고,
   누적 합산(입력+캐시) 표기가 비어 있다. **cursor 한정이 아니다** — native/openai 경로로
   갔을 때도 `c 0`(캐시 0)이었다 (사용자 교정).

## 실측 근거 (라이브 /api/logs, 2026-07-12 00:50 캡처)

- Claude 표면 effort 분포: `gpt-5.6-luna high×12 / xhigh×5`, `claude-haiku-4-5 None/high`.
  Desktop 슬라이더에서 high/xhigh는 도달. low/medium/max 도달 여부 미확인(캡처 수단 없음).
- `ocx-mrgj5jwp-15` (Claude 표면 → openai-pb51d9b, sol): `in:7 out:95 cachedIn:0` — 캐시 0.
- cursor(luna) 행: `cachedIn/read/write = None` 전부. 컨텍스트 체크포인트 없는 턴은 `in: 0, out: 7~211`.
- 비교: 같은 시각 codex 표면 sol 행은 `9.5만 c 9.4만` — 캐시 정상. 차이는 표면(Claude inbound)이다.
- anthropic 라우팅(haiku)은 `write: 10047` — 캐시 write 정상 동작.
- 버그: `usage/log.ts isEstimatedUsageProvider`가 `provider === "cursor"` 정확일치 비교인데
  실제 로그 provider는 `cursor-pb51d9b`(프로바이더 이름) → cursor usage가 `estimated` 마크 없이
  `reported`로 찍힘 (라이브 로그에서 `status: reported` 확인).

## 가설 (검증 계획 포함)

- H1 (캐시): Claude Desktop은 CLI와 달리 `metadata.user_id`를 보내지 않는다 →
  `anthropicToResponsesBody`가 `prompt_cache_key`를 만들지 못함 → native 경로 `session_id`
  헤더 합성도 안 됨 → ChatGPT/OpenAI 캐시 0. **검증**: 인바운드 디버그 캡처(B1)로 Desktop
  요청 바디의 metadata 유무 확인.
- H2 (effort): Desktop은 adaptive wire(`output_config.effort`)를 보내며 high/xhigh는 실측 도달.
  low/medium/max 미도달이 Desktop UI 제약인지 전송 후 소실인지 미확정. **검증**: B1 캡처 +
  Parfit 레인(공식 3P 스키마/GitHub) 결과.
- H3 (cursor usage): Cursor 스트림에 신뢰 가능한 usage/캐시 프레임이 있는지 Einstein 레인이
  조사 중. 없으면 요청측 추정(estimateTokens) + "캐시 미보고" 명시 표기로 투명화.

## 계획 (diff-level)

> A-라운드 1 (Boole, FAIL, 블로커 9) 합성 반영판. 블로커별 수용/반박은 `133_audit_synthesis.md`.

### B0 — Desktop 별칭 전면 `claude-opus-4-8-{code}` 전환 (사용자 지시 + 131 근거)
- 근거: Desktop effort selector는 정확한 지원 모델 ID allowlist(Opus 4.8/4.7/4.6, Sonnet 4.6).
  현행 `claude-opus-4-{code}`는 어떤 실제 버전과도 안 맞아 effort UI가 잠길 개연성.
- `src/claude/desktop-3p.ts` `desktopAlias`: `claude-opus-4-8-${code}` 로 변경 (모든 비-Anthropic
  후보 = native + routed 전부). 충돌 논거(감사 #2 교정): 4.6+ canonical id는 dateless
  `claude-opus-4-8` — 별칭은 여기에 letter-first 3자 suffix가 붙으므로 실제 id와 정확히
  겹치지 않고, 구형 date-suffix(숫자 8자리)와도 문자종이 달라 안 겹침.
- **(감사 #1, High)** 실제 Anthropic id(alias===id인 anthropic passthrough 항목)는 Desktop
  config 모델 목록에는 남기되 **디코드 레지스트리에 등록하지 않는다** — 등록하면
  `resolveInboundModel("claude-opus-4-8")`이 `anthropic/...`을 반환해 sk-ant 네이티브
  패스스루가 죽는다. 활성화 시나리오: 레지스트리 빌드 후
  `resolveDesktop3pAlias("claude-opus-4-8") === null` + `resolveInboundModel` 항등 단언 테스트.
- 하위호환: 레지스트리에 구형 `claude-opus-4-{code}` 키도 함께 등록(디코드만) — 사용자가
  `ocx claude desktop` 재실행 전이어도 404 안 나게.
  활성화 시나리오: 구형/신형 별칭 각각 decode 테스트 + 신구 키 상호 충돌 검사.
- `ocx claude desktop` 재실행 시 config 재작성으로 새 별칭 반영.

### B4b — /v1/models(anthropic flavor)를 ModelInfo 전체 형태로 승격 (131 근거)
- `src/server/index.ts` wantsAnthropicList 분기: 항목을 `{ id, display_name, type:"model",
  created_at, capabilities, max_input_tokens, max_tokens }` 로 확장.
- **(감사 #4, High) Desktop 도달 경로 확보**: `generateDesktop3pConfig`를
  `modelDiscoveryEnabled: true` + `inferenceModels` 제거(discovery 모드)로 전환 —
  정적 목록은 capabilities를 실을 수 없으므로 discovery가 유일한 소비 경로.
  별칭이 전부 `claude-opus-4-8-*`라 "recognizably Claude" 필터도 통과.
  안전판: `ocx claude desktop --static` 플래그로 기존 정적(inferenceModels) 모드 유지 가능.
  **(R2 #4, Low)** `--static` 활성화 시나리오: CLI 인자 파싱(`ocx claude desktop --static`) →
  정적 config shape(inferenceModels 존재 + modelDiscoveryEnabled:false) 단언 + 동일
  프로세스에서 신·구 별칭 decode 단언까지 한 테스트로 커버.
  활성화 시나리오: 사용자 Desktop 재시작 → picker가 /v1/models에서 채워지는지 +
  effort UI 노출 여부 + B1 캡처에서 `output_config.effort` 도달 확인 (실험 게이트).
- **(감사 #4 참고)** Claude Code CLI 2.1.207은 추가 필드를 strip함을 리뷰어가 재현 확인 —
  CLI 호환성 리스크 없음. **(사용자 지시 "모든 aliases")** anthropic-flavor 목록의 id 자체를
  기존 `claude-ocx-*`에서 `claude-opus-4-8-{code}`로 교체(display_name은 실모델명 유지),
  `resolveAlias`(claude-ocx-*) 디코드는 하위호환으로 존치.
- **(감사 #3 → R2 #1, High) effort 소스 확정**: 합성 catalog의 routed 키는 ladder를
  기본화/증강(max·ultra 인위 추가)하므로 capability 진실원으로 쓰지 않는다.
  - native 슬러그: `catalogModelEfforts([slug])`에서 시작하되 **(R3 #2 → R4 #1)** 합성
    증강분을 제거한 **유효 ladder**만 광고. `nativeEffortClamp`는 항등 전달 시 `null`을
    반환하는 계약이므로 광고 조건은 `effective = nativeEffortClamp(slug, r) ?? r` 로 정의하고
    `effective === r`인 rung만 광고한다. ultra 제외.
    활성화 시나리오: 광고된 모든 rung에 대해 `nativeEffortClamp(slug, r) === null ||
    nativeEffortClamp(slug, r) === r` 단언 테스트.
  - routed 모델: `fetchAllModels` 행의 `reasoningEfforts`(어댑터 보고 authoritative ladder)만
    사용. 없거나 비면 `effort.supported:false`(추측 금지).
  - 매핑: ladder 보유 rung만 `{supported:true}`, 미보유 rung `{supported:false}`,
    ladder 자체가 없으면 `supported:false` + `xhigh:null`.
- **(R2 #2, Med) ModelInfo 값 생성 규칙**: `created_at`은 고정 상수 `"2026-01-01T00:00:00Z"`
  (현재시각/추측 금지), `max_input_tokens`는 authoritative contextWindow 있을 때만, 없으면
  `null`. `max_tokens`는 authoritative 출력 한도가 없으므로 일괄 `null`. catalog 부재 시에도
  항목은 나가되 capabilities는 보수값.
- `capabilities.thinking`: reasoning 모델이면 `{supported:true, types:{adaptive:{supported:true},
  enabled:{supported:true}}}`.
- 나머지 필수 capability 필드(batch/citations/code_execution/context_management/image_input/
  pdf_input/structured_outputs)는 보수적 기본값.

### B1 — Claude 인바운드 디버그 캡처 링 (진단 도구, 최우선)
- **(감사 #6, Med) opt-in + allowlist 스칼라만**: `src/claude/inbound-debug.ts` (NEW),
  링버퍼 20건. 저장 필드는 allowlist 스칼라만 — timestamp, endpoint(messages|count_tokens),
  model, resolvedModel, `thinking.type`, `thinking.budget_tokens`(number),
  `output_config.effort`(string), metadata 키 이름 목록, `metadata.user_id` 존재 여부(boolean),
  max_tokens, stream, system 유무(boolean). 해시/프리픽스류 저장 안 함(fingerprint 방지).
  **(R2 #3, Med)** 단, 안정성 판별용으로 프로세스별 랜덤 salt HMAC의 **ephemeral equality
  tag** 2종은 저장: `userIdTag`(metadata.user_id), `systemTag`(system 텍스트) 각 8자 —
  재시작마다 salt가 바뀌어 fingerprint 불가, 링 안에서 턴/대화 간 동일성 비교만 가능.
  기존 debug-settings 인프라에 `claude` 키 추가 — OFF(기본)면 캡처 자체를 안 하고,
  OFF 전환 시 링 클리어.
- **(감사 #5, Med) 캡처 지점**: body를 새로 읽지 않는다. `handleClaudeMessages`의
  `readAnthropicBody` 직후 + count_tokens 핸들러의 parse 직후, 공유 `captureClaudeInbound()`
  호출 (native passthrough 분기 이전이므로 세 경로 모두 커버).
  활성화 시나리오: messages/count_tokens/native passthrough 각 1건씩 합성 요청 → 링에
  endpoint별 항목 단언 + OFF 시 미기록 단언.
- `src/server/management-api.ts`: `GET /api/claude/inbound-debug` 추가.
- `gui/src/pages/Debug.tsx`: "Claude 인바운드" 섹션에 표 렌더 + i18n 4개 로케일.
- 목적: H1/H2를 사용자 라이브 실험(슬라이더 low→max 이동)으로 즉시 판정.

### B2 — usage 정합성 수정 (코드 확정분)
- `src/usage/log.ts`: `isEstimatedUsageProvider`를 provider "이름" 비교에서 어댑터 기반으로.
  `RequestLogContext.providerAdapter?: string`을 responses.ts에서 세팅(`route.provider.adapter`),
  `usageForFinalLog(adapter ?? provider, ...)` 프리픽스 매치(`cursor`, `kiro`)로 판정.
- **(감사 #7, High) 추정 보정은 estimated 어댑터 한정**: `claude-messages.ts` 라우티드
  경로에서 `routeModel` 결과의 adapter가 `cursor`/`kiro`일 때만 `estimateTokens` 입력 추정치를
  `logCtx.usageLogInputTokens`에 세팅. anthropic/openai 등 정확 보고 어댑터에는 절대 세팅하지
  않아 기존 max() 병합이 정확 usage를 덮어쓸 수 없게 한다.
  활성화 시나리오: (i) cursor 경로 in:0 행이 추정치로 메워지고 estimated 마크가 붙는 테스트,
  (ii) anthropic 경로는 usageLogInputTokens 미세팅(정확 usage 그대로) 회귀 테스트.
- GUI `Logs.tsx` + i18n: usage가 estimated면 토큰 수 앞에 `~` 표시(추정), 캐시 필드가
  아예 없는 프로바이더(cursor)는 상세보기에 "캐시 미보고(프로바이더가 캐시 수치를 제공하지
  않음)" 문구.

### B3 — Claude 표면 캐시 친화 복구 (H1 확정 후)
- **(감사 #8, Med 반영)** B1 캡처로 Desktop 요청의 metadata 유무/안정 식별자 후보를 먼저
  확인한 뒤 적용(실험 게이트). 확인 전 기본안: metadata.user_id가 없고 system이 존재할 때만
  fallback prompt_cache_key = sha256(system).slice(0,32). system 부재 시 키 미설정(스킵).
  안전 근거: OpenAI prompt cache는 exact-prefix 매치라 키 공유가 내용 오염을 만들지 않고
  라우팅 친화만 좌우한다 — 여러 Desktop 대화가 키를 공유해도 정확성 무해.
- **(R2 #3 → R3 #1, High)** session_id 헤더 합성은 **metadata.user_id 유래 키일 때만** 기존
  로직 유지. system-hash fallback 키는 body의 `prompt_cache_key`에만 쓰고 session_id 헤더는
  합성하지 않는다. fallback 여부 전달은 **wire body 밖 튜플**로: `anthropicToResponsesBody`가
  `{ body, cacheKeySource: "metadata" | "system" | null }`을 반환하도록 시그니처 변경
  (in-body marker 금지 — enumerable 필드는 native adapter가 upstream에 그대로 전달돼 400 위험).
  활성화 시나리오 추가: (v) 직렬화된 wire body에 cacheKeySource 계열 필드 부재 단언.
- 활성화 시나리오: (i) metadata 없음+system 있음 → 키 생성 단언, (ii) metadata 있음 → 기존
  user_id 해시 유지 단언, (iii) 둘 다 없음 → 키 없음 단언, (iv) fallback 키일 때 session_id
  헤더 미설정 단언. 라이브 검증: 적용 후 Desktop 연속 턴에서 cached_tokens>0 관측.

### B4 — effort 매칭 수정 (H2 확정 후, Parfit 결과 반영)
- 확정 전 코드 변경 없음. 캡처 결과 Desktop wire가 확인되면:
  - `output_config.effort` 외 wire(예: budget) 발견 시 `effortFromOutputConfig`/매핑 확장.
  - Desktop UI가 특정 tier만 노출하는 문제면 desktop-3p.ts config(스키마 필드) 보강.

## 게이트
`bun x tsc --noEmit` / `bun test` / `cd gui && bun run build` / (docs 변경 시) docs-site build.

## 스코프
- IN: 위 B1-B4, 유닛 테스트, i18n 4로케일, devlog 기록.
- OUT: Desktop 앱 자체 동작 변경, cursor 프로토콜 신규 필드 추가(Einstein 결과가 있어야만 IN),
  Usage 페이지 대규모 리디자인.

## 서브에이전트 레인
- Parfit (sol high + cxc-search): Desktop 3P effort wire / config 스키마. → 131 기록 완료
- Einstein (sol high + cxc-search): Cursor usage/캐시 프레임. → 132 기록 완료
  (스트림에 usage 프레임 없음 확정 → B2의 추정+명시 표기가 정공, usage_uuid 사후조회는 차기)
