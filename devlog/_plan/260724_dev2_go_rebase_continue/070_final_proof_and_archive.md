# 070_final_proof_and_archive

## Objective

Prove final `dev2-go` tip and archive the loop unit.

## Files

### MOVE

| From | To | Before | After |
|---|---|---|---|
| `devlog/_plan/260724_dev2_go_rebase_continue/` | `devlog/_fin/260724_dev2_go_rebase_continue/` | unit under `_plan` | unit under `_fin` after D of this phase |

### MODIFY

| Path | Before | After |
|---|---|---|
| `.codexclaw/goalplans/rebase-and-continue-the-opencodex-go-rewrite-on/goalplan.json` | residual criteria open | criteria met with non-empty capturedEvidence paths/URLs |
| `.codexclaw/goalplans/rebase-and-continue-the-opencodex-go-rewrite-on/ledger.jsonl` | in-progress events | workphase_done for remaining phases |

### NEW / DELETE

None beyond MOVE.

## Copy-executable checklist

```bash
cd /Users/jun/Developer/new/700_projects/opencodex-dev2-go-ports
git status --short --branch
FINAL=$(git rev-parse HEAD)
git merge-base --is-ancestor origin/dev HEAD
cd go && go build ./... && go vet ./... && go test ./... -count=1 -timeout 120s && go test -race ./... -count=1 -timeout 180s && go test ./test/e2e/... -count=1 -timeout 60s && cd ..
gh run list --workflow "Go CI" --branch dev2-go --limit 5 --json databaseId,headSha,conclusion,url
# if none for FINAL:
gh workflow run "Go CI" --ref dev2-go
# require conclusion=success headSha=$FINAL; no Node 20 deprecation in logs
git mv devlog/_plan/260724_dev2_go_rebase_continue devlog/_fin/260724_dev2_go_rebase_continue
# update goalplan criteria capturedEvidence
```

## Accept

- ancestry true
- local gates green
- hosted exact-SHA CI green
- residuals honest
- archive path exists under `_fin`
