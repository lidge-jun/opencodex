# 050_settings_card_unify — WP6 설정 카드와 컨트롤 정렬 통일

## P에서 먼저 확정할 의존성

WP6은 WP2의 D 결과를 읽고 아래 둘 중 하나만 고른다.

| WP2 결과 | WP6의 선택 | 금지 사항 |
| --- | --- | --- |
| `.setting-row`를 감싼 card primitive를 export함 | 그 primitive를 import하고, 이 문서의 markup을 그 primitive의 children으로 넣는다. | WP6가 두 번째 card primitive를 만들지 않는다. |
| WP2가 로더만 다루며 card primitive를 export하지 않음 | 아래의 `<div className="card">` + `.setting-row` markup을 WP6의 정본으로 둔다. | WP2에 card API를 뒤늦게 추가하지 않는다. |

이 결정은 WP6 P에서 한 번만 기록한다. WP2의 카드 export는 선택적 소비 관계일 뿐이며, WP6의 시작·검증·완료를 막지 않는다. 이 분기는 계획에 이미 명시돼 있다: `/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:34`.

## 현재 상태 진단

사용자가 보고 있는 화면은 이 checkout이 아니라 npm 전역 `v2.7.43`이다. 그 서빙 CSS에는 `.account-pool-strategy-card` 규칙이 없어서 카드 안쪽 inset 자체가 없었다. 반대로 현재 `dev`에는 이미 `padding: 14px 16px`가 있다. 즉, **테두리에 바짝 붙어 보인 패딩 문제는 릴리스 지연으로 남아 있고, dev에서 같은 패딩 버그가 그대로 재현되는 것은 아니다.** 근거는 `/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_research.md:307-318`, 현재 CSS는 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1284-1289`이다.

그러나 dev도 설정 구조는 통일돼 있지 않다. `CodexPoolStrategySetting`은 제목·설명을 card의 맨 위에 두고 전폭 select를 별도 grid로 내보낸다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexPoolStrategySetting.tsx:190-237`). 그 select의 label은 `strategyLabelHidden` 때문에 `sr-only`가 된다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/AccountPoolStrategyControls.tsx:54-70`). 따라서 화면에는 "제목 + 설명 아래의 이름 없는 전폭 선택기"가 남는다. 이는 title/desc를 좌측에, 조작부를 우측에 둔 지배적 패턴과 다르다. 기준 구현은 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/claude-code-sections.tsx:41-69`, CSS는 `/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1830-1842`다.

전환 임계값의 문제도 높이가 아니라 구조다. 숫자 compound의 최소 높이는 32px(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1134-1146`)이고, 직접 렌더한 `.toggle`은 36×20px(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1122-1126`)이다. 현재 flex는 바닥을 맞춘다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1127-1133`). 그래서 `32 / 2 - 20 / 2 = 6px`만큼 중심이 어긋난다. stepper는 input wrap 안에서 stretch되어 32px를 채우므로 원인이 아니다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1208-1224`).

## 정본 패턴

설정 카드의 정본은 기존 `.setting-row`를 그대로 쓴다. 새 토큰이나 별도 디자인 시스템은 만들지 않는다. 카드 외곽은 `.card`, 행 inset과 경계는 `.setting-row`, 텍스트는 `.setting-label > .title + .desc`, 조작부는 `.setting-controls`다. spacing은 이미 있는 `--space-2`, `--space-3`, `--space-4`만 쓴다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:57-68`).

```tsx
<section className="card" aria-busy={saving || undefined}>
  <div className="setting-row">
    <div className="setting-label">
      <span className="title">{t("accountPool.strategy")}</span>
      <span className="desc">{t("accountPool.strategyDesc")}</span>
    </div>
    <div className="setting-controls">
      <Select
        id="codex-pool-strategy"
        value={strategy}
        options={strategyOptions}
        label={t("accountPool.strategy")}
        onChange={onStrategyChange}
      />
    </div>
  </div>

  {strategy === "round-robin" && (
    <div className="setting-row">
      <div className="setting-label">
        <span className="title">{t("accountPool.stickyLimit")}</span>
        <span className="desc">{t("accountPool.stickyLimitHelp")}</span>
      </div>
      <div className="setting-controls">
        <span className="codex-auto-switch-input-wrap">{/* input + NumberStepper */}</span>
      </div>
    </div>
  )}
</section>
```

`Select`의 `label`은 접근성 이름으로 계속 남긴다. 화면에서 field label을 숨기지 않는 방법은 label을 두 번 출력하는 것이 아니라, 좌측의 `.setting-label .title`을 실제 보이는 필드 이름으로 만드는 것이다. 작은 화면에서는 같은 row를 줄바꿈하되 title/desc와 control의 순서는 바꾸지 않는다.

## 로테이션 전략 카드 diff

`AccountPoolStrategyControls`는 Codex와 Anthropic pool 양쪽에서 쓰인다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexPoolStrategySetting.tsx:204-230`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx:229-250`). 따라서 `strategyLabelHidden`만 제거하고 Codex만 고치면 두 화면의 markup이 다시 갈라진다. 공용 컴포넌트가 두 개의 canonical setting row를 출력하도록 바꾼다. Anthropic caller는 그대로 이 markup을 card 안에 넣고, 그 card도 별도 WP6 diff에서 같은 row/card 구조로 바꾼다.

```diff
diff --git a/gui/src/components/CodexPoolStrategySetting.tsx b/gui/src/components/CodexPoolStrategySetting.tsx
@@
-    <div className="card account-pool-strategy-card" aria-busy={saving || (!hydrated && !loadError)}>
-      <strong>{t("accountPool.strategy")}</strong>
-      <div className="card-sub" role={loadError ? "alert" : undefined}>
-        {loadError ? t("accountPool.strategyLoadFailed") : t("accountPool.strategyDesc")}
-      </div>
-      {loadError && <button type="button" className="btn btn-ghost btn-sm account-pool-strategy-card__retry" onClick={() => { void load(); }}>{t("common.retry")}</button>}
-      {!loadError && <AccountPoolStrategyControls ... strategyLabelHidden ... />}
-    </div>
+    <section className="card account-pool-strategy-card" aria-busy={saving || (!hydrated && !loadError) || undefined}>
+      {loadError ? (
+        <div className="setting-row">
+          <div className="setting-label">
+            <span className="title">{t("accountPool.strategy")}</span>
+            <span className="desc" role="alert">{t("accountPool.strategyLoadFailed")}</span>
+          </div>
+          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button>
+        </div>
+      ) : (
+        <AccountPoolStrategyControls
+          strategy={strategy}
+          stickyDraft={stickyDraft}
+          disabled={controlsDisabled}
+          strategySelectId="codex-pool-strategy"
+          stickyInputId="codex-pool-sticky-limit"
+          onStrategyChange={(next) => { if (!controlsDisabled && next !== strategy) void save({ strategy: next }); }}
+          onStickyDraftChange={setStickyDraft}
+          onStickyCommit={commitStickyLimit}
+        />
+      )}
+      {error && <div role="alert" className="account-pool-strategy-card__error">{error}</div>}
+    </section>
```

위 diff의 `commitStickyLimit`은 기존 `onStickyCommit` body를 이름만 붙여 그대로 옮긴 함수다. 새 동작을 넣지 않는다. 실제 구현에서는 축약부 `...`와 `commitStickyLimit`을 남기지 않고, 기존 props와 216–229행의 검증 body를 통째로 유지한다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexPoolStrategySetting.tsx:203-235`).

```diff
diff --git a/gui/src/components/AccountPoolStrategyControls.tsx b/gui/src/components/AccountPoolStrategyControls.tsx
@@
-  strategyLabelHidden?: boolean;
@@
-  strategyLabelHidden = false,
@@
-    <div className="account-pool-strategy-controls">
-      <div className="field">
-        <span className={strategyLabelHidden ? "sr-only" : "field-label"} id={`${strategySelectId}-label`}>
-          {t("accountPool.strategy")}
-        </span>
-        <Select ... style={{ width: "100%", display: "block" }} />
-      </div>
-      <div className="card-sub">{t("accountPool.strategyHint")}</div>
+    <div className="account-pool-strategy-controls">
+      <div className="setting-row">
+        <div className="setting-label">
+          <span className="title">{t("accountPool.strategy")}</span>
+          <span className="desc">{t("accountPool.strategyDesc")}</span>
+        </div>
+        <div className="setting-controls">
+          <Select id={strategySelectId} value={strategy} options={strategyOptions}
+            disabled={disabled} label={t("accountPool.strategy")}
+            onChange={(next) => onStrategyChange(next as AccountPoolStrategy)} />
+        </div>
+      </div>
       {strategy === "round-robin" && (
-        <label className="field" htmlFor={stickyInputId}>
-          <span className="field-label">{t("accountPool.stickyLimit")}</span>
+        <div className="setting-row">
+          <label className="setting-label" htmlFor={stickyInputId}>
+            <span className="title">{t("accountPool.stickyLimit")}</span>
+            <span className="desc">{t("accountPool.stickyLimitHelp")}</span>
+          </label>
+          <div className="setting-controls">
             <span className="codex-auto-switch-input-wrap">{/* existing input + NumberStepper */}</span>
-          <div className="card-sub">{t("accountPool.stickyLimitHelp")}</div>
-        </label>
+          </div>
+        </div>
       )}
     </div>
```

`strategyHint`가 `strategyDesc`와 다른 문장이라면 위 `desc` 자리에 기존 hint 키를 유지한다. P에서 locale의 실제 의미를 확인해 두 문장을 합치지 않는다. UI text 추가는 하지 않으며, 필요한 키가 없다면 기존 en source와 모든 locale에 같은 키를 넣어야 한다는 GUI 규칙을 따른다(`/Users/jun/Developer/new/700_projects/opencodex/gui/AGENTS.md:11-28`).

```diff
diff --git a/gui/src/styles.css b/gui/src/styles.css
@@
 .account-pool-strategy-card {
-  margin-top: 16px;
-  padding: 14px 16px;
-  display: grid;
-  gap: 8px;
+  margin-top: var(--space-4);
+  overflow: hidden;
 }
-.account-pool-strategy-card > strong { display: block; margin: 0; }
-.account-pool-strategy-card > .card-sub,
-.account-pool-strategy-controls > .card-sub,
-.account-pool-strategy-controls .field .card-sub { margin: 0; padding: 0; }
-.account-pool-strategy-card__retry { justify-self: start; }
-.account-pool-strategy-controls { margin: 0; display: grid; gap: 8px; }
-.account-pool-strategy-controls .field { display: grid; gap: 6px; margin: 0; }
-.account-pool-strategy-controls .field-label { margin-bottom: 0; }
-.account-pool-strategy-controls .custom-select { width: 100%; max-width: 100%; }
-.account-pool-strategy-controls .select-trigger { width: 100%; max-width: 100%; justify-content: space-between; }
+.account-pool-strategy-controls { display: contents; }
+.account-pool-strategy-controls .setting-controls { min-width: 0; }
+.account-pool-strategy-controls .custom-select,
+.account-pool-strategy-controls .select-trigger { min-width: min(100%, 14rem); }
+.account-pool-strategy-card__error { margin: 0 var(--space-4) var(--space-3); color: var(--red); }
```

release 쪽 패딩은 이 diff로 "고친다"고 말하지 않는다. 이 diff는 dev 구조를 정본으로 맞춘다. 사용자의 실제 `v2.7.43` 화면에는 이 CSS가 없으므로, 로컬 build를 실제 serving binary로 교체하고 이후 릴리스해야 `padding`과 새 row 모두 도달한다. 서빙본/checkout 불일치 근거는 `/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_research.md:7-29`다.

## 스위치 정렬 diff

공용 `Switch`로 합친다. `Switch`는 이미 34×20px, disabled, pressed state를 한 버튼에 묶어 제공한다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:8-14`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:845-864`). `.toggle` 직접 렌더는 36×20px이고, `CodexAutoSwitchSetting`에만 pointer/blur 보호가 중복 구현돼 있다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexAutoSwitchSetting.tsx:67-155`). 폭 2px 차이는 세로 정렬을 해결하지 못하므로 공용 Switch의 34px 폭을 바꾸지 않는다.

중심선은 wrapper로 맞춘다. threshold label의 전체 높이를 `align-items: center`로 맞추면 label text 때문에 오히려 input의 중심이 올라간다. 기존처럼 두 control column의 아래 변은 맞추되, toggle을 32px slot의 정중앙에 넣는다.

```text
input wrap:  top = B - 32, center = B - 16
toggle slot: top = B - 32, center = B - 16
Switch:      slot top + (32 - 20) / 2 = B - 26, center = B - 16
차이:        |(B - 16) - (B - 16)| = 0px
```

```diff
diff --git a/gui/src/ui.tsx b/gui/src/ui.tsx
@@
-export function Switch({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
+export function Switch({ on, onClick, disabled, label, describedBy, title, onPointerDownCapture, onPointerUp, onPointerCancel }: {
+  on: boolean; onClick: () => void; disabled?: boolean; label?: string; describedBy?: string; title?: string;
+  onPointerDownCapture?: React.PointerEventHandler<HTMLButtonElement>;
+  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
+  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
+}) {
   return (
-    <button type="button" className={`switch${on ? " on" : ""}`} onClick={onClick} disabled={disabled}
-      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")}>
+    <button type="button" className={`switch${on ? " on" : ""}`} onClick={onClick} disabled={disabled}
+      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")} aria-describedby={describedBy}
+      title={title} onPointerDownCapture={onPointerDownCapture} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
       <span className="knob" />
     </button>
```

```diff
diff --git a/gui/src/components/CodexAutoSwitchSetting.tsx b/gui/src/components/CodexAutoSwitchSetting.tsx
@@
 import { NumberStepper } from "./NumberStepper";
+import { Switch } from "../ui";
@@
-        <button
-          type="button"
-          className={`toggle ${enabled ? "on" : ""}`}
-          onPointerDownCapture={() => { togglePointerIntentRef.current = true; }}
-          onPointerUp={() => { togglePointerIntentRef.current = false; }}
-          onPointerCancel={() => { togglePointerIntentRef.current = false; }}
-          onClick={() => { togglePointerIntentRef.current = false; void onToggle(); }}
-          disabled={controlsDisabled}
-          aria-pressed={enabled}
-          aria-label={t("codexAuth.autoSwitch")}
-          aria-describedby={describedBy}
-          title={t("codexAuth.autoSwitch")}
-        >
-          <span className="toggle-knob" />
-        </button>
+        <div className="codex-auto-switch-toggle-slot">
+          <Switch
+            on={enabled}
+            disabled={controlsDisabled}
+            label={t("codexAuth.autoSwitch")}
+            describedBy={describedBy}
+            title={t("codexAuth.autoSwitch")}
+            onPointerDownCapture={() => { togglePointerIntentRef.current = true; }}
+            onPointerUp={() => { togglePointerIntentRef.current = false; }}
+            onPointerCancel={() => { togglePointerIntentRef.current = false; }}
+            onClick={() => { togglePointerIntentRef.current = false; void onToggle(); }}
+          />
+        </div>
```

```diff
diff --git a/gui/src/styles.css b/gui/src/styles.css
@@
-.codex-auto-switch-controls { display: flex; align-items: flex-end; gap: 12px; flex: 0 0 auto; margin-left: auto; }
-.codex-auto-switch-controls > .toggle { margin-left: auto; }
+.codex-auto-switch-controls { display: flex; align-items: flex-end; gap: var(--space-3); flex: 0 0 auto; margin-left: auto; }
+.codex-auto-switch-toggle-slot { min-height: 32px; display: flex; align-items: center; margin-left: auto; }
```

`NumberStepper.tsx`는 바꾸지 않는다. 32px 컨테이너 안에서 두 button을 stretch시키는 CSS가 이미 있다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1208-1224`); JSX도 presentation-free다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/NumberStepper.tsx:13-45`).

## 앱 전체 통일 감사

감사 검색은 다음 두 범위를 모두 대상으로 한다. 결과가 card라는 이유만으로 설정 카드라고 분류하지 않고, 사용자가 값을 바꾸는 row만 대상으로 삼는다.

```bash
rg -n --glob '*.{tsx,ts}' 'card-row|setting-row|className="toggle|className=\\{`toggle|<Switch\\b|settings|Settings|setting' gui/src/pages gui/src/components
rg -n --glob '*.{tsx,ts}' 'className="card|className=\\{`card' gui/src/pages gui/src/components
```

| 파일:행 | 현재 deviation | WP6 조치 |
| --- | --- | --- |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexPoolStrategySetting.tsx:191-230` | card 제목/설명과 전폭 control이 분리되고 visual field label이 없다. | 위 canonical two-row card로 교체. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/AccountPoolStrategyControls.tsx:54-118` | `.field` grid와 `card-sub`가 setting-row와 별개다. `strategyLabelHidden`도 존재한다. | 공용 component가 canonical rows를 render하고 hidden prop 제거. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexAutoSwitchSetting.tsx:48-167` | `.card-row`, custom `.toggle`, threshold와 toggle의 중심선 불일치. | shared `Switch` + 32px slot. card copy/control도 `.setting-row` 계열로 교체. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx:144-268` | `.card-row`, 직접 checkbox `.toggle`, threshold/strategy가 제각각 label stack이다. | `AccountPoolStrategyControls`의 row markup을 소비하고 enabled/threshold도 같은 card row로 이동. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/claude-code-settings.tsx:19-30` | 바깥 row는 정본이나 toggle implementation이 별도 input/slider다. | `SettingToggle`을 `Switch` adapter로 바꾼다. outer `.setting-row`는 유지. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/dashboard-overview-sections.tsx:125-156` | `.spread` + 손수 만든 `.switch` 두 개가 setting-row의 title/desc 구조를 우회한다. | `setting-row` 카드로 합치고 `Switch` 사용. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/dashboard-overview-sections.tsx:232-310` | panel 안에 `.spread`, 직접 `.switch`, sidecar별 별도 row가 섞여 있다. | sidecar/auto-start/shadow 모두 같은 card + setting-row markup으로 바꾼다. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:879-1005` | shadow, v2, global context cap가 bare `.row`로 있고 label/control hierarchy가 없다. | WP7가 제거하지 않는 global controls만 settings card의 row로 이동. per-provider cap은 아래 결정에 따른다. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:959-974` | policy enable이 직접 `.toggle` + span이라 shared switch와 setting label을 쓰지 않는다. | `Switch`와 `.setting-row`로 교체; 나머지 policy form은 그 아래 panel로 둔다. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/debug-settings-panel.tsx:25-79` | 한 card에 4개 settings가 inline style로 압축돼 row 경계·설명이 없다. | flag마다 `.setting-row`를 출력하고 reset은 card footer action으로 둔다. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderSettings.tsx:177-275` | provider 편집 form은 `.pwi-settings-field`의 세로 form이며 multi-field submit 모델이다. | **변경하지 않음.** 즉시 저장 settings card가 아니라 하나의 저장/폐기 form이므로 canonical row로 억지 변환하지 않는다. checkbox 두 개의 label/accessibility만 별도 점검. |
| `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderDetails.tsx:169-178` | provider header의 enabled switch다. | **변경하지 않음.** detail header action이지 설정 card row가 아니다. |

계정 카드, modal card, combo card, usage card, 모델 browser rail, group-collapse toggle은 값을 설정하는 card/row가 아니어서 위 통일 대상이 아니다. 예를 들어 Codex account card는 계정 상태와 action을 나타내는 목록이다(`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/codex-account-pool-cards.tsx:63-136`). `Models.tsx`의 모델별/프로바이더별 컨트롤은 WP7의 removal gate를 통과한 것만 제거한다. WP6가 먼저 삭제하지 않는다.

## 테스트와 검증

1. CSS/markup regression test는 `CodexAutoSwitchSetting`을 enabled 상태로 render하고 `.codex-auto-switch-input-wrap`, `.codex-auto-switch-toggle-slot > .switch`가 존재함을 확인한다. `NumberStepper`가 남아 있음을 같이 확인한다.
2. 브라우저에서 100% zoom, viewport 1440px와 390px 두 가지로 Codex Auth를 열고 threshold를 on/off 한다. 전자는 input, `Switch`, card inset을; 후자는 row wrap 뒤에도 label과 control 순서가 유지되는지를 screenshot으로 대조한다. screenshot에는 ruler/overlay를 남기지 않는다.
3. DOM proof는 실제 render 뒤 다음을 실행한다. layout device scale factor는 1로 고정한다.

```js
const input = document.querySelector('.codex-auto-switch-input-wrap').getBoundingClientRect();
const toggle = document.querySelector('.codex-auto-switch-toggle-slot > .switch').getBoundingClientRect();
const inputCenter = input.top + input.height / 2;
const toggleCenter = toggle.top + toggle.height / 2;
console.assert(input.height === 32, `input height: ${input.height}`);
console.assert(Math.abs(inputCenter - toggleCenter) === 0, `${inputCenter} != ${toggleCenter}`);
```

`=== 0` 검사는 반올림한 값이 아니라 browser가 돌려준 CSS pixel 값 자체로 한다. 반응형 wrap, disabled, load error, round-robin sticky limit on/off를 모두 screenshot matrix에 넣는다. 실제 구현 단계에서는 GUI 변경 규칙에 따라 `cd gui && bun test tests`, `bun run lint`, `bun run build`를 실행한다(`/Users/jun/Developer/new/700_projects/opencodex/gui/AGENTS.md:39-50`). 이 WP 문서 작성 단계에서는 빌드를 실행하지 않는다.

## 활성화 시나리오

| 시나리오 | 발화 | 관측 기준 |
| --- | --- | --- |
| WP2 primitive 있음 | WP2 export를 import한 build | 한 primitive만 쓰고 duplicate CSS 없음. |
| WP2 primitive 없음 | WP6 자체 markup branch | loader import 없이 card/row snapshot이 동일. |
| 실제 릴리스 지연 | npm global `v2.7.43` 서빙 | 이전 CSS에는 rule 없음, 로컬 build/restart 뒤에는 new row와 inset 보임. |
| 첫 load | `/active` 지연 | disabled chrome은 보이고 write는 blocked. |
| load failure | `/active` 500 | error row와 retry button, stale/default write 없음. |
| auto-switch on | threshold > 0 | 32px input center와 20px switch center가 0px 차이. |
| auto-switch off | threshold = 0 | input field가 사라져도 switch의 focus/pressed/disabled state 정상. |
| round-robin | strategy 변경 | sticky limit이 별도 setting-row로 나타나고 visible title/desc 유지. |

## 범위 경계

**IN**: `CodexPoolStrategySetting`, `AccountPoolStrategyControls`, `CodexAutoSwitchSetting`, shared `Switch`의 필요한 event/ARIA props, 각 표의 설정 row markup/CSS, 0px center-line 검증, release-lag를 명시하는 user-facing release note.

**OUT**: 새 spacing/control token, `gui/dist` 직접 수정, 수치 stepper 재설계, provider form의 submit model 변경, account/list/modal card 재디자인, WP2 loader contract 구현, WP7의 모델별 control 제거, npm publish 또는 실제 release. 사용자 화면의 v2.7.43 padding은 source patch만으로 배포되지 않는다.

## 감사 반영 (A, 2026-07-31) — blocker 1건 + 축소

리뷰어가 FAIL을 냈다. 소스에서 전부 확인했고, 아래가 구현의 정본이다. 위 본문은 원안 기록.

### B1 (blocker) — 한 줄 desc는 문구 하나를 조용히 버린다

원안의 canonical row는 `.desc` 하나만 두고 "둘이 다르면 하나를 고르라"고 했다. 그런데 지금
화면에는 **서로 다른 말을 하는 두 문구**가 동시에 나온다.

| 키 | 한국어 | 렌더 위치 |
|----|--------|-----------|
| `accountPool.strategyDesc` | 새 세션이 풀에서 계정을 고르는 방식입니다. | [CodexPoolStrategySetting.tsx:196](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexPoolStrategySetting.tsx:196) |
| `accountPool.strategyHint` | 새 세션에만 적용됩니다. 기존 스레드는 계정 어피니티를 유지합니다. | [AccountPoolStrategyControls.tsx:73](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/AccountPoolStrategyControls.tsx:73) |

앞은 이 설정이 **무엇을 하는지**, 뒤는 **적용 범위와 기존 스레드가 어떻게 되는지**다. 뒤쪽이
사라지면 "지금 열려 있는 스레드도 즉시 바뀌나?"라는 질문에 화면이 답하지 못한다. 사용자
스크린샷에도 두 줄이 같이 찍혀 있다.

수정: 두 문구를 **모두** 유지한다. canonical row는 `.desc`를 여러 개 받을 수 있고, 어피니티
고지는 두 번째 `.desc` 줄로 남긴다. 어느 쪽도 버리지 않는다.

### B2 — `.setting-row`는 앱 전역 지배 패턴이 아니다

JSX 사용처가 8곳이고 전부 `claude-code-sections.tsx`와 `claude-code-settings.tsx` 두 파일이다.
좋은 기준 구현이긴 하지만 "앱 전역 전환"의 근거는 아니다. 원안의 광범위한 전환 표는 취소한다.

수정: WP6 범위를 **account-pool과 auto-switch 카드로 한정**한다. 나머지 페이지는 별도 인벤토리로
남기고 이번에 건드리지 않는다. 최소 변경을 선호하는 사용자 방향과도 맞는다.

### B3 — auto-switch 처방이 자기모순이었다

표는 canonical row로 전환하라고 하는데 실제 diff는 slot만 추가하고 바깥 `.card.card-row`를
그대로 둔다([CodexAutoSwitchSetting.tsx:48](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexAutoSwitchSetting.tsx:48)).

수정: **slot만** 한다. 정렬 문제는 slot으로 해결되고 침습이 훨씬 적다. 바깥 구조는 유지한다.

### 정렬 방식 확정

리뷰어 확인대로 바깥 `align-items: flex-end`를 **그대로 두고**, 20px `Switch`를 32px slot 안에
넣어 input wrap과 center를 맞춘다. 모바일 override([styles.css:1810](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1810))도
같은 bottom 정렬을 유지하므로 slot 기하를 되돌리지 않는다. `align-items`를 center로 바꾸는
원안보다 부작용이 적다.

### 함께 고칠 테스트

- [account-pool-strategy.test.tsx:180,196](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/account-pool-strategy.test.tsx:180) — 옛 `field-label`/`sr-only` 계약을 단정한다.
- [codex-auto-switch-controller.test.tsx:192](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-auto-switch-controller.test.tsx:192) — `button.toggle` 선택자. `button.switch` + slot으로 바꾸되 pointer-before-blur 경쟁 케이스는 보존한다.
- Anthropic 쪽은 이 컴포넌트를 마운트하는 테스트가 아예 없다. 공용 컴포넌트를 바꾸므로 행동 테스트를 새로 추가한다.
- 0px center-line DOM 검증을 추가한다(반올림 전 CSS pixel 값으로).

### 낡은 앵커

canonical CSS는 1830이 아니라 [styles.css:1928](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1928),
account-pool padding은 1284가 아니라 [styles.css:1385](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1385)다.
release-lag 진단 자체는 맞다. 참고로 반응형 블록에는 `.setting-copy`라는 옛 별칭이 남아 있는데
([styles.css:1803](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1803)) 현재 JSX는
`.setting-label`을 쓴다. 이번에 정리하지 않고 그대로 둔다(범위 밖).

### 감사 2라운드 (blockers=0)

`.setting-copy`를 "낡은 별칭"으로 본 것은 내 오판이었다. Claude와 dashboard 섹션에서 여전히
살아 있는 클래스라 정리 대상이 아니다. 범위 밖으로 두는 결론은 같지만 이유가 다르다.

두 `.desc` 줄이 UI 형태로도 맞다는 확인을 받았다. 설명과 적용 범위는 label column에 같이
있는 것이 자연스럽고, 별도 notice나 select 인라인 텍스트로 빼면 compact한 row에 위계와
소음만 추가된다. 기존 Claude 설정도 이미 여러 desc를 지원한다
([claude-code-sections.tsx](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/claude-code-sections.tsx:128)).

32px slot 관련 구현 제약 하나: **slot은 `{enabled}` 조건 바깥에 렌더한다.** 임계값 input이
사라져도 slot이 남아야 switch 위치가 흔들리지 않는다.

Anthropic 행동 테스트는 "마운트된다"가 아니라 **두 desc 줄이 공용 컴포넌트를 통해 실제로
렌더되는지**를 단정한다. B1의 내용 손실이 한쪽 caller에서만 되살아나는 것을 막는다.
