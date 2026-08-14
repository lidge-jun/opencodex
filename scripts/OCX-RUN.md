# ocx-run — remote long-job runner (installed on `lidge`)

`~/bin/ocx-run`. Use it for anything that takes minutes: suites, typechecks,
builds, long probes.

## Why

On 2026-08-14 two `bun test` runs sat on `lidge` for **3h12m**. Both had stopped
producing output after ~4 minutes, both were wedged inside `tests/request-log.test.ts`,
and neither would ever write its `.exit` file — so every poller read them as
"still running". A second run had also been started against the same 16 CPUs, so
even healthy work crawled. Three independent failures, three guards:

| Failure | Guard |
|---|---|
| Two runs fight over the CPU | `flock` — one job per name, second is refused |
| A job hangs forever | `timeout` — hard ceiling, `SIGKILL` backstop |
| Caller cannot tell hung from working | status file written on **every** exit path |
| Killing the parent orphans workers | `setsid` + process-group kill |
| `ssh host cmd` has no `bun` on PATH | runner prepends `~/.bun/bin` itself |

That last one is why older call sites all hardcoded `~/.bun/bin/bun`: a
non-interactive `ssh` does not read `~/.bashrc`, so a plain `bun` exits 127.

## Use

```bash
# launch (returns immediately when backgrounded)
ssh lidge 'export PATH=$HOME/bin:$PATH
  nohup ocx-run suite ~/ocx-boundary/repo 40m bun run test > /dev/null 2>&1 &'

# check — RUNNING shows time since last output, so a wedge is visible
ssh lidge 'export PATH=$HOME/bin:$PATH; ocx-run status'

ssh lidge 'export PATH=$HOME/bin:$PATH; ocx-run tail suite 40'
ssh lidge 'export PATH=$HOME/bin:$PATH; ocx-run stop suite'
```

`export PATH=$HOME/bin:$PATH` is needed because the invoking ssh is
non-interactive; the job's own PATH is handled inside the runner.

## Reading status

```
suite: RUNNING (pid 3913859, 3s since last output)   # healthy
suite: RUNNING (pid 3913859, 2400s since last output) # wedged — stop it
suite: OK rc=0 ...
suite: FAIL rc=1 ...
suite: TIMEOUT after 40m (rc=124) ...
```

Pick a ceiling above the honest runtime: the opencodex suite is ~210s idle, so
`40m` is generous. A `TIMEOUT` means investigate, not retry with a bigger number.

## Note on the local machine

`bun run test` already queues behind another runner via `scripts/test.ts`.
Do not set `OCX_TEST_NO_QUEUE=1` to "go faster" — that bypass is what let four
suites stack locally and turn a 210s run into 13 minutes.
