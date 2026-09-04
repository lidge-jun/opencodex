# 000 — Dashboard inventory (as shipped, v2.42.0, dev @ 664d80c76)

Evidence: `assets/<route>_1440.png` (full page, ko, 1440 px headless Chrome against the live
proxy), `assets/<route>_text.txt` (visible text), `assets/<route>_interactive.txt` (interactive
controls with refs, `agbrowse snapshot --interactive`). Storage was captured mid-scan (its skeleton
is the honest first paint on a 1.6 GB CODEX_HOME) and is inventoried from source.

Counts are from the captures: interactive = controls in the snapshot, words = visible text words.

| Route | Source | Interactive | Words | Screenshot |
|---|---|---|---|---|
| Sidebar + top bar | gui/src/App.tsx, components/sidebar-github-row.tsx, styles.css | 22 | — | every capture, left rail |
| #dashboard (overview) | pages/Dashboard.tsx, dashboard-overview-sections.tsx (669 L), dashboard-dialogs.tsx | 34 | 199 | dashboard_1440.png |
| #dashboard/providers | same | 18 | — | dashboard_providers_1440.png |
| #dashboard/models | same | 28 | — | dashboard_models_1440.png |
| #startup | pages/Startup.tsx (403 L), startup-sections.tsx | 22 | 167 | startup_1440.png |
| #providers | pages/Providers.tsx, components/provider-workspace/* | 27 | 310 | providers_1440.png |
| #models | pages/Models.tsx (2329 L) | 135 | 460 | models_1440.png |
| #models/combos | pages/Combos.tsx, components/combo-workspace-* | 59 | — | models_combos_1440.png |
| #models/routing | pages/RoutingProfiles.tsx (1139 L) | 28 | — | models_routing_1440.png |
| #models/compatibility | pages/CompatibilityMatrix.tsx | 27 | — | models_compatibility_1440.png |
| #subagents | pages/Subagents.tsx, components/subagents-workspace/* | 60 | 232 | subagents_1440.png |
| #logs | pages/Logs.tsx (1147 L) | 50 | 346 | logs_1440.png |
| #logs/debug | pages/Debug.tsx, debug-log-viewer.tsx | 24 | — | logs_debug_1440.png |
| #usage | pages/Usage.tsx (889 L) | 27 | 654 | usage_1440.png |
| #storage | pages/Storage.tsx (1469 L), components/storage-workspace/* | 16 (skeleton) | — | storage_1440.png |
| #codex-set | pages/codex-set-multiauth.tsx, codex-set-prompt.tsx, components/codex-set/*, CodexAccountPool.tsx | 51 | 361 | codex-set_1440.png |
| #integrations | pages/Integrations.tsx, ApiKeys.tsx, Claude*.tsx, Grok.tsx | 86 | 233 | integrations_1440.png |

## Element-level notes from the captures (main agent's own pass)

Sidebar / top bar
- Brand + version chip, 9 nav rows, language combobox, theme button ("시스템"), a "프록시" label
  row with stop + reload-models icon buttons, GitHub row with star + download(update) icons.
- The "프록시" row is a label with two icon buttons and no state; "시스템" (theme) is a full-width row
  for a rarely-used control.

Dashboard overview
- Six stat cards: subagent mode segmented (v1/base/v2 — a control inside a stat card), status,
  version, uptime, provider count, tokens(30d)+coverage.
- A green "재부팅 후에도 opencodex가 자동으로 준비됩니다" notice band (duplicated on #startup).
- Card "서브에이전트 위임" with a value chip and "설정 열기" (duplicates #subagents).
- Card "모델 동기화" with "지금 동기화" (duplicates the top-bar reload-models icon).
- Card "Codex 실행 시 opencodex 시작" toggle + two sentences (duplicates #startup shim row).
- Cards "웹 검색 사이드카", "비전 사이드카" with model comboboxes, a streaming toggle, "고급 설정".
- Tabs "활성 프로바이더", "사용 가능한 모델" duplicate #providers and #models content.

Startup
- Orange sync banner (Codex version drift) with copy button; green hero card; three stat cards
  restating the hero; "보호 상태 상세" list; "복구 방법" with copyable commands; "대시보드로
  돌아가기" + "새로고침" buttons.

Providers
- Left list (status dot, model count), right overview: 3 stat cards (ready / needs setup /
  inactive), "사용량 제한" per-provider quota bars with reset times, "최근 사용" list, "JSON 편집",
  "+ 프로바이더 추가", filter icon.

Models
- Top notice "Codex가 이 카탈로그보다 오래된 모델 목록을 보여주고 있습니다" + "Codex 모델 목록
  새로고침" button; 4 tabs; a 4-line explanatory paragraph; provider list; global toggles row
  (새 모델을 비활성화 상태로 추가, 섀도우 호출 가로채기 with model picker, 기본 창/상한 stepper
  + toggle) each with a helper sentence; "우선 순서" explanation block; "모두 접기 / 모두 펼치기";
  per-provider group header with 6 controls (edit, 기본 별칭 사용, 커스텀 모델 추가, 모두 켜기,
  모두 끄기, 기본 창/상한 + 사용자 지정 창) repeated per group.

Subagents
- 3 tabs; "추천" list with per-row up/down/remove; "저장"; "모델" search + checklist. Helper
  sentence with inline code.

Logs
- Title + sentence; auto-refresh checkbox; tabs; surface segmented; "가로챈 헬퍼만"; two filter
  inputs with labels; 10-column table; per-row "상세보기" link under the status.

Usage
- Range segmented (전체/Codex/Claude/Grok) + period segmented; 4 tabs with counts; 6 stat cards;
  cost banner sentence; heatmap with legend; model search + table; provider table; coverage.

Codex 설정
- Tabs 다중 인증 / 프롬프트; header controls (Spark 할당량 toggle, 한도 도달 계정 일시 중지,
  할당량 새로고침); "OpenAI 계정 모드" card; main account card with 5 badges/buttons; per-account
  cards with plan badge, count badge, 4 buttons, priority select, quota bars, ✕.

Integrations
- 18 tabs (one per client) in two rows; 4-number summary + "모두 해제"; "API 키" row; explanatory
  paragraph; card grid: name, status badge, one-line, toggle, "설정".

Storage
- Title + sentence, "다시 스캔", card list (source: per-category size cards, cleanup presets,
  log guard section, protection toggles).
