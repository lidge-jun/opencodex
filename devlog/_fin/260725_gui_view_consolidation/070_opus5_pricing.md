# WP7 — `claude-opus-5` 예상 가격 등록

## 목적

`claude-opus-5` 사용량에 가격을 매칭해 Logs의 `~$` 열이 `—` 대신 예상 비용을
표시하게 한다. 사용자가 확인한 “이전 Opus와 동일 가격”만 근거로 삼으므로 공식 가격
확정값이 아니라 `verified-derived` 예상값으로 등록한다(`000_plan.md:313-342`).

## 현재 상태(증거)

`CLAUDE_OPUS_46`은 이미 USD/백만 토큰 기준
`{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }`로 정의돼 있다
(`src/usage/expected-prices.ts:41-44`). 이번 변경은 새 숫자를 만들지 않고 이 상수를
재사용한다.

`claude-opus-5`를 노출하는 표면은 세 provider다.

- Anthropic OAuth/API-key 공용 시드: `src/providers/registry.ts:99-104`
- Cursor discovery: `src/adapters/cursor/discovery.ts:181-186`
- Kiro 모델 목록: `src/providers/kiro-models.ts:1-9`

반면 `rg -n 'claude-opus-5' src/generated/jawcode-model-metadata.ts`와
`rg -n 'claude-opus-5' src/usage/expected-prices.ts`는 모두 0건이다. 따라서 현재
`resolveMatchedPrice(provider, "claude-opus-5")`는 다음 순서에서 모두 실패한다.

1. provider bundle의 jawcode exact 가격을 찾지만 생성 메타데이터에 모델이 없다
   (`src/usage/cost.ts:185-203`).
2. exact `(provider, modelId)` 오버레이를 찾지만 등록 행이 없다
   (`src/usage/cost.ts:204-218`, `src/usage/expected-prices.ts:120-131`).
3. 모델 레벨 vendor fallback은 오버레이가 아니라
   `findJawcodeCostByModelId(modelId)`만 조회한다. dot→dash 보정까지 해도 생성
   메타데이터에 모델 자체가 없으므로 실패한다(`src/usage/cost.ts:221-235`).
4. 그 결과 `null`을 반환하고, 비용 매칭 계약상 UI는 em dash를 표시한다
   (`src/usage/cost.ts:1-10`, `src/usage/cost.ts:169-183`).

실행 확인도 동일하다.

```text
$ bun -e '... resolveMatchedPrice(provider, "claude-opus-5") ...'
anthropic null
cursor null
kiro null
```

### provider별 행 수 판정

**`anthropic` 한 행만으로는 부족하다. 세 provider 행이 모두 필요하다.** 현재의
교차 provider fallback은 jawcode 모델 가격만 공유하고 expected-price overlay는
공유하지 않는다(`src/usage/cost.ts:204-206`, `src/usage/cost.ts:221-227`). 즉
Anthropic exact overlay가 생겨도 Cursor/Kiro 조회가 그 행을 보지 않는다. resolver를
변경하지 않는 WP7 범위에서는 `anthropic`, `cursor`, `kiro` exact 행을 각각 추가해야
한다. 기존 Kiro Opus 4.6 테스트는 fallback이 jawcode vendor 행을 찾을 때만
성공한다는 대조 사례다(`tests/usage-cost.test.ts:105-113`).

## 변경 계획(구체적 diff 형태)

`src/usage/expected-prices.ts`의 Anthropic 가격 상수 아래에 출처 문자열을 추가하고,
`EXPECTED_PRICE_OVERLAYS`에 아래 세 행을 넣는다. `verifiedAt`은 사용자 근거를 이
저장소에 등록한 날짜이며 공식 가격 페이지 확인일로 해석하지 않는다.

```diff
 const CLAUDE_OPUS_46: Cost4 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
+const CLAUDE_OPUS_5_DERIVED_SOURCE = "user-confirmed: claude-opus-5 matches Claude Opus 4.6; no separate Anthropic Opus 5 price page verified";
```

```diff
 export const EXPECTED_PRICE_OVERLAYS: readonly ExpectedPriceOverlay[] = [
+  { provider: "anthropic", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
+  { provider: "cursor", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
+  { provider: "kiro", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
```

`tests/usage-cost.test.ts`에는 shipped overlay를 열거하는 테스트가 이미 있으므로 반드시
갱신한다. 현재 제목은 “43 keys”인데 실제 길이 assertion은 45이며
(`tests/usage-cost.test.ts:194-197`), 다음처럼 목표 상태를 48개로 맞춘다.

```diff
-test("16. shipped overlay membership: 43 keys, including Gemini 3.6 and compatibility prices", () => {
-  expect(EXPECTED_PRICE_OVERLAYS.length).toBe(45);
+test("16. shipped overlay membership: 48 keys, including Opus 5 and compatibility prices", () => {
+  expect(EXPECTED_PRICE_OVERLAYS.length).toBe(48);
   // existing keys...
+  "anthropic/claude-opus-5",
+  "cursor/claude-opus-5",
+  "kiro/claude-opus-5",
```

같은 `describe("resolveMatchedPrice")`에 세 provider의 실제 해석 결과도 고정한다.

```ts
test("claude-opus-5 uses the user-derived Opus 4.6 price on every exposing provider", () => {
  for (const provider of ["anthropic", "cursor", "kiro"]) {
    const price = resolveMatchedPrice(provider, "claude-opus-5");
    expect(price).toMatchObject({
      provider,
      modelId: "claude-opus-5",
      cost4: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      source: "expected",
      status: "verified-derived",
    });
    expect(price?.sourceRef).toContain("user-confirmed");
  }
});
```

## 검증

집중 확인:

```bash
bun test tests/usage-cost.test.ts
rg -n 'claude-opus-5' src/usage/expected-prices.ts tests/usage-cost.test.ts
```

전체 게이트 (`000_plan.md` 필수 항목 전부):

```bash
bun run typecheck
bun run lint:gui
bun run test                      # 루트 스위트 (./tests/)
(cd gui && bun test tests)        # GUI 스위트 — 루트 test 는 gui/tests 를 돌리지 않는다
bun run privacy:scan
bun run build:gui
git diff --check
```

**필수 통합 단언 (선택 아님).** 목표 기준 (6)은 "로그에서 `—` 가 아닌 실제 값"이다.
따라서 `resolveMatchedPrice` 단위 테스트만으로는 충족되지 않는다. 세 provider
각각에 대해 `claude-opus-5` 사용량 행이 non-null 비용으로 해석되는지 결정론적으로
단언하고, 그 뒤 실행 중인 프록시의 Logs 화면에서 `~$` 열이 숫자인지 스크린샷으로
남긴다.

## 위험

- 가격 근거는 공식 Opus 5 가격표가 아니라 사용자의 동일가 확인이다. `verified`로 올리거나 `ANTHROPIC_PRICING`을 직접 출처로 쓰면 증거 수준을 과장한다.
- 세 exact 행 중 하나라도 빠지면 해당 provider는 계속 `null`이다. jawcode fallback이 expected overlay까지 공유한다고 가정하면 안 된다.
- 향후 jawcode 메타데이터에 공식 nonzero Opus 5 가격이 들어오면 jawcode exact가 overlay보다 우선한다(`src/usage/cost.ts:190-204`). 그때 세 파생 overlay의 필요성과 출처를 재검토한다.
- overlay 개수 assertion과 키 목록을 함께 갱신하지 않으면 테스트가 의도와 무관하게 깨지거나 누락을 잡지 못한다.
