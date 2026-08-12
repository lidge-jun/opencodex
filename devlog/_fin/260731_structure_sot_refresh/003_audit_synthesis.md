# 003_audit_synthesis — A 감사 1라운드 종합

감사 2026-07-31, 독립 리뷰어(다른 모델 계열). 판정 `FAIL`, 블로커 14건.
드리프트 판정 18건(S1–S9, I1–I9)은 전부 독립 확인됨. 문제는 **제가 쓴 AFTER 텍스트**였다.

## 근본 원인

한 가지 패턴이 블로커 대부분을 만들었다: **하위 에이전트 요약을 근거로 새 불변 조건을 썼다.**
드리프트 판정은 각 항목마다 코드를 재확인했지만, 교체 문안을 쓸 때는 "이 정도면 맞겠지" 수준의
일반화를 넣었다. `restore exists for anything cleanup moved`, `IDs never reach the GUI`,
`artifacts are never re-fetched`, `Google imports only abort/sleep helpers` — 넷 다 확인하지 않은 단언이다.

교훈: SOT 문서에 넣을 불변 조건은 드리프트 판정과 같은 강도로 검증해야 한다.
"고치는 문장"이 "고쳐지는 문장"보다 느슨하면 순수 손실이다.

## 블로커별 처리

| # | 블로커 | 처리 | 근거 재확인 |
|---|--------|------|------------|
| 1 | 라우트/상태파일 카운트 재현 불가 | 수용. 측정을 `scripts-in-doc`에서 단일 정본 스크립트로 교체하고 숫자를 재측정 | 아래 §측정 정본 |
| 2 | 상태 파일 표의 경로 오류 | 수용. `.opencodex-owner.json`/`.opencodex-uninstall.json`은 OpenCodex 설정 루트 소유(`src/lib/config-ownership.ts:16-17`). **R2에서 정정됨**: `$CODEX_HOME` 쪽은 journal 하나가 아니라 `src/codex/paths.ts:26-30`의 `config.toml`, `opencodex.config.toml`, `opencodex-catalog.json`, `models_cache.json` + `src/codex/journal.ts:8`의 journal이다 | 확인 |
| 3 | product boundary가 provider table 주장 유지 + Live 오분류 | 수용. 기본 경로는 루트 키만 쓴다. Live는 어댑터 파이프라인이 아니라 OpenAI 릴레이(`src/server/live.ts:465` `resolveLiveRelay`) | 확인 |
| 4 | web-search 백엔드 선택 오서술 | 수용. `src/web-search/index.ts:97-105` — 명시 설정만 anthropic을 고르고 미설정은 항상 openai. 자격증명 기반 자동선택은 vision 전용 | 확인. 코드 주석에 자동선택이 회귀였다는 기록까지 있다 |
| 5 | `@main`은 공개 selector가 아님 / generation 충돌은 throw | 수용. `@main`은 config 전용 sentinel(`account-namespace-match.ts:3-4`), 공개 selector는 `claimNamespace("main", used)`(`account-namespaces.ts:93`). 충돌 시 `CodexCredentialGenerationConflictError`(`account-store.ts:420-423`) | 확인 |
| 6 | cleanup restore / account id 단언 오류 | 수용. `mode: "permanent"`가 허용됨(`logs-usage-routes.ts:281`). account id는 GUI로 직렬화됨(마스킹 대상은 이메일) | 확인 |
| 7 | 워크플로 트리거 부정확 | 수용. `service-lifecycle.yml:3-27`은 PR+push 7경로, `enforce-pr-target`/`pr-labeler`는 `pull_request_target`, `react-doctor`는 GUI 경로 필터 없음 | 확인 |
| 8 | devlog 정책 불변 조건이 거짓 | 수용, 그리고 이게 가장 중요하다. `tests/repo-hygiene.test.ts:96-100,161-178`이 devlog를 읽는다. **`AGENTS.md`의 원문(`:47`)이 틀렸고 내 계획이 그것을 복사했다.** **R2에서 정정됨**: 읽는 주체는 두 개가 아니라 `privacy:scan`과 두 개의 릴리스 게이트 스크립트를 포함한다. 문서를 코드에 맞추고, `AGENTS.md` 정정은 이 유닛 범위 밖이므로 후속으로 기록 | 확인 |
| 9 | `_fin` 승격이 no-push 범위와 모순 | 수용. `AGENTS.md:39-42`는 `_fin`을 "이미 공개 git 히스토리에 보이는 작업의 기록"으로 정의한다. 로컬 커밋은 그 조건을 만족하지 않는다. `_plan` 유지 | 확인 |
| 10 | 놓친 드리프트: `05:153` "Missing usage is never zero" | 수용. `tests/api-usage.test.ts:218-227`은 `usage.jsonl` 부재 시 0 요약을 요구한다. 인벤토리에 S10으로 추가 | 확인 |
| 11 | GUI 내비게이션 불변 조건 과대주장 | 수용. rail 선택은 컴포넌트 로컬 상태다. 해당 불변 조건 문장 삭제 | 확인 |
| 12 | transport 표의 발명된 절대 서술 | 수용. `src/images/fulfill.ts:74-85`가 provider URL을 아티팩트로 다운로드한다. `google-http.ts:1-11`은 wire 복구·에러 정규화도 임포트한다 | 확인 |
| 13 | S8 교체 문안이 여전히 검증 불가 | 수용. 외부 방법론 주장 자체를 제거하고 저장소 내 규율 서술만 남긴다 | — |
| 14 | phase 의존성이 장식적 / WP6이 diff-level 아님 | 부분 수용. WP1→WP2 의존은 실제로 약하다(상태 파일 어휘를 WP2가 소비하지 않는다). WP1/WP2/WP3/WP5를 독립 트랙으로 재선언하고, WP4만 WP2·WP3 뒤에 둔다(사이드카/설정 라우트 의미를 소비). WP6은 감사 전용으로 축소 | — |

반박 없음. 14건 전부 수용한다.

## 측정 정본

블로커 1의 지적이 맞다: 문서마다 다른 `rg` 형태를 쓰면 숫자가 재현되지 않는다.
이 유닛의 모든 라우트/경로 측정은 `004_measure.sh` 한 곳을 쓴다.
재측정 결과(2026-07-31, 작업 트리):

```
$ bash devlog/_plan/260731_structure_sot_refresh/004_measure.sh
registered_route_literals  90
documented_route_literals  25
doc_only_routes             0
dead_paths                  0
brace_paths                 0
undocumented_dirs           9
initial_owned_paths        36 (NOT the total state-file count)
```

즉 **등록된 고유 `/api` 경로 리터럴 90개, `structure/` 전체가 언급하는 것 25개.**
`documented_routes`는 `05` 한 문서가 아니라 `structure/` 전체를 센다 — 라우트는 `01`과 `04`에도
등장한다. 이 숫자는 메서드/경로 쌍이 아니라 경로 리터럴 기준이며, 접두 매칭 라우트
(`/api/codex-auth/`)를 한 개로 센다. `001_drift_inventory.md`의 "74 / 24"는 폐기한다.
`initial_owned_paths`는 소유 매니페스트의 **초기 목록**이며 전체 상태 파일 수가 아니다
(매니페스트는 런타임에 자란다).

## 후속으로 넘기는 것

- `AGENTS.md:47`의 "Nothing in the build, typecheck, or test path reads from `devlog/`"는 거짓이다.
  `tests/repo-hygiene.test.ts`가 읽는다. 이 유닛은 `structure/`만 고치므로 별도 유닛으로 남긴다.
- `structure/05:153`의 usage 서술은 S10으로 이 유닛에서 고친다(문서 수정 범위 내).

## 부록 — 유닛 측정 스크립트

`004_measure.sh`로 유닛에 넣는다(번호 접두사 규약 — LEXICO-SPLIT-01). 인벤토리(WP0)와 마감(WP6)이 같은 스크립트를 쓴다.

---

## A 감사 2라운드 (R2) — FAIL, 블로커 14건

R1의 14건은 전부 반영했고 드리프트 판정 18건은 다시 확인되었으나, R2가 새 블로커 14건을 찾았다.
**같은 실패 계열이 두 번 연속**이다: 교체 문안이 검증되지 않은 절대 서술·셋 크기 주장을 넣었다.

LOOP-REPAIR-01에 따라 개별 문장 패치를 멈추고 근본 원인을 잡았다:
`000_plan.md`에 **서술 계약(WRITE-CONTRACT)** 7개 항을 고정했다. R1·R2 블로커를 계열로 묶으면
7개 항이 11건을 커버한다. 3라운드에서 같은 방식으로 실패하지 않게 하는 것이 목적이다.

| # | R2 블로커 | 처리 |
|---|----------|------|
| 1 | `owned_state_files 35`가 소유 인벤토리가 아님 | 지표명을 `initial_owned_paths`로 바꾸고 "총계 아님"을 스크립트 출력과 문서 양쪽에 박았다. 근거: `src/lib/config-ownership.ts:243`(매니페스트 증가), `src/oauth/store.ts:175`(파생 백업), `src/codex/paths.ts:26-30`($CODEX_HOME 4종) |
| 2 | 상태 루트 삭제 = 복구라는 보장이 위험 | 삭제 보장 문장을 제거하고 `$CODEX_HOME` 쓰기와 restore/eject·journal을 명시. 근거: `src/codex/inject.ts:595`, `src/codex/journal.ts:8` |
| 3 | Claude Messages를 무조건 번역으로 서술 | 라우팅 경로는 번역, `wantsNativePassthrough` 분기는 예외로 분리. 근거: `src/server/claude-messages.ts:569` |
| 4 | "thread history is never remapped" | loopback이 `migrateHistoryToOpenai()`를 부른다. 신규는 네이티브 유지, 과거 재태그분은 1회 역마이그레이션으로 정정. 근거: `src/codex/inject.ts:601` |
| 5 | provider workspace에 없는 `Auth` 탭 발명 | 실제 탭(Overview/Models/Usage/[Accounts\|API Keys]/Settings)으로 교체. 근거: `gui/src/components/provider-workspace/ProviderDetails.tsx:99-105` |
| 6 | 검증기 범위보다 넓은 수용 기준 | `004_measure.sh` 헤더에 증명/비증명 범위를 명시하고 수용 기준을 그 범위로 축소. 경로는 루트 기준 완전 경로만 쓰도록 하고 중괄호 축약 검사(`brace_paths`)를 추가 |
| 7 | 카운트가 문서마다 불일치 | 모든 카운트를 HEAD `286d24cbf` 스냅샷 하나로 재생성. `documented_routes`가 `05` 단독이 아니라 `structure/` 전체 기준임을 명시. 74/24 잔재 제거 |
| 8 | `002`에 `@main` 오서술 잔존 | 인벤토리 행도 selector/sentinel 구분으로 수정(계약 6항: 인벤토리와 decade 문서를 함께 고친다) |
| 9 | devlog 독자 "정확히 두 개" 주장 | 릴리스 게이트 스크립트 2개가 더 읽는다. 이름으로 지목하고 개수 주장을 제거. `AGENTS.md` 인용도 `:36` → `:47`로 정정. 근거: `scripts/openai-provider-option-runtime-smoke.ts:43`, `scripts/openai-provider-option-final-gates.ts:114` |
| 10 | WP4의 남은 선행도 장식 | 수용. WP1~WP5 전부 독립 트랙으로 재선언. 용어 일관성은 순서가 아니라 서술 계약 6항이 담보한다 |
| 11 | WP6이 정본 아님 + diff-level 아님 | 폐기된 임시 루프 제거, Reading order를 축자 AFTER 행으로 제시(`03` 행 추가), 결정 기록은 `070_closeout.md`로 |
| 12 | `scripts/measure.sh`가 LEXICO-SPLIT-01 위반 | `004_measure.sh`로 이름 변경, 참조 전부 갱신, `scripts/` 디렉터리 제거 |
| 13 | `00:4` historical 위치 + `03` Reading order 누락 | S13으로 인벤토리에 추가하고 WP1 D9로 배치. `03` Reading order 행을 WP6 D2에 축자로 추가 |
| 14 | `03` 카탈로그 해시 백업 누락 | S12로 인벤토리에 추가하고 WP2 D7에 축자 AFTER로 배치. 근거: `src/codex/catalog/parsing.ts:36,40,427` |

반박 없음. 14건 전부 수용. STALE 총계는 13(S1–S13)으로 갱신됐다.

---

## A 감사 3라운드 (R3) — FAIL, 블로커 11건 (Critical 1)

R2의 14건은 전부 반영됐고 서술 계약도 자리를 잡았지만, R3가 **내 판정 하나를 뒤집었다.**
이게 이 라운드에서 가장 중요한 결과다.

**Critical: S13은 STALE이 아니다.** `00_overview.md:4`의 "historical investigations belong in
`docs/`"는 `docs/README.md:1-8`이 스스로 "investigations and diagnostic notes"를 담는다고 선언하므로
반박되지 않는다. 내가 `AGENTS.md`의 devlog 정책만 보고 기존 서술을 틀렸다고 판정했다.
STALE로 처리하면 **맞는 문서를 틀리게 고치는** 결과가 됐다 — A 감사가 막아야 하는 바로 그 사고다.
I10으로 강등하고, 교체 문안도 "`docs/`는 옛 자료"라는 새 허위 주장을 뺐다.
STALE 12 / IMPRECISE 10으로 재집계.

| # | R3 블로커 | 처리 |
|---|----------|------|
| 1 | **Critical** S13 오판 | I10으로 강등. 근거: `docs/README.md:1-8`. `000`/`001`/`003`/`010` 카운트와 문안 갱신 |
| 2 | I7 조건이 여전히 틀림 | `src/codex/catalog/sync.ts:507-512`의 `enabledProviders.length === 0 || hasCanonicalOpenai` — 활성 프로바이더 0이면 부트스트랩 행이 남는다(#636). 두 갈래를 그대로 서술 |
| 3 | vision 백엔드에 명시 override·fail-closed 누락 | `src/vision/index.ts:113`(명시가 우선), `:172`(명시 anthropic인데 권한 없으면 `undefined` — 폴백 안 함). 표와 인벤토리 양쪽 수정 |
| 4 | WP4의 WP2·WP3 선행이 아직 남아 있음 | 수용. `src/server/management/config-routes.ts:315`는 사이드카 설정을 읽고 쓸 뿐이다. WP4도 `선행: WP0만`으로 바꿔 WP1~WP5 전부 독립 |
| 5 | `codex-runtime*.json`을 프로세스 identity로 분류 | `src/codex/runtime.ts:73`(선택된 실행 파일 상태), `:92`(effort clamp 진단). 별 행으로 분리하고 "다음 시작 시 재생성" 보장 제거 |
| 6 | "메서드/형태 불일치 0건"이 `001`에 남음 | 검증기가 증명하지 않는 주장이므로 제거. 개별 확인한 `PUT /api/config` 405만 남긴다 |
| 7 | 서술 계약 3항 위반 잔존 | `account-namespace-match.ts`, `AddProviderModal.tsx`, `OAuthTosWarningModal.tsx`, `google-http.ts` 등 전부 루트 기준 완전 경로로 교체. `004_measure.sh` 주석의 오기(`src/chat/`을 무효로 표기)도 수정 |
| 8 | 근거 없는 절대어 잔존 | "stale record must recover on its own" → 업데이트 레코드의 PID 회복으로 한정. "never silently upgrades effort" → `src/server/effort-policy.ts:142,168`의 "lowers or preserves"로. "badge never blocks" → advisory 서술로 |
| 9 | `001`/`002`가 측정된 미기재 디렉터리 9개 중 7개만 요약 | `src/claude/`, `src/grok/`를 §A와 요약에 추가 |
| 10 | 브랜치 정책이 stacked-PR 예외를 누락 | `AGENTS.md:119` — 열린 부모 PR의 head를 대상으로 하는 stacked child는 의도된 워크플로다. 예외를 명시 |
| 11 | R1 표의 두 행이 R2 정정 이전 서술 유지 | 두 행에 **R2에서 정정됨**을 달고 `AGENTS.md` 인용을 `:47`로 수정 |

반박 없음. 11건 전부 수용. R3가 확인한 것: S1–S12는 유효, I1–I6·I8·I9도 유효, 측정값 재현
(`90 / 25 / 0 / 0 / 0 / 9 / 36`), WP6는 감사 전용·축자 diff로 인정.

---

## A 감사 4라운드 (R4) — GO-WITH-FIXES, 블로커 4건 (전부 Medium)

리뷰어 교체(1~3라운드 리뷰어가 용량 한계로 중단 → 다른 모델 계열의 새 리뷰어).
R3의 11건은 전부 확인되었고, 드리프트 판정 22건(S1–S12, I1–I10)도 재확인됐다.
측정값 재현: `90 / 25 / 0 / 0 / 0 / 9 / 36`. Critical/High 0건.

| # | R4 블로커 | 처리 |
|---|----------|------|
| 1 | `000_plan.md`에 "IMPRECISE 9건" 잔재 | 중복 수용 기준 줄을 삭제(바로 위 줄이 이미 12/10을 명시한다) |
| 2 | `070_closeout.md`가 편집 대상에 없는데 WP6이 만든다 | `060`의 편집 대상에 명시적으로 추가 |
| 3 | `020` 헤더가 "WP4가 참조"를 유지 | 상호 참조 주장 제거. WP1~WP5는 서로를 소비하지 않고, 용어 일관성은 서술 계약 6항이 담보한다 |
| 4 | 자기점검이 살아남은 절대어를 다 열거하지 않음 | `030`/`040`/`050`의 자기점검을 표로 바꿔 문안별 근거를 전부 적었다. 확인 과정에서 `eleven pages`가 `gui/src/App.tsx:50-62`의 `NAV` 11항목과 일치함을 검증했다 |

반박 없음. 4건 전부 수용. 이 라운드에서 A 게이트를 통과한다(near-pass):
잔여는 전부 문서 내부 일관성 항목이고 `structure/` 서술을 틀리게 만들 항목은 없다.
