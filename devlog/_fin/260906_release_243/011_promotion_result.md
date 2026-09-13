# Promotion result

Owner reaffirmed shipping this candidate and deferring fixes.

- #3676 merged as 81871b3fa7034250b8d5ba2cbbfde44e40f0e69c; dev version 2.44.0; all PR checks passed.
- #3677 merged as 53c784c2a635b061799e4f7542432a921f548bf9; preview version 2.43.0-preview.20260906; functional PR CI passed, dev-only target policy exception recorded; screenshot added from implementation #3670. Gate had marked promotion draft; explicit ready followed by owner-authorized admin merge completed.
- #3678 merged as 06ec553630fa2ee51a96b5cbf694089021249194; main version 2.43.0; exact candidate push CI 33974061890 and lifecycle 33976119109 success were merge evidence. Duplicate PR macOS test still running at merge, so no claim that PR rollup was all green. CodeQL residual and owner-directed deferral recorded on PR; no alert was dismissed.
- Both release refs contain RC af50c6d3451078a7d298b044c08fd2684c9e8eeb. Main tree identical to RC; preview differs only in package.json version.
- Final release gates: preview CI 33976927260 and service 33976927241; main CI 33976953219 and service 33976953226. Docs deployment 33976953239 accompanies main promotion.

Publication remains pending; these merges alone are not completion.
