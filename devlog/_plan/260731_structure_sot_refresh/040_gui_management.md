# 040 — WP4: `05_gui-and-management-api.md`

선행: WP0만. A 감사 R3 블로커 4: WP2·WP3 의존 주장도 장식이었다 —
`/api/sidecar-settings`는 `config.webSearchSidecar`/`config.visionSidecar`를 읽고 쓰는 설정
라우트일 뿐(`src/server/management/config-routes.ts:315`) WP3의 백엔드 선택 규칙을 인용하지 않는다.
WP1~WP5는 전부 독립 트랙이다.
가장 큰 공백을 다루는 phase다. 등록된 고유 `/api` 경로 리터럴 90개 중 `structure/` 전체가 언급하는 것은 25개다(`004_measure.sh`).

## 편집 대상

- MODIFY `structure/05_gui-and-management-api.md`

## D1. API ownership 표 확장 (§3 MISSING)

현재 표는 "Endpoint area | Responsibility" 2열이고 일부 영역만 있다. 등록된 고유 `/api` 경로
리터럴은 90개, `structure/` 전체가 언급하는 것은 25개다(`004_measure.sh`). 라우트를 개별 행으로
90개 나열하지 않는다. 이유: 라우트 목록은 코드가 SOT이고, 문서에 복제하면 다음 라우트 추가에 즉시 낡는다.
대신 **등록 파일별 소유 경계**를 표로 두고 각 계열의 불변 조건을 적는다. 이렇게 하면
"이 라우트는 어디 소유인가"를 답할 수 있고 라우트가 늘어도 표가 유효하다.

표 앞 문단 교체:
```
`src/server/index.ts` authenticates and routes `/api/*`, then delegates to
`src/server/management-api.ts`, which composes the route modules under `src/server/management/`.
Codex account routes live in `src/codex/auth-api.ts` because they own the credential store, not
because they are a different plane.

The registered route set is larger than the areas described below; the code is the route SOT. What
this document owns is which module holds which area and what invariant that area must not break.
```

표에 다음 행 추가(기존 행은 유지, 문구 변경 없음):
```
| Diagnostics/sync | `src/server/management/config-routes.ts` — `GET /api/diagnostics/project-config` reports project-level Codex config that bypasses managed routing; `POST /api/sync` re-runs catalog/config sync. The diagnostic reports the bypass; it does not rewrite the project file (`src/codex/project-config-warnings.ts`). |
| Sidecar/shadow-call settings | `src/server/management/config-routes.ts` — `GET/PUT /api/sidecar-settings` and `/api/shadow-call-settings`. The payload is model, backend, reasoning, and per-turn description limits (`src/server/management/config-routes.ts:276-300`); credentials live in the provider and OAuth stores instead. |
| Storage | `src/server/management/logs-usage-routes.ts` — `GET /api/storage`, cleanup preview/run, cleanup policy read/write/run, trash list and restore. Cleanup takes an explicit `mode`: `quarantine` moves to trash and is restorable, `permanent` is not. Both have a preview form, and the caller must name the mode — there is no default that silently deletes. |
| Provider quotas and tests | `src/server/management/provider-routes.ts` — `GET /api/provider-quotas`, `POST /api/providers/test`, `GET/PUT /api/provider-context-caps`, `GET /api/provider-presets`. A quota read may be served from cache or force-refreshed with `?refresh=1`; absent quota data is reported as unknown rather than as a measured zero. |
| Combos | `src/server/management/combo-routes.ts` — `GET/PUT/DELETE /api/combos` own provider combination and failover definitions. |
| Codex accounts | `src/codex/auth-api.ts` — `/api/codex-auth/*`: account list/add/remove, alias, pause and pause-exhausted, cooldown clear, active selection, auto-switch, pool strategy, failover, quota, reset credits, and the login/manual-code flow. Account ids are opaque handles and are serialized so the GUI can address an account; emails are masked and tokens are never serialized. |
| Models and visibility | `src/server/management/model-routes.ts` — `GET /api/models`, `PUT /api/disabled-models`, `/api/model-visibility`, `/api/selected-models`, `GET/POST /api/custom-models`. Visibility writes trigger catalog sync through the owning server path. |
| Effort and fallback | `src/server/management/agent-settings-routes.ts` — `GET/PUT /api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`. Caps clamp; they do not reject. |
| Grok and Claude integrations | `src/server/management/agent-settings-routes.ts` — `/api/grok`, `/api/grok/selection`, `/api/grok/apply`, `/api/claude-desktop*`, `/api/claude-code`. Apply writes an external app's profile, so its status probe must read the same resolved path it writes (see `04`). |
| Sidebar | `src/server/management/sidebar-routes.ts` — `GET/POST /api/github/star`, `GET /api/update/badge`. Sidebar state is cosmetic; a failed fetch degrades silently. |
| Logs | `src/server/management/logs-usage-routes.ts` — `GET /api/logs`, `/api/claude/inbound-debug`, `/api/debug/injection-logs` join the debug streams described below. |
```

## D2. Startup 사이드바 서술 정정 (S9)

`:97` 부근이 Startup을 사이드바 항목처럼 서술한다. `gui/src/App.tsx:50-62`의 `NAV`에는
`dashboard, codex-auth, providers, models, subagents, logs, usage, storage, api, claude, grok`만 있고
`startup`이 없다. 라우팅과 렌더는 존재한다(`gui/src/app-routing.ts:20-34`).

정정 문장. 진입 조건을 "경고에서만"으로 좁히지 않는다 —
`gui/src/pages/dashboard-overview-head.tsx:86-99`는 보호/네이티브 상태에서도 링크를 노출한다
(A 감사 블로커 11):
```
Startup safety is reachable by route (`/#startup`) and rendered by the app, but it is not a sidebar
entry: it is entered from the dashboard's startup-state row, which links there whether the current
state needs remediation or merely reports how routing is protected.
```

## D2b. Usage 절 정정 (S10 — A 감사에서 발견)

`:153`의 "Missing usage is never treated as zero"는 코드와 반대다.
`tests/api-usage.test.ts:218-227`은 `usage.jsonl` 부재 시 `/api/usage`가 200과
`requests: 0`, `coverageRatio: 0`을 반환하도록 요구한다.

BEFORE
```
Missing usage is never treated as zero. The dashboard Usage tab renders the same shape, and the
```
AFTER
```
A missing `usage.jsonl` returns a zeroed summary with 200, not an error: a fresh install has no
usage and must not render as a failure. What the shape must never do is present an unmeasured
request as a measured zero — that is what the `measured / reported / unreported / unsupported /
estimated` split exists for, and why coverage is reported alongside totals. The dashboard Usage tab
renders the same shape, and the
```

## D3. GUI 표면 절 신설 (§E)

`## UX boundary` 절 뒤에 추가:
```
## Dashboard surfaces

The sidebar exposes eleven pages (`gui/src/App.tsx` `NAV`). Several are workspace shells rather
than single forms, and the shell pattern is the part worth keeping stable:

| Surface | Shape |
| --- | --- |
| Providers | Rail of configured providers plus a detail pane whose tabs are Overview, Models, Usage, then Accounts or API Keys when the provider has an auth surface, then Settings (`gui/src/components/provider-workspace/ProviderDetails.tsx`). |
| API keys | Rail plus per-key detail; masked values only (`gui/src/components/apikeys-workspace/`). |
| Storage | Rail plus cleanup/trash detail (`gui/src/components/storage-workspace/`). |
| Subagents | Featured-roster selection workspace (`gui/src/components/subagents-workspace/`). |
| Combos | Rail, detail panel, and an add flow (`gui/src/components/ComboWorkspace.tsx`). |
| Add provider | Catalog browser plus form and OAuth panes (`gui/src/components/provider-catalog/`, `gui/src/components/AddProviderModal.tsx`). |
| Codex accounts | Account pool cards, add-account flow, switch/reset modals (`gui/src/components/CodexAccountPool.tsx`, `AddCodexAccountModal.tsx`). |
| Dashboard overview | Quota bars, memory observability card, provider/model tabs (`gui/src/pages/dashboard-overview-panels.tsx`). |

Rail selection is component-local state today, so a reload returns to the workspace's default
selection rather than the previously selected row. An OAuth ToS warning is shown before a login
that requires acceptance (`gui/src/components/OAuthTosWarningModal.tsx`).
```

A 감사 블로커 11 반영: rail 선택을 URL 해시에 유지한다는 불변 조건은 코드와 다르다
(`gui/src/components/ComboWorkspace.tsx:38-52`, `gui/src/components/storage-workspace/StorageWorkspace.tsx:68-76`는 컴포넌트 상태를 쓴다).
바람직한 동작일 수는 있으나 SOT는 현재 동작을 적는다. 개선 희망은 이 문서에 남기고
`structure/`에는 넣지 않는다.

## D4. Updates 절에 배지 추가 (§E)

기존 Updates 행 서술 끝에 한 문장:
```
`GET /api/update/badge` backs the sidebar badge. The badge is advisory: it reports that an update exists and links to the update surface rather than gating other actions.
```

## 검증

```bash
# 라우트 측정은 유닛 정본 스크립트만 쓴다 (A 감사 블로커 1). doc_only_routes 가 0 이어야 한다.
bash devlog/_plan/260731_structure_sot_refresh/004_measure.sh /tmp/ocx_wp4
bun test tests/api-usage.test.ts
for p in gui/src/components/provider-workspace gui/src/components/apikeys-workspace \
         gui/src/components/storage-workspace gui/src/components/subagents-workspace \
         gui/src/components/provider-catalog gui/src/components/ComboWorkspace.tsx \
         gui/src/components/CodexAccountPool.tsx gui/src/components/AddCodexAccountModal.tsx \
         gui/src/components/OAuthTosWarningModal.tsx gui/src/pages/dashboard-overview-panels.tsx \
         gui/src/pages/dashboard-overview-head.tsx; do
  [ -e "$p" ] || echo "MISSING $p"
done
bun x tsc --noEmit && bun run privacy:scan && git diff --check
```

## 수용 기준

- 미기재 라우트 계열 12개가 소유 모듈과 함께 표에 들어간다.
- `004_measure.sh`의 `doc_only_routes`가 0이다.
- Startup이 사이드바 항목이 아니라는 사실과 실제 진입 지점이 명시된다.
- usage 0 요약 동작이 정확히 서술되고 `tests/api-usage.test.ts`가 통과한다.
- GUI 워크스페이스 8개가 서술되며, 검증되지 않은 내비게이션 불변 조건을 넣지 않는다.
- 게이트 통과, 커밋 1개.

## 서술 계약 자기점검

살아남은 절대어·셋 크기 주장 전부와 그 근거(A 감사 R4 블로커 4):

| 문안 | 근거 |
|------|------|
| `tokens are never serialized` | `src/codex/auth-api.ts` 계정 DTO에 토큰 필드가 없다(마스킹 대상은 이메일, id는 opaque handle로 직렬화된다) |
| `must never present an unmeasured request as a measured zero` (usage) | 요구사항 서술. `measured/reported/unreported/unsupported/estimated` 분리와 coverage 병기가 그 장치다 |
| `the sidebar exposes eleven pages` | `gui/src/App.tsx:50-62` — `NAV` 배열 항목이 정확히 11개다 |
| `GUI 워크스페이스 8개` (이 계획 문서의 표) | 표의 8행이 각각 `gui/src/components/...` 경로를 갖고, 그 경로가 모두 존재한다 |
| `Rail selection is component-local state today` | `gui/src/components/ComboWorkspace.tsx:38-52`, `gui/src/components/storage-workspace/StorageWorkspace.tsx:68-76` |
| `Startup ... is not a sidebar entry` | `gui/src/App.tsx:50-62`에 `startup` 없음; 진입은 `gui/src/pages/dashboard-overview-head.tsx:86-99` |

- 라우트 개수는 `004_measure.sh` 출력만 인용한다(자체 계산 금지).
- 라벨: provider workspace 탭은 `gui/src/components/provider-workspace/ProviderDetails.tsx:99-105`에서 그대로.
- 경로: GUI 인용 전부 `gui/src/...` 완전 경로.
