# 000 — 조사계획: 로그 tok/s 속도 열 + jawcode 가격 기반 toks/$ 열

## 목적 (조사 전용 — 구현 없음)

로그(GUI Logs 탭 + `/api/logs` + `usage.jsonl`)에 두 열을 추가할 수 있는지 타당성 조사:

1. **토큰 속도 열 (tok/s)** — 요청별 출력 토큰 생성 속도를 측정/표시할 수 있는가.
2. **가격/효율 열 (toks/$)** — jawcode `models.json`의 `cost` 데이터(캐시 읽기/쓰기 단가 포함)로
   요청별 비용을 계산하고, toks/$ 형태로 표시할 수 있는가.

산출물은 조사 문서 2건(001, 002). 코드 패치는 범위 밖(OUT).

## 현재 코드 사실 (탐색 완료, 검증 앵커)

- `src/server/request-log.ts` — `RequestLogEntry`에 `durationMs`(요청 전체 벽시계),
  `usage?: OcxUsage`, `totalTokens`, `attempts[]`(attempt별 `durationMs`+`usage`) 존재.
  `addFinalRequestLog()`가 `durationMs: Date.now() - start`로 기록 (라인 458).
- `src/types.ts:236` — `OcxUsage { inputTokens, outputTokens, totalTokens?, cachedInputTokens?,
  cacheReadInputTokens?, cacheCreationInputTokens?, reasoningOutputTokens?, estimated? }`.
- `src/usage/log.ts` — `PersistedUsageEntry`/`PersistedUsageAttempt`가 `usage.jsonl`에 영속.
  kiro/cursor 어댑터는 `estimated: true` (usage 추정치).
- `gui/src/pages/Logs.tsx:193-202` — 열: time / tokens / model / effort / provider / status /
  request / duration. duration 열이 이미 있어 tok/s는 파생 계산 가능.
- `scripts/generate-jawcode-metadata.ts` — `../jawcode/packages/ai/src/models.json`에서
  contextWindow/maxTokens/input/reasoning/wireModelId만 추출, **cost는 현재 버림**.
- jawcode `packages/ai/src/models.json` — 48개 프로바이더, 모델별
  `cost { input, output, cacheRead, cacheWrite }` (USD per 1M tokens 관례; 검증 필요).
- 스트리밍 경로에 first-token 타임스탬프(TTFT) 기록은 현재 **없음** (`firstToken|ttft` 검색 0건).

## 조사 질문

### Q1 — tok/s (001 문서)

- 측정 정의: `outputTokens / (durationMs/1000)`이 타당한가? durationMs는 TTFT 포함
  전체 벽시계라 실제 디코딩 속도보다 낮게 나온다 — TTFT 분리 계측이 필요한가/가능한가?
- SSE 경로에서 first output delta 시각을 잡을 훅 위치 (relay/responses/adapter 경로별).
  경로별로 분리 조사(감사 blocker #5 fold): native passthrough SSE(`src/server/relay.ts:142-187`),
  adapter SSE(`bridgeToResponsesSSE()`, `src/server/responses.ts:1522-1543`, `src/bridge.ts:213-215`),
  비스트리밍(`src/server/responses.ts:1280-1299`, `1546-1563`), tool/reasoning-only 응답 —
  각각의 "첫 토큰" 정의를 별도로 내릴 것.
- reasoningOutputTokens 포함 여부 (reasoning도 output 토큰으로 속도에 기여).
- estimated usage(cursor/kiro), combo 다중 attempt, 실패/취소(499) 처리 규칙.
  (감사 blocker #3 fold) usage 부재 시 output=0 추정 usage가 생성될 수 있음
  (`src/server/request-log.ts:510-535`) — `outputTokens=0`/unreported/unsupported/estimated를
  tok/s에서 어떻게 표시(생략? "—"? "~" 접두?)할지 정책을 결론에 포함.
- (감사 blocker #6 fold) jawcode stats DB에 이미 `ttft` + tok/s 집계 필드가 존재
  (`jawcode/packages/stats/src/db.ts:426-465`) — jawcode의 측정 정의를 OpenCodex 안과 대조.
- 표시: Logs 탭 열 추가 지점, i18n 키(`logs.col.*`), /api/logs 필드 추가 하위호환.

### Q2 — 비용/toks/$ (002 문서)

- jawcode cost 단위 검증 (per 1M USD 여부; jawcode의 실제 계산식 —
  비용 계산의 원천은 `jawcode/packages/stats/src/db.ts:214-228` (`/1_000_000` 단위 변환 포함);
  `aggregator.ts:368-389`는 집계일 뿐임(감사 blocker #6 반영).
- 캐시 반영 공식 확인: 표준형은
  `cost = (inputTokens − cacheRead) × input단가 + cacheRead × cacheRead단가
        + cacheCreation × cacheWrite단가 + outputTokens × output단가` — jawcode/OpenAI/Anthropic
  usage 필드 의미 차이(OpenAI `cachedInputTokens`은 input에 포함, Anthropic
  `cacheReadInputTokens`은 별도) 정리 필요.
  (감사 blocker #2 fold — HIGH) OpenCodex `OcxUsage.inputTokens`는 캐시 포함 총 prompt 토큰
  (`src/types.ts:227-244`)인 반면 jawcode 계산(`db.ts:214-228`)은 `tokens.input`에 input 단가를
  그대로 곱하고 cacheRead/cacheWrite를 별도 가산 — `cachedInputTokens`/`cacheReadInputTokens`/
  `cacheCreationInputTokens` → jawcode `input/cacheRead/cacheWrite`로의 정확한 변환 규칙
  (프로바이더 계열별: OpenAI형 vs Anthropic형)을 002의 필수 산출물로 강제.
- (감사 blocker #1 fold — HIGH) 모델ID 매칭 경로 정의: OpenCodex는 slash 모델을 alias/decode
  (`src/providers/slug-codec.ts:13-19`, `src/router.ts:256-258`)하는 반면 jawcode 룩업은 exact
  `Map.get()` (`jawcode/packages/ai/src/models.ts:37-50`, `stats/src/db.ts:193-215`).
  로그 엔트리의 `provider`/`model`/`resolvedModel`/`requestedModel`/`wireModelId` 중 무엇으로
  jawcode 키를 만들지 매칭 규칙 + 실측 매칭 성공률(카탈로그 대비)을 002에 포함.
- (감사 blocker #4 fold) combo: 최상위 `combo/*`+provider=combo로 기록되고 attempt 합산은
  단가 정보를 보존하지 않음 (`src/server/request-log.ts:436-466`, `609-655`) — attempt별
  비용 합산 방식 또는 표시 제외를 002에서 명시적으로 결정.
- (감사 blocker #3 fold) usage 부재/estimated/output=0 요청을 `$0`나 무한 toks/$로 표시하지
  않기 위한 표시 정책을 002 결론에 포함.
- 커버리지: OpenCodex 카탈로그 모델 중 jawcode cost가 있는 비율, cost=0(구독/OAuth 계열)
  모델 처리(표시 생략? "구독" 라벨?).
- 메타데이터 파이프라인: `generate-jawcode-metadata.ts`에 cost 4필드 추가 시 생성물 크기/형태.
- 표시: `$0.0123` + `toks/$` 2열 구성안, 어느 열이 유의미한지 (총토큰/$? 출력토큰/$?).

## 진행 방식

- B 단계: `gpt-5.6-terra` (reasoning medium, priority tier) 서브에이전트 **2개 병렬** 디스패치
  — lane 1 = Q1 (쓰기: `001_tok_speed_research.md`), lane 2 = Q2 (쓰기: `002_price_toks_per_dollar_research.md`).
  읽기 범위: opencodex `src/`, `gui/`, `scripts/`, jawcode `packages/ai/`, `packages/stats/` (읽기 전용).
  쓰기 범위: 본 유닛 폴더의 자기 문서 1건씩 (disjoint).
- C 단계: 메인이 두 문서의 경로/라인/수치 앵커를 스팟체크.
- D 단계: 요약 + 로컬 커밋. push 없음.

## IN / OUT

- IN: 조사 문서 001, 002. 실행 가능성 결론(가능/조건부/불가)과 구현 시 diff 지점 목록.
- OUT: 코드 변경, 테스트 추가, jawcode 저장소 수정, push.

## 수용 기준

- 001: tok/s 정의 2안(전체 벽시계 기준 / TTFT 분리 기준) 비교 + 계측 훅 후보 경로:라인 명시.
- 002: 캐시 반영 비용 공식이 jawcode 실계산 코드와 대조 검증됨 + 커버리지 수치 제시.
- 두 문서 모두 "가능한가?"에 명시적 결론 + 구현 시 변경 파일 목록.

---

# 260720 v2 — 구현 로드맵 (사용자 결정 확정 후)

조사(000-002) 완료 후 사용자와 확정한 정책. 이 섹션이 구현 사이클의 SSOT다.
작업 장소: 워크트리 `/Users/jun/Developer/new/700_projects/opencodex-toksdev`
(브랜치 `codex/toksdev`, dev 기반). goalplan slug:
`toksdev-tok-s-luna-usage-workspace-ttft-docs-fir`.

## 확정 정책

1. **가격은 전부 추정(~$)**: 정확 과금 재현이 아니라 추정 표시. `~$` 접두 통일.
   - 캐시 상세는 프로바이더 usage 그대로 사용 — 요청별 `cacheReadInputTokens` 등이
     이미 실측값이므로 "세션 첫 요청" 휴리스틱 불필요.
   - 캐시 상세 없는 응답: input 전액 상한 추정으로 `~$`.
   - cursor/kiro 추정 usage: `~$` 표시 유지.
   - 가격 자체를 못 찾은 것만 `—`.
   - 구독/OAuth cost=0 모델: expected 정가 환산 `~$` (003 오버레이 테이블).
   - 캐시 이중과금 금지: `input = I − R − W` 변환식(002 §2), native ID exact 매칭
     + `deriveJawcodeAliases()` 재사용, combo는 attempt별 단가 합산(002 §5).
   - 스냅샷 영속 없음: 표시 시점 계산.
2. **테이블 열은 2개만 추가**: `tok/s`(전체 duration 기준, jawcode/OpenRouter 관례)
   + `~$`. toks/$·TTFT·캐시 브레이크다운은 상세 팝업으로.
3. **상세 팝업 프로덕션급**: `status >= 400` 게이트 제거(모든 행 상세보기),
   기존 `LogDetailDialog` 그리드 확장 — tok/s, 비용 4분할, 매칭된 jawcode 키,
   combo attempt별 테이블, estimated/미매칭 사유, TTFT(계측 후).
4. **TTFT는 별도 계측 phase**: `firstOutputMs` one-shot (relay/bridge),
   비스트리밍/tool-only는 의도적 unset. 통념(NVIDIA/vLLM/OpenRouter)대로
   TTFT는 tok/s와 별도 지표로 팝업 표기, tok/s 정의는 바꾸지 않음.

## Work-phase 맵 (dependency 순)

각 WP는 독립 close gate(감사 blocker #1 fold)를 갖는다. 003/004는 WP0의 **산출물**이며
선행조건이 아니다(감사 blocker #2는 rebut — docs-only 사이클이 그 문서를 만든다).

| WP | decade 문서 | 내용 | 의존 | close gate (C에서 검증) |
|----|------------|------|------|------------------------|
| 0 | 003, 004 + 010/020/030/040 | docs-only: Luna 빈가격 조사(003), Usage/Workspace 표면 조사(004), 구현 decade 문서 diff-level 작성 | 000-002 | 문서 존재 + diff-level 검증(각 010-040에 NEW/MODIFY 경로와 before/after) + `git diff --stat`에 src/gui 변경 0 |
| 1 | 010 | 비용 코어: `generate-jawcode-metadata.ts` cost 4필드, `src/usage/cost.ts`(캐시 변환·exact 매칭·expected 오버레이·combo 합산), 단위 테스트 | WP0(003의 오버레이 테이블) | `bun run typecheck` + `bun test --isolate tests/usage-cost*` exit 0, Anthropic inclusive 이중과금 회귀 fixture 포함 |
| 2 | 020 | Logs 테이블 tok/s + ~$ 2열, i18n 4로케일, colSpan 8→10 | WP1 | typecheck + GUI 빌드 + 렌더 그라운딩 스크린샷(성공/estimated/미매칭 행) |
| 3 | 030 | 상세 팝업 프로덕션급 재설계: 게이트 해제 + 그리드 확장 + `/api/logs` attempts 노출·`LogEntry` 타입 계약(감사 blocker #4 fold) | WP1 | typecheck + 렌더 그라운딩(성공 행·combo 행·estimated 행 팝업 스크린샷 + 좁은 뷰포트 밀도 확인, 감사 blocker #7 fold) |
| 4 | 040 | TTFT 계측: `firstOutputMs` one-shot(relay/bridge), usage.jsonl/attempt 영속, /api/logs additive, 팝업 optional 표기 | **WP1의 로그 계약/영속 계층만** (WP3 전체 아님 — 감사 blocker #5 fold; 팝업은 optional 필드 부재에도 동작) | typecheck + 계측 테스트 + 실요청 usage.jsonl 라인 증거, 비스트리밍 unset 확인 |

추가 정책 확정(감사 fold):

- **부분 캐시 상세**(blocker #3): read만 오면 `W=0`, write만 오면 `R=0`으로 알려진
  부분만 적용해 계산한다. 전액 상한으로 올려치지 않는다 — 어차피 `~$` 추정 표시이고,
  알려진 값 무시가 더 큰 오차를 만든다. `R+W > I`인 모순 데이터만 `—`(002 §2 유지).
  WP1 테스트에 read-only/write-only fixture를 포함한다.
- **combo GUI 계약**(blocker #4): `/api/logs`는 이미 `attempts`를 포함하므로(서버 타입
  `RequestLogEntry.attempts`) GUI `LogEntry`에 optional `attempts` 타입을 추가하는 것은
  WP3의 명시 작업 항목이며 030 문서에 diff로 기재한다.
- **앵커 정정**(blocker #6): `bridgeToResponsesSSE`는 `src/bridge.ts:66` 시작,
  event loop는 `:407-430`. 001 문서의 `src/bridge.ts:213-215` 인용은 reasoning 상태
  변수 위치였다. 040 작성 시 fresh 앵커로 재검증한다.

빈 가격 조사(003)에서 확정 못 한 단가는 unverified로 남기고 fail-closed(`—`).
Usage/Workspace 구현은 004 조사 결과에 따라 WP5+로 append (LOOP-UNIT-CHAIN-01).

## SSOT 조정 노트 (WP0 D에서 확정)

- **unverified 오버레이 충돌 해소 (v3, WP1 A 재감사 반영)**: `ExpectedPriceStatus`는
  `verified | verified-derived | unverified` 3상태이되, **resolver
  (`findExpectedPriceOverlay`)가 unverified를 아예 반환하지 않는다** — fail-closed(`—`)를
  문서 규율이 아니라 코드로 강제한다. 등재는 003 §4의 verified 4쌍 + verified-derived
  7쌍(계 11쌍)만. verified-derived는 `estimated=true`로 전파된다. 후속 재조사(003 §5)로
  verified 승격 시에만 행이 추가된다.
- **legacy cachedInputTokens 모호성 (WP1 A 재감사 반영)**: canonical 계약
  (`cachedInputTokens`=read)을 우선 해석하고, 그 해석이 `R+W>I` 모순일 때만 legacy
  (read+write 합산형, devlog 070) 복원(cached−creation)을 재시도, 재시도도 모순이면
  `null`. 두 형태는 필드만으로 구별 불가하다는 재감사 지적의 절충안.
- **verified-derived**(suffix→기반 모델 매핑, 예: gemini-3.5-flash-high)는 오버레이에
  등재하되 `source`에 derived 근거를 남기고 GUI 상세에서 표시한다.
- **WP5+ append 예고**(004): WP5 backend(summary.ts 비용/속도 집계), WP6 Usage 페이지,
  WP7 Dashboard 카드, WP8 Provider Workspace — 004 조사대로 goalplan에 append 예정.
