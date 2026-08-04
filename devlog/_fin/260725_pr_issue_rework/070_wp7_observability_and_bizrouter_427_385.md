# WP7 — Memory observability와 BizRouter: PR #427/#385 통합

## 루프 계약

- **Archetype:** 충돌 PR의 current-dev rebase와 clean provider preset PR을 한 work-phase에서 순서대로 통합하고, 각각의 누락된 표시/contract test를 보강하는 integration-and-repair.
- **Trigger:** #427은 response-state memory metrics와 dashboard card를 추가하지만 old Dashboard 구조를 기준으로 해 충돌하고 byte formatter 단위/locale이 부정확하다. #385는 BizRouter preset을 추가하지만 parity 목록 외 discovery contract를 고정하지 않는다.
- **Goal:** #427의 backend/docs/i18n/card를 보존하면서 현재 tabbed Dashboard의 Overview stack에 카드를 정확히 재배치하고 locale-aware KiB/MiB를 사용한다. 이어 #385를 적용하고 BizRouter preset 및 OpenAI-list discovery shape를 focused test로 고정한다.
- **Non-goals:** memory watchdog 정책/threshold 변경, 진단 payload 확장, request body/token/path/account ID 노출, BizRouter featured/sponsorship 처리, provider 신뢰를 자동 승인, #405/#434 provider directory 통합.
- **Verifier:** pinned heads/apply-check → #427 partial apply + manual Dashboard rebase → formatter test → #385 + focused registry/discovery test → focused suites → GUI lint/build → typecheck/full/privacy. C 단계 독립 reviewer는 Dashboard 위치와 management/privacy 경계를 재검토한다.
- **Stop condition:** 두 pinned PR과 아래 delta가 반영되고 #427 card가 Overview tab 안에 정확히 한 번 렌더되며, binary 단위/locale 및 BizRouter discovery shape 회귀가 green이고 maintainer trust decision이 기록된다.
- **Terminal outcomes:** `MERGE_OK`, `REWORK`, `STALE`, `BLOCKED_BY_TRUST_REVIEW`(#385 등록 승인 없음), `BLOCKED`(rebase 또는 검증 실패).

## 착수 시점 사실

- 기준 시각: 2026-07-25 KST.
- worktree는 `/Users/jun/.codex/worktrees/ebcd/opencodex`, 실제 상태는 detached HEAD이며 `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad`.
- PR #427: base `dev`, head `a4a212d6403a6f499a76322502b271cb51383bb6`, 13 files, `+417/-2`. 원문 diff 585줄 전량 확인.
- #427 files: `src/responses/state.ts`, `src/server/management/system-routes.ts`, `gui/src/components/MemoryObservabilityCard.tsx`(NEW), `gui/src/pages/Dashboard.tsx`, `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts`, `tests/memory-watchdog.test.ts`, `tests/responses-state.test.ts`, `docs-site/src/content/docs/troubleshooting/windows-memory.md`.
- `gh pr diff 427 --repo lidge-jun/opencodex | git apply --check -` → exit 1. 유일한 text conflict는 `gui/src/pages/Dashboard.tsx:1`; 현재 dev가 Classic view를 제거하고 tabbed workspace/layout을 복원한 뒤 PR의 old outer-return hunk가 더는 적용되지 않는다.
- `gh pr diff 427 --repo lidge-jun/opencodex | git apply --check --exclude=gui/src/pages/Dashboard.tsx -` → exit 0. Dashboard를 제외한 12 files는 clean apply된다.
- 현재 Dashboard는 `Dashboard({ apiBase })`, `overview/providers/models` 3개 tab, `overviewSection`의 `.dash-overview-stack`, `sections[]`, 단일 tabpanel 구조다(`gui/src/pages/Dashboard.tsx:715-716,1125-1152,1403-1458`). PR의 `viewMode`/outer closing-div 기준 hunk를 되살리면 안 된다.
- PR #385: base `dev`, head `ac0260b7afa06c38588f21fee9dadfadb09ce2d3`, 2 files, `+13/-1`. 원문 diff 36줄 전량 확인.
- `gh pr diff 385 --repo lidge-jun/opencodex | git apply --check -` → exit 0, 출력 없음(clean).
- #385 작성자는 PR 본문에 “I work with the BizRouter team”이라고 관계를 공개했고, 2026-07-24 기준 `/v1/chat/completions` tools+SSE, `/v1/models` OpenAI list shape, opencodex/real Codex CLI E2E를 검증했다고 기재했다. 이는 contributor-provided evidence이며 registry 등록의 신뢰 판단을 대신하지 않는다.

### #427 privacy/auth 근거

- `src/responses/state.ts`가 추가하는 `ResponseStateMetrics`는 `count`, `totalBytes`, `largestBytes`, `oldestAgeMs` 네 숫자뿐이다. 함수는 store를 순회해 count/bytes/age만 읽으며 body/content/token/path/account metadata를 반환하지 않는다.
- `src/server/management/system-routes.ts`의 response는 기존 scalar memory fields와 위 block만 포함한다. PR 테스트도 각 필드가 number인지 확인한다.
- `/api/system/memory`는 unauthenticated `/healthz`가 아니다. `src/server/index.ts:332-336`이 모든 `/api/*` 요청에 `requireApiAuth(req, config, "management")`를 먼저 적용한 뒤 `handleManagementAPI`를 호출하고, `src/server/management-api.ts:124-133`이 같은 context로 `handleSystemRoutes`까지 dispatch한다.
- 따라서 기존 management auth 경계를 재사용하며, 새 credential/logging 경로는 없다. `bun run privacy:scan`과 response-shape tests는 여전히 필수다.

## 변경 계약

### 1. PR #427 — Dashboard 제외 clean apply

```bash
test "$(gh pr view 427 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)" = "a4a212d6403a6f499a76322502b271cb51383bb6"
gh pr diff 427 --repo lidge-jun/opencodex | git apply --exclude=gui/src/pages/Dashboard.tsx -
```

PR의 나머지 12 files는 그대로 적용한다. DELETE는 없다.

### 2. #427 Dashboard current-dev rebase — 가장 중요한 계약

PR의 original Dashboard hunk는 old file에 import 하나를 추가하고 outer content 마지막에 카드를 놓는다.

```diff
-import { formatUptime } from "../formatUptime";
+import { formatUptime } from "../formatUptime";
+import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
@@ old Dashboard outer return
+      <MemoryObservabilityCard apiBase={apiBase} />
```

현재 dev에서는 카드를 `sections`/tabpanel 바깥에 넣으면 모든 tab에서 보이고, old `viewMode` 구조를 복원하면 fa1af1b2 이후 layout 계약을 되돌린다. 반드시 `overviewSection`의 `.dash-overview-stack` 내부, 상단 status/startup-health 묶음 직후이자 project-config warning 앞에 삽입한다.

```diff
diff --git a/gui/src/pages/Dashboard.tsx b/gui/src/pages/Dashboard.tsx
--- a/gui/src/pages/Dashboard.tsx
+++ b/gui/src/pages/Dashboard.tsx
@@
 import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
 import { formatUptime } from "../formatUptime";
+import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
 import { IconAlert, IconChevron, IconExternal, IconInfo, IconRefresh, IconSearch, IconX } from "../icons";
@@
       </div>
 </div>
 
+<MemoryObservabilityCard apiBase={apiBase} />
+
 {projectConfigWarnings.length > 0 && (
   <div className="notice notice-err maintenance-notice" role="alert">
```

고정점은 현재 파일의 `gui/src/pages/Dashboard.tsx:773-794` startup health block 종료와 `:796` project warning 시작 사이다. `sections` 배열, `selected.body`, tab roles/IDs, `updateDialog`, Overview의 기존 panels는 수정하지 않는다. `MemoryObservabilityCard`는 Overview에서만 한 번 mount된다.

### 3. #427 formatter 결함 — binary unit와 locale

PR이 만드는 `MemoryObservabilityCard.tsx:39`의 실제 before:

```ts
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}
```

1024로 나누면서 SI `KB/MB`를 쓰고 `toFixed()`가 decimal separator를 `.`로 고정한다. 최종 after는 binary labels와 active locale formatter를 함께 사용한다.

```diff
-function formatBytes(bytes: number): string {
+export function formatBytes(bytes: number, locale: Locale): string {
   if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
-  const units = ["B", "KB", "MB", "GB", "TB"];
+  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
   const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
   const value = bytes / 1024 ** exp;
-  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
+  const formatted = new Intl.NumberFormat(locale, {
+    minimumFractionDigits: 0,
+    maximumFractionDigits: exp === 0 ? 0 : 1,
+  }).format(value);
+  return `${formatted} ${units[exp]}`;
 }
```

같은 파일의 모든 call site를 빠짐없이 `formatBytes(value, locale)`로 변경한다: RSS, heap used/total, JSC heap, absolute growth, response-state total/largest, watchdog threshold. `formatAge`와 `lastWarnAt.toLocaleString(locale)`은 이미 locale-aware이므로 변경하지 않는다.

**formatter 단위 테스트만으로는 불충분하다 (A-gate blocker 5 반영, C-ACTIVATION-GROUNDING-01).**
`formatBytes()`를 직접 호출하는 테스트는 카드의 fetch 경로나 탭별 mount가 깨져도 green이다.
JSX가 tabpanel 바깥으로 새어나가 모든 탭에서 poll을 돌려도 관찰되지 않는다.
따라서 아래 rendered 테스트를 함께 추가한다.

| 시나리오 | 트리거 | 관찰 대상 (실행 증거) |
|---|---|---|
| 카드 정상 표시 | `/api/system/memory`를 200 + 메트릭 payload로 mock하고 Dashboard Overview 렌더 | 카드가 나타나고 locale 포맷된 KiB/MiB 숫자가 화면에 보임 |
| 탭 전환 시 unmount | Providers 또는 Models 탭 선택 | 카드가 사라지고 추가 `/api/system/memory` 요청이 발생하지 않음 (fetch 호출 수 관찰) |
| unavailable 경로 활성화 | 같은 endpoint를 non-OK(예: 500)로 mock | unavailable UI가 표시되고 예외로 카드가 깨지지 않음 |

**위 세 케이스 전부가 필수다** (A-gate 라운드2 blocker 4 반영). 두 건만 있으면 카드가
tabpanel 밖에 놓여 모든 탭에서 polling해도 C가 통과해버린다. 배치 검증은 `rg` 수동 확인이
아니라 unmount 테스트의 fetch-count assertion이 담당한다. `rg`는 보조 확인일 뿐 게이트가 아니다.

NEW `gui/tests/memory-observability-card.test.ts` — formatter 단위 테스트는 보조로 유지한다:

```ts
import { expect, test } from "bun:test";
import { formatBytes } from "../src/components/MemoryObservabilityCard";

test("memory byte labels use binary units and the active numeric locale", () => {
  expect(formatBytes(0, "en")).toBe("0 B");
  expect(formatBytes(1536, "en")).toBe("1.5 KiB");
  expect(formatBytes(1536, "de")).toBe("1,5 KiB");
  expect(formatBytes(1024 ** 2, "en")).toBe("1 MiB");
});
```

### 4. PR #385 적용

#427과 repair가 green인 뒤 적용한다. 두 PR의 changed-file 교집합은 없다.

```bash
test "$(gh pr view 385 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)" = "ac0260b7afa06c38588f21fee9dadfadb09ce2d3"
gh pr diff 385 --repo lidge-jun/opencodex | git apply -
```

PR이 `src/providers/registry.ts:647` 부근에 추가하는 row는 다음 계약을 유지한다.

```ts
{
  id: "bizrouter", label: "BizRouter", adapter: "openai-chat", baseUrl: "https://api.bizrouter.ai/v1",
  authKind: "key", dashboardUrl: "https://bizrouter.ai/settings/keys",
  defaultModel: "openai/gpt-5.6-sol",
  models: ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"],
  note: "Korean enterprise LLM gateway. Per-key allowed models are discovered live from /v1/models. Full catalog: https://bizrouter.ai/models",
}
```

로깅, request body, token serialization은 추가하지 않는다.

### 5. #385 focused registry/discovery contract test

PR은 `EXPECTED_KEY_PROVIDER_IDS`에 문자열만 추가한다. 이로는 URL/auth/default/models와 `/v1/models` OpenAI list shape가 drift해도 잡지 못한다. `tests/provider-registry-parity.test.ts` imports에 다음을 추가한다.

```diff
-import { OAUTH_PROVIDERS } from "../src/oauth";
+import { buildModelsRequest, OAUTH_PROVIDERS } from "../src/oauth";
+import { isProviderModelsApiItems } from "../src/codex/catalog/provider-fetch";
```

`describe("provider registry parity")` 안, key-login parity test 바로 뒤에 추가:

```ts
test("BizRouter preset preserves key auth and OpenAI-list model discovery", () => {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "bizrouter");
  expect(entry).toMatchObject({
    label: "BizRouter",
    adapter: "openai-chat",
    baseUrl: "https://api.bizrouter.ai/v1",
    authKind: "key",
    dashboardUrl: "https://bizrouter.ai/settings/keys",
    defaultModel: "openai/gpt-5.6-sol",
    models: [
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
      "google/gemini-3.5-flash",
    ],
  });

  const request = buildModelsRequest(providerConfigSeed(entry!), "biz-test-key", "bizrouter");
  expect(request).toEqual({
    url: "https://api.bizrouter.ai/v1/models",
    headers: { Authorization: "Bearer biz-test-key" },
  });

  expect(isProviderModelsApiItems([
    { id: "openai/gpt-5.6-sol", object: "model", owned_by: "bizrouter" },
  ])).toBe(true);
  expect(isProviderModelsApiItems([{ id: 42 }])).toBe(false);
});
```

이 테스트는 실제 vendor network를 CI에서 호출하지 않는다. registry seed → canonical request builder → validated OpenAI `data[]` row shape를 focused하게 고정한다.

### 6. #385 trust/governance gate

- 작성자의 관계 공개와 실서비스 검증은 투명성/기술 근거로 기록한다.
- 그러나 registry preset은 사용자가 신뢰할 endpoint로 제품이 제시하는 행위다. sponsorship 여부와 무관하게 provider 신뢰 표현은 maintainer 판단 사항이다.
- 구현자는 자동으로 featured 처리하거나 “officially endorsed” 문구를 추가하지 않는다. maintainer가 endpoint/공개 docs/관계를 보고 승인하지 않으면 terminal outcome은 `BLOCKED_BY_TRUST_REVIEW`다.

## 검증

```bash
git diff --check
bun test tests/responses-state.test.ts tests/memory-watchdog.test.ts tests/provider-registry-parity.test.ts
(cd gui && bun test tests/memory-observability-card.test.ts)
(cd gui && bun run lint && bun run build)
bun run typecheck
bun run test
bun run privacy:scan
```

Dashboard 구조 보조 확인 (게이트가 아니라 참고용):

```bash
rg -n "MemoryObservabilityCard|const overviewSection|const sections|selected.body" gui/src/pages/Dashboard.tsx
```

기대: import 1회, JSX 1회, JSX는 `overviewSection` 범위 안이며 `sections`/tabpanel 바깥에는 없다.

## 수용 기준

- [ ] #427 Dashboard 제외 patch가 clean apply되고 manual rebase가 exact current-dev hunk와 일치한다.
- [ ] card는 Overview tab에서만 정확히 한 번 렌더되며 existing tab semantics/layout을 바꾸지 않는다.
- [ ] rendered 테스트 3건이 모두 존재하고 통과한다: 정상 표시(locale KiB/MiB 관찰),
      탭 전환 unmount(전환 후 `/api/system/memory` fetch 호출 수가 증가하지 않음을 assertion),
      unavailable 경로(non-OK 응답에서 unavailable UI 표시).
- [ ] 1024 scaling은 KiB/MiB/GiB/TiB로 표시되고 숫자는 active locale을 따른다.
- [ ] memory payload는 count/bytes/age scalar뿐이며 management auth 경계를 재사용한다.
- [ ] #385 pinned patch가 적용되고 BizRouter preset의 adapter/URL/auth/default/models가 focused test로 고정된다.
- [ ] `/v1/models` request URL/Bearer shape와 OpenAI `data[].id` validator의 positive/negative가 테스트된다.
- [ ] BizRouter 관계 공개/실서비스 검증과 별개로 maintainer trust decision이 명시적으로 기록된다.
- [ ] focused, GUI lint/build, typecheck, full suite, privacy scan이 모두 green이다.

## 실행 영수증  _(C/D 단계에서 작성)_

- #427 적용/rebase SHA:
- #385 적용 SHA:
- Dashboard placement proof:
- privacy/auth review:
- focused tests:
- GUI lint/build:
- typecheck/full/privacy:
- BizRouter maintainer trust decision:
- 독립 reviewer 판정:
- terminal outcome:
