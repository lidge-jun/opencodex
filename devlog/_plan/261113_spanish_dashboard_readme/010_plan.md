# Spanish dashboard and README follow-up

This is one follow-up to the Spanish website and documentation in #7559
(original request: #1551). It brings forward the dashboard and README prepared
after #7406 as separate commits in this pull request. The base includes the
subsequent Spanish documentation parity fixes, including #8648.

- Add neutral Spanish to the dashboard shared by browsers and OpenCodex
  Desktop, including the current shell and per-page copy tables.
- Reuse the same client-side preference and catalog contract, including
  language initialization for the classic entry. Native shell and CLI messages
  are separate from the dashboard.
- Publish a Spanish README with current install, integration and privacy
  guidance, linked alongside the other README translations.
- Document the existing Remote Link readiness reason in its Spanish status
  list, and fix the specific Spanish wording issues in the dashboard and
  Codex guides.

Validate with the locale, GUI and documentation tests, the GUI and docs builds,
and root checks. Browser screenshots use synthetic data and are attached to
the PR outside the source branch. See the PR's Verification section for the
commands, results and any environment limitations.
