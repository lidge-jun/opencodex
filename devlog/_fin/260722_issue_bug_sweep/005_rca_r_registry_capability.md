# 005 — RCA R: 모델 레지스트리/어댑터 capability (#202 Vertex, #179 Cursor effort)

- 이슈: #202 (google-vertex 모델 미노출), #179 (Cursor effort 강제)
- 조사: sol 서브트랙 R-1 / R-2, 2026-07-22 dev 트리 실측

## R-1 (#202) — google-vertex 모델이 /v1/models·대시보드에 미노출

### 증상 재현 (코드 검사로 확정)

`ocx models`는 configured provider를 직접 읽어 `defaultModel`을 먼저 출력(`src/cli/models.ts:19,51`) —
카탈로그 진입과 무관. 반면 대시보드·`/v1/models`는 `gatherRoutedModels()` 경유라 0행.

### 데이터 플로우 (파일:라인)

1. config: `providers.<name>` passthrough로 `defaultModel`/`models`/`liveModels` 생존 (`src/config.ts:290`; 타입 의미 `src/types.ts:588,611` — liveModels 기본 켜짐)
2. registry: `google-vertex` 엔트리는 adapter=google, baseUrl=aiplatform.googleapis.com, authKind=key, defaultModel=gemini-3-pro, **`models` 시드 없음, liveModels:false 없음** (`src/providers/registry.ts:649`; 대조: antigravity는 `models: ANTIGRAVITY_MODELS` `:652`)
3. catalog: `fetchProviderModels()`는 static 행을 **`prov.models`에서만** 구성, defaultModel은 시드 아님 (`src/codex/catalog.ts:1240,1243`); liveModels!==false면 generic discovery — OpenAI형 `{data:[{id}]}` 요구 (`:1275,1286,1294`)
4. discovery 요청: Vertex는 AI Studio 특례를 지나 generic 분기 → `GET https://aiplatform.googleapis.com/models` + Bearer key (`src/oauth/index.ts:352,360,378`; 테스트 고정 `tests/google-models-listing.test.ts:45`). **Google Vertex는 OpenAI형(`{data:[{id}]}`) /models 응답을 제공하지 않으므로 현 generic discovery는 호환 불가.** 단 인벤토리 소스가 아예 없는 것은 아니다: Google은 location-aware `GET https://LOCATION-aiplatform.googleapis.com/v1/publishers/*/models` 를 문서화한다(리뷰 검증: docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-garden/use-models) — 다만 OpenAI 형태가 아니고 인증·location 시맨틱이 별도라 Vertex 전용 파서/요청이 필요.
5. 실패 격하: non-2xx/예외 → stale 캐시 아니면 configured(빈 배열) (`catalog.ts:1288,1344`) — **이 경로는 경고 로그도 없음**; 유효한 `{data:[]}`는 authoritative empty로 configured까지 삭제(`:1333`)
6. sync/`/v1/models`: 동일 `gatherRoutedModels()` 소스 (`sync.ts:29`, `refresh.ts:37`, `catalog.ts:1868`, `management-api.ts:1629`, `server/index.ts:247,300`)

### 근본 원인

**google-vertex의 인벤토리 소스가 현 코드에 연결돼 있지 않다** — static 시드도, Vertex 전용 discovery도 없어
generic OpenAI형 discovery가 호환되지 않는 엔드포인트를 두드리고 조용히 빈 목록으로 격하된다.
(Vertex 전용 `publishers/*/models` REST는 존재하므로 "소스 부재"가 아니라 "미구현 호환 갭"이 정확한 원인.)
defaultModel을 카탈로그 멤버로 안 치는 것은 의도된 설계라 `ocx models`와의 분열이 발생.
auth 모드·adapter 특례는 부차적: 인증이 완벽해도 그 URL은 카탈로그를 반환하지 않는다.

### 수정 방향 (021 패치 단위 입력)

1. **단기(권장)**: registry에 감사된 static Vertex Gemini 시드 + `liveModels: false`.
2. 사용자 워크어라운드 문서화: config에 `models: [gemini-2.5-pro]` + `liveModels: false`.
3. generic fallback 개선(선택): discovery 실패·models 빈 경우 defaultModel 노출 — 단 per-provider opt-in 메타데이터로 한정(오타 default 광고 위험).
4. 장기: Vertex 전용 discovery — location-aware `v1/publishers/*/models` REST 사용(project/location/publisher 시맨틱, OpenAI 파서 재사용 금지, callable Gemini 필터). static 시드(1)와의 채택 비교를 021에서 명시.
5. 진단: non-2xx/예외 discovery 실패에 provider·URL class·fallback 결과 경고 로그.

### 테스트 확장

registry parity(vertex.models 비어있지 않거나 liveModels false), gatherRoutedModels 회귀,
static-only 모드에서 generic /models 미호출, config models+liveModels:false의 4면 도달(카탈로그/sync/v1/codex),
404·malformed·authoritative-empty 실패 3종, CLI/API parity 진단.

## R-2 (#179) — Cursor effort 강제 주장 검증

### 핵심 판정

이슈의 "effort 강제 → 모델 파손" 주장은 현 dev에서 **부분만 성립**:

- Cursor effort는 모델 ID 서픽스 인코딩 (`src/adapters/cursor/effort-map.ts:18,85`).
- 직접 요청 경로는 안전: no-effort 모델에 effort를 줘도 bare ID 전송 (`request-builder.ts:93,161`; 테스트 `tests/cursor-effort-suffix.test.ts:46`) — malformed ID는 만들어지지 않음.
- GUI Models 페이지에는 effort 셀렉터 자체가 없음 (`gui/src/pages/Models.tsx:9,157`); Dashboard 인젝션 셀렉터는 capability-aware로 올바름 (`Dashboard.tsx:761`).
- **확인된 "강제" 표면은 Combos**: 모든 콤보가 non-null `defaultEffort`(기본 medium, unset 불가 — `gui/src/combo-workspace-data.ts:9,232`, `ComboWorkspace.tsx:122,135`, `src/combos/types.ts:163`), 클라이언트가 effort를 생략하면 대상 capability 확인 없이 `{reasoning:{effort:"medium"}}` 주입 (`src/combos/request.ts:11`; 테스트 `tests/combos.test.ts:172`).
- 알려진 effort 모델에서 미지원 값은 조용히 클램프 (`claude-4.6-opus + low → -high`, `cursor-effort-suffix.test.ts:33`) — UI/설정 주장과 실제 요청 불일치.
- 메타데이터 드리프트: `grok-4.5-fast`는 effort-map에 티어가 있는데 supportsReasoningEffort 미표기 → 카탈로그는 `[]` 광고, 아웃바운드는 서픽스 부착 가능 (`effort-map.ts:29`, `discovery.ts:167,191` — flag/map 불일치 시 generic ladder fallback도 위험).

### 수정 방향 (021 패치 단위 입력)

1. 콤보 effort nullable화: "None/target default" 옵션, GUI·API·정규화·영속 전체.
2. capability-aware 주입: 대상 `reasoningEfforts`가 `[]`면 생략, 지원 목록이면 명시 정책으로 보존/클램프, unknown이면 보수적 생략 또는 검증 경고.
3. 아웃바운드 방어 유지 + 진단: known-`[]` 모델에 effort가 오면 생략하며 structured debug 경고.
4. 메타데이터 불변식: supportsReasoningEffort=true ↔ effort-map 엔트리 존재를 테스트로 강제, grok-4.5-fast 정합.
5. 저장 시 model/effort 조합 검증.

### 안정성 노트 (이슈의 stability 절반)

현 retry: pre-commit transient만 3회 지터 백오프 (`transport-retry.ts:10,57,20`), HTTP/2 연결 즉시 committed (`live-transport.ts:579`), 30s first-frame 타임아웃(`:601`). 갭: 401 시 토큰 refresh-and-retry 없음(`:343`), gRPC 숫자 status(14 등) 미분류(`:665` vs `transport-retry.ts:27`), Retry-After 미준수, post-commit 재개 없음(중복 방지 목적 — 유지 권장). 최소 개선: gRPC status 분류·진단, commit 전 1회 credential refresh.
