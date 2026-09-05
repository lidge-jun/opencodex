# Onboarding verification

Source: wp2 on top of core c5ad48c19. No local test suites were executed.

- Root TypeScript, GUI build, lint and i18n lint passed.
- New dialog/hook regression file passed static TypeScript checking.
- Independent source review PASS after fixing explicit config-refresh results and
  API-target A→B→A notice lifetime; no remaining blocking findings.
- Isolated source backend, fake 20-model upstream and separate temporary
  OPENCODEX_HOME/CODEX_HOME. The user's running proxy/config were not changed.
- Real browser Add Provider → custom registration → completed all-OFF notice
  with count 20 → Open Models → registration-demo 0/20 visible, all 20 switches
  unchecked. Existing native OpenAI rows remained 8/8 visible.
- Enabled demo-model-1 in the real UI and reloaded: 1/20 remained visible, its
  checkbox stayed checked, and the other 19 stayed OFF.
- Screenshots 021 and 022 are actual built dashboard captures, not mockups.

Full behavioral regression execution and final landing evidence are supplied by
the exact-head GitHub CI runs and stacked pull requests; static/manual evidence
does not substitute for those gates.
