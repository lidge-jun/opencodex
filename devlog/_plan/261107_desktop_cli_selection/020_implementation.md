# Implementation evidence

Base: 553a6216f38af4b41ca3de20e12624b22d92b34a.

Modified the target validation and spawn failure paths to return errors without package continuation. Declarations remove the unreachable continuation variant; existing onSpawn callback, sync mutex and signal handling remain. Updated the current runtime contract, terminal-command and user installation/uninstall guidance.

Red: pinned Bun 1.4.4 ran the five changed refusal tests against original production code. Exit 1; 0 pass, 5 fail. The real launcher returned exit 0 when a selected target was missing, demonstrating package fallback.

Green: `node_modules/.bin/bun test tests/cli/ocx-launcher-desktop-handoff.test.ts`, exit 0; 43 pass, 1 root-only skip, 0 fail, 331 assertions. Includes real launcher marker proving no Bun execution during missing/denied/restored target selection; explicit bypass control runs that marker. Raw local receipts remain in ignored scratch.

`git diff --check`: exit 0. Dependency preparation `bun install --frozen-lockfile`: exit 0, no tracked lockfile change.

Exact-base independent review and remaining verification dispatched to a separate GOAT-managed remote checkout. NOT RUN here: typecheck, structure/privacy gates, docs build, full suite, Windows native runtime, deployment, live post-recovery sync. Current passing launcher tests do not certify Child recovery or that this patch is installed.
