# 050 — wp5: Remote Link GUI, i18n, docs-site, screenshots (L5)

상위 문서: devlog/_plan/260925_remote_home_child_link/000_prd.md,
001_stack_plan.md, 002_arch_plan.md, 010_wp1_link_core.md

브랜치: codex/remote-link-5-gui
레이어: L5, wp5
작업 성격: 이 문서가 GUI 구현 설계를 고정한다. 문서 작성에서는 production code를 변경하지 않는다.

## Design Read

- 표면: 반복 사용형 OpenCodex dashboard의 설정/연결 화면.
- 사용자: 허브 컴퓨터 운영자와 연결 전 standalone 클라이언트 운영자.
- 방향: 기존 dashboard token과 panel, page-head, btn, notice, 상태 색을 그대로 쓰는 조용하고 조밀한 연결 도구. 새 design system, 새 색상 체계, 새 폰트, 장식용 gradient를 추가하지 않는다.
- 목업 근거: 설계 검토용 목업 이미지(저장소 밖에 보관, 커밋하지 않음)를 확인했다. 화면은 ① 꺼짐 스위치와 흐린 preview, ② Home/Child 역할 선택, ③ Home에 연결된 자식 목록과 Add Child sheet의 세 단계다.
- 적용 범위: 목업의 구조와 상태 의미를 따르되 텍스트, 응답 데이터, 상태 색은 실제 API와 기존 토큰에 맞춘다.

DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5 (feature-rich dashboard)
Reasoning: SSH 연결과 인증 상태를 빠르게 스캔해야 하므로 정보 밀도는 유지하고 전환은 상태 피드백으로 제한한다.

아이콘은 기존 gui/src/icons.tsx의 IconMonitor, IconLink, IconPlus, IconRefresh, IconTrash, IconX 중 의미가 맞는 것을 재사용한다. 새 아이콘 패키지나 dependency는 추가하지 않는다. 모든 조작은 semantic button, visible focus, keyboard sheet close/confirm 경로를 가진다. 상태를 색만으로 구분하지 않고 텍스트와 aria-live="polite"를 함께 보여 준다.

## 범위

### IN

- #remote를 새 RemoteLink page의 route로 사용한다.
- 첫 화면을 off 상태의 grayscale switch와 흐린 preview로 만든다. 이 switch는 첫 링크 설정 UI를 여는 render-local control이며 서버의 임의 enable API를 만들지 않는다.
- Home / Child 역할 선택을 만든다. L5에서는 Home 시작 흐름을 구현하고, Child 선택은 L6의 standalone “find home” 작업으로 이어질 수 있는 선택 상태와 안내만 고정한다.
- Home 흐름에서 host 후보 조회, 수동 alias 입력, SSH probe, fingerprint 확인, 적용, 상태 polling, disconnect 확인을 구현한다.
- connected / reconnecting / failed 상태를 dot, label, 조치 버튼으로 표현한다.
- 기존 RemoteWorkspace를 #remote-workspace로 옮기고, GET /api/remote-workspace의 available === true일 때만 sidebar에 보인다.
- gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi}.ts에 새 visible key를 추가한다.
- English docs-site canonical guide와 Starlight sidebar entry를 추가한다.
- 구현 후 synthetic API fixture로 desktop/mobile screenshot을 만들고 PR body에 연결할 절차를 고정한다.

### OUT

- wp4가 소유하는 SSH 실행, tunnel supervisor, API route, key issuance/revocation, response schema 구현.
- wp6가 소유하는 Child의 실제 POST /api/link/join, client-owned ssh -L, standalone-only flow.
- 기존 Remote Workspace protocol, executor, pairing, session semantics 변경.
- 새 theme/token, external icon dependency, real two-machine E2E, Windows support.
- 화면에서 API key, private key, service token, raw secret을 표시하거나 복사하는 기능.
- PR screenshot을 feature branch나 repository의 docs/pr-assets/에 commit하는 것.

## 파일 변경 지도

| 경로 | 종류 | 내용 |
|---|---|---|
| gui/src/App.tsx | MODIFY | RemoteLink을 #remote에 mount하고 RemoteWorkspace를 #remote-workspace로 이동. 기존 workspace availability가 true일 때만 nav entry와 route를 노출. |
| gui/src/app-routing.ts | MODIFY | remote-workspace page id를 Page와 VALID_PAGES에 추가. #remote의 의미는 새 link 화면으로 유지. |
| gui/src/pages/RemoteLink.tsx | NEW | Home/Child 선택, add-child sheet, probe/fingerprint/apply/disconnect 흐름, polling과 상태 machine. |
| gui/src/styles-remote-link.css | NEW | 기존 --* token만 이용한 off preview, role cards, sheet, link rows, responsive rules. |
| gui/src/pages/RemoteWorkspace.tsx | READ ONLY | 기존 API/기능을 보존한다. route identity는 App/app-routing/i18n에서 해결하므로 이 파일은 변경하지 않는다. |
| gui/src/i18n/en.ts | MODIFY | TKey source of truth에 nav.remoteWorkspace와 link.* keys 추가, nav.remote label을 link 화면 의미로 변경. |
| gui/src/i18n/de.ts | MODIFY | English key set과 동일한 key를 독일어로 추가. |
| gui/src/i18n/fr.ts | MODIFY | English key set과 동일한 key를 프랑스어로 추가. |
| gui/src/i18n/ko.ts | MODIFY | English key set과 동일한 key를 한국어로 추가. 화면 용어는 “홈 / 자식 / 원격 연결”을 사용. |
| gui/src/i18n/zh.ts | MODIFY | English key set과 동일한 key를 간체 중국어로 추가. |
| gui/src/i18n/zh-TW.ts | MODIFY | English key set과 동일한 key를 번체 중국어로 추가. |
| gui/src/i18n/ru.ts | MODIFY | English key set과 동일한 key를 러시아어로 추가. |
| gui/src/i18n/ja.ts | MODIFY | English key set과 동일한 key를 일본어로 추가. |
| gui/src/i18n/tr.ts | MODIFY | English key set과 동일한 key를 터키어로 추가. |
| gui/src/i18n/vi.ts | MODIFY | English key set과 동일한 key를 베트남어로 추가. |
| gui/tests/remote-link.test.tsx | NEW | API fixture 기반 GUI flow와 조건부 상태의 focused tests. |
| gui/tests/remote-workspace.test.tsx | MODIFY | 기존 #remote route assertion을 #remote-workspace로 바꾸고 새 link route와 충돌하지 않음을 확인. |
| docs-site/astro.config.mjs | MODIFY | Guides sidebar에 guides/remote-link canonical entry와 기존 locale label을 추가. |
| docs-site/src/content/docs/guides/remote-link.md | NEW | GUI에서 SSH link를 설정하고 상태를 해제하는 canonical English guide. 기존 Remote Hub와 Remote Workspace 문서로 연결. |

structure/manifest.json, structure/INDEX.md, root tests/fixtures/test-layout-expected.json,
root scripts/test-layout/layout.json은 wp5가 변경하지 않는다. GUI source ownership은 기존
design-methodology.md의 gui/ entry로 이미 포괄되며, 새 backend invariant나 src/ path ownership을
만들지 않는다.

## 실제 source 근거와 변경 상세

아래 line은 현재 HEAD에서 읽은 근거다. 구현자는 각 MODIFY를 적용하기 전에 같은 line anchor가
drift했는지 확인한다.

### 1. gui/src/App.tsx — route, nav, mount

현재 gui/src/App.tsx:13:

    import RemoteWorkspace from "./pages/RemoteWorkspace";

현재 gui/src/App.tsx:34-46:

    const PAGE_TKEY: Record<Page, TKey> = {
      // ...
      remote: "nav.remote",
      "codex-set": "nav.codexSet",
      integrations: "nav.integrations",
    };

현재 gui/src/App.tsx:68-79:

    const NAV: NavEntry[] = [
      // ...
      { id: "remote", tkey: "nav.remote", Icon: IconMonitor },
      { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
    ];

현재 gui/src/App.tsx:517:

    {page === "remote" && <RemoteWorkspace apiBase={sharedBase} hubOrigin={targets.shared.serverOrigin} />}

적용 후 형태:

    import RemoteLink from "./pages/RemoteLink";
    import RemoteWorkspace from "./pages/RemoteWorkspace";

    // PAGE_TKEY
    remote: "nav.remote",
    "remote-workspace": "nav.remoteWorkspace",

    // NAV
    { id: "remote", tkey: "nav.remote", Icon: IconMonitor },
    { id: "remote-workspace", tkey: "nav.remoteWorkspace", Icon: IconMonitor },

    // render
    {page === "remote" && (
      <RemoteLink
        apiBase={sharedBase}
        sessionReady={targets.connected && sharedSessionReady}
      />
    )}
    {page === "remote-workspace" && remoteWorkspaceAvailable && (
      <RemoteWorkspace apiBase={sharedBase} hubOrigin={targets.shared.serverOrigin} />
    )}

정확한 적용 논리:

1. App 안에 기존 GET /api/remote-workspace response의 available만 읽는 availability resource를 둔다.
   gui/src/pages/RemoteWorkspace.tsx:45-51의 RemoteWorkspaceState.available과 같은 shape을 사용한다.
2. resource는 targets.connected && sharedSessionReady일 때만 시작하고, 30초 polling 또는 기존 app
   resource convention을 사용한다. session이 없으면 nav에서 workspace를 숨기고 workspace API를 호출하지 않는다.
3. NAV의 remote-workspace entry는 remoteWorkspaceAvailable === true일 때만 map한다. deep link가
   이미 #remote-workspace인데 unavailable이면 workspace component를 mount하지 않고
   link.workspaceUnavailable 안내와 Remote Link 이동 버튼을 보여 준다.
4. RemoteLink는 full dashboard session이 없으면 link.sessionRequired만 보여 주며 /api/link/*를
   호출하지 않는다. 이는 wp4의 “Full dashboard session only” 계약과 일치한다.
5. GUI는 status response의 `role`을 표시용으로만 읽는다. link를 켠다고 로컬 실행 모드를
   변경하거나 별도 frontend role enum을 만들지 않는다.

주의: PAGE_TKEY와 NAV가 module constant이므로 availability 자체를 constant에 넣지 말고 render 시 filter한다.

### 2. gui/src/app-routing.ts — page id

현재 gui/src/app-routing.ts:5-16:

    export type Page =
      | "dashboard"
      | "startup"
      | "providers"
      | "models"
      | "subagents"
      | "logs"
      | "usage"
      | "storage"
      | "remote"
      | "codex-set"
      | "integrations";

현재 gui/src/app-routing.ts:18-30의 VALID_PAGES에도 remote만 있다.

적용 후:

      | "remote"
      | "remote-workspace"
      | "codex-set"

그리고 VALID_PAGES에 같은 위치의 "remote-workspace"를 한 번 추가한다. readPageFromHash의 첫
segment 규칙은 유지하므로 새 parser나 redirect는 만들지 않는다. #remote는 새 link page,
#remote-workspace는 기존 workspace page다.

### 3. gui/src/pages/RemoteLink.tsx — 신규 page 계약

#### exported types와 view model

backend LinkRecord를 GUI가 src/에서 import하지 않는다. API response를 GUI boundary에서 검증하고
K16 status wire DTO를 그대로 소비한다. probe 결과와 UI state만 별도 view model로 좁힌다.

    export type RemoteLinkRole = "home" | "child";
    export type RemoteLinkUiState =
      | "off"
      | "role-select"
      | "adding-child"
      | "confirming-host"
      | "applying"
      | "connected"
      | "reconnecting"
      | "failed";

    export type LinkWireDirection = "hub-initiated" | "client-initiated";
    export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
    export type LinkListenerState = "off" | "listening" | "failed";

    export interface LinkCandidateView {
      alias: string;
      source: string;
    }

    export interface LinkProbeView {
      alias: string;
      fingerprint: string;
      keyType: string;
    }

    export interface LinkConfirmHostView {
      alias: string;
      fingerprint: string;
      ocxVersion: string;
    }

    export interface LinkRowWire {
      id: string;
      alias: string;
      direction: LinkWireDirection;
      state: LinkWireState;
      since: string;
      reason: string | null;
      tunnelPort: number;
    }

    export interface RemoteLinkStatusWire {
      role: "standalone" | "home" | "child";
      listener: { state: LinkListenerState; port: number | null };
      links: LinkRowWire[];
      child: null | { alias: string; state: string; since: string; reason: string | null };
    }

#### component signature

    export interface RemoteLinkProps {
      apiBase: string;
      sessionReady: boolean;
    }
    export default function RemoteLink(props: RemoteLinkProps): JSX.Element;

`RemoteLinkStatusWire`는 `003_decisions.md:22`의 K16 DTO를 그대로 소비한다. 즉
`role`, `listener`, `links[]`의 `id`, `alias`, `direction`, `state`, `since`, `reason`,
`tunnelPort`, 그리고 `child`만 status wire contract에 둔다. `hub`/`client` 값, `links[]`의
`status`, `hostKeyFingerprint`, `ocxVersion`은 status DTO에 추가하지 않는다.
GUI boundary parser는 이 shape와 허용된 enum을 검증하고, 서버가 보내지 않은 값을 추정하지 않는다.

#### wire role → UI label mapping

`role`은 wire 값이고, 표의 값은 해당 locale에서 렌더링할 label이다. `standalone`도 항상
표시 가능한 label을 가지며, Home/Child는 K16의 `home`/`child`를 가리킨다. locale 파일은
현재 `gui/src/i18n/shared.ts:6-17`의 열 개(`en`, `de`, `fr`, `ko`, `zh`, `zh-TW`, `ru`,
`ja`, `tr`, `vi`)를 모두 유지한다.

| wire role | en | de | fr | ko | zh | zh-TW | ru | ja | tr | vi |
|---|---|---|---|---|---|---|---|---|---|---|
| `standalone` | Standalone | Eigenständig | Autonome | 독립형 | 独立 | 獨立 | Автономный | スタンドアロン | Bağımsız | Độc lập |
| `home` | Home | Zuhause | Accueil | 홈 | 主机 | 主機 | Главный | ホーム | Ana | Máy chủ |
| `child` | Child | Kind | Enfant | 자식 | 子设备 | 子裝置 | Дочерний | 子 | Çocuk | Máy con |

#### wire state → status dot mapping

`links[].state`의 dot은 텍스트 label과 함께 렌더링하고 `aria-live="polite"`로 상태 변화를
알린다. 색상은 기존 `gui/src/styles-remote-workspace.css:26-27,46-50`의 토큰을 재사용한다.

| wire state | status dot | 의미 |
|---|---|---|
| `connecting` | amber (`--amber`) | 연결 시도 중 |
| `connected` | green (`--green`) | 연결됨 |
| `reconnecting` | amber (`--amber`) | 재연결 중 |
| `failed` | red (`--red`) | 조치 필요 |
| `idle` | muted (`--faint`) | 유휴 |

`listener.state`는 `off`→muted, `listening`→green, `failed`→red로 표시한다. `child`의
`state`는 K16 필드로 보존하며, link state와 일치할 때만 위 link dot mapping을 적용한다.

#### component layout

- RemoteLinkPage: page head, session gate, off switch, role selection, connected summary.
- RemoteLinkPreview: off state에서 blurred panel preview를 aria-hidden으로 보여 주고 실제 조작 대상은 switch 하나로 제한한다.
- RemoteLinkRolePicker: Home과 Child 두 semantic radio-like button. Home이 default selected이며 primary button은 Continue 하나다.
- AddChildSheet: candidates list, manual alias input, probe action, fingerprint confirmation section, apply action. sheet는 Escape와 close button으로 닫고 focus를 반환한다.
- LinkList: link record마다 alias, direction, state text/dot, disconnect button.
- LinkStatusMessage: connected/reconnecting/failed를 text와 live region으로 함께 표현한다.

#### state machine

    session-gated
      -> off
    off + switch on -> role-select
    role-select + Home/Continue -> adding-child
    role-select + Child/Continue -> child-pending (L6 handoff copy; no L5 mutation)
    adding-child + candidate/manual alias -> adding-child
    adding-child + probe success -> confirming-host
    adding-child + probe error -> adding-child + error
    confirming-host + cancel -> adding-child
    confirming-host + confirm-host success -> adding-child + confirmed candidate
    confirmed candidate + apply -> applying
    applying + status connected -> connected
    applying + request/timeout error -> failed
    connected + polling reconnecting -> reconnecting
    reconnecting + five-minute/auth/hostkey failure -> failed
    connected/reconnecting/failed + disconnect confirm + DELETE success -> connected or off

Disconnect 후 link가 하나도 없으면 off preview로 돌아간다. 다른 link가 남으면 list를 유지한다.
failed 상태에서는 retry가 같은 alias의 probe부터 재시작하며, silent local provider fallback을 하지 않는다.

#### API 호출과 정확한 순서

모든 호출은 apiBase + path와 { cache: "no-store" }를 사용하고 readJsonOrThrow로 status를
확인한다. 이는 현재 gui/src/pages/RemoteWorkspace.tsx:87-97의 resource pattern과
gui/src/fetch-json.ts:28-43의 error boundary를 따른다.

| UI action | method/path | body | 성공 후 |
|---|---|---|---|
| page status | GET /api/link/status | 없음 | `RemoteLinkStatusWire`의 K16 shape 검증, role/listener/links/child 반영 |
| sheet open | GET /api/link/candidates | 없음 | LinkCandidateView[] 표시 |
| candidate/manual alias probe | POST /api/link/probe | { alias } | 응답 { alias, fingerprint, keyType }을 confirmation view에 고정. ocxVersion은 사용자가 지문을 확인한 뒤 POST /api/link/confirm-host 응답 { alias, fingerprint, ocxVersion }에서만 받아 표시 |
| fingerprint confirm | POST /api/link/confirm-host | { alias, fingerprint } | 확인된 alias를 apply 단계로 전환 |
| apply | POST /api/link/apply | { alias } | 즉시 status polling; 성공 toast와 connected row |
| disconnect | DELETE /api/link/{id} | 없음 | status 재조회; 204/JSON (무효: 감사 반영 Averroes 절 참조) 양쪽의 성공 envelope을 허용 |

확인 전에는 apply를 호출하지 않는다. probe 오류, malformed JSON, 401/403, 409, 5xx는 모두
localized error와 retry path로 매핑한다. HTTP error message를 logic discriminator로 사용하지 않는다.

### 4. gui/src/styles-remote-link.css — 신규 style contract

새 값은 만들지 않고 기존 gui/src/styles-remote-workspace.css:1-75에 보이는
--text-*, --radius-*, --border*, --raised*, --accent*, --green, --amber, --red를 사용한다.

필수 selector와 동작:

    .remote-link-page
    .remote-link-off-preview
    .remote-link-switch
    .remote-link-role-grid
    .remote-link-role-card
    .remote-link-status
    .remote-link-status--connected
    .remote-link-status--reconnecting
    .remote-link-status--failed
    .remote-link-children
    .remote-link-child-row
    .remote-link-sheet
    .remote-link-sheet-backdrop
    .remote-link-fingerprint
    .remote-link-error

- off preview는 filter: blur(...)를 실제 content state에 적용하지 않고 preview layer에만 적용한다. switch와 heading은 선명하게 유지한다.
- 상태 색은 기존 green/amber/red만 쓰고 각 row에 label을 함께 렌더링한다.
- sheet는 desktop에서 오른쪽 panel, 좁은 화면에서 bottom sheet로 전환한다. max-width: 620px에서 한 열로 바꾸고 touch target은 기존 44px 기준을 지킨다.
- perpetual animation은 없다. prefers-reduced-motion: reduce에서는 모든 transition을 제거한다.
- @import는 RemoteLink.tsx에서 한 번만 수행하며 global styles.css token을 복제하지 않는다.

신규 stylesheet가 250 lines 이하로 유지되면 아래가 적용 가능한 전체 초안이다. selector 외의
새 token은 넣지 않는다.

    .remote-link-page { display: grid; gap: 14px; }
    .remote-link-off-preview { position: relative; overflow: hidden; min-height: 300px; }
    .remote-link-off-preview::after { content: ""; position: absolute; inset: 0; backdrop-filter: blur(7px); pointer-events: none; }
    .remote-link-switch { min-width: 56px; min-height: 32px; border: 0; border-radius: var(--radius-pill); background: var(--faint); color: var(--bg); }
    .remote-link-switch[aria-checked="true"] { background: var(--text); }
    .remote-link-role-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .remote-link-role-card { min-height: 150px; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--raised); text-align: left; }
    .remote-link-role-card[aria-pressed="true"] { border-color: var(--text); box-shadow: 0 0 0 1px var(--text); }
    .remote-link-role-card:focus-visible, .remote-link-switch:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 2px; }
    .remote-link-status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: var(--text-caption); }
    .remote-link-status::before { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); content: ""; }
    .remote-link-status--connected::before { background: var(--green); }
    .remote-link-status--reconnecting::before { background: var(--amber); }
    .remote-link-status--failed::before { background: var(--red); }
    .remote-link-children { display: grid; gap: 7px; }
    .remote-link-child-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 10px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--raised); }
    .remote-link-sheet-backdrop { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, var(--text) 18%, transparent); }
    .remote-link-sheet { position: fixed; z-index: 21; top: 0; right: 0; bottom: 0; width: min(430px, 100vw); padding: 20px; overflow: auto; border-left: 1px solid var(--border); background: var(--bg); box-shadow: -12px 0 32px color-mix(in srgb, var(--text) 12%, transparent); }
    .remote-link-fingerprint { padding: 10px; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--raised); font-family: var(--font-code); }
    .remote-link-error { color: var(--red); }
    @media (max-width: 620px) {
      .remote-link-role-grid { grid-template-columns: 1fr; }
      .remote-link-sheet { top: auto; width: 100%; max-height: 88dvh; border-top: 1px solid var(--border); border-left: 0; border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .remote-link-page *, .remote-link-page *::before, .remote-link-page *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }

### 5. gui/src/pages/RemoteWorkspace.tsx — 보존 근거

현재 component는 gui/src/pages/RemoteWorkspace.tsx:87-97에서 /api/remote-workspace를 읽고,
available === false일 때 remote.hubRequired를 표시한다. 기능 자체를 바꾸지 않는다.

before/after production snippet은 없다. page identity는 App/app-routing/i18n에서 해결하며, 이
파일을 불필요하게 고치지 않는 것이 기존 workspace behavior 보존 조건이다.

### 6. i18n catalog 변경

현재 gui/src/i18n/catalogs.ts:1-35가 en을 TKey source로 사용하고 10개 locale을 DICTS에 등록한다.
현재 nav.remote와 workspace copy는 gui/src/i18n/en.ts:3168-3215 및 각 locale의 같은 namespace에 있다.
현재 nav.remote anchors는 de.ts:3134, fr.ts:3123, ko.ts:3156, zh.ts:3155, zh-TW.ts:3120,
ru.ts:3157, ja.ts:3156, tr.ts:3157, vi.ts:3092이며, 각 파일의 다음 remote namespace가 workspace
copy를 소유한다. 새 key를 같은 catalog block에 추가하고 locale parity test가 key set을 검사한다.

English source block:

    "nav.remote": "Remote Link",
    "nav.remoteWorkspace": "Remote Workspace",
    "link.title": "Remote Link",
    "link.subtitle": "Connect another OpenCodex computer over SSH.",
    "link.switch": "Remote linking",
    "link.switchOn": "Set up a connection",
    "link.role.title": "Choose this computer's role",
    "link.role.home": "Home",
    "link.role.homeHint": "Manage child computers from this dashboard.",
    "link.role.child": "Child",
    "link.role.childHint": "Use another computer's OpenCodex setup.",
    "link.continue": "Continue",
    "link.sessionRequired": "Sign in to the local dashboard session to manage links.",
    "link.loading": "Loading remote links…",
    "link.loadFailed": "Could not load remote link status.",
    "link.refresh": "Refresh",
    "link.children": "Child computers",
    "link.addChild": "Add child",
    "link.sheetTitle": "Add a child computer",
    "link.candidates": "SSH hosts",
    "link.noCandidates": "No SSH host candidates were found.",
    "link.manualAdd": "Add manually",
    "link.alias": "SSH host alias",
    "link.aliasPlaceholder": "Enter an alias from your SSH config",
    "link.probe": "Test connection",
    "link.probing": "Testing connection…",
    "link.hostFingerprint": "Host key fingerprint",
    "link.ocxVersion": "OpenCodex version {version}",
    "link.confirmFingerprint": "I recognize this host key",
    "link.apply": "Connect child",
    "link.applying": "Connecting…",
    "link.connected": "Connected",
    "link.reconnecting": "Reconnecting",
    "link.failed": "Connection needs attention",
    "link.retry": "Retry",
    "link.disconnect": "Disconnect",
    "link.disconnectConfirm": "Disconnect {alias}? Its link key will be revoked.",
    "link.close": "Close",
    "link.cancel": "Cancel",
    "link.error.probe": "The SSH connection test failed.",
    "link.error.confirm": "The host key could not be confirmed.",
    "link.error.apply": "The child could not be connected.",
    "link.error.disconnect": "The child could not be disconnected.",
    "link.workspaceUnavailable": "Remote Workspace is unavailable on this installation.",
    "link.childPending": "Child setup is available in the client-started flow.",
    "link.status.aria": "Remote link status",

위 block을 de.ts, fr.ts, ko.ts, zh.ts, zh-TW.ts, ru.ts, ja.ts, tr.ts, vi.ts에 같은 key로 번역한다.
link.* namespace에는 visible English fallback을 남기지 않는다. 한국어는 “홈”, “자식”, “원격 연결”,
“호스트 키 지문”으로 통일한다. ocxVersion의 version 값과 alias/fingerprint는 변수/기술 값이므로
번역하지 않는다.

### 7. gui/tests/remote-workspace.test.tsx

현재 gui/tests/remote-workspace.test.tsx:11-13:

    test("#remote resolves to the Remote Workspace page", () => {
      expect(readPageFromHash("#remote")).toBe("remote");
    });

적용 후:

    test("#remote is the Remote Link page and the old workspace has its own route", () => {
      expect(readPageFromHash("#remote")).toBe("remote");
      expect(readPageFromHash("#remote-workspace")).toBe("remote-workspace");
    });

나머지 Remote Workspace behavior fixture는 endpoint와 component를 유지한다.

### 8. docs-site/src/content/docs/guides/remote-link.md — 신규 문서 전체 초안

250 lines 이하의 canonical English page는 다음 내용으로 생성한다. 실제 response field가 wp4에서
확정되면 이 문서의 field wording만 그 계약에 맞춰 갱신한다.

    ---
    title: Remote Link
    description: Connect OpenCodex computers over SSH from the dashboard.
    ---

    Remote Link connects OpenCodex computers over SSH while keeping the normal local dashboard and
    Codex endpoint on each computer. The Home computer manages Child links; the Child computer keeps
    its own local dashboard in read-only link mode after it connects.

    ## Requirements

    The v1 flow supports macOS and Linux, system OpenSSH, key or agent authentication, and a full
    local dashboard session on the Home computer. Password SSH, Windows clients, automatic OCX
    installation, and public HTTPS link setup are outside this flow.

    ## Add a Child from the Home dashboard

    1. Open the dashboard and select **Remote**.
    2. Turn on **Remote linking**, choose **Home**, and select **Continue**.
    3. Select an SSH host from the candidates or enter an alias from your SSH config.
    4. Select **Test connection**. OpenCodex runs the probe and shows the offered host key fingerprint.
    5. Compare the fingerprint with the host you intend to use, then confirm it.
    6. Select **Connect child**. The Home dashboard shows the tunnel as **Connected** when the
       supervisor has established the link.

    The dashboard never asks for or displays the data key. The SSH probe must complete before the
    fingerprint can be confirmed. A host key is not accepted by this screen without the explicit
    confirmation step.

    ## Status and recovery

    **Connected** means the tunnel is ready. **Reconnecting** means requests may return 503 with
    Retry-After while the supervisor retries. **Connection needs attention** means an authentication,
    host-key, forwarding, or timeout condition requires the operator to retry or repair the host.
    OpenCodex does not silently use a local provider in place of a failed link.

    Select **Disconnect** on the Home dashboard to stop the tunnel, revoke the link key, and remove
    the saved link record. Confirm the alias before the destructive action.

    ## Child-started flow

    The Child role is shown in the dashboard role picker. The standalone Child flow is delivered in
    the client-started layer and uses a client-owned local forward. Until that layer is available,
    choose Home for the dashboard-managed flow or use the documented CLI surface.

    ## Existing features

    Remote Link is separate from [Remote Hub Deployment](/guides/remote-hub/) and
    [Remote Workspace](/guides/remote-workspace/). Remote Workspace remains an opt-in executor
    feature and appears in the dashboard navigation only when its availability check succeeds.

### 9. locale file-size 근거

현재 모든 locale은 tests/fixtures/file-size-baseline.json:2-13의 exempt에 있다. 따라서 line cap
headroom을 계산하지 않고, locale parity와 bun run lint:i18n을 gate로 삼는다.

## 필드 체인

### PLAN-FIELD-CHAIN-01: RemoteLinkStatusWire

- 생성: wp4 GET /api/link/status가 K16의 `role`, `listener`, `links[]`, `child`를 생성한다.
- serialization: wp4 route가 K16 필드만 JSON response에 넣는다. GUI가 server field를 생성하거나
  별도 role 이름으로 변환하지 않는다.
- deserialization/validation: RemoteLink.tsx parser가 `role`, listener의 `state`/`port`,
  links의 `id`, `alias`, `direction`, `state`, `since`, `reason`, `tunnelPort`, child의
  `alias`/`state`/`since`/`reason`을 확인하고 모르는 role/state는 load error로 보낸다.
- consumers: role label, LinkList의 state dot/label, RemoteLinkUiState 전환, retry/disconnect
  button disabled state, aria-live status message, screenshot fixtures.
- 실패 의미: 필드가 없거나 허용되지 않은 값이면 connected로 추정하지 않고 load error로 유지한다.

### PLAN-FIELD-CHAIN-02: RemoteLinkProbeView.fingerprint

- 생성: wp4 POST /api/link/probe가 ssh-keygen -lf 결과를 fingerprint로 반환한다.
- serialization: probe JSON { alias, fingerprint, keyType }; confirm-host JSON { alias, fingerprint, ocxVersion }.
- deserialization/validation: probe는 non-empty fingerprint·keyType, confirm-host는 같은 fingerprint와 non-empty ocxVersion을 확인한다.
- consumers: confirmation sheet text, POST /api/link/confirm-host body, apply eligibility, screenshot fixture.
- 실패 의미: fingerprint가 없으면 confirmation/apply button을 disabled로 두고 probe error를 보여 준다.

### PLAN-FIELD-CHAIN-03: RemoteWorkspaceState.available

- 생성: 기존 GET /api/remote-workspace가 생성하며 현재 DTO가 이미 available을 선언한다
  (gui/src/pages/RemoteWorkspace.tsx:45-51).
- serialization/deserialization: 기존 endpoint와 기존 component parser를 그대로 사용한다.
- consumers: App sidebar filtering, #remote-workspace deep-link guard, existing workspace page empty/error copy.
- 변경: 새 backend field 없음.

## 테스트 사례

각 테스트는 gui/tests/remote-link.test.tsx의 happy-dom + fetch fixture에서 synthetic responses를
사용한다. SSH를 실제로 실행하지 않으며, response JSON은 wp4 contract fixtures와 같은 envelope을 사용한다.

| activation scenario | 테스트 | observable evidence |
|---|---|---|
| full session 없음 | sessionReady=false mount | link.sessionRequired가 보이고 /api/link/status 호출 수가 0 |
| disconnected/off | status에 links=[] | switch와 blurred preview가 보이고 add sheet가 아직 mount되지 않음 |
| Home 선택 | role select에서 Home + Continue | link.children, link.addChild가 보이고 Child flow API는 호출되지 않음 |
| Child 선택 | Child + Continue | link.childPending이 보이고 /api/link/join 호출 수가 0; L6 handoff contract 보호 |
| candidates 성공 | sheet open + GET candidates | candidate aliases가 렌더되고 manual alias input도 존재 |
| candidates empty | GET candidates=[] | empty copy와 manual add 경로가 함께 보임 |
| manual alias | alias 입력 + probe | POST body가 정확히 { alias }이고 button은 probe 완료 전 apply 불가 |
| probe 성공 | { alias, fingerprint, keyType } | fingerprint confirmation이 보이고 raw key/token과 ocxVersion은 아직 보이지 않음 |
| confirm-host 성공 | { alias, fingerprint, ocxVersion } | ocxVersion이 표시되고 apply 버튼이 활성화됨 |
| probe 실패/401/403/5xx | non-2xx 또는 malformed body | localized probe error, retry 가능, confirm/apply 호출 0 |
| fingerprint cancel | confirmation에서 cancel | sheet가 alias step으로 돌아가고 confirm-host/apply 호출 0 |
| confirm-host 성공 | checkbox + confirm | POST body가 { alias, fingerprint }; apply 전 confirmed view 유지 |
| confirm-host 실패 | non-2xx | localized confirm error, apply disabled |
| apply 성공 | apply 201/200 (무효: 감사 반영 Averroes 절 참조) 후 status connected | POST { alias }, polling 결과 connected dot/label과 row 생성 |
| apply timeout/failure | request reject 또는 failed status | failed label, retry visible, silent fallback 없음 |
| reconnecting | `links[].state = "reconnecting"` | amber label/live region, request action remains disabled or retry-only |
| reconnecting → connected | next poll connected | green label and connected row |
| reconnecting → failed | next poll failed | red label and actionable retry |
| disconnect confirm cancel | confirm dialog negative | DELETE 호출 0, row 유지 |
| disconnect success | confirm + DELETE 204/JSON (무효: 감사 반영 Averroes 절 참조) | DELETE /api/link/{id}, row 제거, last row면 off state |
| disconnect failure | DELETE non-2xx | error notice, row/status 유지 |
| workspace unavailable | App availability false + #remote-workspace | nav entry와 component가 없고 localized unavailable copy만 표시 |
| workspace available | App availability true | #remote-workspace nav row와 existing component가 표시 |
| locale parity | all ten locale modules | every new TKey exists; no hardcoded visible JSX copy |
| keyboard/a11y | Tab, Enter, Escape, focus return | sheet closes with Escape, focus returns to Add Child, buttons have accessible names, status has live label |
| responsive | 1440x900 and 390x844 | no horizontal overflow; sheet becomes bottom sheet; primary action remains visible |

## 검증 명령 표

이 문서 작성에서 실제로 실행한 명령과 대상은 아래와 같다. RemoteLink.tsx, docs page, locale 변경은
아직 존재하지 않으므로 구현 전 NEW file check를 성공으로 기록하지 않는다.

| 명령 | exit code | change target read 여부 | 증거 |
|---|---:|---|---|
| wc -l devlog/_plan/260925_remote_home_child_link/{000_prd,001_stack_plan,002_arch_plan,010_wp1_link_core}.md AGENTS.md | 0 | 대상 문서 아님 | 필수 reference line 수를 확인했다. |
| find gui docs-site -name AGENTS.md -print 및 두 파일 cat | 0 | 대상 문서 아님 | gui/AGENTS.md, docs-site/AGENTS.md를 읽었다. |
| test -f gui/src/App.tsx && test -f gui/src/app-routing.ts && test -f gui/src/pages/RemoteWorkspace.tsx && test -f gui/src/i18n/en.ts && test -f gui/tests/remote-workspace.test.tsx && test -f docs-site/astro.config.mjs | 0 | 예정 MODIFY source를 읽음 | 모든 현재 source path가 존재했다. |
| 목업 이미지 존재 확인(저장소 밖 경로) | 0 | mockup만 읽음 | 지정 목업을 view_image로 확인했다. |
| rg -n 'remote-workspace|guides/remote-hub|guides/remote-workspace' gui/src docs-site/src docs-site/astro.config.mjs | 0 | 현재 source를 읽음 | 기존 route/component/docs/sidebar 근거를 확인했다. |
| test -f devlog/_plan/260925_remote_home_child_link/050_wp5_remote_gui.md | 0 | 이 change target을 읽음 | 이 문서가 생성된 뒤 존재함을 확인한다. |
| bun run privacy:scan | 실행 후 기록 | 이 문서와 devlog를 읽음 | docs-only 변경에서 privacy gate를 통과해야 한다. |
| bun run structure:check | 실행 후 기록 | structure와 manifest를 읽음 | structure ownership 변경 없음과 문서 map 일관성을 확인한다. |

구현 PR에서 별도로 실행할 명령은 cd gui && bun run lint:i18n, bun test tests/remote-link.test.tsx
tests/remote-workspace.test.tsx, cd gui && bun run build, cd docs-site && bun run build다. 이 문서
작성 단계에서는 production code가 없어 실행하지 않는다. full test suite는 실행하지 않는다.

## 우회 경로 기록

| enforcement | tier | surface | bypass | residual risk |
|---|---|---|---|---|
| management mutation requires full dashboard session | E-UI + E-server | /api/link/probe, confirm-host, apply, DELETE | 로컬 사용자가 정상 dashboard session을 직접 만들거나 CLI ocx link issue를 사용할 수 있다 | local user authority는 browser/agent를 기술적으로 구별할 수 없다. wp4의 server-side session/CSRF gate가 최종 경계다. |
| host-key confirmation | E-SSH + E-UI | probe → fingerprint confirmation | 사용자가 OS known_hosts에 직접 키를 넣으면 probe가 이미 신뢰된 host를 보여 줄 수 있다 | 의도된 OpenSSH 동작이며, GUI는 fingerprint를 숨기거나 자동 승인하지 않는다. |
| link ingress excludes dashboard/API | E-server | tunnel data plane | 허브 로컬 process는 기본 loopback listener를 직접 호출할 수 있다 | 기존 loopback trust와 같은 residual risk이며 link listener가 그 trust를 자식에게 넓히지 않는다. |
| client role deferred to L6 | E-UI | Child choice in L5 | 사용자는 CLI/manual flow로 연결할 수 있다 | L5가 /api/link/join을 호출하지 않아 L6 contract와 중복되지 않는다. |
| screenshot synthetic fixture | E-QA | PR visual evidence | real two-machine live screenshot 대신 fixture screenshot | visual layout proof는 되지만 SSH/tunnel correctness proof가 아니다. L4/integration evidence와 분리한다. |

## File-size ratchet headroom

tests/fixtures/file-size-baseline.json:2-13에서 locale 10개는 모두 exempt다. 아래 파일들은 baseline의
files map에 없으므로 현재 cap이 없으며, 새 파일은 최초 ratchet baseline이 생성될 때 실제 line count가 cap이 된다.

| 파일 | 상태 | 현재 baseline/headroom |
|---|---|---|
| gui/src/App.tsx | MODIFY | baseline entry 없음; cap N/A. 변경량은 route gate만큼으로 제한 |
| gui/src/app-routing.ts | MODIFY | baseline entry 없음; cap N/A |
| gui/src/pages/RemoteWorkspace.tsx | conditional MODIFY | baseline entry 없음; no-op이면 미변경 |
| gui/src/i18n/{10 locale}.ts | MODIFY | exempt; numeric headroom N/A, parity/lint gate 적용 |
| gui/src/pages/RemoteLink.tsx | NEW | baseline entry 없음; target <= 250 lines if kept monolithic, otherwise split before implementation |
| gui/src/styles-remote-link.css | NEW | baseline entry 없음; token-only stylesheet |
| gui/tests/remote-link.test.tsx | NEW | root baseline entry 없음; focused test file |
| gui/tests/remote-workspace.test.tsx | MODIFY | baseline entry 없음; one route assertion change |
| docs-site/astro.config.mjs | MODIFY | baseline entry 없음; one sidebar item |
| docs-site/src/content/docs/guides/remote-link.md | NEW | baseline entry 없음; concise canonical guide |

gui/src/styles.css는 baseline 2958 line cap(tests/fixtures/file-size-baseline.json:19-20)에 있으므로 변경하지
않는다. gui/src/pages/Models.tsx cap 2792도 건드리지 않는다.

## Test layout registration

새 GUI tests는 기존 gui/tests runner/domain에 둔다. root tests/fixtures/test-layout-expected.json와
scripts/test-layout/layout.json은 root tests/ domain map을 위한 것이며 gui/tests/remote-link.test.tsx는
그 map의 대상이 아니다. 따라서 wp5에는 두 JSON registration entry를 추가하지 않는다.

기존 root test를 새로 만들거나 tests/gui/로 옮기는 구현으로 바뀌면 아래 두 곳에 같은 entry를 추가하고
layout checker를 실행한다.

    // scripts/test-layout/layout.json -> explicit
    "remote-link.test.tsx": "gui"

    // tests/fixtures/test-layout-expected.json
    "remote-link.test.tsx": "gui"

현재 계획은 gui/tests 경로를 유지하므로 위 snippet은 contingency only다.

## structure / docs updates

- structure/manifest.json: 변경 없음. GUI path는 기존 design-methodology.md documents gui/ owner에 이미 포함된다(structure/manifest.json:465-471). 새 src/ ownership이나 invariant가 없다.
- structure/INDEX.md: 변경 없음.
- docs-site/astro.config.mjs:74-92: Guides sidebar에 guides/remote-link를 추가하고 기존 8개 docs locale label을 채운다. English canonical page는 root에 둔다.
- docs-site/src/content/docs/guides/remote-link.md: GUI Home flow, candidate/probe/fingerprint/apply/disconnect, status meanings, Child flow가 L6임을 설명한다. API key와 host private key를 UI에 입력하거나 문서에 출력하지 않는다.
- 기존 remote-hub.md와 remote-workspace.md는 각각 기존 manual hub/client flow와 workspace feature의 source of truth다. 새 guide는 둘을 대체하지 않고 링크한다. 구현 중 claims가 겹치면 current source code와 wp4 response schema를 확인해 필요한 최소 cross-link만 추가한다.

## Screenshot capture procedure

이 PR은 gui/를 변경하므로 repository policy상 PR body screenshot이 필수다
(tests/ci-workflows/docs-gui-screenshot-policy.test.ts:4-27, .github/PULL_REQUEST_TEMPLATE.md:8).
screenshot은 feature branch에 commit하지 않는다.

1. cd gui && bun run build를 실행한다.
2. build output을 기존 repo browser harness로 정적 serve한다. Playwright가 이미 repo에 있으면 그
   runner를 사용하고, 아니면 agbrowse의 기존 local-page/screenshot 경로를 사용한다. 새 browser dependency를 설치하지 않는다.
3. browser context에서 dashboard session HTML과 API를 synthetic fixture로 intercept한다. GET /api/link/status,
   GET /api/link/candidates, POST /api/link/probe, POST /api/link/confirm-host, POST /api/link/apply,
   DELETE /api/link/{id}, GET /api/remote-workspace를 deterministic response로 제공한다. 실제 SSH,
   key, token은 사용하지 않는다.
4. #remote에서 1440x900으로 off state, role selection, fingerprint confirmation, connected list 중
   최소 하나를 캡처한다. 390x844에서는 add-child sheet가 bottom sheet로 접히고 primary action이
   보이는지 캡처한다.
5. screenshot을 view_image로 직접 읽고, text fit, focus-visible state, dot label, no horizontal overflow,
   blurred preview 범위를 확인한다. layout 문제가 있으면 구현과 capture를 반복한다.
6. 결과 파일은 임시 경로 또는 PR asset upload flow에 둔다. maintainer가 CLI upload를 할 때는
   pr-assets branch에 별도 commit하고 그 commit SHA URL을 PR body에 넣는다. 일반 contributor는 이미지를
   PR description에 drag/drop한다.
7. PR body Summary/Verification에 “synthetic fixture screenshot; no live SSH/two-machine proof”를
   명시한다. screenshot은 UI 렌더 증거이며 L4/L5 integration proof로 과장하지 않는다.

권장 PR body image labels: remote-link-off-and-role.png, remote-link-fingerprint-sheet-mobile.png.

## PR title/body notes

제목: feat(gui): add SSH remote link dashboard

Summary에는 다음을 쓴다.

- #remote가 Home/Child 역할 선택과 Home의 SSH child linking flow를 제공한다.
- RemoteWorkspace는 #remote-workspace로 분리되고 availability가 있을 때만 nav에 보인다.
- ten locale catalogs와 canonical Remote Link guide를 추가한다.
- PR body에 synthetic API fixture screenshot을 첨부한다.

Verification에는 focused GUI test, bun run lint:i18n, cd gui && bun run build, docs-site build, 그리고
screenshot viewport를 기록한다. live two-machine SSH/tunnel validation은 이 layer의 proof가 아니므로
“not run”으로 기록한다.

이 작업은 auth/credential/permission boundary를 직접 구현하지 않지만, full dashboard session-only
management API를 UI에서 호출하고 host-key confirmation surface를 추가한다. MAINTAINERS.md:74-75의
“Authentication, credential handling … security-boundary changes require explicit security review”에
따라 PR body에 “Maintainer security review required for wp2/wp3/wp4 contract; wp5 consumes the protected
routes and does not weaken them”을 명시한다. MAINTAINERS.md:11의 security-review maintainer ownership도
참고한다.

## Contract deviations

1. K16 status DTO: `003_decisions.md:22`의 `role`, `listener`, `links[]`, `child` shape을
   canonical contract로 사용한다. GUI parser는 이 DTO를 검증하며 status wire field를 추가하거나
   다른 role/state 이름으로 변환하지 않는다. probe response `{alias, fingerprint, keyType}`(K16)와 confirm-host의 `ocxVersion`, 나머지
   endpoint의 request order는 기존 계획을 유지한다.
2. Child action의 실제 구현 시점: wp5는 role picker와 Child pending state까지만 제공하고
   POST /api/link/join은 wp6가 구현한다. 이는 001의 L6 ownership과 shared contract를 따른다.
3. RemoteWorkspace source file: route 이동에 component file 변경이 필요하지 않으면
   gui/src/pages/RemoteWorkspace.tsx는 실제 diff에서 제외한다. “moved”는 hash/nav identity 이동을 뜻한다.
4. workspace availability polling: 기존 component가 이미 available을 응답에 포함하므로 새 availability
   endpoint를 만들지 않는다. App에서 같은 existing endpoint를 읽는 중복 요청을 피할 수 있는지 구현 중
   확인하고, 가능하면 shared resource/helper로 합친다.

## 열린 질문

- status의 `links[].state` reconnecting/failed reason과 retry eligibility가 field로 제공되는가, 아니면 GUI가 state만 표시하고 retry는 probe부터 시작해야 하는가?
- fingerprint confirmation 뒤 POST /api/link/confirm-host의 성공 response가 apply-ready record를 반환하는가? 반환하지 않아도 local confirmed alias state만으로 apply 가능한가?
- DELETE /api/link/{id} 성공이 204인지 JSON인지, 두 형태를 허용하는 것이 wp4 contract에 포함되는가?
- RemoteWorkspace availability resource를 App에서 공유할지, component mount 시 nav capability를 별도 route registry로 올릴지?
- Child pending copy와 L6 handoff route의 exact Korean/English wording을 L6 문서에서 고정할 것인가?
- docs-site의 translated page를 이번 stack에서 English fallback으로 둘지, 기존 eight locale guide files까지 동시에 번역할지?

## 문서 작성 proof

- 필수 reference docs와 root/gui/docs-site AGENTS 지침을 읽었다.
- 지정 목업을 view_image로 확인했다.
- 실제 MODIFY source의 현재 line anchor를 확인했다: gui/src/App.tsx:13,34-46,68-79,517;
  gui/src/app-routing.ts:5-30; gui/src/pages/RemoteWorkspace.tsx:45-51,87-97;
  gui/src/i18n/catalogs.ts:1-35; gui/src/i18n/en.ts:3168-3215;
  gui/src/i18n/shared.ts:6-17; gui/src/styles-remote-workspace.css:26-27,46-50;
  gui/src/fetch-json.ts:28-43; gui/tests/remote-workspace.test.tsx:11-13;
  docs-site/astro.config.mjs:74-92; structure/manifest.json:465-481; MAINTAINERS.md:74-75.
- 이 문서 자체만 write scope로 작성한다.

## 감사 반영 (Pauli FAIL r1)

- K16의 `role: standalone | home | child`, `listener`, `links[]` 전체 필드, `child`를
  `RemoteLinkStatusWire`로 고정하고 GUI가 wire DTO를 확장하지 않도록 했다.
- `role`별 열 개 locale label과 link/listener state별 status dot mapping을 추가했다.
- 기존 실행 역할(`hub`/`client`) wire 가정과 status의 `hostKeyFingerprint`/`ocxVersion`
  가정을 제거했다. (Pauli r2 반영) probe 응답은 K16대로 `{alias, fingerprint, keyType}`이고 `ocxVersion`은 confirm-host 응답에서만 받는다.

## wp5 P 재검증 (아키텍트 Descartes, gpt-6-sol high, 2026-09-25) — 이 절이 앞선 내용보다 우선한다

| ID | 제안 | 처분 |
|---|---|---|
| W5-1 | Remote Link 활성 조건은 `sharedSessionReady`만(standalone은 targets.connected=false, api-targets.ts:117-124) | 수용 |
| W5-2 | 권한 표: candidates/probe/confirm-host/apply는 페어링 대시보드 세션만, status·DELETE는 세션 또는 신뢰 루프백 관리자 토큰(link-routes.ts:388-434) | 수용. GUI는 세션 경로만 쓴다 |
| W5-3 | 응답 모양: candidates `{candidates:[...]}`, apply 202 `{linkId}`, DELETE 200 `{linkId}`, `child.state`는 `LinkWireState`(status-projection.ts:19-24) | 수용 |
| W5-4 | App의 가용성 조회가 RemoteWorkspace 3초 폴링(RemoteWorkspace.tsx:87-97)과 겹침 | 결정: App은 원격 워크스페이스 가용성을 마운트와 경로 변경 시 한 번만 조회한다. 3초 폴링은 RemoteWorkspace 화면이 열려 있을 때만 기존대로. Remote Link 화면은 자기 status를 5초 간격으로, 화면이 보일 때만 폴링 |
| W5-5 | gui/tests/locale-parity.test.ts:3이 vi를 빠뜨림 | 수용: 목록을 `LOCALES`에서 파생 |
| W5-6 | 번역된 docs 트리 7개(astro.config.mjs:64-72)에 Remote Workspace 번역본이 있음 | 결정: 영어 원문 + 7개 언어 번역 페이지를 모두 추가하고 사이드바에 등록. 자식 흐름은 wp6 전까지 "준비 중" 문장 |
| W5-7 | #remote → Remote Link, #remote-workspace 분리 | 유지 |
| W5-8 | Switch·Notice·확인 대화상자 재사용, 추가 시트는 네이티브 `<dialog>`(Escape, 포커스 가두기·복원, OAuthTosWarningModal.tsx:34-70 관행) | 수용 |
| W5-9 | 스크린샷 절차 | 결정: `gui/scripts/remote-link-fixture.ts`(Bun 서버: `gui/dist` 정적 제공 + 고정 `/api/link/*`·세션·워크스페이스 응답, 상태별 쿼리 스위치 off/role/home-connected/add-sheet/fingerprint)를 만들고, agbrowse로 1440×900과 390×844를 찍는다. 이미지는 저장소 브랜치에 커밋하지 않고 `pr-assets` 브랜치에 올려 커밋 SHA로 링크(AGENTS.md 규칙). 픽스처 스크립트는 저장소에 남겨 재현 가능하게 한다 |

- 반영 확인(Descartes MISALIGNED 2건):
  - W5-4 확정: App의 효과는 `useEffect(..., [page, sharedSessionReady, sharedBase])`. `sharedSessionReady`가 false면 조회하지 않고 원격 워크스페이스 내비 항목을 숨긴다. 조회 실패도 숨김(가용성 불명 = 비노출). 페이지 이동마다 한 번, 중복 요청은 진행 중 요청을 재사용.
  - W5-9 확정: 파일 변경 지도에 NEW `gui/scripts/remote-link-fixture.ts` 추가. 계약: `bun gui/scripts/remote-link-fixture.ts --port <n>`이 `gui/dist`를 제공하고, `GET /opencodex-session`·`/api/remote-workspace/status (무효: 감사 반영 Averroes 절 참조)`·`/api/link/status`·`/api/link/candidates`·`POST /api/link/probe`·`/api/link/confirm-host`·`/api/link/apply`에 고정 JSON을 돌려준다. 상태는 URL 쿼리 `?fixture=off|role|home-connected|add-sheet|fingerprint`로 고른다(서버는 Referer 쿼리 또는 쿠키 `ocx-fixture`로 판별). 재현 명령: `cd gui && bun run build && bun scripts/remote-link-fixture.ts --port 5199` 후 agbrowse로 각 상태를 1440×900, 390×844로 캡처. 검증 표에 이 명령과 `bun run lint:i18n`, `bun test tests`, `bun run lint`, `bun run build`, docs-site 빌드(`cd docs-site && bun run build`)를 추가한다.
  - 실행 증거는 B/C 단계에서 만든다(계획 단계 문서는 결정 기록).

## 감사 반영 (Averroes FAIL r1, wp5 계획 감사) — 이 절이 앞선 모든 내용보다 우선한다

1. `#remote` 호환(반박 + 대안): 사용자가 `#remote`에서 링크 화면을 원한다고 명시했으므로(PRD 문제 정의) `#remote`는 Remote Link로 바꾼다. 옛 북마크 대책: 원격 워크스페이스가 사용 가능한 설치(App 가용성 조회가 true)에서는 Remote Link 화면 맨 위에 "원격 워크스페이스는 이제 별도 화면에 있어요 → 열기"(`#remote-workspace`) 카드를 항상 보여 준다. 테스트: 가용성 true면 카드와 링크가 렌더링되고 클릭 시 hash가 `#remote-workspace`, false면 카드 없음. `#remote-workspace` 직접 진입은 가용성과 무관하게 기존 RemoteWorkspace 화면(비활성 안내 포함)을 연다.
2. 오류 코드: `gui/src/remote-link-api.ts`(NEW)에 `readLinkJson<T>(res): Promise<T>`를 두고, 비정상 응답은 본문 `{error:{code,message}}`에서 code를 꺼내 `LinkApiError(code, status)`로 던진다(기존 `readJsonOrThrow`는 건드리지 않음). code → i18n 키 표: `invalid_body`, `invalid_alias`, `ssh_unreachable`, `probe_failed`, `host_confirmation_expired`, `host_fingerprint_mismatch`, `remote_ocx_missing`, `listener_unavailable`, `key_issue_failed`, `link_apply_failed`, `link_connect_timeout`, `compensation_failed`, `remote_disconnect_failed`, `key_revoke_failed`, `link_remove_failed`, `tailscale_session_refused`, `link_unavailable` + 알 수 없는 코드용 `remoteLink.error.generic`. 구현 시 link-routes.ts에서 실제 code 목록을 `rg -o 'fail\("[a-z_]+"'`로 뽑아 표와 대조하고, 표에 없는 코드가 있으면 추가한다. 테스트: 각 code가 해당 문구를 보여 줌, 알 수 없는 code는 generic.
3. 강제 해제: DELETE가 `remote_disconnect_failed`(502)면 두 번째 확인 대화상자("기기에 연결할 수 없어요. 이 컴퓨터에서만 링크를 지울까요? 그 기기는 직접 `ocx disconnect` 해야 해요")를 띄우고 확인 시 `DELETE /api/link/{id}` 본문 `{"force":true}`. `compensation_failed` 행은 실패 점(빨강) + 사유 문구 + "링크 지우기" 버튼(같은 DELETE 흐름). 테스트: 502 → 강제 확인 → force 본문 전송, compensation_failed 행 렌더링.
4. 상태 코드 고정: apply 202 `{linkId}`, DELETE 200 `{linkId}`, probe 200, confirm-host 200, candidates 200. 테스트·픽스처 모두 이 값만.
5. 픽스처 엔드포인트: 원격 워크스페이스 가용성은 `GET /api/remote-workspace`(remote-workspace-routes.ts:61). W5-9 표기의 `/api/remote-workspace/status (무효: 감사 반영 Averroes 절 참조)`는 폐기. 파일 변경 지도에 NEW `gui/scripts/remote-link-fixture.ts` 포함.
6. 문서 파일: NEW `docs-site/src/content/docs/guides/remote-link.md`와 7개 번역 `docs-site/src/content/docs/{fr,ko,zh-cn,zh-tw,ru,ja,tr}/guides/remote-link.md`, 그리고 `docs-site/astro.config.mjs` 사이드바의 Guides 그룹에 remote-hub 옆으로 등록(기존 remote-workspace 등록 방식과 같게). 기존 remote-hub/remote-workspace 가이드에서 새 페이지로 한 줄 링크.
7. 비차단 반영: 테스트에 `role: "home", links: [], child: null` 홈 빈 상태와, 꺼짐 스위치·역할 선택만으로는 GET 외 요청이 없음을 요청 기록으로 확인. CSS는 gui/design-system의 토큰(간격·반경·색)만 쓰고 새 원시 값이 필요하면 토큰을 먼저 추가한다.

## 감사 반영 (Averroes FAIL r2)

1. 오류 코드 목록은 구현된 라우트에서 뽑은 것이 전부다(`rg -o 'fail\("[a-z_]+"' src/server/management/link-routes.ts`, 2026-09-25 기준 24개). r1 절 2번의 목록은 이 표로 대체한다(`ssh_unreachable`, `remote_ocx_missing`, `link_connect_timeout`은 존재하지 않으므로 폐기). 구현은 이 목록을 `gui/src/remote-link-api.ts`에 `LINK_ERROR_CODES` 상수로 두고, GUI 테스트가 같은 명령에 해당하는 정규식으로 `src/server/management/link-routes.ts`를 읽어 뽑은 집합과 상수가 같은지 확인한다(서버가 코드를 추가하면 GUI 테스트가 실패).

| code | i18n 키 |
|---|---|
| `admission_timeout` | `remoteLink.error.admission_timeout` |
| `compensation_failed` | `remoteLink.error.compensation_failed` |
| `fingerprint_failed` | `remoteLink.error.fingerprint_failed` |
| `forbidden` | `remoteLink.error.forbidden` |
| `host_confirmation_expired` | `remoteLink.error.host_confirmation_expired` |
| `host_fingerprint_mismatch` | `remoteLink.error.host_fingerprint_mismatch` |
| `host_not_confirmed` | `remoteLink.error.host_not_confirmed` |
| `invalid_alias` | `remoteLink.error.invalid_alias` |
| `invalid_body` | `remoteLink.error.invalid_body` |
| `invalid_link_id` | `remoteLink.error.invalid_link_id` |
| `key_issue_failed` | `remoteLink.error.key_issue_failed` |
| `key_revoke_failed` | `remoteLink.error.key_revoke_failed` |
| `link_apply_failed` | `remoteLink.error.link_apply_failed` |
| `link_exists` | `remoteLink.error.link_exists` |
| `link_not_found` | `remoteLink.error.link_not_found` |
| `link_remove_failed` | `remoteLink.error.link_remove_failed` |
| `link_unavailable` | `remoteLink.error.link_unavailable` |
| `listener_unavailable` | `remoteLink.error.listener_unavailable` |
| `probe_failed` | `remoteLink.error.probe_failed` |
| `remote_connect_failed` | `remoteLink.error.remote_connect_failed` |
| `remote_disconnect_failed` | `remoteLink.error.remote_disconnect_failed` |
| `remote_port_failed` | `remoteLink.error.remote_port_failed` |
| `tailscale_session_refused` | `remoteLink.error.tailscale_session_refused` |
| `version_probe_failed` | `remoteLink.error.version_probe_failed` |
| (알 수 없는 code) | `remoteLink.error.generic` |

2. 새 문구 키(영어 원문, 10개 로케일 모두 추가, `bun run lint:i18n` 통과). 위 표의 오류 키도 모두 10개 로케일에 추가한다.
   - `remoteLink.workspaceMoved.title`: "Remote Workspace has its own page now"
   - `remoteLink.workspaceMoved.open`: "Open Remote Workspace"
   - `remoteLink.forceRemove.title`: "This machine could not reach {alias}"
   - `remoteLink.forceRemove.body`: "Remove the link only on this machine? Afterwards run {cmd} on {alias} yourself." ({cmd}는 `<Trans>`의 `ocx disconnect` 코드 칩)
   - `remoteLink.forceRemove.confirm`: "Remove here only"
   - `remoteLink.row.removeFailedLink`: "Remove link"
3. 앞 절의 `201/200`, `204/JSON`, `/api/remote-workspace/status` 표기는 본문에서 무효로 표시했다.
