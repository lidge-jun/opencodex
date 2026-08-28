# wp5 — Current-`dev` reimplementations

This lane replaced stale, overbroad, or partially correct branches with narrow changes on
current `dev`.

#2842 carried the valid part of #2812 and closed #2810 without broadening the fake-IP
classification. #2843 replaced #2796 and closed #2717 with consistent AgentRouter identity
handling. #2844 replaced #2797 and made the doctor `env_key` check safe, but issue #2713
remains open because that change covered only part of the issue's requested behavior.
#2835 landed its focused Kiro behavior without carrying the earlier host-identifying
measurement note.

#2847 replaced the overbroad #2793 branch with the narrow #2718 keyring fix. #2848 replaced
the very stale #2497 branch with a current-`dev` repair for #2221. #2850 replaced #2744's
combo-recovery work without its unrelated version hunk, and #2851 repaired defects found by
the independent follow-up.

The combo-recovery review found two important verification failures. One test passed when
unrelated plaintext was present, so it did not prove that the intended recovery path ran.
The implementation also wrote secret bytes before hardening the temporary file's
permissions. Both were fixed, and mutation runs demonstrated that the focused tests failed
when each defect was restored.

Contributor pull requests #2812, #2796, #2797, #2793, #2744, and #2497 were closed only
after their replacements landed, with credit and cross-references. Credential-related
members share the unresolved formal-review gap described in `070_wp7_closeout.md`.
