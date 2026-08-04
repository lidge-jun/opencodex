# WP8 — PR #405 free-provider 디렉터리 (메타데이터 모듈만)

대상: PR #405 (HaydernCenterpoint), head `a70e0cc4`. 텍스트 병합은 clean이지만
registry 병합 훅이 **의미상 충돌**한다.

**선행: WP7 (A-gate blocker 8).** 두 work-phase가 `tests/provider-registry-parity.test.ts`를
공유하고, WP7은 `src/providers/registry.ts`를 수정하는데 WP8은 바로 그 파일의 불변조건을
잠근다. 병렬 실행하거나 커밋을 독립 준비하면 안 된다. WP7 완료 후 재검증한다.

## 결함 — 디렉터리 ID가 canonical runtime ID가 됨

PR은 `FREE_PROVIDER_DIRECTORY`를 `PROVIDER_REGISTRY`에 spread한다. 그러면
`qoder`, `vertex`, `baidu`, `cloudflare-ai` 같은 ID가 정식 런타임 ID가 된다.
`routedProviderConfig()`는 무조건 registry를 조회하므로, 같은 이름의 사용자 정의
provider가 destination·adapter·모델 목록·discovery 동작까지 통째로 교체된다.

부수 결함:

- `deriveProviderPresets()`가 reference 전용 행까지 `accessGroups`를 달아 내보내는데,
  현재 GUI에는 actionable/reference 구분 계약이 없다.
- 다수 항목이 `lastVerified: "2026-07-23"`을 주장하지만 항목별 출처가 없고,
  일부는 명시적으로 `unverified`다.

## 검증 날짜 정정 (A-gate blocker 7)

실제 타입은 `#405:src/providers/free-directory.ts:35` 기준으로 다음과 같다.

```ts
verification: "official" | "primary" | "unverified";
```

**`"verified"`라는 값은 존재하지 않는다** (A-gate R2 blocker 6). 최초 안이 쓴
`entry.verification === "verified"`는 TS2367을 낸다. 아래 규칙은 실제 union으로 표현한다.

`:50`의 `const LAST_VERIFIED = "2026-07-23"`이 `:163`에서 **모든** 생성 항목에 균일 부여된다.
`verification: "unverified"` 항목도 예외가 아니다. 현재 import되지 않아 런타임 자격증명
라우팅 위험은 없지만, 이후 UI가 소비할 때 거짓 근거가 된다.

따라서 원본 파일을 그대로 넣지 않는다. B 단계에서 아래를 적용한다.

1. `lastVerified`를 optional(`lastVerified?: string`)로 바꾸고,
   `verification === "unverified"` 항목에서는 부여하지 않는다.
2. `documentationUrl`이 이미 항목별 출처 역할을 한다. 새 필드를 만들지 않고 이를
   provenance로 승격한다: `verification !== "unverified"`인 항목은
   `documentationUrl`이 반드시 있어야 한다.
3. `documentationUrl`이 없는 비-unverified 항목은 `unverified`로 강등하고
   `lastVerified`를 제거한다. 항목 자체를 삭제하지는 않는다.

항목을 통째로 드롭하지 않는 이유는 R2 blocker 7에서 드러났다. `qoder`는
`:22`의 `accessGroups` 목록에만 있고 `documentationUrl`이 없는데, 아래 shadow 방지
테스트가 `qoder`의 존재를 요구한다. 드롭 규칙과 테스트가 동시에 성립할 수 없다.
강등 규칙은 두 요구를 모두 만족시킨다: `qoder`는 목록에 남되 `unverified`가 되고
`lastVerified`를 갖지 않는다.

## 범위

TAKE:

```
A src/providers/free-directory.ts
```

DO NOT TAKE:

```
M src/providers/derive.ts
M src/providers/registry.ts
M tests/provider-registry-parity.test.ts
```

특히 아래를 `PROVIDER_REGISTRY`에 추가하지 않는다:

```ts
...FREE_PROVIDER_DIRECTORY.map(entry => ({
  ...entry,
  directoryOnly: true,
}))
```

결과적으로 이번 통합은 아무 곳에서도 import되지 않는 불활성 메타데이터 모듈 하나를
추가한다. 이것이 의도다. 이후 UI 슬라이스가 별도 read-only DTO로 소비하되,
다음 조건을 만족해야 actionable로 노출한다:

```ts
actionable: entry.supportLevel !== "reference"
  && entry.verification !== "unverified"
  && Boolean(entry.dashboardUrl)
  && Boolean(entry.baseUrl)
```

provider 생성 엔드포인트가 `actionable:false`를 독립적으로 거부해야 한다.
버튼 비활성화는 보안 경계가 아니다.

## 회귀 테스트

아래 테스트는 WP7이 `tests/provider-registry-parity.test.ts`를 먼저 수정한 뒤에 추가한다.

APPEND: `tests/provider-registry-parity.test.ts`

추가로 검증 날짜 정정을 잠그는 케이스를 함께 넣는다.

```ts
test("unverified directory entries do not claim a verification date", () => {
  for (const entry of FREE_PROVIDER_DIRECTORY) {
    if (entry.verification === "unverified") {
      expect(entry.lastVerified).toBeUndefined();
    } else {
      expect(entry.documentationUrl).toBeTruthy();
      expect(entry.lastVerified).toBeTruthy();
    }
  }
});
```

RED→GREEN 근거: 수정 전에는 모든 항목이 `lastVerified`를 가지므로 `unverified` 항목의
첫 assertion에서 실패한다.

```ts
test("free-directory metadata cannot shadow a custom runtime provider", () => {
  expect(FREE_PROVIDER_DIRECTORY.some(entry => entry.id === "qoder")).toBe(true);
  expect(PROVIDER_REGISTRY.some(entry => entry.id === "qoder")).toBe(false);

  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "qoder",
    providers: {
      qoder: {
        adapter: "openai-chat",
        baseUrl: "https://custom.example.test/v1",
        apiKey: "test-key",
        liveModels: true,
      },
    },
  };

  const routed = routeModel(config, "qoder/custom-model");
  expect(routed.provider).toMatchObject({
    adapter: "openai-chat",
    baseUrl: "https://custom.example.test/v1",
    liveModels: true,
  });
  expect(routed.modelId).toBe("custom-model");
});
```

RED→GREEN 근거: PR 원안대로 registry에 병합하면 `qoder`가 전역 registry 항목이 되어
두 번째 assertion과 `routed.provider` 비교가 실패한다. 메타데이터 모듈만 취하면 통과한다.

이 테스트는 "우리가 취하지 않기로 한 변경"을 잠그는 잠금장치다. 나중에 누군가
registry 병합을 되살리면 즉시 빨간불이 켜진다.

## 활성화 시나리오

런타임 분기를 추가하지 않는다. 활성화 증거는 `routeModel`이 사용자 정의 `qoder`를
registry로 덮어쓰지 않고 그대로 반환하는 것이다.

## 커밋

```
docs(providers): add free-provider directory metadata (#405)

Co-authored-by: Haydern <oriskinhaydern@gmail.com>
```

## 검증

```bash
bun test --isolate tests/provider-registry-parity.test.ts
bun run typecheck
```
