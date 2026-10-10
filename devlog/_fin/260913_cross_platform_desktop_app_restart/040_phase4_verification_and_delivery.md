# wp4 — Live three-host verification, hosted CI, PR, merge

Procedure and evidence contract. Depends on wp3 (`030`).

## 1. What counts as proof

A restart is proven when the **root shell process identity changes** and the app is
running again. Not "the command exited 0", not "the picker looks right".

For each host, capture before and after:

```
root pid + start time   ->  run the command  ->  root pid + start time
```

A new pid with a later start time, and a live process, is the proof. A same-pid
reading is a failure regardless of what the command printed.

## 2. Host assignment

| Platform | Host | Why this host |
|---|---|---|
| macOS | `macmini-cf` | the command arrives over ssh and is **not** inside the app tree, so the direct path is exercised |
| Linux | `lidge` | Ubuntu 24.04, deb install, real GNOME session on `:1` |
| Windows | `mini` | MSIX install, the platform the original implementation targeted |
| macOS handoff | local | the only host where the caller is inside the tree (`001` §1.3); proves wp5 |

The local machine cannot prove the macOS **direct** path: `001` §1.3 measured this
shell as a descendant of the app, so the guard fires by design. It is instead the
only host that can prove the **handoff** path, which is the harder case. Running the
local handoff proof terminates this session, so it is the last action of the unit,
after the PR is merged, and its evidence is read back from the handoff log
afterwards rather than from the terminal that issued it.

## 3. Getting the branch code onto each host

Each host runs the branch from a checkout, not from its installed `ocx`:

- `macmini-cf`: `~/Developer/opencodex` exists; `~/.bun/bin/bun` 1.3.14.
  `node` is absent from the non-interactive PATH, so every command uses absolute
  paths and `bun`, never the `~/.bun/bin/ocx` npm shim (which fails with
  `env: node: No such file or directory`).
- `lidge`: `~/.local/bin/ocx` is opencodex 2.50.0; locate or create a checkout.
- `mini`: `/c/nvm4w/nodejs/ocx` is opencodex 2.52.0; locate or create a checkout.

Invocation is `bun run src/cli/index.ts sync --restart-codex` from the checkout.

`bun install` on a verification host is **setup for the remote proof**, not the local
product suite that `000` §2 forbids. The prohibition is about substituting local
green for hosted CI; it does not prevent making a remote host able to execute the
code at all. No suite, build, or typecheck runs on any of these hosts.

## 4. Per-host procedure

### macOS (`macmini-cf`)

```
before: ps -Ao pid=,lstart=,comm= | grep 'ChatGPT.app/Contents/MacOS/ChatGPT'
run:    cd <checkout> && ~/.bun/bin/bun run src/cli/index.ts sync --restart-codex
after:  same ps, plus confirm the pid is alive
```

Watch for the Sparkle updater: `001` §1 recorded `Autoupdate com.openai.codex` and an
`Updater.app` staged since Sep 10 on this host. If the relaunch produces a different
bundle version than the one that was stopped, that is Sparkle applying the staged
update on restart, not a defect — record it rather than treating it as noise.

### Linux (`lidge`)

```
before: pgrep -a -f '^/usr/lib/chatgpt/ChatGPT$' ; stat -c %Y /proc/<pid>
run:    cd <checkout> && bun run src/cli/index.ts sync --restart-codex
after:  same, and confirm the new root's parent is init/systemd (relaunched detached),
        not gnome-shell (which would mean a human launched it)
```

Also confirm the captured session variables actually took: the new root's children
must show `--user-data-dir=/home/lidgeai/.config/Codex` and a live GPU process with
`--ozone-platform=x11`. An app that started but cannot reach the compositor would
otherwise look identical from a pid check alone.

### Windows (`mini`)

```
before: powershell -NoProfile -Command "Get-Process ChatGPT | Select Id,StartTime"
run:    cd <checkout> && bun run src/cli/index.ts sync --restart-codex
after:  same
```

This is the regression check: Windows already worked through
`--restart-desktop-app`, and the shared ladder must not have lost anything.

### `ocx system codex-restart --yes`

Run on `lidge` against its own proxy, proving the route path reaches the same module.
Capture the JSON envelope and the root pid change.

## 5. Hosted CI

No local suite (`000` §2). The gate is `gh run list --commit <final head sha>` with
every required check `success` **at that exact sha**. A run against an earlier head, a
cancelled run, a skipped run and a queued run are none of them proof. If the head
moves for any reason — a review fix, a rebase — the previous green is void and the
gate is re-read at the new sha.

## 6. PR and merge

- Branch `codex/260913-cross-platform-desktop-restart`, base `dev`.
- `.github/PULL_REQUEST_TEMPLATE.md` filled completely: Summary, Verification,
  Checklist. `enforce-target` rejects thin or malformed descriptions.
- The description must not describe this as a GUI change — it is not one (`030` §4) —
  so the screenshot gate does not apply.
- Verification section carries the three before/after pid tables and the exact-head
  CI run id. Local suite state is stated as NOT RUN rather than left implied.
- `#2292` is referenced as the issue whose Windows-only decision this supersedes, with
  the reasoning from `000` §4, so a future reader finds the reversal explained rather
  than silently contradicted.
- Merge into `dev` once exact-head CI is green.

## 7. Evidence to record before D

1. Three before/after root-identity tables, one per platform.
2. The `ocx system codex-restart --yes` envelope and its pid change.
3. The exact-head CI run id and per-check conclusions at the merged sha.
4. The merge commit sha on `dev`.
5. The local handoff log line proving wp5 (captured after the fact).

Anything missing is named as missing. A platform without a pid change is not
described as working.

## 8. What is proven by test rather than by a live host

Named here so the PR does not imply live coverage it does not have. These rest on the
focused tests in `030` §6 plus hosted CI:

- `--restart-desktop-app` still working and printing its deprecation line.
- `--restart-app-server-only` reproducing the old narrow behaviour.
- `POST /api/machine/sync`'s `restartCodex` staying unhonored (`030` §4.1).
- The `restart_in_flight` singleton refusal.

`catalog pull --restart-codex` is the one borderline case: it is a real behaviour
change to a real command, so it gets one live invocation on `lidge` against a
loopback catalog URL, checked for the desktop pid change and the
`desktopAppRestarted` envelope field. A flag whose meaning changed deserves better
than a unit test on the host where the change is observable anyway.
