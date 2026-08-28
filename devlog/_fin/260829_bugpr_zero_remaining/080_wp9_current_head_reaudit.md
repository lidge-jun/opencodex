# wp9 — Current-head re-audit of #2638 and #2828

This lane completed with both contributor branches preserved through credited
current-`dev` replacements.

#2845 landed the relevant #2638 commits after current-head review and patch-equivalence
checks. #2846 landed the relevant #2828 commits and added the #2830 repair. The original
pull requests were closed as landed with cross-references rather than being judged from
reviews attached to superseded heads.

Independent review of #2846 found that the first #2830 repair never executed because it
was placed behind `orphans.length === 0`. The branch condition was corrected, and an
anti-vacuity mutation restored the unreachable arrangement to prove the regression test
would fail.

This lane reinforced two campaign rules. Review evidence belongs to the exact head it
examined, and green tests are not enough when the test can pass without activating the
changed branch. Credential-surface findings were fixed and posted as comments, while the
lack of a formal non-author approval remains recorded as an open governance gap.
