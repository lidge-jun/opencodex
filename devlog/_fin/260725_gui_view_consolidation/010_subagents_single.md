# 010 — Subagents Classic 단일 구현

WP1의 목표는 `gui/src/pages/Subagents.tsx`에 이미 있는 Classic 화면을 Subagents의
유일한 구현으로 승격하고, #441이 추가한 Workspace 컴포넌트·스타일·문구·테스트를
회수하는 것이다. #441은 2026-07-25 06:42 KST에 정상적으로 머지되었지만
메인테이너가 두 구현을 비교한 뒤 Classic이 더 깔끔하다고 판정했다
(`000_plan.md:56-68`). 따라서 이 작업은 과거 상태로 되감는 revert가 아니라,
동시에 존재하는 두 구현 중 Classic을 최종 구현으로 선택하는 통합이다.

## 현재 상태

| 파일 | 현재 역할과 근거 | WP1 판정 |
| --- | --- | --- |
| `gui/src/pages/Subagents.tsx` | 181줄. `readViewMode`/`ViewMode`와 Workspace 컴포넌트를 가져온다(`:7-8`). `workspaceView`는 `:18`에서 계산한다. 데이터 로드·선택·순서 변경·저장은 두 화면이 공유한다(`:12-79`). 로딩 반환 뒤(`:81`) Workspace 분기는 `:83-99`, Classic 렌더는 `:101-180`이다. | 공유 로직과 Classic 렌더를 남기고 Workspace 분기만 제거한다. |
| `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx` | 231줄. Workspace 전용 rail/detail UI와 로컬 `query`/`selected` 상태를 소유한다(`:22-58`). 전체 렌더는 `:59-230`이다. | 파일 삭제. |
| `gui/src/styles-subagents-workspace.css` | 470줄. `.subagents-workspace-*`와 `.swi-*` 전용 규칙만 정의한다(`:1-470`). | 파일 삭제. |
| `gui/src/styles.css` | Workspace 전용 스타일을 `@import "./styles-subagents-workspace.css";`로 가져온다(`:18`). | import 한 줄 삭제. |
| `gui/src/i18n/{en,ko,ja,de,ru,zh}.ts` | 각 로케일에 `sub.workspace.*` 10개가 있다(아래 회수표). 실제 UI 소비자는 삭제 대상 컴포넌트뿐이다(`SubagentsWorkspace.tsx:103-181`). | 6개 로케일에서 60개 항목을 같은 diff에서 삭제. |
| `gui/tests/subagents-workspace.test.ts` | 5개 정적 계약 테스트가 Workspace 분기·컴포넌트·CSS를 검증한다(`:3-86`). | Classic 단일 구현 계약으로 이름과 내용을 정리한다. |
| `gui/src/App.tsx` | Subagents 호출부가 아직 전역 `viewMode`를 전달한다: `<Subagents apiBase={API_BASE} viewMode={viewMode} />` (`:282`). | WP1에서는 유지. 호출 계약 제거는 WP5에서 한다. |

분기 조건은 정확히 다음과 같다(`gui/src/pages/Subagents.tsx:18,83`).

```tsx
const workspaceView = (viewMode ?? readViewMode()) === "workspace";

if (workspaceView) {
  // Workspace render
}
```

즉 `gui/src/pages/Subagents.tsx:83-99`가 Workspace 경로이고,
`gui/src/pages/Subagents.tsx:101-180`이 남길 Classic 경로다. `:1-81`의 fetch,
5개 제한, 순서 변경, PUT 저장 로직은 구현 선택과 무관한 공유 로직이므로 보존한다.

## 변경 계획

1. `gui/src/pages/Subagents.tsx:7-10,18,83-101` — Workspace 의존성과 분기를
   제거한다. `SubagentsWorkspace` import(`:8`), `readViewMode` 값 import(`:7`),
   `workspaceView` 계산(`:18`), Workspace 반환 블록(`:83-99`)을 삭제하고 Classic
   반환(`:101-180`)을 로딩 반환(`:81`) 바로 뒤의 유일한 반환으로 둔다.

   현재 형태:

   ```tsx
   import { readViewMode, type ViewMode } from "../view-mode";
   import SubagentsWorkspace from "../components/subagents-workspace/SubagentsWorkspace";

   export default function Subagents({ apiBase, viewMode }: { apiBase: string; viewMode?: ViewMode }) {
     const workspaceView = (viewMode ?? readViewMode()) === "workspace";
     // shared state and handlers
     if (loading) return /* ... */;
     if (workspaceView) return <SubagentsWorkspace /* ... */ />;
     return /* Classic */;
   }
   ```

   WP1 종료 형태:

   ```tsx
   import type { ViewMode } from "../view-mode";

   export default function Subagents({ apiBase }: { apiBase: string; viewMode?: ViewMode }) {
     // shared state and handlers
     if (loading) return /* ... */;
     return /* Classic */;
   }
   ```

   `viewMode` 필드를 props 타입에만 남기는 것은 의도적 과도기다.
   `gui/src/App.tsx:282`가 아직 그 prop을 넘기며, 전역 전달과 `ViewMode` 자체의
   철거는 WP5 소유다(`000_plan.md:220-229`). WP1에서 즉시 prop을 없애면
   `App.tsx`까지 수정해야 하므로 작업 경계를 넘는다. WP5에서는 최종적으로
   `Subagents({ apiBase }: { apiBase: string })`와
   `<Subagents apiBase={API_BASE} />`로 함께 축소한다.

2. `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:1-231` — 파일 전체를
   삭제한다. Classic에 없는 rail/detail UX(`:59-187`)를 옮기거나 재구현하지 않는다.
   Classic이 이미 선택, 5개 제한, 순서 변경, 제거, 저장을 제공한다
   (`gui/src/pages/Subagents.tsx:43-74,110-178`).

3. `gui/src/styles.css:18`과 `gui/src/styles-subagents-workspace.css:1-470` — import를
   먼저 제거하고 전용 스타일 파일을 삭제한다. 검색상 `.subagents-workspace-*`와
   `.swi-*` 소비자는 삭제 컴포넌트와 삭제 테스트뿐이므로 다른 화면으로 규칙을
   이식하지 않는다(`SubagentsWorkspace.tsx:60-227`,
   `subagents-workspace.test.ts:21-86`).

4. `gui/src/i18n/en.ts:437-446`, `ko.ts:431-440`, `ja.ts:402-411`,
   `de.ts:419-428`, `ru.ts:437-446`, `zh.ts:431-440` — 아래 10개
   `sub.workspace.*` 키를 6개 로케일에서 동시에 제거한다. 키별 `rg` 결과,
   `allModels`, `selector`, `priority`, `notFeatured`, `addToFeatured`,
   `removeFromFeatured`, `featuredFull`, `mainAria`의 런타임 사용은 삭제 대상
   `SubagentsWorkspace.tsx:103-181`에만 있다. `selectModel`과 `selectModelDesc`는
   6개 번역 정의 외 사용처가 이미 0건이다. 테스트의 문자열 검사는
   `gui/tests/subagents-workspace.test.ts:27-58`과 함께 제거된다.

5. `gui/tests/subagents-workspace.test.ts:1-86` — 파일을
   `gui/tests/subagents-classic.test.ts`로 이름 변경하고 아래 표대로 2개 Classic
   계약만 남긴다. 새 첫 테스트는 `Subagents.tsx`에
   `readViewMode`/`SubagentsWorkspace`/`workspaceView`가 없고 Classic의 subtitle,
   featured 목록, 모델 검색, 저장이 남는지 확인한다
   (`gui/src/pages/Subagents.tsx:57-79,101-178`). `App.tsx:282`의 prop 전달은
   WP5 전까지 허용하되, Workspace 렌더 경로가 생존하는 근거로 검사하지 않는다.
   새 둘째 테스트는 5개 상한(`Subagents.tsx:43-46,156`), 순서 이동(`:47-55`),
   PUT body(`:57-69`), 이동·제거 접근성 레이블(`:123-130`)을 Classic 계약으로
   고정한다.

## i18n 회수 목록

| 제거 키 | en | ko | ja | de | ru | zh |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `sub.workspace.allModels` | `en.ts:437` | `ko.ts:431` | `ja.ts:402` | `de.ts:419` | `ru.ts:437` | `zh.ts:431` |
| `sub.workspace.selector` | `en.ts:438` | `ko.ts:432` | `ja.ts:403` | `de.ts:420` | `ru.ts:438` | `zh.ts:432` |
| `sub.workspace.priority` | `en.ts:439` | `ko.ts:433` | `ja.ts:404` | `de.ts:421` | `ru.ts:439` | `zh.ts:433` |
| `sub.workspace.notFeatured` | `en.ts:440` | `ko.ts:434` | `ja.ts:405` | `de.ts:422` | `ru.ts:440` | `zh.ts:434` |
| `sub.workspace.addToFeatured` | `en.ts:441` | `ko.ts:435` | `ja.ts:406` | `de.ts:423` | `ru.ts:441` | `zh.ts:435` |
| `sub.workspace.removeFromFeatured` | `en.ts:442` | `ko.ts:436` | `ja.ts:407` | `de.ts:424` | `ru.ts:442` | `zh.ts:436` |
| `sub.workspace.featuredFull` | `en.ts:443` | `ko.ts:437` | `ja.ts:408` | `de.ts:425` | `ru.ts:443` | `zh.ts:437` |
| `sub.workspace.selectModel` | `en.ts:444` | `ko.ts:438` | `ja.ts:409` | `de.ts:426` | `ru.ts:444` | `zh.ts:438` |
| `sub.workspace.selectModelDesc` | `en.ts:445` | `ko.ts:439` | `ja.ts:410` | `de.ts:427` | `ru.ts:445` | `zh.ts:439` |
| `sub.workspace.mainAria` | `en.ts:446` | `ko.ts:440` | `ja.ts:411` | `de.ts:428` | `ru.ts:446` | `zh.ts:440` |

총 10키 × 6로케일 = 60개 항목이다. 이 표의 행 번호는 WP1 적용 전
`dev` 기준이다. 각 키를 개별 `rg -n --fixed-strings`로 확인했으며, 위에서 명시한
삭제 컴포넌트·삭제 테스트·번역 정의 외 사용처는 없다.

## 테스트 처리

| 현재 테스트 | 범위 | 결정 | 근거 |
| --- | --- | --- | --- |
| `Subagents uses global viewMode ... workspace shell` (`gui/tests/subagents-workspace.test.ts:3-19`) | 전역 모드 분기, Workspace import/CSS import | **Classic 계약으로 재작성** | 단일 구현 선택을 회귀 방지해야 한다. `readViewMode`, `workspaceView`, `SubagentsWorkspace`, Workspace CSS import가 모두 사라졌고 Classic 핵심 표면이 남았음을 검사한다. `App.tsx:282`의 과도기 prop은 WP5에서 별도로 제거한다. |
| `SubagentsWorkspace exposes featured rail + save actions` (`:21-36`) | rail, save, landmark, rail toggle a11y | **Classic 계약으로 재작성** | rail/landmark 계약은 폐기하되, 사용자 핵심 행위인 선택·5개 상한·이동·제거·저장과 `sub.moveUp`/`sub.moveDown`/`sub.removeAria` 레이블은 Classic에 그대로 존재한다(`Subagents.tsx:43-69,123-138,156-165`). |
| `Subagents detail shows exact public selector ...` (`:38-71`) | Workspace detail의 selector 표시와 provider 추론 금지 | **삭제** | Classic에는 detail 화면이 없고 모델명은 `modelLabel(m)`로 직접 표시한다(`Subagents.tsx:122,171`). 제거된 표면의 selector/detail 계약을 새 테스트로 가장하지 않는다. |
| `Subagents rail list reserves scrollbar gutter ...` (`:73-78`) | Workspace rail 전용 CSS | **삭제** | 대상 CSS 파일 전체가 삭제되며 Classic에는 rail이 없다(`styles-subagents-workspace.css:58-69`). |
| `Subagents workspace stacks via content-width ...` (`:80-86`) | Workspace container query와 mobile 전환 | **삭제** | 대상 shell·container query가 함께 삭제된다(`styles-subagents-workspace.css:11-18,433-470`). Classic 반응형 검증은 실제 렌더 QA로 수행한다. |

## 검증

아래 명령은 WP1 구현 직후 저장소 루트에서 순서대로 실행한다.

1. 제거 잔존물:

   ```bash
   rg -n 'SubagentsWorkspace|styles-subagents-workspace|subagents-workspace|swi-' gui/src gui/tests
   rg -n 'sub\.workspace\.' gui/src gui/tests
   test ! -e gui/src/components/subagents-workspace/SubagentsWorkspace.tsx
   test ! -e gui/src/styles-subagents-workspace.css
   ```

   첫 두 `rg`가 exit 1/출력 0건이고 두 `test`가 exit 0이면 Workspace 구현,
   전용 CSS, 60개 번역 키, 테스트 문자열까지 모두 회수된 것이다.

2. Classic 집중 계약:

   ```bash
   (cd gui && bun test tests/subagents-classic.test.ts)
   ```

   > 루트에서 `bun test gui/tests/...` 는 경로가 아니라 **필터**로 해석되어
   > 아무 파일도 매칭하지 않고 조용히 통과한다. `scripts/test.ts:38-41` 기본값은
   > `./tests/` 뿐이다. GUI 테스트는 반드시 `cd gui && bun test tests` 형태로 돌린다
   > (`gui/package.json:10`, `.github/workflows/ci.yml:75-76`).

   2 pass, 0 fail이면 단일 Classic 렌더와 선택·5개 상한·순서·저장 계약이
   정적 회귀 테스트를 통과한 것이다.

3. GUI와 전체 저장소 게이트:

   ```bash
   bun run typecheck
   bun run lint:gui
   bun run build:gui
   bun run test
   bun run privacy:scan
   git diff --check
   ```

   각 명령 exit 0, 테스트 0 fail, `git diff --check` 출력 0건이어야 한다.
   특히 build 성공은 6개 로케일 키 제거와 import 삭제 뒤 TypeScript/Vite 그래프가
   닫혔음을 증명한다.

4. 실제 렌더:

   ```bash
   bun run dev
   OPENCODEX_PROXY_TARGET=http://127.0.0.1:10199 bun run dev:gui
   agbrowse start --headless
   agbrowse navigate 'http://127.0.0.1:5173/#subagents'
   agbrowse wait 2000
   agbrowse resize 1280 720
   agbrowse snapshot --interactive --max-nodes 160
   agbrowse screenshot --full-page --json
   agbrowse resize 760 900
   agbrowse snapshot --interactive --max-nodes 160
   agbrowse screenshot --full-page --json
   agbrowse console --clear --reload --duration 3000
   agbrowse stop
   ```

   1280×720과 760×900 모두에서 Classic의 Featured 목록, 검색, 모델 목록, Save가
   보이고 rail/detail shell이 없어야 한다(`Subagents.tsx:101-178`). 스크린샷 JSON의
   산출물 경로를 열어 겹침·잘림·가로 넘침이 없음을 확인하고, console 결과에
   error/warning이 0건이어야 완료다. `bun run dev`와 proxy target을 지정한
   `bun run dev:gui`는 각각 별도 터미널에서 유지한다. 이 설정은 Vite가 `/api`와
   `/healthz`를 실제 proxy로 전달하게 한다(`gui/vite.config.ts:8-23`).

5. 변경 범위:

   ```bash
   git diff --name-status -- \
     gui/src/pages/Subagents.tsx \
     gui/src/components/subagents-workspace/SubagentsWorkspace.tsx \
     gui/src/styles-subagents-workspace.css \
     gui/src/styles.css \
     gui/src/i18n \
     gui/tests/subagents-workspace.test.ts \
     gui/tests/subagents-classic.test.ts
   ```

   출력은 위 계획의 수정·삭제·이름 변경만 포함해야 한다. `App.tsx` 또는 다른
   페이지가 나오면 WP1 범위 확장으로 보고 중단한다.

## 위험

- `viewMode` prop을 즉시 없애면 `gui/src/App.tsx:282` 호출과 타입 계약이 어긋난다.
  WP1에서는 props 타입에만 남기고 WP5에서 호출부와 함께 제거한다.
- `gui/src/styles.css:18` import를 남긴 채 CSS 파일만 삭제하면 Vite build가 실패한다.
  두 변경은 원자적으로 적용한다.
- 한 로케일이라도 `sub.workspace.*` 블록을 남기면 미사용 번역 부채가 남고, 한
  로케일만 먼저 지우면 번역 계약이 어긋날 수 있다. 6개 파일 60항목을 한 diff로
  회수한다.
- 현재 테스트 5개를 파일째 삭제만 하면 “Subagents는 Classic 하나뿐”이라는 결정이
  무보호 상태가 된다. 첫 두 테스트를 Classic 단일 구현/핵심 행위 계약으로 바꾼다.
- Classic은 Workspace CSS를 재사용하지 않는다. 삭제 뒤 레이아웃 차이는 의도된
  선택이지만, 좁은 폭에서의 잘림은 정적 검색으로 증명할 수 없으므로 760×900 실제
  렌더를 완료 게이트로 둔다.
- #441의 기능을 제거하는 diff 모양만 보고 revert로 오해할 수 있다. 커밋 메시지와
  완료 기록에는 “두 구현 중 Classic 선택”이라는 판단 근거를 그대로 남긴다
  (`000_plan.md:67-68`).
