# 060_multimodel_demotion — WP7 멀티모델 개별 설정을 CLI/API로 이관

## 판정과 전제

이 WP는 WP6 CSS에 의존하지 않는다. 제거 허용 여부는 control마다 CLI/API 수용 매니페스트가 실제 소스에 있는지와 사용자의 제거 승인만으로 판단한다. 이 의존성은 `/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:34-45`, 사전 gate는 같은 문서 167-172행에 있다.

여기서 "개별"은 모델 하나, provider 하나의 model catalog, custom model 한 건을 바꾸는 조작이다. 전역 context-cap 값, 모든 provider에 일괄 적용하는 switch, 전역 shadow-call model, provider의 기본 model은 GUI에 남긴다. provider별 context-cap은 **GUI에 남긴다.** 모델 하나가 아니라 provider 단위이며, 전역 cap value와 `setAll`의 바로 아래에서 같은 설정 축을 이룬다. 다만 현재 provider model card header에 박혀 있으므로 WP6 정본 row로 옮긴다. 근거가 되는 현재 control은 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:659,735`, API/CLI는 `/Users/jun/Developer/new/700_projects/opencodex/src/server/management/provider-routes.ts:441-485`, `/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:144-173`에 있다.

리서치의 candidate 표도 한 행을 정정한다. `selected-models`는 `Models.tsx`에 독립 UI control로 존재하지 않는다. 모델별 switch와 provider all on/off가 내부적으로 바꾸는 allowlist/disabled-model 조합의 한 부분이며(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/model-visibility.ts:47-70`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:299-327`), 그래서 독립 "제거" 항목이 아니라 유지할 API/CLI capability다.

## 수용 매니페스트

아래 `curl`의 `<base>`는 실제 proxy의 loopback URL이다. API 직접 호출은 브라우저 세션의 관리 인증/identity check를 우회하는 문서 경로가 아니다. headless 사용자는 `ocx` CLI를 사용한다. runtime CLI는 live proxy를 찾고, 실행 중 proxy가 없으면 `ocx start`를 안내하며, proxy 관리 header를 붙인다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/runtime-api.ts:43-47`, `/Users/jun/Developer/new/700_projects/opencodex/src/cli/runtime-api.ts:61-87`). 따라서 모든 live CLI command의 전제는 `ocx start` 또는 설치된 service가 실행 중인 것이다.

| GUI에서 제거할 것 | 실제 GUI 위치 | CLI 수용 명령 | 실제 HTTP request | 판정 |
| --- | --- | --- | --- | --- |
| 모델 한 개 enable | `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:770` | `ocx models enable anthropic/claude-sonnet-4`<br>`ocx models enable gpt-5.6 --native` | `curl -sS -X PUT '<base>/api/model-visibility' -H 'Content-Type: application/json' --data '{"scope":"models","provider":"anthropic","enabled":true,"targets":[{"id":"claude-sonnet-4","native":false}]}'` | 충족. CLI가 같은 body를 보낸다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:86-99`); API는 allowlist와 disabled set을 원자 갱신한다(`/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:132-228`). |
| 모델 한 개 disable | `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:770` | `ocx models disable anthropic/claude-sonnet-4`<br>`ocx models disable gpt-5.6 --native` | `curl -sS -X PUT '<base>/api/model-visibility' -H 'Content-Type: application/json' --data '{"scope":"models","provider":"anthropic","enabled":false,"targets":[{"id":"claude-sonnet-4","native":false}]}'` | 충족. enable의 역 body이며 같은 validation을 탄다. |
| provider의 All on | `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:677-685,732` | `ocx models provider anthropic on` | `curl -sS -X PUT '<base>/api/model-visibility' -H 'Content-Type: application/json' --data '{"scope":"provider","provider":"anthropic","enabled":true,"targets":[{"id":"claude-sonnet-4","native":false}]}'` | 충족. CLI는 먼저 `GET /api/models`로 현재 provider targets를 읽고 같은 PUT을 보낸다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:101-117`). 직접 API 사용자는 적어도 한 target을 넣어야 한다; 서버가 빈 targets를 400으로 거절한다(`/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:152-169`). |
| provider의 All off | `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:677-685,733` | `ocx models provider anthropic off` | `curl -sS -X PUT '<base>/api/model-visibility' -H 'Content-Type: application/json' --data '{"scope":"provider","provider":"anthropic","enabled":false,"targets":[{"id":"claude-sonnet-4","native":false}]}'` | 충족. CLI가 GUI와 같이 현재 catalog 전체를 target으로 만든다. |
| selected-model allowlist 조회 | visible 독립 control 없음; read는 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:173-222` | `ocx models selected anthropic` | `curl -sS '<base>/api/selected-models'` | capability 유지. GET은 selected와 provider별 full available set을 준다(`/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:321-337`). 제거할 GUI control은 없으므로 removal diff 없음. |
| selected-model allowlist 설정/해제 | 모델 toggle이 간접 변경; `/Users/jun/Developer/new/700_projects/opencodex/gui/src/model-visibility.ts:57-69` | `ocx models selected anthropic --set claude-sonnet-4,claude-haiku-4`<br>`ocx models selected anthropic --clear` | `curl -sS -X PUT '<base>/api/selected-models' -H 'Content-Type: application/json' --data '{"provider":"anthropic","models":["claude-sonnet-4","claude-haiku-4"]}'`<br>`curl -sS -X PUT '<base>/api/selected-models' -H 'Content-Type: application/json' --data '{"provider":"anthropic","models":[]}'` | 충족. CLI parsing/PUT은 `/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:119-142`, empty list가 allowlist 해제인 서버 의미는 `/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:339-355`다. |
| custom model add | provider card의 `+`: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:710-730`; duplicate add: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderModels.tsx:120-144,179-201` | `ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image` | `curl -sS -X POST '<base>/api/custom-models' -H 'Content-Type: application/json' --data '{"provider":"deepseek","modelId":"deepseek-v4","displayName":"DeepSeek V4","contextWindow":128000,"inputModalities":["text","image"]}'` | 충족. CLI add는 config 저장 뒤 실행 중 proxy면 catalog sync도 한다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/models.ts:110-168`); API POST는 같은 필드를 받아 201을 반환한다(`/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:235-266`). |
| custom model edit | hover tooltip action: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:822-852`; modal submit: 1245-1271 | `ocx models edit '<custom-id>' --model-id deepseek-v4.1 --display-name 'DeepSeek V4.1' --context-window 128000 --modalities text,image` | `curl -sS -X PUT '<base>/api/custom-models/<custom-id>' -H 'Content-Type: application/json' --data '{"modelId":"deepseek-v4.1","displayName":"DeepSeek V4.1","contextWindow":128000,"inputModalities":["text","image"]}'` | 충족. 이 명령은 live management API를 쓴다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:50-75`); API PUT validation/duplicate check는 `/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:269-303`다. |
| custom model delete | hover tooltip action: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:841-852` | `ocx models remove '<custom-id>' --yes`<br>`ocx models remove deepseek/deepseek-v4 --yes` | `curl -sS -X DELETE '<base>/api/custom-models/<custom-id>'` | 충족. CLI는 interactive TTY confirmation 또는 `--yes`를 요구한다(`/Users/jun/Developer/new/700_projects/opencodex/src/cli/models.ts:170-208`); API DELETE도 존재한다(`/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:306-318`). |

이 표의 **BLOCKER는 없다.** 리서치 초안의 "`ocx models add/edit/remove`가 모두 runtime CLI"라는 표현만 틀렸다. add/remove는 offline config CLI이고 edit는 running proxy CLI다. 기능 범위는 GUI와 동등하다. API request의 `<custom-id>`는 `ocx models list-custom --json` 또는 `GET /api/custom-models`로 먼저 얻는다; GUI도 custom row의 `customId`를 API request에 쓴다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:822-849`).

## 제거 diff

삭제는 하나의 commit에서 control, 그것을 위한 state/callback/import, i18n key, CSS를 같이 제거한다. `selectedModels` fetch는 global shadow-call select의 active option 계산에 계속 필요하다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:141-144`). `model-visibility.ts`는 GUI에서 더 이상 write하지 않더라도 tests 또는 다른 caller가 없음을 `rg -n 'putModelVisibility|modelVisible|fetchSelectedModels' gui/src`으로 확인한 뒤, read helper만 남기거나 server/API test owner로 옮긴다.

### 1. Models page: 설정 테이블 대신 unified controls + CLI 안내

provider card 전체와 rail은 개별 model management UI다. switch만 떼고 list를 남기면, row/hover/custom badge가 "여기서 바꾸라"는 인상을 계속 준다. 이 대형 table/rail을 함께 없애고, page는 global controls와 read-only CLI 안내 card만 보인다. shadow model options를 위한 `models`, `disabled`, `selectedModels` read는 유지한다.

```diff
diff --git a/gui/src/pages/Models.tsx b/gui/src/pages/Models.tsx
@@
-import { IconChevron, IconBoxes, IconInfo, IconShuffle } from "../icons";
+import { IconInfo, IconShuffle } from "../icons";
@@
-  buildProviderModelGroups,
-  type ConfiguredProviderSummary,
-  type ProviderModelGroup,
-} from "../models-groups";
-import {
-  fetchSelectedModels,
-  modelVisible,
-  putModelVisibility,
-  shouldApplyLoadGeneration,
-  type ProviderModelMap,
-  type ModelVisibilityScope,
-  type ModelVisibilityTarget,
-} from "../model-visibility";
+} from "../models-groups";
+import { fetchSelectedModels, shouldApplyLoadGeneration, type ProviderModelMap } from "../model-visibility";
@@
-  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>(() => cached?.providers ?? []);
-  const [search, setSearch] = useState<Record<string, string>>({});
-  const [limit, setLimit] = useState<Record<string, number>>({});
-  const initialCollapsed = readCollapsedProviders();
-  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed ?? new Set());
-  const needsDefaultCollapseRef = useRef(initialCollapsed === null);
-  const [customModalOpen, setCustomModalOpen] = useState(false);
-  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
-  // custom form state and hover state
@@
-  const applyVisibility = async (scope: ModelVisibilityScope, provider: string, targets: ModelVisibilityTarget[], enabled: boolean) => {
-    // remove complete existing function
-  };
-  const renderGroup = (group: ProviderModelGroup<ModelRow>) => {
-    // remove complete existing function, including +, All on/off, per-model Switch and custom tooltip actions
-  };
@@
-      <div className="models-workspace-root">
-        <aside className="models-workspace-rail">{/* provider rail */}</aside>
-        <section className="models-workspace-main">
-          {controlsBlock}
-          {combosBlock}
-          {collapseControls}
-          <div className="models-provider-list">{visibleGroups.map(group => renderGroup(group))}</div>
-          {groups.length === 0 && emptyStateBlock}
-        </section>
-      </div>
-      {modalsBlock}
+      <section className="models-unified-settings" aria-label={t("nav.models")}>
+        {controlsBlock}
+        {combosBlock}
+        <div className="card models-cli-management-card">
+          <div className="setting-row">
+            <div className="setting-label">
+              <span className="title">{t("models.cliManagementTitle")}</span>
+              <span className="desc">{t("models.cliManagementDesc")}</span>
+            </div>
+            <a className="btn btn-ghost btn-sm" href="https://opencodex.dev/reference/cli/#ocx-models-subcommand">
+              {t("models.cliManagementDocs")}
+            </a>
+          </div>
+          <pre className="models-cli-management-command">ocx models provider &lt;provider&gt; on|off</pre>
+        </div>
+      </section>
```

이 diff를 적용할 때 삭제 주석은 literal `// remove complete ...`가 아니라 해당 함수 전체다. 함수 경계와 final render 위치는 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:299-369`, `645-870`, `1279-1345`로 고정한다. replacement card가 있어서 rail/table이 사라져도 사용자는 다음 행동(문서 열기와 실제 command)을 바로 얻는다. 새로운 visible text는 `en.ts`와 모든 locale에 넣어야 한다(`/Users/jun/Developer/new/700_projects/opencodex/gui/AGENTS.md:11-28`).

`controlsBlock`은 다음처럼 provider card header가 아니라 settings card 안의 canonical rows가 된다. 이는 WP6의 primitive 유무 branch를 그대로 소비한다.

```diff
@@
-      <div className="models-control-top-row">
-        <div className="models-shadow-row row muted text-control">{/* shadow controls */}</div>
-        {v2 && <div className="models-v2-mode-row row">{/* v2 controls */}</div>}
-      </div>
+      <div className="card models-unified-settings-card">
+        <div className="setting-row">{/* existing shadow Switch + Select, with title/desc at left */}</div>
+        {v2 && <div className="setting-row">{/* existing v2 segmented control, with title/desc at left */}</div>}
+        <div className="setting-row">{/* existing global context Select + all Switch, with title/desc at left */}</div>
+        {groups.filter(group => !group.native).map(group => (
+          <div className="setting-row" key={group.provider}>{/* provider context-cap Switch only */}</div>
+        ))}
+      </div>
```

이 부분의 `groups`는 read-only provider list가 아니라 context-cap rows를 만들기 위해 최소 형태로 유지한다. provider cap도 GUI에서 제거하기로 사용자가 나중에 선택하면 이 WP의 범위 확장이 필요하다. 현재는 remove list가 아니다.

### 2. workspace duplicate custom add 제거

`ProviderModels`는 Models page와 별도로 `POST /api/custom-models`를 다시 구현한다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderModels.tsx:37-57,120-144,179-211`). 전체 custom model GUI를 내릴 때 아래 state/effect/label/row/status도 함께 삭제한다. model chips의 read-only list/search/copy는 유지한다.

```diff
diff --git a/gui/src/components/provider-workspace/ProviderModels.tsx b/gui/src/components/provider-workspace/ProviderModels.tsx
@@
-  const [customModelId, setCustomModelId] = useState("");
-  const [customSaving, setCustomSaving] = useState(false);
-  const [customError, setCustomError] = useState("");
-  const [customSuccess, setCustomSuccess] = useState("");
-  const [customModelIds, setCustomModelIds] = useState<string[]>([]);
-  const [customModelsReady, setCustomModelsReady] = useState(false);
-  const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
-  const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
@@
-  useEffect(() => { /* GET /api/custom-models and retry state */ }, [apiBase, item.name, t, customModelsLoadEpoch]);
-  const retryCustomModels = () => { /* remove */ };
-  const addCustomModel = async () => { /* remove */ };
@@
-      <label className="text-label pws-custom-model-label" htmlFor={`pws-custom-model-${item.name}`}>{t("models.customAdd")}</label>
-      <div className="row pws-custom-model-row">{/* input + Add button */}</div>
-      {customSuccess && <p className="muted text-label" role="status">{customSuccess}</p>}
-      {customError && <p className="pws-inline-error" role="alert">{/* retry */}</p>}
+      <p className="muted text-label pws-model-management-note">
+        {t("models.cliManagementDesc")}
+      </p>
```

`filterModels`의 custom id input을 없앴다면 `customModelIds` argument도 없애거나 API read-only catalog data로 대체한다. 빈 상태는 live/configured models만으로 계산한다. 이 replacement note는 provider workspace에서 input/button이 사라져 생기는 빈 action 영역을 막는다.

### 3. CSS/i18n/doc cleanup

`Models.tsx`의 `models-provider-*`, `models-workspace-rail-*`, `model-row-wrap`, `model-tip*`, `models-field*` 중 custom modal 전용 selector와 `pws-custom-model-*` CSS를 삭제한다. combo summary와 unified global controls CSS는 유지한다. 삭제는 selector usage를 먼저 `rg -n`으로 0건 확인한 뒤 한다. i18n에서는 custom modal/title/button/delete confirmation, allOn/allOff, active-count가 이 page 외에 쓰이지 않는지 먼저 검색하고, removal replacement keys `models.cliManagementTitle`, `models.cliManagementDesc`, `models.cliManagementDocs`는 모든 locale에 추가한다.

## 문서화 diff — 제거 전에 먼저 landing

영문 source of truth는 `docs-site/src/content/docs/reference/cli.md`다. 현재 `ocx models` 설명은 command family 이름만 나열한다(`/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/reference/cli.md:224-230`). 다음 prose와 code block을 그 heading 바로 뒤에 추가한다.

~~~~md
#### Model catalog management

Use the CLI or the management API for per-model catalog changes. The dashboard keeps global
model settings such as the context-cap value and shadow-call model, but it does not edit an
individual model or a provider's catalog visibility.

```bash
# Inspect the live catalog before changing it.
ocx models live --provider anthropic --json

# Change one model or every currently discovered model for a provider.
ocx models disable anthropic/claude-sonnet-4
ocx models provider anthropic on

# Use or clear the provider allowlist.
ocx models selected anthropic --set claude-sonnet-4,claude-haiku-4
ocx models selected anthropic --clear

# Manage manual catalog entries.
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000 --modalities text,image
ocx models edit <custom-id> --display-name "DeepSeek V4.1"
ocx models remove <custom-id> --yes
```

`enable`, `disable`, `provider`, `selected`, `context`, `shadow`, and custom-model `edit`
use the running proxy's management API and require a running proxy. `add` and `remove` update
validated local configuration and synchronise a live proxy when one is available. Run
`ocx models list-custom --json` to find a custom model id.
~~~~

The last paragraph must be corrected before landing: `add` and `remove` are offline-capable, but `enable`, `disable`, `provider`, `selected`, `context`, `shadow`, and `edit` are runtime commands. That split follows `/Users/jun/Developer/new/700_projects/opencodex/src/cli/models.ts:315-335` and `/Users/jun/Developer/new/700_projects/opencodex/src/cli/models-runtime.ts:16-24`.

`docs-site/src/content/docs/guides/web-dashboard.md` must replace the Models row and remove the current "Model visibility" section, which still promises switches in the dashboard (`/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/guides/web-dashboard.md:47,65-67`). Add this exact prose in its place:

~~~~md
## Model catalog management

The dashboard keeps unified model settings: the global context-cap value, provider-level context
cap switches, the all-providers context-cap action, the global shadow-call model, and v1/base/v2
controls. Per-model visibility, provider-wide catalog visibility, provider allowlists, and custom
model entries are managed with `ocx models` or the management API. See
[CLI reference](/reference/cli/#ocx-models-subcommand) for commands and examples.
~~~~

The existing management endpoint table must change the model line from `GET /api/models · PUT /api/disabled-models` and `GET /api/selected-models · PUT /api/model-visibility` to this exact row:

~~~~md
| `GET /api/models` · `PUT /api/model-visibility` · `GET` / `PUT /api/selected-models` · `GET` / `POST /api/custom-models` | Read or manage the model catalog outside the dashboard. |
~~~~

Locale sync is mandatory before GUI removal: `docs-site/src/content/docs/ko/reference/cli.md`, `ja/reference/cli.md`, `zh-cn/reference/cli.md`, and `ru/reference/cli.md` need the CLI section; `ko/guides/web-dashboard.md`, `ja/guides/web-dashboard.md`, `zh-cn/guides/web-dashboard.md`, and `ru/guides/web-dashboard.md` need the dashboard statement. Existing translated dashboard claims are discoverable at `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/ko/guides/web-dashboard.md:112`, `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/ja/guides/web-dashboard.md:110`, `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/zh-cn/guides/web-dashboard.md:104`, and `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/ru/guides/web-dashboard.md:116`.

## 사용자 확인 gate

기능 제거는 구현자가 결정하지 않는다. docs PR과 수용 매니페스트가 먼저 green인 뒤, 아래 항목을 사용자가 항목별로 승인해야 한다. 어느 한 항목이 `보류` 또는 `거절`이면 해당 UI와 관련 state/CSS/docs claim을 유지하고 나머지 승인 항목만 진행한다.

| 승인 항목 | 승인 | 보류/거절 시 |
| --- | --- | --- |
| Models page의 모델별 enable/disable switch 제거 | `승인 / 보류 / 거절` | switch와 `applyVisibility("models", ...)` 유지. |
| provider All on/All off 제거 | `승인 / 보류 / 거절` | 두 bulk button 유지. |
| Models page의 custom model add/edit/delete modal·tooltip action 제거 | `승인 / 보류 / 거절` | custom CRUD UI 유지. |
| Provider workspace의 duplicate custom-model Add 제거 | `승인 / 보류 / 거절` | duplicate input/button 유지. |
| Models rail/provider table을 CLI 안내 card로 교체 | `승인 / 보류 / 거절` | read-only browser를 남길지 별도 UX 결정을 받는다. |
| provider별 context-cap GUI 유지 | `승인 / 보류 / 거절` | 거절은 범위 확장이다. API/CLI replacement와 별도 approval이 필요하다. |

사용자에게 보낼 승인 문구는 다음으로 고정한다.

> 모델별 On/Off, provider All On/Off, custom model CRUD, provider workspace의 중복 Add를 GUI에서 빼고 `ocx models`/management API로만 관리해도 될까요? 전역 context cap, provider별 cap, shadow-call model, provider default model은 GUI에 남깁니다. 위 표에서 각 항목을 승인·보류·거절로 표시해 주세요.

## 활성화 시나리오

| 시나리오 | 발화 | 관측 기준 |
| --- | --- | --- |
| 개별 routed model disable | `ocx models disable provider/model` | `ocx models live --provider provider --json`과 `GET /api/models`에서 disabled 상태 확인. |
| native model enable | `ocx models enable gpt-5.6 --native` | CLI가 `{ provider: "openai", native: true }` request를 보냄. |
| provider All on | `ocx models provider provider on` | allowlist clear와 provider blocklist 해제가 같은 PUT 결과에 반영. |
| allowlist clear | `ocx models selected provider --clear` | `GET /api/selected-models`에서 provider key가 없거나 빈 list이며 catalog가 전체 노출. |
| custom add/edit/delete | 표의 세 CLI command | add/delete는 offline config에서도 동작, edit은 live proxy에서 response 200. |
| dashboard migration | approved remove list로 GUI build | provider rail/table/custom modal/input이 없고 unified controls + CLI card만 존재. |
| old docs link | dashboard CLI link click | `/reference/cli/#ocx-models-subcommand`의 command block으로 이동. |

검증은 control마다 command를 실제 실행하고 stdout/status를 manifest에 기록한 뒤, `bun run test`와 docs build를 실행한다. 실행 전에는 UI를 지우지 않는다. 이 WP 문서는 실행 계획만 담고 있으며 command를 실행하지 않는다.

## 범위 경계

**IN**: 모델별 visibility GUI, provider bulk visibility GUI, Models custom CRUD GUI, ProviderModels duplicate custom add GUI의 승인된 제거; CLI/API replacement 문서화; Models page replacement affordance; retained global/provider-level setting 정리; relevant tests and docs locale sync.

**OUT**: management API route 삭제/변경, `ocx models` command semantics 변경, provider default model GUI 제거, global context-cap/shadow-call/v2 GUI 제거, provider-level context cap 제거(새 승인 필요), WP6 CSS completion, release/publish, direct management-token/curl auth UX를 새로 문서화하는 일.
