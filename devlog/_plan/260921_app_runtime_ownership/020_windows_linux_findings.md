# Windows and Linux release readiness

Second external review, covering what stands between this tree and shipping the desktop app on
Windows and Linux. Every claim below was re-read against `a499746395` before being recorded.

## Confirmed by reading the tree

**The Windows release job runs bash syntax under PowerShell.**
`.github/workflows/release.yml:347` — `Rename release assets` uses backslash line continuations
and `"$RELEASE_VERSION"` expansion, and carries no `shell: bash`. The workflow sets no top-level
`defaults.run.shell` either; only two other steps (lines 117 and 146) opt in explicitly. A Windows
runner defaults to PowerShell, so this step does not mean on Windows what it means elsewhere.

**Checksums record a path the verifier cannot resolve.**
`release.yml:159` writes `sha256sum "dist/ocx-<version>-<target>.tar.gz" > dist/....sha256`, so
the checksum file contains the path `dist/ocx-...`. `release.yml:472` then verifies with
`cd dist/release && shasum -a 256 -c ./*.sha256`, which resolves that recorded path relative to
`dist/release` — a directory that has no `dist/` inside it.

**Publishing does not depend on packaging.**
`release.yml:483` — `publish` declares `needs: validate-dispatch` only. npm publication and the
GitHub release can proceed while desktop packaging is failing, which is how a version becomes
public with no app attached.

**`ocx.exe` is not recognised as an opencodex process.**
`src/config/process-state.ts` `isOcxCommandLine` matches
`(?:ocx|opencodex)(?:\.cmd)?` — no `.exe`. Meanwhile `scripts/build-standalone.ts:37` and
`desktop/scripts/prepare-sidecar.ts:39` both emit `ocx.exe` on Windows targets, and the sidecar is
copied as `ocx-<triple>.exe`. This predicate feeds pid identity, so the shipped Windows binary is
the one shape the identity check does not know.

**The Windows app origin is not in the navigation allowlist.**
`desktop/src-tauri/src/window.rs` permits the `tauri` scheme and `http://127.0.0.1:<port>`, and
sends everything else to the external browser. Tauri serves the local app over
`http://tauri.localhost` on Windows, which lands in the external-browser branch. The policy
mismatch is confirmed; what the WebView2 first navigation actually does was not reproduced.

**The service path filter does not cover the service directory.**
`.github/workflows/service-lifecycle.yml:7` and `release.yml:636` both key on `src/service.ts`.
The implementation is `src/service/**` — eleven files. A change to `launchd.ts` or
`windows-scheduler.ts` alone does not trigger the lifecycle workflow.

**`desktop shell` does not exercise a real sidecar.**
`.github/workflows/ci.yml:1253` creates the sidecar with `: > "desktop/src-tauri/binaries/ocx-<triple>"`
and `chmod +x`, then runs fmt, clippy and cargo test. That is a useful Rust check and it is not
evidence that the bundled binary runs.

**The Windows suite is out of the push gate by design.**
`ci.yml` gates `platform-windows` on `workflow_dispatch`, with a comment saying Windows
re-enters the gate once its tracked failures are fixed. So the review's observation is right, but
this is a recorded decision rather than an oversight. It still means a green push tells you nothing
about the Windows app.

**Standalone binaries target modern x64 only.**
`scripts/build-standalone.ts` builds `bun-windows-x64` and `bun-linux-x64` with no baseline
variant. A CPU without the newer instruction set would fail as an immediate sidecar exit, which the
shell currently reports as a generic health failure.

**Start-up failures are indistinguishable and can be slow.**
`proxy.rs` sets a 4s per-request timeout; `sidecar.rs` polls 20 times with 150ms sleeps and
discards the spawn event stream into `_events`. A failure mode where every probe times out is
arithmetically over a minute, with no exit code and no diagnostic surfaced.

## Confirmed shape, consequence not reproduced

- Stop treats an HTTP 200 with parseable JSON as success without reading `success: false`, and
  does not wait for the backend's post-response drain before killing the child.
- Linux inherits the macOS menu-bar assumption: the window is created hidden and close always
  hides, which on a desktop without a working tray leaves a running process with no way back in.
- Tray capability differs per platform — a title is macOS-only — so usage shown as tray title has
  no Windows or Linux equivalent.
- `.deb` and AppImage are both shipped while the updater manifest is AppImage-shaped, and the
  update code does not branch on install format.
- Rust reads `HOME` before `USERPROFILE`; Node's `homedir()` prefers `USERPROFILE` on Windows.
  Under Git Bash the two can differ, which presents to a user as missing accounts.
- Windows code signing for the installer and executables is separate from the updater's minisign
  key, and no Authenticode configuration was found.

## Ordering the review proposes

1. Release pipeline: the Windows shell, the checksum paths, and no publication before packaging.
2. Instance identity and config home: recognise `.exe`, one home for both sides, prove the
   connected process is the spawned child.
3. A graceful shutdown coordinator shared by stop, quit and update.
4. Per-OS first run, window and tray behaviour.
5. Update target and install format separation, app versus CLI.
6. An installed-artifact gate: first run, coexistence, stop, update and uninstall from the real
   MSI, deb and AppImage.

The closing judgement is the one worth keeping: the Swift episode was not about Swift. Compiling,
bundling and registering each failed to prove running. The same gap is still open on Windows and
Linux.

