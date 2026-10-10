# RT6 survey ledger (2026-09-30, dev 73289d46ae)

Every open PR (55) and issue (52; #6244 added after the A audit found it missing) with the survey recommendation and the RT6 decision. Survey reports with source anchors stayed in .tmp/rt6/ (not tracked).

| # | Kind | Title | Survey | RT6 decision |
| --- | --- | --- | --- | --- |
| #6242 | issue | [Provider compatibility] Qwen models fail through Responses → Chat translation:  | FIX-NOW | SELECT L1 fix (conditional) |
| #6237 | issue | [Bug]: Windows standalone 2.71.0 service wrapper is rejected by the ownership pr | COVERED-BY-PR #6238 | via #6238 |
| #6231 | issue | [Bug]: Completed hosted image results from a routed Responses provider are not d | COVERED-BY-PR #6233 | follow survey |
| #6222 | issue | [Bug] macOS 2.70.0 Startup safety fails in bundled CLI and ignores desktop super | DEFER | follow survey |
| #6220 | issue | [Provider compatibility] Codex Web GPT replay fails after routed Responses reque | DEFER | follow survey |
| #6215 | issue | [Bug] Kiro saved unpublished model IDs remain routable after catalog removal | DEFER | follow survey |
| #6197 | issue | [Bug]: Anthropic OAuth cooldown survives authoritative quota recovery, and CLI c | COVERED-BY-PR #6203 | via #6203 |
| #6196 | issue | [Bug] Codex App (macOS): send button disabled at quota exhaustion - the #5947 in | DEFER | follow survey |
| #6162 | issue | OpenAI-compatible non-streaming Responses requests fail on Codex pool (Hindsight | COVERED-BY-PR #6200 | via #6200 |
| #6139 | issue | [Bug][macOS] Bundled 2.68.0 ocx cannot load @napi-rs/keyring | COVERED-BY-PR #6161 | via #6161 |
| #6135 | issue | [Bug] Bun.exe is consistently using up to 2GB of RAM | NEEDS-INFO | follow survey |
| #5848 | issue | [Bug]: Provider-table form hides openai-tagged threads from the ChatGPT mobile r | DEFER | follow survey |
| #5616 | issue | [Feature]: Resume a turn automatically when an account limit cuts the response m | DEFER | follow survey |
| #5270 | issue | [Provider compatibility] Qoder adapter cannot use Codex-owned MCP/tool calls | DEFER | follow survey |
| #4956 | issue | [Bug]: spawned Bun child processes stop producing output and never exit, on both | NEEDS-INFO | follow survey |
| #4878 | issue | [Bug] Codex Desktop model picker reopens after Luna Reserve exhaustion, but Send | NEEDS-INFO | follow survey |
| #4213 | issue | [Bug]: Codex App feature surfaces (Astra trial prompt, built-in image generation | ALREADY-FIXED | follow survey |
| #4143 | issue | missing codex model only in desctop app | NEEDS-INFO | follow survey |
| #3765 | issue | [Bug]: Claude Messages to Astra cache plateau/reset with growing history; Codex  | NEEDS-INFO | follow survey |
| #3506 | issue | [Bug] Cursor/Grok 4.6 no-progress loop persists on OpenCodex 2.42.0 after #2600 | NEEDS-INFO | follow survey |
| #6241 | issue | [Feature]: opt-in pre-rotation compact/checkpoint handshake for long-lived Codex | DEFER | follow survey |
| #6223 | issue | Remote Link: guide SSH host setup and avoid duplicate errors in Add Child | DEFER | follow survey |
| #6093 | issue | [Feature]: expose requestPacing.maxConcurrentRequests in the provider settings G | ALREADY-FIXED | CLOSE fixed by #6224 |
| #6013 | issue | [Feature]: Claude account pool — per-account pause and per-account auto-switch t | COVERED-BY-PR #6204 | via #6204+#6207 |
| #5745 | issue | [Feature]: Support PostgreSQL-backed shared spend state for zero-downtime rollin | DEFER | follow survey |
| #5679 | issue | Cursor integration: surface the Private Inference local-mode installer when only | ALREADY-FIXED | CLOSE fixed by #6224 |
| #5660 | issue | [Feature]: Qoder as a client integration (use opencodex models inside Qoder IDE  | NEEDS-INFO | follow survey |
| #5649 | issue | Add configurable low-quota threshold actions (pause / desktop alert) | DEFER | follow survey |
| #5493 | issue | Desktop: keep background startup lightweight and prove Linux packaged-shell E2E | DEFER | follow survey |
| #4961 | issue | Luna Reserve capability is bound to codexDesktopAuthless, a flag documented as c | DEFER | follow survey |
| #4869 | issue | [Feature] Explicit per-thread external-provider routing during Codex Desktop Lun | NEEDS-INFO | follow survey |
| #4854 | issue | Support OpenScience (`@synsci/openscience`) as a client integration | NEEDS-INFO | follow survey |
| #4761 | issue | codex-restart quits the desktop shell where upstream restarts only the app-serve | DEFER | follow survey |
| #4644 | issue | Dashboard: Safari standalone web app (iOS home-screen web app) does not AutoFill | DEFER | follow survey |
| #4579 | issue | Keeping authority stable while the model switches | DEFER | follow survey |
| #4434 | issue | OpenCodex Fusion: user-defined lead/main + oracle/sidekick pairs from any expose | DEFER | follow survey |
| #4198 | issue | [Feature]: Official multi-arch Docker image and automated build workflow (GHCR / | DEFER | follow survey |
| #4189 | issue | 添加提供方-账户 新增zcode登录 | NEEDS-INFO | follow survey |
| #4173 | issue | [Feature]: atomic ocx update command with daemon drain, schema validation, and m | DEFER | follow survey |
| #3705 | issue | [Feature]: add opt-in sensitive-data Guardrails | DEFER | follow survey |
| #3494 | issue | Feature request: Extend existing integrations to AI agents running in VS Code | NEEDS-INFO | follow survey |
| #3459 | issue | [Feature]: Pre-adapter request transform hook (custom handlers on OcxParsedReque | DEFER | follow survey |
| #3379 | issue | [Feature]: dashboard management gaps — delete rollback entries, custom usage ran | DEFER | follow survey |
| #3376 | issue | [Feature]: retain quota history and make reset windows a scheduling input (capac | DEFER | follow survey |
| #3375 | issue | [Feature]: complete the OAuth account-pool lifecycle — session affinity, 401/403 | DEFER | follow survey |
| #2834 | issue | [Feature] Add relay model diagnostics for connectivity, latency, and identity co | DEFER | follow survey |
| #2811 | issue | Feature: provenance-aware Codex CLI update manager | COVERED-BY-PR #6152 | follow survey |
| #2511 | issue | Feature: opt-in per-provider request byte budget that downscales then prunes inl | DEFER | follow survey |
| #2358 | issue | [RFC] Add a compatibility contract, proxy budgets, and OS-backed credentials | DEFER | follow survey |
| #1416 | issue | feat(integrations): add a versioned Orca launch manifest | NEEDS-INFO | follow survey |
| #95 | issue | [Roadmap] Centrally hosted multi-user OpenCodex with tenant isolation | DEFER | follow survey |
| #6236 | PR | fix(catalog): avoid synthetic compaction on native/routed model switches | MERGE | SELECT L1 merge |
| #6235 | PR | fix(claude): end a passthrough stream on an upstream reset with an Anthropic err | MERGE | SELECT L3 merge |
| #6233 | PR | fix(responses): display hosted image results in local Codex clients | DEFER | follow survey |
| #6232 | PR | fix(responses): drop the internal summary:none marker before it reaches the upst | CARRY | SELECT L3 carry |
| #6230 | PR | fix(cursor): redirect native tool denials through code-mode exec | MERGE | SELECT L1 merge |
| #6225 | PR | fix(bridge): preserve rate-limit retry advice for Codex | MERGE | SELECT L1 carry |
| #6200 | PR | fix(responses): support canonical non-streaming delivery | FIXUP | SELECT L3 fix-up (conditional) |
| #5995 | PR | Support keyless Zen through provider-owned request compatibility | DEFER | follow survey |
| #6188 | PR | fix(codex): recover stale main locks from two-window WHAM usage | DEFER | follow survey |
| #6149 | PR | feat(compaction): scope routing overrides by source model | DEFER | follow survey |
| #6143 | PR | Watch Codex Desktop model cache for catalog updates | DEFER | follow survey |
| #5800 | PR | fix(claude-agent-sdk): replace the ToS-violating claude -p turn with Anthropic's | HOLD-SECURITY | follow survey |
| #5424 | PR | feat(mirasim): add native Mirasim provider | HOLD-SECURITY | follow survey |
| #5912 | PR | feat: add experimental Zed Hosted AI provider | HOLD-SECURITY | follow survey |
| #6239 | PR | feat(oauth): code-display login mode for hosts with no reachable localhost | DEFER | follow survey |
| #6234 | PR | fix(combos): a spent pool account must not cool the whole target | FIXUP | SELECT L2 carry (conditional) |
| #6207 | PR | feat(oauth): add per-account Anthropic usage thresholds | MERGE | SELECT L2 merge |
| #6204 | PR | feat(oauth): support Anthropic account pause and resume | MERGE | SELECT L2 merge |
| #6203 | PR | fix(oauth): recover Anthropic reset cooldowns | FIXUP | SELECT L2 fix-up (conditional) |
| #6192 | PR | Antigravity 403 verify-account quarantine with needs-reauth(verify) marking | HOLD-SECURITY | follow survey |
| #6185 | PR | feat(combo,gui): configurable JEV decision destination and a decision models tab | DEFER | follow survey |
| #5879 | PR | feat(codex): quota-driven desktop-authless auto failover | DEFER | follow survey |
| #3742 | PR | feat(cursor): add capability-gated account pool kernel | DEFER | follow survey |
| #3738 | PR | feat(codex): add quota-aware switching and resumable pool waits | DEFER | follow survey |
| #4932 | PR | feat(combos): enroll text-only members in vision sidecar from the UI | DEFER | follow survey |
| #5617 | PR | Separate global model visibility from provider controls | DEFER | follow survey |
| #5408 | PR | feat(gui): unified provider workspace with pool controls and reset-first rotatio | DEFER | follow survey |
| #5932 | PR | feat(antigravity): expose membership plan in account UI | FIXUP | follow survey |
| #6238 | PR | fix(service): accept standalone Windows wrappers in ownership probe | MERGE | SELECT L4 merge |
| #6205 | PR | fix(config): surface why macOS proxy "auto" refuses (exception shapes, SOCKS-onl | FIXUP | DEFER maintainer change request |
| #6161 | PR | fix(packaging): ship keyring native addon with desktop sidecar | HOLD-SECURITY | SELECT L4 update (conditional) |
| #6119 | PR | fix(update): allow Scoop Node npm from user home | FIXUP | DEFER junction boundary |
| #6079 | PR | feat(codex): add opt-in Windows desktop compatibility controls | DEFER | follow survey |
| #5782 | PR | fix(windows): make manual stops durable and bound bridge delivery receipts | DEFER | follow survey |
| #5947 | PR | feat(chatgpt-unblock): PAC-fallback mode so traffic survives opencodex stopping | DEFER | follow survey |
| #6120 | PR | ci(deploy): typecheck the Cloudflare deploy package | DEFER | follow survey |
| #6077 | PR | feat(deploy): host an opencodex hub on Cloudflare Containers | DEFER | follow survey |
| #6076 | PR | fix(security): require pairing for child link join | HOLD-SECURITY | DEFER maintainer change request / security |
| #3741 | PR | feat(transport): add opt-in Antigravity TLS profile | DEFER | follow survey |
| #6152 | PR | feat(codex): attest the selected npm-global CLI and add a read-only update plan | HOLD-SECURITY | follow survey |
| #6157 | PR | docs(codex): propose native remote-list policy with executable probes | DEFER | follow survey |
| #6151 | PR | feat(droid): configure per-model reasoning defaults in integrations | DEFER | follow survey |
| #5955 | PR | feat: add provider-independent advisor runtime | HOLD-SECURITY | follow survey |
| #5950 | PR | feat(clients): add Qoder client integration and config export | DEFER | follow survey |
| #5374 | PR | feat(voice): configurable dictation, transcription, and speech routes | DEFER | follow survey |
| #5253 | PR | feat(i18n): add Brazilian Portuguese (pt-BR) localization | DEFER | follow survey |
| #4732 | PR | perf(core): cache static registry model lookups and eliminate snapshot traversal | CARRY | follow survey |
| #4649 | PR | feat(dashboard): opt-in remember admin token on this device for standalone sign- | HOLD-SECURITY | follow survey |
| #4056 | PR | feat(client): add opt-in remote hub voice relay | HOLD-SECURITY | follow survey |
| #4022 | PR | feat: add opt-in sensitive-data Guardrails | DEFER | follow survey |
| #2355 | PR | feat(status): warn when config.json diverges from the running proxy (CLI + GUI) | DEFER | follow survey |
| #4222 | PR | Experimental: preserve parent prompt-cache prefixes for Desktop side chats | DEFER | follow survey |
| #3833 | PR | feat(clients): add native Command Code integration and catalog sync | DEFER | follow survey |
| #4259 | PR | feat(zcode): add opt-in local app-server agent provider | HOLD-SECURITY | follow survey |
| #4647 | PR | feat(providers): Z.ai Start Plan provider (OAuth login, in-process traceless cap | HOLD-SECURITY | follow survey |
| #6244 | issue | Main-account hard lock never releases when the blocking 5h window stops being observed | (missed by survey; triaged at A) | INVESTIGATE; owner policy question; defer if unanswered |
