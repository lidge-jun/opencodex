# 000 — 탭 전환 시 계정/데이터가 안 뜨는 이유와 전 탭 로딩 계약 부재

작성 2026-07-30. 유닛: `260730_gui_hydration_loading_unify`.

## 증상 (사용자 보고)

> "옛날보다 계정 불러오기가 탭 전환시 잘 안되고 할당량 새로고침 이런거 했을때만 되는경향이 있어"

즉 두 가지 주장이 섞여 있다.

1. 탭을 전환하면 계정 목록이 안 채워진다.
2. `할당량 새로고침` 같은 명시적 액션을 눌러야 채워진다.

## 1. 결정적 발견: 실행 중인 GUI는 이 체크아웃 빌드가 아니다

사용자가 보고 있는 `http://localhost:10100`은 로컬 `dev` 트리 빌드가 아니라
**npm 전역 설치된 v2.7.43 릴리스본**을 서빙한다.

서빙 중인 에셋 해시 (라이브 DOM에서 읽음):

```
/assets/index-cmds12BG.js
/assets/index-Czw-jpTU.css
```

디스크 대조:

| 위치 | 에셋 | mtime |
|------|------|-------|
| `/Users/jun/.bun/install/global/node_modules/@bitkyc08/opencodex/gui/dist/assets/` | `index-cmds12BG.js`, `index-Czw-jpTU.css` | 07-30 07:12 |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/dist/assets/` | `index-Cvkkoo0h.js`, `index-bncC71Q8.css` | 07-30 21:18 |

`readlink -f /Users/jun/.bun/bin/ocx` →
`/Users/jun/.bun/install/global/node_modules/@bitkyc08/opencodex/bin/ocx.mjs`,
`package.json` version `2.7.43`. 로컬 트리 `package.json`은 `2.7.41`.

CSS 대조로 확정:

```
# 서빙 중 (릴리스본) — .account-pool-strategy-card 규칙이 아예 없음
curl -s http://127.0.0.1:10100/assets/index-Czw-jpTU.css \
  | rg -o '\.account-pool-strategy-card\{[^}]*\}'      # 출력 없음

# 로컬 dev 빌드에는 있음
rg -o '\.account-pool-strategy-card\{[^}]*\}' gui/dist/assets/index-bncC71Q8.css
.account-pool-strategy-card{gap:8px;margin-top:16px;padding:14px 16px;display:grid}
```

**따라서 사용자 증상과 스크린샷은 전부 `v2.7.43` (main, `d1f544bbc`, 07-30 06:51) 기준이다.**
오늘 낮 `dev`에 들어간 하이드레이션/페인트 스택(`c4c98c0e7` … `959e9ff11`)은
아직 사용자 화면에 도달하지 않았다. 이 사실을 빼고 `dev` 소스만 읽으면
"소스에는 그런 게이트가 없다"는 잘못된 결론에 도달한다.

## 2. 근본원인 A — 릴리스본에는 마운트 간 캐시 시드가 없다

> A 감사(2026-07-30) 정정: 초기 초안은 "30초 폴링이 화면을 비운다"고 썼다. 그건 틀렸다.
> 릴리스본의 로딩 UI는 `accountsCount === 0`일 때만 렌더된다. 계정 행이 이미 있으면
> 폴링은 화면을 비우지 않는다. 아래는 정정된 인과다.

`v2.7.43`의 `useCodexAccountPool`:

```ts
// git show d1f544bbc:gui/src/hooks/useCodexAccountPool.ts:85
const [loadState, setLoadState] = useState<CodexAccountLoadState>("loading");
```

```ts
// 같은 파일, load() 진입부
const load = useCallback(async (refreshQuota = false): Promise<boolean> => {
  const generation = ++loadGenerationRef.current;
  ...
  if (!refreshQuota) setLoadState("loading");
```

30초 인터벌도 같은 `load()`를 호출한다:

```ts
// git show d1f544bbc:gui/src/hooks/useCodexAccountPool.ts:182
useEffect(() => {
  if (!enabled || pauseCount > 0) return;
  const interval = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
  return () => window.clearInterval(interval);
}, [enabled, load, pauseCount]);
```

하지만 그 `loading` 상태가 화면에 나타나는 조건이 따로 있다:

```tsx
// git show d1f544bbc:gui/src/components/codex-account-pool-main-card.tsx
{loadState === "loading" && accountsCount === 0 && (
  <div className="pwi-auth-state" role="status">{t("pws.accountsLoading")}</div>
)}
```

따라서 실제 인과는 다음과 같다.

- **폴링 자체는 채워진 목록을 비우지 않는다.** `accountsCount > 0`이면 `loading` 상태여도
  로더가 렌더되지 않고 기존 행이 유지된다. E9 실측(36초 관측, 변화 0건)이 이를 확인한다.
- **비우는 것은 라우트 리마운트다.** 릴리스본에는 `lastGoodByBase` 모듈 캐시 시드가
  **없다**. `App.tsx`는 한 번에 한 페이지만 렌더하므로 탭을 떠나면 컨트롤러가 언마운트되고,
  돌아올 때 `accounts`는 빈 배열, `loadState`는 `"loading"`부터 시작한다. 이때 비로소
  `accountsCount === 0` 조건이 성립해 빈 화면이 노출된다 (E6: 일관되게 82ms).
- **강제 새로고침이 달라 보이는 이유는 리마운트가 아니기 때문이다.** `?refresh=1`은
  이미 마운트된 화면에서 눌리므로 `accounts`가 채워져 있고, 게다가
  `if (!refreshQuota)`에 걸려 `loading` 전이조차 건너뛴다. E7 실측처럼 908ms 내내
  행이 유지된다.

즉 사용자가 체감한 "새로고침 눌렀을 때만 제대로 된다"는 **리마운트 경로에만 빈 창이
있고, 액션 경로에는 없기 때문**이다.

폴링의 기여는 매우 좁다. 이미 목록이 비어 있는 **컨트롤러 상태에서만** `loading`이
화면에 드러난다. 그런 상태는 (a) 콜드 마운트 직후 첫 응답 도착 전, (b) 계정이 실제로
0개인 경우다. 반대로 "요청 실패"와 "세션 만료"는 `accounts`를 비우지 않는다 — 실패
분기는 `setAccounts`를 호출하지 않고 `loadState`만 `error`로 바꾸므로, 기존 행이
남아 있으면 에러 배너가 행 위에 붙는다. 따라서 실패·세션 만료는 폴링 깜빡임의 원인이
아니다.

`dev` HEAD는 이 부분을 이미 고쳤다 —
[useCodexAccountPool.ts](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:85)의
`lastGoodByBase` 시드와 `hasLoadedRef`. 다만 그 수정은 **배포되지 않았고**,
동시에 새로운 결함을 들여왔다(§3).

## 3. 근본원인 B — dev에는 빈 목록이 "ready"로 굳는 새 결함이 있다

`dev` HEAD:

```ts
// gui/src/hooks/useCodexAccountPool.ts:89 부근
const seed = lastGoodByBase.get(apiBase);
const [loadState, setLoadState] = useState<CodexAccountLoadState>(() => (seed != null ? "ready" : "loading"));
const hasLoadedRef = useRef(seed != null);
```

```ts
// 같은 파일, 실패 처리
if (!hasLoadedRef.current) setLoadState("error");
```

성공한 **빈** 응답도 `lastGoodByBase`에 기록되고 `hasLoadedRef`를 세운다. 그러면
다음 마운트는 `ready`로 시작하고, 이후 요청이 실패해도 `error`로 못 간다.
결과적으로 "빈 목록 + 조용한 실패"가 정상 빈 상태와 시각적으로 구별되지 않는다.
에러/재시도 UI가 억제된다.

## 4. 라이브 계측 — 요청은 나가고 있다

in-app 브라우저 + CDP `Network` 도메인으로 실측(모두 `v2.7.43` 서빙본 기준).

사이드바 클릭 시 요청/상태/지연:

| 전환 | 요청 | 상태 | 지연 |
|------|------|------|------|
| → Codex 인증 | `/api/codex-auth/active` | 200 | 2ms |
| | `/api/codex-auth/accounts` | 200 | 4ms |
| | `/api/codex-auth/active` | 200 | 4ms |
| | `/api/config` | 200 | 6ms |
| → 모델 | `/api/combos` `/api/models` `/api/providers` `/api/selected-models` `/api/v2` `/api/shadow-call-settings` `/api/provider-context-caps` | 200 | 3–127ms |

콜드 리로드에서 첫 계정 행까지: **480ms**. 그 사이 213자 분량의 `role=status` 2개만
표시되고, 계정 스켈레톤은 관측되지 않았다(`skel=0` 전 구간).

```
40ms   rows=0 status=0 len=0
113ms  rows=0 status=2 len=213
402ms  rows=0 status=2 len=213
480ms  rows=7 status=0 len=653   ← 첫 계정 행
```

사이드바 전환 시 빈 창(blank window):

| 전환 | 첫 계정 행 |
|------|-----------|
| → 프로바이더 | 23ms (직전 화면 잔상) |
| → Codex 인증 | 82ms |
| → 모델 | 22ms |
| → Codex 인증 (재방문) | 82ms |

즉 **탭 전환마다 약 60–80ms 동안 빈 화면**이 나온다. 짧지만, 그 구간에 스켈레톤도
스피너도 없어서 "안 불러와진다"로 읽힌다. 이 빈 창은 리마운트 고유의 것이며,
30초 폴링은 여기에 겹쳐 재현되지 않는다(§2, E9).

강제 새로고침(`할당량 새로고침`) 실측:

```
/api/codex-auth/active            200    3ms
/api/codex-auth/accounts?refresh=1 200  908ms
```

908ms 동안 계정 행은 유지되고(`r7p5`) `role=status` 하나가 뜬다. 여기서만 UI가
"제대로 로드되는" 것처럼 보이는 이유가 코드로 설명된다.

## 5. 프로바이더 탭의 요청 폭발

`#providers` 한 번 전환에 4초 창에서 **38개** `/api/*` 요청이 발생했다.
`/api/provider-quotas`가 단독으로 8회 중복 호출된다.

```
/api/oauth/status?provider=xai … (7개 프로바이더)
/api/oauth/accounts?provider=… (6개)
/api/oauth/accounts?provider=…&quota=1 (6개)
/api/provider-quotas × 8
/api/codex-auth/accounts × 2, /api/codex-auth/active × 2
```

이것이 "옛날보다 느려졌다"의 클라이언트 측 실체다. 서버 지연이 아니라 요청 수다.

## 6. 서버 측 판정

로컬 루프백 실측(비인증 3회):

| 엔드포인트 | 상태 | 시간 |
|---|---|---|
| `/healthz` | 200 | 0.39–0.49ms |
| `/api/config` | 401 | 0.37–0.48ms |
| `/api/codex-auth/accounts` | 401 | 0.38–0.47ms |
| `/` (문서) | 200 | 0.47–0.53ms |

`/api/codex-auth/active`는 인메모리 config 투영이다 —
[auth-api.ts:817](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:817).
`/api/config`도 동기 DTO —
[config-routes.ts:69](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/config-routes.ts:69).

`/api/codex-auth/accounts`만 실제 작업을 한다 —
[auth-api.ts:541](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:541).
5분 캐시가 식으면 메인 1회 + 자격증명 보유 계정마다 1회 WHAM 요청을 보내고,
풀 동시성 4, 개별 타임아웃 8초다 —
[auth-api.ts:368](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:368),
[auth-api.ts:443](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:443).
따라서 콜드 상한은 대략 `8s × ceil(계정수 / 4)`이고, 토큰 만료 시 단일 비행 갱신이
30초 네트워크 타임아웃 / 65초 락 대기를 더한다 —
[account-store.ts:319](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:319).

레이트 리밋, ETag/304, 목록 단위 단일 비행은 없다 —
[server/index.ts:391](/Users/jun/Developer/new/700_projects/opencodex/src/server/index.ts:391).
빠른 탭 전환이 429나 빈 목록을 받는 경로는 존재하지 않는다.

GUI 세션은 5분 TTL이고 128개 초과 시 축출된다 —
[management-auth.ts:27](/Users/jun/Developer/new/700_projects/opencodex/src/server/management-auth.ts:27).
만료 시 401 → `reBootstrapSessionToken()` → 재시도이며 로컬 추가 비용은 1ms 미만 —
[api.ts:97](/Users/jun/Developer/new/700_projects/opencodex/gui/src/api.ts:97).
다만 부트스트랩이 토큰을 못 얻으면 래퍼가 **원본 401 응답을 그대로 반환한다** —
[api.ts:194](/Users/jun/Developer/new/700_projects/opencodex/gui/src/api.ts:194).
계정 풀은 `response.ok`를 검사하므로 401 본문을 계정으로 파싱하진 않고 실패로 접는다 —
[useCodexAccountPool.ts:148](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:148).

`/Users/jun/.opencodex/service.log`에서 오늘자 401/timeout/quota/codex-auth 라인은 0건.

**판정: 탭 전환 증상은 서버 원인이 아니다.** 단 `/accounts` 콜드/강제 경로의
O(계정수) WHAM 팬아웃은 실제 지연 요인이며 별도로 고칠 값어치가 있다.

## 7. 전 탭 로딩 UI 인벤토리 (dev HEAD 기준)

공용 `<Spinner>` / `<Skeleton>` 컴포넌트가 **존재하지 않는다**. 각 화면이 제각각이다.

| 페이지 | 마운트 즉시 fetch | 첫 로드에 보이는 것 | 빈 상태 vs 로딩 구분 |
|---|---|---|---|
| Dashboard | 예 (콜드 구독) | 페이지 로더 없음. 프로바이더/모델이 빈 상태로 먼저 그려질 수 있음 | **아니오** |
| Codex 인증 | 지연 0ms | 레이아웃 맞춘 시머 스켈레톤 (`role=status`+`aria-live`) | 예 |
| Providers | 지연 0ms | 부트 레일 + 스피너 텍스트, `aria-busy` | 대체로 예 |
| Models | 지연 0ms | 스피너 텍스트 | 예 |
| Combos | 지연 0ms | 텍스트만 `role=status` | 예 |
| Subagents | 지연 0ms | 회색 텍스트, status role 없음 | 예 |
| Logs | 활성 시 | `EmptyState("Loading…")` | 예 (단 캐시된 빈 목록은 콜드로 오인) |
| Usage | 지연 0ms | `EmptyState` 텍스트 | 예 |
| Storage | 지연 0ms | `EmptyState("Scanning…")`; 재검증 중엔 로더 없이 stale 유지 | 예 |
| API | 지연 0ms | 키는 시머 스켈레톤, 모델은 평문, 레일은 평문 (한 페이지 3종) | 예 |
| Claude Code | 지연 0ms | 회색 텍스트 | 예 |
| Claude Desktop | 지연 0ms | 텍스트 + `role=status` | 예 |
| Grok | 지연 0ms | 평문 문단 | 예 |
| Startup | 지연 0ms | `EmptyState` 텍스트 | 예 |
| Debug (Logs 하위) | 콜드 구독 | `.empty` 평문 | **아니오** (실패가 로딩과 동일 분기) |

공용 프리미티브로 쓸 만한 기존 자산:

- `.spin` / `@keyframes spin` — [styles.css:917](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:917)
- 시머 스켈레톤 클래스군 — [styles.css:1003](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1003)
- `ResourceSnapshot<T>` = `{ data, error, loading }` + `refresh()` — [client-resource.ts:3](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:3)
- i18n 로딩/빈/실패 키가 이미 en/ko 양쪽에 존재 (`common.loading`, `pws.accountsLoading`, `*.loadFail` 등)

접근성: 첫 로드 상태를 스크린리더에 알리지 않는 페이지 — Dashboard, Models, Subagents,
Logs, Usage, Storage, Claude Code, Grok, Startup, Debug.

## 8. 회귀 구간 (git)

`dev`의 07-30 GUI 스택에서 하이드레이션 관련 변경:

| sha | 제목 | 하이드레이션 영향 |
|-----|------|------------------|
| `c4c98c0e7` | gate Codex pool writes until hydrated | 스냅샷/점진 페인트 + 350/900/2000ms 쿼터 채움 재호출 추가 |
| `fa443c0d4` | address Codex review on pool hydration | 성공한 빈 응답을 hydrated로 취급 |
| `ee3eaa2c0` | progressive dashboard paint | 프로바이더 워크스페이스 읽기를 취소 가능한 0ms 타이머로 전환, Codex `/accounts` 중복 폴백 제거, 대시보드 wave-2를 overview 준비 뒤로 게이트 |
| `748171521` | address review findings | epoch 경쟁에서 밀린 응답을 `undefined`로 버림 |
| `959e9ff11` | restore dev CI baseline | 늦은 관찰자용 `/active` 재생 제거 |

`ee3eaa2c0`의 0ms 타이머 패턴은 마운트 직후 언마운트되면 요청이 아예 안 나가고
재시도도 없다 —
[ProviderWorkspaceShell.tsx:166](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:166).
`ee3eaa2c0`의 대시보드 게이트는 overview가 멈추면 wave-2가 구독조차 안 된다 —
[use-dashboard-data.ts:220](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:220).

현재 이 경로를 재현하는 테스트는 없다. 반대로 다음 테스트들이 현 동작을 고정한다:

- `enabled: overviewReady`를 정적으로 요구 — [dashboard-contracts.test.ts:90](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/dashboard-contracts.test.ts:90)
- 마지막 pause 리스 해제가 load를 소급 발화하지 **않아야** 한다고 단언 — [codex-account-pool-behaviour.test.tsx:264](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:264)

## 9. 설정 UI 결함 (사용자 지적 2건)

### 9.1 로테이션 전략 카드

서빙 중인 `v2.7.43` CSS에는 `.account-pool-strategy-card` 규칙이 **없다**(§1 확인).
그래서 카드가 패딩 없이 테두리에 붙는다. `dev`에는 `padding: 14px 16px`가 이미 있다 —
[styles.css:1284](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1284).

패딩과 별개로 구조 문제는 남는다. `strategyLabelHidden`이 라벨을 `sr-only`로 바꿔서
시각적 필드 라벨 없는 전폭 셀렉터가 된다 —
[AccountPoolStrategyControls.tsx:54](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/AccountPoolStrategyControls.tsx:54).

앱의 지배적 설정 패턴은 `.setting-row` + `.setting-label`(title+desc) + 우측 컨트롤이고
Claude Code 섹션이 그 기준 구현이다 —
[claude-code-sections.tsx:41](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/claude-code-sections.tsx:41),
[styles.css:1831](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1831).

### 9.2 전환 임계값 스위치 높이

```css
/* styles.css:1122 */
.codex-auto-switch-controls { display: flex; align-items: flex-end; gap: 12px; }
.codex-auto-switch-input-wrap { align-items: stretch; min-height: 32px; }
.toggle { width: var(--toggle-w); height: var(--toggle-h); }  /* 36×20 */
```

숫자 복합 컨트롤은 최소 32px, 토글은 20px. `align-items: flex-end`가 아래 변만 맞추므로
중심이 6px 어긋난다. 공통 베이스라인이 생길 수 없는 구조다. 스테퍼는 이미 32px로
stretch되어 있어 원인이 아니다 — [styles.css:1183](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1183).

이 컴포넌트는 공용 `Switch`(34×20)를 쓰지 않고 `.toggle`을 직접 렌더한다 —
[ui.tsx:8](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:8).
올바른 선례는 Models의 shadow-call 행(`.row` + `align-items: center`) —
[styles.css:888](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:888).

## 10. 멀티모델 개별 설정 → API/CLI 이관 대상

| GUI 컨트롤 | 위치 | CLI / API 대체 | 분류 |
|---|---|---|---|
| 모델별 노출 스위치 | [Models.tsx:770](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:770) | `ocx models enable/disable`, `PUT /api/model-visibility` | 개별 → 이관 |
| 프로바이더 전체 On/Off | [Models.tsx:677](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:677) | `ocx models provider <n> on/off` | 개별의 벌크 → 이관 |
| selected-model 허용목록 | [model-visibility.ts:57](/Users/jun/Developer/new/700_projects/opencodex/gui/src/model-visibility.ts:57) | `ocx models selected`, `PUT /api/selected-models` | 개별 → 이관 |
| 커스텀 모델 CRUD | [Models.tsx:1120](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:1120) | `ocx models add/edit/remove`, `/api/custom-models` | 개별 → 이관 |
| 워크스페이스 중복 커스텀 추가 | [ProviderModels.tsx:179](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderModels.tsx:179) | 동일 | 중복 → 제거 |
| 프로바이더별 컨텍스트 캡 스위치 | [Models.tsx:659](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:659) | `ocx models context provider` | 프로바이더 단위 → 판단 필요 |
| 전역 캡 값 / 전체 적용 | [Models.tsx:973](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:973) | `ocx models context value/all` | 통합 → **유지** |
| 프로바이더 기본 모델 | [ProviderSettings.tsx:221](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderSettings.tsx:221) | `ocx provider edit --default-model` | 통합 → **유지** |
| 전역 shadow-call 모델 | [Models.tsx:880](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:880) | `ocx models shadow set` | 통합 → **유지** |

모든 이관 대상에 이미 CLI/API 대체 경로가 존재한다 —
[model-routes.ts:135](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:135),
[models-runtime.ts:16](/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:16).

## 11. 디자인 토큰 (통일 계획이 참조할 실제 값)

[styles.css:57](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:57) 간격:
`--space-1: 4px` … `--space-4: 16px` … `--space-16: 64px`.
[styles.css:108](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:108) 컨트롤 높이:
`--control-sm/md/lg/touch = 28/34/40/44px`.
[styles.css:129](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:129) 토글:
`--toggle-w: 36px`, `--toggle-h: 20px`, `--toggle-dot: 14px`.

새 토큰을 발명하지 말고 이들을 쓴다.

## 12. 결론

| 주장 | 판정 |
|------|------|
| 탭 전환 시 요청이 안 나간다 | **거짓**. 매 전환마다 실제로 나간다(200, 2–6ms). |
| 탭 전환 시 화면이 비어 보인다 | **참**. 60–80ms 빈 창 + 스켈레톤 부재. |
| 새로고침 때만 제대로 된다 | **참, 그리고 코드로 설명됨**. 리마운트 경로에만 빈 창이 있다(캐시 시드 부재). 액션 경로는 이미 채워진 화면에서 실행되고 `loading` 전이도 건너뛴다. |
| 30초 폴링이 화면을 비운다 | **거짓**. 로딩 UI는 `accountsCount === 0`에서만 렌더된다. 목록이 비어 있을 때만 기여한다. |
| 느려졌다 | **참**. 프로바이더 탭 1회 전환 = 38 요청, `/api/provider-quotas` 8중복. |
| 서버가 원인이다 | **거짓**. 로컬 게이트는 1ms 미만. 단 `/accounts` 팬아웃은 별개 문제. |
| 사용자가 보는 게 dev 코드다 | **거짓**. v2.7.43 릴리스본이다. |

## 13. `/api/provider-quotas` 8중복의 출처

A 감사에서 확인된 구조적 원인:
`Providers.tsx`가 프로바이더별 계정 응답으로부터 `quotaRefreshKey`를 파생하고 —
[Providers.tsx:129](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:129) —
그 키를 워크스페이스 셸에 내린다 —
[Providers.tsx:273](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:273).
셸의 쿼터 이펙트가 `quotaRefreshKey`를 의존성으로 갖는다 —
[ProviderWorkspaceShell.tsx:242](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:242).

따라서 OAuth 계정 응답이 프로바이더마다 하나씩 도착할 때마다 키가 바뀌고 쿼터 이펙트가
재실행된다. 6개 프로바이더의 계정 응답 + 초기 1회 + 쿼터 포함 응답이 만드는 연쇄가
E3의 8회다. 이것은 우발적 중복이 아니라 파생 키의 세분성 문제이며, WP4는 키를 안정화하거나
이펙트를 인플라이트 공유로 묶어야 한다.

구현 순서는 `000_plan.md`의 의존성 순서를 따른다.
