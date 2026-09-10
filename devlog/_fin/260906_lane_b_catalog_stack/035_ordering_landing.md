# 035 — Ordering and verification prerequisite landed

PR #3700 landed with an admin merge at `76356176c86aa123220c82b65321453e81897405`.
Its tree `f1950aecabdb3b73dbb4bdea18a845b27da70222` matches the tested GitHub merge
candidate. Both ordering head `e59b730b1` and Lab prerequisite head `8b5dbde02`
were verified as ancestors of dev. GitHub automatically marked #3713 merged.

Source #3571 was closed immediately after that proof. Its refreshed head
`09acfba64596011c308f0d9cbac070123bb9faeb` rebases the carried source: eight of
twelve feature-file blobs are identical; four differences are established dev
changes, and the three rewritten follow-ups have matching stable patch IDs.
The source author and `Co-authored-by: voiys <matej2714@gmail.com>` are retained.

- Exact source-head [CI 33989738843](https://github.com/lidge-jun/opencodex/actions/runs/33989738843)
  completed successfully, including Linux four shards, macOS two shards and all producers.
- Remote merge candidate `33ed4751` passed the canonical full suite: 19,606 pass,
  0 fail, 15 skip, plus build, typecheck and privacy checks.
- After the intervening Logs landing, candidate `88a67043` passed all dashboard
  tests, lint/i18n/build, five affected root test files, typecheck, privacy and docs
  build. Catalog, Lab, adapters and dependencies match the full-suite baseline.
- The earlier standalone prerequisite run is retained as cancelled: its macOS
  log stopped at the client-connect file before Lab execution. It is not called green.

Independent source, contract and security reviews passed. The ordering PABCD
cycle is closed; model management and Fable remain separate incomplete work phases.
