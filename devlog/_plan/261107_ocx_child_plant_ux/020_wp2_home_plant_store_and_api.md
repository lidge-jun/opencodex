# Work-Phase 2 (`wp2`): Home Management API — Inspection, SSH Plant & Rollback, `childKind` Projection, and `DELETE --purge`

> Depends on: `000_roadmap.md`, `010_wp1_rust_purge_and_conflicts.md`. Consumed types: `LinkChildKind`, `ChildTargetTriple`, `RemoteRuntimeKind`, `ChildBinarySource`, `inspectRemoteChildRuntime`, `remotePlantChildArgv`, `remotePurgePlantedChildArgv`.

## 1. File Change Map

| Action | Path | Summary |
|---|---|---|
| MODIFY | `src/server/management/link-route-state.ts` | Extend `PendingLinkHost` and `ConfirmedLinkHost` with optional `runtimeKind`, `targetTriple`, `plantable`, `binarySizeBytes`, `plantUnavailableReason` |
| MODIFY | `src/server/management/link-enrollment.ts` | Extend `probe` and `confirmHost` with `allowMissing?: boolean`; extend `apply` with `plant?: boolean`, streaming verified `ocx-child` bytes over SSH `stdin`, rolling back newly planted binary on failure, persisting `childKind`, and mapping `child_port_busy` / `child_external_provider_conflict` to `409` |
| MODIFY | `src/link/status-projection.ts` | Project optional `childKind?: "full" | "ephemeral"` on `LinkStatusDto["links"][number]` |
| MODIFY | `src/server/management/link-routes.ts` | Extend `GET /api/link/status` (`homeCodexSettingsDigest` on `gui-session`) and `DELETE /api/link/:id` (`{ force?: boolean, purge?: boolean }`, passing `["disconnect", "--purge"]` when `purge === true && record.childKind === "ephemeral"`) |
| MODIFY | `tests/server/link-enrollment-ephemeral-child.test.ts` | Add server route tests for `confirm-host` (`allowMissing: true` across `missing`/`ephemeral`/`full`), `apply` (`plant: true` success, missing `plant` refusal, post-plant failure rollback, `child_port_busy`, `child_external_provider_conflict`), `status` (`childKind` + `homeCodexSettingsDigest`), and `DELETE` (`purge: true` vs default vs `force+purge` `400`) |
| MODIFY | `tests/clients/link-ocx-child-e2e.test.ts` | Add real-binary E2E case streaming compiled `ocx-child` into a bare Child `$HOME/.cache/opencodex/bin/ocx-child`, enrolling, relaying, and running `disconnect --purge` to verify zero leftover binary or `child/` directory |

## 2. Diff-Level Specifications

### 2.1 `src/server/management/link-route-state.ts`

```diff
--- a/src/server/management/link-route-state.ts
+++ b/src/server/management/link-route-state.ts
@@ -18,10 +18,16 @@ export interface PendingLinkHost {
   probedAt: number;
   sshLatencyMs?: number;
   remotePlatform?: "posix" | "windows";
+  runtimeKind?: "full" | "ephemeral" | "missing";
+  targetTriple?: import("../../link/child-binary-source").ChildTargetTriple | null;
 }
 
 export interface ConfirmedLinkHost extends PendingLinkHost {
-  ocxVersion: string;
+  ocxVersion: string | null;
+  plantable?: boolean;
+  binarySizeBytes?: number;
+  plantUnavailableReason?: import("../../link/child-binary-source").PlantUnavailableReason;
 }
```

### 2.2 `src/server/management/link-enrollment.ts`

1. **`probe`**:
   - Accept `{ alias }`, `{ alias, includeVersion }`, or `{ alias, includeVersion, allowMissing }` (`includeVersion` and `allowMissing` must be `boolean` when present).
   - When `includeVersion === true && allowMissing !== true`: unchanged legacy behavior (`remoteOcxArgv(["--version"], remotePlatform)` -> `{ alias, fingerprint, keyType, ocxVersion }`).
   - When `includeVersion === true && allowMissing === true`: run `inspectRemoteChildRuntime(runner, alias, path, remotePlatform)`.
     - If `runtimeKind === "full"` or `"ephemeral"`: verify `MIN_REMOTE_OCX` (`>= 2.66.0`, else `409 remote_ocx_outdated`), store `runtimeKind` and `targetTriple` on `PendingLinkHost`, and return `{ alias, fingerprint, keyType, ocxVersion, runtimeKind, targetTriple, plantable: false }`.
     - If `runtimeKind === "missing"`: resolve `resolveChildBinarySource(targetTriple)`, store on `PendingLinkHost`, and return `{ alias, fingerprint, keyType, ocxVersion: null, runtimeKind: "missing", targetTriple, plantable, ...(binarySizeBytes !== undefined ? { binarySizeBytes } : {}), ...(plantUnavailableReason ? { plantUnavailableReason } : {}) }`.

2. **`confirmHost`**:
   - Accept `{ alias, fingerprint }` or `{ alias, fingerprint, allowMissing }`.
   - When `allowMissing !== true`: preserve exact legacy `remoteOcxArgv(["--version"], remotePlatform)` call and exact `{ alias, fingerprint, ocxVersion }` JSON response!
   - When `allowMissing === true`: run `inspectRemoteChildRuntime(runner, alias, path, remotePlatform)`:
     - If `runtimeKind !== "missing"`: check `MIN_REMOTE_OCX`, pin host in `known_hosts`, store `ConfirmedLinkHost` with `runtimeKind`, `targetTriple`, `ocxVersion`, `plantable: false`, and return `{ alias, fingerprint, ocxVersion, runtimeKind, targetTriple, plantable: false }`.
     - If `runtimeKind === "missing"`: resolve `resolveChildBinarySource(targetTriple)`, pin host in `known_hosts`, store `ConfirmedLinkHost` with `ocxVersion: null, runtimeKind: "missing", targetTriple, plantable, binarySizeBytes, plantUnavailableReason`, and return that object.

3. **`apply`**:
   - Accept `alias`, optional `fingerprint`, and optional `plant?: boolean`.
   - If `confirmed.runtimeKind === "missing"` and `body.plant !== true`: return `fail("remote_ocx_missing", "ocx was not found on the remote host; confirm planting ocx-child before applying.", 409)`.
   - Track `let plantedFreshBinary = false`.
   - When `body.plant === true && confirmed.runtimeKind === "missing"`:
     - `phase = "remote_plant"`; re-resolve `resolveChildBinarySource(confirmed.targetTriple ?? null)` (reading verified `Uint8Array` bytes + `sha256` right before streaming). If `!source.ok`, return `fail("remote_plant_unavailable", "No verified ocx-child binary is available for this host architecture.", 409, source.reason)`.
     - Run `runner.run(buildExecArgv({ alias, argv: remotePlantChildArgv(remotePlatform, source.artifact.sizeBytes, source.artifact.sha256), knownHostsFile: knownHosts }), { stdin: source.artifact.bytes, timeoutMs: Math.max(budget, 60_000) })`.
     - If nonzero exit, return `fail("remote_plant_failed", "Could not plant ocx-child on the remote host.", 502, sshFailureHint(plantRes.stderr))`.
     - Set `plantedFreshBinary = true`.
   - Extend `failed(response)` helper so whenever `plantedFreshBinary === true`, after `compensateNewLink` revokes any issued key and stops the tunnel, Home runs best-effort `run(remotePurgePlantedChildArgv(remotePlatform))` (which invokes `ocx-child detach --purge` if state exists and removes the newly planted managed binary) so failed enrollments leave the bare host untouched!
   - Conflict mapping in `apply`:
     - During `child_preflight` for `ephemeralChild`: when `before.code === 0` (or a TCP listener probe answers on `childPort`), return `fail("child_port_busy", "Port " + childPort + " is already in use on the Child; no Child files were modified.", 409)` (before any key is issued!).
     - During `remote_connect`: if `connected.code !== 0`, inspect `classifyChildAttachConflict(connected.stderr)`:
       - `"child_port_busy"` -> compensate (and purge if freshly planted; `remoteMayBeConnected = false` because `ocx-child` exited before writing state/files!) and return `fail("child_port_busy", "The Child's target port is already in use; no Child files were modified.", 409, sshFailureHint(connected.stderr))`.
       - `"child_external_provider_conflict"` -> compensate (`remoteMayBeConnected = false` because `detect_unowned_root_routing_conflict` runs before journal/config writes!) and return `fail("child_external_provider_conflict", "The Child's ~/.codex/config.toml is already managed by another model provider or custom base URL; no Child files were modified.", 409, sshFailureHint(connected.stderr))`.
   - Persist `childKind: ephemeralChild ? "ephemeral" : "full"` on hub-initiated `apply` `record` in `links.json` (leaving `POST /api/link/issue` client-initiated records without `childKind` so existing exact-store fixtures in `tests/server/link-management-routes.test.ts` stay untouched).
   - Update `tests/server/link-enrollment-ephemeral-child.test.ts:192` assertion from `"child_restart_unsupported"` to `"child_port_busy"` on ephemeral foreign-listener preflight.

### 2.3 `src/link/status-projection.ts` & `src/server/management/link-routes.ts`

```diff
--- a/src/link/status-projection.ts
+++ b/src/link/status-projection.ts
@@ -20,6 +20,7 @@ export interface LinkStatusDto {
     since: string;
     reason: string | null;
     tunnelPort: number;
+    childKind?: "full" | "ephemeral";
     /** Home only: what the link carried from this Child, and the compatibility verdict. */
     peer?: LinkPeerStatus;
@@ -141,6 +142,7 @@ export function projectLinkStatus(
     ...stateDetails(record, byId.get(record.id), compensation),
     tunnelPort: record.tunnelPort,
+    ...(record.childKind ? { childKind: record.childKind } : {}),
     ...parity(record.id),
   }));
```

In `src/server/management/link-routes.ts`:
- In `remove`: validate `body` keys `<= ["force", "purge"]`, both optional booleans, and reject `force === true && purge === true` with `400 invalid_body`. When `!force && record.direction === "hub-initiated"`, pass `purge === true && record.childKind === "ephemeral" ? ["disconnect", "--purge"] : ["disconnect"]` to `remoteOcxArgv`.
- In `GET /api/link/status`: when `ctx.principal === "gui-session"`, include `homeCodexSettingsDigest: codexSettingsDigest(projectHomeCodexSettings(ctx.config, packageVersion("0.0.0")).settings)` alongside `joinAvailable` and `joinDenied`.

## 3. Conditional Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

- Bare host `apply` without `plant: true` -> `409 remote_ocx_missing`, zero SSH writes.
- Bare host `apply` with `plant: true` + simulated `child_relay_failed` -> key revoked, tunnel stopped, and `remotePurgePlantedChildArgv` invoked to remove planted binary.
- `ocx-child` `connect` returning `ocx-child-conflict:child_external_provider_conflict` -> `409 child_external_provider_conflict` without `residual: true` and with link compensated cleanly.

## 4. `wp2` P-Phase Continuity & Architect Reflection Amendments (`01a1b316-9e8c-7a23-845e-da43f6554f0e`)

- **Continuity from `wp1` D**: Resumed from `wp1` D conclusion ("Next cycle wp2 implements Home Management API enrollment/plant/purge routes").
- **Architect `01a1b316-9e8c-7a23-845e-da43f6554f0e` verdict**: `ALIGNED` on `W2-ARCH-01..W2-ARCH-03`.
- **Folded refinements**:
  1. Add `resolveChildBinarySource?: typeof import("../../link/child-binary-source").resolveChildBinarySource` to `ManagementApiDeps` in `src/server/management/context.ts` so server route tests can deterministically inject verified/unavailable binary resolutions across targets.
  2. In `apply` (`src/server/management/link-enrollment.ts`), route EVERY exit after `plantedFreshBinary = true` (including `remote_port` and `child_preflight` refusals such as `child_port_busy` and `child_curl_missing`) through `await failed(...)` so newly planted binaries are always purged on failure; keep `confirmedHosts` intact on pre-plant `409 remote_ocx_missing` / `remote_plant_unavailable`; and reset `remoteMayBeConnected = false` on classified pre-write attach conflicts (`child_port_busy`, `child_external_provider_conflict`).
  3. Enforce strict key sets: `probe` requires `includeVersion === true` when `allowMissing` is supplied; `confirmHost` accepts `{ alias, fingerprint }` or `{ alias, fingerprint, allowMissing }`; `apply` accepts `{ alias, fingerprint?, plant? }` (all 4 exact subsets); `DELETE /api/link/:id` accepts empty/null body or `{ force?, purge? }` and rejects `force === true && purge === true` with `400 invalid_body`.

## 5. `wp2` A-Phase Audit Fold-Backs (`01a1b322-c1e1-7c41-a560-45f51e35dca3`, `GO-WITH-FIXES`)

1. **`W2-BLK-01` (Folded — Purge exception safety & `residual` reconciliation)**: Wrap `remotePurgePlantedChildArgv` inside `failed()` in a once-only `try/catch` (`plantedFreshBinary = false`). If rollback purge exits `0`, reset `remoteMayBeConnected = false` (no residual left on Child); if rollback purge returns nonzero or throws, set `remoteMayBeConnected = true` with recovery `"Run ~/.cache/opencodex/bin/ocx-child detach --purge on the Child before retrying."`.
2. **`W2-BLK-02` (Folded — Public DTO projection, boolean guards, & `context.ts` seam)**: Add `src/server/management/context.ts` (`resolveChildBinarySource` seam) to the File Change Map, project only explicit public DTO fields from `confirmHost` (never leaking `knownHostLine`, `probedAt`, `sshLatencyMs`, or `remotePlatform`), validate `typeof allowMissing === "boolean"` in `probe`/`confirmHost` and `typeof plant === "boolean"` in `apply` (`400 invalid_body`), and wire `ctx.deps.resolveChildBinarySource ?? resolveChildBinarySource` in all three handlers.

