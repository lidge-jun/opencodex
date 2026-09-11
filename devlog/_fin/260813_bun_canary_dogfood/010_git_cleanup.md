# WP-1A — Guarded Git Preservation and Synchronization

This document specifies the requested historical cleanup. It contains a destructive `git reset --hard`; execute it only after every preflight assertion passes. It never authorizes `git clean`, deletion of untracked files, a push, or a force-push.

## Expected historical input graph

The cleanup path applies only when all of these are true:

- current branch is `dev`;
- current `dev` contains local-only commits `304fa003d` and `022f6c0b3`;
- `origin/dev` has commits absent from `dev`;
- the worktree has no tracked modifications;
- branch `preview-dev` does not exist, or already points to the current `dev` HEAD.

At roadmap-authoring time, live `dev` already equaled `origin/dev` at `a34d1a5a6`, so an executor seeing that state must take the **already synchronized** path below and must not reset based on the older narrative.

## Step 1 — Capture state and fetch without mutation

```bash
cd /Users/jun/Developer/opencodex

git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/dev
git cat-file -e 304fa003d^{commit}
git cat-file -e 022f6c0b3^{commit}
git fetch origin dev

git log --oneline --decorate -20 dev
git log --oneline dev..origin/dev
git log --oneline origin/dev..dev
```

Fail if `git branch --show-current` is not exactly `dev`.

Fail if this command prints any tracked change (`M`, `A`, `D`, `R`, `C`, or `U` in either index/worktree column):

```bash
git status --porcelain=v1 --untracked-files=no
```

Untracked files are allowed and must remain untouched. Record them before continuing:

```bash
git status --short --untracked-files=all
```

## Step 2 — Select the path from current evidence

### Path A: already synchronized

Use this path when:

```bash
test "$(git rev-parse dev)" = "$(git rev-parse origin/dev)"
test "$(git rev-list --count dev..origin/dev)" -eq 0
```

Do not run `reset --hard`. Verify and exit this phase:

```bash
test "$(git log --oneline dev..origin/dev | wc -l | tr -d ' ')" -eq 0
git status --short --branch
```

If historical preservation is still required and `preview-dev` does not exist, creating it from current `dev` would **not** prove it contains the two commits. Stop and ask which historical ref should own them.

### Path B: historical divergent graph

Use this path only if both local commits are ancestors of current `dev` and absent from `origin/dev`:

```bash
git merge-base --is-ancestor 304fa003d dev
git merge-base --is-ancestor 022f6c0b3 dev
! git merge-base --is-ancestor 304fa003d origin/dev
! git merge-base --is-ancestor 022f6c0b3 origin/dev
test "$(git rev-list --count dev..origin/dev)" -gt 0
```

If any assertion fails, stop. The graph is different from the requested operation and a hard reset is not authorized.

## Step 3 — Preserve current dev exactly as `preview-dev`

Resolve any pre-existing branch first:

```bash
if git show-ref --verify --quiet refs/heads/preview-dev; then
  test "$(git rev-parse preview-dev)" = "$(git rev-parse dev)" || {
    echo "preview-dev exists at a different commit; stop" >&2
    exit 1
  }
else
  git branch preview-dev dev
fi
```

Prove the preservation branch points to the pre-reset HEAD and contains both commits:

```bash
test "$(git rev-parse preview-dev)" = "$(git rev-parse dev)"
git merge-base --is-ancestor 304fa003d preview-dev
git merge-base --is-ancestor 022f6c0b3 preview-dev
git log --oneline --decorate -10 preview-dev
```

Record the immutable preservation SHA:

```bash
PREVIEW_DEV_SHA="$(git rev-parse preview-dev)"
printf '%s\n' "$PREVIEW_DEV_SHA"
```

## Step 4 — Reset local dev to freshly fetched origin/dev

This is the only destructive command in this phase. The preconditions above are the confirmation gate.

```bash
git reset --hard origin/dev
```

Why reset is required for the historical graph: local-only commits make `git pull --ff-only` impossible. The branch backup makes those commits reachable before `dev` is realigned.

## Step 5 — Post-reset proof

```bash
test "$(git rev-parse dev)" = "$(git rev-parse origin/dev)"
test "$(git rev-parse preview-dev)" = "$PREVIEW_DEV_SHA"
test "$(git log --oneline dev..origin/dev | wc -l | tr -d ' ')" -eq 0

git merge-base --is-ancestor 304fa003d preview-dev
git merge-base --is-ancestor 022f6c0b3 preview-dev

git log --oneline dev..origin/dev
git log --oneline dev..preview-dev
git branch --contains 304fa003d
git branch --contains 022f6c0b3
git status --short --branch
```

Required interpretation:

- `git log --oneline dev..origin/dev` prints nothing (zero commits).
- `git rev-parse dev` and `git rev-parse origin/dev` are identical.
- `git log --oneline dev..preview-dev` contains `304fa003d` and `022f6c0b3` when those commits are topologically outside the new `dev`.
- Both `git branch --contains` commands list `preview-dev`.
- Every previously observed untracked path remains present.

Do not merge or cherry-pick `preview-dev` during this phase. It is a preservation branch only.

## Recovery if the reset target was wrong

Do not guess from reflog. The preserved target is explicit:

```bash
git rev-parse preview-dev
git log --oneline --decorate -10 preview-dev
```

Restoring `dev` from `preview-dev` is another destructive reset and requires fresh user approval:

```bash
# APPROVAL REQUIRED
git reset --hard preview-dev
```
