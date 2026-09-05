# Window-priority steering

Superseded expiry decision: review amendment033/034 now requires a fresh valid lower reading to release retained99. Clock-only expiry is not recovery evidence; the existing minute sweep refreshes blocked main usage automatically. The priority and genuine0/rearming decisions below remain unchanged.

Owner clarification during wp1: accounts with a 5h window must use that window; accounts with weekly quota use weekly. If both exist, 5h wins. The initial maximum-across-windows policy is superseded before publication.

Acceptance changes (not reduced verification): choose the observed short/5h tuple when present, otherwise weekly, otherwise monthly for monthly-only accounts. A high secondary window cannot activate this local 99% policy. Upstream limits still apply independently. An expired or unknown selected window is unknown, not permission to substitute a different high window. Retain known short-window shape across partial snapshots using the existing provenance-aware merger.

Implementation: only the main-owned policy helper and policy tests change; identity, destination, maintenance and no-suite rules remain unchanged. UI copy in wp2 must say 5h first, weekly otherwise; monthly-only accounts retain their governing window. Add short98/weekly100 -> ready, short99/weekly20 -> blocked, expired short/weekly99 -> unknown, weekly98/monthly100 -> ready, and monthly-only99 -> blocked.

All reviewers/workers receive this steering; their existing identity/tertiary/TTL findings remain applicable when the selected account has no short window.

Second owner clarification: a fresh 0% reset must automatically release the block. The opt-in remains enabled and rearms at99. Explicit regression sequence for both short and weekly:99 blocked ->0 ready with enabled=true ->99 blocked again. No manual clear or toggle cycle is required.
