# WP6 — Web Dashboard 문서 동기화

## 목적

Classic/Workspace 전환 경로가 제거된 뒤에도 사용자가 사라진 토글과
`#providers/workspace`를 찾지 않도록 영어 원문과 ko/ja/ru/zh-cn 번역을 최종 단일
레이아웃 계약에 맞춘다. Dashboard는 상단 탭과 하위 해시를, Providers는
`#providers` 하나만 사용한다는 사실을 같은 자리에서 설명한다
(`000_plan.md:198-203`, `000_plan.md:304-310`).

## 현재 상태(증거)

### 제거해야 할 문장 전수

영어 원문에는 제목과 아래 세 문장이 있다
(`docs-site/src/content/docs/guides/web-dashboard.md:44-48`).

> ### Classic vs Workspace
>
> The sidebar **Workspace / Classic** control switches the Dashboard and Providers layouts.
>
> The preference is stored in the browser and kept consistent across those pages.
>
> On Providers, the URL also reflects the mode (`#providers` vs `#providers/workspace`).

한국어 번역에는 아래 제목과 세 문장이 있다
(`docs-site/src/content/docs/ko/guides/web-dashboard.md:44-46`).

> ### Classic / Workspace
>
> 사이드바의 **Workspace / Classic** 컨트롤로 Dashboard와 Providers 레이아웃을 전환합니다.
>
> 설정은 브라우저에 저장되며 이 페이지들 사이에서 맞춰집니다.
>
> Providers에서는 URL도 모드를 반영합니다(`#providers` vs `#providers/workspace`).

일본어 번역에는 아래 제목과 세 문장이 있다
(`docs-site/src/content/docs/ja/guides/web-dashboard.md:44-46`).

> ### Classic / Workspace
>
> サイドバーの **Workspace / Classic** コントロールで Dashboard と Providers のレイアウトを切り替えます。
>
> 設定はブラウザに保存され、これらのページ間で揃います。
>
> Providers では URL もモードを反映します（`#providers` と `#providers/workspace`）。

러시아어 번역에는 아래 제목과 세 문장이 있다
(`docs-site/src/content/docs/ru/guides/web-dashboard.md:44-46`).

> ### Classic / Workspace
>
> Элемент боковой панели **Workspace / Classic** переключает макеты Dashboard и Providers.
>
> Предпочтение хранится в браузере и согласуется между этими страницами.
>
> На Providers URL также отражает режим (`#providers` и `#providers/workspace`).

중국어 간체 번역에는 아래 제목과 세 문장이 있다
(`docs-site/src/content/docs/zh-cn/guides/web-dashboard.md:43-45`).

> ### Classic / Workspace
>
> 侧边栏的 **Workspace / Classic** 控件切换 Dashboard 与 Providers 的布局。
>
> 偏好保存在浏览器中，并在这些页面间保持一致。
>
> Providers 页面的 URL 也会反映模式（`#providers` 与 `#providers/workspace`）。

### 다른 문서 검색

`rg -n -i 'workspace|classic|providers/workspace' docs-site/src/content/docs --glob '*.md'`의
관련 결과는 위 5개 Web Dashboard 문서뿐이다. 추가로 잡히는
`docs-site/src/content/docs/guides/sub-agent-surface.md:16`의 “Classic namespaced agent
tools”는 `multi_agent_v1` 도구 명칭이며 GUI 레이아웃·토글·해시와 무관하므로 유지한다.
즉, WP6 수정 대상은 계획대로 5개 파일이다.

## 변경 계획(구체적 diff 형태)

각 파일에서 기존 제목과 문단 전체를 아래 블록으로 교체한다. 영어를 기준으로 삼되,
번역은 각 언어의 자연스러운 문장으로 유지한다.

### English

```diff
-### Classic vs Workspace
-
-The sidebar **Workspace / Classic** control switches the Dashboard and Providers layouts. The
-preference is stored in the browser and kept consistent across those pages. On Providers, the URL
-also reflects the mode (`#providers` vs `#providers/workspace`).
+### Dashboard and Providers layouts
+
+Dashboard and Providers each use a single layout with no layout toggle. The Dashboard's top tabs
+use `#dashboard` for Overview, `#dashboard/providers` for Providers, and `#dashboard/models` for
+Models. The Providers page uses `#providers`.
```

### 한국어

```diff
-### Classic / Workspace
-
-사이드바의 **Workspace / Classic** 컨트롤로 Dashboard와 Providers 레이아웃을 전환합니다. 설정은 브라우저에 저장되며 이 페이지들 사이에서 맞춰집니다. Providers에서는 URL도 모드를 반영합니다(`#providers` vs `#providers/workspace`).
+### Dashboard와 Providers 레이아웃
+
+Dashboard와 Providers는 전환 버튼 없이 각각 하나의 레이아웃만 사용합니다. Dashboard 상단 탭은 Overview에 `#dashboard`, Providers에 `#dashboard/providers`, Models에 `#dashboard/models`를 사용합니다. Providers 페이지 주소는 `#providers`입니다.
```

### 日本語

```diff
-### Classic / Workspace
-
-サイドバーの **Workspace / Classic** コントロールで Dashboard と Providers のレイアウトを切り替えます。設定はブラウザに保存され、これらのページ間で揃います。Providers では URL もモードを反映します（`#providers` と `#providers/workspace`）。
+### Dashboard と Providers のレイアウト
+
+Dashboard と Providers は、それぞれ切り替えなしの単一レイアウトを使用します。Dashboard 上部のタブでは、Overview に `#dashboard`、Providers に `#dashboard/providers`、Models に `#dashboard/models` を使用します。Providers ページの URL は `#providers` です。
```

### Русский

```diff
-### Classic / Workspace
-
-Элемент боковой панели **Workspace / Classic** переключает макеты Dashboard и Providers. Предпочтение хранится в браузере и согласуется между этими страницами. На Providers URL также отражает режим (`#providers` и `#providers/workspace`).
+### Макеты Dashboard и Providers
+
+Dashboard и Providers используют по одному макету без переключателя. Верхние вкладки Dashboard используют `#dashboard` для Overview, `#dashboard/providers` для Providers и `#dashboard/models` для Models. Адрес страницы Providers — `#providers`.
```

### 简体中文

```diff
-### Classic / Workspace
-
-侧边栏的 **Workspace / Classic** 控件切换 Dashboard 与 Providers 的布局。偏好保存在浏览器中，并在这些页面间保持一致。Providers 页面的 URL 也会反映模式（`#providers` 与 `#providers/workspace`）。
+### Dashboard 与 Providers 布局
+
+Dashboard 和 Providers 均使用单一布局，不再提供切换控件。Dashboard 顶部标签页中，Overview 使用 `#dashboard`，Providers 使用 `#dashboard/providers`，Models 使用 `#dashboard/models`。Providers 页面使用 `#providers`。
```

## 검증

1. `rg -n -i 'classic|workspace|providers/workspace' docs-site/src/content/docs/{guides,ko/guides,ja/guides,ru/guides,zh-cn/guides}/web-dashboard.md`가 0건이어야 한다.
2. `rg -n '#dashboard/providers|#dashboard/models|#providers'`를 같은 5개 파일에 실행해 각 파일에서 새 해시 계약을 확인한다.
3. `(cd docs-site && bun run build)`로 Markdown/Astro 구문 오류와 locale 경로 오류가 없는지 확인한다(`docs-site/package.json:6-11`).
4. 영어와 네 번역을 나란히 읽어 세 의미—단일 레이아웃, Dashboard 상단 탭 해시, Providers 단일 해시—가 모두 보존되는지 수동 대조한다.

## 위험

- WP2/WP5보다 먼저 문서를 반영하면 배포 문서가 아직 없는 해시를 안내한다. 계획대로 WP5 완료 뒤 적용한다(`000_plan.md:257-264`).
- 번역 문구에서 Overview/Providers/Models를 임의 번역하면 실제 UI 탭 이름과 어긋날 수 있다. 현재 UI 표기를 그대로 둔다.
- `#providers/workspace`의 passive replace 호환 경로는 구현상 남더라도 사용자용 정식 주소가 아니다. 새 문서에는 호환 해시를 다시 노출하지 않는다(`000_plan.md:304`).
