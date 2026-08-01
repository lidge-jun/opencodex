# 030 — WP3 Logs 상세 팝업 프로덕션급 구현 명세

## 0. 범위와 의존 계약

이 문서는 WP3 구현자가 그대로 따라갈 수 있는 diff-level PRD다. 코드 변경 대상은 아래 6개 파일이며, 이 문서 작성 단계에서는 코드를 변경하지 않는다.

> **WP3 P-phase stale-check (2026-07-20, WP2 landed 커밋 70f9af92 + 4자리 fix 대조):**
>
> 1. WP2 landed `MetricUnavailableReason`에는 `expected_price_unverified`가 **없다**
>    (landed resolver가 unverified를 반환하지 않아 삭제됨). 본 문서의
>    `reason.expected_price_unverified` i18n 행과 §5의 "unverified expected overlay가
>    matched를 포함하면 ..." 문단은 **구현하지 않는다** — unavailable union과 사유
>    enum은 WP2 landed 타입이 SSOT다. `logs.detail.verification.unverified` 키는
>    price.status가 verified-derived일 때의 표시로 대체한다: source/verification 행은
>    `verified` → "검증됨", `verified-derived` → "기반 모델 유도(derived)"로 표기하고
>    새 키 `logs.detail.verification.derived`를 4로케일에 추가한다.
> 2. 사용자 결정(WP2 C 이후): 비용 표기는 **소수 4자리 고정 반올림**. §4의
>    `formatEstimatedUsdValue`의 가변 자릿수(2/4/6)를 버리고 테이블 formatter와 동일하게
>    `minimumFractionDigits: 4, maximumFractionDigits: 4`로 통일한다.
> 3. WP2 landed GUI 타입에서 `CostResult`의 unavailable에는 `matched` 필드가 없다.
>    §5 unavailable 렌더는 사유 한 행만 표시한다.
> 4. **(A-round fold, 이 블록이 본문보다 우선한다)** 감사 blocker 정리:
>    - (H1) 본문에 남은 가변 자릿수 helper(§4), `verified` 고정 출력(§5),
>      `verification.unverified`/`reason.expected_price_unverified` 키·fixture·close
>      criterion(§9, §10)은 모두 **무시**하고 이 stale-check 규칙으로 구현한다:
>      4자리 고정, `price.status` 분기(verified→`logs.detail.verification.verified`,
>      verified-derived→`logs.detail.verification.derived`), unverified 계열 키 미구현.
>    - (H2) `type CostEstimateReason = "usage_estimated" | "cache_detail_missing" |
>      "expected_price_overlay"`를 명명 타입으로 추출해 `CostResult`와 helper가 공유한다.
>    - (M3) GUI `UsageBreakdown`에 `estimated?: boolean`을 추가한다(서버 OcxUsage spread와
>      필드 일치).
>    - (M4) attempt 소테이블의 target 셀 보조 줄(model 아래)에 cost.kind==="value"일 때
>      `estimate.price`의 matched key(`jawcodeProvider ?? provider`/`modelId`)와
>      source/verification 라벨을 muted caption으로 렌더한다.
>    - (M5) close gate rg는 정확 패턴으로 분리: `rg -n 'attempts\?: LogAttempt\[\]'`,
>      `rg -n 'firstOutputMs\?: number'`, status gate 제거는 수동 JSX 판독으로 확인.
>    - (L6) 본문 라인 앵커(138/257 계열)는 WP2 landing으로 stale — 구조 diff가 SSOT.
>    - (L7) `.log-detail-grid dt { font-weight: inherit; }` 추가.

| 구분 | 파일 | 책임 |
| --- | --- | --- |
| MODIFY | `gui/src/pages/Logs.tsx` | 모든 행 상세 진입, LogAttempt 타입, 섹션/attempt table 렌더, requestId 복사 |
| MODIFY | `gui/src/styles.css` | 넓은 detail card, 섹션, 그리드, attempt table, 좁은 viewport |
| MODIFY | `gui/src/i18n/en.ts` | 상세 UI 원본 키 |
| MODIFY | `gui/src/i18n/ko.ts` | 한국어 키 |
| MODIFY | `gui/src/i18n/zh.ts` | 중국어 키 |
| MODIFY | `gui/src/i18n/de.ts` | 독일어 키 |

의존:

- WP1 `src/usage/cost.ts`가 정규화/매칭/expected overlay/combo 합산/tok/s helper를 제공한다. WP3는 이를 직접 import하거나 내부 구현을 바꾸지 않는다.
- WP2 `/api/logs`가 각 entry와 attempt에 additive `displayMetrics`를 응답 시점 계산해 붙인다. 저장 스냅샷은 없다. 030은 020의 `TokPerSecondResult`, `CostResult`, `LogDisplayMetrics` GUI 타입을 소비한다.
- WP4 이전에는 `firstOutputMs`가 없을 수 있다. optional field가 없으면 TTFT 행 자체를 렌더하지 않는다.
- `RequestLogEntry.attempts`는 이미 서버와 `/api/logs`에 존재한다 (`src/server/request-log.ts:63-89`, `431-466`; `src/server/management-api.ts:313-315`). WP3의 서버 변경은 없다.

## 1. fresh 현행 앵커

- `gui/src/pages/Logs.tsx:138`: 선택된 detail의 status 설명을 `statusCodeInfo()`로 구한다.
- `gui/src/pages/Logs.tsx:149`: virtual row estimate 44px, 각 row는 `measureElement`로 실제 높이를 잰다.
- `gui/src/pages/Logs.tsx:257-266`: status cell에서 `status >= 400`일 때만 `logs.details` 버튼이 보인다. 이것이 해제할 게이트다.
- `gui/src/pages/Logs.tsx:282-284`: 선택된 `detail`이 있으면 dialog를 렌더한다.
- `gui/src/pages/Logs.tsx:289-298`: `useModalDialog`가 native `<dialog>.showModal()`/`.close()`를 관리한다.
- `gui/src/pages/Logs.tsx:300-339`: 현 `LogDetailDialog`는 status 제목/설명, 2열 `log-detail-grid`, raw JSON으로 구성된다. time/request/model/provider/error/upstream/duration만 구조화되어 있다.
- `gui/src/styles.css:628-647`: native dialog reset과 `.modal-card` max-width 520px/max-height 84vh/overflow-y auto.
- `gui/src/styles.css:694-714`: request id clamp, stacked status/details, 2열 detail grid, raw JSON 스타일.
- `gui/src/styles.css:791-847`: 760px 이하 공통 responsive 규칙은 있으나 detail modal 전용 collapse는 없다.
- `src/usage/log.ts:16-30`: attempt는 ordinal/provider/model/adapter/status/durationMs/sendCount/recoveryKinds/usageStatus/inputTokenEstimate?/usage?/totalTokens?/errorCode?를 가진다.
- `src/server/request-log.ts:609-655`: combo top-level usage는 attempt usage 합계지만, attempt 배열은 원본 provider/model/duration/usage를 유지한다.

## 2. 모든 행 상세보기: status gate diff

### 결정

모든 행에 기존 locale `logs.details` 텍스트 버튼을 표시한다. 성공 행도 EN `Details`, KO `상세보기`, ZH `查看详情`, DE `Details`다. 새 아이콘을 만들지 않는다.

아이콘-only는 status 폭을 더 줄일 수 있으나 발견성이 낮고 별도 accessible label/icon 추가가 필요하다. 기존 실패 행에서 검증된 text affordance를 모든 행에 확장하는 편이 일관적이다.

before (`gui/src/pages/Logs.tsx:257-265`):

```tsx
<span className="log-status-cell">
  <span className="mono font-semibold" style={{ color: statusColor(log.status) }}>{log.status}</span>
  {log.status >= 400 && (
    <button type="button" className="log-detail-btn" onClick={() => setDetail(log)}>
      {t("logs.details")}
    </button>
  )}
</span>
```

after:

```tsx
<span className="log-status-cell">
  <span className="mono font-semibold" style={{ color: statusColor(log.status) }}>{log.status}</span>
  <button
    type="button"
    className="log-detail-btn"
    onClick={() => setDetail(log)}
    aria-label={`${t("logs.details")}: ${log.requestId ?? log.status}`}
  >
    {t("logs.details")}
  </button>
</span>
```

영향과 완화:

- 모든 행 status cell이 2줄이 되어 기존 44px estimate에 근접하거나 조금 커질 수 있다. `measureElement`가 실측하므로 virtualizer 정확성은 유지한다.
- `.log-status-cell`에 `min-width: 7ch`와 `line-height: var(--leading-tight)`를 주고 버튼 padding 0/nowrap을 유지해 status 열 폭을 제한한다.
- 10열 Logs는 020의 horizontal scroll 정책을 유지한다. 성공 행에만 다른 row 높이를 만드는 대신 모든 행 높이가 일관돼 스캔이 쉬워진다.

## 3. `LogEntry`/attempt API 계약 diff

### `gui/src/pages/Logs.tsx` — MODIFY

020의 `LogDisplayMetrics` 아래에 타입을 추가한다.

```ts
type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

interface LogAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: LogUsageStatus;
  inputTokenEstimate?: number;
  usage?: UsageBreakdown;
  totalTokens?: number;
  errorCode?: string;
  firstOutputMs?: number;       // WP4 additive; 부재 가능
  displayMetrics?: LogDisplayMetrics; // WP2 additive; rolling upgrade에서 부재 가능
}

interface LogEntry {
  // existing fields
  firstOutputMs?: number;       // WP4 additive
  attempts?: LogAttempt[];      // 서버에 이미 존재, GUI만 계약 추가
  displayMetrics?: LogDisplayMetrics;
}
```

`firstOutputMs`는 요청 시작부터 첫 output event까지의 ms다. 이 값을 duration에서 빼거나 tok/s를 다시 계산하지 않는다. 레이블은 TTFT이고 값은 `${firstOutputMs}ms`다.

## 4. 상세 정보 구조와 렌더 diff

### 구조 확정

modal은 기존 `modal-card`를 재사용하면서 `log-detail-card` modifier만 추가한다. 정보는 다음 순서로 나눈다.

1. **기본 정보** — status, time, requestId+copy, provider/model, error/upstream reason.
2. **성능** — end-to-end duration, tok/s(E2E), optional TTFT.
3. **비용** — total, input/cache read/cache write/output 각각 `~$`, matched jawcode key, price source/verification, estimated 또는 unavailable 사유.
4. **Combo attempts** — attempts가 있을 때만 소테이블.
5. **원본 usage** — input/output/cache read/cache write/reasoning/total token 수.
6. **원본 로그** — 기존 JSON `<pre>`를 `<details>`로 접어 progressive disclosure한다.

이 화면은 dense developer console이므로 새 card를 여러 겹 만들지 않고 section heading + hairline separator만 쓴다.

### helper 추가

`formatEstimatedUsd`는 020 helper를 재사용한다. breakdown은 number를 받는 overload/helper로 분리한다.

```ts
function formatEstimatedUsdValue(value: number, locale: string): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const fractionDigits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `~$${new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}`;
}

function metricReasonKey(reason: MetricUnavailableReason): `logs.detail.reason.${MetricUnavailableReason}` {
  return `logs.detail.reason.${reason}`;
}

function estimateReasonKey(reason: CostEstimateReason): `logs.detail.estimate.${CostEstimateReason}` {
  return `logs.detail.estimate.${reason}`;
}
```

raw usage cache token 수는 기존 `cacheSplit()`을 재사용해 inclusive input 계약을 유지한다. cacheRead와 cacheWrite를 input에 다시 더하지 않는다.

### `LogDetailDialog` before/after

before (`gui/src/pages/Logs.tsx:317-337`): 단일 `.modal-card`, status 중심 header, 하나의 grid, 항상 펼친 raw JSON.

호출부와 props 계약:

```diff
-<LogDetailDialog detail={detail} detailInfo={detailInfo} localeTag={localeTag} t={t} onClose={() => setDetail(null)} />
+<LogDetailDialog detail={detail} detailInfo={detailInfo} localeCode={locale} localeTag={localeTag} t={t} onClose={() => setDetail(null)} />
```

```ts
// LogDetailDialog props에 추가
localeCode: string;
```

after의 골격:

```tsx
function LogDetailDialog(/* existing props */) {
  const dialogRef = useModalDialog(true);
  const [copied, setCopied] = useState(false);
  const numberLocale = localeTag ?? localeCode;
  const tokenSplit = cacheSplit(detail);
  const cost = detail.displayMetrics?.cost;

  const copyRequestId = async () => {
    if (!detail.requestId) return;
    try {
      await navigator.clipboard.writeText(detail.requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 복사 실패는 dialog를 깨지 않는다. 상태 변경 없음.
    }
  };

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby="log-detail-title"
      onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className="modal-card log-detail-card">
        <div className="modal-head">
          <h3 id="log-detail-title">{t("logs.detailTitle")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}
            aria-label={t("common.cancel")}><IconX /></button>
        </div>

        <section className="log-detail-section" aria-labelledby="log-detail-basic">
          <h4 id="log-detail-basic" className="log-detail-section-title">{t("logs.detail.section.basic")}</h4>
          <dl className="log-detail-grid">
            <dt>{t("logs.col.status")}</dt>
            <dd><span className="mono font-semibold" style={{ color: statusColor(detail.status) }}>{detail.status}</span>{detailInfo && ` ${detailInfo.label}`}</dd>
            <dt>{t("logs.col.time")}</dt><dd className="mono">{formatLogDateTime(detail.timestamp, localeTag)}</dd>
            <dt>{t("logs.col.request")}</dt>
            <dd className="log-detail-request-row">
              <span className="mono log-detail-break">{detail.requestId ?? "—"}</span>
              {detail.requestId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyRequestId()}>{t(copied ? "logs.detail.copied" : "logs.detail.copyRequestId")}</button>}
            </dd>
            <dt>{t("logs.col.model")}</dt><dd className="mono">{modelLabel(detail.resolvedModel ?? detail.model)}</dd>
            <dt>{t("logs.col.provider")}</dt><dd>{detail.provider}</dd>
            {detail.errorCode && <><dt>{t("logs.col.error")}</dt><dd className="mono">{detail.errorCode}</dd></>}
            {detail.upstreamError && <><dt>{t("logs.col.upstreamReason")}</dt><dd className="mono log-detail-break">{detail.upstreamError}</dd></>}
          </dl>
          {detailInfo && <p className="modal-desc log-detail-reason">{detailInfo.description}</p>}
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-performance">
          <h4 id="log-detail-performance" className="log-detail-section-title">{t("logs.detail.section.performance")}</h4>
          <dl className="log-detail-grid">
            <dt>{t("logs.col.duration")}</dt><dd className="mono">{detail.durationMs}ms</dd>
            <dt>{t("logs.col.tokPerSec")}</dt><dd className="mono">{formatTokPerSecond(detail.displayMetrics?.tokPerSecond, numberLocale)}</dd>
            {detail.firstOutputMs !== undefined && <><dt>{t("logs.detail.ttft")}</dt><dd className="mono">{detail.firstOutputMs}ms</dd></>}
          </dl>
        </section>

        <CostSection cost={cost} locale={numberLocale} t={t} />
        {detail.attempts?.length ? <AttemptsSection attempts={detail.attempts} locale={numberLocale} t={t} /> : null}
        <UsageSection detail={detail} split={tokenSplit} locale={localeCode} t={t} />

        <details className="log-detail-raw">
          <summary>{t("logs.detailRaw")}</summary>
          <pre className="log-detail-json">{JSON.stringify(detail, null, 2)}</pre>
        </details>
      </div>
    </dialog>
  );
}
```

`LogDetailDialog` props에 `localeCode: string`을 추가하고 호출부에서 현재 `locale`을 넘긴다. `localeTag`는 날짜/화폐 number formatting에, `localeCode`는 `formatTokens()`의 ko/zh myriad 단위 선택에 사용한다 (`gui/src/format-tokens.ts:7-31`). `CostSection`, `AttemptsSection`, `UsageSection`은 같은 파일의 50줄 이하 focused component로 추출한다. 범용 helper/component 파일은 새로 만들지 않는다.

## 5. 비용 4분할과 사유 표시

### 성공 cost

`cost.kind === "value"`일 때 `cost.estimate.cost`와 `cost.estimate.price`를 쓴다.

```tsx
<section className="log-detail-section" aria-labelledby="log-detail-cost">
  <h4 id="log-detail-cost" className="log-detail-section-title">{t("logs.detail.section.cost")}</h4>
  <dl className="log-detail-grid">
    <dt>{t("logs.detail.costTotal")}</dt><dd className="mono">{formatEstimatedUsdValue(cost.estimate.cost.total, locale)}</dd>
    <dt>{t("logs.tokens.input")}</dt><dd className="mono">{formatEstimatedUsdValue(cost.estimate.cost.input, locale)}</dd>
    <dt>{t("logs.tokens.cacheRead")}</dt><dd className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheRead, locale)}</dd>
    <dt>{t("logs.tokens.cacheWrite")}</dt><dd className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheWrite, locale)}</dd>
    <dt>{t("logs.tokens.output")}</dt><dd className="mono">{formatEstimatedUsdValue(cost.estimate.cost.output, locale)}</dd>
    {cost.estimate.price && <>
      <dt>{t("logs.detail.matchedKey")}</dt><dd className="mono log-detail-break">{cost.estimate.price.jawcodeProvider ?? cost.estimate.price.provider}/{cost.estimate.price.modelId}</dd>
      <dt>{t("logs.detail.priceSource")}</dt><dd>{t(`logs.detail.source.${cost.estimate.price.source}`)} · {t("logs.detail.verification.verified")}</dd>
    </>}
  </dl>
  {cost.estimateReasons.length > 0 && (
    <ul className="log-detail-notes">
      {cost.estimateReasons.map(reason => <li key={reason}>{t(estimateReasonKey(reason))}</li>)}
    </ul>
  )}
</section>
```

모든 숫자는 `~$`다. `matched`가 없는 combo aggregate는 attempt table에서 각 jawcode key/source를 보여준다.

### unavailable cost

`cost` 부재(구버전 server) 또는 `kind === "unavailable"`이면 금액 자리에 `—`와 localized 사유를 보인다.

```tsx
<dt>{t("logs.detail.costTotal")}</dt><dd className="mono">—</dd>
<dt>{t("logs.detail.unavailableReason")}</dt>
<dd>{cost?.kind === "unavailable" ? t(metricReasonKey(cost.reason)) : t("logs.detail.reason.usage_missing")}</dd>
```

unverified expected overlay가 `matched`를 포함하면 key는 `${matched.jawcodeProvider ?? matched.provider}/${matched.modelId}`, source는 `Expected price overlay · Unverified`로 보이되 금액은 `—`다. 미매칭은 `price_unmatched`, 비정상 usage는 `invalid_usage`, cache 모순은 `invalid_cache_breakdown`, combo 일부 실패는 `combo_attempt_unavailable`로 구분한다.

## 6. raw usage 표시

`UsageSection`은 비용과 별개로 원본 token 수를 보인다.

```tsx
<dl className="log-detail-grid">
  <dt>{t("logs.tokens.input")}</dt><dd className="mono">{detail.usage ? formatTokens(detail.usage.inputTokens, locale) : "—"}</dd>
  <dt>{t("logs.tokens.output")}</dt><dd className="mono">{detail.usage ? formatTokens(detail.usage.outputTokens, locale) : "—"}</dd>
  <dt>{t("logs.tokens.cacheRead")}</dt><dd className="mono">{split.read !== undefined ? formatTokens(split.read, locale) : "—"}</dd>
  <dt>{t("logs.tokens.cacheWrite")}</dt><dd className="mono">{split.write !== undefined ? formatTokens(split.write, locale) : "—"}</dd>
  <dt>{t("logs.tokens.reasoning")}</dt><dd className="mono">{detail.usage?.reasoningOutputTokens !== undefined ? formatTokens(detail.usage.reasoningOutputTokens, locale) : "—"}</dd>
  <dt>{t("logs.detail.totalTokens")}</dt><dd className="mono">{displayTokenTotal(detail) !== undefined ? formatTokens(displayTokenTotal(detail)!, locale) : "—"}</dd>
</dl>
```

cache 값이 0으로 보고되면 `0`, field가 없으면 `—`다. “값 없음”과 “0 tokens”를 합치지 않는다. estimated usage면 섹션 아래에 기존 `logs.tokens.estimatedNote`; cache detail까지 없으면 `logs.tokens.noCacheNote`를 표시한다.

## 7. combo attempt 소테이블

attempt가 하나 이상일 때만 렌더한다. row key는 `${ordinal}-${provider}-${model}`이고 ordinal 순으로 정렬한다. 열은 다음 6개로 고정한다.

```text
# | provider / model | duration | tok/s | ~$ | reason
```

```tsx
<div className="log-detail-attempts-wrap">
  <table className="tbl log-detail-attempts">
    <thead><tr>
      <th className="num">#</th>
      <th>{t("logs.detail.attempt.target")}</th>
      <th className="num">{t("logs.col.duration")}</th>
      <th className="num">{t("logs.col.tokPerSec")}</th>
      <th className="num">{t("logs.col.estimatedCost")}</th>
      <th>{t("logs.detail.attempt.reason")}</th>
    </tr></thead>
    <tbody>{[...attempts].sort((a, b) => a.ordinal - b.ordinal).map(attempt => {
      const cost = attempt.displayMetrics?.cost;
      const reason = attempt.errorCode
        ?? (attempt.recoveryKinds.length ? attempt.recoveryKinds.join(", ") : undefined)
        ?? (cost?.kind === "unavailable" ? t(metricReasonKey(cost.reason)) : t("logs.detail.attempt.completed"));
      return <tr key={`${attempt.ordinal}-${attempt.provider}-${attempt.model}`}>
        <td className="num mono">{attempt.ordinal}</td>
        <td><span>{attempt.provider}</span><br /><span className="mono muted log-detail-break">{attempt.model}</span></td>
        <td className="num mono">{attempt.durationMs}ms</td>
        <td className="num mono">{formatTokPerSecond(attempt.displayMetrics?.tokPerSecond, locale)}</td>
        <td className="num mono">{formatEstimatedUsd(cost, locale)}</td>
        <td className="log-detail-break">{reason}</td>
      </tr>;
    })}</tbody>
  </table>
</div>
```

attempt 비용 tooltip 또는 target 아래 보조 줄에 matched `provider/model`, source/verification을 표시한다. expected unverified는 `~$0`이 아니라 `—` + localized reason이다. top-level combo tok/s는 전체 E2E 지표, attempt tok/s는 해당 attempt duration 기준임을 section 안내 문구로 명시한다.

WP4가 attempt별 `firstOutputMs`를 추가하더라도 이 table 열은 늘리지 않는다. 필요 시 target/reason cell의 title에서 TTFT를 제공하며, top-level detail의 optional TTFT 행과 구분한다.

## 8. 스타일 diff

### `gui/src/styles.css` — MODIFY

기존 `:694-714` 블록을 확장한다.

```css
.log-status-cell { min-width: 7ch; line-height: var(--leading-tight); }

.log-detail-card { max-width: 760px; }
.log-detail-section { padding: 14px 0; border-top: 1px solid var(--border-soft); }
.log-detail-section:first-of-type { padding-top: 0; border-top: 0; }
.log-detail-section-title {
  margin: 0 0 10px; font-size: var(--text-label);
  font-weight: var(--weight-semibold); color: var(--text);
}
.log-detail-grid { margin: 0; }
.log-detail-grid dt { color: var(--muted); }
.log-detail-grid dd { margin: 0; min-width: 0; }
.log-detail-request-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.log-detail-request-row > span { min-width: 0; }
.log-detail-reason { margin: 10px 0 0; }
.log-detail-notes { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: var(--text-label); }
.log-detail-attempts-wrap { overflow-x: auto; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.log-detail-attempts { min-width: 680px; }
.log-detail-attempts th, .log-detail-attempts td { vertical-align: top; }
.log-detail-raw { margin-top: 14px; }
.log-detail-raw > summary { cursor: pointer; color: var(--muted); font-size: var(--text-label); }
.log-detail-raw[open] > summary { margin-bottom: 6px; }
```

좁은 viewport 규칙을 760px media 안에 추가한다.

```css
.modal-overlay { padding: 16px 10px; }
.log-detail-card { max-height: calc(100dvh - 32px); padding: 16px; }
.log-detail-grid { grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr); gap: 8px 10px; }
.log-detail-request-row { align-items: flex-start; flex-direction: column; }
```

320px에서도 label/value 관계를 유지하기 위해 grid를 한 열로 완전히 무너뜨리지 않는다. attempt table만 내부 horizontal scroll을 사용한다. copy/close button은 기존 `.btn` touch target/focus style을 재사용한다.

## 9. i18n 4 locale 키

기존 `logs.detail*` 근처에 추가한다. 기술 field 이름(`TTFT`, `tok/s`, jawcode key)은 번역하지 않는다.

### 공통 구조/행

| key | en | ko | zh | de |
| --- | --- | --- | --- | --- |
| `logs.detail.section.basic` | `Basic information` | `기본 정보` | `基本信息` | `Grundinformationen` |
| `logs.detail.section.performance` | `Performance` | `성능` | `性能` | `Leistung` |
| `logs.detail.section.cost` | `Estimated cost` | `추정 비용` | `预估费用` | `Geschätzte Kosten` |
| `logs.detail.section.attempts` | `Combo attempts` | `Combo 시도` | `Combo 尝试` | `Combo-Versuche` |
| `logs.detail.section.usage` | `Raw usage` | `원본 usage` | `原始 usage` | `Roh-Nutzung` |
| `logs.detail.ttft` | `TTFT` | `TTFT` | `TTFT` | `TTFT` |
| `logs.detail.costTotal` | `Total` | `합계` | `总计` | `Gesamt` |
| `logs.detail.totalTokens` | `Total tokens` | `전체 토큰` | `Token 总数` | `Tokens gesamt` |
| `logs.detail.matchedKey` | `Matched jawcode key` | `매칭된 jawcode 키` | `匹配的 jawcode 键` | `Zugeordneter jawcode-Schlüssel` |
| `logs.detail.priceSource` | `Price source` | `가격 출처` | `价格来源` | `Preisquelle` |
| `logs.detail.unavailableReason` | `Unavailable reason` | `표시 불가 사유` | `不可用原因` | `Grund der Nichtverfügbarkeit` |
| `logs.detail.copyRequestId` | `Copy request ID` | `요청 ID 복사` | `复制请求 ID` | `Anfrage-ID kopieren` |
| `logs.detail.copied` | `Copied` | `복사됨` | `已复制` | `Kopiert` |

### source/verification/attempt

| key | en | ko | zh | de |
| --- | --- | --- | --- | --- |
| `logs.detail.source.jawcode` | `jawcode catalog` | `jawcode 카탈로그` | `jawcode 目录` | `jawcode-Katalog` |
| `logs.detail.source.expected` | `Expected price overlay` | `expected 가격 오버레이` | `Expected 价格覆盖` | `Expected-Preis-Overlay` |
| `logs.detail.verification.verified` | `Verified` | `검증됨` | `已验证` | `Verifiziert` |
| `logs.detail.verification.unverified` | `Unverified` | `미검증` | `未验证` | `Nicht verifiziert` |
| `logs.detail.attempt.target` | `Provider / model` | `프로바이더 / 모델` | `提供方 / 模型` | `Anbieter / Modell` |
| `logs.detail.attempt.reason` | `Result / reason` | `결과 / 사유` | `结果 / 原因` | `Ergebnis / Grund` |
| `logs.detail.attempt.completed` | `Completed` | `완료` | `已完成` | `Abgeschlossen` |
| `logs.detail.attempt.e2eNote` | `Top-level tok/s is end-to-end; each attempt uses its own duration.` | `상위 tok/s는 전체 요청 기준이며 각 시도는 자체 소요 시간을 사용합니다.` | `顶层 tok/s 为端到端值；每次尝试使用各自耗时。` | `Tok/s auf oberster Ebene ist Ende-zu-Ende; jeder Versuch nutzt seine eigene Dauer.` |

### unavailable/estimated reason enum

| suffix | en | ko | zh | de |
| --- | --- | --- | --- | --- |
| `reason.usage_missing` | `Usage was not reported.` | `usage가 보고되지 않았습니다.` | `未上报 usage。` | `Nutzung wurde nicht gemeldet.` |
| `reason.usage_unsupported` | `This provider does not report usage.` | `이 프로바이더는 usage 보고를 지원하지 않습니다.` | `该提供方不支持上报 usage。` | `Dieser Anbieter meldet keine Nutzung.` |
| `reason.output_missing` | `No positive output token count was reported.` | `양수 출력 토큰 수가 보고되지 않았습니다.` | `未上报正数输出 token。` | `Es wurden keine positiven Ausgabe-Tokens gemeldet.` |
| `reason.invalid_duration` | `The request duration is not valid.` | `요청 소요 시간이 유효하지 않습니다.` | `请求耗时无效。` | `Die Anfragedauer ist ungültig.` |
| `reason.price_unmatched` | `No matching jawcode price was found.` | `매칭되는 jawcode 가격을 찾지 못했습니다.` | `未找到匹配的 jawcode 价格。` | `Kein passender jawcode-Preis gefunden.` |
| `reason.expected_price_unverified` | `The expected price overlay is not verified.` | `expected 가격 오버레이가 검증되지 않았습니다.` | `Expected 价格覆盖尚未验证。` | `Das Expected-Preis-Overlay ist nicht verifiziert.` |
| `reason.invalid_cache_breakdown` | `Cache token details conflict with total input tokens.` | `캐시 토큰 상세가 전체 입력 토큰과 모순됩니다.` | `缓存 token 明细与输入 token 总数冲突。` | `Cache-Token-Details widersprechen den Eingabe-Tokens.` |
| `reason.invalid_usage` | `Usage contains an invalid token value.` | `usage에 유효하지 않은 토큰 값이 있습니다.` | `Usage 包含无效的 token 值。` | `Die Nutzung enthält einen ungültigen Token-Wert.` |
| `reason.combo_attempt_unavailable` | `At least one combo attempt could not be priced.` | `하나 이상의 combo 시도 비용을 계산할 수 없습니다.` | `至少一次 Combo 尝试无法计价。` | `Mindestens ein Combo-Versuch konnte nicht bepreist werden.` |
| `estimate.usage_estimated` | `Provider usage is estimated.` | `프로바이더 usage가 추정치입니다.` | `提供方 usage 为估算值。` | `Die Anbieternutzung ist geschätzt.` |
| `estimate.cache_detail_missing` | `Cache details were unavailable; input is an upper-bound estimate.` | `캐시 상세가 없어 입력 전액을 상한으로 추정했습니다.` | `缺少缓存明细；输入费用按上限估算。` | `Cache-Details fehlen; Eingabe ist als Obergrenze geschätzt.` |
| `estimate.expected_price_overlay` | `A verified expected list price was used.` | `검증된 expected 정가를 사용했습니다.` | `使用了已验证的 Expected 标价。` | `Ein verifizierter Expected-Listenpreis wurde verwendet.` |

key 이름은 020의 union suffix와 정확히 같아야 한다. dynamic `t()`가 `TKey`로 추론되지 않으면 helper return type을 위 명세처럼 template-literal union으로 제한하며 `as TKey` 광역 캐스트를 쓰지 않는다.

## 10. close gate

### 정적 검증

워크트리 루트에서 실행한다.

```bash
bun run typecheck
bun test --isolate tests/usage-cost* tests/management-api-logs-metrics.test.ts
(cd gui && bun run lint:i18n)
(cd gui && bun run build)
```

모두 exit 0이어야 한다. 특히 다음을 코드 검색/리뷰로 확인한다.

```bash
rg -n 'status >= 400|attempts\?:|firstOutputMs\?:|log-detail-section|log-detail-attempts' gui/src/pages/Logs.tsx gui/src/styles.css
```

- `status >= 400` detail gate가 0건이어야 한다. status color 로직의 `status >= 400`은 허용되므로 검색 결과를 문맥별로 판독한다.
- `attempts?: LogAttempt[]`, entry/attempt optional `firstOutputMs`, section/attempt class가 존재해야 한다.
- 서버/request-log/usage/cost/generated 파일은 WP3 diff에 없어야 한다.

### 렌더 그라운딩

020과 같은 Vite proxy 방식으로 아래 네 상태를 준비한다.

1. 성공 행: status 200, verified matched cost, cache read/write 포함, requestId 있음.
2. combo 행: attempts 2개 이상. 하나는 성공, 하나는 recovery/error reason을 가지며 attempt별 provider/model/duration/tok/s/cost가 다름.
3. estimated 행: usageStatus estimated, cache detail 없음, `usage_estimated` + `cache_detail_missing` 노출.
4. 미매칭 또는 unverified 행: 금액 `—`, matched key/source/verification 또는 `price_unmatched` 사유 노출.

native browser QA 도구에서:

1. status 200 행에도 `Details`/`상세보기`가 보이는지 확인하고 클릭한다.
2. 성공 popup을 1440×1000에서 캡처한다. 기본/성능/비용/원본 섹션, 네 비용 항목 모두 `~$`, cache token 원본, copy button을 확인한다.
3. combo popup을 캡처한다. attempt 소테이블의 행 수/순서/provider/model/duration/tok/s/~$/reason을 확인한다.
4. estimated popup을 캡처한다. `~`/`~$`, 두 estimated reason, cache 값 `—`가 보이는지 확인한다.
5. 390×844와 320×700에서 popup을 캡처한다. card가 viewport 밖으로 빠지지 않고 자체 vertical scroll이 되며, attempt table만 내부 horizontal scroll되는지 확인한다.
6. keyboard로 성공 행 Details에 focus→Enter, dialog close에 focus, Escape close, reopen, requestId copy button까지 tab 이동을 확인한다. focus trap은 native modal dialog 범위 안이어야 한다.
7. `firstOutputMs` 없는 fixture에서 TTFT label 자체가 없어야 한다. optional field를 넣은 fixture에서는 정확한 ms 한 행만 나타나야 한다.
8. raw log `<details>`는 기본 닫힘이며 열었을 때 JSON이 card 폭을 깨지 않아야 한다.

스크린샷 기록 형식:

```text
success-detail-desktop (1440): <path>
combo-detail-desktop (1440): <path>
estimated-detail-desktop (1440): <path>
detail-mobile (390): <path>
detail-narrow (320): <path>
keyboard/focus/Escape/copy: checked | issue
TTFT absent/present: checked | issue
```

### WP3 close 판정

- [ ] 성공/실패/취소를 포함한 모든 행에 localized 상세 버튼이 있다.
- [ ] modal은 기본/성능/비용/combo attempts/원본 usage/raw log로 구분된다.
- [ ] tok/s는 E2E이고 TTFT는 optional 별도 행이다.
- [ ] total/input/cacheRead/cacheWrite/output 비용은 표시 가능한 경우 전부 `~$`다.
- [ ] matched jawcode key, expected source, verified/unverified, estimated/미매칭 사유가 구분된다.
- [ ] raw cache token 수에서 0과 missing이 구분된다.
- [ ] combo attempt별 provider/model/duration/tok/s/~$/reason이 보인다.
- [ ] 4 locale parity, typecheck, GUI build가 exit 0이다.
- [ ] 성공/combo/estimated popup과 390/320 viewport 스크린샷, keyboard/Escape/copy 증거가 있다.
