# 002_coverage_gaps — 코드에 있고 `structure/`에 없는 것

측정 2026-07-31. 각 항목은 담당 문서와 근거 경로를 함께 적는다. 담당 문서 배정은
`00_overview.md` Writing rule(평평한 `NN_topic.md`, 새 주제는 다음 번호)을 따른다.

## A. `src/` 루트 서브시스템 (담당: `01_runtime.md`)

| 서브시스템 | 역할 | 근거 |
|-----------|------|------|
| `src/tray/` | Windows 트레이 상주 프로세스. 고정 액션만 CLI에 위임 | `src/tray/`, `src/server/windows-tray-control.ts` |
| `src/github/` | 사이드바 star 상태 조회 | `src/server/management/sidebar-routes.ts:17` |
| `src/combos/` | 프로바이더 조합·failover 정의 | `src/server/management/combo-routes.ts:69` |
| `src/images/` | 이미지/비디오 생성 루프, xAI 클라이언트, 아티팩트 저장 | `src/images/loop.ts`, `src/images/artifacts.ts` |
| `src/storage/` | 로그·아티팩트 정리 정책, 휴지통 | `src/server/management/logs-usage-routes.ts:235` |
| `src/chat/` | Chat Completions inbound/outbound 변환 | `src/chat/inbound.ts`, `src/chat/outbound.ts` |
| `src/claude/` | Claude Code/Desktop 통합: 인바운드 변환, auth 모드 마이그레이션, Desktop 프로필/헬스, 컨텍스트 윈도 | `src/claude/inbound.ts`, `src/claude/desktop-3p.ts`, `src/claude/auth-mode-migration.ts` |
| `src/grok/` | Grok 통합 설정과 적용 경로 | `src/server/management/agent-settings-routes.ts:422` |
| `src/generated/` | 생성 코드 (수동 편집 대상 아님) | `src/generated/` |
| `src/cli.ts`, `src/index.ts`, `src/stall-timeout.ts` | 모듈 엔트리포인트와 stall 예산 | `src/stall-timeout.ts:8` |

## B. 어댑터·트랜스포트 (담당: `04_transports-and-sidecars.md`)

| 항목 | 근거 |
|------|------|
| Azure Responses passthrough | `src/adapters/azure.ts:3-6` |
| Google / Vertex / Antigravity 트랜스포트·wire 컴파일러·툴 스키마 | `src/adapters/google.ts:269`, `src/adapters/google-http.ts:13-89`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts` |
| Mimo Free 트랜스포트 (클라이언트/JWT) | `src/adapters/mimo-free.ts:11-17,164` |
| Anthropic 이미지 ingress 정규화·한도 | `src/adapters/anthropic-image-guard.ts:19-45`, `src/adapters/anthropic-image-normalize.ts:40-64` |
| 어댑터 공용 실행 지원 (turn 큐, 툴 카탈로그 nudge, identity, image 변환, upstream 에러 정규화) | `src/adapters/run-turn-queue.ts:52`, `src/adapters/tool-catalog-nudge.ts:35-62`, `src/adapters/identity.ts:18-44`, `src/adapters/image.ts:8-19`, `src/adapters/upstream-http-error.ts` |
| Cursor live transport / MCP 매니저 / discovery 재시도 / thread 연속성 | `src/adapters/cursor/transport-retry.ts:10-130`, `src/adapters/cursor/mcp-manager.ts:7-8`, `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/thread-continuity.ts` |
| Claude Messages 네이티브/passthrough 및 count-tokens | `src/server/claude-messages.ts:490-510,798` |
| Chat Completions inbound 엔드포인트 | `src/server/chat-completions.ts:48` |
| 직접 hosted search relay (`/alpha/search`) | `src/server/search.ts:39,98-134` |
| 이미지/비디오 브릿지 루프, 아티팩트 다운로드, xAI 이미지·비디오 클라이언트 | `src/images/plan.ts:7-82`, `src/images/fulfill.ts:74-85`, `src/images/xai-client.ts:25`, `src/images/xai-video-client.ts:31`, `src/images/loop.ts:247-251` |
| GitHub Copilot 트랜스포트 선택 | `src/providers/github-copilot-transport.ts:34` |
| API 키 풀 429 로테이션/쿨다운 | `src/providers/key-failover.ts:78,152-169` |
| Alibaba 리전 마이그레이션/스타트업 | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` |
| 모델 discovery 한도, 프로바이더 쿼터 캐시 | `src/providers/model-discovery.ts:12-14`, `src/providers/quota.ts:296-328` |

## C. Config 표면 (담당: `02_config-and-codex-home.md`)

| 항목 | 근거 |
|------|------|
| 운영 설정 (`port`, `hostname`, `defaultProvider`, `fastMode`, stream 모드, 타임아웃, 프록시, 스토리지 정리, API 키, shim/start 동작, resume 히스토리 동기화) | `src/types.ts:514-675`, `src/config.ts:668-699,1573-1597` |
| 컨텍스트·카탈로그 제어 (`providerContextCaps`, `contextCapValue`, `disabledModels`, `customModels`, `modelCacheTtlMs`, 프로바이더 `selectedModels`) | `src/types.ts:603-610,632-675,930-951` |
| Windows 번들 플러그인 마켓플레이스 doctor 진단 | `src/codex/plugins-doctor.ts:145-205` |
| 프로젝트 수준 Codex config 우회 경고 | `src/codex/project-config-warnings.ts:104-152,281-302` |

## D. 카탈로그·계정·서브에이전트 (담당: `03_catalog-and-subagents.md`)

| 항목 | 근거 |
|------|------|
| 계정 네임스페이스: 생성된 공개 selector(메인은 `main`, 충돌 시 접미사)와 그것이 가리키는 config 전용 sentinel `@main`, 프로바이더/콤보 id 충돌 보호 | `src/codex/account-namespaces.ts:93`, `src/codex/account-namespace-match.ts:3-4,27-62` |
| Codex 계정 풀 로테이션, sticky 선택, 실패 처리 | `src/codex/pool-rotation.ts:17-185`, `src/types.ts:698-705` |
| 프로바이더 라이브 모델 캐시 수명·무효화 | `src/codex/model-cache.ts:119-147`, `src/server/management/provider-routes.ts:136-151` |
| 쿼터 인지 서브에이전트 폴백 체인 (60초 가용성 프로브 기본값) | `src/codex/subagent-model-fallback.ts:29-33`, `src/types.ts:528-536` |
| V2 기능 플래그와 최대 동시 스레드 (카탈로그 `multiAgentMode`와 별개) | `src/codex/features.ts:83-120`, `src/server/management/agent-settings-routes.ts:101-163` |
| effort 상한 (`effortCap`, `subagentEffortCap`)의 V2 한정 적용 | `src/types.ts:589-601`, `src/server/effort-policy.ts:45-79` |
| warmup 요청 동작과 폴백 모델 | `src/codex/warmup.ts:21-32,133-169` |
| 자격증명 저장소 generation 가드·refresh lock (경합 시 `CodexCredentialGenerationConflictError`) | `src/codex/account-store.ts:115-305,420-423` |

## E. GUI 표면 (담당: `05_gui-and-management-api.md`)

| 워크스페이스 | 근거 |
|-------------|------|
| provider workspace (rail + 탭 Overview/Models/Usage/[Accounts 또는 API Keys]/Settings) | `gui/src/components/provider-workspace/ProviderDetails.tsx:99-105` |
| API keys workspace | `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:118-160` |
| storage workspace | `gui/src/components/storage-workspace/StorageWorkspace.tsx:2` |
| subagents workspace | `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:2` |
| combo workspace (rail/detail/add) | `gui/src/components/ComboWorkspace.tsx:19-32` |
| provider catalog 브라우저 | `gui/src/components/provider-catalog/ProviderCatalog.tsx:31` |
| Codex 계정 풀, 계정 추가 플로우, 프로바이더 추가 모달, OAuth ToS 경고 | `gui/src/components/CodexAccountPool.tsx:35-57`, `gui/src/components/AddCodexAccountModal.tsx:11`, `gui/src/components/AddProviderModal.tsx:12-29`, `gui/src/components/OAuthTosWarningModal.tsx` |
| 업데이트 배지 | `gui/src/components/sidebar-github-row.tsx:59-131` |

## F. 릴리스·거버넌스 (담당: `06_docs-and-release.md`)

| 항목 | 근거 |
|------|------|
| 워크플로 7개: `enforce-issue-quality`, `enforce-pr-target`, `issue-quality-tests`, `issue-triage`, `pr-labeler`, `react-doctor`, `stale-needs-info` | `.github/workflows/` |
| 브랜치 정책 (`dev` 단일 통합, `main` 승격, `preview` 프리릴리스, `enforce-target` 검사) | `AGENTS.md:108-132`, `MAINTAINERS.md:22-29` |
| `devlog/`가 추적 디렉터리라는 정책 (서브모듈·비공개 미러 없음), Go 런타임 은퇴 | `AGENTS.md:33-36,110-117` |

`06`이 Go나 서브모듈 devlog를 잘못 주장하는 문장은 없다. 없는 것은 정책 서술 자체다.
`structure/`가 저장소 구조의 SOT라면 이 정책은 여기에 있어야 한다.

## G. 배치 판단

A~F를 전부 기존 아홉 문서에 넣는다. 새 번호 문서는 만들지 않는다. 근거:

- Writing rule은 "한 파일이 너무 넓어지면 다음 번호로 분리"를 허용하지만, 위 항목은 모두
  기존 문서의 주제 안에 든다. 트레이·스토리지·이미지는 런타임 서브시스템이고, 라우트는 관리 API,
  워크플로는 릴리스 문서 소관이다.
- 예외 후보는 B의 어댑터 14계열이다. `04`는 이미 35KB다. 다만 이 유닛의 목표는 정확성 복구이므로
  어댑터는 절 신설이 아니라 기존 표에 행 추가로 처리하고, 분할이 필요하다는 판단은 WP6에서
  실제 파일 크기를 보고 결정한다.
