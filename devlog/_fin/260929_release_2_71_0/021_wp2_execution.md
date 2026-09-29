# 021 wp2 execution

Previous D (wp1): integration head 441aeb179e built; typecheck and 16 focused files (321 tests) pass
in /private/tmp/rt2710-verify; the only skip is the real-Windows priority readback, which the
Windows CI shards run. Direction unchanged: run the full 020 gate set on that head.

Head under test: 441aeb179e (verification worktree /private/tmp/rt2710-verify, detached).

Gate script .tmp/rt2710/wp2-gates.sh (each gate's exit is recorded; the script does not stop at the
first failure so every gate reports):

```sh
cd /private/tmp/rt2710-verify
test "$(git rev-parse HEAD)" = 441aeb179e173c7778afdbecf2d2ad1675146cd6
run() { name=$1; shift; "$@" > /private/tmp/rt2710-gate-$name.log 2>&1; echo "$name exit=$?"; }
run typecheck bun run typecheck
run lint-gui bun run lint:gui
run build-gui bun run build:gui
run privacy bun run privacy:scan
run structure bun run structure:check
run skill-surface bun run skill:surface:check
run gui-tests sh -c 'cd gui && bun test tests'
run docs-build sh -c 'cd docs-site && bun install --frozen-lockfile && bun run build'
run full-test bun run test
git status --short   # must be empty: no gate may leave tracked changes
```

Classification of any full-test failure: rerun the failing files alone with
`bun scripts/test.ts <file>` in /private/tmp/rt2710-verify and in /private/tmp/rt2710-base (dev
37ad7e771b). Pass alone at head = load flake (record); fail at head and pass at base = regression
(fix in a new commit, return to wp1 amendment); fail in both = pre-existing (record, not ours).
Base reference: 9 load-timeout failures (020).

Independent review in parallel with the gates: a fresh Kimi reviewer reads
`git diff 37ad7e771b..441aeb179e` and `git log --format=%B` for the ten commits and reports
defects in the union (cross-PR interactions, i18n key collisions, capability counts, docs
contradictions). REVIEW-SYNTHESIS: each finding accepted (fix commit) or rebutted with reason.

Exit: all gates exit 0 after classification, review findings dispositioned, working tree clean.

D9 (architect, wp2): the union touches eight docs-site pages and no other gate builds docs-site
(deploy-docs.yml runs on main only), so an Astro build is added. Accepted. The architect confirmed
no path under desktop/, go/, app/ or native/ is touched, so the macOS/cargo helper suites are not
needed; root `bun run test` does not run gui/tests, so the separate gui gate stays.

Audit (Kimi 01a0eb66, PASS). Dispositions: the deps gate ran when the verification worktree was
created (`bun install` root and gui at 441aeb179e, lockfiles unchanged vs dev). The "fail in both"
classification compares the named test and its error text, not only the file, because #6198 and
#6209 touch the spawned-CLI area where the base has load timeouts. Union finding 1 (F1 paths "do
not exist") is rebutted: both files exist on the #6079 head that the paragraph describes
(`git ls-tree rt/pr-6079`: src/codex/desktop-compatibility/usage-policy.ts and runtime-ownership.ts,
with the cited line ranges matching).
