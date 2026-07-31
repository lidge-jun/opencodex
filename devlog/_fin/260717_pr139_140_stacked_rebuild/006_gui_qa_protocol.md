# Shared GUI QA protocol

Every GUI child sets its exact `WP_ID`, `ROUTE`, and viewport list in its decade doc, then runs this copy-paste procedure from the child worktree root. Evidence stays in the implementation unit; refs are discovered from each fresh snapshot and never reused after navigation/state change.

```sh
UNIT=devlog/_plan/260717_pr139_140_child_stack
EVIDENCE="$UNIT/evidence/WP${WP_ID}"
mkdir -p "$EVIDENCE"
(cd gui && bun run dev -- --host 127.0.0.1) >"$EVIDENCE/gui.log" 2>&1 &
GUI_PID=$!
agbrowse start --headless
agbrowse navigate "http://127.0.0.1:5173/${ROUTE}"
agbrowse wait 2000
agbrowse resize 1280 720
agbrowse snapshot --interactive --max-nodes 120 >"$EVIDENCE/1280.snapshot.txt"
agbrowse screenshot --full-page --json >"$EVIDENCE/1280.screenshot.json"
agbrowse console --clear --reload --duration 3000 >"$EVIDENCE/console.txt"
agbrowse network --reload --duration 2000 >"$EVIDENCE/network.txt"
agbrowse resize 760 900
agbrowse snapshot --interactive --max-nodes 120 >"$EVIDENCE/760.snapshot.txt"
agbrowse screenshot --full-page --json >"$EVIDENCE/760.screenshot.json"
kill "$GUI_PID"
agbrowse stop
agbrowse status >"$EVIDENCE/teardown.txt"
```

For each named interactive state in a decade doc: run `agbrowse snapshot --interactive`, act on the current ref with `agbrowse click/type/check/select`, immediately re-run `agbrowse snapshot --interactive`, then save `agbrowse screenshot --full-page --json` output as `$EVIDENCE/<state>.screenshot.json`. Append the before/after commands and observed text to `$EVIDENCE/<state>.md`. A screenshot JSON path is not observation by itself; C must open/read the image and record the visual verdict in the state markdown.

Failure policy: if `agbrowse` cannot connect, run `agbrowse status`, then `agbrowse start --headless` once and retry. Never install another Playwright/Puppeteer runner for this ad-hoc QA. Always terminate the GUI PID and browser session; teardown receipts are the final lines of `gui.log` and `$EVIDENCE/teardown.txt`.
