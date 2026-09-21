#!/bin/sh
# 2.6s for the whole thing, which is the only reason a hook like this survives:
# typecheck, the structural gates, and the red tests that prove each voice
# guard would be noticed if it were deleted.
#
# Not the full suite — that is 24,000 tests and about four minutes. Run
# `bun run test:changed` before pushing, and read it without a pipe.
set -e
cd "$(git rev-parse --show-toplevel)"

# Git hooks run with a minimal environment, not your shell's. This hook
# failed once with "bun: command not found" on a commit that was perfectly
# fine — and a hook that fails for a reason unrelated to correctness is how
# people learn to pass --no-verify.
if command -v bun >/dev/null 2>&1; then
    BUN=bun
elif [ -x "$HOME/.local/bin/bun" ]; then
    BUN="$HOME/.local/bin/bun"
elif [ -x "/opt/homebrew/bin/bun" ]; then
    BUN=/opt/homebrew/bin/bun
else
    echo "pre-commit: cannot find bun; install it, or remove the pre-commit hook from $(git rev-parse --git-path hooks)" >&2
    exit 1
fi

"$BUN" run check
