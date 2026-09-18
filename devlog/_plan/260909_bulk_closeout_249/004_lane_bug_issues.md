# Lane D — open bug-labelled issues with no obvious owning PR

READ-ONLY adversarial triage. Research worktree `/tmp/ocx-249.xGQnxl/wt` detached at
`origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9` (`Merge pull request #4037 from lidge-jun/codex/prs-stack-record`),
`package.json` version `2.49.0`. Remote verified as `https://github.com/lidge-jun/opencodex.git`.
Index re-read immediately before verdict; every line quote below was read from that worktree at that SHA.

**These are issues, not PRs**, so there is no head SHA / CI-at-head / merge conflict per item. Those columns
read `n/a (issue)`. A cross-check of all 71 open PRs found **no open PR declaring
`Closes/Fixes/Resolves` for any of the 22 lane-D issues**, and no loose `#NNNN` mention of them either.

## Summary table

| Item | Verdict | One-line reason | Head SHA | CI at head | Conflicts |
| --- | --- | --- | --- | --- | --- |
| #4035 dead codex-runtime.json pin | **REIMPLEMENT** (C2, real defect, no owning PR) | Dead `configured` pin is never cleared: `runtime.ts:647` skips persist when source is `fallback` | n/a (issue) | n/a | none — `src/codex/runtime.ts` untouched by luvs01 |
| #4032 hub chaining drops context windows | **REIMPLEMENT** (C1, best single-PR candidate) | `capabilityRecord?.context_length` missing from the `positiveSafeInteger` list at `provider-fetch.ts:1399` while `max_output_tokens` is read at `:1420` | n/a (issue) | n/a | none |
| #4023 macOS Stop unloads launchd before teardown | **REIMPLEMENT** (C2) | `management-api.ts:315` unloads the service before `:348` awaits teardown; `service.ts:3866` exempts non-Windows from the respawn guard | n/a (issue) | n/a | none |
| #3994 2.42.0 Plus quota exhaustion | **CLOSE** (duplicate) | Reporter states it themselves: duplicate of #3795, fixed by #3791, shipped v2.46.0; observed on 2.42.0, no repro on tip | n/a (issue) | n/a | none |
| #3989 Hermes whole-file conflict | **CLOSE** (already fixed on dev) | `registry.ts:193` now carries `sourcePreservingYaml`, landed `a0e794d1d` via #4030 | n/a (issue) | n/a | none |
| #3807 unpaired-tool-result guard kills sub-agents | **REIMPLEMENT** (C2, highest user impact) | Guard at `core.ts:6092-6106` is unchanged on dev; only test coverage landed (`9cde6e735`) | n/a (issue) | n/a | none |
| #3782 Claude Desktop model switch | **DEFER** | Needs product judgment on the `claude-opus-4-8-` alias shape (`desktop-3p.ts:128-141`) vs Desktop effort allowlist; CC Switch comparison is a live lead | n/a (issue) | n/a | none |
| #3781 Antigravity quota Fake-IP | **DEFER** | Transport slice already landed via #3872; remainder is authenticated TUN field acceptance nobody here can observe | n/a (issue) | n/a | none |
| #3775 minimal/none on mapped Astra | **DEFER** | Scoped part landed in #3804; remainder is arbitrary-gateway capability policy = product judgment | n/a (issue) | n/a | none |
| #3765 Astra cache plateau | **DEFER** | Measurement report, explicitly not a proven OCX root cause; needs wire capture before any code change | n/a (issue) | n/a | none |
| #3761 Ollama Cloud hosted web_search | **DEFER** | Needs a destination-scoped search bridge + credential/endpoint policy; explicitly deferred by maintainer | n/a (issue) | n/a | none |
| #3926 Google AI Studio `models[]` | **DEFER** (borderline C2) | `model-discovery.ts:487-497` rejects a bare `models[]` **by design**; promoting it is a documented policy decision | n/a (issue) | n/a | none |
| #3719 Anthropic thinking replay | **DEFER** | Streaming-order slice landed via #3877; remainder needs live Anthropic credentials + controlled cache measurement | n/a (issue) | n/a | none |
| #3675 accept 413 gracefully | **DEFER** | #3177 already ships the terminal mapping; what the reporter wants is current-turn auto-shrink = #2511 product scope | n/a (issue) | n/a | none |
| #3661 unreadable_encrypted_agent_task | **DEFER** | Multipart reassembly at `agent-task-recovery.ts:150` needs an envelope contract decision, not a bounded fix | n/a (issue) | n/a | none |
| #3657 Astra stream failures lack evidence | **DEFER** | Reporter answered the last two diagnostic asks with "unknown"; nothing left to act on, but the thread is live (2026-09-08) | n/a (issue) | n/a | none |
| #3522 Windows continuation spill | **DEFER** | Diagnostic slice landed via #3790; remaining recovery remedy needs Windows ACL judgment | n/a (issue) | n/a | none |
| #3506 Cursor/Grok no-progress loop | **DEFER** | Requires a client-supplied progress marker contract; #2628 already recorded OCX cannot infer progress | n/a (issue) | n/a | none |
| #3464 mise upgrade leaves old proxy | **CLOSE** (already fixed on dev) | `service.ts:497` `buildPlist` now takes `deps.launcher` and names #3464; four named regression tests | n/a (issue) | n/a | none |
| #3433 Hermes zero cache hits | **DEFER** | Latest evidence shows the client sends **no** cache identifier; nothing for OCX to preserve | n/a (issue) | n/a | none |
| #3320 Windows non-ASCII scheduler task | **CLOSE** (needs-info, stale) | Maintainer asked on 2026-09-04 for unpatched `<Triggers>` evidence; no reporter response in 5 days | n/a (issue) | n/a | none |
| #3245 macOS Codex 0.152.0 stream disconnect | **CLOSE** (needs-info, stale, upstream) | Reporter's own probe shows no POST reached the proxy; three maintainer asks unanswered since 2026-09-04 | n/a (issue) | n/a | none |

**Counts:** 5 CLOSE, 4 REIMPLEMENT (real bounded defects), 13 DEFER.

## Top 5 rankable for a single bounded PR each

Ranked by (defect proven on dev) x (fix fits one PR without product judgment) x (user impact).

1. **#4032** — C1. One array element. Highest confidence, smallest diff.
2. **#3807** — C2. Highest user impact in the lane: routed sub-agents are 100% dead.
3. **#4035** — C2. Bounded to clearing a dead pin; skip the discovery-candidate half.
4. **#4023** — C2. Reorder teardown before unload, or refuse like Windows does.
5. **#3926** — C2, but only if the maintainer first rules the `models[]` promotion in-scope. Ranked last for that reason.

---

## #4035 — Codex App update invalidates the persisted `codex-runtime.json` pin

**Verdict: REIMPLEMENT — real defect on dev, no owning PR, C2.**

URL: https://github.com/lidge-jun/opencodex/issues/4035 · labels `bug`, `cli`, `service` · author `h-dot-seo` · created 2026-09-08.

The reporter's causal chain holds at the current SHA. The probe correctly rejects a vanished absolute path:

```
src/codex/runtime.ts:293
    if (!exists(command)) return { ok: false, reason: "path does not exist" };
```

But the persist step refuses to write whenever the resolution degraded to `fallback`, which is exactly the
reporter's state (dead pin **and** no `codex` on `PATH`):

```
src/codex/runtime.ts:647
  if (result.runtime.command && result.runtime.source !== "fallback" && !selectionUnchanged) {
```

So the dead `configured` entry survives forever, and every subsequent resolve re-probes a path that
cannot exist. The reporter's claim that the stable Codex App location is not considered also checks out —
`rg 'plugin-appserver' src/` returns nothing at this SHA.

The recovery flag exists but is not the escape hatch: `src/cli/doctor.ts:1004` handles
`--fix-codex-runtime`, and `src/cli/doctor.ts:1140` only prints it as an `Optional:` hint, which is
consistent with the reporter not finding it in `--help`.

Focused test run at this SHA: `bun test tests/codex-integration/codex-runtime.test.ts` → **33 pass / 0 fail**.
Line 509 covers a stale *shim* path and line 583 covers `replacedConfigured`, but nothing covers a dead
`configured` pin combined with an empty `PATH`. The defect is real and untested.

**Bounded fix (no product judgment):** in `resolveAndPersistCodexRuntime` at `src/codex/runtime.ts:633-657`,
when the resolved source is `fallback` *and* a persisted `command` exists that failed with
`path does not exist`, clear the persisted file instead of skipping the write. Regression test asserts
the file is gone after one resolve with a nonexistent pin and no `PATH` candidate.

**Explicitly out of scope for that PR** (needs maintainer direction, as the review comment says): adding
`%USERPROFILE%.codexplugins.plugin-appservercodex.exe` as a discovery candidate, and refreshing
`selectedVersion` on drift.

## #4032 — Chained clients drop per-model context windows

**Verdict: REIMPLEMENT — real defect on dev, no owning PR, C1. Rank 1.**

URL: https://github.com/lidge-jun/opencodex/issues/4032 · labels `bug`, `catalog`, `platform`, `service` · author `tizerluo`.

The asymmetry the reporter describes is visible in one function. `catalogHintsFromModelsApiItem` reads
the capability record for output tokens but never for context length:

```
src/codex/catalog/provider-fetch.ts:1394
  const capabilityRecord = plainRecord(metadata?.capabilities) ?? plainRecord(item.capabilities);
src/codex/catalog/provider-fetch.ts:1399
      limits?.max_context_length,          <- capabilityRecord?.context_length is NOT in this list
src/codex/catalog/provider-fetch.ts:1420
    capabilityRecord?.max_output_tokens,   <- but the same record IS read here
```

The hub serves `capabilities.context_length: 922000`, which lands in `capabilityRecord` and is dropped.
With no discovered window, materialization applies the compatibility floor:

```
src/codex/catalog/parsing.ts:566
  const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;
```

That reproduces the reported `128000` on every routed row while local forward rows keep their real values.

**Bounded fix:** add `capabilityRecord?.context_length` to the `positiveSafeInteger(...)` argument list at
`provider-fetch.ts:1399`. Order matters and the file already documents the convention — place it **after**
`limits?.max_context_length` and the Copilot-specific `capabilityLimits?.max_context_window_tokens` so no
provider that already resolves changes behavior, matching the `#3156` and `#1797` comments in place.
Regression test: a hub-shaped `/v1/models` fixture whose only window lives at `capabilities.context_length`.

**Out of scope:** consuming `GET /v1/catalog` in the provider sync path, and the single- vs multi-slash id
normalization papercut. Both are separate decisions.

## #4023 — macOS dashboard Stop unloads launchd before native teardown

**Verdict: REIMPLEMENT — real defect on dev, no owning PR, C2.**

URL: https://github.com/lidge-jun/opencodex/issues/4023 · labels `bug`, `gui`, `platform`, `service` · author `tommy1616`.

The ordering the reporter identified in v2.48.0 is unchanged at `7dc7dc99e`:

```
src/server/management-api.ts:315
      serviceStop = stopServiceIfInstalledDetailed();
src/server/management-api.ts:348
    const teardown = await performStopTeardown(url, { ownsReceipt: deferralMatchesReceipt });
```

On darwin that first call is a self-unload:

```
src/service.ts:3931
      try { stopLaunchd(); return "stopped"; } catch { return "failed"; }
src/service.ts:2351
function stopLaunchd(): void { try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ } }
```

And the guard that protects the Windows path returns early for every other platform:

```
src/service.ts:3866
  if (platform !== "win32") return "none";
```

So the `respawnable_service` 409 at `management-api.ts:295-301` can never fire on macOS, and the
`launchctl unload` can kill the handler before line 348 restores the Codex config keys. This matches
the reported residue of `openai_base_url` / `experimental_realtime_ws_base_url` / `model_catalog_json`.

**Bounded fix, two options — pick one, both are single-PR sized:**
(a) move `performStopTeardown` above `stopServiceIfInstalledDetailed` on darwin so restore completes and
is verified before unload; or (b) extend `installedServiceRespawnRisk` to report a darwin self-unload risk
and refuse with the existing 409 shape pointing at `ocx stop`, mirroring Windows.
Option (a) preserves the feature; option (b) is smaller and strictly safer. Existing coverage to extend
lives at `tests/service/stop-deferred-teardown.test.ts`.

**Note for the maintainer:** the same question applies to the Linux systemd branch and should be checked in
the same PR, since line 3866 exempts it identically.

## #3807 — unpaired-tool-result guard rejects the Codex desktop sub-agent seed

**Verdict: REIMPLEMENT — real defect on dev, no owning PR, C2. Rank 2 (highest impact).**

URL: https://github.com/lidge-jun/opencodex/issues/3807 · labels `bug`, `proxy` · authors `DaveW001`, corroborated by `stephen-drew` on Windows.

The guard added by #3471 is still production code at this SHA, emptiness-checked and adapter-keyed:

```
src/server/responses/core.ts:6092
  if (!("passthrough" in adapter && adapter.passthrough)) {
src/server/responses/core.ts:6093
    const unpaired = parsed.context.messages.find(
src/server/responses/core.ts:6094
      message => message.role === "toolResult"
src/server/responses/core.ts:6095
        && (typeof (message as { toolCallId?: unknown }).toolCallId !== "string"
src/server/responses/core.ts:6096
          || (message as { toolCallId: string }).toolCallId.length === 0),
src/server/responses/core.ts:6103
        "tool result requires a non-empty string call_id",
```

Provenance: `git log -L 6092,6106:src/server/responses/core.ts` shows the block introduced by
`4968d0f26 fix(responses,combos): reject unpaired tool results and fail over provider context caps (#3471)`
and **not modified since**.

Critically, the only work that has landed for this issue is test coverage, not a fix:

```
9cde6e735 test(responses): cover established task delivery and compaction
  "Coverage motivated by issue #3807 ... Production code and missing-call-id guards are unchanged."
  1 file changed, 124 insertions(+)  (tests/responses/responses-compaction-routing.test.ts)
```

That commit message is explicit that the guard is untouched, which confirms the defect is live. The
reporter's `curl` probe is a faithful reproduction of lines 6095-6096: emptiness only, never actual
pairing.

**Bounded fix:** repair instead of reject in the translating path — when a `toolResult` has an empty or
non-string `toolCallId`, synthesize a `call_`-prefixed id and continue, optionally emitting a
diagnostic. The comment block at `core.ts:6078-6091` already explains why this cannot move into the
schema, so the repair belongs at exactly this site. Do **not** add a config flag; the review comment on the
issue argues against it and it would grow the config surface.

**Risk to state honestly:** this weakens the #3259 protection that motivated #3471 (undefined `call_id`
reaching kiro/ollama/anthropic). A synthesized id satisfies those consumers structurally, but a reviewer
should confirm the anthropic path at `anthropic.ts` tolerates a tool_result whose id matches no tool_use.
That is the one judgment call in this otherwise mechanical fix.

## #3989 — Hermes whole-file conflicts

**Verdict: CLOSE — already fixed on dev.**

The registry entry now carries the source-preserving declaration the issue asked for:

```
src/integrations/registry.ts:189-194
  hermes: {
    id: "hermes",
    configPath: (env = process.env, home = homedir()) => hermesConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => hermesHomeDir(env, home),
    sourcePreservingYaml: { path: ["providers", "opencodex"] },
  },
```

`git blame` attributes line 193 to `a0e794d1d rrmlima 2026-09-07`, commit subject
`feat(integrations): support source-preserving YAML for Hermes Agent (#3989)`. PR #3990 is `CLOSED`
with the maintainer note: *"Landed on `dev` via #4030 (merge `5bb8faf7b`) with your commit carried by
`git cherry-pick -x`."* The issue was simply never closed alongside it.

**Closing comment to post:**

> Fixed on `dev`. `INTEGRATION_CLIENTS.hermes` now declares
> `sourcePreservingYaml: { path: ["providers", "opencodex"] }` at `src/integrations/registry.ts:193`,
> so `classifyIntegration` scopes ownership to that subtree and sibling providers, comments, and
> auxiliary models no longer trigger a `foreign-edit` / `unowned-key` whole-file conflict or the
> destructive Replace prompt.
>
> Landed via #4030 (`a0e794d1d`), carrying @rrmlima's commit from #3990. Thanks for the precise
> report — naming the missing registry field is what made this a one-line fix.
>
> Closing as fixed. If a multi-provider `~/.hermes/config.yaml` still reports `conflict` on a build
> from current `dev`, please reopen with the `state` / `reason` JSON and the `ocx` version.

## #3464 — mise upgrade leaves launchd proxy on an old version

**Verdict: CLOSE — already fixed on dev.**

`buildPlist` now accepts a stable launcher and documents this exact issue:

```
src/service.ts:490-497
 * Render the launchd plist. Mirrors `buildUnit`: when `deps.launcher` names a stable `ocx`
 * executable, the job execs that launcher instead of the package-local Bun + CLI pair, so a
 * version-manager upgrade (mise, asdf, nvm) that replaces the package directory is picked up
 * on the next launchd start instead of leaving the old build serving (#3464 — the macOS
 * counterpart of #2898).
export function buildPlist(
```

The install path resolves it once and shares it with install state:

```
src/service.ts:2296-2297
  const launcher = stableLauncherEntry();
  writeServiceDefinitionFile(p, buildPlist(resolvedProxyEnv(), { launcher }), "utf8");
```

Regression coverage names the issue in four places: `tests/service/service.test.ts:1190` (launcher named
in the plist, no versioned path baked), `:1219` (only a proof-bound Bun override survives), `:1236`
(shell/XML metacharacter quoting), `:3241` (start/status compare the live job against the expected
command). The diagnostic half also landed: `tests/cli/cli-version-skew.test.ts:22` —
`"#3464 directs a newer CLI to restart the older proxy"` — which fixes the misleading "your CLI is old"
wording the review comment flagged. Carried by `4e2246c32 fix(service): carry stable launchd launcher ownership (#3554) (#3616)`.

**Closing comment to post:**

> Fixed on `dev`. macOS now gets the same stable-launcher contract Linux received in #2898:
> `buildPlist` takes a `launcher` and execs the stable `ocx` entry instead of baking the
> package-local Bun + CLI pair (`src/service.ts:490-497`), and `installLaunchd` resolves it once and
> records it in install state (`src/service.ts:2296`). A mise/asdf upgrade that replaces the package
> directory is therefore picked up on the next launchd start, with no manual
> `ocx service restart`.
>
> Regression coverage: `tests/service/service.test.ts` (launcher named in the plist and no versioned
> path baked, proof-bound Bun override only, metacharacter quoting, live-job comparison) and
> `tests/cli/cli-version-skew.test.ts`, which also corrects the skew wording so it names which side
> is older — the reversed-diagnosis problem you hit.
>
> Thanks for identifying the external upgrade path and the downstream Copilot failure; that is what
> separated this from #3450. Closing as fixed.

## #3994 — 2.42.0 Plus quota exhaustion

**Verdict: CLOSE — duplicate of #3795, conceded by the reporter.**

The issue body states it directly: *"this matches the incomplete-terminal accounting defect in #3795, fixed
by #3791 ... it can be linked/closed as a duplicate of #3795. No reproduction on v2.46.0 or v2.47.0 has been
performed."* Observed on an installed 2.42.0; `dev` is 2.49.0. There is nothing to fix and no tip
regression claimed.

**Closing comment to post:**

> Closing as a duplicate of #3795, which is the disposition you proposed yourself.
>
> The incomplete-terminal quota accounting defect was fixed by #3791 and shipped in v2.46.0; `dev` is
> now on 2.49.0. Your evidence was captured on an installed 2.42.0, which predates that fix, so the 18
> consecutive `incomplete` terminals without failover are the known pre-fix behavior rather than a new
> defect.
>
> Thank you for the careful sanitized aggregation and for being explicit about what the logs do and do not
> establish — particularly that they show recovery on main without proving what initiated the account
> change. That precision is why this could be dispositioned without further investigation.
>
> If you see the same streak on 2.46.0 or later, please open a fresh report with the `ocx` version and
> the usage rows; that would be a genuine regression rather than this one.

## #3320 — Windows non-ASCII scheduler task

**Verdict: CLOSE — needs-info, stale (5 days, second unanswered request).**

Already labelled `needs-info`. The maintainer asked twice. On 2026-09-04 the ask was specific and
minimal: an `ocx service status --json` scheduler detail plus the `<Triggers>` block from an
**unpatched** build, because the reporter's SID evidence was collected *after* applying a local patch and
running `ocx service repair`, which may have recreated the task. No response since.

The maintainer's analysis also shows the pasted SID form should already validate: `cachedWindowsTaskUserIds()`
returns both `identity.sid` and `identity.name`, and `windowsTaskTriggerScopeAcceptable` accepts either.
So the report cannot currently be distinguished from a working configuration.

**Closing comment to post:**

> Closing as `stale-needs-info`. This is not a judgment that the report was invalid.
>
> The evidence needed to move it is a pre-repair capture from an unpatched build: the
> `ocx service status --json` scheduler detail, and the `<Triggers>` block from
> `schtasks /query /tn opencodex-proxy /xml` redacted the way you already did. The SID you shared was
> queried after a local compatibility patch and an `ocx service repair`, which may have rewritten the
> task, so it confirms the current shape rather than the failing one.
>
> That distinction matters because a SID-form `<UserId>` should already validate on current `dev`:
> `cachedWindowsTaskUserIds()` returns both the SID and the account name, and
> `windowsTaskTriggerScopeAcceptable` accepts a trigger matching either. The remaining candidates are
> that identity resolution fails outright on a non-ASCII account, or that the stock task differs from the
> repaired one — and only an unpatched capture separates them.
>
> Please reopen with that capture and it will be picked up. Thank you for the SID-shape confirmation and
> for redacting it carefully.

## #3245 — macOS Codex 0.152.0 streams disconnect

**Verdict: CLOSE — needs-info, stale, and the evidence points upstream.**

Already labelled `upstream-tracking` and `needs-info`. The decisive fact is the reporter's own probe:
the WebSocket upgrade received the intentional 426, Codex logged `falling back to HTTP`, and **no HTTP POST
ever reached the proxy** and no usage-log row was written. The OpenCodex data plane starts only on that
POST, so the SSE relay, terminal repair, idle timeout, and connection reuse were never entered.

`Ingwannu` independently checked `rust-v0.152.0` and `rust-v0.152.1`: `codex-rs/core/src/client.rs`
maps 426 to `FallbackToHttp` and should immediately issue the HTTP request, and the OCX side of that
contract is asserted green by `tests/server-auth.test.ts`. The reporter also found a working opt-in
(`ocx config set websockets true`). Three requests for a current-version retest have gone unanswered
since 2026-09-04, against a report filed at 2.39.0 while `dev` is now 2.49.0.

**Closing comment to post:**

> Closing as `stale-needs-info`. This was filed against 2.39.0 and `dev` is now 2.49.0, with
> substantial streaming and Responses changes in between, so a disconnect on that build cannot be
> attributed to current code.
>
> Your own transport probe is what makes this the honest outcome rather than a guess: the upgrade
> received the deliberate 426, Codex logged `falling back to HTTP`, and no subsequent
> `POST /v1/responses` reached the probe or the usage log. The OpenCodex Responses data plane does not
> begin until that POST, so the SSE relay, terminal repair, idle timeout, and outbound connection reuse
> were never reached and cannot explain the failure. The 426 → HTTP fallback is client-side, and our half
> of the contract is covered by a test asserting 426 followed by HTTP 200.
>
> `ocx config set websockets true` remains a valid opt-in for this environment.
>
> If it still reproduces on a current Codex CLI and a current `ocx`, please reopen with an
> `ocx logs --jsonl` excerpt spanning the disconnect, or a `run-request` entry captured with
> `ocx debug provider on` — specifically whether a POST leaves the client at all. Thank you for the
> localhost probe; it is the single most useful piece of evidence in this thread.

---

## DEFER items — one line each

- **#3782** Claude Desktop model switch. The CC Switch same-client comparison is real evidence, but the fix
  would change the alias shape at `src/claude/desktop-3p.ts:133-141`, whose `claude-opus-4-8-` prefix is
  deliberately chosen against Desktop's effort allowlist ("Desktop's effort selector is an allowlist keyed on
  exact supported model ids"). Changing it risks regressing effort controls and existing profiles.
- **#3781** Antigravity Fake-IP. Transport slice landed via #3872 (`ddee5e8b4`); the remainder is
  authenticated TUN field acceptance and failure categorization, neither observable without the reporter's
  network.
- **#3775** `minimal`/`none` on mapped Astra. Scoped part landed in #3804; the rest requires deciding
  how much arbitrary gateway capability to trust — product judgment.
- **#3765** Astra cache plateau. Explicitly "measured symptoms, not a proven OCX root cause"; existing logs
  cannot separate client prefix changes from upstream cache placement.
- **#3761** Ollama Cloud hosted `web_search`. The early return is at `src/web-search/index.ts:203` and
  `:223` (`if (!parsed._webSearch || isPassthrough) return ...`), but relaxing the guard alone just changes
  the failure mode; a real fix needs a destination-scoped bridge with credential and endpoint policy.
- **#3926** Google AI Studio `models[]`. `extractProviderModelItems` at
  `src/providers/model-discovery.ts:487-497` accepts only a top-level array or a `data` envelope, and the
  in-code comment states the exclusion is deliberate: *"Catalog discovery must not treat a stray `models` key
  on openai-chat responses as valid."* Promoting AI Studio's envelope is a policy change. Bounded **if** the
  maintainer rules it in scope, hence rank 5.
- **#3719** Anthropic thinking replay. Streaming-order slice landed via #3877 (`4fe4ad8df`); the rest needs
  live Anthropic credentials and controlled cache measurement.
- **#3675** 413. #3177 already maps a pre-stream 413 to a terminal `context_length_exceeded` event
  (`src/server/responses/context-overflow.ts:12,20-26`). What the reporter wants — OpenCode-style
  current-turn auto-shrink — is #2511's scope. Worth retitling to the residual rather than closing.
- **#3661** `unreadable_encrypted_agent_task`. Bounded refusal reasons landed via #3794; multipart
  reconstruction at `src/server/responses/agent-task-recovery.ts:150` (`|| encryptedPartCount !== 1`)
  needs an envelope contract decision.
- **#3657** Astra stream evidence. Live thread (2026-09-08) but the reporter answered the last two asks with
  "unknown". No code action available; leave open a little longer rather than close mid-exchange.
- **#3522** Windows spill. Diagnostic slice landed via #3790; the recovery remedy needs Windows ACL judgment
  and the maintainers explicitly want no automatic restart or memo clearing.
- **#3506** Cursor no-progress loop. #2628 already recorded that OCX cannot infer workspace progress from
  protocol activity; a mergeable design needs a client-supplied progress marker that may not exist.
- **#3433** Hermes zero cache hits. The controlled capture shows the client sends **none** of
  `prompt_cache_key`, `session_id`, `session-id`, `thread-id`, so there is no identifier for OCX
  to drop. Next step is reporter-side, not code.

---

## Shared files / stack order

**Lane D touches no files at all today** — every item is an issue, and the four REIMPLEMENT candidates are
proposals rather than branches. The overlap analysis below is therefore forward-looking, for whoever writes
those PRs.

Proposed touch sets for the four REIMPLEMENT candidates:

| Candidate | Source file | Test file |
| --- | --- | --- |
| #4032 | `src/codex/catalog/provider-fetch.ts` | new fixture near `tests/providers/provider-model-discovery-contract.test.ts` |
| #3807 | `src/server/responses/core.ts` | `tests/responses/responses-compaction-routing.test.ts` |
| #4035 | `src/codex/runtime.ts` | `tests/codex-integration/codex-runtime.test.ts` |
| #4023 | `src/server/management-api.ts`, `src/service.ts` | `tests/service/stop-deferred-teardown.test.ts` |

**Overlap with the luvs01 fixture train (#4004 #4012 #4014 #4015 #4039 #4034 #4041 #4036 #4043 #4025 #4006 #3997):**
I pulled the file list for all twelve. **No source-file collision with any lane-D candidate.** The train's
source files are `src/codex/project-config-warnings.ts` (#4039), `src/server/responses/collaboration.ts`
(#4034), `src/server/port-reclaim.ts` (#4036), `src/cli/effort.ts` (#4043),
`src/codex/account-lifecycle.ts` / `auth-collision.ts` / `auth-context.ts` /
`native-profile-startup.ts` (#4025), `src/codex/inject.ts` / `src/codex/journal.ts` (#4006), and
`src/codex/auth-context.ts` (#3997). None is `provider-fetch.ts`, `responses/core.ts`,
`codex/runtime.ts`, `management-api.ts`, or `service.ts`.

Two coordination notes worth flagging:

- **`src/codex/auth-context.ts` is shared inside the train itself** — #4025 and #3997 both touch it, as do
  both of their `tests/codex-integration/main-account-hard-lock-auth.test.ts` edits. Those two must be
  serialized against each other regardless of lane D.
- **`tests/clients/client-connect.test.ts` is shared by #4004 and #4006**, and
  `docs-site/.../reference/cli/lifecycle.md` (plus its `ko/` sibling) is shared by #4039, #4036, and
  #4006. Same serialization note.

**Recommended stack order if all four lane-D fixes are written:** fully parallel. They share no file with each
other or with the train, so each can be a standalone PR off `dev`. If a single stack is preferred, order by
descending confidence: #4032 → #3807 → #4035 → #4023.

**Within lane D, #4023 is the only candidate touching two source files** (`management-api.ts` and
`service.ts`), and `service.ts` is a large, frequently-edited file — write it last if the fixes land
sequentially.

