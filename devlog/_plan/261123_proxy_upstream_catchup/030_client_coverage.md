# 030 — 클라이언트 범위와 설정 이식성: Gemini CLI, Zed, MCP 동기화, 로컬 백업

**Gaps:** G-008, G-009, G-010, G-011
**Depends on:** 010
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

Gemini CLI와 Zed를 opt-in으로 OpenCodex에 연결하고 원복한다. 여러 파일을 쓰는 연결이 중간에 프로세스가 죽어도 다음 시작 때 일관된 상태로 돌아온다. Codex/Claude Code의 MCP 서버 항목을 읽고 고른 항목만 적용한다. 관리 설정을 골라 로컬 백업 번들로 내보내고 복원 전 변경을 본다.

## Why

- **G-008** — cc-switch는 `.gemini/.env`와 `settings.json`을 함께 다룬다(`ccs:src-tauri/src/gemini_config.rs:9–19,258–262`). OpenCodex에는 Gemini CLI 파일 연결이 없다 (`003` 인벤토리: gap).
- **G-009** — magpie는 Zed `settings.json`에 custom provider를 쓴다(`mgp:internal/agent/zed.go:51,70`). OpenCodex client 목록에 Zed가 없다(`ocx:src/clients/client-ids.ts:2`, `ocx:src/integrations/registry.ts:288`) (`007` L7-7).
- **G-010** — cc-switch `McpService`는 Claude `mcpServers`, Codex `[mcp_servers.*]`로 투영한다(`ccs:src-tauri/src/services/mcp.rs:51,276–287`). OpenCodex에는 전역 MCP 항목을 읽고 재투영하는 표면이 없다 (`003` L3-8).
- **G-011** — cc-switch는 백업 생성·검증·복원을 제공한다(`ccs:src-tauri/src/database/backup.rs:581–619`). OpenCodex는 raw `config export/import`만 있다(`ocx:src/cli/config-command.ts:246`) (`003` L3-6).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/clients/client-ids.ts` | MODIFY | `EXPORT_CLIENT_IDS`(`ocx:src/clients/client-ids.ts:2`)에 `"gemini-cli"`, `"zed"`. exhaustive union이므로 같은 PR에서 모든 소비자와 i18n을 갱신하고 개수는 목록에서 파생 |
| `src/integrations/registry.ts` | MODIFY | `INTEGRATION_CLIENTS`(`ocx:src/integrations/registry.ts:288`)에 두 항목 |
| `src/clients/config-export.ts` | MODIFY | `EXPORT_CLIENTS: Record<ExportClientId, ExportClientSpec>`(`ocx:src/clients/config-export.ts:1504`)에 두 spec 등록. 이 맵도 exhaustive라 빠지면 typecheck가 실패한다 |
| `src/clients/config-export/gemini-cli.ts` | NEW | Gemini CLI export spec (dotenv + settings.json 미리보기) |
| `src/clients/config-export/zed.ts` | NEW | Zed export spec (custom provider 블록 미리보기, upstream Zed provider id와 구분) |
| `src/integrations/writer.ts` | MODIFY | `commit`(`ocx:src/integrations/writer.ts:155`)의 단일 파일 순서(파일 → ownership → journal, `:147`) 앞에 다중 파일 recovery record 단계를 둔다 (아래) |
| `src/integrations/multi-file-recovery.ts` | NEW | 기존 transaction seam(`io.beginTransaction`, `ocx:src/integrations/writer.ts:155`; 다중 파일 선례 `ocx:src/integrations/cline-io.ts:131`)을 써서 쓰기 전에 `{opId, files:[{path, preImageSnapshot, intendedHash}], priorRecord, journalEntry}`를 durable하게 기록하고, 파일·ownership(`ocx:src/integrations/writer.ts:180`)·journal 모두 commit 뒤 완료 표시. 시작 시 미완료 record를 복구 |
| `src/integrations/gemini-cli-io.ts` | NEW | dotenv + JSON 두 파일을 하나의 recovery record로 쓴다 |
| `src/integrations/zed-settings.ts` | NEW | Zed JSON(주석 허용) merge, 사용자 모델 선택 보존 |
| `src/integrations/mcp/` | NEW | `read.ts`, `plan.ts`(선택 항목 diff), `apply.ts`(writer 경유) |
| `src/cli/config-command.ts` | MODIFY | `handleConfigCommand`(`ocx:src/cli/config-command.ts:246`)에 `backup [--include …]`, `restore --preview` 하위 명령. 구현은 sibling `config-backup.ts` |
| `gui/src/pages/integrations/` | NEW 패널 | Gemini CLI·Zed 카드(기존 `FileIntegrationPage.tsx` 재사용), MCP 패널, 백업 패널 |

다중 파일 복구 규칙 (감사 r2 #6, r3 #5): 복구 단위는 파일, ownership record, journal row 전체다. 미완료 record가 있으면 ownership은 `priorRecord`로, journal은 해당 opId 행을 "recovered" 상태로 기록해 파일 상태와 맞춘다. 파일은 각 파일의 현재 해시를 `intendedHash`, `preImageSnapshot`과 비교한다. 현재 바이트가 우리가 쓴 값이면 pre-image로 되돌린다. pre-image와 같으면 그대로 둔다. 둘 다 아니면 사용자가 그사이 고친 것이므로 건드리지 않고 충돌로 보고한다.

### Before / After

`ocx:src/clients/client-ids.ts:2` — client 목록에 Gemini CLI와 Zed가 없다.

```ts
// before
export const EXPORT_CLIENT_IDS = [
  "qoder", "qoder-cn", "workbuddy", "workbuddy-ai", "opencode", "pi", "omp", "hermes",
  "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "commandcode", "prime", "aside",
  "raycast", "omo", "cline", "kilo", "droid", "gentle-shell", "t3code",
] as const;
```

```ts
// after (sketch)
export const EXPORT_CLIENT_IDS = [
  /* 기존 24개 그대로 */ "t3code",
  "gemini-cli", "zed",
] as const;
// EXPORT_CLIENTS(config-export.ts:1504)와 INTEGRATION_CLIENTS(registry.ts:288)는 둘 다 Record<…Id, …>이므로
// 두 spec(config-export/gemini-cli.ts, zed.ts)과 두 integration 항목이 없으면 typecheck가 실패한다.
// gemini-cli의 writer는 multi-file-recovery를 거쳐 .env와 settings.json을 한 작업으로 쓴다.
```

## Dependencies

010의 journal/restore 계약과 Connections 화면을 재사용한다.

## Acceptance

- Gemini CLI 연결을 켰다 끄면 두 파일이 원래 바이트로 돌아온다.
- fixture: dotenv를 쓴 직후 프로세스를 종료하고 재시작하면 dotenv가 pre-image로 복구되고 JSON은 그대로이며, 그사이 사용자가 고친 무관한 키는 남는다.
- fixture: 첫 파일의 ownership·journal bookkeeping까지 commit된 뒤 종료하면, 재시작 후 ownership은 이전 record로 돌아가고 journal의 해당 작업은 recovered로 표시되어 디스크 파일과 일치한다.
- Zed 연결 후 사용자가 고른 모델이 유지된다.
- MCP 패널은 고른 항목만 적용하고 서버 명령을 실행하지 않는다.
- 백업 번들은 기본적으로 credential을 제외하고 복원 전 변경 목록을 보여 준다.

## Verification

- 신규 `tests/cli/gemini-cli-integration-io.test.ts`, `tests/cli/zed-integration-settings.test.ts`, `tests/cli/mcp-client-sync-plan.test.ts`, `tests/cli/config-backup.test.ts`, `tests/cli/integration-multi-file-recovery.test.ts`
- 기존 회귀: `tests/cli/cli-integration-preview.test.ts`, `tests/cli/cli-capability-integration-workflows.test.ts`, `tests/ci-workflows/skill-ocx.test.ts` (CLI capability 추가 시 `bun run skill:surface`)
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run lint:gui`

## Risks

- **Union exhaustiveness:** `EXPORT_CLIENT_IDS`와 i18n·개수가 다른 브랜치와 동시에 바뀌면 merge 뒤 typecheck가 깨진다.
- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `writer.ts` 1094줄, `registry.ts` 604줄 — recovery와 adapter는 sibling.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다.
- **Privacy:** MCP 항목의 env·header 값은 표시와 로그에서 가린다.

## Non-goals

- 범용 MCP/Skills Library (G-052 비채택), 원격 저장소 동기화 (G-040 보류), roster 맞추기 (G-054 비채택).
