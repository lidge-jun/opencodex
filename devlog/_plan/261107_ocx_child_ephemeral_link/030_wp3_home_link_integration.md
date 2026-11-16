# `wp3` — Home-Side Ephemeral Child Discovery, Enrollment, Sync Fan-Out, & E2E Integration

> Continuity handoff (`LOOP-CONTINUITY-01` from `wp2` D at `072d491771`): `wp2` delivered `native/ocx-child` (878 KiB stripped release binary, 6/6 Rust conformance + live lifecycle suites passing). Revalidated `030_wp3_home_link_integration.md` against `072d491771`: all paths, hunks, `link-*` test-layout shard entries, and real-binary E2E steps match the compiled `ocx-child` contract. Architect consultation: covered by `ARCH-05` & `ARCH-07` (`ALIGNED` on `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7`, `000_roadmap.md` §3.1).

- **Phase ID**: `wp3` (depends on `wp2`; satisfies `c-4`, `c-6`)
- **Header dependencies**:
  - Consumes `isDetachedEphemeralChildConfig` (`src/link/ephemeral-child.ts`), `POWERSHELL_ENCODED_MAX` (`src/link/remote-windows.ts:8`), `isChildHealth`, `remoteChildHttpArgv`, `REMOTE_CURL_PREFLIGHT` (`src/link/remote-probe.ts:20-40`), `classifySyncResult` (`src/cli/sync-fanout.ts:52`), and compiled `ocx-child` binary.
- **Scope**:
  - **IN**: `src/link/ssh-argv.ts` (MODIFY), `src/link/remote-windows.ts` (MODIFY), `src/server/management/link-enrollment.ts` (MODIFY), `package.json` (MODIFY), `tests/clients/link-ephemeral-child-discovery.test.ts` (NEW), `tests/server/link-enrollment-ephemeral-child.test.ts` (NEW), `tests/clients/ocx-child-e2e.test.ts` (NEW), `scripts/test-layout/layout-clients.json` (MODIFY), `tests/fixtures/test-layout-expected.json` (MODIFY).
  - **OUT**: `src/cli/index.ts` (untouched — 1999/2000 cliff), `src/link/store.ts` (untouched — `LinkRecord` stays backwards-compatible), `structure/**` & `docs-site/**` (`wp4`).

## 1. Exact File Changes & Before/After Hunks

### 1.1 MODIFY `src/link/ssh-argv.ts`

Extend `REMOTE_OCX_CANDIDATES` so every full-`ocx` candidate is probed first, and only when all full-`ocx` candidates miss does discovery probe `ocx-child` in `$HOME/.local/bin/ocx-child`, `$HOME/.cache/opencodex/bin/ocx-child`, and `$PATH`:

```diff
 const REMOTE_OCX_CANDIDATES = `for candidate in "$HOME/.opencodex-desktop/bin/ocx" "/Applications/OpenCodex.app/Contents/MacOS/ocx" "/usr/bin/ocx"; do
   try_ocx "$candidate" "$@"
 done
 remaining=$PATH
 while :; do
   directory=\${remaining%%:*}
   try_ocx "\${directory:-.}/ocx" "$@"
   case "$remaining" in *:*) remaining=\${remaining#*:};; *) break;; esac
-done`;
+done
+for candidate in "$HOME/.local/bin/ocx-child" "$HOME/.cache/opencodex/bin/ocx-child"; do
+  try_ocx "$candidate" "$@"
+done
+remaining=$PATH
+while :; do
+  directory=\${remaining%%:*}
+  try_ocx "\${directory:-.}/ocx-child" "$@"
+  case "$remaining" in *:*) remaining=\${remaining#*:};; *) break;; esac
+done`;
```

### 1.2 MODIFY `src/link/remote-windows.ts`

Append `ocx-child.exe` fallback candidates after all `ocx.exe` candidates in `OCX_CANDIDATES`, keeping both `windowsOcxArgv` and `windowsPinnedSyncArgv` strictly below `POWERSHELL_ENCODED_MAX = 8000`:

```diff
 const OCX_CANDIDATES = String.raw`$u=$env:USERPROFILE;$c=@("$u\.opencodex-desktop\bin\ocx.exe","$u\.local\share\goat\opencodex\current\ocx.exe","$u\.local\bin\ocx.exe")
 if($env:LOCALAPPDATA){$c+="$env:LOCALAPPDATA\Programs\OpenCodex\ocx.exe"}
 if($env:ProgramFiles){$c+="$env:ProgramFiles\OpenCodex\ocx.exe"}
 $c+=@((Get-Command ocx.exe -Type Application -EA 0).Source)
+$c+=@("$u\.local\bin\ocx-child.exe","$u\.cache\opencodex\bin\ocx-child.exe")
+if($env:LOCALAPPDATA){$c+="$env:LOCALAPPDATA\opencodex\bin\ocx-child.exe"}
+$c+=@((Get-Command ocx-child.exe -Type Application -EA 0).Source)
 `;
```

### 1.3 MODIFY `src/server/management/link-enrollment.ts`

In `apply()` (`src/server/management/link-enrollment.ts:133-158`), import `isDetachedEphemeralChildConfig` from `../../link/ephemeral-child`: when `isDetachedEphemeralChildConfig(childConfig)` is `true`, require `before.code !== 0` (refusing `409 child_restart_unsupported` if any foreign/existing listener occupies `childPort`) and tailor the `remoteMayBeConnected` failure `recovery` hint to `"Run ocx-child detach (or ocx disconnect) on the Child before retrying."` so operators are never told to run `ocx restart` after `disconnect`; otherwise keep the exact existing `isChildHealth(beforeHealth, "standalone", childPort)` gate and recovery string for full `ocx`:

```diff
+import { isDetachedEphemeralChildConfig } from "../../link/ephemeral-child";
 ...
+    let ephemeralChild = false;
     let remoteMayBeConnected = false, phase = "remote_port";
     const failed = async (response: Response): Promise<Response> => {
       const compensation = record ? await compensateNewLink(ctx, state, record) : null;
       const outcome = compensation ?? response;
       if (!remoteMayBeConnected) return outcome;
       const payload = await outcome.json() as Record<string, unknown>;
-      return Response.json({ ...payload, residual: true, recovery: "Run ocx disconnect and ocx restart on the Child before retrying." }, { status: outcome.status });
+      const recovery = ephemeralChild
+        ? "Run ocx-child detach (or ocx disconnect) on the Child before retrying."
+        : "Run ocx disconnect and ocx restart on the Child before retrying.";
+      return Response.json({ ...payload, residual: true, recovery }, { status: outcome.status });
     };
 ...
       if (remotePlatform === "posix" && (await run(REMOTE_CURL_PREFLIGHT)).code !== 0) return fail("child_curl_missing", "Install curl on the Child before connecting a Remote Link.", 409);
       const before = await run(remoteChildHttpArgv(childPort, "healthz", LINK_RELAY_VERIFY_MS, remotePlatform));
-      const beforeHealth = before.code === 0 ? parseChildHttp(before.stdout) : null;
-      if (!isChildHealth(beforeHealth, "standalone", childPort)) return fail("child_restart_unsupported", "The Child must run a standalone OpenCodex with bound restart support; update or disconnect it before linking.", 409);
+      ephemeralChild = isDetachedEphemeralChildConfig(childConfig);
+      if (ephemeralChild) {
+        if (before.code === 0) return fail("child_restart_unsupported", "The Child's target port is already in use; disconnect or free the port before linking.", 409);
+      } else {
+        const beforeHealth = before.code === 0 ? parseChildHttp(before.stdout) : null;
+        if (!isChildHealth(beforeHealth, "standalone", childPort)) return fail("child_restart_unsupported", "The Child must run a standalone OpenCodex with bound restart support; update or disconnect it before linking.", 409);
+      }
```

Add `native/ocx-child` source artifacts to `"files"` and add scripts `build:ocx-child` and `test:ocx-child`:

```diff
     "native/remote-workspace-helper/Cargo.toml",
     "native/remote-workspace-helper/Cargo.lock",
     "native/remote-workspace-helper/src",
+    "native/ocx-child/Cargo.toml",
+    "native/ocx-child/Cargo.lock",
+    "native/ocx-child/src",
     "LICENSE"
 ...
     "build:remote-workspace-helper": "cargo build --release --locked --manifest-path native/remote-workspace-helper/Cargo.toml",
     "test:remote-workspace-helper": "cargo test --locked --manifest-path native/remote-workspace-helper/Cargo.toml",
+    "build:ocx-child": "cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml",
+    "test:ocx-child": "cargo test --locked --manifest-path native/ocx-child/Cargo.toml",
```

### 1.5 NEW Tests & Dual Test-Layout Registrations

Register all three new test files in `scripts/test-layout/layout-clients.json` and `tests/fixtures/test-layout-expected.json`:

1. `tests/clients/link-ephemeral-child-discovery.test.ts` (`"clients"`): POSIX & Windows candidate discovery precedence (`ocx` beats `ocx-child`; fallback selects `ocx-child`), Windows encoded PowerShell `< 8000` chars, and `OCX_PROTOCOL_COMPAT_VERSION` (`>= 2.93.0`) compatibility check via `classifyVersionProbe`.
2. `tests/server/link-enrollment-ephemeral-child.test.ts` (`"server"`): Home `probe -> confirm-host -> apply` and `DELETE /api/link/:id` across clean detached `ocx-child`, already-attached `ocx-child` (`409`), busy-port foreign listener (`409`), and full-`ocx` standalone Child (`202`).
3. `tests/clients/link-ocx-child-e2e.test.ts` (`"clients"` — `link-*` prefix per `seeds.json`): End-to-end integration driving the real compiled `ocx-child` Rust binary against a real in-process Home `hub-link` + management server (`RUSTUP_HOME` / `CARGO_HOME` preserved from `OCX_REAL_HOME` per `#7884`): enroll -> SSE inference relay with caller credential stripping -> Home `ocx sync` fan-out updating catalog & Home Codex settings -> daemon rollover (`startedAt >= appliedAt`) + immediate `child-parity` POST verified on Home `GET /api/link/status` -> Child `status --json` -> `--expect-link` mismatch exit `5` (`child-link-mismatch:other_link`) -> `#1798` comment-stripped `DELETE /api/link/:id` & offline `detach` -> byte-accurate restoration and zero running `ocx-child` process.

## 2. Conditional-Path Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

1. **Foreign listener occupying detached `ocx-child` port**: Triggered in `link-enrollment-ephemeral-child.test.ts` -> observed `409 child_restart_unsupported` before `issueKey`.
2. **Full `ocx` precedence over `ocx-child`**: Triggered in `link-ephemeral-child-discovery.test.ts` -> observed `ocx` selected when runnable, `ocx-child` selected when `ocx` missing/broken.
3. **Post-sync runtime rollover & OCX-6 parity**: Triggered in `ocx-child-e2e.test.ts` -> observed `startedAt >= appliedAt` and Home `/api/link/status` `parity.appliedCodexSettingsDigest` matching Home's new digest.
4. **Wrong `--expect-link` fan-out skip**: Triggered in `ocx-child-e2e.test.ts` -> observed `classifySyncResult` returning `{ state: "skipped", reason: "child-link-mismatch:other_link" }`.

## 3. Phase Verifiers

- `bun test tests/clients/link-ephemeral-child-discovery.test.ts tests/server/link-enrollment-ephemeral-child.test.ts tests/clients/link-ocx-child-e2e.test.ts tests/server/link-enrollment.test.ts tests/clients/link-pinned-sync-argv.test.ts tests/clients/link-ssh-argv.test.ts tests/clients/link-ssh-argv-discovery.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/lab/core-link-boundary.test.ts tests/lab/core-lab-boundary.test.ts` (exit `0`)
- `bun run typecheck` (exit `0`)
- `bun run privacy:scan` (exit `0`)
