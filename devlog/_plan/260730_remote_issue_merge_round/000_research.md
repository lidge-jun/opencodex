# 000 — 2026-07-30 원격 머지 라운드: 후보 선별과 근거

## 목적

열린 PR 24건 / 이슈 39건 중에서 **지금 머지해도 안전한 3건**을 골라 랜딩하고,
"모델 추가 / 에포트 추가" 계열로 들어온 후보 하나는 전제가 틀렸으므로 올바른
형태로 교정한 뒤 닫는다. 사용자 요청은 "모델 추가나 에포트 추가 이런것부터
시작하면 좋을듯" — 즉 저위험 카탈로그성 변경 우선.

## 선별 스냅샷 (2026-07-29 ~ 07-30, `gh` 실측)

`gh pr list --state open` 24건. 후보 판정에 쓴 축은 세 개다.

| 축 | 확인 명령 | 왜 중요한가 |
|----|-----------|-------------|
| 타겟 브랜치 | `gh pr view <n> --json baseRefName` | AGENTS.md: 모든 PR은 `dev` 타겟. `main` 타겟은 `enforce-target`이 거부 |
| 머지 가능성 | `gh pr view <n> --json mergeStateStatus,isDraft,reviewDecision` | draft / CHANGES_REQUESTED / DIRTY는 즉시 머지 불가 |
| CI 실체 | `gh pr checks <n>` + `gh api .../actions/jobs/<id>` | `gh pr checks`의 `fail`이 실제로는 `cancelled`인 경우가 있다 (아래 참조) |

### 최종 후보와 순위

| 순위 | PR | 성격 | 상태 | 판단 |
|------|----|------|------|------|
| 1 | #711 | Claude Messages 브리지 data-only SSE 수용 (버그픽스) | `MERGEABLE`, non-draft, CI 8/9 + 1 cancelled | 가장 깨끗함 |
| 2 | #646 | `cursor/kimi-k3` low/high/max 에포트 티어 추가 | draft, `CHANGES_REQUESTED`, P2 2건 | 사용자가 원한 "모델/에포트 추가". 한 줄 보강 필요 |
| 3 | #652 | bounded model discovery contract | `CLEAN` + `APPROVED` + CI 전항목 green | 유일한 완전 green |
| — | #706 | MiniMax-M3 메타데이터 갱신 | `main` 타겟, `enforce-target` fail | **전제 오류** — 교정 후 클로즈 |

### 탈락시킨 주요 후보

- **#610** (`fix(catalog)`: `codex --version` 프로브 재생성 중단): `ubuntu-latest`와
  `windows-latest`가 **실제 Test 스텝 실패**. `gh api .../jobs/90505714532/logs`에서
  `error: EEXIST: file already exists, epoll_ctl`와
  `Cannot call afterEach() after the test run has completed` — Bun 테스트 러너 크래시.
  cancelled가 아니라 진짜 fail이므로 이번 라운드 제외.
- **#653** (Baseten preset): `windows-latest` fail + #652 선행 의존. #652가 먼저다.
- **#562** (Modelsell preset): draft, 리뷰 0건. 본문이 `prepush` 미완료를 자진 신고.
- **#611** (Volcengine Ark): `CHANGES_REQUESTED` 미해소.
- **#707** (security hardening, +7248/-548, 80파일): draft + 보안 경계. MAINTAINERS.md
  기준 명시적 보안 리뷰 대상이라 이번 라운드 범위 밖.

## `gh pr checks`의 fail ≠ 실패 (중요한 함정)

#711은 `gh pr checks 711`에서 `windows-latest fail 12m9s`로 보이지만:

```
gh api repos/lidge-jun/opencodex/actions/jobs/90673729420 --jq '[.name,.conclusion]'
→ windows-latest  cancelled
```

워크플로 런 자체(`30480687886`)의 결론도 `cancelled`다. 즉 코드가 깨진 게 아니라
런이 취소된 것이고, 나머지 8개 체크(ubuntu / macos / npm-global ×3 / react-doctor /
enforce-target / label)는 전부 `success`다. **`gh pr checks`만 보고 fail로 분류하면
정상 PR을 떨어뜨린다** — 이번 라운드에서 얻은 재사용 가능한 교훈.

검증 명령 (재사용):

```bash
gh api "repos/lidge-jun/opencodex/commits/<sha>/check-runs?per_page=40" \
  --jq '.check_runs[]|[.name,.conclusion]|@tsv' | sort
```

## #711 — data-only Responses SSE

이슈 #700. `src/claude/outbound.ts`의 `responsesSseToAnthropicSse()`가
`if (!eventName || !dataLine) continue;`로 **`event:` 줄이 없는 프레임을 버린다.**
버린 뒤 EOF에 도달하면 터미널 프레임을 못 봤으므로 truncation으로 처리한다.

외부 근거가 이 PR 손을 들어준다:

- WHATWG HTML SSE 스펙: `event` 필드가 없는 프레임은 **유효한 `message` 이벤트**다.
  `event:`는 옵셔널 필드이며 그 부재가 프레임 무효를 의미하지 않는다.
- OpenAI 파이썬 SDK도 SSE `event` 필드가 아니라 **디코드된 JSON의 `type`으로
  라우팅**한다. Responses 프레임의 `type`은 required 필드다.

즉 데이터-온리 프레임은 정상 트래픽이고 우리 파서가 과하게 엄격했다. 수정은
`eventName || data.type`으로 이벤트명을 해석하는 3줄이고, 테스트 2케이스가 붙었다.

## #646 — cursor/kimi-k3 에포트 티어

PR은 `CURSOR_MODEL_EFFORT_TIERS`에 `"kimi-k3": ["low","high","max"]`를 넣고
`CURSOR_STATIC_MODELS`에 `kimi-k3`를 시드한다. 티어 구성은 **정확하다**:
Kimi K3 공식 Quickstart가 `reasoning_effort`를 `low` / `high` / `max`로 문서화하고
**기본값을 `max`로 명시**한다.

그런데 Codex 리뷰가 지적한 P2를 코드로 재현했다.

- `cursorModelEffortLadder("kimi-k3")` → `["low","high","max"]`
  (`src/adapters/cursor/effort-map.ts:102` — **PR #646 적용 시**; 현재 `dev`에서는 `undefined`)
- cursor 레지스트리 엔트리(`src/providers/registry.ts:380-392`)는
  `modelReasoningEfforts`만 제공하고 **`modelDefaultReasoningEfforts`가 없다.**
- `applyProviderConfigHints()`는 `modelRecordValue(prov.modelDefaultReasoningEfforts, id)`
  로 기본값을 찾는다 (`src/codex/catalog/provider-fetch.ts:140`). 없으면 undefined.
- 그러면 `applyReasoningLevels()`가 카탈로그 기본값을 채우고, 결과적으로 픽커가
  `high`를 **명시적으로 전송**한다. 요청 빌더가 의도한 "에포트 없음 → `kimi-k3-max`"
  폴백에는 영원히 도달하지 못한다.

같은 K3를 서빙하는 다른 경로는 이미 올바르다:

```
src/providers/registry.ts:587   modelDefaultReasoningEfforts: { "kimi-k3": "max" }   # opencode-go
src/providers/registry.ts:501   modelDefaultReasoningEfforts: KIMI_CODING_DEFAULT_REASONING_EFFORTS
src/providers/registry.ts:1035  modelDefaultReasoningEfforts: KIMI_CODING_DEFAULT_REASONING_EFFORTS
```

cursor만 빠져 있어서 **공식 기본값과도 다르고 사내 다른 경로와도 불일치**한다.
한 줄 보강 + 회귀 테스트 + docs 갱신이 머지 전 조건.

두 번째 P2는 docs다. `docs-site/src/content/docs/guides/providers.md:256`의 Cursor
커버리지 표는 `cursor/gpt-5.6-*`만 나열한다. AGENTS.md의 docs-sync 규칙상 사용자
가시 카탈로그가 바뀌면 영문 소스와 번역 로케일이 어긋나지 않아야 한다.

## #652 — bounded model discovery contract

열린 PR 중 **유일하게** `mergeStateStatus: CLEAN` + `reviewDecision: APPROVED` +
체크 9개 전부 `success`(head `a7ae3970`). 엄브렐라 #572의 phase 1이고 #653
Baseten 배치의 선행 기반이다.

지적 사항 처리 상태:

- Codex/CodeRabbit 지적 3건 → 작성자가 `4e8e7d5`에서 항목별로 응답·처리.
- CodeRabbit의 `safeConfigDTO`에서 `provider.note` 누락 지적 → **이 PR이 만든 회귀가
  아니다.** `dev`의 현재 `src/server/auth-cors.ts`도 레지스트리 노트만 복사한다.
  기존 결함이므로 이 PR의 머지 차단 사유가 아니고, 별도 이슈 대상.
- OAuth·자격증명 경로를 건드리므로(23파일 / +1332) MAINTAINERS.md 기준 보안 리뷰
  대상이며, Wibias가 tip `169e6374`에 대해 보안 리뷰를 붙였다: redirect `error`,
  fetch 전 destination policy, 레지스트리 신뢰 정책 비복사 확인.

## #706 — MiniMax-M3 메타데이터: 전제 오류

PR 주장: "M3 메타데이터가 stale하다 — video 입력이 빠지고 가격이 옛 $0.30/$1.20이다."

### 가격: 주장이 틀렸다

MiniMax 공식 pay-as-you-go 가격 페이지 기준으로 M3에는 **상시 50% 할인**이 걸려 있고,

| 구간 | 정가 (input/output) | 상시 할인가 | 캐시 읽기 |
|------|--------------------|------------|----------|
| ≤512K 입력 | $0.60 / $2.40 | **$0.30 / $1.20** | $0.06 |
| >512K 입력 | — | $0.60 / $2.40 | $0.12 |

즉 PR이 "현재 값"으로 갈아끼우려는 $0.60 / $2.40 / $0.12는 **>512K 구간 가격이자
≤512K의 정가**이고, 지금 카탈로그에 있는 $0.30 / $1.20 / $0.06은 **실제로 과금되는
상시 할인가**다. 둘 다 공식 숫자다. 어느 쪽을 단일 값으로 쓸지는 **정책 결정**이며
이번 라운드 범위 밖이다.

게다가 우리 메타데이터의 minimax M3 행은 `contextWindow`가 `1000000`이라 두 구간이
한 행에 섞여 있다. 정가로 바꾸면 대다수 실제 청구액을 2배로 과대표시한다.
→ **가격은 건드리지 않는다.**

### video 입력: 주장이 맞다

MiniMax는 M3의 video 입력을 문서화하고 M2 계열과 명확히 구분한다. 근거는 **우리가
실제로 호출하는 경로**의 문서를 쓴다 — 우리 minimax 프리셋은 `openai-chat` +
`https://api.minimax.io/v1`이다(`src/providers/registry.ts:1001`, `minimax-cn`은 `:1013`).
OpenAI 호환 경로는 `POST /v1/chat/completions`에서 `video_url` 콘텐츠 파트로 video를
받으며 MP4/AVI/MOV/MKV, 직접 50MB, Files API 경유 512MB, `fps` 0.2–5(기본 1)를 명시한다
(<https://platform.minimax.io/docs/api-reference/text-openai-api>).

`text,image` → `text,image,video` 교정은 이 근거로 옳다. 단 **와이어 구현은 없다**:
`rg "video_url|input_video" src --glob '!src/generated/**'`가 아무것도 반환하지 않으므로
이 변경은 카탈로그 광고(Codex 앱이 비디오 첨부를 받아들이게 됨)까지이고 전송 경로는
후속 작업이다. 자세한 정정 경위는 040 참조.

### 구조 문제: 생성물만 고치면 되돌아간다

`src/generated/jawcode-model-metadata.ts` 헤더:

```
// Generated by scripts/generate-jawcode-metadata.ts. Do not edit by hand.
```

상위 소스는 `../jawcode/packages/ai/src/models.json`이고(`generate-jawcode-metadata.ts:23`),
거기 `minimax.MiniMax-M3` (line ~40817)는 여전히:

```json
"input": ["text", "image"],
"cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.06, "cacheWrite": 0 },
"contextWindow": 1000000
```

PR처럼 생성물만 손대면 다음 `bun run generate:jawcode-metadata`에서 되돌아간다.
**소스를 고치고 재생성**하는 것이 유일하게 지속되는 수정이다.

참고: 같은 파일의 `deepinfra` 번들에도 `MiniMaxAI/MiniMax-M3`가 있다(line ~8735,
`contextWindow` 524288). 서로 다른 서빙 경로이므로 minimax 프리셋만 교정한다.

### 타겟 브랜치

`baseRefName: main`. AGENTS.md는 `dev` 외 타겟을 금지하고 `enforce-target`이 이미
`fail`이다. 재타겟 + 전제 수정 + 소스 반영을 요구하면 사실상 새 PR이므로,
video 발견을 크레딧하고 우리가 직접 올바른 형태로 반영한 뒤 닫는다.

## 타입 확장이 필요한 지점

`("text" | "image")[]`가 하드코딩된 곳은 생성 파이프라인 두 파일뿐이다:

```
src/generated/jawcode-model-metadata.ts:9   input?: ("text" | "image")[];
src/generated/jawcode-model-metadata.ts:99  input.split(",") as ("text" | "image")[]
```

런타임 소비 측은 이미 `string[]`이라 video를 통과시킨다:

- `src/types.ts:509` — `inputModalities?: string[]`
- `src/codex/catalog/parsing.ts:107` — `inputModalities?: string[]`
- `tests/catalog-vision-sidecar-modalities.test.ts:29` — `["text","image","video"]`를
  이미 기대하는 케이스가 존재

→ 제너레이터 타입만 넓히면 되고 소비 측 변경은 불필요하다.

## 작업 순서 (독립 유닛 + 위험 램프 — PHASE-SPLIT-01 해당 없음)

> **개정 (A-감사 후)**: 초판은 이 절을 "의존성 기준, PHASE-SPLIT-01"이라 붙여놓고
> 실제로는 위험도 순서를 설명했다. 감사가 정확히 지적했고 인정한다. 이번 라운드의
> work-phase들은 **서로 독립**이며, 순서는 의존성에서 도출된 것이 아니라 위험 램프
> 선택이다. PHASE-SPLIT-01은 의존성 슬라이싱을 요구하는 규칙이므로 여기 인용하지 않는다.

```
wp1 (#711) ── 독립. src/claude/outbound.ts 단독
wp2 (#646) ── 독립. src/adapters/cursor/* + src/providers/registry.ts + docs-site
wp3 (#652) ── 독립. (#653의 선행이지만 #653은 이번 범위 밖이라 제약으로 작동하지 않음)
wp4 (#706) ── 독립. jawcode 소스 + 제너레이터 타입까지만. 생성물은 불변
wp5 (재동기화) ── **wp4에 진짜로 의존.** wp4가 소스에 video를 넣어야
                  이 사이클의 재생성이 그것을 실어온다
```

wp1~wp4는 파일이 겹치지 않아 어떤 순서로도 실행 가능하다. 채택한 순서는 위험 램프다 —
CI 확인만 남은 wp1로 랜딩 파이프라인을 먼저 검증하고, 코드 보강이 필요한 wp2,
대형 승인 건 wp3, 외부 레포가 끼는 wp4를 뒤에 둔다. 이건 스케줄 선택이며 아키텍처
빌드 순서가 아니라고 명시한다.

**실재하는 의존성은 wp4 → wp5 하나**다. wp4가 jawcode 소스를 고치고 생성물을 불변으로
두므로, wp5의 재생성이 video를 자동으로 실어온다. 역순으로 하면 재동기화 후 video를
위해 한 번 더 재생성해야 한다.

## 범위 밖 (명시)

- MiniMax 가격 정책 변경
- 다른 열린 PR 머지 (#707/#693/#687/#671/#653/#635/#633/#630/#629/#616/#611/#610/#607/#581/#575/#569/#562/#557/#533)
- 릴리스 발행
- 워크트리의 무관한 미커밋 변경 — **보존만 한다**. 이 목록은 동시 세션이 작업 중이라
  실시간으로 변한다. 라운드 시작 시점에는 `src/service.ts`,
  `structure/04_transports-and-sidecars.md`, `structure/08_openai-provider-tiers.md`,
  `tests/startup-prompt.test.ts`였고, 이후 `src/cli/interactive-confirm.ts`와
  `tests/interactive-confirm.test.ts`가 나타나고 `structure/*.md`가 사라졌다.
  따라서 **고정 목록으로 취급하지 않고 커밋 직전에 `git status`로 재확인**하며,
  내 변경만 경로 지정으로 스테이징한다 (`git add <경로>`; `git add -A` 금지)
- devlog 서브모듈의 선행 세션 변경(`260730_kiro_usage_cumulative_cache`) — 보존만 한다

## A-감사 결과 반영 (260730, 리뷰어 verdict FAIL → 개정)

독립 리뷰어가 다섯 문서를 전수 검증했다. 접수한 주요 지적:

| # | 심각도 | 내용 | 처리 |
|---|--------|------|------|
| 1 | High | wp4 재생성이 95모델/가격 63행을 끌고 옴 — 수용 기준 달성 불가 | wp5 분리, 040 전면 개정 |
| 2 | Medium | `opencode-go/minimax-m3` 컨텍스트 반토막, `kimi-k3` 신규 비용 행 | 050에 낙진으로 명시 |
| 3 | Medium | `event: message`를 명시 전송하는 게이트웨이는 #711로도 안 고쳐짐 | 010에 기록, 후속 분리 |
| 4 | Medium | 작업 순서가 의존성이 아니라 위험 램프 | 이 문서 상단 개정 |
| 5 | Medium | 020의 테스트/문서가 스텁 — DIFFLEVEL 미달 | 020 개정 |
| 6 | Medium | 030의 `169616..a7ae39` 비교가 실제로 38커밋 150파일 | 030 개정 (merge-base/range-diff) |
| 7 | Low | `minimax-cn`이 같은 번들로 video를 물려받음 | 040에 의도된 결과로 명시 |
| 8 | Low | `deepinfra` 제외는 무의미 (생성물 도달 불가) | 040 정정 |
| 9 | Low | 제너레이터 타입 위젠은 기능적 필요 없음 | 040에 "문서적"으로 격하 |
| 10 | Low | #711 테스트는 2개가 아니라 5개 | 010 정정 |
| 11 | Low | `effort-map.ts:103` → 실제 `:102`, 래더 재현은 PR 적용 상태에서만 성립 | 000/020 정정 |

리뷰어가 확인해준 것 중 가장 중요한 것: **wp2의 인과 사슬이 실제 함수 실행으로 검증됐다.**
`applyReasoningLevels(entry, ["low","high","max"], undefined, false)` → `high`,
`"max"` 오버라이드 시 → `max`. mock-top-tier 블록(`effort.ts:157-162`)은 래더에만
`max`/`ultra`를 더하고 기본값은 건드리지 않으며, 기본값은 `:178-180`에서
`medium` → `high` → `efforts[0]` 순으로 결정된다. 그리고 `{ "kimi-k3": "max" }` 레코드는
`modelRecordValue`의 매칭 규칙상 `kimi-k3-max`나 다른 cursor 모델로 누출되지 않는다.

리뷰어가 검증 못한 항목 중 하나는 메인 세션이 이어서 확정했다: **MiniMax M3 video 지원**.
단 라운드 2 재감사에서 근거 경로가 틀렸다는 지적(NEW-3)을 받아 정정했다 — 우리 프리셋은
`openai-chat` + `/v1`이므로 OpenAI 호환 경로 문서를 근거로 쓴다
(<https://platform.minimax.io/docs/api-reference/text-openai-api>). Anthropic 호환 경로는
블록 형태가 달라 우리 경로가 아니다. M3 전용 구분은 두 경로 모두에서 동일하다.

정정 하나: 아래 `cursorModelEffortLadder("kimi-k3")` 재현은 **PR #646이 적용된 상태**에서만
성립한다. 현재 `dev`에서는 `kimi-k3`가 `CURSOR_MODEL_EFFORT_TIERS`에 없어 `undefined`다.

## 이 라운드에서 얻은 재사용 가능한 교훈

감사를 세 라운드 돌면서 반복적으로 드러난 실수 유형. 다음 유닛에서 먼저 확인할 것.

1. **`gh pr checks`의 `fail`은 결론이 아니다.** cancelled를 fail로 표시한다.
   `gh api ".../commits/<sha>/check-runs"`로 실제 `conclusion`을 봐야 한다. 이 함정을
   모르면 정상 PR(#711)을 떨어뜨린다.
2. **생성 파일은 "현재 소스와 동기화되어 있다"고 가정하지 마라.** `src/generated/*`를
   건드리는 계획은 먼저 격리 사본에서 재생성해 델타를 재보아야 한다. 이번엔 95모델/
   가격 63행이 이미 밀려 있었고, 그 사실 하나가 work-phase 하나를 쪼개게 만들었다.
   동기화를 강제하는 테스트가 없으면 드리프트는 반드시 쌓인다.
3. **함수 이름을 기억으로 쓰지 마라.** 계획 문서에 `deriveProviderFromRegistry`(존재
   안 함) → `providerConfigSeed`(부적절) → `enrichProviderFromRegistry`(정답)로 두 번
   틀렸다. diff-level 계획이라면 시그니처를 `rg`로 확인하고, 가능하면 스크래치에서
   실행해 값까지 확인한다.
4. **근거 문서가 우리 코드 경로와 같은지 확인하라.** MiniMax video를 Anthropic 호환
   경로 문서로 정당화했으나 우리 프리셋은 `openai-chat` + `/v1`이었다. 벤더 문서가
   여러 경로를 제공할 때, 인용은 `adapter`/`baseUrl`이 실제로 가리키는 경로여야 한다.
5. **"레지스트리가 오버라이드하니 안전"은 모델별로 확인하라.** `opencode-go`는
   `kimi-k3`만 `modelContextWindows`를 갖고 `minimax-m3`는 없다. 한 모델에서 참인
   보호 논리를 형제 모델로 일반화하면 안 된다.
6. **카탈로그 광고 ≠ 능력.** 모달리티를 추가하면 클라이언트가 첨부를 받아들이지만
   와이어 경로가 없으면 조용히 버려진다(`OcxContentPart`는 text|image뿐,
   `responses/parser.ts`는 미지 블록을 무시). 광고와 구현을 같은 문장에서 주장하지 않는다.
7. **PR 승인 tip과 현재 head가 다르면 measure 방법을 먼저 정하라.** 단순 `A..B` diff는
   `dev` 머지분까지 끌어와 38커밋 150파일로 보인다. `merge-base` 또는 `range-diff`로
   PR 저작분만 분리하면 이번 경우 커밋 3개였다.
