# 004 — Usage, Dashboard, Provider Workspace의 tok/s + 추정 비용 표면 조사

## 결론

**조건부 가능**이다. `usage.jsonl`에는 과거 행까지 비용 계산에 필요한 provider/model/usage와
속도 계산에 필요한 `durationMs`가 이미 있고, `/api/usage`는 이 파일을 읽어 기간·모델·provider
집계를 만든다. 따라서 가격 스냅샷을 새로 영속하지 않고 WP1의 `src/usage/cost.ts`를
`src/usage/summary.ts`에서 호출하면 세 표면에 동일 정책을 적용할 수 있다.
`src/usage/log.ts:16-45`, `src/usage/log.ts:191-210`, `src/usage/summary.ts:370-399`,
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:111-120`

권장안은 **서버 집계 확장 → Usage 상세 표면 → 메인 Dashboard 최소 KPI → Provider Workspace
provider별 표면** 순서다. 비용은 선택 기간의 계산 가능한 행 합계와 가격 커버리지를 함께
표시하고, 속도는 산술 평균이 아니라 `Σ outputTokens / Σ durationSeconds`인 가중 E2E output
rate로 표시한다. `outputTokens <= 0` 또는 `durationMs <= 0`인 행은 속도 분모/분자에서 제외한다.
이 정의는 기존 Logs 즉시안인 전체 request duration 기준과 같다.
`devlog/_plan/260720_toks_speed_price_columns/001_tok_speed_research.md:26-43`,
`src/usage/log.ts:16-28`, `src/usage/log.ts:32-45`

조건은 두 가지다. 첫째, WP1의 exact native-ID 가격 lookup·캐시 변환·expected overlay·combo
합산 코어가 먼저 완료되어야 한다. 둘째, 003의 `verified`/`verified-derived` 항목만 expected
overlay에 넣고 not-published/unverified/구조적으로 환산 불가능한 가격은 `—`로 유지해야 한다.
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:137-141`,
`devlog/_plan/260720_toks_speed_price_columns/003_missing_price_research.md:8-10`,
`devlog/_plan/260720_toks_speed_price_columns/003_missing_price_research.md:48-62`

## 1. 확정 정책 기준

- 가격 숫자는 실제 청구액이 아니라 모두 `~$`로 표시한다. 캐시 상세가 없으면 input 전액,
  cursor/kiro estimated usage도 포함하며, 가격을 찾지 못한 경우만 행 단위 `—`다.
  `devlog/_plan/260720_toks_speed_price_columns/000_plan.md:111-120`
- 캐시 계산은 `I - R - W`를 비캐시 input으로 쓰고, provider alias 뒤 native model ID를 exact
  match하며, combo는 attempt별 단가를 적용한 뒤 합산한다.
  `devlog/_plan/260720_toks_speed_price_columns/000_plan.md:117-120`,
  `devlog/_plan/260720_toks_speed_price_columns/002_price_toks_per_dollar_research.md:71-88`,
  `devlog/_plan/260720_toks_speed_price_columns/002_price_toks_per_dollar_research.md:188-210`
- 부분 캐시 상세는 알려진 read/write만 반영하고, `R + W > I`인 모순 행만 `—`다.
  `devlog/_plan/260720_toks_speed_price_columns/000_plan.md:143-148`
- tok/s의 1차 정의는 output token을 request 전체 duration으로 나눈 E2E output rate다. TTFT는
  별도 지표이며 이번 Usage/Dashboard 집계에 섞지 않는다.
  `devlog/_plan/260720_toks_speed_price_columns/000_plan.md:121-128`

`002`의 estimated 비용 기본 `—` 및 정확 금액 표기는 조사 당시 초안이고
(`devlog/_plan/260720_toks_speed_price_columns/002_price_toks_per_dollar_research.md:212-225`),
그 뒤 확정된 위 v2 SSOT의 “전부 추정, estimated도 표시”가 우선한다.
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:102-120`

## 2. Usage 페이지 현황

### 2.1 데이터 소스와 기간/표면 필터

- `Usage.tsx`는 기본 `30d`와 `all` surface 상태로 시작하고, range는 `all | 30d | 7d`, surface는
  `all | codex | claude`다. `gui/src/pages/Usage.tsx:7-8`, `gui/src/pages/Usage.tsx:523-529`
- 화면은 `${apiBase}/api/usage?range=<range>&surface=<surface>` 하나를 fetch하고, range/surface가
  바뀔 때 이전 요청을 abort한 뒤 다시 읽는다. `gui/src/pages/Usage.tsx:531-557`
- 서버 handler는 query를 정규화하고 `readUsageEntries()` 전체 결과를 `summarizeUsage()`에
  넘긴다. 읽기 실패도 200과 zero summary/empty arrays를 반환한다.
  `src/server/management-api.ts:367-400`
- range parser의 기본값은 `30d`; 7일/30일은 현재 시각에서 millisecond window를 빼고,
  `all`은 since가 null이다. surface 미지정/미지원 값은 `all`이다.
  `src/usage/summary.ts:82-95`

### 2.2 현재 `/api/usage` 집계 구조

응답은 선택 `range/surface`, `since/generatedAt`, 전체 `summary`, 날짜별 `days`, 모델별
`models`, provider별 `providers`로 구성된다. `src/usage/summary.ts:69-78`

- 전체 summary는 request/attempt 수, reported/unreported/unsupported/estimated 수,
  input/output/cache read/cache write/reasoning/total token, coverage ratio를 가진다.
  `src/usage/summary.ts:8-24`, `src/usage/summary.ts:113-130`
- 날짜별 집계는 date, requests, measured/reported requests, total tokens와 그 날짜의
  provider+model breakdown을 가진다. `src/usage/summary.ts:26-41`,
  `src/usage/summary.ts:218-267`
- 모델별 집계는 `baseProviderLabel(provider) + native model`을 row identity로 쓰며
  `resolvedModel`은 identity가 아니다. requests는 같은 parent request의 여러 attempt를 한 번만
  세고, attemptCount와 status/token 합계는 별도로 누적한다.
  `src/usage/summary.ts:270-321`
- provider별 집계도 account pool suffix를 접은 base provider 단위이며, parent request 수와
  attemptCount를 분리하고 status와 total token을 누적한다.
  `src/usage/summary.ts:324-368`, `src/providers/label.ts:3-18`
- combo 또는 retry attempt가 있으면 날짜/모델/provider attribution은 최상위 `combo` 행이 아니라
  각 attempt의 실제 provider/model/usage를 사용한다. attempt가 없는 legacy 행만 최상위 필드를
  쓴다. `src/usage/summary.ts:137-167`
- 최종 `summarizeUsage()`는 먼저 기간/surface를 filter하고, 전체 summary는 parent entry 단위,
  날짜/모델/provider는 위 helper로 만든다. `src/usage/summary.ts:370-399`

현재 Usage UI는 6개 summary 카드(requests, measured, total tokens, cache, coverage, active days),
기간 차트/heatmap, 모델 표, provider 표, coverage panel 순서다.
`gui/src/pages/Usage.tsx:250-279`, `gui/src/pages/Usage.tsx:332-416`,
`gui/src/pages/Usage.tsx:418-520`, `gui/src/pages/Usage.tsx:579-599`
모델 표는 model/provider/requests/measured/tokens/share 6열이고 provider 표는
provider/requests/measured/tokens/share 5열이다. `gui/src/pages/Usage.tsx:445-470`,
`gui/src/pages/Usage.tsx:475-503`

### 2.3 `usage.jsonl`에 이미 있는 원천 필드

- parent 행에는 requestId, timestamp, provider, model, optional surface/resolvedModel/requestedModel,
  status, `durationMs`, `usageStatus`, optional `usage`, `totalTokens`, `attempts`가 있다.
  `src/usage/log.ts:32-45`
- attempt에는 실제 provider/model/adapter/status, `durationMs`, usageStatus, optional usage와
  totalTokens가 있다. `src/usage/log.ts:16-30`
- `OcxUsage`에는 inclusive input, output, optional total, cache read/write, reasoning output,
  estimated flag가 있다. cache detail은 total에 다시 더하지 않는 계약이다.
  `src/types.ts:227-245`
- request log가 append될 때 위 parent usage/duration/attempts가 그대로 persisted usage entry로
  투영된다. `src/server/request-log.ts:95-125`
- JSONL reader는 줄별 parse 후 parent duration/usage/attempts를 normalize해 되돌리고, 잘못 쓴
  한 줄은 건너뛴다. `src/usage/log.ts:191-210`, `src/usage/log.ts:227-243`
- combo parent usage는 attempt usage 합계지만 provider/model은 `combo`/`combo/*`이고, attempts에는
  실제 child가 남는다. `src/server/request-log.ts:431-466`,
  `src/server/request-log.ts:609-655`

따라서 이미 저장된 행은 가격표를 **표시 시점**에 적용해 소급 계산할 수 있고, 가격표가 갱신되면
과거 표시액도 달라진다. 이는 스냅샷을 저장하지 않는 확정 정책이다.
`src/usage/log.ts:32-45`, `src/usage/log.ts:191-210`,
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:111-120`
실제 사용자 `usage.jsonl` 전체 세대에 malformed top-level duration이나 누락 usage가 얼마나 있는지는
이번 읽기 전용 소스 조사로는 **미확인**이다.

## 3. Dashboard와 Provider Workspace 현황

### 3.1 메인 Dashboard

메인 Dashboard는 별도 workspace가 아니라 앱의 `#dashboard` 페이지다. Provider workspace는
`#providers/workspace`인 별도 sub-view다. `gui/src/App.tsx:20-33`, `gui/src/App.tsx:266-278`,
`gui/src/pages/Providers.tsx:65-84`

Dashboard는 다음을 보여 준다.

- 상단 6개 카드: multi-agent mode, server status, version, uptime, provider 수, 30일 token 합계와
  usage coverage다. `gui/src/pages/Dashboard.tsx:558-616`
- effort cap과 injection model 설정 panel. `gui/src/pages/Dashboard.tsx:636-730`,
  `gui/src/pages/Dashboard.tsx:732-792`
- maintenance/sync/update, Codex auto-start, web-search/vision sidecar, shadow-call 설정.
  `gui/src/pages/Dashboard.tsx:794-928`
- active provider 표와 provider별 available model 카드 목록.
  `gui/src/pages/Dashboard.tsx:930-970`

핵심 데이터는 health/providers/settings/sidecar/shadow-call과 `/api/usage?range=30d`를 같은
`Promise.all`에서 5초마다 읽고, usage 실패만 `null`로 격리한다.
`gui/src/pages/Dashboard.tsx:176-216`, `gui/src/pages/Dashboard.tsx:232-285`
Dashboard가 현재 소비하는 usage contract는 requests/totalTokens/coverageRatio 세 필드뿐이다.
`gui/src/pages/Dashboard.tsx:21-21`, `gui/src/pages/Dashboard.tsx:184-184`

### 3.2 Provider Workspace와 accounts rail 관계

- Provider workspace는 config provider를 ready/needs-setup/disabled rail로 나누고, 선택 provider의
  detail 또는 미선택 aggregate dashboard를 보여 준다. `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:83-86`,
  `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:379-404`
- workspace shell은 `/api/usage?range=30d`의 `providers[]`를 provider-name keyed
  `{ requests, totalTokens }`로 바꿔 보관한다. `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:104-116`
- 미선택 aggregate dashboard는 ready/setup/disabled 카드, provider quota rows, requests 기준
  recently-used provider ranking을 표시한다. `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:64-139`
- 선택 detail은 Overview/Models/Usage/Accounts-or-API-keys/Settings tabs를 가지며, auth surface가
  있는 provider만 account tab을 만든다. `gui/src/components/provider-workspace/ProviderDetails.tsx:23-23`,
  `gui/src/components/provider-workspace/ProviderDetails.tsx:74-87`,
  `gui/src/components/provider-workspace/ProviderDetails.tsx:155-203`
- Overview의 STATS에는 30일 requests/tokens와 quota 갱신 시각이 있고, Usage tab은 30일
  requests/tokens 카드와 rate-limit bars를 보여 준다. `gui/src/components/provider-workspace/ProviderOverview.tsx:95-132`,
  `gui/src/components/provider-workspace/ProviderUsage.tsx:20-63`
- account rail 작업은 account 선택을 Accounts tab 내부에 두고 provider rail에는 provider-level
  정보만 두는 구조로 확정했다. `devlog/_plan/260718_provider_workspace_accounts_rail/000_plan.md:33-59`

현재 `/api/usage`의 provider row는 account pool suffix를 base provider로 접으므로 workspace에
넣을 비용/속도도 **provider 전체 30일 값**이지 account별 값이 아니다.
`src/providers/label.ts:7-18`, `src/usage/summary.ts:324-368`
`usage.jsonl`에는 account identity 자체가 없고 provider log label만 있으므로 Accounts tab의
각 account별 비용/속도 attribution은 현재 계약으로는 **불가**다.
`src/usage/log.ts:16-45`

## 4. 제안 설계

### 4.1 서버 집계 확장 대 클라이언트 계산

| 안 | 장점 | 단점 | 판정 |
| --- | --- | --- | --- |
| `src/usage/summary.ts`가 WP1 `src/usage/cost.ts`를 호출 | raw parent/attempt usage와 duration을 이미 보유하고 combo/legacy attribution도 한 곳에 있다. Usage, Dashboard, Provider workspace가 같은 `/api/usage` contract를 공유한다. `src/usage/summary.ts:137-167`, `src/usage/summary.ts:370-399` | 5초 polling Dashboard에서 full JSONL read 뒤 가격 계산도 반복된다. 현재도 full read/summarize를 반복하나 추가 CPU 비용은 **미확인**이다. `gui/src/pages/Dashboard.tsx:232-285`, `src/server/management-api.ts:367-372` | **권장** |
| GUI에서 계산 | 표시 formatting을 화면 가까이에 둘 수 있다. `gui/src/pages/Usage.tsx:79-81` | 현재 API는 raw entry/attempt/cache/duration을 보내지 않아 정확 계산이 불가능하다. 이를 보내면 API payload와 세 GUI consumer의 정책 중복이 커진다. `src/usage/summary.ts:69-78`, `gui/src/pages/Dashboard.tsx:21-21`, `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:104-116` | 비권장 |

서버는 숫자와 coverage/status만 반환하고, `~$`, locale 숫자, tooltip 문구는 GUI가 format하는
경계를 권장한다. 기존 API도 summary 숫자를 보내고 GUI가 token/percent를 format한다.
`gui/src/pages/Usage.tsx:79-81`, `gui/src/pages/Usage.tsx:263-276`

### 4.2 제안 API 필드와 집계식

다음 additive 필드를 `summary`, `days`, `models`, `providers` 중 필요한 shape에 둔다.
기존 소비자는 필요한 필드만 구조적으로 읽으므로 additive 확장과 충돌하지 않는다.
`gui/src/pages/Dashboard.tsx:21-21`, `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:106-112`

```text
estimatedCostUsd: number
pricedRequests: number
unpricedRequests: number
costCoverageRatio: number

outputTokensForRate: number
durationMsForRate: number
rateRequests: number
estimatedRateRequests: number
avgOutputTokensPerSecond: number | null
```

`avgOutputTokensPerSecond = outputTokensForRate / (durationMsForRate / 1000)`로 계산한다.
request별 tok/s 산술 평균은 짧고 작은 응답에 같은 가중치를 주므로 사용하지 않는다. 전체 summary와
day는 parent request의 전체 duration/aggregate output을 사용하고, model/provider는 기존 attribution과
같이 attempt duration/output을 사용한다. parent와 attempt 모두 duration/usage를 보존한다.
`src/usage/log.ts:16-28`, `src/usage/log.ts:32-45`, `src/usage/summary.ts:147-167`

`estimatedCostUsd`는 `pricedRequests`에 포함된 행만 합한 값이다. `costCoverageRatio < 1`이면 UI는
“전체 비용”이라고 단정하지 않고 `~$X · N/M priced`처럼 coverage를 함께 보여 준다. 모든 행이
미매칭이면 `—`다. 현재 usage summary도 measured/request coverage를 숫자와 ratio로 함께 보존하는
선례가 있다. `src/usage/summary.ts:8-24`, `src/usage/summary.ts:180-216`

### 4.3 Usage 페이지 배치

1. **선택 기간 summary**: 기존 6개 카드에 `추정 비용 (~$)`과 `평균 E2E tok/s` 두 카드를
   추가해 8개를 4×2 desktop / 2열 mobile로 배치한다. 현재 3열 카드 grid와 mobile 2열 규칙은
   8개에서 desktop 3+3+2가 되므로 desktop column 조정이 필요하다.
   `gui/src/pages/Usage.tsx:250-279`, `gui/src/styles.css:838-850`
2. **모델 표**: Tokens 뒤에 `~$`와 `E2E tok/s`를 추가하고 Share는 마지막에 유지한다.
   비용 tooltip에는 priced coverage/expected overlay 여부를, 속도 tooltip에는 output/duration과
   estimated 포함 여부를 표시한다. 현재 모델 표 위치와 열은 `gui/src/pages/Usage.tsx:445-470`이다.
3. **provider 표**: workspace와 같은 server provider shape를 검증할 수 있도록 Tokens 뒤에
   `~$`, `E2E tok/s`를 추가한다. 현재 provider 표 위치와 열은 `gui/src/pages/Usage.tsx:475-503`이다.
4. **날짜 차트**: WP6 첫 구현에서는 색/높이를 token 기준으로 유지하고 tooltip에 day `~$`와
   E2E tok/s만 추가한다. 현재 heatmap/daybar geometry가 totalTokens에 결합되어 있어 비용 축으로
   바꾸면 별도 시각화 설계가 된다. `gui/src/pages/Usage.tsx:281-328`,
   `gui/src/pages/Usage.tsx:332-414`

### 4.4 메인 Dashboard 배치

상단에 독립 속도 카드까지 추가하는 것은 비권장이다. 현재 grid는 정확히 6열/3열/2열이고 상단이
이미 6개 카드라 두 카드를 더 넣으면 desktop에서 6+2 비대칭이 된다.
`gui/src/pages/Dashboard.tsx:563-616`, `gui/src/styles.css:427-434`

권장 최소안은 기존 `Tokens (30d)` 카드를 **30d Usage 카드**로 확장해 token을 주값으로 유지하고,
보조행에 `~$X · Y E2E tok/s · cost coverage Z%`를 넣는 것이다. 비용은 기간 KPI로 유용하지만,
E2E rate는 tool 대기/TTFT까지 포함하므로 독립 health KPI로 오해될 수 있다.
`gui/src/pages/Dashboard.tsx:607-615`,
`devlog/_plan/260720_toks_speed_price_columns/001_tok_speed_research.md:26-43`
세부 분석은 Usage 페이지로 이동시키는 링크 추가 여부는 현재 Dashboard 카드가 navigation
control이 아니어서 **미확인/후속 UX 선택**이다. `gui/src/pages/Dashboard.tsx:607-615`

### 4.5 Provider Workspace 배치

- aggregate workspace의 recently-used row는 requests 뒤에 `~$`를 보조 정보로 추가하고,
  tok/s는 넣지 않는다. provider ranking에서 heterogeneous E2E rate 비교는 모델/작업 혼합의 영향을
  크게 받으며, 현재 row는 provider name/requests 중심이다.
  `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:112-133`
- 선택 provider Overview STATS에는 30일 `추정 비용`과 `평균 E2E tok/s` 두 kv row를 추가한다.
  현재 STATS가 requests/tokens/quota timestamp를 소유한다.
  `gui/src/components/provider-workspace/ProviderOverview.tsx:95-132`
- 선택 provider Usage tab의 30일 metric block은 requests/tokens/~$/E2E tok/s 4개 metric으로
  확장하고 cost/rate coverage 문구를 붙인다. rate-limit block은 변경하지 않는다.
  `gui/src/components/provider-workspace/ProviderUsage.tsx:20-63`
- Accounts tab/rail에는 넣지 않는다. usage가 base provider로 합쳐지고 account identity가 persisted
  usage contract에 없기 때문이다. `src/providers/label.ts:7-18`, `src/usage/log.ts:16-45`

## 5. combo, estimated, 미매칭 처리 규칙

| 입력 | 비용 집계 | 속도 집계 | 표시 |
| --- | --- | --- | --- |
| reported 단일 행 + exact/expected price | canonical cache 변환 후 포함 | output > 0, duration > 0이면 포함 | `~$`, `N.N E2E tok/s` |
| estimated usage | 확정 v2 정책대로 포함 | output > 0이면 포함 | 비용은 어차피 `~$`; 속도 aggregate에 하나라도 estimated가 있으면 `~N.N`과 estimated count |
| usage 없음 / unreported / unsupported | 제외 | 제외 | 행 `—`; aggregate coverage 감소 |
| exact/expected price 미매칭 | 비용 제외 | usage/duration이 유효하면 속도는 독립적으로 포함 | 비용 `—`, 속도는 표시 가능 |
| outputTokens = 0 | input/cache/output 비용은 계산 가능 | 제외 | 비용 `~$`, 속도 `—` |
| durationMs <= 0 | 비용에는 영향 없음 | 제외 | 속도 `—` |
| `R + W > I` | 모순 데이터로 비용 제외 | 속도는 독립적으로 유효하면 포함 | 비용 `—` |
| combo/retry | request summary cost는 모든 attempt를 canonical key로 계산해 전부 성공할 때만 parent 합계 포함; 모델/provider breakdown은 실제 attempt에 귀속 | request summary는 parent output/전체 duration, 모델/provider는 attempt output/duration | partial parent total 금지; attempt attribution coverage 별도 |

근거 계약은 usage status 네 상태와 usage 부재 처리 `src/usage/log.ts:7-7`,
`src/usage/log.ts:73-82`; combo attempt 보존/aggregate `src/server/request-log.ts:431-466`,
`src/server/request-log.ts:609-655`; v2 estimated/cache/combo 정책
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:111-120`,
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:143-151`; tok/s zero/estimated 정책
`devlog/_plan/260720_toks_speed_price_columns/001_tok_speed_research.md:58-63`이다.

모델/provider breakdown에서 combo child 하나의 가격이 미매칭이어도 다른 **개별 provider/model
row**의 valid attempt 비용은 그 row의 `pricedRequests`에 포함할 수 있다. 다만 parent combo 총액이나
전체 request의 full-cost coverage에는 포함하지 않는다. 이는 부분합을 실제 combo 총액처럼 보이지
않게 하는 기존 조사 원칙과 실제 attempt attribution을 함께 지키는 안이다.
`devlog/_plan/260720_toks_speed_price_columns/002_price_toks_per_dollar_research.md:188-210`,
`src/usage/summary.ts:147-167`

## 6. 구현 예상 파일과 난이도

WP1의 `src/usage/cost.ts`, `src/usage/expected-prices.ts`, generated metadata 변경은 선행
작업이며 이 WP5+ 목록에서 중복 구현하지 않는다.
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:137-139`,
`devlog/_plan/260720_toks_speed_price_columns/003_missing_price_research.md:8-10`

| 구분 | 파일 | 예상 변경 | 난이도 |
| --- | --- | --- | --- |
| MODIFY | `src/usage/summary.ts` | cost core 호출, parent/attempt rate accumulator, summary/day/model/provider additive fields와 coverage | 높음 — combo parent와 attribution 이중계상 방지 |
| MODIFY | `src/server/management-api.ts` | read-failure zero fallback에 새 summary 필드 추가 | 낮음 |
| MODIFY | `tests/usage-summary.test.ts` | weighted rate, estimated, zero output/duration, historical, combo partial, provider/model attribution | 높음 — 현재 combo/legacy fixture는 `tests/usage-summary.test.ts:360-469` |
| MODIFY | `tests/api-usage.test.ts` | additive wire shape와 read-failure defaults | 중간 — 현재 shape/fallback 검증은 `tests/api-usage.test.ts:83-103`, `tests/api-usage.test.ts:172-200` |
| MODIFY | `gui/src/pages/Usage.tsx` | 2 summary cards, model/provider 2열, day tooltip, format/coverage 상태 | 중간 |
| MODIFY | `gui/src/pages/Dashboard.tsx` | 30d usage type와 기존 token 카드 보조행 확장 | 낮음 |
| MODIFY | `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` | provider API row의 cost/rate/coverage를 `usageTotals`로 전달 | 중간 |
| MODIFY | `gui/src/components/provider-workspace/types.ts` | provider 30d usage view type 확장 | 낮음 |
| MODIFY | `gui/src/provider-workspace/usage.ts` | 중복 ProviderUsageTotals 정리/formatter 또는 ranking view 확장 | 중간 — 현재 별도 타입은 `gui/src/provider-workspace/usage.ts:55-76` |
| MODIFY | `gui/src/components/provider-workspace/ProviderOverview.tsx` | STATS cost/rate kv rows | 낮음 |
| MODIFY | `gui/src/components/provider-workspace/ProviderUsage.tsx` | 4-metric 30d block와 coverage | 낮음 |
| MODIFY | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx` | recently-used row에 비용/coverage 보조 정보 | 중간 |
| MODIFY | `gui/src/styles.css` | Usage 4×2 cards, table/tooltip 및 Dashboard 보조행 밀도 | 중간 — 현재 관련 grid는 `gui/src/styles.css:427-434`, `gui/src/styles.css:838-850` |
| MODIFY | `gui/src/styles/provider-workspace-shell.css` | 4-metric provider Usage 반응형 layout | 중간 |
| MODIFY | `gui/src/styles/provider-overview-dashboard.css` | recently-used row 보조 정보 폭/좁은 화면 | 중간 — 현재 row grid/반응형은 `gui/src/styles/provider-overview-dashboard.css:79-168` |
| MODIFY | `gui/src/i18n/{en,ko,de,zh}.ts` | Usage/Dashboard/workspace labels, E2E 정의, coverage/unavailable 문구 | 중간 — 현재 usage key 군은 `gui/src/i18n/en.ts:352-374`, workspace key 군은 `gui/src/i18n/en.ts:509-511` |
| MODIFY | `tests/provider-workspace-data.test.ts` 및 관련 workspace source-contract test | provider totals 새 필드 전달/ranking/render contract | 중간 — 현재 workspace helper owner는 `gui/src/provider-workspace/usage.ts:55-76` |
| NEW | 없음 | WP1 cost core와 기존 summary/UI owners로 충분 | — |

## 7. WP5+ phase 분할 제안

### WP5 — Usage metrics backend contract

- `src/usage/summary.ts`, `src/server/management-api.ts`, `tests/usage-summary.test.ts`,
  `tests/api-usage.test.ts`만 변경한다.
- close gate: `bun test --isolate tests/usage-summary.test.ts tests/api-usage.test.ts
  tests/usage-cost*.test.ts` + `bun run typecheck` exit 0.
- 반드시 parent summary와 attempt attribution의 combo 이중계상, weighted rate, estimated,
  unmatched, `R+W>I`, output/duration zero fixture를 닫는다. 현재 summary에 combo/legacy 회귀
  fixture가 이미 있다. `tests/usage-summary.test.ts:360-469`

### WP6 — Usage page

- `gui/src/pages/Usage.tsx`, `gui/src/styles.css`, 4 locale i18n을 변경한다.
- close gate: typecheck + GUI build + 7d/30d/all 및 codex/claude surface에서 full/partial/zero
  cost coverage와 estimated rate 렌더 screenshot.
- 기존 range/surface fetch와 모델 검색/sort를 유지한다.
  `gui/src/pages/Usage.tsx:523-577`

### WP7 — Main Dashboard

- `gui/src/pages/Dashboard.tsx`와 필요한 i18n/style만 변경한다.
- close gate: usage 성공/empty/read-failure에서 Dashboard 나머지가 유지되고 6-card grid가
  desktop/mobile에서 깨지지 않는 screenshot. 현재 usage failure는 독립 `null` 처리다.
  `gui/src/pages/Dashboard.tsx:232-285`, `gui/src/pages/Dashboard.tsx:563-616`

### WP8 — Provider Workspace

- shell/types/usage helper/Overview/ProviderUsage/aggregate dashboard와 workspace styles/tests를
  변경한다.
- close gate: aggregate/no-selection, provider Overview, Usage tab의 full/partial/unavailable 상태를
  desktop/constrained/mobile에서 검증하고 Accounts tab에는 account별 비용이 나타나지 않음을 확인한다.
  workspace의 provider selection/detail 경계는 `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:379-404`다.

WP5를 WP1 뒤에 두고 WP6-8이 그 additive API만 소비하게 하면 Usage/Dashboard/workspace가 서로의
클라이언트 계산을 복제하지 않는다. 기존 로드맵도 004 결과를 WP5+로 append하도록 명시한다.
`devlog/_plan/260720_toks_speed_price_columns/000_plan.md:130-157`

## 최종 판정

- **Usage 페이지: 가능.** WP1 cost core 뒤 서버 summary를 확장하고, 선택 기간 카드와
  model/provider rows에 `~$`/가중 E2E tok/s를 표시하는 안을 권장한다.
  `src/usage/summary.ts:370-399`, `gui/src/pages/Usage.tsx:579-599`
- **메인 Dashboard: 가능하지만 최소 노출 권장.** 독립 카드 추가보다 기존 30일 token 카드의
  보조행으로 비용/속도/coverage를 보여 주어 6-card grid를 보존한다.
  `gui/src/pages/Dashboard.tsx:607-615`, `gui/src/styles.css:427-434`
- **Provider Workspace: provider 단위는 가능, account 단위는 불가.** aggregate row와 selected
  provider Overview/Usage tab에 30일 provider 합계를 넣고 Accounts tab에는 넣지 않는다.
  `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:104-116`,
  `src/providers/label.ts:7-18`, `src/usage/log.ts:16-45`
