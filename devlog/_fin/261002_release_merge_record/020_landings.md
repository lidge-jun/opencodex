# Landing inventory

The [fixed scope](000_scope.md) contains 81 first-parent landings:
**68 + 11 + 2**. Tables preserve first-parent landing order, oldest first.
The 68-entry inventory covers landings outside the six units listed below
and the two release dev-opens. It does not assert that no other document
mentions these changes.

## 68 landings recorded here

| PR | Landing commit | Published change |
| --- | --- | --- |
| [#6319](https://github.com/lidge-jun/opencodex/pull/6319) | [`b933aa2923`](https://github.com/lidge-jun/opencodex/commit/b933aa29231a24b41056a17e24c05893bdeab6e1) | fix(cursor): bound local installer manifests |
| [#6308](https://github.com/lidge-jun/opencodex/pull/6308) | [`2713b60e32`](https://github.com/lidge-jun/opencodex/commit/2713b60e32966bbe37094b03e1df7ba5e91ecc5e) | fix(codex): preserve TOML values and routing marker ownership |
| [#6315](https://github.com/lidge-jun/opencodex/pull/6315) | [`57fc9cc57e`](https://github.com/lidge-jun/opencodex/commit/57fc9cc57efcb4da2e73b676d09fad1bc3067798) | fix(devin): bound held signature-type payloads |
| [#6324](https://github.com/lidge-jun/opencodex/pull/6324) | [`8326838e1d`](https://github.com/lidge-jun/opencodex/commit/8326838e1dd7f69ca1c91a00ff12ae19607429a4) | fix(devin): score family axes sparsely with own-key targets |
| [#6325](https://github.com/lidge-jun/opencodex/pull/6325) | [`f5e9fdabaa`](https://github.com/lidge-jun/opencodex/commit/f5e9fdabaa8782311f331e317f5c8835f14b1a9c) | fix(redaction): bound XML identifying-attribute scans |
| [#6326](https://github.com/lidge-jun/opencodex/pull/6326) | [`b0d275dc79`](https://github.com/lidge-jun/opencodex/commit/b0d275dc79e8ce89de3495a60cbad6bb8b7ee5e2) | fix(codex): require live credential evidence for pool quota policy |
| [#6328](https://github.com/lidge-jun/opencodex/pull/6328) | [`662dfe170e`](https://github.com/lidge-jun/opencodex/commit/662dfe170e166c9a12b2b01022b495679d9e5ce8) | fix(devin): apply Cognition blocklist rewrites to the system prompt |
| [#6329](https://github.com/lidge-jun/opencodex/pull/6329) | [`6c32c4da36`](https://github.com/lidge-jun/opencodex/commit/6c32c4da36868afd87a603476b7c9b9f65a7588d) | fix(anthropic): give each Claude model its real 128K output maximum |
| [#6330](https://github.com/lidge-jun/opencodex/pull/6330) | [`87e182f110`](https://github.com/lidge-jun/opencodex/commit/87e182f110b3ade4d2d5b2e6a7b0fff0e3f394fd) | fix(claude): record why a native passthrough failed in its request-log row |
| [#6331](https://github.com/lidge-jun/opencodex/pull/6331) | [`f9bfca0d0a`](https://github.com/lidge-jun/opencodex/commit/f9bfca0d0a1235257173c586feeab6d5f9f1f258) | fix(models): apply new-model policy before discovery, sync and export publication |
| [#6332](https://github.com/lidge-jun/opencodex/pull/6332) | [`4f3182292d`](https://github.com/lidge-jun/opencodex/commit/4f3182292d6c22f53feb2ff5915d25e4bfaaa451) | docs(structure): keep providers-and-adapters.md within its 600-line budget |
| [#6333](https://github.com/lidge-jun/opencodex/pull/6333) | [`349588e2f1`](https://github.com/lidge-jun/opencodex/commit/349588e2f1df38bf7e43eac08284c0dd829a78ad) | fix(models): project drifted discovery reads without mutating live policy |
| [#6341](https://github.com/lidge-jun/opencodex/pull/6341) | [`6f2f6ae9cf`](https://github.com/lidge-jun/opencodex/commit/6f2f6ae9cf3b7cf11120dabeb08fcb3b0517d685) | fix(xai): report a current Grok CLI version on the OAuth path |
| [#6343](https://github.com/lidge-jun/opencodex/pull/6343) | [`a8c6c3f0d0`](https://github.com/lidge-jun/opencodex/commit/a8c6c3f0d07fef5879e0d900fc54fc86c0e79044) | fix(xai): report the current stable Grok CLI 1.0.46 |
| [#6342](https://github.com/lidge-jun/opencodex/pull/6342) | [`7ea77aaaf5`](https://github.com/lidge-jun/opencodex/commit/7ea77aaaf5dfc110da7f0391cf6239a6deb46f8e) | docs(providers): link the TokenLab OpenCodex integration guide |
| [#6344](https://github.com/lidge-jun/opencodex/pull/6344) | [`ee3845fb10`](https://github.com/lidge-jun/opencodex/commit/ee3845fb10d2e81b2ba2978c13e0f9cc325299e4) | fix(claude): preserve Devin answers with late reasoning signatures |
| [#6345](https://github.com/lidge-jun/opencodex/pull/6345) | [`8ad261e000`](https://github.com/lidge-jun/opencodex/commit/8ad261e00074ffada82e1f4179a18263941a0f16) | fix(gui): bridge quota popover hover gap and link account management |
| [#6346](https://github.com/lidge-jun/opencodex/pull/6346) | [`09a86e1ab3`](https://github.com/lidge-jun/opencodex/commit/09a86e1ab37e00ef16de3dcf76719a6a9fa5482e) | fix(subagents): accept visible bare native ids in pickerOrder |
| [#6347](https://github.com/lidge-jun/opencodex/pull/6347) | [`c4a521985a`](https://github.com/lidge-jun/opencodex/commit/c4a521985aeabf38c2d024eecbcc6e2fa19074dc) | fix(anthropic): fail over on proven pre-output account 403 refusals |
| [#6349](https://github.com/lidge-jun/opencodex/pull/6349) | [`82a4955196`](https://github.com/lidge-jun/opencodex/commit/82a495519608780361d30604d651efe5b89d29cd) | test(anthropic): follow the renamed refusal rotators in source oracles |
| [#6360](https://github.com/lidge-jun/opencodex/pull/6360) | [`0328373fb8`](https://github.com/lidge-jun/opencodex/commit/0328373fb88fe0d019b29ae278e153d7fed4bcc7) | perf(responses): reuse measured entry strings for the state snapshot |
| [#6354](https://github.com/lidge-jun/opencodex/pull/6354) | [`b7f106ea3f`](https://github.com/lidge-jun/opencodex/commit/b7f106ea3fb34a7476da1a2c227c2a483aa396a5) | fix(claude): log a stalled or over-cap passthrough stream as a 502 incomplete row |
| [#6355](https://github.com/lidge-jun/opencodex/pull/6355) | [`7b2deb8059`](https://github.com/lidge-jun/opencodex/commit/7b2deb80591b088fc0946141f5cadb764bc930e6) | fix(anthropic): clamp budget thinking to the model's real output maximum |
| [#6371](https://github.com/lidge-jun/opencodex/pull/6371) | [`22c890c8df`](https://github.com/lidge-jun/opencodex/commit/22c890c8df3c494028896532060ff116285120d1) | fix(anthropic): enforce model routes for vision and search helpers |
| [#6369](https://github.com/lidge-jun/opencodex/pull/6369) | [`7429513548`](https://github.com/lidge-jun/opencodex/commit/7429513548923641a4e259f22869829150ba1c87) | fix(gemini): bound type-array schema normalization and preserve pointers |
| [#6372](https://github.com/lidge-jun/opencodex/pull/6372) | [`459b4ec16f`](https://github.com/lidge-jun/opencodex/commit/459b4ec16f5523b7fca239622a94652a02357a02) | fix(antigravity): enforce one sibling rotation across authentication failures |
| [#6374](https://github.com/lidge-jun/opencodex/pull/6374) | [`5939b09dbe`](https://github.com/lidge-jun/opencodex/commit/5939b09dbed76093495add7e63a95fa79a517439) | fix(kiro): retry rebuilt requests at the rebuilt destination |
| [#6377](https://github.com/lidge-jun/opencodex/pull/6377) | [`3ed275fbf5`](https://github.com/lidge-jun/opencodex/commit/3ed275fbf55526cacbc56c09266fb44b74b373b4) | fix(kiro): release leases granted across request cancellation |
| [#6373](https://github.com/lidge-jun/opencodex/pull/6373) | [`de4b2e2a20`](https://github.com/lidge-jun/opencodex/commit/de4b2e2a205f206cb714049d100e9d34aae36b41) | fix(xai): authorize the Fast wire model across API endpoints |
| [#6375](https://github.com/lidge-jun/opencodex/pull/6375) | [`6e5101115c`](https://github.com/lidge-jun/opencodex/commit/6e5101115c63960027ad7716ff1f724b8e931432) | fix(config): require owner-only no-follow registry publication |
| [#6368](https://github.com/lidge-jun/opencodex/pull/6368) | [`72e65439f7`](https://github.com/lidge-jun/opencodex/commit/72e65439f797f2322198df546f3cd82a0b2b7e6f) | fix(codex): reject unpaired surrogates in discovered model metadata |
| [#6385](https://github.com/lidge-jun/opencodex/pull/6385) | [`c94fcf5645`](https://github.com/lidge-jun/opencodex/commit/c94fcf564517109b0758f2812b12c4d40f148873) | fix(chat): recognize Eliza qwen3-8-27b checkpoint ids in the leading-system template |
| [#6323](https://github.com/lidge-jun/opencodex/pull/6323) | [`faf946e8bf`](https://github.com/lidge-jun/opencodex/commit/faf946e8bf27ebe3f673f6e22a1f191772d21495) | fix(command-code): preserve canonical path case in project confinement |
| [#6388](https://github.com/lidge-jun/opencodex/pull/6388) | [`50b3dd48db`](https://github.com/lidge-jun/opencodex/commit/50b3dd48dbd3c8b777edc68239e73f4e83e3ee45) | fix(gui): keep native login confirmation readable and contained |
| [#6205](https://github.com/lidge-jun/opencodex/pull/6205) | [`7f6b5b7389`](https://github.com/lidge-jun/opencodex/commit/7f6b5b73896a5cc6c4ecb24735c161c41e98b4bb) | fix(config): surface why macOS proxy "auto" refuses (exception shapes, SOCKS-only) |
| [#6399](https://github.com/lidge-jun/opencodex/pull/6399) | [`95f21f438c`](https://github.com/lidge-jun/opencodex/commit/95f21f438c11f46845a231949b90cdb392920102) | test(codex): match the canonical role path in the role-route write-failure test |
| [#6356](https://github.com/lidge-jun/opencodex/pull/6356) | [`404ca8b551`](https://github.com/lidge-jun/opencodex/commit/404ca8b5512b3e7a53078ad7ead36c61fb66b7aa) | fix(claude): relay native Anthropic rate-limit headers |
| [#6392](https://github.com/lidge-jun/opencodex/pull/6392) | [`a207452b37`](https://github.com/lidge-jun/opencodex/commit/a207452b371b56e2fb7363978de59ec6d90bd3a7) | fix(responses): record first-output timing for tool-only streams (carry #6259) |
| [#6397](https://github.com/lidge-jun/opencodex/pull/6397) | [`a9d5a80c2d`](https://github.com/lidge-jun/opencodex/commit/a9d5a80c2dad2c29b0289233bbd8d24c104c5012) | fix(codex): verify service manager identity before census delegation (carry #6379) |
| [#6376](https://github.com/lidge-jun/opencodex/pull/6376) | [`6256cb4f8d`](https://github.com/lidge-jun/opencodex/commit/6256cb4f8d0eae228fa38a1438be9fae26eafaf8) | fix(kiro): rebind continuation ownership after refusal failover |
| [#6383](https://github.com/lidge-jun/opencodex/pull/6383) | [`bd3d303bd2`](https://github.com/lidge-jun/opencodex/commit/bd3d303bd20a6b43b081de03864d8e91dce2c1b0) | fix(combos): a pool-held 429 must not park the combo target past the pool |
| [#6394](https://github.com/lidge-jun/opencodex/pull/6394) | [`5444d343e2`](https://github.com/lidge-jun/opencodex/commit/5444d343e2235c03581291dd5c40892e51f5efaa) | fix(responses): display hosted image results in local Codex clients (carry #6233) |
| [#6398](https://github.com/lidge-jun/opencodex/pull/6398) | [`4448e98a60`](https://github.com/lidge-jun/opencodex/commit/4448e98a60f381ddc798250d80961c9644c6e775) | fix(spend): name the refused ledger file and condition, warn on synced state directories |
| [#6396](https://github.com/lidge-jun/opencodex/pull/6396) | [`58a26f0c13`](https://github.com/lidge-jun/opencodex/commit/58a26f0c13e7fa7c469219d8bbd3dfca0a9e33c4) | fix(router): preserve policy authorization across fallback redirects (carry #6380) |
| [#6411](https://github.com/lidge-jun/opencodex/pull/6411) | [`665e2bc15b`](https://github.com/lidge-jun/opencodex/commit/665e2bc15b945317419d1ebb4503ffed593e1d9c) | test(config): canonicalize the owner-registry ACL test root (macOS) |
| [#6393](https://github.com/lidge-jun/opencodex/pull/6393) | [`0202cc68e8`](https://github.com/lidge-jun/opencodex/commit/0202cc68e8e8275fb39fbbe6533a32561975c274) | fix(codex): exclude macOS Electron helpers from client diagnostics (carry #6296) |
| [#6395](https://github.com/lidge-jun/opencodex/pull/6395) | [`09cd45daa5`](https://github.com/lidge-jun/opencodex/commit/09cd45daa57afdb965c5281d286bbdcd7350f04d) | fix(update): check and pin the npm cache root before staging (#6288) |
| [#6391](https://github.com/lidge-jun/opencodex/pull/6391) | [`8a3a7762fe`](https://github.com/lidge-jun/opencodex/commit/8a3a7762fe84070df37aa8e876d793580db444b4) | fix(service): tolerate locale dates in Windows service wrappers (carry #6298) |
| [#6359](https://github.com/lidge-jun/opencodex/pull/6359) | [`58726ae418`](https://github.com/lidge-jun/opencodex/commit/58726ae4185f83c8a83db535dd19b419917cba88) | feat(transport): carry opt-in Antigravity TLS profile onto provider egress (carry #3741) |
| [#6412](https://github.com/lidge-jun/opencodex/pull/6412) | [`ff1ce7e8c5`](https://github.com/lidge-jun/opencodex/commit/ff1ce7e8c55fcbc6af86b392710cab16482e8c16) | fix(chatgpt): close the #6361 review follow-ups |
| [#6413](https://github.com/lidge-jun/opencodex/pull/6413) | [`5ea63751d8`](https://github.com/lidge-jun/opencodex/commit/5ea63751d8adb37f06cf0fa6b8fb89f2d3c1bdb0) | fix(chatgpt): build the bundled app-server path with posix.join on every host |
| [#6414](https://github.com/lidge-jun/opencodex/pull/6414) | [`328ce95814`](https://github.com/lidge-jun/opencodex/commit/328ce95814150d8b2614e2822d537a70e58a15a2) | fix(spend): classify synced state paths with POSIX rules on every host |
| [#6403](https://github.com/lidge-jun/opencodex/pull/6403) | [`89db85ff05`](https://github.com/lidge-jun/opencodex/commit/89db85ff052de43a5230332112934909be1f5ed7) | fix(service): bound every Windows manager command the guarded stop depends on |
| [#6400](https://github.com/lidge-jun/opencodex/pull/6400) | [`137164e3eb`](https://github.com/lidge-jun/opencodex/commit/137164e3ebb78f9ce80009b477af60cfdd184396) | Extend Windows takeover startup budget |
| [#6407](https://github.com/lidge-jun/opencodex/pull/6407) | [`17d6e8498d`](https://github.com/lidge-jun/opencodex/commit/17d6e8498d8f3941995c027d43027df87f27d555) | fix(update): release the Bun updater lease around service-manager starts (#5760) |
| [#6401](https://github.com/lidge-jun/opencodex/pull/6401) | [`cfde167436`](https://github.com/lidge-jun/opencodex/commit/cfde16743686935ad107ecdb5269e25ecc582a84) | fix(service): scope Windows scheduler probes to the root task and re-probe deleted registrations |
| [#6404](https://github.com/lidge-jun/opencodex/pull/6404) | [`0f2ec7adb0`](https://github.com/lidge-jun/opencodex/commit/0f2ec7adb02aac6240f014371bb24ab7c8d045b9) | fix(update): release the restart lease before the service refresh (#5760) |
| [#6402](https://github.com/lidge-jun/opencodex/pull/6402) | [`6d84e4468d`](https://github.com/lidge-jun/opencodex/commit/6d84e4468d7b4b94c5b9ec86040a0f9fb7be030c) | fix(cli): stabilize guarded-stop re-verification and report the failing guard fact |
| [#6419](https://github.com/lidge-jun/opencodex/pull/6419) | [`8b23fe340a`](https://github.com/lidge-jun/opencodex/commit/8b23fe340a53799aac5ad7654582a75df7ade7c8) | fix(claude): rebuild a CLI picker snapshot whose rows no longer decode |
| [#6440](https://github.com/lidge-jun/opencodex/pull/6440) | [`933bd03cbf`](https://github.com/lidge-jun/opencodex/commit/933bd03cbf58418bc591b025e46917c4a6575cc1) | fix(gui): conditions-based Claude account-pool and OAuth warning copy |
| [#6442](https://github.com/lidge-jun/opencodex/pull/6442) | [`0f6026ddca`](https://github.com/lidge-jun/opencodex/commit/0f6026ddcafac2580ddd0244ec73b8e78801a49c) | fix(anthropic): bind native Claude metadata and client identity to the serving OAuth account |
| [#6427](https://github.com/lidge-jun/opencodex/pull/6427) | [`af358141e5`](https://github.com/lidge-jun/opencodex/commit/af358141e5954fa1defbad33e5faeb0f188ae43e) | fix(cli): succeed ensure for validated connected clients |
| [#6443](https://github.com/lidge-jun/opencodex/pull/6443) | [`a300b57c81`](https://github.com/lidge-jun/opencodex/commit/a300b57c81c41f476f37534d2ac07ee39030269e) | fix(anthropic): classify 429s and admit by per-model weekly quota in the Claude account pool |
| [#6446](https://github.com/lidge-jun/opencodex/pull/6446) | [`470758088a`](https://github.com/lidge-jun/opencodex/commit/470758088a6e94f9f1141246f98ee1ae2a821429) | fix(streaming): decode CR, LF and CRLF server-sent events across chunks (carry #6439) |
| [#6447](https://github.com/lidge-jun/opencodex/pull/6447) | [`fc0f24a57b`](https://github.com/lidge-jun/opencodex/commit/fc0f24a57bb46ae440d29e8c1128fb9aa5a774cb) | fix(cli): carry oocheol's CLI validation and diagnostics fixes (#6429 #6431 #6432 #6433 #6434 #6435 #6437 #6438) |
| [#6444](https://github.com/lidge-jun/opencodex/pull/6444) | [`10428d0120`](https://github.com/lidge-jun/opencodex/commit/10428d0120cbceeff997508a28a7a50c4007f7dc) | feat(codex): switch accounts at 100% by default and make spending ChatGPT credits opt-in |
| [#6441](https://github.com/lidge-jun/opencodex/pull/6441) | [`21aed9fee9`](https://github.com/lidge-jun/opencodex/commit/21aed9fee9e8df0ea6c47c411dadeb41bcec0ba7) | fix(service): wait out the npm Bun placeholder instead of executing it |
| [#6448](https://github.com/lidge-jun/opencodex/pull/6448) | [`e0af52c8a2`](https://github.com/lidge-jun/opencodex/commit/e0af52c8a2701dccd81fa5e672c92744e59d2e29) | feat(providers): add OpenGateway (Sionic AI) preset with live discovery and Sionic-first ordering |

## 11 landings covered by existing units

These are 11 landings across six documentation units, not 11 separate units.
The paths below reflect the fixed upstream snapshot; linking an open unit
does not mark its remaining work complete.

| PR | Landing commit | Published change |
| --- | --- | --- |
| [#6366](https://github.com/lidge-jun/opencodex/pull/6366) | [`a6114b62ed`](https://github.com/lidge-jun/opencodex/commit/a6114b62ed1b65dede802359ccd373d913979b24) | feat(codex): pick the model for each LazyCodex agent role (carry #6262) |
| [#6367](https://github.com/lidge-jun/opencodex/pull/6367) | [`da13a02727`](https://github.com/lidge-jun/opencodex/commit/da13a027275ca6bc345f2daa8897ee38451bc4c6) | feat(codex): auto-assign LazyCodex role models by sizing each role (carry #6269) |
| [#6389](https://github.com/lidge-jun/opencodex/pull/6389) | [`de8afe2e86`](https://github.com/lidge-jun/opencodex/commit/de8afe2e86e4006220be42dd817d96b7c8523869) | feat(subagents): suggest a delegation model by sizing the work (carry #6274) |
| [#6390](https://github.com/lidge-jun/opencodex/pull/6390) | [`6c91540e82`](https://github.com/lidge-jun/opencodex/commit/6c91540e82556e819d0942261d74b1bccbd5ce9b) | docs(devlog): close the omo (Codex / LazyCodex) carry unit |
| [#6362](https://github.com/lidge-jun/opencodex/pull/6362) | [`1c9227159c`](https://github.com/lidge-jun/opencodex/commit/1c9227159c1561f20b2f38af9eb1d08dfc6b4daf) | feat(zed): experimental Zed Hosted AI provider, use at your own risk (carry #5912) |
| [#6361](https://github.com/lidge-jun/opencodex/pull/6361) | [`fcbfb16c00`](https://github.com/lidge-jun/opencodex/commit/fcbfb16c004035cd680bd7d94655f7ed1b0a7ace) | feat(chatgpt): experimental macOS app-server quota-gate shim (split from #5947) |
| [#6364](https://github.com/lidge-jun/opencodex/pull/6364) | [`06cc3815c0`](https://github.com/lidge-jun/opencodex/commit/06cc3815c06a10120d89ef986c46be95be37f28a) | feat(combos): JEV decision methods — TypeSafe, System One server, or any opencodex model |
| [#6363](https://github.com/lidge-jun/opencodex/pull/6363) | [`f86ad0ad59`](https://github.com/lidge-jun/opencodex/commit/f86ad0ad594f2a3a7dabcc1fe37dd662d1b919e8) | feat(codex): window-aware main-account hard-lock thresholds and outside-usage warning |
| [#6418](https://github.com/lidge-jun/opencodex/pull/6418) | [`584b525c5e`](https://github.com/lidge-jun/opencodex/commit/584b525c5e4e236f85e72d4cec00a906614acd33) | feat(claude): list opencodex models in the Claude Code CLI first-party /model picker |
| [#6428](https://github.com/lidge-jun/opencodex/pull/6428) | [`3d77e3dacf`](https://github.com/lidge-jun/opencodex/commit/3d77e3dacf27b00d7031cc114343e72150f50749) | fix(claude): start the intercept pair on demand instead of asking for a restart |
| [#6430](https://github.com/lidge-jun/opencodex/pull/6430) | [`03ed9a3b1c`](https://github.com/lidge-jun/opencodex/commit/03ed9a3b1c1535d25f8f47c3d6bf38db8ffc1fc9) | feat(gui): top-level Claude page with Account, Code, Desktop and Settings tabs |

| Covered PRs | Existing record |
| --- | --- |
| #6366, #6367, #6389, #6390 | [omo / LazyCodex carry](../261001_omo_lazycodex_carry/090_outcome.md) |
| #6361, #6363 | [Quota send-lock split](../../_plan/261001_quota_send_lock_split/000_plan.md) |
| #6364 | [JEV decision methods](../../_plan/261001_jev_decision_routing/000_plan.md) |
| #6362 | [Zed Hosted AI carry](../../_plan/261001_zed_hosted_uayor_carry/010_finish_carry.md) |
| #6418 | [Claude CLI first-party picker](../../_plan/261002_claude_cli_picker/010_plan.md) |
| #6428, #6430 | [Claude UX](../../_plan/261002_claude_ux/010_roadmap.md) |

## Two release dev-opens

| PR | Landing commit | Published change |
| --- | --- | --- |
| [#6351](https://github.com/lidge-jun/opencodex/pull/6351) | [`64294638a6`](https://github.com/lidge-jun/opencodex/commit/64294638a69e25ca0c7a4e2102e2349973161f71) | chore(release): open dev at 2.76.0 before releasing 2.75.0 |
| [#6462](https://github.com/lidge-jun/opencodex/pull/6462) | [`b4616be1e4`](https://github.com/lidge-jun/opencodex/commit/b4616be1e4db9e7178fd28cb19d4c2269abc2ba7) | chore(release): open dev at 2.77.0 before releasing 2.76.0 |

Both #6351 and #6462 are counted only in the dev-open category. Follow-up
landings such as #6412, #6413 and #6419 remain in the
68-entry inventory even though they relate to a separately documented unit.
