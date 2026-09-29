# 011 wp1 execution script

Revalidated at wp1 P (2026-09-29): dev 37ad7e771b, main 53834ff47b, preview aa3a8dda16 unchanged;
all six PR heads equal the 010 table. Previous D (wp0) conclusion: roadmap locked, audit PASS,
execute 010 as written.

Run from the managed worktree on branch codex/release-2-71-0 (HEAD e69b48f71e = dev + roadmap,
plus this file once committed). The script lives at .tmp/rt2710/land.sh (gitignored):

```sh
set -eu
git diff --quiet HEAD && git diff --cached --quiet
norm() { grep -E '^(diff --git|[-+])' | grep -vE '^(\+\+\+|---) '; }
land() { # n author subject trailers...
  n=$1; author=$2; subject=$3; shift 3
  head=$(git rev-parse rt/pr-$n); base=$(git merge-base canon/dev rt/pr-$n)
  git diff --binary "$base" "$head" > ".tmp/rt2710/pr-$n.patch"
  git apply --3way --index ".tmp/rt2710/pr-$n.patch"
  body="Lands #$n at head $head on dev through the 2.71.0 integration branch."
  if [ "$n" = 6209 ]; then body="$body

Closes #6208."; fi
  trailers=""
  for t in "$@"; do trailers="$trailers
Co-authored-by: $t"; done
  msg="$subject

$body"
  if [ -n "$trailers" ]; then msg="$msg
$trailers"; fi
  git commit -q --author="$author" -m "$msg"
  pa=$(git diff HEAD^ HEAD | git patch-id --stable | cut -d' ' -f1)
  pb=$(git patch-id --stable < ".tmp/rt2710/pr-$n.patch" | cut -d' ' -f1)
  la=$(git diff --binary HEAD^ HEAD | norm | git hash-object --stdin)
  lb=$(norm < ".tmp/rt2710/pr-$n.patch" | git hash-object --stdin)
  [ "$pa" = "$pb" ] && [ "$la" = "$lb" ] || { echo "diff mismatch for #$n"; exit 1; }
}
# six land calls with the 010 table arguments, in order 6206 6201 6209 6094 5905 6198
test -z "$(git diff --name-status 4d81bf2856 HEAD | grep -v 'devlog/_plan/260929_release_2_71_0/')"
```

D5-D8 (architect, wp1 proposal): fail-fast apply (set -e and clean-tree assert), equality of
each land commit's diff against the PR diff, a blank line before the trailer block (the trailers
string starts with a newline, so "body + newline + trailers" leaves one empty line), and the tree
check against 4d81bf2856 as a command. All accepted. The base assert is on the clean tree rather
than a fixed SHA because this file is committed first.

D6 amended (main, wp1 P): byte equality of `git diff --binary` is the wrong check. A dry run in a
temporary index showed #6209, #5905 and #6198 produce different bytes only because an earlier
land commit already touched the same file (layout rosters, src/cli/index.ts), which shifts hunk
line numbers and context. The check is now `git patch-id --stable` equality plus equality of the
changed lines only (`diff --git` headers and +/- lines, file headers dropped). Dry run: all six
EQUAL on both measures; final tree 4d81bf2856.

Then F1-F4 exactly as 010, each applied with apply_patch and committed by the coordinator.

wp1 C (before wp2's full suite): `bun run typecheck` and the focused test files from 020 in
/private/tmp/rt2710-verify at the wp1 head.
