#!/usr/bin/env zsh
# cursor-call integration driver — the executable form of
# devlog/_plan/260818_cursor_call_integration/{010,020,030,040,050}.
#
# Fifteen audit rounds found the same defect class over and over: a binding written
# as prose that no shell would enforce. Six rounds of fixing the prose kept producing
# new unbound variables, because a document is not a program. This file is the program.
# The decade docs explain WHY each assertion exists; this decides WHAT runs.
#
# Every step is idempotent to re-run and refuses to continue on a failed assertion.
# Nothing here merges or pushes without the operator invoking that step by name.

set -euo pipefail
# `##` in a pattern needs EXTENDED_GLOB. Without it the validator below rejected
# every value, including SHAs — the script could not save anything at all (audit r16).
setopt EXTENDED_GLOB

# Ask git for the root rather than counting `..` — the script lives three levels down
# (devlog/_plan/<unit>/), and an off-by-one put the state file in devlog/.tmp/, which
# is a different directory that happens to also be gitignored. A wrong-but-hidden
# path is exactly the kind of thing this script exists to stop trusting.
ROOT="$(cd "${0:A:h}" && git rev-parse --show-toplevel)" || { print -r -- "[cc] FATAL: not in a git repo" >&2; exit 1 }
cd "$ROOT"
STATE="$ROOT/.tmp/cursor-call-integration.env"
mkdir -p "${STATE:h}"

log ()  { print -r -- "[cc] $*" >&2 }
die ()  { print -r -- "[cc] FATAL: $*" >&2; exit 1 }
# Rewrite the key rather than appending: a re-run must not leave two rows for one
# artifact, because `source` would take the last and a reader would see the first.
save () {
  local key="$1" value="$2" tmp="$STATE.tmp"
  # The state file is `source`d, so an unvalidated value is code. Only SHAs, PR
  # numbers and plain identifiers ever go in here (audit r15).
  [[ "$value" == [A-Za-z0-9._/+-]## ]] \
    || die "refusing to save $key: value is not a plain token"
  : >| "$tmp"
  [[ -f "$STATE" ]] && grep -v "^${key}=" "$STATE" >> "$tmp" || true
  print -r -- "${key}=${value}" >> "$tmp"
  mv "$tmp" "$STATE"
  typeset -g "$key"="$value"
  log "recorded $key=$value"
}

# Re-reading state is what makes each step independently re-runnable after a
# compaction, a disconnect, or a day off.
load_state () { [[ -f "$STATE" ]] && source "$STATE" || true }

# 020 and 050 require the command, its output and the SHA it ran against as evidence.
# A marker in the state file is not that, so every gate also appends a receipt here
# (audit r16). The readiness note quotes from it.
RECEIPTS="$ROOT/.tmp/cursor-call-receipts.log"
receipt () {
  local sha="$1" cmd="$2"; shift 2
  {
    print -r -- "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$sha"
    print -r -- "$ cd <worktree> && $cmd"
    print -r -- "$@"
  } >> "$RECEIPTS"
}

need () {
  local name="$1"
  [[ -n "${(P)name:-}" ]] || die "$name is not set — run the earlier step first (state: $STATE)"
}

live_dev () { git ls-remote origin refs/heads/dev | cut -f1 }
live_branch () { git ls-remote origin "refs/heads/$1" | cut -f1 }

# Create the worktree only if it is missing, then prove it is at the expected SHA AND
# clean. `|| true` on the add would swallow a real failure, and a pre-existing dirty
# worktree can sit at the right HEAD while its tree says something else (audit r15).
remote_worktree () {
  local wt="$1" sha="$2"
  ssh lidge "cd $LIDGE_HOME && { git worktree list --porcelain | grep -qx 'worktree $wt' || git worktree add $wt $sha; }" \
    || die "could not create $wt at $sha on lidge"
  ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$sha\" && test -z \"\$(git status --porcelain)\"" \
    || die "$wt is not a clean checkout of $sha"
}

remote_worktree_remove () {
  ssh lidge "cd $LIDGE_HOME && git worktree remove --force $1" \
    || log "NOTE: could not remove $1 — remove it by hand"
}

# ---------------------------------------------------------------- 010: rebase

step_pin () {
  load_state
  # Re-pinning after downstream artifacts exist silently invalidates them: every
  # later assertion would compare against a base the branch was never rebased onto
  # (audit r15). Force the operator to be explicit.
  if [[ -n "${VERIFIED_TIP:-}" && "${1:-}" != "--repin" ]]; then
    die "VERIFIED_TIP already exists; re-pinning invalidates it. Re-run from scratch, or pass --repin and then re-run rebase/push/verify/cut."
  fi
  # --repin means every downstream artifact describes a base that no longer applies.
  # Drop them rather than leaving stale values that still look valid (audit r16).
  if [[ "${1:-}" == "--repin" && -f "$STATE" ]]; then
    # Remove the remote worktrees BEFORE forgetting their paths, or --repin orphans
    # them on lidge with no handle left to clean them up (audit r16).
    [[ -n "${CC_WORKTREE:-}" ]]  && remote_worktree_remove "$CC_WORKTREE"
    [[ -n "${DEV_WORKTREE:-}" ]] && remote_worktree_remove "$DEV_WORKTREE"
    local keep; keep="$STATE.keep"
    grep -vE '^(VERIFIED_BASE|VERIFIED_TIP|GATES_GREEN_AT|LAYERS_GREEN_AT|PR[123]_HEAD|PR[123]|EXPECTED_DEV|MERGED_DEV|RELEASE_GATES_GREEN_AT|CC_WORKTREE|DEV_WORKTREE)=' "$STATE" > "$keep" || : >| "$keep"
    mv "$keep" "$STATE"
    log "--repin: cleared every downstream artifact; re-run rebase, push, verify, cut, verify_layers"
  fi
  git fetch origin dev
  local base; base="$(live_dev)"
  [[ -n "$base" ]] || die "could not read live dev"
  save VERIFIED_BASE "$base"
}

step_rebase () {
  load_state; need VERIFIED_BASE
  git rev-parse --verify cursor-call-prerebase-260818 >/dev/null \
    || die "snapshot branch missing — it is the only recovery path"
  # 010 EXPECTS two conflicts. Re-running this step mid-rebase must continue, never
  # restart — `git rebase <base>` on a conflicted tree aborts with its own error and
  # would lose the resolution (audit r16).
  if [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]; then
    log "a rebase is in progress — continuing it"
    git rebase --continue
  else
    git rebase "$VERIFIED_BASE"
  fi
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call \
    || die "rebase did not land on VERIFIED_BASE"
  ! grep -rEn "^(<<<<<<<|>>>>>>>|=======$)" src tests >/dev/null 2>&1 \
    || die "conflict markers survived the rebase"
}

step_push () {
  load_state
  need VERIFIED_BASE
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call \
    || die "cursor-call is not on VERIFIED_BASE — run rebase before pushing"
  git push --force-with-lease --no-verify origin cursor-call
  [[ "$(live_branch cursor-call)" == "$(git rev-parse cursor-call)" ]] \
    || die "remote cursor-call does not match local after push"
}

# ------------------------------------------------------- 020: remote verification

# Single-quoted and NOT tilde-expanded: zsh would expand ~ to the LOCAL home, and
# /Users/jun/... does not exist on lidge. The remote shell expands this (audit r15).
LIDGE_HOME='$HOME/Developer/opencodex'

step_verify () {
  load_state
  need VERIFIED_BASE
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call \
    || die "cursor-call is not on VERIFIED_BASE — verifying the wrong tree"
  local tip; tip="$(live_branch cursor-call)"
  [[ "$tip" == "$(git rev-parse cursor-call)" ]] \
    || die "local and remote cursor-call disagree — push first"
  save VERIFIED_TIP "$tip"
  local wt="/tmp/ocx-cc-${tip:0:9}"
  ssh lidge "cd $LIDGE_HOME && git fetch origin cursor-call dev" || die "lidge fetch failed"
  remote_worktree "$wt" "$tip"
  save CC_WORKTREE "$wt"
  ssh lidge "cd $wt && bun install --frozen-lockfile"
  local gate
  for gate in "bun x tsc --noEmit" "bun run privacy:scan" "bun run audit:high" "bun run build:gui" "bun test --isolate tests"; do
    log "gate: $gate"
    local out
    out="$(ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$tip\" && $gate" 2>&1)" \
      || { receipt "$tip" "$gate" "$out"; die "gate failed at $tip: $gate" }
    receipt "$tip" "$gate" "$(print -r -- "$out" | tail -20)"
  done
  save GATES_GREEN_AT "$tip"
}

# --------------------------------------------------------------- 030: the stack

# Exactly one match, or fail. Two commits sharing a subject would otherwise return
# two SHAs and every later assertion would compare against a two-line string (r16).
subject_sha () {
  local hits; hits="$(git log --format="%H %s" "$VERIFIED_BASE"..cursor-call | grep -F "$1" || true)"
  local n; n="$(print -r -- "$hits" | grep -c . || true)"
  [[ "$n" -eq 1 ]] || die "subject '$1' matched $n commits, expected exactly 1"
  print -r -- "$hits" | cut -d" " -f1
}

step_cut () {
  load_state; need VERIFIED_BASE; need VERIFIED_TIP; need GATES_GREEN_AT
  [[ "$(git rev-parse cursor-call)" == "$VERIFIED_TIP" ]] \
    || die "cursor-call moved since verification — re-run step_verify"
  [[ "$GATES_GREEN_AT" == "$VERIFIED_TIP" ]] \
    || die "the gates were green for a different tree"
  local p1 p2
  p1="$(subject_sha "record what shipped for 010 and 020")"
  p2="$(subject_sha "record what shipped for 040")"
  [[ -n "$p1" && -n "$p2" ]] || die "could not locate both stack boundaries by subject"
  [[ "$(print -r -- "$p1" | wc -l)" -eq 0 ]] || true
  git branch -f cursor-call-wire   "$p1"
  git branch -f cursor-call-cancel "$p2"
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call-wire   || die "wire is not on the verified base"
  git merge-base --is-ancestor cursor-call-wire cursor-call-cancel        || die "cancel is not on wire"
  git merge-base --is-ancestor cursor-call-cancel cursor-call             || die "tip is not on cancel"
  local a b c total
  a="$(git rev-list --count "$VERIFIED_BASE"..cursor-call-wire)"
  b="$(git rev-list --count cursor-call-wire..cursor-call-cancel)"
  c="$(git rev-list --count cursor-call-cancel..cursor-call)"
  total="$(git rev-list --count "$VERIFIED_BASE"..cursor-call)"
  (( a + b + c == total )) || die "layers $a+$b+$c do not partition $total"
  log "partition ok: $a + $b + $c = $total"
  save PR1_HEAD "$p1"
  save PR2_HEAD "$p2"
  save PR3_HEAD "$VERIFIED_TIP"
  log "layers cut; run 'verify_layers' before pushing (AGENTS.md:178-180 wants each layer verified at its own SHA)"
}

# AGENTS.md requires each non-trivial PR to carry its own verification, so a layer is
# gated at ITS head, not at the tip's. Full suite stays on the tip (step_verify);
# here each lower layer gets typecheck plus the tests it owns.
PR1_TESTS="tests/cursor-eof-terminal.test.ts tests/cursor-hardening.test.ts tests/cursor-tool-result-image.test.ts tests/cursor-request-builder.test.ts"
PR2_TESTS="tests/cursor-cancel-provenance.test.ts tests/cursor-hardening.test.ts"

verify_layer () {
  local sha="$1" tests="$2" wt="/tmp/ocx-layer-${1:0:9}"
  ssh lidge "cd $LIDGE_HOME && git fetch origin cursor-call-wire cursor-call-cancel" || die "lidge fetch failed"
  # Recorded before the gates so a failure leaves a cleanup handle (audit r16).
  save LAYER_WORKTREE "$wt"
  remote_worktree "$wt" "$sha"
  ssh lidge "cd $wt && bun install --frozen-lockfile"
  ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$sha\" && bun x tsc --noEmit" \
    || die "typecheck failed at layer $sha"
  ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$sha\" && bun test $tests" \
    || die "focused tests failed at layer $sha"
  remote_worktree_remove "$wt"
  save LAYER_WORKTREE "none"
}

step_verify_layers () {
  load_state; need PR1_HEAD; need PR2_HEAD; need GATES_GREEN_AT
  git push --no-verify origin cursor-call-wire cursor-call-cancel
  verify_layer "$PR1_HEAD" "$PR1_TESTS"
  verify_layer "$PR2_HEAD" "$PR2_TESTS"
  # Record WHICH heads were verified, so a later re-cut invalidates the marker
  # instead of inheriting it (audit r16).
  save LAYERS_GREEN_AT "${PR1_HEAD}+${PR2_HEAD}"
  log "layers verified — open the PRs bottom-up, then run: record_prs <pr1> <pr2> <pr3>"
}

# PR numbers are recorded by the operator right after `gh pr create`, because only
# then do they exist. Every later step asserts them rather than assuming.
step_record_prs () {
  load_state
  [[ $# -eq 3 ]] || die "usage: step_record_prs <pr1> <pr2> <pr3>"
  need PR1_HEAD; need PR2_HEAD; need PR3_HEAD
  # 030 requires each PR to point at its layer head and to carry all three template
  # sections. Recording three unchecked numbers would let a mislabeled PR through
  # (audit r16). The BODY's substance is the agent's to write; its STRUCTURE is
  # checkable, so check it.
  local i=1 pr head body
  for pr in "$1" "$2" "$3"; do
    [[ "$pr" == [0-9]## ]] || die "PR $pr is not a number"
    case $i in
      1) head="$PR1_HEAD" ;;
      2) head="$PR2_HEAD" ;;
      3) head="$PR3_HEAD" ;;
    esac
    [[ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" == "$head" ]] \
      || die "PR $pr does not point at its layer head $head"
    body="$(gh pr view "$pr" --json body --jq .body)"
    local section
    for section in "## Summary" "## Verification" "## Checklist"; do
      print -r -- "$body" | grep -qF "$section" \
        || die "PR $pr is missing the '$section' section the template requires"
    done
    (( i++ ))
  done
  save PR1 "$1"; save PR2 "$2"; save PR3 "$3"
}

# ---------------------------------------------------------------- 040: the merge

# Retargeting a merged PR is an error; retargeting one already on dev is a no-op.
retarget_to_dev () {
  local pr="$1"
  local state; state="$(gh pr view "$pr" --json state --jq .state)"
  [[ "$state" == "OPEN" ]] || { log "PR $pr is $state — no retarget needed"; return 0 }
  [[ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" == "dev" ]] \
    && { log "PR $pr already targets dev"; return 0 }
  gh pr edit "$pr" --base dev
}

merge_layer () {
  local pr="$1" expected_head="$2"
  [[ -n "$pr" && -n "$expected_head" ]] || die "merge_layer needs a PR number and its expected head"
  # Resume, not restart. A merged layer is DONE: adopt its merge commit as the
  # current EXPECTED_DEV and move on, so a disconnect between `gh pr merge` and
  # `save` costs nothing and a re-run is a no-op (audit r15).
  local state; state="$(gh pr view "$pr" --json state --jq .state)"
  if [[ "$state" == "MERGED" ]]; then
    local oid; oid="$(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid)"
    [[ -n "$oid" ]] || die "PR $pr reports MERGED with no merge commit"
    # Adopting a merge unchecked would accept a PR someone merged from a different
    # head, or into a different base, as this campaign's output (audit r16).
    [[ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" == "dev" ]] \
      || die "PR $pr was merged into a base other than dev"
    [[ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" == "$expected_head" ]] \
      || die "PR $pr was merged from a head we never verified"
    git fetch origin dev >/dev/null 2>&1 || true
    git merge-base --is-ancestor "$expected_head" "$oid" \
      || die "PR $pr's merge commit does not contain the verified head"
    # And it must have been merged ONTO the predecessor this campaign produced. A
    # merge made after an unrelated commit landed on dev is someone else's history,
    # not the next layer of this stack (audit r16). First parent == base at merge.
    local first_parent; first_parent="$(git rev-parse "${oid}^1" 2>/dev/null || true)"
    [[ "$first_parent" == "$EXPECTED_DEV" ]] \
      || die "PR $pr was merged onto $first_parent, not the expected $EXPECTED_DEV"
    save EXPECTED_DEV "$oid"
    log "PR $pr already merged — adopted $oid"
    return 0
  fi
  [[ "$state" == "OPEN" ]] || die "PR $pr is $state, neither OPEN nor MERGED"
  [[ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" == "dev" ]] \
    || die "PR $pr does not target dev"
  [[ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" == "$expected_head" ]] \
    || die "PR $pr head moved off the verified SHA"
  [[ "$(live_dev)" == "$EXPECTED_DEV" ]] \
    || die "dev moved since the last layer — rebase and re-verify"
  gh pr merge "$pr" --merge --admin
  EXPECTED_DEV="$(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid)"
  [[ -n "$EXPECTED_DEV" ]] || die "could not read the merge commit for PR $pr"
  save EXPECTED_DEV "$EXPECTED_DEV"
}

step_merge () {
  load_state
  need VERIFIED_BASE; need VERIFIED_TIP
  need PR1; need PR2; need PR3
  need PR1_HEAD; need PR2_HEAD; need PR3_HEAD
  need LAYERS_GREEN_AT
  [[ "$LAYERS_GREEN_AT" == "${PR1_HEAD}+${PR2_HEAD}" ]] \
    || die "the layer gates were green for different heads ($LAYERS_GREEN_AT) — re-run verify_layers"
  EXPECTED_DEV="${EXPECTED_DEV:-$VERIFIED_BASE}"
  merge_layer "$PR1" "$PR1_HEAD"
  retarget_to_dev "$PR2"
  merge_layer "$PR2" "$PR2_HEAD"
  retarget_to_dev "$PR3"
  merge_layer "$PR3" "$PR3_HEAD"
  local merged; merged="$(gh pr view "$PR3" --json mergeCommit --jq .mergeCommit.oid)"
  [[ -n "$merged" ]] || die "PR3 has no merge commit"
  git fetch origin dev
  git merge-base --is-ancestor "$VERIFIED_TIP" "$merged" \
    || die "the verified tip is not an ancestor of the merge result"
  # dev may legitimately advance past our merge, but the merge must BE on dev — a
  # merge commit that never landed there would send the release gates somewhere else.
  git merge-base --is-ancestor "$merged" "$(live_dev)" \
    || die "PR3's merge commit is not on dev"
  # Saved LAST: a durable MERGED_DEV is a claim that both proofs passed, and
  # release_gates trusts it on a later invocation (audit r16).
  save MERGED_DEV "$merged"
  [[ "$(live_dev)" == "$merged" ]] \
    || log "NOTE: dev has moved past our merge — 050 must say so in the readiness note"
}

# ------------------------------------------------------- 050: release gates on dev

step_release_gates () {
  load_state; need MERGED_DEV
  local wt="/tmp/ocx-dev-${MERGED_DEV:0:9}"
  ssh lidge "cd $LIDGE_HOME && git fetch origin dev" || die "lidge fetch failed"
  remote_worktree "$wt" "$MERGED_DEV"
  save DEV_WORKTREE "$wt"
  ssh lidge "cd $wt && bun install --frozen-lockfile"
  local gate
  for gate in "bun x tsc --noEmit" "bun run privacy:scan" "bun run audit:high" "bun run build:gui" "bun test --isolate tests"; do
    log "dev gate: $gate"
    local out
    out="$(ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$MERGED_DEV\" && $gate" 2>&1)" \
      || { receipt "$MERGED_DEV" "$gate" "$out"; die "release gate failed on dev: $gate" }
    receipt "$MERGED_DEV" "$gate" "$(print -r -- "$out" | tail -20)"
  done
  save RELEASE_GATES_GREEN_AT "$MERGED_DEV"
}

# 050 requires the readiness note to quote LIVE release state, never a cached ref.
# Printed for the note, not saved: these are facts about a moment, not artifacts the
# later steps assert against.
step_release_state () {
  load_state; need MERGED_DEV; need RELEASE_GATES_GREEN_AT
  [[ "$RELEASE_GATES_GREEN_AT" == "$MERGED_DEV" ]] \
    || die "the release gates were green for $RELEASE_GATES_GREEN_AT, not $MERGED_DEV"
  print -r -- "MERGED_DEV=$MERGED_DEV"
  print -r -- "live main=$(git ls-remote origin refs/heads/main | cut -f1)"
  print -r -- "live dev=$(live_dev)"
  print -r -- "--- latest tags"
  git ls-remote --tags origin | tail -5
  print -r -- "--- npm dist-tags"
  npm view @bitkyc08/opencodex dist-tags 2>&1 | head -10
  print -r -- "--- releases"
  gh release list --limit 3 2>&1 | head -5
  print -r -- "--- write 060_release_readiness.md with the gate output, these refs, the"
  print -r -- "--- governance position from 040, the open follow-ups, and a go/no-go."
}

# 020 and 050 both require the verification worktrees to be removed when their phase
# closes. Kept as its own step so a failed gate leaves the tree available to inspect.
step_cleanup () {
  load_state
  [[ -n "${CC_WORKTREE:-}" ]]  && remote_worktree_remove "$CC_WORKTREE"
  [[ -n "${DEV_WORKTREE:-}" ]] && remote_worktree_remove "$DEV_WORKTREE"
  [[ -n "${LAYER_WORKTREE:-}" && "$LAYER_WORKTREE" != "none" ]] && remote_worktree_remove "$LAYER_WORKTREE"
  log "cleanup done"
}

# ------------------------------------------------------------------------ driver

main () {
  local step="${1:-}"
  [[ -n "$step" ]] || die "usage: cursor-call-integration.zsh <step> [args] — steps: pin rebase push verify cut verify_layers record_prs merge release_gates release_state cleanup state"
  shift
  case "$step" in
    pin)            step_pin "$@" ;;
    rebase)         step_rebase ;;
    push)           step_push ;;
    verify)         step_verify ;;
    cut)            step_cut ;;
    verify_layers)  step_verify_layers ;;
    record_prs)     step_record_prs "$@" ;;
    merge)          step_merge ;;
    release_gates)  step_release_gates ;;
    release_state)  step_release_state ;;
    cleanup)        step_cleanup ;;
    state)          load_state; [[ -f "$STATE" ]] && cat "$STATE" || log "no state yet" ;;
    *)              die "unknown step: $step" ;;
  esac
}

main "$@"
