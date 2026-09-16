# 010 — wp1: #4420 carry (SWE-2 명시 effort가 접미사를 이긴다)

- 원 PR: https://github.com/lidge-jun/opencodex/pull/4420 (`Smartnewb`, draft)
- 원 head: `6a456fb2af306a2d30a36e2f884c75318d3dd18b`, base `f5b2a0d00` (현재 `dev`보다 27커밋 뒤)
- patch: `.tmp/research/4420.patch` (sha256 `3a03dda5064298c5c156dbed0b14865451967f2f9bbba04f2dacd8d86ae93227`)
- apply 검증: `git apply --check` / `--3way --check` 둘 다 EXIT 0, reject 없음 (레인 E)

## 왜 아직 필요한가

현재 `dev`(`7ca00ffe7`)의 `src/adapters/devin.ts:99-106`:

```ts
async function resolveWireModelUid(
  rawModelId: string,
  apiKey: string,
  host: string,
  reasoningEffort?: string,
): Promise<string> {
  const modelId = normalizeDevinModelId(rawModelId);
  if (hasEffortSuffix(modelId)) return modelId;   // <- 여기서 끝난다
```

`swe-2-high`를 명시 effort `medium`으로 부르면 `hasEffortSuffix`가 참이라 즉시 반환되고,
호출자가 지정한 `medium`은 버려진다. `#4415`가 ACP를 걷어낸 뒤 이 공유 어댑터에는
SWE-2 재작성 경로가 없다. `rg` 결과 `swe-2` 정규식도, `SWE-2 wire effort selection`
describe도 트리에 없다.

## MODIFY: src/adapters/devin.ts

`resolveWireModelUid`를 export하고, `hasEffortSuffix` 조기 반환 **앞에** SWE-2 분기를 넣는다.

```ts
// before
  const modelId = normalizeDevinModelId(rawModelId);
  if (hasEffortSuffix(modelId)) return modelId;

// after
  const modelId = normalizeDevinModelId(rawModelId);
  const swe2 = resolveSwe2Variant(modelId, reasoningEffort);
  if (swe2) return swe2;
  if (hasEffortSuffix(modelId)) return modelId;
```

신규 헬퍼 (원 PR은 인라인이었다 — grok-bot이 지적한 이중 유지보수를 피해 분리한다):

```ts
const SWE2_EFFORT: Record<string, "medium" | "high" | "max"> = {
  none: "medium", off: "medium", minimal: "medium", low: "medium", medium: "medium",
  high: "high",
  xhigh: "max", ultra: "max", max: "max",
};

function resolveSwe2Variant(modelId: string, reasoningEffort?: string): string | undefined {
  if (!/^swe-2(?:-(?:medium|high|max))?$/.test(modelId)) return undefined;
  const mapped = reasoningEffort ? SWE2_EFFORT[reasoningEffort.toLowerCase()] : undefined;
  return mapped ? `swe-2-${mapped}` : undefined;
}
```

effort를 안 줬거나 모르는 값이면 `undefined`를 돌려 기존 경로가 그대로 돈다.
`EFFORT_SUFFIXES`(`devin.ts:69`)에 `ultra`/`off`/`minimal`이 없다는 사실은 이 표가
별도로 필요한 이유이자, 표를 한 곳에 모아야 하는 이유다.

## MODIFY: tests/providers/devin-adapter.test.ts

`SWE-2 wire effort selection` describe를 추가한다. 원 PR의 4케이스에 회귀 2건을 더한다.

| 입력 modelId | reasoningEffort | 기대 UID |
|---|---|---|
| `swe-2-high` | `medium` | `swe-2-medium` |
| `swe-2` | `xhigh` | `swe-2-max` |
| `swe-2-medium` | `high` | `swe-2-high` |
| `swe-2-high` | (없음) | `swe-2-high` |
| `swe-2-high` | `bogus` | `swe-2-high` |
| `gpt-5-6-sol-high` | `medium` | `gpt-5-6-sol-high` (타 계열 불변) |

import 라인 2를 `resolveWireModelUid` 포함으로 바꾼다.

## MODIFY: 문서 2개만

- `docs-site/src/content/docs/reference/adapters.md` — `devin` 절에 SWE-2 effort 문단 1개
- `structure/adapters/registry.md` — 소유권 문장 1줄

원 PR이 같은 문장을 `structure/data-planes/inbound-compat.md`,
`structure/providers/chat-compat.md`, `structure/providers/cursor.md`,
`structure/runtime.md`, `structure/transports/inventory.md`,
`structure/transports/responses.md` 6곳에 복붙했다. grok-bot 리뷰가 지적한 대로
structure-gate 인접성을 통과하려는 잡음이므로 **omit**한다. 만약 `structure:check`가
hosted CI에서 이를 요구하면 그때 되살린다 (CI가 판정자).

## 커밋 메시지

```text
fix(devin): apply explicit SWE-2 effort before model suffix

Carry #4420 from 6a456fb2af306a2d30a36e2f884c75318d3dd18b onto 7ca00ffe7.
An explicit SWE-2 reasoning effort must win over a picker suffix, so
swe-2-high + medium becomes swe-2-medium before hasEffortSuffix
short-circuits. Omitted or unknown effort keeps the variant; other
families keep suffix precedence.

The effort map is a named table rather than an inline branch, because
EFFORT_SUFFIXES does not carry ultra/off/minimal and the two would drift.
The six copy-paste structure hunks from the source PR are omitted.

Local product tests / typecheck / build / install: NOT RUN.
Hosted exact-head CI on this PR is the merge proof.

Co-authored-by: Smartnewb <159137930+Smartnewb@users.noreply.github.com>
```

## 착지 후

- #4420을 close하고 carry PR을 가리키는 코멘트를 남긴다 (`dev` 타깃이라 자동 close 안 됨).
- #4416은 이미 closed. ACP는 되살리지 않는다.

