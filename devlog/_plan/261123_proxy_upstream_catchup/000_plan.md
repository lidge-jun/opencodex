# 000 — Proxy upstream catch-up: plan and map of content

Unit: `devlog/_plan/261123_proxy_upstream_catchup/` · opened 2026-11-23 · class C3 (docs-only roadmap; implementation runs in later units)

## Objective

OpenCodex (`ocx`) is a local provider proxy for Codex and Claude Code. Four neighbouring open-source projects cover overlapping ground and move fast. This unit records what OpenCodex lacks relative to them, with source evidence on both sides, and turns the adoptable gaps into a dependency-ordered catch-up roadmap (decade docs `010`, `020`, …) plus a standalone HTML overview (`index.html`).

The unit writes documentation only. No change lands in `src/`, `gui/`, `tests/`, `docs-site/` or `structure/` here; each phase doc is the PRD for a later implementation unit.

## Pinned heads

| Project | Role for OpenCodex | Head analysed | Local copy (gitignored) |
|---|---|---|---|
| OpenCodex | subject | `origin/dev` `9e0e298ef9` (2026-11-21) | `.tmp/chase/opencodex-dev/` (`git archive` export) |
| router-for-me/CLIProxyAPI (Go) | closest peer: multi-provider OAuth proxy exposing OpenAI/Claude/Gemini/Codex wire | `0d251842d2` (2026-11-23) | `.tmp/chase/CLIProxyAPI/` |
| farion1231/cc-switch (Rust/Tauri + React) | desktop config switcher for Claude Code, Codex, Gemini CLI, OpenCode; local proxy + failover | `f19a9d4f4f` (2026-11-23) | `.tmp/chase/cc-switch/` |
| Wei-Shaw/sub2api (Go + Vue) | subscription-to-API relay: shared account pools, scheduling, keys, billing, admin | `328db26f45` (2026-11-20) | `.tmp/chase/sub2api/` |
| yetone/magpie (Go/Wails + Bun plugin host) | most direct competitor: single-binary agent config switcher (60+ agents), subscription bridging, plugin ecosystem, translating gateway, deep-link import | `3377e77eb6` (2026-11-23) | `.tmp/chase/magpie/` |

Earlier CLIProxyAPI notes live in [`devlog/_chase/20_cli-proxy-api.md`](../../_chase/20_cli-proxy-api.md), analysed at `00114be` (2026-06-29). Doc 001/002 reconcile those rows instead of repeating them. A 2026-10-17 magpie teardown is recorded in Aside memory (`~/.aside/u/0/memory/projects/opencodex.md`, "Magpie competitive teardown"); 006/007 re-verify it against the current head instead of quoting it.

## Method

1. Eight research lanes run in parallel on `gpt-6.2-sol` (GOAT `task.create`, codex provider, `reasoningEffort: xhigh`). Each lane owns exactly one research doc and writes nothing else.
2. Every claim cites `path:line` in the reference clone and in `.tmp/chase/opencodex-dev/`. Confirmation has two routes: parity/partial/ocx-ahead traces both implementations (entry point, implementation, gate); a gap traces the reference side and gives an OpenCodex absence receipt. Weaker rows are OBSERVED-partial or INFERRED with status `unknown`. Statuses: ocx-ahead, parity, partial, gap, unknown, n/a. Rows carry a shared `CAP-<topic>` tag; the coordinator scores each tag once in 009 against the baseline lane's OpenCodex evidence.
3. Every lane also researches recent practice on its axis through Aside (`$aside-jun`), public read-only pages only: release notes and changelogs since about 2026-09-20, issues, and community reports (GitHub discussions, Linux.do, X, blogs). Those rows carry publication date, release/commit, URL and access date, stay separate from source-read rows, and never change a confirmed status when they postdate the pinned head.
4. "OpenCodex lacks X" requires an absence receipt: pinned revision, exact command, roots, exit status, and the closest equivalent OpenCodex path inspected.
5. The coordinator merges the lane findings into `009_gap_matrix.md` (matrix, ranking, dependency graph, non-goals), then writes the decade phase docs, `index.html` and `check.mjs` (all in this unit).
6. Unpublished security weaknesses in any project stay out of every lane doc, final message, Aside query, the matrix and the HTML. Each lane may write one gitignored scratch note at `.tmp/chase/security-scratch/<lane>.md` and its doc says only that a note exists (AGENTS.md "Security working notes").

## Map of content

| Doc | Content | Owner |
|---|---|---|
| `000_plan.md` | this plan, heads, method, MOC | coordinator |
| [`001_cliproxyapi_wire.md`](001_cliproxyapi_wire.md) | CLIProxyAPI translators, executors, wire protocols, model catalog, streaming/WS | Sol lane L1 |
| [`002_cliproxyapi_ops.md`](002_cliproxyapi_ops.md) | CLIProxyAPI auth/credential pool, routing, quota/cooldown, management API, config hot reload, SDK, clustering | Sol lane L2 |
| [`003_ccswitch.md`](003_ccswitch.md) | cc-switch provider switching, client config writers, MCP/skills/prompts, local proxy/failover, usage, deep links | Sol lane L3 |
| [`004_sub2api_gateway.md`](004_sub2api_gateway.md) | sub2api gateway, account scheduling, sticky sessions, rate limits, upstream protocol handling | Sol lane L4 |
| [`005_sub2api_platform.md`](005_sub2api_platform.md) | sub2api users, API keys, groups, billing, admin UI, usage stats, ops monitoring | Sol lane L5 |
| [`006_magpie_gateway.md`](006_magpie_gateway.md) | magpie gateway: translation, routing modes, cache affinity, middleware, subscription bridging, plugin host | Sol lane L6 |
| [`007_magpie_clients.md`](007_magpie_clients.md) | magpie agent config switching, migration/import, deep links, sync, LAN sharing, distribution/update, UX surfaces | Sol lane L7 |
| [`008_opencodex_baseline.md`](008_opencodex_baseline.md) | OpenCodex capability inventory at `9e0e298ef9` on the same axes | Sol lane L8 |
| [`009_gap_matrix.md`](009_gap_matrix.md) | merged gap matrix (id, source, value, effort, phase or rejection), phasing rules, dependency graph, non-goals | coordinator |
| `010` … `090` | one decade doc per catch-up phase | coordinator |
| [`index.html`](index.html) | standalone overview: matrix, phase timeline, links (generated) | coordinator |
| [`build_index.mjs`](build_index.mjs) | regenerates `index.html` from 009 and the phase docs: `node build_index.mjs` | coordinator |
| [`check.mjs`](check.mjs) | mechanical gate: file presence, gap-id coverage, declared dependencies, MODIFY anchors against the pinned export, offline HTML links: `node check.mjs` | coordinator |
| [`check-selftest.mjs`](check-selftest.mjs) | ten regression cases proving `check.mjs` fails on each defect class (incl. missing before/after sketch): `node check-selftest.mjs` | coordinator |

## Work phases (goalplan `opencodex-upstream-proxy-catch-up-roadmap-docs-o`)

- **wp1** research 000–009. Done when 001–008 exist with two-sided citations, dated Aside rows (or a documented Aside blocker in NOT RUN) and NOT RUN lists, and 009 synthesizes them.
- **wp2** roadmap. Done when 010…090 exist in dependency order, every adopted gap id appears in exactly one phase doc, `index.html` renders offline with resolving links, a Sol reviewer has audited the roadmap, and `check.mjs` and `check-selftest.mjs` exit 0.

## Constraints carried into every phase doc

- Lab boundary: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` must not reach `src/lab/` (`tests/lab/core-lab-boundary.test.ts`).
- File-size ratchet: `tests/fixtures/file-size-baseline.json` caps only move down; new code goes into sibling files.
- New tests need entries in `scripts/test-layout/layout.json` (or shard) and a `tests/fixtures/test-layout-expected*.json` shard.
- Owned source areas update their `structure/` doc; `bun run structure:check` gates it.
- Actions that spend the user's identity, credits or reputation stay consent-gated (AGENTS_INSTALL.md).

## NOT RUN

No reference project was built or executed; comparisons are source reads plus dated web reports gathered through Aside. OpenCodex was read from an `origin/dev` export, not run.


## wp2 계획 — 단계 문서 형식 (2026-11-23)

wp1 결론: gap matrix를 9개 단계(010–090)로 배치했다. 감사 뒤 60건 중 34건 채택, 보류 9, 비채택 16, 이미 있음 1 ([009](009_gap_matrix.md)). 클라이언트 트랙(010→020/030)과 런타임 트랙(040→050/070→080, 060→090)은 독립이다.

각 단계 문서 `0X0_<slug>.md`는 아래 순서의 섹션을 모두 가진다. `check.mjs`가 섹션 이름과 `**Gaps:**` 줄을 검사한다.

- 머리 줄: `**Gaps:**` (matrix id), `**Depends on:**`, `**Size:**`
- `## Goal` — 단계가 끝났을 때 사용자가 보는 결과
- `## Why` — gap id별 근거 (레인 문서 링크)
- `## Changes` — OpenCodex 경로별 NEW/MODIFY, 현재 코드 위치(`path:line`, 고정 head `9e0e298ef9`)와 before/after 스케치
- `## Dependencies` — 선행 단계와 그 이유
- `## Acceptance` — 관찰 가능한 완료 조건
- `## Verification` — focused `bun test` 파일, `bun run typecheck`, `bun run structure:check`, 필요 시 `ci:full` 사유
- `## Risks` — file-size ratchet(캡 파일·2000줄 신규 한도), Lab 경계, consent, privacy
- `## Non-goals`

각 단계를 구현하는 사람은 시작할 때 이 문서의 경로·줄 번호를 현재 `dev`에 대해 다시 확인한다. 이 단위의 줄 번호는 `9e0e298ef9` 기준이다.

산출물: `010`–`090` 문서, `build_index.mjs`로 만든 `index.html`, 검증 스크립트 `check.mjs`.

## 감사 기록 (wp2, 2026-11-23)

독립 리뷰어: `gpt-6.2-sol` (reasoning high) 서브에이전트 하나가 같은 대화로 여덟 라운드를 진행했다(r1–r6 wp2, r7–r8 wp3). 매 라운드 지적은 반영하거나 근거를 들어 범위를 조정했고, 마지막 라운드에서 열린 BLOCKER·SHOULD가 없었다.

| 라운드 | 판정 | 핵심 지적과 처리 |
|---|---|---|
| r1 (연구·matrix) | FAIL | G-002는 기존 first-party 토글과 중복 → preview·home별 상태로 축소. G-031은 이미 있음 → CLOSED. G-025 공정성 단위 미정 → 발급 키 단위, 키 간 집계는 G-057 보류. 060 → 040 의존 추가. G-040/G-058 분리, G-037/G-038 출처 정정, G-015 기존 priority 위로 축소, 응답 hook G-059 보류 |
| r2 (단계 문서) | FAIL | 020 Hub 초대와 SSH Link 흐름 혼동, 070 예산이 과거 사용량 읽기, 090 filter가 outbound body 생성 전 → 각각 분리·예약·send 지점으로 수정. MODIFY 행 근거 의무화, 010 home 선택 규칙, 030 다중 파일 복구, 050 신원 출처, 060 리소스 핸들러, 수치 정정 |
| r3 | FAIL | 090 passthrough 재생성, 070 ledger 차원, 050 신원=권한 혼동 → 재생성 지점 추가, key-window 차원 신설, JEV `callerNamespace` 사용. G-007 축소와 G-060 보류, 030 ownership·journal 복구, 060 계정 binding |
| r4 | FAIL | Codex credential replay 재생성, standalone Realtime·dictation WS 우회, 사후 보고 send → 지점 추가, `serve-options.ts` admission, retry 차단 규칙. 060 연쇄 POST, 검증기 회귀 두 건 → `check-selftest.mjs` |
| r5 | FAIL | seed 예약 경로 누락, native 리소스 조작의 범위 재확인 → 반영 |
| r6 | **PASS** | 새 지적 없음. `node check.mjs`(근거 133개 해석)와 `node check-selftest.mjs`(9개 사례) 모두 exit 0 |
| r7 (wp3: before/after 스케치) | FAIL | 목표의 "before/after 스케치" 요구를 wp3로 추가해 9개 문서에 넣고 `check.mjs`로 강제함. 070 스케치가 예약·정산 계약을 깨뜨림 → lease attach로 수정. 010 인용 누락·중복 클릭, 020 import 계약(Antigravity 리터럴·Cockpit 파싱)과 실제 저장소, 030 `EXPORT_CLIENTS`, 040 lease 키·egress 필드, 050 override 경로 → 반영 |
| r8 | NEAR-PASS | 010 preview 실패 시 잠금 해제(기존 finally 사용), 070 거절 경로·async admission·spend tracker 정산 → 반영 |

## 결과와 다음 단계

- 연구: 001–008 (레인 8개, 인용 2,402개 전부 해석), 종합 009 (gap 60건: 채택 34, 보류 9, 비채택 16, 이미 있음 1).
- 로드맵: 010–090 단계 문서(각각 고정 코드를 인용한 before/after 스케치 포함), `index.html`(`node build_index.mjs`로 재생성; headless Chrome으로 오프라인 렌더 확인), 검증 `node check.mjs`와 `node check-selftest.mjs`.
- gap 상태 값: `0X0`(채택), `DEFER`, `REJECT`, `CLOSED`(고정 head의 OpenCodex에 이미 있음).
- 다음 구현은 두 트랙으로 나눠 시작할 수 있다: 클라이언트 트랙 010 → 020/030, 런타임 트랙 040 → 050/060/070 → 080/090. 각 단계는 새 구현 단위를 열 때 이 문서의 경로와 줄 번호를 현재 `dev`에서 다시 확인한다.
- 이 단위는 코드와 테스트를 바꾸지 않았다. 커밋·push·PR도 만들지 않았다.
