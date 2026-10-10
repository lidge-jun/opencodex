# Attribution implementation evidence

Backend worker Harvey implemented the audited classifier, price-option propagation, summary
marker, Logs attempt DTO consistency and missing-policy rejection. Main implemented provider
model annotation, per-provider share calculation and the usage cache version bump.

- Production direct TypeScript checker: exit 0.
- GUI direct typecheck/build: exit 0; existing large-chunk warning only.
- GUI i18n lint: exit 0.
- Privacy scan: passed.
- Public docs Astro build: exit 0, 425 pages; existing missing 404-entry and chunk warnings.
- Local test suites: NOT RUN, expressly forbidden; regression execution belongs to remote CI.
- Browser: actual ProviderWorkspaceShell -> ProviderDetails -> ProviderUsage components on
  `http://127.0.0.1:18184/.tmp/provider-parity.html`, synthetic responses only, no live credentials
  or upstream requests. Observed Korean unresolved-selector explanation and 80%/20% shares
  within Kimi despite a separate provider owning 90% of global tokens; unavailable foreign
  vendor cost remains a dash. Screenshot `assets/011_usage_attribution.png` read back.
- Narrow viewport revealed verbose Korean annotation; shortened copy and used normal text
  font rather than inherited model monospace. Desktop re-observed cleanly after the change.

Independent final review and exact-head CI remain pending. Existing usage history is untouched;
no new inference, service restart, or live-account mutation occurred.
