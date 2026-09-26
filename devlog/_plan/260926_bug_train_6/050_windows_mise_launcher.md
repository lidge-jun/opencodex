# Windows mise launcher test (dev red since f32f9aabd7)

Previous D: batch 8 (#5945) landed. A fresh `dev` run at `fa46080b6c` stayed red only on `windows 6/9`. That job has
failed since `f32f9aabd7`, the first `dev` run after the batch 1–5 merges. The last green run was at `dac1d25f48`.

Three cases from #5878 (`tests/update/update-mise-launcher-target.test.ts`) force `platform: "linux"` and hand the
Linux resolver native Windows paths. The resolver's POSIX suffix check rejects backslash paths, so `runningRoot` is
undefined. The product code returns `null` on any platform other than Linux (`src/update/mise-launcher-target.ts:77`), so
Windows users are not affected. This was verified on the Windows host `mini`: realpath and mise ownership succeed, and the
8.3 short name and junction are not the cause.

Fix (`4c483daf55`, cherry-picked): the launcher-path cases run on POSIX hosts only (`describe.skipIf(win32)`). The four
early-exit cases (macOS, Windows, a service env alone, and a foreground proxy with a service record) move out of that
block, so they still run everywhere, now with a `runningRoot` that throws if it is read.

Check: focused test locally (14 pass) and on `mini` (4 pass, 10 skipped), tsc, exact-head CI including `windows 6/9`.


## Outcome

Merged as #5957 (`8258ef8075`). PR CI skipped the Windows shards by path filter, so a `workflow_dispatch` run on the
branch head `404a1ee502` (run 36249508035) supplied the evidence: `windows 6/9` and every other Windows shard passed.
The next full `dev` run (36250434617, at `8258ef8075`) passed `windows 6/9` as well. It failed only `windows 8/9`, on a
10s timeout in `GET /api/settings reports external Codex ownership`. That job had passed at `404a1ee502` and
`fa46080b6c`, and #5930 landed in between, so the failed job was rerun to tell a flake from a regression.
