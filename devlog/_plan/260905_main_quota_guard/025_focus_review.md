# UI review follow-up

Parent runtime rebased onto f42d86fca: fresh-only lower usage recovery, existing minute sweep, malformed-negative rejection, cold hydration and quarantine-preserving background refresh. Public English/Korean guide now describes that contract. Docs build passed425pages.

External review3938946546 identified missing disable-path focus restoration. The switch now arms restoration for either action, focuses the section while authoritative reload leaves it disabled, and restores the enabled toggle after successful GET. Independent Descartes review found an additional delayed-recovery focus steal after deliberate departure; the section now cancels intent on a non-null focus target outside itself. Null-target disabled-control blur and internal navigation retain intent. ACK/save-versus-refresh semantics are unchanged.

Descartes final source review PASS, blocking_issues0. Existing setting test397lines plus new focused82line departure/null-target regression authored for CI, not executed locally. GUI build/typecheck, lint and GUI-scoped React Doctor0.9.11 passed after the final fix. Existing responsive screenshots remain visually representative because this amendment changes focus behavior only.

Isolated browser check used fixture ports15141/15142, not live10100. Successful disable restored focus to the toggle; failed PUT plus failed GET focused the setting section and kept the switch disabled. No real account, upstream inference or reset credits were used.

Departure scenario also passed in the real browser: after failed PUT/GET, focused the separate usage-threshold input, restored the fixture GET endpoint, and let the actual30s settings poll complete. The protected switch became enabled while focus remained on the threshold input.
