# 030 — wp3: local-CA send-unblock intercept (candidate)

Branch `codex/chatgpt-send-unblock-intercept`, stacked on wp2. Code from #5947,
`Co-authored-by: lcxhh521`. A candidate maintainers may close.

## Files (from pr/5947 at 61947c04d9)

Whole files: `src/chatgpt/desktop-unblock/{listener,ca-trust,ws-frame,ws-relay,ws-upstream,launch-watcher,runtime,rewrite}.ts`,
`src/server/index/chatgpt-unblock-lifecycle.ts`, `src/server/index/optional-listeners.ts` hunk,
`src/lib/socks5-handshake.ts` + `src/lib/socks5-fetch.ts` (shared SOCKS5 refactor),
`tests/lab/core-lab-boundary.test.ts` hunk.

Removed while extracting:

- PAC: runtime.ts:32,49-50,84-121,166-169,177-181,204-221; launch-watcher PAC branches
  (102,114-116,146-165,177-179,190-203,239-242,271-277,472-475); CLI PAC status.
- Shim duplicates: runtime.ts:44-45,123-161,222-231 and watcher shim branches; the
  shim lives in wp2. `rewrite.ts` imports the gate helpers from
  `src/chatgpt/app-server-shim/gate-rewrite.ts` instead of redefining them.

Config: `chatgptDesktop.unblockSend`, `chatgptDesktop.port` added to wp2's block.
CLI: `ocx chatgpt launch|restore|status|install-watcher` gain the intercept mode.

Tests: `rewrite`, `unblock-ca-trust`, `unblock-listener`, `unblock-ws-frame`,
`unblock-ws-relay`, `unblock-runtime` (non-PAC cases), `unblock-launch-script`
(non-PAC, non-shim), `unblock-watcher-install`, `unblock-config-boundary`,
`tests/lib/socks5-handshake.test.ts`. Register in both layout files.

Docs: guide sections for the intercept in English (+ locales from #5947 where they do
not describe PAC/shim), structure updates, transports inventory SOCKS5 row.

## PR description must state

- Security cost: issues a local CA and asks the user to run
  `security add-trusted-cert` into the login keychain trust store; the loopback
  listener terminates TLS for chatgpt.com and relays the account's credentials.
- #6196 evidence: on current Desktop builds the gate reads come from the bundled
  app-server; the listener saw zero established connections in ~20 h.
- Conflicts with the 260928 maintainer design; offered only so the decision can be
  made on a reviewable diff.

