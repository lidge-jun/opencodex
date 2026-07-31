# PR 상세 인벤토리 — 2026-07-22

## #215 — fix(responses): strip mismatched agent_message item ids

- 저자: robin-main-hub | base: dev | +3/-0, 2 files
- 생성: 2026-07-21T13:41 | 상태: MERGEABLE

### 변경 내용

`stripInvalidItemIds`의 `validPrefixes` 맵에 `agent_message → amsg_` 추가.
dialect-mixed thread history에서 `msg_` prefix를 가진 agent_message가
Responses API 400을 일으켜 스레드가 영구 브릭되는 문제 수정.

### diff 검증

- `src/adapters/openai-responses.ts`: validPrefixes에 한 줄 추가 — 정확
- `tests/openai-responses-passthrough.test.ts`: mismatch strip + valid preserve 2케이스 추가
- production에서 2개 Codex app 스레드 브릭 확인됨 (PR 설명)

### 판정: MERGE-READY (LOW)

최소 변경, 명확한 버그 수정, 테스트 충분. 충돌 없음.

---

## #219 — fix(winsw): detect sc.exe error 1060 under Bun truncation

- 저자: Wibias | base: dev | +34/-4, 2 files
- 생성: 2026-07-21T17:07 | 상태: UNKNOWN

### 변경 내용

Windows SCM probe에서 두 가지 함정 수정:
1. Bun이 exit code를 8비트로 잘라서 1060 → 36이 됨
2. sc.exe가 FAILED prefix를 로컬라이즈 (pt-BR FALHA, de-DE FEHLER)

해결: 숫자 코드 `1060`을 word boundary로 매칭 (`/\b1060\b/`).
e.message를 스캔 대상에서 제외 (false positive 방지).
Buffer 디코딩 추가.

### diff 검증

- `src/lib/winsw.ts`: e.message 제외, Buffer.toString(), `\b1060\b` regex — 정확
- `tests/winsw.test.ts`: Bun truncation, 로컬라이즈, word boundary, Buffer 7케이스 추가
- 기존 bug sweep devlog(260722_issue_bug_sweep/002_rca_w_windows_1060.md)와 일치

### 판정: MERGE-READY (LOW)

우리 쪽 bug sweep에서 이미 RCA 완료된 이슈의 커뮤니티 수정. 구현이 RCA와 일치.

---

## #224 — fix(adapters): forward prompt_cache_key through openai-chat

- 저자: Wibias | base: dev | +42/-0, 5 files
- 생성: 2026-07-21T19:54 | 상태: UNKNOWN

### 변경 내용

Responses parser가 `promptCacheKey`를 `options.promptCacheKey`에 쓰지만,
openai-chat adapter의 `buildRequest()`가 이걸 outbound body에 복사하지 않음.
provider opt-in 방식(`promptCacheKey: boolean`)으로 전달.

### diff 검증

- `src/adapters/openai-chat.ts`: provider.promptCacheKey gate + body.prompt_cache_key — 정확
- `src/providers/registry.ts`: registry entry에 promptCacheKey 필드 추가
- `src/router.ts`: parallelToolCalls와 동일한 backfill 패턴
- `src/types.ts`: OcxProviderConfig에 필드 + JSDoc
- `tests/openai-chat-hardening.test.ts`: opt-in 전달 + opt-out 미전달 2케이스
- strict backend(Groq, Cerebras) 보호를 위한 opt-in 설계 — 좋음

### 판정: MERGE-READY (LOW)

기존 parallelToolCalls 패턴을 정확히 따름. opt-in이라 기존 동작 변경 없음.

---

## #211 — fix(i18n): complete RU parity with dev en.ts

- 저자: AnyCPU | base: dev | +161/-13, 6 files
- 생성: 2026-07-21T12:09 | 상태: UNKNOWN

### 변경 내용

#207(RU 로컬라이제이션) 병합 후 dev의 en.ts에 13개 키 추가 + 5개 수정이
발생해서 ru.ts가 Record<TKey, string> 타입 에러로 GUI 빌드 실패.
누락 키 추가 + 재번역 + RU 문서 동기화.

### diff 검증

- `gui/src/i18n/ru.ts`: 13개 키 추가, 5개 재번역 (cost estimate 뉘앙스 보존)
- `README.ru.md`, `docs-site/.../ru/`: CLI account 섹션, disclaimer 추가
- `gui/src/i18n/frontier-i18n.ts`: stale 헤더 코멘트 수정
- PR 설명에서 `cd gui && bun run build` 통과 주장 — 이게 핵심 검증

### 판정: MERGE-READY (LOW)

dev GUI 빌드 깨짐을 수정하는 긴급 수정. 다른 PR(#221)도 ru.ts를 건드리지만
#211이 먼저 병합되면 #221에서 충돌 해결.

---

## #225 — ci: enforce issue quality for feature requests

- 저자: Wibias | base: dev | +453/-1, 3 files
- 생성: 2026-07-21T20:01 | 상태: MERGEABLE

### 변경 내용

GitHub Actions 워크플로우로 low-quality feature request 자동 클로즈.
빈/짧은 섹션, 반복 텍스트, 제목만 있는 body 감지.
trusted contributor(OWNER/MEMBER/COLLABORATOR) 면제.
blank_issues_enabled: false로 구조화 폼 우회 차단.

### 리스크

- false-positive: 짧지만 유효한 feature request가 클로즈될 수 있음
- 커뮤니티 정책 결정사항 — maintainer 판단 필요
- `actions/github-script@v9` 사용, checkout 없음 (코드 실행 없음) — 보안 OK
- concurrency group으로 race condition 방지 — 좋음

### 판정: MERGE-WITH-FIXES (MEDIUM)

기술적으로는 문제없으나 정책 결정 필요. threshold tuning 여지.

---

## #221 — fix(oauth): do not persist needsReauth across restarts

- 저자: Wibias | base: dev | +4434/-185, 90 files
- 생성: 2026-07-21T18:07 | 상태: UNKNOWN

### 변경 내용 (설명 기준)

`needsReauth`를 disk-persisted에서 in-memory Set으로 전환.
Windows 부팅 시 네트워크 미就绪 상태에서 첫 refresh 실패가
영구적으로 needsReauth=true를 disk에 써서 OAuth 계정이 브릭되는 문제 수정.

### 실제 diff 분석 — 범위 초과

90개 파일 중 needsReauth 관련은 약 10개:
- `src/oauth/store.ts` (핵심 수정)
- `src/oauth/index.ts`
- `src/oauth/anthropic.ts`
- `src/oauth/local-token-detect.ts`
- `tests/oauth-store-multi.test.ts`
- `tests/oauth-refresh.test.ts`
- `tests/oauth-provider-reconcile.test.ts`

나머지 80+ 파일은 무관한 변경:
- devlog 파일들 (260722_gemini_36_rollout, 260721_sidebar_diet, 260722_issue_bug_sweep)
- GUI: App.tsx, ComboWorkspace.tsx, Debug.tsx, Logs.tsx, Models.tsx, styles.css
- i18n: de.ts, en.ts, ko.ts, ru.ts, zh.ts
- combo: combos/index.ts, combos/request.ts, combos/types.ts
- cursor: cursor/discovery.ts
- google: google.ts, antigravity-models.ts
- catalog: codex/catalog.ts, codex/routing.ts
- server: relay.ts, request-log.ts, responses.ts
- 기타: winsw.ts, types.ts, registry.ts, expected-prices.ts

이건 여러 작업이 하나의 PR에 섞인 것. needsReauth 수정 자체는 타당하지만
나머지 변경은 별도 PR로 분리해야 함.

### 판정: NEEDS-REWORK (HIGH)

scope 분리 필수. needsReauth 핵심만 cherry-pick하거나 분리 PR 요청.

---

## #223 — fix(codex): clamp reasoning efforts to installed binary

- 저자: Bricol1982 | base: main | +186/-5, 3 files
- 생성: 2026-07-21T19:24 | 상태: UNKNOWN

### 변경 내용

Codex 0.133.0의 `ReasoningEffort` enum이 `xhigh`에서 끝나는데,
opencodex가 `max`/`ultra`를 mock해서 catalog 전체 파싱 실패.
설치된 바이너리의 bundled catalog에서 지원 effort를 읽어 clamp.

### diff 검증

- `src/codex/catalog.ts`:
  - `codexSupportedReasoningEfforts()`: bundled catalog에서 effort set 추출
  - `clampEntryToCodexSupportedEfforts()`: entry별 rung 필터 + default repair
  - `clampCatalogModelsToCodexSupport()`: emission boundary guard
  - `loadCatalogForSync`: deep-clone으로 cache poisoning 방지 — 좋은 발견
  - `syncCatalogModels`: clamp 적용
- self-adapting: 새 Codex가 max/ultra 지원하면 clamp 안 함
- safe fallback: codex 없으면 no-op
- 6개 regression test 추가 주장

### 리스크

- base가 main인데 dev의 catalog.ts와 충돌 가능
- `codex debug models --bundled` 호출 성능 (매 sync마다)
- Claude Code 생성 PR — 코드 품질은 높지만 통합 검증 필요

### 판정: MERGE-WITH-FIXES (MEDIUM)

base를 dev로 변경 요청. 설계는 정확하고 self-adapting.

---

## #220 — feat: add Gemini 3.6 Flash and 3.5 Flash-Lite

- 저자: HaydernCenterpoint | base: main | +33/-3, 5 files
- 생성: 2026-07-21T17:49 | 상태: UNKNOWN

### 변경 내용

Gemini 3.6 Flash, 3.5 Flash-Lite catalog 추가.
Antigravity wire model (low/medium/high) 노출.
1,048,576 token context window.

### 판정: MERGE-READY (LOW)

단순 catalog 추가. 독립적. dev 경유 또는 main 직접.

---

## #213 — fix(gui): expose private-network opt-in for presets

- 저자: apple-ouyang | base: main | +13/-5, 2 files
- 생성: 2026-07-21T12:30 | 상태: UNKNOWN

### 변경 내용

built-in provider preset에도 `allowPrivateNetwork` 체크박스 표시.
DeepSeek/Clash fake-IP regression 커버.

### 판정: MERGE-READY (LOW)

소형 GUI 수정. 기존 bug sweep(003_rca_n_allow_private_network.md)과 일치.

---

## #214 — feat: rename combos + custom public model name

- 저자: eachann1024 | base: main | +1028/-76, 24 files
- 생성: 2026-07-21T12:42 | 상태: UNKNOWN

### 변경 내용

combo rename + alias 기능. `combo/<id>` 대신 bare name(`deepseek-v4-flash`)으로
combo를 노출. rename은 atomic, disabledModels/subagentModels 참조 마이그레이션.

### 리스크

- catalog, routing, log, GUI에 걸치는 광범위한 변경
- alias collision shadowing 로직 검증 필요
- `owned_by: "combo"` marker로 stale alias GC — 새로운 catalog 필드
- 테스트 202개 통과 주장하나 통합 검증 필요

### 판정: MERGE-WITH-FIXES (MEDIUM)

기능은 완전해 보이나 dev에서 통합 테스트 후 병합. base 변경 요청.

---

## #226 — Redesign provider setup + Codex restart

- 저자: HaydernCenterpoint | base: main | +875/-198, 19 files
- 생성: 2026-07-21T20:33 | 상태: MERGEABLE

### 변경 내용

Provider 페이지를 OAuth/API 섹션으로 분리. connected account만 표시.
검색 가능한 provider picker. restart 엔드포인트. model sync.

### 리스크

- 기존 provider-workspace 전체 재설계 — 회귀 위험
- restart 엔드포인트 (management API origin check) — 보안 검증 필요
- 4개 언어 로컬라이제이션 — #211(ru)과 충돌 가능
- "intentionally isolated from unrelated work" 주장하나 검증 필요

### 판정: NEEDS-REWORK (HIGH)

dev 경유 필수. 기존 provider-workspace와 상호작용 깊이 검증.
restart 엔드포인트 보안 리뷰.
