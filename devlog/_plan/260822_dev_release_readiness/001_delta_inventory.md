# 001 — main..dev commit inventory (mechanical)

Source: `git log origin/main..origin/dev --oneline --no-merges` at
planning head 1af7a1e26 (109 non-merge commits; merges excluded —
PR numbers appear in subject lines).

```
5eb56409c devlog: 290 post-landing status — 230/231 and 260 landed, final CI gate noted
f3a7cd4a1 fix(cursor): keep provably-small bare resource_exhausted on the 429 class
ab6a54e4d fix(cursor): fold display aliases in textual pseudo tool-call markers back to wire names
d6b8f8b5d devlog: round-3 live-probe evidence and lock (docs-only)
ce15bf9ff fix(cursor): fail OAuth polling on terminal statuses and shut the discovery H2 pool down at lifecycle exit
994e5ba87 fix(cursor): fail silent and heartbeat-only streams at the transport instead of the 300s bridge watchdog
6b889c36e devlog: round-2 Cursor stabilization research and roadmap lock (docs-only)
525568652 feat(cursor): add weighted credential router with cooldown failover (#2334)
d79b1b444 perf(cursor): add HTTP/2 session pool for discovery calls (#2332)
a69d291fb fix(cursor): stop native Auto from echoing [Tool Result] as chat (#2318)
b513a9142 fix(cursor): unknown exec replies with ExecClientThrow + streamClose instead of silence (#2322)
fd0605868 fix(cursor): close HTTP/2 after turnEnded so a held-open response cannot stall the turn (#2321)
b08ea715c fix(cursor): classify bare 0-token resource_exhausted as context overflow (#2320)
c836ffbff devlog: triage matrix — mark #2281 hardened and merged on the train
3b18d288b devlog: 2281 review rounds — both reviewers pass
bc6d6b516 fix(responses): normalize Claude Code prompt_cache_key through anthropicSessionKeyFromParts
0fb80bdeb devlog: 2281 cycle plan — merge-ref strategy with stacked normalization
c7f341a80 devlog: triage matrix — mark #2270 hardened and merged on the train
65c0fd362 devlog: 2270 review round — boundary pin added, re-verdict pass
ec32a8d52 test(responses): pin canonical forward custom-tool passthrough against explicit denial
3bbe4e411 devlog: 2270 cycle plan — PR-ref merge strategy for fork
5bbca70ab devlog: triage matrix — mark #2289 hardened and merged on the train
7957756ea devlog: 2289 review round — locale parity fixed, re-verdict pass
174f03b60 docs(lifecycle): sync Windows bare-service fail-closed caveat across all 7 locales
d846ad4e0 devlog: 2289 cycle plan — live-head scope after author rebase
c16d5ffde devlog: triage matrix — mark #2296 hardened and merged on the train
d83222154 devlog: 2296 security review round — major fixed, re-verdict pass
698228e40 fix(codex): derive subagent preview quota scope from the route model
c142cc72c devlog: 2296 cycle plan — live-head scope, inherited-model reviewer
f52de33f8 devlog: triage matrix — mark #2294 hardened and merged on the train
08bd08641 devlog: 2294 security review round — blocker fixed, re-verdict pass
2cdfba24d fix(release): reject credential-shaped scp-like hosts and colon-bearing userinfo
aea77b84c devlog: 2294 cycle plan — live-head scope and gate sequence
584a3e3e5 devlog: triage matrix — mark #2295 merged on the train
7f00202d4 devlog: 2295 cycle — full-suite rerun green after gui deps fix (14175 pass / 0 fail, lidge)
64cd6e5a9 fix(xai): normalize Responses web search tools
fcc3f5c05 fix(cursor): keep mixed tool terminals fail-closed
76166608f fix(cursor): preserve drained terminal on clean end
56bff341a test(cursor): harden clean terminal teardown
2df92a270 fix(service): fail closed on unknown installation state
948fb5db1 fix(service): restart existing installations without re-registering
0e5a43459 fix(codex): align Desktop affinity preview
72df5e0de fix(codex): bind Desktop reconnects to one pool account
c9c818d13 fix(cursor): settle clean Connect terminal without HTTP EOF
a228ed741 devlog: vision routed dropdown screenshot (PR evidence)
362377a03 test(vision): pin routed GET verbatim reporting (live-found regression)
a211e6d9e devlog: record vision routed-backend live delivery evidence (190)
3ff19c33e feat(vision): GUI/CLI routed surfaces + GET reports the routed describer verbatim
316190447 feat(vision): routed describe executor via loopback self-fetch (#2188 roadmap 180)
21aec549d feat(vision): routed describer backend — options, gates, namespaced ids (#2188 roadmap 170)
7317dde30 devlog: bug merge-train roadmap (260821) — triage, dependency analysis, audited disposition order
1d7099328 devlog: vision external-backend roadmap (160-190) under sidecar-selection unit
71598fa45 test(release): close SSH target log bypasses
4c7b3ceb8 fix(release): reject credential-bearing SSH remotes
6d5f0cf2c fix(codex): recover zero-byte coordinator remnants
6c33ea5dd devlog: record provider verification and PR fallback for restart helper
4430742f6 scripts: add Windows Codex desktop full-restart helper
569d0208c fix(test): compare terminal-guard rebuild content, not wall-clock stamps
25b0c11a9 fix(release): harden the deploy-key push path against three review findings
7a6d9c23f fix(release): derive the ssh push target from origin instead of hardcoding it
59d6367d4 fix(release): quote the deploy-key path in GIT_SSH_COMMAND
ed727d0e5 feat(release): push the version bump through a dedicated release deploy key
3e130d239 devlog: record the 260821 model-catalog-refresh unit
d23c3179f feat(providers): Ox Alpha (stealth 1M multimodal) and the DeepSeek vision preview across the catalog
27764f342 chore(runtime): move the bundled Bun to 1.4.0 stable and retire the canary channel
293276e0d docs(runtime): record the green full-suite run under Bun 1.4 canary
6889825bf fix(codex): keep multi_agent_v2 readable when the TOML parser rejects the document
68137e200 test(codex): stop relying on Bun 1.3.14 leaking PATH into children
876ebf320 docs(runtime): record what the Bun 1.4 canary lane found
d9ff528f9 test(codex): pin the datetime catalog contract across Bun TOML versions
8a3d43552 test(ci): teach the workflow hardening test the new CI shape
4cc735344 docs(runtime): README reflects the GitHub canary channel
90eabcc42 ci(runtime): qualify Bun 1.4 from the GitHub canary channel
d3ec5abd1 docs(runtime): add preview-dev branch README and upstream track pointer
1d76525eb docs(runtime): Bun 1.4 preview-dev roadmap with diff-level decade docs
a0fa018e7 ci(runtime): source Bun version from package.json and qualify preview-dev
aedc223c8 test(cursor): wait for RunSSE fetch instead of two microtasks
4729b37d6 test(quota): lock real Z.AI v2 and new-protocol responses as fixtures
d884d2c4a docs(providers): document the Z.AI GLM Coding Plan quota probe
10b3dee58 fix(quota): tighten zai window matching and legacy fallback gate
dcda7fa59 feat(quota): support GLM coding plan quota on z.ai and bigmodel.cn
e8c62a90d test(fastwire): expect xAI key-auth chat to forward Fast
4fbfb27d1 test(clients): assert the Pi override with join, not a POSIX separator
398b7ade4 test(responses): lower apply_patch on noncanonical forward destinations
2785aa29d test(responses): assert the terminal SSE marker on namespace replay
88ffe3272 fix(responses): build the routed compaction body last
df16e0a78 fix(responses): lower apply_patch for upstreams that reject custom tools
3124cb13d docs(cursor): use French typographic apostrophe in Vision omission wording
61ad6653e docs(cursor): describe history and omission markers in Vision sections
4e82029f5 fix(cursor): fail closed on untrusted sniff and soft-cap misses
c688bace5 fix(cursor): address post-rebase CodeRabbit nits on SelectedImage
40d096475 fix(cursor): avoid duplicate prepared binding in live transport
a0b96ec43 fix(cursor): reuse prepared SelectedImage bytes
e6a4a232c fix(cursor): keep image-only history in external root replay
e332aa2b6 docs(cursor): add glm-5.3 and French Vision section
43ad5ae87 fix(cursor): validate small JPEGs before passthrough
6097e60b4 fix(cursor): abort before image-count guard
2d703c89e fix(cursor): address second CodeRabbit pass on SelectedImage
0e5924366 fix(cursor): address CodeRabbit findings on native SelectedImage
82d2f32ff feat(cursor): native SelectedImage vision for verified models (data: only)
b31f3dbed test: cover Claude Code thought-signature replay scope
6c748663e fix: enable call_id thought-signature replay for Claude Code
d4023aedd docs(xai): separate the OAuth gateway row in the remaining locales
33e1c3e08 docs(xai): separate OAuth gateway rows
c13981b5a docs(xai): clarify API key transport
d887a4f2d fix(gui): translate estimated cost labels
1d7d8177a fix(xai): address B2 pricing review
057f93ea5 docs(devlog): capture the xAI Fast pricing UI evidence
f87698c0d feat(xai): enable Priority Processing on the API-key transport
```

Lane assignment for every commit lives in 002 (lane-ownership rule: exactly
one lane each; unassigned commits fail the matrix).

