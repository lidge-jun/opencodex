# 011 — wp2 execution: three Linux lanes on lidge

Re-verified against `origin/dev` 93ed1a40b4: the two commits after `d17a9f2239` (#6846, #6848) touch no file under
test, so 010 and its dispositions stand. Architect proposal (Dewey, 01a1225a-9e23) D1-D6 accepted as below.

## Host hazards found in P

- lidge runs the user's own npm `ocx` proxy (PID 3280942) on `127.0.0.1:10100`. No probe may reach, stop or replace
  it: every Desktop and `ocx` probe runs in a loopback-only network namespace, and each lane re-checks that PID and
  the port listener before and after.
- `/`, `/var/tmp`, `/tmp` and `/home` share one ext4 filesystem, so an overlay upper directory on `/var/tmp` overlaps
  `lowerdir=/`; upper and work go on a tmpfs mounted inside the private mount namespace (D3).
- <user>'s umask is 002; the PATH-Bun fallback skips group-writable Bun files or directories (D6).

## Decisions

| ID | Decision | Disposition |
|---|---|---|
| D1 | Live Desktop checks (L9 with Desktop, L10 refusals) run in lane A, the only place a dev Desktop exists; lane B uses fixture records | accepted |
| D2 | Each lane has its own clone and `BUN_INSTALL`, `BUN_INSTALL_CACHE_DIR`, `npm_config_cache` under `/tmp/ocx-probe-261010/<lane>`; only `~/.cargo` is shared (cargo locks it) | accepted |
| D3 | Overlay of `/` with tmpfs upper/work inside `sudo setsid -f unshare --mount --pid --fork --propagation private`, fresh `proc`, rbind `/dev` `/sys`, tmpfs over `/tmp` `/run` `~`; enter with `nsenter -t <holder> -m -p -r -w` | accepted |
| D4 | Loopback-only network namespace for every Desktop/`ocx` probe; Desktop as `ocxprobe` under `dbus-run-session -- xvfb-run -a` with `WEBKIT_DISABLE_DMABUF_RENDERER=1`; apt inside the overlay with a `policy-rc.d` returning 101 | accepted |
| D5 | `bun install` with the host Bun, then the repo's `node_modules/bun/bin/bun.exe` (1.4.2) for `build:gui`, `prepare-sidecar` and `x tauri build` | accepted |
| D6 | L11 temp Bun directory and binary `chmod 755` | accepted |

## Lanes

| Lane | Rows | Workspace | Returns |
|---|---|---|---|
| A — packaged deb | L3, L5-L7, live L9/L10, L12; 020 audit items 1 and 5 | clone `/tmp/ocx-probe-261010/a`; overlay namespace | namespace PIDs and mounts; `dpkg -s open-codex` inside vs outside; `cli.json`; each rc diff; LOGIN/INTERACTIVE/`command -v ocx` per shell mode; status/doctor/resolve with Desktop live; guard refusal text; Desktop log tail; revert checks |
| B — launcher and diagnostics | L8, L9 without Desktop, L10 focused tests, L11, F4 | clone `/tmp/ocx-probe-261010/b`; temp HOMEs on the real root; probes inside a loopback netns as <user> with `env -i` and a PATH without `~/.local/bin` | `--version` through npm-global (`npm_config_prefix`), bun-link and a linuxbrew-shaped path, with and without `OCX_NO_DESKTOP_HANDOFF=1`; record-state table (missing, disabled, ready, unsafe mode, pending, oversize, target missing, target is self) with status/doctor lines; resolve output; L11 notice and the 1.3.14 failure text; focused test results with the repo Bun |
| C — F1 lock-busy | L1, L2, F1 | existing `/tmp/ocx-probe-261010/repo` | pass/fail counts for 30 parallel and 30 `--test-threads=1` runs with load average; on failure errno and holder process from a `/proc/*/fd` inode scan during an instrumented 3 s sleep; cause verdict; L2 ignored real-shell result |

## Stop conditions

- Any lane: the host proxy PID or the `:10100` listener changes, `dpkg -s open-codex` stops reporting 2.61.0, or
  `/etc/passwd` or a file in `~` changes → stop and revert.
- A: overlay mount fails → stop and report; Desktop not up in 120 s after one software-rendering retry → row
  unverified per audit item 1.
- B: any probe reaches port 10100 → stop.
- C: 60 runs without a failure → "not reproduced", no fix PR for F1 (the first-run failure stays recorded).
- Revert: kill the namespace holder, require `lsns -t mnt` and `findmnt` free of `ocx-probe`, then
  `sudo rm -rf /var/tmp/ocx-probe`; lanes B/C remove their `/tmp/ocx-probe-261010/<lane>` and any netns they created.

Every mutation is logged in the worktree `.tmp/host-changes.md` (via the coordinator) before it happens.

## Reflection (Dewey, same architect): MISALIGNED → dispositions

1. The namespace holder runs `exec chroot $M sleep infinity`; every later step enters with
   `sudo nsenter -t <holder> -m -p -r -w`, so the root is the overlay (D3 corrected).
2. Before the holder starts, `sudo mkdir -p /var/tmp/ocx-probe /var/tmp/ocx-probe-evidence` is logged as a host change.
   Inside the namespace, `/var/tmp/ocx-probe-evidence` is bind-mounted to `$M/evidence` so lane A's results survive the
   tmpfs teardown, and the overlay's dangling `/etc/resolv.conf` symlink is replaced by the host file's contents.
3. The network namespace (`ip netns add ocxprobe261010`, loopback up) is created after apt and the fish download, kept
   alive by its own named namespace, and every Desktop, status, doctor, resolve and guard probe runs in that one
   namespace (`ip netns exec ocxprobe261010 nsenter ...` or the reverse order, whichever works with the chroot).
   Revert: `sudo ip netns delete ocxprobe261010`.
4. Lane B uses the pinned Bun for `bun install` and `build:gui` before `npm pack` (`prepack` → `prepare:package`).
5. Stop condition watches named paths only: `~/.bashrc`, `~/.profile` (sha256 recorded first), `~/.opencodex` (mtime of
   its top-level files), absence of `~/.opencodex-desktop`, `~/.local/lib/node_modules/@bitkyc08`; `~/.cargo` is shared
   by design.
6. Revert check: record the holder PID and `readlink /proc/<pid>/ns/mnt` at start; revert requires the PID gone and that
   inode absent from `sudo lsns -t mnt` before `sudo rm -rf /var/tmp/ocx-probe`.

## Audit (independent Sol, 01a1226f-82b1): FAIL → dispositions

These supersede earlier rows where they conflict.

1. **Fixed entry and gate.** Lane A creates the netns first on the host (`sudo ip netns add ocxprobe-a`,
   `sudo ip -n ocxprobe-a link set lo up`; no other interfaces), and the mount/PID holder is started *inside* it:
   `sudo ip netns exec ocxprobe-a setsid -f unshare --mount --pid --fork --propagation private sh -c '<D3 setup>; exec chroot $M sleep infinity'`.
   Network access for apt and the fish tarball is done before that, by downloading on the host into
   `/var/tmp/ocx-probe-evidence/in/` (debs via `apt-get download` of xvfb and its deps, fish tarball, the dev deb) and
   installing inside the overlay from those files with `dpkg -i` only. Every later command enters with exactly
   `sudo nsenter -t <holder> -m -p -n -r -w <cmd>` and is preceded by a gate script that aborts unless:
   `readlink /proc/self/ns/mnt` and `/proc/self/ns/pid` equal the holder's recorded inodes, `/proc/self/ns/net`
   equals `ocxprobe-a`'s inode, `ip -o link` lists only `lo`, and `test -f /evidence/.overlay-marker` (a file written
   only into the overlay at setup). Lane B uses its own `ocxprobe-b` netns with the same gate minus the overlay checks.
2. **Deb route.** The dev deb is copied from lane A's host clone to `/var/tmp/ocx-probe-evidence/in/` with its sha256
   recorded, then installed inside the overlay from `/evidence/in/`. Before and after: host `dpkg -s open-codex`
   reports 2.61.0 and `sha256sum /usr/bin/ocx` on the real root is unchanged.
3. **Evidence and rollback.** Evidence is copied back with `rsync -a lidge:/var/tmp/ocx-probe-evidence/out/
   <worktree>/.tmp/evidence/lidge-a/`; then the holder is killed, its mount-ns inode must be absent from `sudo lsns -t mnt`,
   `sudo ip netns delete ocxprobe-a`, `sudo ip netns delete ocxprobe-b`,
   `sudo rm -rf /var/tmp/ocx-probe /var/tmp/ocx-probe-evidence`, and
   `ls -d /var/tmp/ocx-probe* /tmp/ocx-probe-261010` must fail; `ip netns list` must not show either name.
   A rerun must first confirm that `/var/tmp/ocx-probe` and `/var/tmp/ocx-probe-evidence` do not exist (or use fresh
   `mktemp -d` paths): `mkdir -p` accepts existing directories, and this cleanup removes everything under the fixed paths.
4. **Supervision gate.** Live L9/L10 coverage is claimed only if `resolve --json` (or a direct
   `inspectDesktopSupervision()` call) inside the namespace reports `kind: "desktop"` for the Desktop's child;
   otherwise those rows are recorded unverified with the inspector's actual result.

5. **Root proof.** The gate requires `stat -f -c %T /` = `overlayfs` and `test -f /.ocxprobe-overlay-root`, a marker
   written to `$M/.ocxprobe-overlay-root` after the overlay mount (it lives only in the tmpfs upper layer); the
   `/evidence` marker is dropped.
6. **Per-path ownership and cleanup.** Each lane removes only what it owns, after it finishes, and checks each path
   separately with `test ! -e <path>`:
   - lane A: `/tmp/ocx-probe-261010/a`, netns `ocxprobe-a`, holder ns, `/var/tmp/ocx-probe`;
   - lane B: `/tmp/ocx-probe-261010/b`, netns `ocxprobe-b`;
   - lane C: `/tmp/ocx-probe-261010/repo` and `/tmp/ocx-probe-261010/c`;
   - coordinator, after all three: `/var/tmp/ocx-probe-evidence` (after rsync) and the now-empty `/tmp/ocx-probe-261010`.
