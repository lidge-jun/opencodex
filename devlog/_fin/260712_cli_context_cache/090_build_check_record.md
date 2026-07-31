# 090 — B/C 기록: CLI 컨텍스트·캐싱·티어슬롯 하드닝

## 구현 델타 (B)
| 항목 | 파일 | 내용 |
|---|---|---|
| 공유 헬퍼 | `src/claude/context-windows.ts` (NEW) | 4형식 키 contextWindows 맵(first-wins), withOneMillionMarker, effectiveModelEnv(6키+effective-haiku), boundedContextWindows(3s) |
| B1 [1m] 픽커 | `src/claude/model-info.ts` | native+routed >=1M에 `[1m]` 변형 행(dedupe, 이중접미사 방지) |
| B2 티어 슬롯 | `types.ts`, `cli/claude.ts`, `system-env.ts`, `management-api.ts`, `ClaudeCode.tsx`, i18n×4 | tierModels 왕복+ANTHROPIC_DEFAULT_*_MODEL 주입(3경로)+[1m] 자동부여+manualEnv effective 렌더 |
| B2 조회 | `cli/claude.ts` fetchClaudeContextWindows | /api/claude-code GET, 3s AbortSignal, env토큰 우선 인증 헤더, 실패 무부여 |
| B3 CJK | `lib/token-estimate.ts` | CJK>30% 시 min(모델 ratio, 2.5), 샘플링 O(1) |
| B4 코호트 | `claude/inbound.ts` | canonical JSON {version:2, model, system, tools(wire순서)} 해시 (Pro 교정 반영) |

## 검증 (C)
- tsc 클린 / **bun test 2235 pass, 0 fail** (9461 expect, 216 files) / gui build ✓ / docs 55p ✓.
- 활성화: context-windows 7테스트(4형식/충돌 first-wins/마커/6키/타임아웃 fixture),
  model-info [1m] 3테스트(1M만/native/이중접미사), claude-cli 3테스트(티어+[1m]/user-wins/무맵),
  inbound 코호트 4단언+wire순서, [1m] 스트립 두 별칭 계열, token-estimate CJK 3분기,
  system-env 티어 주입/추적/조건부 export, management-api tierModels 왕복+400,
  endpoint CJK count_tokens 비교.
- 잔여(NEEDS_HUMAN): 2.1.207 라이브 픽커 스모크 — 재시작 후 [1m] 행 표시/폴딩 여부,
  티어 별칭 서브에이전트 실호출 확인 (012의 폴딩 주의 참조).

## 사용자 절차
1. `ocx stop && ocx start` → `ocx claude` 새로 실행 (env는 시작 시 1회)
2. GUI Claude 페이지: 서브에이전트 티어 모델 3슬롯 지정 + 저장
3. CLI /model 픽커에서 `… · 1M` 행 선택 → /context가 1M로 뜨는지
4. 서브에이전트에서 `model: "opus"` 지정 → 로그에서 티어 슬롯 모델로 라우팅 확인

## 020 auto-context 사이클 (C 기록)

- 구현: 조건부 `[1m]` 마킹(`shouldMarkOneMillion`: >=1M 항상, auto는 >200k && >=compactWindow) +
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 주입(기본 350k) — cli/claude.ts, system-env.ts(launchctl+shell),
  model-info.ts 픽커 변형(정직 라벨 `· 372k`), management-api GET/PUT, GUI 드롭다운(모델 픽커와
  동일한 Select, 프리셋 사다리 100k~1M + off-ladder 값 노출) + 커스텀 값 빨간 경고, i18n 4로케일,
  docs en/ko/zh.
- 감사(021, Lovelace/sol FAIL→전건 수용): 범위 100k..1M(BIN pSo/yDs 재검증), env-override가 술어
  구동(무효 env는 auto OFF), anthropic sub-1M 제외(맵 미등록+변형 억제), manualEnv export 추가,
  bare id 유일시 등록, 테스트 계약 갱신, `[1m]` 대소문자 무시 통일(inbound/count_tokens 포함).
- 게이트: `bun x tsc --noEmit` clean / `bun test` 2252 pass 0 fail / `gui build` OK /
  `docs-site build` 55 pages OK.
- 잔여(HOTL): 라이브 스모크 — `ocx claude` 재시작 후 picker에서 `gpt-5.6-sol · 372k` 변형 선택,
  /context 1M 표시 + 350k 부근 자동 컴팩션 관측.

## 030 gateway-cache 사이클 (C1, 라이브 스모크 중 발견)

- 증상: 프록시 재시작 후에도 픽커에 옛 `claude-ocx-*` 행만 표시.
- 원인(바이너리): `q5l()`은 `ANTHROPIC_AUTH_TOKEN`/api key 없으면 fetch 자체를 생략 —
  구독 보존 모드(토큰 미주입)에서는 `~/.claude/cache/gateway-models.json`이 영원히 stale.
  픽커(`mkr()`)는 baseUrl 일치만 검사하고 캐시를 그대로 신뢰.
- 해결: `src/claude/gateway-cache.ts` — CLI 스키마 그대로(usable-id 필터 포함) 캐시를
  선기록. `ocx claude` 실행 직전 + systemEnv 주입 시(데몬 자기-fetch, 서버 listen 후) 실행.
- 게이트: tsc clean / bun test 2255 pass. 라이브 캐시 재기록 확인(36 모델, 372k 변형 포함).

## 정정 (실측 2026-07-12): effort는 id 모양과 무관

2.1.207 실측(디버그 링, `claude -p` 3종 비교): `claude-opus-4-8-ncb` / `claude-ocx-native--gpt-5.6-sol` /
bare `gpt-5.6-sol` 모두 `output_config.effort: high` + `thinking: adaptive`가 와이어에 실림 —
ALWAYS_ENABLE_EFFORT 미설정 상태. devlog 136의 "opus 모양만 effort 탑재" 결론은 현 버전에서 무효
(effort-2025-11-24 beta가 전 모델 적용으로 보임). opus-4-8 해시 별칭의 CLI 잔여 근거는
① 디스커버리 필터 `/^(claude|anthropic)/i` ② Desktop과의 레지스트리 공유, 두 가지로 축소.

## 040 crash-guard 사이클 (C1, 사용자 로그 리포트)

- 증상: `unhandledRejection TypeError: Invalid state: ReadableStream is locked`
  (ERR_INVALID_STATE, native-only 스택, onSinkClose2) — 프록시는 생존, 배너만 시끄러움.
- 원인: tee() 패스스루(responses.ts Bun#32111 우회)에서 클라이언트가 SSE 도중 끊으면
  Bun의 sink-close teardown이 tee로 잠긴 원본 body를 cancel 시도 → off-path 거부.
  요청 수명주기는 이미 종료된 뒤라 무해 — 기존 'null is not an object' 계열과 동일 가족.
- 해결: isBenignAbortTeardown에 두 번째 형태 추가(메시지+code+native-only 3중 판정,
  JS 프레임 있으면 계속 실제 결함으로 승격). responses.ts 429 회전의 void cancel도
  .catch 가드(잠긴 스트림 cancel은 try/catch를 지나쳐 비동기 거부).
- 게이트: tsc clean / bun test 2257 pass. 커밋 f5be49d. 데몬 재시작 후 적용.

## 050 CLI 가독형 id 사이클 (C 기록, 커밋 2c2beda)

- 구현: `claudeCodeAlias`/`claudeCodeNativeAlias` 공용 헬퍼(가독형 ?? desktop3p 해시 폴백,
  anthropic canonical passthrough) → model-info idStyle 파라미터, /v1/models 표면 분기
  (?ids=cli|desktop > UA `/^claude-code\//i` > 기본 해시), gateway-cache `?ids=cli` 고정,
  GUI aliases 가독형 전환, docs en/ko/zh.
- 감사(051 NEAR-PASS) 5건 전부 반영: 공용 헬퍼 양쪽 사용, 폴백 first-wins 명문화,
  구 해시 선택값 UX 문서화, false-green 테스트 보강([1m] 가독형 디코드/티어 마킹/UA 분기),
  ids=cli 결정성.
- 게이트: tsc clean / bun test 2263 pass / gui build / docs 55p. 라이브 스모크: ids=cli
  28 readable rows(sol/sol[1m] 확인), Desktop UA는 해시 28행·가독형 0행, 캐시 선기록 확인.
- 잔여: 사용자 픽커 재선택 필요(구 claude-opus-4-8-ncb 선택값은 커스텀으로 표시, 동작은 유지).

## 070 로스터 에이전트 주입 사이클 (C 기록)

- 구현: agents-inject.ts (roster<=5 + ocx-self(inherit) → ~/.claude/agents/ocx-*.md,
  generated-by 마커 소유권 + lstat 심링크 가드 + tmp/rename 원자 쓰기 + disabled prune),
  cmdClaude/injectSystemEnv 훅(윈도우 맵 재사용), management PUT 즉시 prune, GUI 토글+i18n x4,
  docs x3. Kant 감사(071 FAIL) 3블로커 포함 7건 전건 반영 — 특히 self는 `model: inherit`.
- 게이트: tsc clean / bun test 2274 pass / gui+docs build.
- 라이브 E2E: 6개 def 생성 확인, `claude -p`에서 `subagent_type: ocx-gpt-5-6-terra` 파견 →
  "pong" 회신 + 로그에 라우팅 확인. 잔여(코스메틱): 서브에이전트 행 하나 resolvedModel 미표기.
- 운영 노트: launchd 서비스가 외부 `ocx stop`류에 의해 두 차례 bootout → plist 재bootstrap.

## 072 ocx-self 3라운드 (C 기록) — inherit 반증 → settings 핀 → ocx-route 지시자

- R1: description "no model arg" 지시 — 디스패처 오버라이드는 억제됐으나 무-인자 파견이
  fable로 낙하 → frontmatter `inherit`는 2.1.207에서 미지원 (Kant 주장 라이브 반증).
- R2: settings.json 픽커 기본값 핀 — 정의 본문은 로드되지만 커스텀 게이트웨이 id가
  frontmatter 검증에서 sonnet-5로 낙하 (프록시 로그: requested=claude-sonnet-5, native).
- R3(확정 해법, 사용자 제안 방향): 본문에 `<!-- ocx-route: <model> -->` 지시자 —
  서브에이전트 시스템 프롬프트에 본문이 그대로 실리는 것을 이용, 프록시가 passthrough
  분기 전에 모델을 덮어씀 (messages+count_tokens). 라이브: ocx-self 파견 전 행이
  gpt-5.6-sol/openai로 라우팅, sonnet 행 소멸. 테스트 2276 pass.
- 부수: service.ts 클립보드 오염 복구(붙여넣기 사고), 커밋 분리 기록.
