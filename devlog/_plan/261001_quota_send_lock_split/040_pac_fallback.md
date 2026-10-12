# 040 — wp4: PAC fallback (candidate)

Branch `codex/chatgpt-pac-fallback`, stacked on wp3. Code from #5947,
`Co-authored-by: lcxhh521`. A candidate maintainers may close.

Adds `src/chatgpt/desktop-unblock/{pac,entry-proxy}.ts`, restores the PAC hunks
removed in 030 (runtime, launch-watcher, lifecycle logging, CLI status), config
`chatgptDesktop.pacFallback`, tests `unblock-pac`, `unblock-entry-proxy`, PAC cases of
`unblock-runtime`, `unblock-launch-script` (314-325, 373-426), `unblock-watcher-install`
(142), and the guide's PAC section (English 92-120 plus locales).

End state: wp2+wp3+wp4 tree equals #5947's feature set with the shim relocated.

## PR description must state

Same security cost as 030 (requires the trusted local CA) plus: the PAC embeds the
system proxy/PAC configuration captured at start, and #6196 measured zero traffic on
both the TLS listener and the CONNECT entry.

