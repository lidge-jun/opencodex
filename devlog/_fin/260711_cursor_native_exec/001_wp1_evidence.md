# 001 — WP1 evidence: live flag flip + A/B activation proof

Timestamps are 2026-07-11 KST; raw payloads in /tmp/ocx-ab-*.json (session-local).

## Flip (no restart)

- `PUT /api/debug {"debug":true}` -> runtimeOverride.debug=true (provider frames on).
- `POST /api/providers` with the full cursor provider object + flag ->
  `{"success":true,"name":"cursor"}`; config.json diff afterwards: changed
  keys = `['unsafeAllowNativeLocalExec']` only (before snapshot
  /tmp/ocx-cursor-provider-before.json). In-memory liveness per reviewer
  finding 4 (management-api.ts:304 mutates the closed-over config;
  routeModel re-reads per request).

## A/B

- BEFORE (flag unset), read prompt via `cursor/gpt-5.6-luna`:
  model relayed exactly the NATIVE_LOCAL_EXEC_DISABLED denial text.
- AFTER, same request: replied `OCX-NATIVE-EXEC-TEST-2607111905 hello from
  baseline` — the file's exact content.
- AFTER, write prompt: `/tmp/ocx-native-exec-write-test.txt` created on disk
  with exact line `OCX-WRITE-OK-2607111920`; model replied DONE.

## Activation proof (deterministic, A-gate blocker 2)

`GET /api/debug/logs` frame events (`[ocx:cursor:frame]`):

- read turn: `{"case":"execServerMessage","exec":"readArgs"}` seq 21.
- write turn: `requestContextArgs` seq 80, `readArgs` seq 83/143,
  `shellStreamArgs` seq 86, `writeArgs` seq 145, `readArgs` seq 165 —
  the Cursor agent read, wrote, and re-verified via native exec, all
  executed locally post-flip.

## Notes

- Provider debug returned to off after evidence capture.
- The legacy boolean equals the future `nativeLocalExec:"on"` (010 doc);
  after WP2 lands and the proxy is next restarted by the user, the config can
  optionally move to `"codex-sandbox"`.
