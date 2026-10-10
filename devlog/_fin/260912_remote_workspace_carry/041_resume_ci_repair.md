# Resumed final-tip verification

The integration branch was fast-forwarded from 5c462fec1a to existing remote head 4ad1d1ce54 without rewriting the six intervening commits. PRs #4344, #4362 and #4372 remain open. CI run 34683454076 at 4ad1d1ce54359ee25fbb078344a22bdb16f7e304 failed; cancelled and skipped jobs are not passing evidence.

## Scoped repair

MODIFY tests/clients/remote-workspace-activation.test.ts: provide the HTTP Host precondition that managementRequestOrigin requires. Preserve 200/404 expectations and assert the admin-token denial message so a generic origin failure cannot satisfy the consent regression.

MODIFY tests/clients/remote-workspace-sessions.test.ts: observe pending rejection using native Promise settlement, release the held start/availability gate, then assert rejection. Keep late runtime cleanup, one-stop/one-close checks, terminal failure state, and assert zero model prompts. Production cleanup code is unchanged. The source dependency order is verified; Bun matcher scheduling remains a hypothesis until repaired-head hosted execution confirms it.

The host goal is observed blocked and the native cycle remains C; no direct goal/FSM edits or reset were performed. This repair continues the incomplete integration Check under explicit resume authorization. It is not claimed as an additional completed cycle. Local suites/build/typecheck/install are NOT RUN. Independent inherited-model review and final cumulative-tip hosted CI remain required.

## Render provenance

Dashboard artifact 10294424393 from run 34683454076 records merge-ref commit 5270d422166eb56692d1fde1513d5ff4f40533d4 and GUI tree 69b1bce039ee18cecea2586bc484c2afe0523a13, equal to candidate 4ad1d1ce54:gui. It is rendered with synthetic example state on a loopback static server; mutations are disabled. This proves the captured layout only, not real pairing or runtime execution.

Observed screenshots: assets/041_desktop_read_only.png and assets/042_desktop_files_only.png at 1440x913 CSS pixels. The actual access picker changes from Read only to Edit files only and displays the command-unavailable notice. No live enrollment or model operation was invoked. A requested390px native-window resize stopped at500px; that is not390px proof, and no narrower layout claim is made. The installed browser CLI does not expose the documented script command; no driver was installed to work around it.

## Windows subprocess fixtures

Run34693137770 at d1a922ae reports three remote-owned fixture failures on Windows: two native response cases cannot execute a POSIX shebang file, and the cwd case times out while starting PowerShell. The intended contracts are bounded stdin/response decoding and real child cwd; neither requires a shell. Replace only test subprocess fixtures with the exact current Bun executable, preserve helper-path checks, timeout/output bounds and success/error assertions. Native Windows command support remains disabled. Local suites remain NOT RUN; independent source review and repaired-head hosted proof are required.

The Windows native fixture keeps descriptor keys separate from its injected spawn function, verifies all pipe options before forwarding them unchanged, and never executes authority from the input JSON. Cwd checks compare decoded stdout with the canonical executor directory and exclude the canonical coordinator directory. An exact exit-code/empty-stderr assertion accompanies the unchanged deadline. At predecessor d1a922ae, hosted Windows2 job103552067478 passed the corrected disabled management status case; that narrow result is not an all-suite pass.
