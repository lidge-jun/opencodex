# 001 — Subagent opinions (independent, read-only, dev @ 664d80c76)

Three reviewers were dispatched in parallel with the same packet (evidence pack in `assets/`,
full source access, no edits, no suites, no proxy mutation). Model requested → model that
answered (as self-reported in the REVIEWER line):

| # | Requested | Answered as | Agent | Status |
|---|---|---|---|---|
| R1 | gpt-5.6-sol / medium | claude-fable-5-1 (proxy routed) | 01a06823-44b2 "Mendel" | complete |
| R2 | anthropic/claude-opus-5 / medium | claude-opus-5 | 01a06823-4549 "Epicurus" | complete |
| R3 | xai/grok-4.6 / high | grok-4.6 | 01a06823-45e1 "Averroes" | complete (≈21 min) |

Evidence caveat both reviewers raised: the first capture pass had four misrouted text files
(logs, logs_debug, models_compatibility, and subagents==storage). They were recaptured before
002 was written; the reviewers' verdicts for those routes were source-grounded and were
re-checked against the corrected captures in 002.

## Where R1 and R2 agree (high confidence)

- Dashboard "활성 프로바이더" and "사용 가능한 모델" tabs duplicate Providers/Models → remove.
- Dashboard duplicates settings that have a home elsewhere: subagent v1/base/v2 switch,
  "서브에이전트 위임" card, shadow-call intercept, "Codex 실행 시 opencodex 시작" → demote to
  their owning page (Subagents / Models / Startup).
- Integrations 18-tab strip is redundant with the card grid → collapse; zero-valued summary
  cards and uninstalled-client cards → hide when zero / behind "add client".
- Sidebar: GitHub star orb removed from chrome; GitHub row demoted; language + theme
  collapsed into a compact footer control; "프록시" label removed (orbs keep aria-labels).
- Models: 4-line catalog subtitle + picker-order paragraph → tooltip/help; per-provider header
  control wall (6 controls × N providers) → per-provider action menu.
- Codex 설정: per-account priority explanation ×6 → one shared ⓘ; 별칭 편집 / ✕ → overflow
  menu; truncated account ID → tooltip (copyable).
- Usage: 활동일 card removed; coverage shown once; cost estimate keeps its disclaimer; heatmap
  collapsed/follows range.
- Startup: three stat cards restating the hero → collapse; "대시보드로 돌아가기" removed.
- Providers: 3 summary cards restate the rail → collapse; "최근 사용" demoted to Usage;
  quota bars KEEP (both call them the highest-value element on the page).
- Never touch: stop/restart orbs, reboot-protection health bar, quota bars, storage
  destructive-action ceremony + quarantine, JSON 편집 escape hatch, conditional warning
  banners, cost/lab disclaimers, model visibility toggles.

## Where they disagree

| Topic | R1 | R2 | Note for 002 |
|---|---|---|---|
| Version chip in sidebar | demote to tooltip | keep (most-asked support fact) | R2 wins: one chip, zero cost, high support value. |
| Sidebar nav rows | demote Codex 설정 / 서브에이전트 / 저장소 under other pages | keep all 9 | R2 wins for this loop: route changes are a scope expansion; nav stays. |
| Logs 10-column table | collapse 5 columns behind a column picker | (no call) | Defer — Logs was just reworked (#3367); revisit after the rest lands. |
| Memory 관찰 card | collapse behind runtime details | #1 highest noise: collapse body, keep pressure bar | Agree on collapse; R2's shape (keep pressure/in-flight/restart) is the one to build. |
| Providers summary cards | keep | collapse (restate the rail) | R2 wins: the rail group headers already carry ready/needs-setup/inactive counts. |
| Integrations "모두 해제" | demote to bulk menu | keep | R2 wins: bulk rollback of a config-writing feature is safety, not noise. |
| Storage subtitle | keep | keep | agree. |

## R3 — headline (full text in §R3 below)

R3 converges with R1/R2 on: dashboard clone tabs, triple v1/base/v2 (owner: Subagents), dual shadow-call (owner: Models), Models essay/control wall, Integrations 18 tabs, Usage heatmap + sticker price, sidebar star/GitHub/update chrome, Combos empty-state expert form, Routing dry-run on empty tab, per-account 선택 순서 ×N, page subtitles. R3-only calls: remove the third Codex-restart orb on the Models page head (Models.tsx:2207); demote "재시도" on Routing to error-only; DEMOTE 활동일; keep Providers 3 summary cards (disagrees with R2). R3 keeps Startup three stat cards (R1 collapses them) and keeps "모두 해제".

## R1 — full review

Review basis: commit `664d80c76`, current source, visible-text/control captures, and all 16 PNGs. No files were changed and no tests or proxy operations were run.

The intended product posture should be: show current health, exceptions, and the next useful action; disclose implementation detail, raw identifiers, historical data, and rare configuration only on demand.

Evidence warning: three supplied captures are misrouted:

- `logs_1440.png` / `logs_text.txt` show Codex authentication.
- `logs_debug_1440.png` / `logs_debug_text.txt` show Integrations.
- `models_compatibility_1440.png` / its text show Usage.

Those routes can be reviewed structurally from source, but not visually validated from this evidence pack.

## Sidebar

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `opencodex` | `gui/src/App.tsx:249` | KEEP | Stable product identity anchors every route. | Removing it makes the shell anonymous. |
| `v2.42.0` | `gui/src/App.tsx:250` | DEMOTE-to-System/status tooltip | Version matters during diagnosis, not during every navigation decision. | Operators may take one extra action when comparing versions. |
| `대시보드`, `프로바이더`, `모델`, `로그&디버그`, `사용량`, `연동` | `gui/src/App.tsx:62` | KEEP | These are distinct, frequent operator jobs. | Combining them would obscure major workflows. |
| `Codex 설정` | `gui/src/App.tsx:64` | DEMOTE-to-Codex subsection under Providers or Models | It is product-specific configuration inside a universal proxy and currently competes with primary operations. | Codex-heavy users lose one-click access. |
| `서브에이전트` | `gui/src/App.tsx:67` | DEMOTE-to-Models/Advanced | It configures model selection behavior rather than a standalone runtime resource. | Multi-agent users need one extra click. |
| `저장소` | `gui/src/App.tsx:70` | DEMOTE-to-System/maintenance | Storage cleanup is periodic maintenance, not a primary daily destination. | Disk-pressure investigation is less immediately discoverable. |
| `한국어` | `gui/src/App.tsx:323` | COLLAPSE-behind-settings-popover | Locale is a rare preference after initial selection. | Language switching becomes one click deeper. |
| `시스템` theme control | `gui/src/App.tsx:335` | COLLAPSE-behind-settings-popover | Theme has no proxy-operational decision value. | Theme switching becomes less immediate. |
| `프록시` plus stop/restart icons | `gui/src/App.tsx:339` | KEEP | Stop and restart are consequential runtime controls. | Hiding them would delay recovery. |
| `GitHub` | `gui/src/components/sidebar-github-row.tsx:131` | REMOVE | Repository promotion is unrelated to operating the local proxy. | Users lose a convenience link; the repository remains reachable elsewhere. |
| star control | `gui/src/components/sidebar-github-row.tsx:136` | REMOVE | Spending user identity/reputation has zero operator value in persistent navigation. | Users cannot star from the dashboard. |
| update icon | `gui/src/components/sidebar-github-row.tsx:147` | DEMOTE-to-System/version-status | Updating is operationally relevant only when an update exists. | Manual update checks become less prominent. |

## Topbar

The desktop evidence has no independent topbar; this is the mobile shell.

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| menu button | `gui/src/App.tsx:258` | KEEP | It is the only narrow-screen navigation entry. | Removing it blocks mobile navigation. |
| `opencodex` brand | `gui/src/App.tsx:263` | KEEP | It provides compact route context. | Minimal risk, but removing it weakens orientation. |
| session logout icon | `gui/src/App.tsx:265` | COLLAPSE-behind-account/menu | Logout is infrequent and visually indistinguishable among three adjacent icon-only actions. | Connected-runtime logout takes one extra step. |
| proxy stop icon | `gui/src/App.tsx:271` | KEEP | Emergency shutdown is high-value and confirmation-gated. | None if label and confirmation remain. |
| Codex restart icon | `gui/src/App.tsx:275` | DEMOTE-to-model-stale-banner-or-menu | Restart is usually relevant only after stale-state detection. | Manual restart is one click deeper outside stale conditions. |

## Dashboard — Overview

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| subtitle explaining “local proxy, providers, models” | `gui/src/pages/Dashboard.tsx:80` | REMOVE | The sidebar and page title already establish this context. | First-time users lose a generic orientation sentence. |
| `개요 / 활성 프로바이더 / 사용 가능한 모델` tabs | `gui/src/pages/Dashboard.tsx:54` | REMOVE | The latter two duplicate dedicated Providers and Models routes. | Users lose read-only shortcuts; replace with linked counts. |
| `서브에이전트 v1/base/v2` | `gui/src/pages/dashboard-overview-head.tsx:34` | DEMOTE-to-Subagents-settings | It is a mutation embedded in what should be a status overview. | Mode switching is no longer available from the landing screen. |
| `상태 온라인` | `gui/src/pages/dashboard-overview-head.tsx:73` | KEEP | Runtime reachability is the dashboard’s primary decision signal. | None. |
| `버전` | `gui/src/pages/dashboard-overview-head.tsx:79` | DEMOTE-to-status-tooltip | It matters only for mismatch/update diagnosis. | Exact version is less glanceable. |
| `가동 시간` | `gui/src/pages/dashboard-overview-head.tsx:80` | COLLAPSE-behind-runtime-details | Uptime rarely changes an operator decision unless diagnosing restarts. | Restart-loop detection requires opening details. |
| `프로바이더 9` | `gui/src/pages/dashboard-overview-head.tsx:81` | KEEP | A linked count quickly reveals whether expected capacity exists. | Count alone does not reveal unhealthy providers. |
| `토큰 (30일) / 커버리지` | `gui/src/pages/dashboard-overview-head.tsx:82` | DEMOTE-to-Usage | It duplicates the Usage report and dominates the health row with historical volume. | Cost-conscious users lose a landing-page summary. |
| reboot-protection status bar | `gui/src/pages/dashboard-overview-head.tsx:93` | KEEP | Startup protection is a real availability decision and links to remediation. | None. |
| `서브에이전트 위임 / 설정 열기` | `gui/src/pages/dashboard-overview-sections.tsx:127` | DEMOTE-to-Subagents | It duplicates the dedicated configuration surface. | One-click access from dashboard is lost. |
| `모델 동기화 / 지금 동기화` | `gui/src/pages/dashboard-overview-sections.tsx:206` | KEEP | Catalog drift requires an explicit corrective action. | None. |
| `Codex 실행 시 opencodex 시작` | `gui/src/pages/dashboard-overview-sections.tsx:487` | DEMOTE-to-Startup-safety | It is startup policy, not live health. | Users may overlook launcher behavior unless following startup status. |
| `웹 검색 사이드카` | `gui/src/pages/dashboard-overview-sections.tsx:509` | DEMOTE-to-Models/Advanced | This is model-routing configuration, not dashboard status. | Web-search operators need one additional navigation step. |
| `응답 실시간 스트리밍` | `gui/src/pages/dashboard-overview-sections.tsx:531` | COLLAPSE-behind-web-search-details | It is a secondary tuning flag. | Streaming behavior is less discoverable. |
| `비전 사이드카` | `gui/src/pages/dashboard-overview-sections.tsx:549` | DEMOTE-to-Models/Advanced | It is another routing configuration block occupying the primary overview. | Image-routing configuration becomes less immediate. |
| `쉐도우 호출 가로채기` | `gui/src/pages/dashboard-overview-sections.tsx:626` | DEMOTE-to-Models/Advanced | It is a specialized Codex compatibility feature. | Helper-call routing becomes harder to discover. |
| `메모리 관찰` summary | `gui/src/components/MemoryObservabilityCard.tsx:470` | COLLAPSE-behind-System/runtime-details | Memory is useful primarily when abnormal; normal RSS/JSC figures are monitoring noise. | Slow leaks may be noticed later unless warning thresholds remain visible. |

## Dashboard — Active Providers

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| entire `활성 프로바이더` tab | `gui/src/pages/Dashboard.tsx:56` | REMOVE | It is a less actionable duplicate of the Providers workspace. | Operators lose a compact read-only inventory. |
| provider count | `gui/src/pages/dashboard-providers-section.tsx:16` | DEMOTE-to-linked-dashboard-stat | The number is useful, but not a standalone page. | None if linked to Providers. |
| `이름` | `gui/src/pages/dashboard-providers-section.tsx:22` | DEMOTE-to-Providers-list | Names belong in the actionable provider workspace. | None. |
| `어댑터` | `gui/src/pages/dashboard-providers-section.tsx:27` | COLLAPSE-behind-provider-details | Adapter type is implementation detail for troubleshooting. | Advanced users need to open details. |
| `Base URL` | `gui/src/pages/dashboard-providers-section.tsx:28` | COLLAPSE-behind-provider-details | Raw endpoints have no routine decision value and visually dominate the table. | Endpoint mistakes become one click less visible. |
| default `모델` | `gui/src/pages/dashboard-providers-section.tsx:29` | DEMOTE-to-provider-details | It is actionable only in the provider editor. | Users lose at-a-glance default-model comparison. |

## Dashboard — Available Models

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| entire `사용 가능한 모델` tab | `gui/src/pages/Dashboard.tsx:57` | REMOVE | It duplicates the Models catalog without offering catalog actions. | Operators lose a fast read-only model lookup. |
| total model count | `gui/src/pages/dashboard-models-section.tsx:29` | DEMOTE-to-linked-dashboard-stat | The count is useful as health context, not as a separate page. | None if linked. |
| `모델 검색…` | `gui/src/pages/dashboard-models-section.tsx:37` | DEMOTE-to-Models | Search belongs where results can be enabled, disabled, or configured. | Dashboard-only lookup disappears. |
| provider accordion rows | `gui/src/pages/dashboard-models-section.tsx:51` | REMOVE | They repeat the same provider/model hierarchy already presented in Models. | Read-only browsing requires entering Models. |
| raw model-ID chips | `gui/src/pages/dashboard-models-section.tsx:68` | COLLAPSE-behind-provider-model-details | Raw IDs matter when configuring or copying, not in a health dashboard. | Copying an ID takes one extra action. |

## Startup Safety

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| explanatory subtitle | `gui/src/pages/Startup.tsx:322` | COLLAPSE-behind-help-tooltip | The page’s protected/at-risk result explains its purpose more directly. | New users lose conceptual context. |
| `대시보드로 돌아가기` | `gui/src/pages/Startup.tsx:325` | REMOVE | Global navigation already provides this route. | Keyboard users lose a redundant shortcut. |
| `새로고침` | `gui/src/pages/Startup.tsx:328` | KEEP | Rechecking after remediation is a direct operator action. | None. |
| runtime compatibility warning and `ocx sync` | `gui/src/pages/Startup.tsx:360` | KEEP | It identifies actionable version/config drift. | None. |
| protected/at-risk hero | `gui/src/pages/startup-sections.tsx:44` | KEEP | This is the page’s decisive answer. | None. |
| three cards: routing, protection, preference | `gui/src/pages/startup-sections.tsx:59` | COLLAPSE-behind-protection-details | They restate the hero in implementation terms during healthy operation. | Exact mechanism is less glanceable. |
| `보호 상태 상세` with platform | `gui/src/pages/startup-sections.tsx:99` | COLLAPSE-behind-hero-disclosure | Detailed service/shim state is needed mainly when risk exists. | Healthy users need one click to inspect mechanisms. |
| install/repair action for unhealthy service or shim | `gui/src/pages/startup-sections.tsx:112` | KEEP | It is the direct remediation path. | None. |
| `복구 방법` command list | `gui/src/pages/startup-sections.tsx:237` | COLLAPSE-behind-manual-recovery | Manual commands are fallback capability after one-click remediation. | CLI-oriented users need to expand it. |

## Providers

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `프로바이더 추가` | `gui/src/pages/Providers.tsx:322` | KEEP | Adding capacity is a core provider task. | None. |
| left provider rail and ready/disabled status | `gui/src/pages/Providers.tsx:328` | KEEP | It is the primary inventory and selection mechanism. | None. |
| `프로바이더 개요` explanatory sentence | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:98` | REMOVE | The workspace structure already communicates that it manages providers. | Minimal onboarding loss. |
| `JSON 편집` | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:103` | COLLAPSE-behind-Advanced | Raw config editing is high-risk and rarely the first action. | Power users need one extra action; advanced access must remain obvious. |
| ready/setup/disabled summary cards | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:110` | KEEP | They summarize actionable provider health. | None. |
| attention list | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:120` | KEEP | Exceptions should remain more prominent than normal providers. | None. |
| full `사용량 제한` bars for every provider | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:146` | COLLAPSE-behind-usage-limits | Normal low-utilization quota rows consume most of the screen; surface only nearing-limit rows initially. | Operators lose passive comparison of all quotas. |
| `최근 사용` ranking | `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:196` | DEMOTE-to-Usage/providers | Historical ranking duplicates Usage and does not help configure a provider. | A quick “most used” glance disappears from Providers. |

## Models — Catalog

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| stale-Codex banner and restart action | `gui/src/pages/Models.tsx:2215` | KEEP | It detects a real mismatch and gives the corrective action. | None. |
| `모델 / 콤보 / 라우팅 / 호환성` tabs | `gui/src/pages/models-tab-strip.tsx:19` | KEEP | They represent distinct model-management capabilities. | Removing them would bury major features. |
| long catalog subtitle | `gui/src/pages/Models.tsx:2226` | COLLAPSE-behind-help-tooltip | It explains nuanced cache/visibility semantics but pushes controls below the fold. | Users may misunderstand direct-ID behavior without opening help. |
| provider rail | `gui/src/pages/Models.tsx:2132` | KEEP | It is the simplest way to scope a large catalog. | None. |
| top-level `새 모델을 비활성화 상태로 추가` | `gui/src/pages/Models.tsx:2173` | COLLAPSE-behind-catalog-policy | This is a rare future-model policy, not a routine model-selection action. | Newly discovered models may surprise users who never inspect policy. |
| `별칭` global control | `gui/src/pages/Models.tsx:2175` | COLLAPSE-behind-Advanced | Alias management is specialized and already has per-provider controls. | Users need an extra action to audit all aliases. |
| shadow-call controls | `gui/src/pages/Models.tsx:2173` | COLLAPSE-behind-Codex-advanced | They are product-specific compatibility controls. | Helper-call overrides are less discoverable. |
| subagent mode `v1/base/v2` | `gui/src/pages/Models.tsx:2173` | DEMOTE-to-Subagents-settings | It belongs with delegation configuration. | Cross-surface users lose immediate mode visibility. |
| global `기본 창 / 상한` | `gui/src/pages/Models.tsx:2173` | COLLAPSE-behind-context-settings | Context limits are advanced tuning and dangerous to change casually. | Operators diagnosing truncation need one extra click. |
| picker-order explanatory paragraph | `gui/src/pages/Models.tsx:1752` | COLLAPSE-behind-info-tooltip | It is reference documentation, not a decision control. | Ordering behavior is less immediately explicit. |
| `모두 접기 / 모두 펼치기` | `gui/src/pages/Models.tsx:1759` | KEEP | It directly manages information density in a large catalog. | None. |
| provider header actions: aliases, custom model, all on/off, context | `gui/src/pages/Models.tsx:2192` | COLLAPSE-behind-provider-action-menu | Repeating six controls on every provider creates the screen’s largest control wall. | Bulk actions require opening a per-provider menu. |
| individual model rows/toggles | `gui/src/pages/Models.tsx:2192` | KEEP | Visibility selection is the catalog’s primary capability. | None. |

## Models — Combos

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| combos tab | `gui/src/pages/models-tab-strip.tsx:21` | KEEP | Failover/load-distribution is a distinct operator capability. | None. |
| tab subtitle | `gui/src/pages/Models.tsx:2226` | COLLAPSE-behind-help-tooltip | Existing combos explain themselves; onboarding text is primarily needed for an empty state. | First-time comprehension depends more on the empty state. |
| duplicate `콤보 추가` in rail and `콤보 만들기` in editor | `gui/src/components/ComboWorkspace.tsx:108` | REMOVE | The empty workspace presents multiple labels for the same creation action. | Ensure one retained CTA focuses or opens the complete form. |
| combo search with zero combos | `gui/src/components/ComboWorkspace.tsx:112` | REMOVE | Search has no decision value until at least one combo exists. | None; show it conditionally once combos exist. |
| `콤보 ID` | `gui/src/components/ComboWorkspace.tsx:197` | KEEP | Stable identity is required to create and address a combo. | None. |
| public model name and native OpenAI alias | `gui/src/components/ComboWorkspace.tsx:197` | COLLAPSE-behind-identity-advanced | Most users can accept `combo/<id>` and do not need namespace/alias mechanics initially. | Advanced naming is less discoverable. |
| display name | `gui/src/components/ComboWorkspace.tsx:197` | COLLAPSE-behind-identity-advanced | It is conditional on alias behavior rather than core failover setup. | Native-alias users need to expand the section. |
| strategy and ordered targets | `gui/src/components/ComboWorkspace.tsx:197` | KEEP | These define combo behavior and are the primary decisions. | None. |
| default reasoning level | `gui/src/components/ComboWorkspace.tsx:197` | COLLAPSE-behind-behavior-advanced | Target defaults are usually sufficient. | Users may miss a useful normalization override. |
| multimodal/adaptive reasoning toggles | `gui/src/components/ComboWorkspace.tsx:197` | COLLAPSE-behind-capabilities | These are compatibility constraints, not minimum combo creation inputs. | Misconfigured heterogeneous targets may need more deliberate inspection. |

## Models — Routing

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `라우팅 (beta)` | `gui/src/pages/models-tab-strip.tsx:22` | KEEP | Explicit beta labeling correctly bounds expectations. | None. |
| `프로필 만들기` | `gui/src/pages/RoutingProfiles.tsx:624` | KEEP | Creating a policy is the primary task. | None. |
| profile cards with model and revision | `gui/src/pages/RoutingProfiles.tsx:624` | KEEP | Operators need to choose the policy under inspection. | None. |
| revision badge | `gui/src/pages/RoutingProfiles.tsx:638` | COLLAPSE-behind-profile-details | Revision is audit metadata, not a selection criterion for most operators. | Concurrent-edit diagnosis is less immediate. |
| `드라이런 평가` shown before any profile exists | `gui/src/pages/RoutingProfiles.tsx:1015` | COLLAPSE-behind-selected-profile | The disabled form is dead visual weight until a profile is selected. | Users may not discover dry-run until selecting a profile. |
| context/tools/image/structured inputs | `gui/src/pages/RoutingProfiles.tsx:1017` | KEEP | These are the minimum meaningful routing simulation inputs. | None. |
| `라우팅 분석` empty panel | `gui/src/pages/RoutingProfiles.tsx:1097` | REMOVE | “No analysis yet” contributes no decision value before a profile has traffic. | Users lose advance awareness that analytics exists; reveal after first data or via details. |
| p50/p95/p99/cooldown/confidence badge wall | `gui/src/pages/RoutingProfiles.tsx:1101` | COLLAPSE-behind-analytics-details | Default view should show success/fallback and anomalies; latency distribution is diagnostic depth. | Performance tuning requires expansion. |

## Models — Compatibility

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| compatibility tab | `gui/src/pages/models-tab-strip.tsx:23` | KEEP | Compatibility evidence prevents unsafe model assumptions. | None. |
| refresh button | `gui/src/pages/CompatibilityMatrix.tsx:460` | KEEP | Evidence freshness is operationally meaningful. | None. |
| community-evidence panel | `gui/src/pages/CompatibilityMatrix.tsx:473` | COLLAPSE-behind-community-evidence | Community information is secondary to local/production evidence. | Users may overlook useful external evidence. |
| status cards | `gui/src/pages/CompatibilityMatrix.tsx:478` | KEEP | They summarize whether compatibility evidence is usable. | None. |
| layer/verdict/subject filters | `gui/src/pages/CompatibilityMatrix.tsx:480` | KEEP | Filtering is necessary for a large evidence matrix. | None. |
| compatibility matrix | `gui/src/pages/CompatibilityMatrix.tsx:520` | KEEP | It is the route’s primary decision surface. | None. |
| second full `verdicts` table | `gui/src/pages/CompatibilityMatrix.tsx:553` | COLLAPSE-behind-list-view | It repeats matrix contents in another representation and doubles page length. | Table-oriented users need to switch views. |
| selected-verdict detail pane | `gui/src/pages/CompatibilityMatrix.tsx:613` | KEEP | Evidence details preserve explainability without crowding every row. | None. |

## Subagents

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `추천 / 모델 / 설정` sticky section tabs | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:78` | KEEP | They organize three related jobs in one long page. | None. |
| instructional sentence mentioning `spawn_agent` | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:97` | COLLAPSE-behind-info-tooltip | It is durable documentation repeated above a self-explanatory ranked list. | First-time users may not understand dual picker/delegation effects. |
| selected 1–5 ranked list | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:105` | KEEP | The order directly changes model preference. | None. |
| separate `저장` button | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:145` | KEEP | It makes a multi-row reorder transaction explicit. | Auto-save would make accidental reorder harder to undo. |
| full available-model list | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:152` | COLLAPSE-behind-모델-chooser | It should not occupy the first viewport once five recommendations are complete. | Adding/removing candidates takes one disclosure action. |
| `먼저 부를 모델` | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:66` | KEEP | It is a clear primary delegation decision. | None. |
| `Codex 설정에도 기본값으로 저장` | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:99` | COLLAPSE-behind-Advanced | Persistence scope is an expert setting. | Users may assume dashboard state applies to new sessions. |
| `일 나누는 방법 알려주기` | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:116` | COLLAPSE-behind-Advanced | Prompt-injection behavior is implementation-level tuning. | Delegation behavior may be harder to explain. |
| `울트라 모드` and custom text editor | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:133` | COLLAPSE-behind-Advanced-policy | It changes broad delegation policy and exposes raw policy text. | Power users need to expand it; active status should remain visible. |

## Logs

Visual evidence is invalid for this route; verdicts below come from source.

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `로그 / 디버그` tabs | `gui/src/pages/Logs.tsx:550` | KEEP | Historical request inspection and live debug capture are distinct jobs. | None. |
| `자동 새로고침` | `gui/src/pages/Logs.tsx:543` | KEEP | Freshness materially changes incident diagnosis. | None. |
| subtitle | `gui/src/pages/Logs.tsx:596` | REMOVE | The table and filters already make the request-log purpose obvious. | Minimal onboarding loss. |
| surface segmented filter | `gui/src/pages/Logs.tsx:598` | KEEP | It is the fastest way to isolate client-specific failures. | None. |
| intercepted-only checkbox | `gui/src/pages/Logs.tsx:621` | COLLAPSE-behind-more-filters | It is a specialized diagnostic predicate. | Shadow-call debugging needs one extra click. |
| conversation and model filters | `gui/src/pages/Logs.tsx:629` | KEEP | They directly narrow incidents and sessions. | None. |
| default table columns: time, model, provider, status, duration | `gui/src/pages/Logs.tsx:732` | KEEP | These answer what ran, where, whether it worked, and how long it took. | None. |
| tokens, tok/s, estimated cost, effort, request ID all visible | `gui/src/pages/Logs.tsx:735` | COLLAPSE-behind-column-picker | Ten default columns exceed routine scan needs; preserve them as optional columns/detail fields. | Performance/cost comparison requires enabling columns. |
| per-row `상세` | `gui/src/pages/Logs.tsx:833` | KEEP | It is the correct disclosure point for route, attempt, usage, and raw data. | None. |
| raw JSON | `gui/src/pages/Logs.tsx:1140` | KEEP | It is already correctly collapsed behind `<details>`. | None. |

## Logs — Debug

Visual evidence is invalid for this route; verdicts below come from source.

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| debug subtitle | `gui/src/pages/debug-settings-panel.tsx:119` | COLLAPSE-behind-help-tooltip | Debug users generally know why they opened the route. | First-time users lose guidance. |
| refresh | `gui/src/pages/debug-settings-panel.tsx:105` | KEEP | Manual re-read is essential when follow is disabled. | None. |
| follow checkbox | `gui/src/pages/debug-settings-panel.tsx:113` | KEEP | It controls live-tail behavior directly. | None. |
| four capture switches | `gui/src/pages/debug-settings-panel.tsx:28` | KEEP | Operators must explicitly choose potentially sensitive or expensive debug streams. | None. |
| reset button | `gui/src/pages/debug-settings-panel.tsx:43` | KEEP | It quickly returns debugging to a safe baseline. | None. |
| second stream selector row | `gui/src/pages/debug-settings-panel.tsx:48` | COLLAPSE-behind-active-stream-dropdown | It duplicates the enabled-stream concepts in another horizontal control group. | Switching streams is one compact selector instead of direct buttons. |
| empty debug explanation | `gui/src/pages/debug-log-viewer.tsx:25` | KEEP | It explains why no log viewer is shown and what must be enabled. | None. |
| live raw log viewer | `gui/src/pages/debug-log-viewer.tsx:43` | KEEP | It is the route’s core diagnostic output. | None. |

## Usage

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| surface and date-range filters | `gui/src/pages/Usage.tsx:811` | KEEP | They define the report being inspected. | None. |
| subtitle | `gui/src/pages/Usage.tsx:815` | COLLAPSE-behind-info-tooltip | The missing-data caveat matters, but not as permanent header copy. | Users may initially assume missing usage is zero. |
| section tabs with counts | `gui/src/pages/Usage.tsx:722` | KEEP | They provide navigation through a long report. | None. |
| requests + measured cards | `gui/src/pages/Usage.tsx:287` | COLLAPSE-behind-coverage-summary | The pair is meaningful mainly for coverage diagnosis, not as two primary KPIs. | Data-quality gaps become less immediately visible. |
| total tokens | `gui/src/pages/Usage.tsx:289` | KEEP | It is the core consumption measure. | None. |
| cache-hit and cache-write cards | `gui/src/pages/Usage.tsx:290` | COLLAPSE-behind-token-breakdown | Cache accounting is optimization detail. | Cache-efficiency analysis takes one extra step. |
| coverage | `gui/src/pages/Usage.tsx:299` | KEEP | It qualifies every aggregate on the page. | None. |
| active days | `gui/src/pages/Usage.tsx:300` | REMOVE | The selected 7/30-day range and heatmap already communicate activity continuity. | Users lose a compact count. |
| API list-price estimate and disclaimer | `gui/src/pages/Usage.tsx:302` | COLLAPSE-behind-cost-estimate | It is explicitly not billing and can dwarf more reliable usage signals. | Cost comparison is less prominent. |
| annual heatmap | `gui/src/pages/Usage.tsx:400` | COLLAPSE-behind-activity-history | It consumes substantial vertical space while rarely affecting proxy operation. | Long-term usage patterns need expansion. |
| models and providers tables | `gui/src/pages/Usage.tsx:691` | KEEP | They answer where consumption occurred. | None. |
| detailed coverage panel | `gui/src/pages/Usage.tsx:707` | COLLAPSE-behind-coverage | Keep the percentage primary; disclose reported/estimated/unreported composition. | Data provenance takes one extra action. |

## Storage

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `다시 스캔` | `gui/src/pages/Storage.tsx:1414` | KEEP | Storage state can change after cleanup and needs explicit refresh. | None. |
| subtitle | `gui/src/pages/Storage.tsx:1419` | KEEP | The promise not to disturb active sessions is an important safety contract. | None. |
| `CODEX_HOME` path and last-scan timestamp | `gui/src/pages/Storage.tsx:1421` | COLLAPSE-behind-scan-details | These are diagnostic metadata rather than cleanup decisions. | Multi-home users must open details to confirm target. |
| bucket rail with size/count | `gui/src/components/storage-workspace/StorageWorkspace.tsx:535` | KEEP | It identifies where disk usage is concentrated. | None. |
| total bytes and files | `gui/src/components/storage-workspace/StorageWorkspace.tsx:614` | KEEP | They establish cleanup scale. | None. |
| repeated home-path summary card | `gui/src/components/storage-workspace/StorageWorkspace.tsx:623` | REMOVE | The same path is already available in page scan details and does not merit a KPI card. | Target path is less visible if scan details are also collapsed. |
| ten largest files | `gui/src/components/storage-workspace/StorageWorkspace.tsx:643` | COLLAPSE-behind-largest-files | File-level paths are diagnostic depth after bucket-level triage. | Manual forensic cleanup needs expansion. |
| bucket oldest/newest timestamps | `gui/src/components/storage-workspace/StorageWorkspace.tsx:575` | COLLAPSE-behind-bucket-details | They are useful for investigation, not the initial storage decision. | Age-based cleanup decisions take one extra action. |
| cleanup policy/quarantine tabs | `gui/src/pages/Storage.tsx:1278` | KEEP | Policy and recoverable deletion are safety-critical capabilities. | None. |
| manual archived-session cleanup | `gui/src/pages/Storage.tsx:1310` | COLLAPSE-behind-manual-cleanup | Automatic policy should be primary; manual cleanup is fallback. | Immediate archive cleanup is one click deeper. |

## Codex Settings

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| `다중 인증 / 프롬프트` tabs | `gui/src/pages/CodexSet.tsx:43` | KEEP | They are unrelated capabilities and should remain separated. | None. |
| `Codex Spark 할당량` | `gui/src/components/codex-account-pool-main-card.tsx:218` | COLLAPSE-behind-account-display-options | It controls visibility of a special quota rather than account operation. | Spark users may overlook the hidden quota. |
| `한도 도달 계정 일시 중지` | `gui/src/components/codex-account-pool-main-card.tsx:234` | KEEP | It is a high-value bulk recovery action. | None. |
| `할당량 새로고침` | `gui/src/components/codex-account-pool-main-card.tsx:242` | KEEP | Quota freshness directly affects routing decisions. | None. |
| account email, plan, next/current, quota bars | `gui/src/components/codex-account-pool-cards.tsx:79` | KEEP | These are the minimum facts needed to manage account rotation. | None. |
| repeated email + plan + truncated account ID line | `gui/src/components/codex-account-pool-cards.tsx:146` | COLLAPSE-behind-account-details | It duplicates the visible identity; raw ID is troubleshooting detail. | Copying an account ID takes one extra action. |
| `별칭 편집` on every row | `gui/src/components/codex-account-pool-cards.tsx:133` | COLLAPSE-behind-row-overflow-menu | It is infrequent and repeats as a prominent button across the pool. | Alias editing takes one extra click. |
| delete `×` | `gui/src/components/codex-account-pool-cards.tsx:136` | COLLAPSE-behind-row-overflow-menu | Destructive account removal should not sit as an unlabeled visual peer to routing controls. | Removal is less immediate but safer. |
| selection-priority control | `gui/src/components/codex-account-pool-cards.tsx:148` | COLLAPSE-behind-routing-details | Most users use defaults; priority is advanced pool tuning. | Priority conflicts may be harder to inspect. |
| explanatory paragraph repeated for each priority selector | `gui/src/components/codex-account-pool-cards.tsx:148` | REMOVE | One shared tooltip/help disclosure is sufficient. | No capability loss if the explanation remains centrally accessible. |

## Integrations

| element | source file:line | verdict | reason | risk |
|---|---|---|---|---|
| page subtitle | `gui/src/pages/Integrations.tsx:133` | COLLAPSE-behind-help-tooltip | The route and client states already communicate the job. | New users lose a short orientation sentence. |
| 18-tab strip | `gui/src/pages/Integrations.tsx:142` | COLLAPSE-behind-client-picker | Showing every supported client before relevance is known is the page’s largest noise source. | Direct one-click navigation to rare clients is lost; hashes must remain supported. |
| overview tab | `gui/src/pages/integrations/integration-tabs.ts:31` | KEEP | It is the appropriate default summary. | None. |
| detected/configured/update counts | `gui/src/pages/integrations/IntegrationsOverview.tsx:517` | KEEP | They summarize actionable integration state. | None. |
| `마지막 변경` | `gui/src/pages/integrations/IntegrationsOverview.tsx:541` | COLLAPSE-behind-history | A timestamp alone rarely changes the next action. | Recent unexpected changes are less glanceable. |
| `모두 해제…` | `gui/src/pages/integrations/IntegrationsOverview.tsx:545` | DEMOTE-to-bulk-actions-menu | A broad destructive mutation should not be a permanent summary-row peer. | Emergency bulk disable takes one extra action. |
| API key row | `gui/src/pages/integrations/IntegrationsOverview.tsx:568` | KEEP | Credentials are a distinct integration prerequisite. | None. |
| onboarding paragraph about backups/provider blocks | `gui/src/pages/integrations/IntegrationsOverview.tsx:571` | COLLAPSE-behind-how-it-works | It is important reference copy, but not a repeated operational decision. | Users may not understand backup behavior before first apply; show it in confirmation. |
| cards for applied or update-needed clients | `gui/src/pages/integrations/IntegrationsOverview.tsx:596` | KEEP | These states require monitoring or action. | None. |
| cards for every uninstalled client | `gui/src/pages/integrations/IntegrationsOverview.tsx:596` | COLLAPSE-behind-add-client | Unsupported/uninstalled clients should be discoverable without dominating routine operation. | Users may not notice a supported integration until opening “Add client.” |
| config filesystem paths on overview cards | `gui/src/pages/integrations/IntegrationsOverview.tsx:596` | COLLAPSE-behind-client-details | Paths are implementation detail useful during troubleshooting. | Manual file verification takes one extra action. |
| rollback history | `gui/src/pages/integrations/IntegrationsOverview.tsx:619` | COLLAPSE-behind-recent-changes | Keep a visible warning/recent reversible operation, but hide normal chronology. | Cross-client audit history becomes less prominent. |

## Top 15 highest-noise removals

1. Remove the Dashboard `Active providers` tab; it duplicates Providers (`gui/src/pages/Dashboard.tsx:56`).
2. Remove the Dashboard `Available models` tab; it duplicates Models (`gui/src/pages/Dashboard.tsx:57`).
3. Replace Integrations’ 18 always-visible tabs with a relevant-client picker (`gui/src/pages/Integrations.tsx:142`).
4. Hide all uninstalled integration cards behind `Add client` (`gui/src/pages/integrations/IntegrationsOverview.tsx:596`).
5. Move repeated per-provider Models controls into a provider action menu (`gui/src/pages/Models.tsx:2192`).
6. Remove GitHub star from persistent navigation (`gui/src/components/sidebar-github-row.tsx:136`).
7. Remove the persistent GitHub repository row (`gui/src/components/sidebar-github-row.tsx:131`).
8. Remove the second full compatibility verdict table from default flow (`gui/src/pages/CompatibilityMatrix.tsx:553`).
9. Remove the empty Routing Analytics panel until data exists (`gui/src/pages/RoutingProfiles.tsx:1097`).
10. Remove `Active days`; the range and heatmap already express it (`gui/src/pages/Usage.tsx:300`).
11. Remove the duplicate Storage home-path KPI card (`gui/src/components/storage-workspace/StorageWorkspace.tsx:623`).
12. Remove the duplicate Combos creation CTA in the zero-combo state (`gui/src/components/ComboWorkspace.tsx:108`).
13. Remove combo search while the combo count is zero (`gui/src/components/ComboWorkspace.tsx:112`).
14. Remove repeated account-priority explanatory copy from every Codex account row (`gui/src/components/codex-account-pool-cards.tsx:148`).
15. Remove generic page subtitles where the title and primary surface already communicate the job, beginning with Dashboard and Logs (`gui/src/pages/Dashboard.tsx:80`, `gui/src/pages/Logs.tsx:596`).

## Explicitly do not touch

- Runtime offline/error states and retry actions: they carry immediate recovery value.
- Startup protected/at-risk status and remediation: this prevents reboot-time routing failures.
- Provider attention/reauthentication indicators: exceptions are exactly what the minimal UI should emphasize.
- Model visibility toggles and stale-catalog warning: these directly determine what Codex can select.
- Combo target ordering and strategy: collapsing these would hide the combo’s actual behavior.
- Routing dry-run inputs and result evidence after a profile is selected.
- Log status, model, provider, time, duration, and row detail disclosure.
- Usage coverage percentage: aggregates without provenance are misleading.
- Storage quarantine and confirmation flows: recoverability and destructive-action safety outrank visual minimalism.
- Codex account quota, current/next account, pause, and reauthentication controls.
- Integration applied/update-needed/conflict states and confirmation dialogs.
- Accessibility semantics already present in tabs, disclosures, dialogs, focus restoration, and icon labels.

REVIEWER: claude-fable-5-1



## R2 — full review

I have everything I need. Writing up the full review now.

# Dashboard minimalism review — opencodex GUI @ 664d80c76

**Evidence caveat first.** Four of the sixteen text/interactive captures are byte-identical duplicates of other routes, so those pages were never actually captured. `models_compatibility_text.txt` == `usage_text.txt` (md5 `9c6df39d…`), `subagents_text.txt` == `storage_text.txt` (`2052bcf5…`), `logs_text.txt` is the Codex-Set multi-auth page, and `logs_debug_text.txt` == `integrations_text.txt` (`afd25efb…`). The `_interactive.txt` dumps for those four *are* correct, and I verified the mismatch against the PNGs. Verdicts for Compatibility, Subagents, Logs, and Debug are therefore grounded in source + interactive refs, not screenshots — worth recapturing before anyone acts on them.

My operator model throughout: someone running a local proxy who needs to answer *is it up, is my traffic going where I think, am I about to hit a limit, and how do I fix it*. Everything else is reference material and should be one click away, not on the page.

## Sidebar and topbar

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `opencodex` + `v2.42.0` brand | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:246) | KEEP | Version is the single most-asked support question and it is live from `/healthz`. | none |
| 9 nav rows (대시보드…연동) | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:62) | KEEP | One row per page, already deduplicated once. | none |
| 언어 `Select` in footer | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:325) | DEMOTE-to-icon-menu | A locale is set once per install and then occupies a full-width footer row forever. | Discoverability drops for first-run users; keep it in the same footer cluster as theme. |
| 시스템 / theme toggle | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:335) | COLLAPSE-behind-icon-only | Same argument, and the `mode` word adds nothing the icon does not. | Screen-reader label already exists on the button; keep it. |
| `프록시` label + stop/restart orbs | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:339) | KEEP orbs, REMOVE label | The two orbs are the only destructive controls in the shell and must stay reachable; the word "프록시" above them is decoration. | Orbs already carry `aria-label` + `title`, so nothing is lost. |
| GitHub link row | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:132) | DEMOTE-to-footer-icon | A repo link is not an operating control; it currently gets equal weight to the proxy kill switch. | None — the same URL is the star button's fallback. |
| ★ star orb | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:136) | REMOVE from chrome | This is a promotion ask polling `gh` every 5 min on every page; it carries zero operator value. Note `AGENTS.md` treats starring as a user-consent action, which reinforces that it should not be ambient UI. | Maintainer loses a star funnel. Keep the action inside the update dialog if it must live somewhere. |
| ⬇ update orb + dot | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:147) | KEEP | "Am I current?" is a real operator question and the dot is the only ambient signal for it. | none |
| Mobile topbar duplicate orbs | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:264) | KEEP | Sidebar is off-canvas at that width; these are not duplicates in practice. | none |

## Dashboard — 개요

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| "대시보드" h2 + subtitle | [Dashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Dashboard.tsx:78) | REMOVE subtitle | The sidebar row is already highlighted; the sentence restates the product description. | Nothing; the h2 stays. |
| 개요 / 활성 프로바이더 / 사용 가능한 모델 tabs | [Dashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Dashboard.tsx:54) | COLLAPSE-behind-Providers-and-Models-pages | Both tabs are strictly-poorer copies of full pages that already exist in the sidebar (see the two sections below). | Loses a same-page glance; the counts stay in the stat row. |
| 서브에이전트 `v1 / base / v2` radio group | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:52) | DEMOTE-to-Subagents-page | A three-way mode switch is the highest-consequence control on the page and it is sitting in a stat cell shaped like a read-only metric. The identical control already exists on Models. | Users who learned it here must relearn; mitigate by leaving the resolved mode as text. |
| ⓘ next to 서브에이전트 | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:37) | KEEP | The modes are genuinely non-obvious; this is disclosure done right. | none |
| 상태 / 온라인 | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:73) | KEEP | The reason the page exists. | none |
| 버전 `2.42.0` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:79) | REMOVE | Byte-identical to the sidebar brand version 200px away, from the same `/healthz`. | none |
| 가동 시간 `1시간 42분` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:80) | DEMOTE-to-tooltip-on-상태 | Uptime only matters when it is *short* (did it crash?); as a standing number it is trivia. | A restart-detector loses a glance; the tooltip keeps it. |
| 프로바이더 `9` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:81) | KEEP | Cheap, and a drop to 0 is diagnostic. | none |
| 토큰 (30일) + 커버리지 99% | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:82) | KEEP value, DEMOTE coverage | 51.5B tokens is a real signal; "커버리지 99%" is a measurement-quality caveat that belongs on Usage where it is already explained in full. | Users misreading totals as exact; keep coverage as a tooltip. |
| 재부팅 보호 health bar | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:95) | KEEP | Highest-value row on the page: one line, actionable, deep-links to Startup. | none |
| 프로젝트 설정 경고 block | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:116) | KEEP | Conditional and only renders when broken. | none |
| 서브에이전트 위임 / 없음 / 설정 열기 | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:120) | DEMOTE-to-Subagents-page | A whole panel whose steady state is "없음" plus a link to the page that owns it. | The link is the only affordance lost; the sidebar row replaces it. |
| 모델 동기화 + hint + 지금 동기화 | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:206) | KEEP button, REMOVE hint | Sync is a genuine recurring action; the two-line explanation is read once. | Move the hint to the button's `title`. |
| Codex 실행 시 opencodex 시작 toggle + 2-line hint | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:487) | DEMOTE-to-Startup-page | Its own hint tells you to go verify on Startup — that is the page that owns launch behaviour, and it already renders the shim row. | Two places to change one setting becomes one; bookmark holders lose nothing. |
| 웹 검색 사이드카 card | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:509) | COLLAPSE-behind-고급 disclosure | Set once at install; occupies a permanent half-width card thereafter. | Rarely-changed setting gets one extra click. |
| 응답 실시간 스트리밍 toggle | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:533) | COLLAPSE-behind-same | Sub-setting of a set-once setting. | none beyond the above |
| 비전 사이드카 card + effort | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:549) | COLLAPSE-behind-same | Same lifecycle as web search; pair them in one "사이드카" section. | none |
| 고급 설정 popover (max/timeout) | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:588) | KEEP | Already correctly collapsed. | none |
| 쉐도우 호출 가로채기 panel | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:626) | REMOVE (duplicate) | The identical toggle + model select + ⓘ + `⚠ 5.6-luna` badge is rendered on Models at [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1594). Two live editors for one setting is a consistency bug waiting to happen. | Dashboard-only users lose the control; Models is the honest home since it is about model rewriting. |
| 추론 상한 panel | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:37) | COLLAPSE-behind-고급 | Conditional on v2 already, but still a full panel for two rarely-touched selects. | none |
| 메모리 관찰 card (whole) | [dashboard-overview-panels.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-panels.tsx:21) | COLLAPSE-behind-single-pressure-row | This is developer telemetry on the operator's home screen. It polls every 5s and renders RSS, JS heap, JSC heap, arena, and a growth rate. | Leak-hunting gets slower; keep the pressure bar + 상세 정보 so every number stays reachable. |
| 진행 중 요청 `3` | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:425) | DEMOTE-to-overview-stat-row | This is the one genuinely operator-facing number in the card — it belongs next to 상태, not inside a memory panel. | none if relocated |
| 작업 완료 후 재시작 button | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:431) | KEEP | Drain-and-restart is materially different from the sidebar stop orb and is confirm-gated. | none |
| rss / 임계값의 28% pressure bar | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:443) | KEEP | The one memory fact with a threshold attached, so the only one that is actionable. | none |
| 상주 메모리 / JS 힙 / JSC 힙 / 시간당 변화 | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:451) | COLLAPSE-behind-상세-정보 | Four monospace byte counts nobody acts on; the growth tone already escalates into the pressure bar. | Move them into the existing `<details>` at line 470 — zero capability lost. |
| 상세 정보 `<details>` | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:470) | KEEP | Model example for the rest of the page. | none |

## Dashboard — 활성 프로바이더 tab

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| Whole tab (9-row table) | [dashboard-providers-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-providers-section.tsx:20) | REMOVE | The Providers page shows the same nine providers *plus* quota bars, attention list, and per-provider actions. This tab is a read-only subset with no path to act on anything in it. | Loses a compact table; add an "adapter/baseURL" column toggle to the Providers rail if anyone misses it. |
| `Base URL` column | [dashboard-providers-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-providers-section.tsx:28) | DEMOTE-to-provider-detail | Raw endpoint URLs are configuration trivia except when debugging a specific provider — which is exactly when you are in its detail view. | Local-endpoint users (`http://100.100.125.116:8081/v1`) lose an at-a-glance check. |
| `어댑터` chip column | [dashboard-providers-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-providers-section.tsx:27) | DEMOTE-to-provider-detail | `openai-responses` vs `openai-chat` matters at setup time only. | same |

## Dashboard — 사용 가능한 모델 tab

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| Whole tab | [dashboard-models-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-models-section.tsx:27) | REMOVE | Shows 96 models grouped by provider with a search box — the Models page shows the same grouping with visibility toggles, aliases, caps, and per-model detail. | Loses a read-only browser; the `96` count survives in the stat row. |
| 모델 검색 input | [dashboard-models-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-models-section.tsx:39) | REMOVE with tab | Duplicate of the Models rail. | none |

## 시작 안전성 (startup)

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 시작 안전성 h2 + subtitle | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:321) | KEEP | Genuinely non-obvious page; the subtitle earns its line here. | none |
| 대시보드로 돌아가기 | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:325) | REMOVE | The sidebar is permanently visible and has a 대시보드 row. This is a back button in an app with no back problem. | Deep-linked arrivals lose one click; browser Back still works. |
| 새로고침 | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:328) | KEEP | State changes out-of-band after `ocx service repair`. | none |
| Codex runtime clamp notice | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:366) | KEEP | Conditional, explains a live capability loss, ships its own fix command. | none |
| 재부팅 보호됨 hero + h3 + detail | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:44) | KEEP badge, COLLAPSE prose | Badge + heading + paragraph say the same thing three times when green. | Keep the paragraph for `at-risk`/`error` where it carries the diagnosis. |
| Codex 라우팅 / 재부팅 보호 / 필요 시 자동 시작 grid | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:59) | COLLAPSE-behind-보호-상태-상세 | Three stats that restate the hero when protected. | Nothing if folded into the details panel below them. |
| 보호 상태 상세 + `darwin` | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:99) | KEEP | Per-mechanism status with install/repair buttons — the actionable core. | none |
| 백그라운드 서비스 / shim hint lines | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:105) | DEMOTE-to-tooltip | One-line explanations under labels whose badges already say 사용 가능 / 설치되지 않음. | Novices lose inline context; `title` retains it. |
| 복구 방법 section (3 copy blocks) | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:237) | COLLAPSE-behind-`<details>` | Manual fallback for the one-click buttons directly above; its own intro paragraph says so. | Users on locked-down shells still get it, one click in. |
| `ocx restore` row | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:264) | KEEP inside that details | The escape hatch out of the proxy entirely — must never become hard to find. | Keep it last, not hidden behind a second layer. |
| Windows tray section | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:159) | KEEP | Already platform-gated to `win32`. | none |

## 프로바이더

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 프로바이더 h2 + 프로바이더 추가 | [Providers.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Providers.tsx:319) | KEEP | Primary action, correctly placed. | none |
| Rail search + filter popover | [ProviderWorkspaceShell.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:382) | KEEP search, COLLAPSE filter | Search earns its place at 9+ providers; the filter is already behind a popover. | none |
| Sort: 5 modes (az/za/free-paid/paid-free/accounts-first) | [ProviderWorkspaceShell.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:50) | REMOVE 3 of 5 | Five sort orders for a nine-item list. `za` and `paid-free` are pure inversions nobody asks for. | Keep az + accounts-first; loses ordering nobody exercises. |
| Type filter (cloud/local/selfHosted/login) | [ProviderWorkspaceShell.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:432) | REMOVE | Four-way taxonomy over nine rows that the user can already see. | Large installs lose a facet; status + pricing filters remain. |
| 프로바이더 개요 title + "모든 모델 프로바이더를 한곳에서 관리합니다" | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:100) | REMOVE both | A second page title inside a page that already has "프로바이더" as its h2, plus a tagline. | none |
| JSON 편집 | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:104) | KEEP | Escape hatch for anything the UI cannot express. | none |
| 준비됨 8 / 설정 필요 0 / 비활성 1 cards | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:110) | REMOVE | The rail immediately left shows `준비됨 8`, `비활성 1` as group headers with the same counts. Three large cards restating adjacent headers. | The zero-state "설정 필요 0" disappears — which is the point, since zero needs no card. |
| 사용량 제한 quota rows | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:147) | KEEP | The single highest-value block in the entire dashboard for a multi-account operator. | none |
| `방금 전 전 확인` meta | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:166) | DEMOTE-to-tooltip | Per-row freshness stamp on every provider; also note the visible ko double-particle bug ("전 전"). | Stale-quota detection moves to hover. |
| OpenAI 보정/커버리지 caveat lines | [ProviderCapacityQuota.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderCapacityQuota.tsx) | COLLAPSE-behind-ⓘ | Two full sentences of estimation methodology under one provider's bars. | Users may over-trust the pooled estimate; the ⓘ must stay adjacent to the number. |
| 최근 사용 (4 rows) | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:196) | DEMOTE-to-Usage | Request counts are a usage question, and Usage shows all 19 providers instead of the top 4. | Loses a shortcut into a provider from a usage ranking. |

## 모델 — 카탈로그

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 모델 h2 + restart orb | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2204) | KEEP | Catalog changes need a Codex re-read; the orb is the fix. | none |
| Stale-catalog banner + 새로고침 | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2215) | KEEP | Conditional and directly actionable. | none |
| Tab strip 모델/콤보/라우팅(beta)/호환성 | [models-tab-strip.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/models-tab-strip.tsx:65) | KEEP strip, DEMOTE 호환성 | Compatibility Lab is opt-in by architecture (`AGENTS.md`) yet takes a permanent quarter of the strip. | Lab users need one more click; put it behind an overflow or the Lab activation. |
| 5-line catalog subtitle | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2226) | COLLAPSE-behind-ⓘ | Explains toggling, hiding, direct-id calls, and cache invalidation — a paragraph of documentation above the controls. | Genuinely useful once; keep every word in the popover. |
| 새 모델을 비활성 상태로 추가 | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1586) | KEEP | Real policy decision with security-ish consequences. | none |
| 별칭 button + table | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1592) | KEEP | Already collapsed behind a toggle. | none |
| 쉐도우 호출 가로채기 row | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1594) | KEEP (canonical) | This is where it should live; delete the Dashboard twin instead. | none |
| 서브에이전트 v1/base/v2 row | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1603) | DEMOTE-to-Subagents | Third rendering of one mode switch (Dashboard, Models, Subagents). Pick one owner. | Two entry points collapse to one; state is server-side so nothing diverges. |
| 기본 창 / 상한 + 5-line hint | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1706) | KEEP control, COLLAPSE hint | The 350k default genuinely governs behaviour; the paragraph explaining relay `context_length` is reference. | Misconfiguration risk if the hint is fully removed — use ⓘ, not deletion. |
| 커스텀 2개 chip | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1744) | REMOVE | A count of custom models with no link and no action. | none |
| 피커 순서 hint (ⓘ + 3-line) | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1752) | COLLAPSE-behind-ⓘ | Explains sort precedence that the list already demonstrates. | none |
| 모두 접기 / 모두 펼치기 | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1759) | KEEP | Earns its place at 8 provider groups. | none |
| Per-provider 기본 별칭 사용 switch (×8) | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1591) | COLLAPSE-into-provider-card-overflow | Eight repetitions of a set-once toggle in the densest header row in the app. | Bulk alias changes get slower; the global switch stays visible. |
| Per-provider 모두 켜기/끄기 | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1342) | KEEP | The fastest way to go from 40 Cursor models to 6. | none |
| Per-provider 기본 창/상한 + 사용자 지정 창 | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1350) | KEEP switch+select, COLLAPSE 사용자 지정 창 | Per-model overrides are a modal-worthy minority case; note the source comment already argues for the occupied slot, so keep the switch/select pair. | Per-model context tuning gets one click deeper. |
| `1,048,576` raw values | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1367) | KEEP but format | Four providers show `1,048,576` while others show `1M` / `350k` for the same kind of number. | Formatting only — no capability. |
| 새 모델 정책 끔/켬 + full model id list | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1420) | COLLAPSE-behind-provider-expand | On kimi and meta-muse this dumps nine fully-qualified ids into the header area. | The ids stay in the expanded body where they belong. |

## 모델 — 콤보

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 콤보 `0` + 콤보 추가 (×3 buttons) | [combo-workspace-overview-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-overview-panel.tsx:44) | REMOVE 2 of 3 | The empty state renders "콤보 추가", "콤보 추가", "콤보 만들기" — three buttons for one action. | none |
| 4 count pills (total/failover/roundRobin/other) | [combo-workspace-overview-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-overview-panel.tsx:49) | COLLAPSE-when-zero | Four pills all reading 0 on a fresh install. | none when non-empty — keep them then. |
| 콤보 소개 blurb + 사용법 section | [combo-workspace-overview-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-overview-panel.tsx:47) | COLLAPSE-behind-ⓘ | Two separate explanatory blocks (`overviewBlurb`, `howBody`) for one feature. | Keep one in the empty state only. |
| Per-field helper text (콤보 ID, 공개 모델 이름, 표시 이름, 전략, 기본 추론 수준) | [combo-workspace-controls.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-controls.tsx:79) | COLLAPSE-to-placeholder-and-tooltip | Every single field carries a sentence; the create form is more prose than form. | Novice error rate may rise; keep the two non-obvious ones (전략, 적응형 추론) inline. |
| 적응형 추론 단계 2-sentence hint | [combo-workspace-controls.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-controls.tsx:143) | KEEP | Genuinely unguessable behaviour. | none |
| 할당량 알 수 없음 placeholder | [combo-workspace-controls.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-controls.tsx:294) | REMOVE-until-known | Renders before a provider is even picked. | none |

## 모델 — 라우팅 (beta)

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `+ 프로필 만들기` / 재시도 pair | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:616) | REMOVE 재시도 | An unconditional retry button next to the create action, with no error present. | Error-state retry must remain; make it conditional on `loadError`. |
| 드라이런 평가 form (4 fields) | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:585) | COLLAPSE-behind-`<details>` | A simulator rendered at full size on a page with zero profiles. | Profile authors click once more. |
| 라우팅 분석 empty state | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:621) | KEEP | Correct empty-state copy, one line. | none |
| 6 fieldsets (candidates/require/optimize/limits/unknownEvidence/compatibility) | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:681) | COLLAPSE 4 of 6 | Candidates + require are the profile; optimize, limits, unknown-evidence, and compatibility-gating are expert tuning. | Advanced authors get a disclosure; nothing is removed. |
| `revision` badges (×2) | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:638) | DEMOTE-to-detail-only | Shown on both the list row and the detail header. | none |

## 모델 — 호환성 (Lab)

Reviewed from source and refs; screenshot missing.

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| Whole tab | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2322) | DEMOTE-behind-Lab-activation | `AGENTS.md` states Lab is opt-in and must not touch the core path; the UI contradicts that by advertising it to every user. | Lab users lose a top-level tab; gate it on the same activation flag the runtime uses. |
| 4 status cards (subject/verdict/observation/event counts) | [CompatibilityMatrix.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CompatibilityMatrix.tsx:135) | REMOVE | Internal projection cardinality — meaningless to an operator. | Lab developers lose a health readout; keep it in the detail pane. |
| 3 `전체` filter selects | [CompatibilityMatrix.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CompatibilityMatrix.tsx:436) | KEEP | The matrix is unusable unfiltered. | none |
| 프로덕션 관측 block + "검증이 아닙니다" | [CompatibilityMatrix.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CompatibilityMatrix.tsx:209) | KEEP | The disclaimer is load-bearing; without it these numbers read as verdicts. | none |

## 서브에이전트

Reviewed from `subagents_interactive.txt` + source; screenshot missing.

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 추천 5/5, 모델 21, 설정 tabs | [Subagents.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Subagents.tsx:210) | KEEP | Three genuinely different jobs. | none |
| Per-row 위로/아래로/삭제 (×5 = 15 buttons) | ref `e61`–`e93`, [SubagentsWorkspace.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx) | COLLAPSE-to-drag-plus-hover | Fifteen always-visible buttons to order five items. | Keyboard users must keep the arrows — reveal on focus, not hover alone. |
| 저장 button | ref `e95` | KEEP | Explicit commit for a reorder. | none |
| 21 추천 추가/제거 buttons | ref `e101`–`e161` | KEEP | This is the tab's whole purpose. | none |
| 서브에이전트 위임 select + 일 나누는 방법 알려주기 + 울트라 모드 | ref `e166`–`e174` | KEEP | Canonical home for delegation once the Dashboard and Models copies are demoted here. | none |
| `Codex 설정에도 기본값으로 저장` | ref `e170` | KEEP | Cross-writes real Codex config; must stay explicit. | none |

## 로그&디버그

Reviewed from source + refs; screenshot missing (capture shows Codex Set).

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 로그 / 디버그 tabs | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:550) | KEEP | Two distinct surfaces. | none |
| 자동 새로고침 checkbox | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:544) | KEEP | 2s polling must be defeatable while reading. | none |
| Page subtitle | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:596) | REMOVE | A table of requests needs no caption. | none |
| Surface filter all/claude/codex/grok | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:600) | KEEP | Primary triage axis. | none |
| 가로챈 헬퍼만 checkbox | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:621) | COLLAPSE-behind-filter-popover | Narrow debugging facet occupying permanent toolbar width. | Shadow-call debugging gets one click deeper. |
| 대화 + 모델 filter inputs | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:629) | KEEP | Two text filters is the right number for a log table. | none |
| Detail modal: 8 sections incl. 원본 JSON | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:933) | KEEP | On-demand by definition, and raw JSON is already in `<details>`. | none |
| 비용 section disclaimer, repeated per row | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:1028) | DEMOTE-to-section-tooltip | Same disclaimer appears on Usage and in every log detail. | Legal/accuracy framing weakens slightly; keep it on Usage in full. |

## 사용량

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 전체/Codex/Claude/Grok + 30일/7일 filters | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:223) | KEEP | The two axes of the report. | none |
| Page subtitle | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:815) | KEEP | The "누락된 사용량은 0으로 표시하지 않습니다" clause changes how you read every number below. | none |
| SectionTabs 개요/모델/프로바이더/커버리지 | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:722) | KEEP | Scroll-to anchors, not panel swaps. | none |
| 요청 / 측정됨 side-by-side | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:287) | COLLAPSE-to-one | `231928` and `229025` differ by 1.2%; two cards to express one number and its caveat. | Show `231928` with measured-count on hover. |
| 커버리지 99% card | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:299) | REMOVE | Third restatement of the same measurement-quality fact (card, tab meta, and a whole 커버리지 상세 section). | The dedicated section keeps every number. |
| 캐시 히트 토큰 + 캐시 생성 sub | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:290) | KEEP | Cache ratio is the main cost lever on this workload. | none |
| 활동일 `30` | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:300) | REMOVE | On a 30-day range this reads `30` for any regular user, and the heatmap below shows activity per day. | none |
| API 정가 환산치 + 2 disclaimers | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:302) | KEEP | ~$39k is the most attention-grabbing figure in the app; the disclaimers are mandatory next to it. | none |
| 일별 활동 heatmap (13-month) | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:406) | DEMOTE-to-7d/30d-window | A year-wide grid where the screenshot shows ~4 populated columns and twelve months of empty dots. | Long-history users lose the annual view; make the range control drive the heatmap span. |
| 모델 table, 66 rows | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:696) | COLLAPSE-to-top-15-plus-더보기 | The tail is `770`, `227`, `59`, `41`, `38`, `19`, `1` tokens — and `no-such-model` / `unpriced-model` test rows. | Nothing if 더보기 reveals the rest; search already exists. |
| Rows with 0 measured / 0 tokens | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:792) | COLLAPSE-behind-"측정 안 됨" toggle | ~15 rows contributing nothing to any total. | Probe-failure debugging needs them; keep them one toggle away. |
| 프로바이더 table (19) | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:704) | KEEP | Short enough to read whole. | none |
| 커버리지 상세 5 cards + note | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:622) | KEEP | Once the duplicates above are gone, this is the single canonical home. | none |
| 미지원 `0` card | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:627) | COLLAPSE-when-zero | A card whose only value is zero. | none

Now the final three route tables and the ranked lists.

## 저장소

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 저장소 h2 + 다시 스캔 | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1408) | KEEP | Disk state changes outside the app. | none |
| Page subtitle | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1419) | KEEP | "정리는 활성 세션을 건드리지 않습니다" is a safety promise before a destructive action. | Removing it would make cleanup scarier, not cleaner. |
| `codexHome` path + 마지막 스캔 timestamp | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1421) | DEMOTE-to-tooltip | Two facts on a meta line; the path already has a `title` attribute. | Multi-home operators lose a glance — keep the path, drop the timestamp. |
| Cleanup percent slider + 미리보기 | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:246) | KEEP | Preview-before-delete is the correct shape for a destructive control. | none |
| 정리 도움말 paragraph | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:241) | COLLAPSE-behind-ⓘ | Third explanatory block on a page that already has a subtitle and a confirm dialog. | The confirm dialog retains the consequential wording. |
| 영구 삭제 toggle + warning | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:314) | KEEP | Irreversible-vs-quarantine is the single most important choice on the page. | none |
| Quarantine/restore panel | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1461) | KEEP | The undo path for the above. | none |

## Codex 설정 (codex-set)

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 다중 인증 / 프롬프트 tabs | [CodexSet.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CodexSet.tsx:43) | KEEP | Unrelated surfaces, lazily mounted. | none |
| `OpenAI 계정 모드` banner (renders empty) | [codex-set-multiauth.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/codex-set-multiauth.tsx:28) | REMOVE-when-empty | In the capture this is a titled card with no body and no badge — pure vertical space. | When pool/direct badges exist it is meaningful; render only then. |
| 한도 도달 계정 일시 중지 / 할당량 새로고침 | [codex-account-pool-main-card.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/codex-account-pool-main-card.tsx:240) | KEEP | Two bulk actions over six accounts. | none |
| `선택 순서 · 기본 (0)` + 3-line hint, per account (×6) | [AccountPriorityControl.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/AccountPriorityControl.tsx:35) | COLLAPSE-to-control-plus-one-tooltip | The identical three-sentence explanation is repeated under every account card. Six copies of one paragraph. | None — one ⓘ at the pool header covers all rows. |
| `ID: account-…8327` | [codex-account-pool-main-card.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/codex-account-pool-main-card.tsx:138) | DEMOTE-to-tooltip | A truncated opaque id that cannot be copied or acted on. | Support debugging — make it copyable in the tooltip instead. |
| `리셋 크레딧 1개` badges | ref `e62`, `e81`, `e98` | KEEP | Real consumable state. | none |
| 이 계정을 다음에 사용 / 일시 중지 / 별칭 편집 / 삭제 (×5 accounts) | ref `e66`–`e141` | COLLAPSE-to-overflow-menu | ~20 always-visible buttons; only "다음에 사용" is routinely clicked. | Keep 다음에 사용 inline, move 별칭/삭제 into a ⋯ menu — nothing removed. |
| Per-account quota bars | ref `e72`ff | KEEP | The actual decision input for which account to pin. | none |
| 로테이션 전략 + 3 explanation lines | [AccountPoolStrategyControls.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/AccountPoolStrategyControls.tsx:71) | KEEP select, COLLAPSE 2 of 3 lines | `strategyDesc` is needed; `unboundDefinition` and the quota-rebinding caveat are reference. | Subtle rebinding behaviour becomes less discoverable — keep it in the ⓘ. |
| 고급 설정 | ref `e151` | KEEP | Correct disclosure. | none |

## 연동 (integrations)

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| 연동 h2 + subtitle | [Integrations.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Integrations.tsx:131) | KEEP h2, REMOVE subtitle | The tab strip and cards below make the purpose self-evident. | none |
| 18-tab strip (개요…Aside) | [Integrations.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Integrations.tsx:142) | DEMOTE-to-detail-from-card | Eighteen tabs across one row for clients where the detected count is 0. The card grid below already lists all 17 with 설정 buttons — the strip is a second, redundant navigation for the same set. | Direct-hash bookmarks must keep working; route card clicks to the same panels. |
| Client marks on tabs | [Integrations.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Integrations.tsx:160) | KEEP | If the strip survives, the logos are what makes 18 labels scannable. | none |
| 감지된 0 / 설정된 0 / 업데이트 필요 0 / 확인 중 17 / 마지막 변경 알 수 없음 | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:519) | COLLAPSE-to-2-cards | Five summary cards of which three read 0 and one reads 알 수 없음. Keep 감지됨 and 설정됨. | Stale-count visibility drops; surface it as a badge only when non-zero. |
| `확인 중` × 17 rows | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:537) | KEEP as skeleton | Transient probe state, not permanent copy. | none — but it should look like a skeleton, not a value. |
| 모두 해제… | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:551) | KEEP | Bulk rollback for a config-writing feature. | none |
| 키 관리 explanation paragraph | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:568) | KEEP | Describes backup/restore semantics before the app edits user config files. | Removing it would hide a real consequence. |
| 온보딩 line | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:571) | COLLAPSE-to-empty-state-only | Redundant once any client is configured. | none |
| 복원 센터 heading rendered twice | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:619) | REMOVE one | The capture shows "복원 센터 / 복원 센터" — the section title and its skeleton label both render. Looks like a bug. | none |

## Top 15 highest-noise removals, ranked

1. **메모리 관찰 card body** — [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:451). Four byte counts + growth rate polling every 5s on the home screen. Collapse into the existing `<details>`; keep the pressure bar, in-flight count, and restart.
2. **Dashboard 활성 프로바이더 tab** — [dashboard-providers-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-providers-section.tsx:20). A read-only subset of the Providers page with no way to act.
3. **Dashboard 사용 가능한 모델 tab** — [dashboard-models-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-models-section.tsx:27). Same, for Models.
4. **Duplicate 쉐도우 호출 가로채기 panel** — [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:626). Two live editors for one server setting; Models is the honest home.
5. **Third copy of the v1/base/v2 mode switch** — [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:52) and [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1603). Consolidate on Subagents.
6. **Integrations 18-tab strip** — [Integrations.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Integrations.tsx:142). Duplicate navigation for a card grid that is already complete.
7. **Providers 3 summary cards** — [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:110). Restates the rail group headers 200px to the left.
8. **Per-account 선택 순서 hint ×6** — [AccountPriorityControl.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/AccountPriorityControl.tsx:35). One paragraph printed six times.
9. **Usage 커버리지 99% card + 활동일** — [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:299). Coverage appears four times on one page; 활동일 is tautological on a 30d range.
10. **Usage model-table tail (~50 rows)** — [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:696). Rows down to 19 tokens, including obvious test fixtures.
11. **13-month heatmap** — [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:406). Mostly empty; should follow the range control.
12. **Models 5-line catalog subtitle + 피커 순서 hint + 커스텀 chip** — [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2226). Documentation stacked above the controls.
13. **Startup 3-stat grid + 대시보드로 돌아가기** — [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:59). Restates the hero; back button in a permanent-sidebar app.
14. **Sidebar star orb + GitHub row weight** — [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:136). Promotion ask polling `gh` every 5 minutes, at parity with the kill switch.
15. **Integrations 3 zero-valued summary cards + duplicated 복원 센터 heading** — [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:519).

## What I would not touch

- **The 재부팅 보호 health bar** ([dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:95)) — one line, one dot, deep-links to the fix. This is the best-designed element in the app.
- **Provider quota bars** ([ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:147)) and per-account quota bars — for a nine-provider, six-account operator these answer the only question that changes behaviour today.
- **`ocx restore`** ([startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx:264)) — the exit from the proxy. May go inside a disclosure, never behind two.
- **Cost disclaimers next to the ~$39k figure** ([Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:302)) and the Lab "검증이 아닙니다" note ([CompatibilityMatrix.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CompatibilityMatrix.tsx:210)) — a number that will be misread without its caveat is worse than no number.
- **Storage 영구 삭제 toggle, preview, and quarantine panel** ([Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:314)) — destructive-action ceremony is not noise.
- **The sidebar stop/restart orbs** ([App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:349)) — the only always-available controls for a runaway proxy.
- **JSON 편집** ([ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:104)) — every hidden control needs an escape hatch, and this is it.
- **Conditional notices** — project-config warnings, catalog clamp, `historyTruncated`, stale-catalog banner. They cost nothing when things are fine and are the whole product when they are not.

Two structural notes beyond the tables. First, the recurring pattern is *duplication across pages*, not verbosity within a page: shadow-call, the multi-agent mode switch, coverage, model lists, and provider lists each render in two or three places, and each pair is a state-divergence bug waiting to be filed. Deduplicating those alone removes more surface than any amount of tightening. Second, the empty states are the worst offenders — Combos with three "add" buttons and four zero-pills, Integrations with three zero-cards, Routing with a full dry-run simulator and no profiles. A zero-valued card is the highest-noise element type in this GUI, and a single "hide when zero" convention would clear a lot of it.

I made no edits and ran no tests, per the read-only scope. No skill influenced these verdicts; the `AGENTS.md` Lab-is-opt-in invariant and the user-consent rule on starring are cited above because they support two specific calls (호환성 tab, star orb).

REVIEWER: claude-opus-5

## R3 — full review


Read-only review at `664d80c76`. Evidence pack caveat: `logs_1440` / `logs_*.txt` captured Codex 설정, and `models_compatibility_1440` / its text files captured 사용량. Those two routes are scored from source plus the other screenshots. Sidecars/memory that the dashboard PNG cropped still appear in the full-page text dump.

Operator test used throughout: does this help decide “is the proxy up, which provider/model is live, and what do I change if it isn’t?” If not, it should leave the first viewport.

## Sidebar + topbar

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `opencodex` + `v2.42.0` | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:246) | KEEP | Instant “am I on the running proxy?” | Losing version makes support/upgrade harder |
| `대시보드` / `Codex 설정` / `프로바이더` / `모델` / `서브에이전트` / `로그&디버그` / `사용량` / `저장소` / `연동` | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:62) | KEEP | This is the product IA | Collapsing nav hides whole workspaces |
| `한국어` | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:323) | DEMOTE-to-settings-popover | Locale is set-once, not an ops decision | Harder first-run locale switch |
| `시스템` theme | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:335) | DEMOTE-to-same-popover | Theme is preference, not proxy state | Extra click for light/dark |
| `프록시` stop | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:349) | KEEP | Only global kill switch | Hiding it delays emergency stop |
| `Codex 모델 목록 새로고침` orb | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:355) | KEEP | Needed when Codex is stale; keep one global copy | Operators on Models lose a fallback if both page copies go |
| `GitHub` link | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:132) | DEMOTE-to-overflow/`…` | Repo browsing is not a proxy decision | Slightly slower issue/PR hop |
| `GitHub 스타 완료` | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:136) | COLLAPSE-behind-GitHub-menu | Consent/marketing chrome on every page | One extra click to star |
| `업데이트 확인` | [sidebar-github-row.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/sidebar-github-row.tsx:147) | DEMOTE-to-badge-only-when-available | Idle “check update” is noise; a pending-version dot is the decision | Missed updates if badge poll is stale |
| Mobile hamburger + duplicated orbs | [App.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/App.tsx:257) | KEEP | Narrow-screen chrome, not 1440 noise | Breaks phone/drawer use |

## Dashboard / overview

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| subtitle `로컬 opencodex 프록시와…` | [Dashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/Dashboard.tsx:80) | REMOVE | Restates the nav label; no decision | New users lose a one-line explainer |
| tabs `개요` / `활성 프로바이더` / `사용 가능한 모델` | [Dashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/Dashboard.tsx:54) | REMOVE | Read-only clones of Providers/Models | Operators who never leave Dashboard lose a glance list |
| `서브에이전트` `v1`/`base`/`v2` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:36) | DEMOTE-to-Subagents | Mode is a settings decision, not a health stat | Extra click when flipping v1/v2 from home |
| `상태 온라인` / `가동 시간` / `프로바이더 9` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:73) | KEEP | Core health | Blind ops if removed |
| `버전 2.42.0` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:79) | DEMOTE-to-sidebar-brand-tooltip | Already in the brand chip | Duplicate version hunting |
| `토큰 (30일)` + `커버리지 99%` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:82) | DEMOTE-to-Usage-link | 515억 tokens is trivia on home; Usage already owns it | Home no longer previews spend |
| `재부팅 후에도…준비됩니다` | [dashboard-overview-head.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-head.tsx:94) | KEEP | Only when at-risk/error; green bar can shrink to a dot | Operators miss reboot risk if fully hidden |
| `서브에이전트 위임` + `설정 열기` | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:128) | DEMOTE-to-Subagents | Duplicate editor; home should show current model as a chip/link | Can’t change default spawn from home |
| `모델 동기화` + `지금 동기화` | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:205) | KEEP | Catalog rewrite is a real home action | Sync buried in Models |
| `Codex 실행 시 opencodex 시작` + long hint | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:490) | COLLAPSE-behind-Startup-row | Set-once; Startup already owns the real protection state | Toggle harder to find |
| `웹 검색 사이드카` + streaming | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:509) | COLLAPSE-behind-`고급 설정` | Rare path vs “is proxy up?” | Extra click for web-search model |
| `비전 사이드카` + `low` + `고급 설정` | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:549) | COLLAPSE-behind-same-disclosure | Same: image routing is exception handling | Vision timeout/max buried |
| `쉐도우 호출 가로채기` | [dashboard-overview-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-overview-sections.tsx:626) | DEMOTE-to-Models-catalog | Already a first-class Models control | Can’t intercept helpers from home |
| `메모리 관찰` RSS/heap/growth + restart | [MemoryObservabilityCard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/MemoryObservabilityCard.tsx:415) | COLLAPSE-behind-`상세 정보` unless warn | Debug telemetry; in-flight+restart can stay as one compact row | Leak diagnosis takes a click |

## Dashboard / 활성 프로바이더

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| table `이름/어댑터/Base URL/모델` | [dashboard-providers-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-providers-section.tsx:16) | REMOVE | Providers workspace is the editable source of truth | Glance-only users lose adapter/URL without opening Providers |
| `어댑터` + `Base URL` columns | same | If kept at all: COLLAPSE-behind-row-detail | Operators decide on name + ready/quota, not `openai-chat` vs URL | Debugging a bad base URL needs Providers anyway |

## Dashboard / 사용 가능한 모델

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| accordion `Anthropic Claude 13` … | [dashboard-models-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-models-section.tsx:30) | REMOVE | Catalog toggling lives on Models; this is a 96-id browser | Can’t inventory IDs from home |
| `모델 검색…` | [dashboard-models-section.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/dashboard-models-section.tsx:39) | REMOVE-with-the-tab | Search on a read-only clone is extra chrome | Same as above |

## Startup

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `시작 안전성` + `대시보드로 돌아가기` / `새로고침` | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:319) | KEEP | This page is the recovery surface | No way back / no re-probe |
| subtitle about reboot reconnect | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:322) | COLLAPSE-behind-info-icon | Hero already says the outcome | Weaker first-visit teaching |
| `ocx sync` copy banner | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:355) | KEEP | Actionable runtime mismatch | Hidden effort-option breakage |
| `재부팅 보호됨` hero | [startup-sections.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/startup-sections.tsx) via [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:387) | KEEP | The decision this page exists for | False calm if removed |
| `Codex 라우팅` / `재부팅 보호` / `필요 시 자동 시작` cards | same | KEEP | Three-state summary is the scan | Operators must open details for every check |
| `보호 상태 상세` + shim install | same | KEEP | Install/repair is the action | Shim stays missing |
| `복구 방법` + three `ocx …` copy blocks | [Startup.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Startup.tsx:411) | COLLAPSE-behind-`복구 방법` (already a section; default-collapse when protected) | CLI copies are fallback, not daily UI | Manual repair slower when GUI install fails |

## Providers

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| list + search + `프로바이더 추가` | [Providers.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Providers.tsx) / workspace shell | KEEP | Primary ops surface | Can’t add/select providers |
| `프로바이더 개요` subtitle | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:101) | REMOVE | “한곳에서 관리” is empty calories | None |
| `JSON 편집` | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:105) | DEMOTE-to-provider-detail/`…` | Power-user escape hatch, not overview | JSON path one click deeper |
| `8 준비됨 / 0 설정 필요 / 1 비활성` | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:111) | KEEP | Status counts earn the overview | Have to scan the list |
| `사용량 제한` bars | [ProviderOverviewDashboard.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx:150) | KEEP | Quota is the daily decision | Surprise 429s |
| `최근 사용` request counts | same file, recent-usage column | DEMOTE-to-Usage-or-provider-detail | Counts don’t change routing; quotas do | Lose “who is hot” glance |
| `방금 전 전 확인` copy | quota meta | KEEP-but-fix-copy | Timestamp is useful; doubled 전 is noise | None if only copy-fixed |
| OpenAI pool caveats (`일부만`, uncalibrated weight) | quota cards | KEEP | They change whether you trust the bar | Silent undercount |

## Models / catalog

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `Codex가 이 카탈로그보다 오래된…` + refresh | [codex-stale-banner.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/codex-stale-banner.tsx:24) | KEEP | Conditional, actionable | Stale picker with no explanation |
| extra page-head restart orb | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2207) | REMOVE | Third copy of the same restart | Still have sidebar + banner |
| tabs `모델` / `콤보` / `라우팅 (beta)` / `호환성` | [models-tab-strip.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/models-tab-strip.tsx:65) | KEEP | Real workspaces | Lab/combo become unreachable |
| catalog subtitle (5-line essay) | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2226) | COLLAPSE-behind-`?` | Teaches cache/id rules, not a decision | New users may toggle IDs without knowing hidden IDs still work |
| left provider rail | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx) | KEEP | Filter for 96 models | Huge unfiltered list |
| `새 모델을 비활성화 상태로 추가` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1586) | COLLAPSE-behind-provider-`새 모델 정책` | Global duplicate of per-provider radios | Global default harder to set |
| `별칭` + `기본 별칭 사용` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1590) | COLLAPSE-behind-`별칭` disclosure | Alias editing is infrequent | Extra click to rename |
| `쉐도우 호출 가로채기` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1594) | KEEP | This is the right home for intercept | Helpers keep burning paid models |
| `서브에이전트 v1/base/v2` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1603) | DEMOTE-to-Subagents | Third copy of the same radios | Can’t flip mode from catalog |
| `기본 창 / 상한` + paragraph | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1706) | COLLAPSE-behind-`창` disclosure | Default 350k is set-once; per-provider caps stay | Global cap less discoverable |
| `피커 순서: Subagents에서…` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1752) | COLLAPSE-behind-tooltip | Explains a sort you cannot change here | Confusion about toggle vs order |
| `모두 접기` / `모두 펼치기` | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:1759) | KEEP | Density control on a long list | More scrolling |
| per-provider `모두 켜기/끄기`, caps, custom add | group headers in [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx) | KEEP | Actual catalog decisions | Can’t bulk-hide Cursor’s 40 |

## Models / combos

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| tab subtitle | [Models.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Models.tsx:2226) | COLLAPSE-behind-empty-state | Repeats the empty-canvas job | Weaker first combo lesson |
| left `콤보 추가` | [ComboWorkspace.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/ComboWorkspace.tsx:108) | KEEP | List-side create | No create from the rail |
| right `콤보 만들기` + full form on empty | [combo-workspace-add-modal.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-add-modal.tsx:106) / [combo-workspace-detail-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-detail-panel.tsx:218) | DEMOTE-to-modal-on-add | Empty state already paints a 4-field expert form | Slightly slower first combo |
| `설정` / `정보` | [combo-workspace-detail-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-detail-panel.tsx:218) | KEEP `설정`; COLLAPSE-`정보` | About-tab is docs | Docs one click deeper |
| per-field hint under ID/alias/native/display/strategy | [combo-workspace-detail-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/combo-workspace-detail-panel.tsx:268) | COLLAPSE-behind-field-`?` | Four stacked essays before a target exists | Native-alias footguns less visible |
| `대상` picker + add | same | KEEP | Combo without targets is nothing | Can’t build failover |
| `이미지 / 멀티모달`, `적응형 추론 단계` | combos capabilities | COLLAPSE-behind-`기능` | Capability flags are secondary | Missed image/effort intersection |

## Models / routing (beta)

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `+ 프로필 만들기` | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:616) | KEEP | Only create action | Can’t start a policy |
| `재시도` | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:620) | DEMOTE-to-error-only | Idle reload on an empty beta tab | Harder manual refresh |
| empty `드라이런 평가` form | [RoutingProfiles.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/RoutingProfiles.tsx:1016) | COLLAPSE-behind-profile-or-`평가` | Dry-run with zero profiles is a lab toy in the default viewport | Testing a policy needs an extra click |
| `라우팅 분석` empty | same | KEEP-as-empty-hint | Fine as a stub, not as a second card | None |

## Models / compatibility

Pack screenshot is Usage. From [CompatibilityMatrix.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CompatibilityMatrix.tsx:134): keep the matrix/verdicts; COLLAPSE community-evidence / status-grid counts (`subjectCount`, `observationCount`) behind `상세`. Those are Lab telemetry, not “which model can I route today?” Risk: Lab maintainers lose glance stats.

## Subagents

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `추천` ordered 1–5 + save | [SubagentsWorkspace.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:99) | KEEP | This page’s job | Picker order uneditable |
| `spawn_agent` hint | [SubagentsWorkspace.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:99) | COLLAPSE-behind-`?` | One-time teaching | New users miss picker vs spawn coupling |
| `모델 21` checklist | same | KEEP | Choosing the five | Can’t add candidates |
| `먼저 부를 모델` | [SubagentDelegationSection.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx) | KEEP | Default spawn is the decision | Always-empty delegation |
| `Codex 설정에도 기본값으로 저장` | [SubagentDelegationSection.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:101) | KEEP | Persistence choice | Defaults don’t stick across sessions |
| `일 나누는 방법 알려주기` + long hint | [SubagentDelegationSection.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:117) | COLLAPSE-behind-`고급` | Prompt-injection policy, not daily | Guidance toggle less obvious |
| `울트라 모드` + v2 warning | [SubagentDelegationSection.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:135) | COLLAPSE-behind-`고급` | Expert policy; already gated | Ultra harder to enable |

## Logs & debug

Logs PNG in the pack is Codex 설정. From [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:540) and the real debug shot:

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `로그` / `디버그` tabs | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:550) | KEEP | Request log vs transport debug | Debug unreachable |
| logs subtitle | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:596) | REMOVE | Table is self-explanatory | None |
| surface filter Codex/Claude/Grok | [Logs.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Logs.tsx:598) | KEEP | Cuts noise in a mixed proxy | Harder isolation |
| debug subtitle + `Provider debug` / `Usage 추출` / `주입 로그` / `Claude 인바운드` | [debug-settings-panel.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/debug-settings-panel.tsx:119) | KEEP toggles; COLLAPSE-subtitle | Toggles are the page; paragraph is docs | Slightly less onboarding |
| `Follow` / `새로고침` / `런타임 재정의 해제` | logs_debug evidence | KEEP | Live tail and escape hatch | Stuck overrides |

## Usage

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `전체/Codex/Claude/Grok` + `30일/7일` | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:811) | KEEP | Real slice controls | Can’t isolate a client |
| subtitle | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:815) | COLLAPSE-behind-`커버리지` | Methodology belongs with coverage | People may treat zeros as real |
| `요청/측정됨/총 토큰/캐시/커버리지/활동일` | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:299) | KEEP the first four; DEMOTE `활동일` | Active-days is a vanity stat here | Lose “how many days in window” |
| `API 정가 환산치 ~US$38,986` | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:303) | DEMOTE-to-`커버리지 상세` or tooltip | Fake sticker price on a subscription proxy is actively misleading | Operators who want a ceiling number must open details |
| year `일별 활동` heatmap | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:401) | COLLAPSE-behind-`활동` / replace-with-30-day-bars | GitHub-year chrome for a 30-day local log | Weaker seasonality view |
| model/provider tables | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx) | KEEP | Answers “what burned the quota?” | No breakdown |
| `커버리지 상세` | [Usage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Usage.tsx:618) | KEEP as tab | Trust-the-numbers surface | Hidden unmetered traffic |

## Storage

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `저장소` + `다시 스캔` | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1408) | KEEP | Only action while scanning | Can’t refresh |
| subtitle | [Storage.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Storage.tsx:1419) | COLLAPSE-behind-empty/scan | Safety note belongs on destructive clean | People may fear session deletion less |
| skeleton rows | same | KEEP | Honest loading | None |

## Codex 설정

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| `다중 인증` / `프롬프트` | [CodexSet.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/CodexSet.tsx:43) | KEEP | Two unrelated workspaces | Prompt editor gone |
| `Codex Spark 할당량` | [codex-account-pool-main-card.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/codex-account-pool-main-card.tsx:218) | KEEP | Visibility toggle for a real quota family | Spark hidden with no switch |
| `한도 도달 계정 일시 중지` / `할당량 새로고침` / `추가` | pool header | KEEP | Daily pool ops | Can’t pause/refresh/add |
| per-account `이 계정을 다음에 사용` / `일시 중지` / `별칭` / delete / quota | cards | KEEP | Account-level decisions | Stuck on a burned account |
| `선택 순서 기본 (0)` repeated 5× | [AccountPriorityControl.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/AccountPriorityControl.tsx:35) | DEMOTE-to-nondefault-only | Default-0 on every card is wallpaper; hint is already `sr-only` | Fine-grained order less visible |
| `리셋 크레딧 N개` | cards | KEEP | Spends a real credit | Accidental hide of a billed action |
| `로테이션 전략` copy block | [CodexAccountPool.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/CodexAccountPool.tsx) | COLLAPSE-behind-select-tooltip | Three paragraphs for one dropdown | Binding/affinity less understood |
| `고급 설정` | [CodexAuthAdvancedSettings.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/components/CodexAuthAdvancedSettings.tsx:18) | KEEP | Already the right disclosure | None |

## Integrations

| element | source | verdict | reason | risk |
|---|---|---|---|---|
| subtitle | [Integrations.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/Integrations.tsx:133) | REMOVE | Overview cards already say it | None |
| 18-tab strip `개요…Aside` | [integration-tabs.ts](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/integration-tabs.ts:31) | DEMOTE-uninstalled-to-`더보기` | Hick’s law: 10 detected, 6 applied, 8 empty clients in the tablist | Uninstalled clients one click further |
| `감지된 10 / 설정된 6 / 업데이트 필요 2` | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:519) | KEEP | Scan-level status | No bulk picture |
| `마지막 변경 9/3/2026, 7:09:00 PM` | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:542) | DEMOTE-to-복원-센터 | Timestamp is audit, not apply/unapply | Harder “what just changed?” |
| `모두 해제…` | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:547) | KEEP | Dangerous bulk action should stay explicit | No bulk undo-apply |
| client cards + apply/settings | [IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/8938/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx) | KEEP applied/stale; COLLAPSE-`미설치` | Empty path cards (`~/.omp/...`) are inventory, not decisions | Discovering a new client needs `더보기` |
| raw home paths on cards | same | COLLAPSE-behind-`설정` | Path is for the detail pane | Copy-path slower |
| `복원 센터` | rollback history | KEEP | Undo is the safety net | No restore |

## TOP 15 highest-noise (ranked)

1. Sidebar `GitHub 스타` on every route — marketing/consent, zero proxy decision.  
2. Dashboard `활성 프로바이더` + `사용 가능한 모델` tabs — read-only clones of two full pages.  
3. Dashboard first viewport packed with sidecar/delegation/memory editors — home should be health + sync + at-risk startup.  
4. Models catalog 5-line subtitle + global alias/new-policy/v2/context-cap essay before the list.  
5. Triple `v1/base/v2` (Dashboard, Models, Subagents). One owner: Subagents.  
6. Dual `쉐도우 호출 가로채기` (Dashboard + Models). One owner: Models.  
7. Third Codex-restart orb on Models page-head (sidebar + stale banner already exist).  
8. Integrations 18-tab strip including uninstalled clients.  
9. Combos empty state rendering the full expert form + duplicate `콤보 추가`.  
10. Routing dry-run card as the default empty beta tab.  
11. Usage GitHub-year heatmap + `$38,986` sticker price on a subscription mix.  
12. Almost every `page-sub` sentence (`대시보드`, `프로바이더 개요`, `연동`, `로그`, `저장소`).  
13. Idle sidebar `업데이트 확인` + `GitHub` link chrome.  
14. Memory RSS/heap/arena/JSC block on Overview (details already exist).  
15. Codex pool `선택 순서 기본 (0)` × N cards plus rotation-strategy essay.

## Do not touch

- Provider ready/disabled list, add-provider, and quota bars — that is the daily “can I keep working?” surface.  
- Models per-provider show/hide, stale-catalog banner, and one Codex restart path.  
- Codex account pause / next / add / reset-credit — billed, irreversible-ish ops.  
- Logs table (when actually on Logs) and debug transport toggles.  
- Startup hero + shim/service install when unprotected.  
- Integrations apply/unapply/restore for clients that are actually present.  
- Stop-proxy control.  
- Destructive confirms (disable-all, delete account, storage clean). Collapsing those into magic defaults is the inverse failure.

Minimal dashboard, for this operator: **one home (health + sync + startup risk), one catalog, one account pool, one log, one usage table.** Settings that are not those five belong behind a disclosure or on their existing dedicated page — not deleted.

REVIEWER: grok-4.6
