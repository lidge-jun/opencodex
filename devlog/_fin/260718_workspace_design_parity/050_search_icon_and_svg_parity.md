# Phase 050 — 검색 아이콘 겹침 및 SVG 원본 렌더링 통일

## 문제

- `.pws-search-input`의 `padding-left: 28px`가 후순위 `.input` shorthand에 덮여 실제 계산값이 11px가 된다.
  14px 검색 SVG가 입력 글자와 겹친다.
- 클래식 뷰는 provider SVG를 `<img>`로 원본 그대로 렌더링하지만,
  Workspace의 `ProviderIcon`은 `providerBrandColor`가 있는 SVG를 단색 mask로 바꾼다.

## 변경

- `gui/src/styles/provider-workspace-shell.css`
  - `.pws-search-wrap .pws-search-input`으로 specificity를 높이고 왼쪽 여백을 32px로 고정한다.
- `gui/src/components/provider-workspace/ProviderRail.tsx`
  - Workspace 전용 brand-color mask 분기를 제거한다.
  - 클래식 뷰와 동일하게 원본 provider SVG를 `<img>`로 렌더링한다.

## 검증

- 계산된 검색 입력 왼쪽 padding이 32px이다.
- 검색 SVG와 placeholder가 겹치지 않는다.
- 클래식/Workspace가 동일한 `/provider-icons/*.svg` 원본을 사용한다.
- GUI typecheck, targeted eslint, build가 exit 0이다.
- agbrowse로 Workspace rail, dashboard, detail 아이콘을 확인한다.

## Evidence

- 계산된 입력 padding: `32px`
- 검색 SVG bounds: left `385`, right `399`; placeholder 시작 `409` — 10px 간격
- Workspace 원본 SVG 목록:
  - `/provider-icons/claude-color.svg`
  - `/provider-icons/cursor-color.svg`
  - `/provider-icons/antigravity-color.svg`
  - `/provider-icons/kimi-color.svg`
  - `/provider-icons/openai.svg`
  - `/provider-icons/opencode.svg`
  - `/provider-icons/grok-color.svg`
- 클래식: `/Users/jun/.browser-agent/screenshots/screenshot_1784338088050.png`
- Workspace: `/Users/jun/.browser-agent/screenshots/screenshot_1784338100615.png`
- `bunx tsc -b --noEmit` — exit 0
- `bunx eslint src/components/provider-workspace/ProviderRail.tsx` — exit 0
- `bun run build` — exit 0, 67 modules transformed
