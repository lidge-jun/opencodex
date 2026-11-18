# Work-Phase 3 (`wp3`): CLI (`--plant`, `--purge`) & Dashboard `#remote` UX Across All 11 Locales

> Depends on: `000_roadmap.md`, `010_wp1_rust_purge_and_conflicts.md`, `020_wp2_home_plant_store_and_api.md`. Consumed types: `LinkStatusDto`, `LinkChildKind`, `ChildTargetTriple`, `RemoteRuntimeKind`, `PlantUnavailableReason`.

## 1. File Change Map

| Action | Path | Summary |
|---|---|---|
| MODIFY | `src/cli/link-enrollment.ts` | Add `--plant` to `ocx link add`, probe/confirm with `allowMissing: true`, interactive TTY bare-host plant prompt (`Confirm <alias> <keyType> <fp> — plant lightweight ocx-child (<size>) and connect? (type yes): `), non-TTY `--plant` requirement on bare hosts, and actionable messages for `child_port_busy` / `child_external_provider_conflict` / `remote_plant_*` |
| MODIFY | `src/cli/link.ts` | Update `LINK_USAGE` (keeping `src/cli/capabilities-base.ts` untouched so `skills/ocx/references/*` outside `writeScope` stays current), accept optional `childKind` in `validateStatus`, add `--purge` to `ocx link revoke` (mutually exclusive with `--force`), and emit `~/.cache/opencodex/bin/ocx-child detach` recovery guidance on `--force` when `childKind === "ephemeral"` |
| MODIFY | `gui/src/remote-link-api.ts` | Add `child_port_busy`, `child_external_provider_conflict`, `remote_plant_failed`, `remote_plant_unavailable` to `LINK_ERROR_CODES`; extend `LinkConfirmHostView`, `LinkRowWire` (`childKind`, `appliedCodexSettingsDigest`), and `RemoteLinkStatusWire` (`homeCodexSettingsDigest`) |
| NEW | `gui/src/pages/RemoteLinkSheet.tsx` | Extracted Add Child / Find Home `<dialog>` sheet with Ready-to-Plant card (architecture, formatted ~0.9 MB size, zero-Node/Bun cache explanation, primary CTA `link.plant.apply`), Cached Ephemeral card (`link.ephemeralReady`), Full OpenCodex card, and unavailable-plant notice |
| NEW | `gui/src/pages/RemoteLinkDialogs.tsx` | Extracted Disconnect / Force-Remove `<dialog>` with Ephemeral fast-detach explanation + `--purge` checkbox (`remoteLink.disconnect.purgeLabel`), and `~/.cache/opencodex/bin/ocx-child detach` `<Trans cmd=... />` for forced ephemeral removal |
| MODIFY | `gui/src/pages/RemoteLink.tsx` | Wire `allowMissing: true` on Home `confirmHost`, `plant: true` when `confirmation.runtimeKind === "missing"`, Connected Child row mode badge (`remoteLink.badge.ephemeral` vs `remoteLink.badge.full`) & parity badge (`remoteLink.parity.synced` vs `remoteLink.parity.outdated`), `purge` state in `removeLink`, and new conflict `ERROR_TKEY` mappings |
| MODIFY | `gui/src/styles-remote-link.css` | Add token-based styles for Ready-to-Plant card (`.remote-link-plant-card`), row badges (`.remote-link-badges`), and purge checkbox row (`.remote-link-purge-option`) without touching `gui/src/styles.css` |
| MODIFY | `gui/src/i18n/{en,ko,ja,zh,zh-TW,de,fr,pt,ru,tr,vi}.ts` | Add all new `link.plant.*`, `remoteLink.badge.*`, `remoteLink.parity.*`, `remoteLink.disconnect.*`, and `remoteLink.error.*` keys across all 11 locales (patched in 2–3 file batches) |
| MODIFY | `tests/cli/cli-link-enrollment.test.ts` & `tests/cli/cli-link-force.test.ts` (or `cli-link.test.ts`) | Add CLI tests for `ocx link add --plant` (TTY prompt, non-TTY refusal without `--plant`, non-TTY success with `--plant`), conflict errors, and `ocx link revoke --purge` + ephemeral `--force` recovery guidance |
| MODIFY | `gui/tests/remote-link.test.tsx` | Update Home `confirm-host` `allowMissing: true` body assertions (`lines 1027, 1046, 1048, 1111`) and add tests for Ready-to-Plant card, Cached Ephemeral card, Connected mode/parity badges, `child_port_busy` / `child_external_provider_conflict` notices, and Ephemeral Disconnect `--purge` checkbox + force-remove command |

## 2. Diff-Level Specifications

### 2.1 CLI (`src/cli/link-enrollment.ts` & `src/cli/link.ts`)

- `src/cli/link-enrollment.ts`:
  ```diff
   const wantsJson = takeJsonFlag(args);
  +const plantFlag = takeFlag(args, "--plant");
   const expected = takeOption(args, "--expect-fingerprint");
   ...
  +if (command === "probe" && plantFlag) throw new CliUsageError("--plant is only for link add", usage);
  ```
  - For `command === "probe"`: send `{ alias, includeVersion: true }` (unchanged).
  - For `command === "add"`: send `{ alias, includeVersion: true, allowMissing: true }`.
  - Parse `probe` response accepting legacy `{ alias, fingerprint, keyType, ocxVersion }` (`runtimeKind` treated as `"full"`) or extended `{ alias, fingerprint, keyType, ocxVersion: string | null, runtimeKind, targetTriple, plantable, binarySizeBytes?, plantUnavailableReason? }`.
  - When `probe.runtimeKind === "missing"`:
    - If `probe.plantable !== true`: throw `new Error("Cannot plant ocx-child on " + alias + " (" + (probe.targetTriple ?? "unknown target") + "): " + (probe.plantUnavailableReason ?? "artifact unavailable") + ".")`.
    - Format size helper `formatSizeMb(bytes)` -> e.g. `"~0.9 MB"` (`(bytes / (1024 * 1024)).toFixed(1) + " MB"`).
    - If `!isTTY && !plantFlag`: throw `new CliUsageError("Remote host has no OpenCodex runtime; pass --plant alongside --expect-fingerprint to plant lightweight ocx-child.", usage)`.
    - If `!expected` (TTY): prompt `Confirm ${alias} ${probe.keyType} ${probe.fingerprint} — plant lightweight ocx-child (${sizeLabel}) and connect? (type yes): ` and set `shouldPlant = true` on `"yes"`.
    - Else if `!plantFlag` (TTY with `--expect-fingerprint`): prompt `Plant lightweight ocx-child (${sizeLabel}) on ${alias} and connect? (type yes): ` and set `shouldPlant = true` on `"yes"`.
    - Else (`plantFlag`): `shouldPlant = true`.
  - Call `POST /api/link/confirm-host` with `{ alias, fingerprint: probe.fingerprint, ...(shouldPlant || probe.runtimeKind ? { allowMissing: true } : {}) }`.
  - Call `POST /api/link/apply` with `{ alias, fingerprint: probe.fingerprint, ...(shouldPlant ? { plant: true } : {}) }`.

- `src/cli/link.ts`:
  - `validateStatus`: `assertKeys(candidate, ["id", "alias", "direction", "state", "since", "reason", "tunnelPort"], [...PARITY_KEYS, "peer", "tunnel", "childKind"], ...)`, validating `candidate.childKind === undefined || candidate.childKind === "full" || candidate.childKind === "ephemeral"`.
  - `runRevoke`:
    - `const purge = takeFlag(args, "--purge");`
    - `if (purge && force) throw new CliUsageError("--purge cannot be combined with --force", LINK_USAGE);`
    - When `force`: inspect local store (`(deps.readStore ?? (() => { try { return readLinkStore(linkStorePath()); } catch { return emptyLinkStore(); } }))()`) before `DELETE` to check if `record?.childKind === "ephemeral"`; if `"ephemeral"`, set `recovery = "Run ~/.cache/opencodex/bin/ocx-child detach on the remote client."`!
    - When `purge`: send `DELETE /api/link/<id>` with `{ method: "DELETE", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ purge: true }) }`.

### 2.2 GUI `#remote` Wire & Components (`gui/src/remote-link-api.ts`, `RemoteLink.tsx`, `RemoteLinkSheet.tsx`, `RemoteLinkDialogs.tsx`)

- `gui/src/remote-link-api.ts`:
  ```ts
  export type LinkRuntimeKind = "full" | "ephemeral" | "missing";
  export interface LinkConfirmHostView {
    alias: string;
    fingerprint: string;
    ocxVersion: string | null;
    runtimeKind: LinkRuntimeKind;
    targetTriple: string | null;
    plantable: boolean;
    binarySizeBytes: number | null;
    plantUnavailableReason: string | null;
  }
  export interface LinkRowWire {
    id: string;
    alias: string;
    direction: LinkWireDirection;
    state: LinkWireState;
    since: string;
    reason: string | null;
    tunnelPort: number;
    childKind: "full" | "ephemeral" | null;
    appliedCodexSettingsDigest: string | null;
  }
  export interface RemoteLinkStatusWire {
    ...
    homeCodexSettingsDigest: string | null;
  }
  ```
- New i18n keys (added identically across all 11 `gui/src/i18n/*.ts` files):
  - `link.plant.title`: EN `"Ready to plant lightweight agent"` / KO `"경량 에이전트 설치 준비됨"`
  - `link.plant.meta`: EN `"{arch} · {size} · ~/.cache/opencodex/bin/ocx-child"` / KO `"{arch} · {size} · ~/.cache/opencodex/bin/ocx-child"`
  - `link.plant.body`: EN `"OpenCodex is not installed on this computer yet. Plant the standalone ocx-child binary (~1 MB, no Node or Bun required) into ~/.cache/opencodex/bin over SSH and connect immediately. You can remove it cleanly when disconnecting."` / KO `"원격 컴퓨터에 아직 OpenCodex가 없습니다. Node나 Bun 없이 동작하는 단일 경량 파일(~1 MB)을 ~/.cache/opencodex/bin에 심어 즉시 연결하며, 연결 해제 시 깔끔하게 지울 수 있습니다."`
  - `link.plant.apply`: EN `"Plant lightweight agent & connect"` / KO `"경량 에이전트 심고 연결"`
  - `link.plant.applying`: EN `"Planting & connecting…"` / KO `"경량 에이전트 심고 연결 중…"`
  - `link.plant.unavailable`: EN `"OpenCodex was not found on this host ({arch}), and no verified ocx-child binary is available locally to plant."` / KO `"원격 컴퓨터({arch})에 OpenCodex가 없으며, 이 컴퓨터에서 심을 수 있는 검증된 경량 에이전트 파일을 찾지 못했습니다."`
  - `link.ephemeralReady`: EN `"Lightweight agent ready (ocx-child {version})"` / KO `"경량 에이전트 준비됨 (ocx-child {version})"`
  - `remoteLink.badge.ephemeral`: EN `"Lightweight"` / KO `"경량 모듈"`
  - `remoteLink.badge.full`: EN `"Full install"` / KO `"전체 설치"`
  - `remoteLink.parity.synced`: EN `"Home settings synced"` / KO `"Home 설정 일치"`
  - `remoteLink.parity.outdated`: EN `"Sync needed"` / KO `"동기화 필요"`
  - `remoteLink.disconnect.ephemeralBody`: EN `"Disconnect {alias}? Its Codex configuration will be restored and the relay process will stop immediately (0 background processes). By default, the cached ocx-child binary stays in ~/.cache/opencodex/bin for fast reconnects."` / KO `"{alias} 연결을 해제할까요? 원격 Codex 설정이 원래대로 복원되고 백그라운드 프로세스 0개 상태로 종료됩니다. 기본적으로 빠른 재연결을 위해 경량 에이전트 파일은 캐시에 남겨둡니다."`
  - `remoteLink.disconnect.purgeLabel`: EN `"Also delete the planted lightweight agent binary from the remote computer"` / KO `"심어둔 경량 에이전트 파일까지 원격 컴퓨터에서 함께 삭제"`
  - `remoteLink.disconnect.purgeConfirm`: EN `"Delete & disconnect"` / KO `"파일 삭제 후 연결 해제"`
  - `remoteLink.error.child_port_busy`: EN `"The target port (10100) on the Child computer is already in use by another process. No files on the Child were modified. Free the port or stop the conflicting process, then retry."` / KO `"원격 컴퓨터의 대상 포트(10100)를 이미 다른 프로세스가 사용 중입니다. 원격 파일은 변경되지 않았습니다. 포트를 비운 뒤 다시 시도하세요."`
  - `remoteLink.error.child_external_provider_conflict`: EN `"~/.codex/config.toml on the Child computer is already managed by another model provider or custom base URL. No files on the Child were modified."` / KO `"원격 컴퓨터의 ~/.codex/config.toml을 이미 다른 모델 제공자나 사용자 지정 주소가 소유하고 있습니다. 원격 파일은 변경되지 않았습니다."`
  - `remoteLink.error.remote_plant_failed`: EN `"Could not plant the lightweight ocx-child agent over SSH. Check remote disk space and ~/.cache permissions, then retry."` / KO `"SSH를 통해 경량 에이전트(ocx-child)를 심지 못했습니다. 원격 디스크 여유 공간과 ~/.cache 권한을 확인한 뒤 다시 시도하세요."`
  - `remoteLink.error.remote_plant_unavailable`: EN `"No verified ocx-child binary is available for the remote computer's architecture."` / KO `"원격 컴퓨터 아키텍처에 맞는 검증된 경량 에이전트 파일이 없습니다."`

## 3. Conditional Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

- Ready-to-Plant modal -> clicking `Plant lightweight agent & connect` sends `POST /api/link/apply` with `{ alias, plant: true }`.
- Connected list -> row with `childKind: "ephemeral"` and matching `appliedCodexSettingsDigest === homeCodexSettingsDigest` renders `Lightweight` + `Home settings synced`; mismatched digest renders `Sync needed`.
- Ephemeral Disconnect dialog -> checking purge checkbox sends `DELETE /api/link/<id>` with `{ purge: true }`; unchecking sends bodyless `DELETE /api/link/<id>`; `remote_disconnect_failed` transitions to Force Remove rendering `~/.cache/opencodex/bin/ocx-child detach`.

## 4. `wp3` P-Phase Continuity & Architect Reflection Amendments (`01a1b32b-f0db-7e73-93d5-8578c4fbf55d`)

- **Continuity from `wp2` D**: Resumed from `wp2` D conclusion ("Next cycle wp3 implements CLI (--plant, --purge) and #remote GUI + 11 locales").
- **Architect `01a1b32b-f0db-7e73-93d5-8578c4fbf55d` verdict**: `ALIGNED` on `W3-ARCH-01..W3-ARCH-03`.
- **Folded refinements**:
  1. Gate CLI `confirm-host` `{ allowMissing: true }` on `shouldPlant || probe.runtimeKind === "missing"` so existing full-runtime CLI expectations stay unchanged, and accept both legacy 3-key and extended `allowMissing` confirmation payloads.
  2. Map `child_port_busy`, `child_external_provider_conflict`, `remote_plant_failed`, `remote_plant_timeout`, and `remote_plant_unavailable` in CLI `PHASES` / actionable error messages, and emit `~/.cache/opencodex/bin/ocx-child detach` residual recovery when `shouldPlant` or `runtimeKind === "ephemeral"` is active.
  3. Explicitly parse and null-default `childKind`, `appliedCodexSettingsDigest`, and `homeCodexSettingsDigest` in `parseRemoteLinkStatus` (`gui/src/remote-link-api.ts`), and reset `purge` checkbox state to `false` whenever the Disconnect dialog opens or closes.

## 5. `wp3` A-Phase Audit Fold-Backs (`01a1b32d-f03c-79f0-ba27-9cf46b2708ec`, `GO-WITH-FIXES`)

1. **`remote_plant_timeout` & zero hardcoded strings in `src/pages/*`**: Add `remote_plant_timeout` to `LINK_ERROR_CODES`, `ERROR_TKEY`, and all 11 locale catalogs (`remoteLink.error.remote_plant_timeout`); add `link.plant.unknownArch` across all 11 locales for `targetTriple === null`; and place `formatBinaryMegabytes` inside `gui/src/remote-link-api.ts` so `src/pages/*` passes `bun run lint:i18n` with zero allowlist additions.
2. **Strict `probe.runtimeKind === "missing"` CLI gate**: Gate CLI `confirm-host` `{ allowMissing: true }` strictly on `shouldPlant || probe.runtimeKind === "missing"`.
3. **Null guards & force/purge isolation**: Render parity badge only when `row.appliedCodexSettingsDigest !== null && status.homeCodexSettingsDigest !== null`; omit Apply CTA when `runtimeKind === "missing" && !plantable`; send `{ purge: true }` only when `!pending.force && purge && pending.row.childKind === "ephemeral"`, and send `{ force: true }` exclusively when `pending.force` is true.

