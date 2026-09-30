# 021 wp3 execution: promotion and release

| Step | Evidence |
|---|---|
| Candidate | C = dev `1cd9d25517` (#6240 squash), version sources 2.72.0 |
| Pre-move | #6243 → dev `73289d46ae` (2.73.0), `maintainer-sponsored` after review |
| Preview promotion | `codex/promote-preview-2.72.0`: `-s ours` merge of origin/preview + sync to 2.72.0-preview.20260930 (`14ccfe1a1a`); diff vs C = four version sources; PR #6245 merged (merge commit) → preview `4f9e3f0afb` |
| Main promotion | `codex/promote-main-2.72.0`: `-s ours` merge of origin/main (`77cb00512f`), tree equals C; PR #6246 merged → main `5ab6d52b2a` |
| Push-event gates | preview: Cross-platform CI 36597831993, Service lifecycle 36597831950; main: Cross-platform CI 36597841262, Service lifecycle 36597841450 |

Dispatches (after both gates of a SHA succeed), preview first:

```sh
gh workflow run release.yml -R lidge-jun/opencodex --ref preview -f version=2.72.0-preview.20260930 -f tag=preview -f dry-run=false -f expected-sha=4f9e3f0afbbcf54a2b0421db8e962ec3d5682d5e
gh workflow run release.yml -R lidge-jun/opencodex --ref main -f version=2.72.0 -f tag=latest -f dry-run=false -f expected-sha=5ab6d52b2a4da722d398e4ab50a6c621ac3ce087
```

## Results

| Check | Evidence |
|---|---|
| Preview gates | Cross-platform CI 36597831993 success (push), Service lifecycle 36597831950 success |
| Main gates | Service lifecycle 36597841450 success; Cross-platform CI 36597841262 attempt 1 failed only `test 2/4` (batch 10/48 hit the 120 s process bound; the attribution sweep reported every file passing alone, "the timeout lives in multi-file process state"); one rerun, attempt 2 success |
| Preview release | release.yml 36602348988 success; npm `preview` = 2.72.0-preview.20260930, gitHead `4f9e3f0afb`, bins `ocx`/`opencodex` intact; GitHub release prerelease, 25 assets |
| Stable release | release.yml 36603799783 success; npm `latest` = 2.72.0 (published 17:45 UTC, visible ~10 min later, as with 2.71.0), gitHead `5ab6d52b2a`, bins intact; GitHub release v2.72.0 not prerelease, 25 assets; latest.json 2.72.0 signed for darwin-aarch64, darwin-x86_64, linux-x86_64, linux-x86_64-deb, windows-x86_64 |

npm printed `"bin[...]" script name bin/ocx.mjs was invalid and removed` during both publishes; 2.70.0 and
2.71.0 printed the same, and the registry metadata keeps both bins (the `./` prefix is normalized).
The installed proxy and desktop app on this machine were not updated.
