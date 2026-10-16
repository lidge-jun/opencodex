# Unified quota presentation evidence

Base `768e5a004`. Main owns shared reading/current projection and three-tab integration;
Harvey owns account enrichment, refresh epochs and AuthPanel integration. No local test,
typecheck, build, lint or privacy-scan commands were executed in this layer. Remote CI owns
all command-based validation.

Implemented one state/credit/window renderer across Overview, Usage and Accounts/API keys.
Known-mode active rows are authoritative, including empty passive readings. Pool totals are
not current-account fallback. Explicit null from the API remains null during client merges;
only absent data can carry forward. Forced reads settle both account enrichment and the
matching provider-report epoch. Main-owned source slice reviewed PASS by Kant; fresh integrated
review remains in progress.

## Browser evidence

Existing isolated Vite server on127.0.0.1:18184; natural production components mounted from
`gui/.tmp/provider-parity.html` with synthetic responses only. No live tokens, accounts or
upstream requests. The temporary fixture is not a shipped page.

- 031_current_overview.png: current35%/61% below usage statistics.
- 032_current_usage.png: same current reading below provider model usage.
- 033_oauth_accounts.png: two account rows show61% and12% separately.
- 034_api_key_balances.png: two keys show75USD and25USD separately, never summed.
- 035_passive_current_unobserved.png: actually selected the unobserved second passive account;
  the previous account's report remains in fixture state but its numbers are absent.
- 036_pool_current.png: aggregate20%, current70%; selected-provider current section shows70%.
- Unsupported configured provider: explicit unsupported message, no current refresh control,
  no retained quota numbers.
- 037_tablet_usage.png: actual CSS viewport767px, document width767px; Korean layout observed.
- 039_mobile_current.png: actual CSS viewport390px, document width390px; current section and
  refresh control stay inside the viewport; the model table keeps its local horizontal scroll.
  Refresh was activated with pointer and Return, displaying check-completed feedback with
  visible focus. Raw browser capture avoids the in-app screenshot wrapper's zoom clipping.

Desktop, tablet and mobile captures were read back. Temporary viewport overrides were reset.
The source fixture's active account switch and refresh are synthetic UI state transitions,
not writes to the user's account. Exact-head remote CI and final stack integration are pending.

Remote React Doctor atd78a02a63 reported test-harness render-time global assignments in two
new hook tests, one unused mock parameter, and cleanup-ref capture warnings in the account
loader. Its detail was read from the signed-in GitHub summary using Aside, not by running
the tool locally. Repair keeps assertions: capture test observations in layout effects,
remove the unused parameter and capture the stable cleanup containers inside the effect.
