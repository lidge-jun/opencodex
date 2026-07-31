#!/bin/zsh
set -euo pipefail
cd /Users/sigi/Documents/OpenCodex
git status -sb
git fetch origin dev
git merge origin/dev -m "merge: sync origin/dev (workspace revival + alias fixes)"
echo "MERGE_DONE status:"
git status -sb | head -40
echo "UNMERGED:"
git diff --name-only --diff-filter=U || true
