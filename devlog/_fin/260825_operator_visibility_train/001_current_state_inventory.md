# 001 — Current-state inventory

Read at `bb89eafbe`. Every line anchor below was opened and read, not inferred.

## #2457 — the pair check discards the union

The accepted union is complete. `src/server/management/config-routes.ts:591`:

```ts
const WEB_SEARCH_BACKENDS_UNION = ["openai", "anthropic", "xai", "gemini", "exa"] as const;
```

The pair check nineteen lines later throws it away. `config-routes.ts:668`:

```ts
const effectiveBackend = body.webSearch.backend === "anthropic"
  ? "anthropic"
  : body.webSearch.backend === "openai" || body.webSearch.backend === null
    ? "openai"
    : config.webSearchSidecar?.backend ?? "openai";
```

A submitted `"gemini"` is not `"anthropic"`, not `"openai"`, not `null`.
It falls to the final arm and the request is validated against the **stored**
backend. With stored `openai` (or unset), `webSearchModelIsRejected("openai",
"gemini-3.7-flash", candidates)` is true, and the route returns 400 before the
persistence block at `:687` — which does honor the full union — ever runs.

`src/server/management/agent-settings-routes.ts:1121` carries the same stale
ternary with a different null policy:

```ts
const effectiveBackend = section.backend === "anthropic"
  ? "anthropic"
  : section.backend === "openai"
    ? "openai"
    : section.backend === null
      ? config.webSearchSidecar?.backend ?? "openai"
      : stored?.backend ?? config.webSearchSidecar?.backend ?? "openai";
```

The comment directly above that block reads: *"Same module as
/api/sidecar-settings — a gate on one route and a stale copy on the other is no
gate at all."* The gate is shared; the backend resolution is not, and it drifted
exactly as the comment feared.

`xai` and `exa` have the identical hole. They escape notice because
backend-only submissions short-circuit on `effectiveModel` being empty.

The executor is already correct and must not be touched:
`resolveSidecarBackend("gemini")` returns `"gemini"`
(`src/web-search/index.ts:162`), and `planWebSearch` already defaults Gemini to
`gemini-3.7-flash` (`:285`). Writing the pair directly into `config.json`
works today, which is the reporter's own proof that only the write gate is wrong.

## #2411 — status has the routing kind and never prints it

`collectStatus()` already computes it. `src/cli/status.ts:188`:

```ts
const startup = collectStartupHealth(config, {
  service,
  shim: codexShim,
  routingKind: getCodexRoutingKind(),
});
```

`startup` lands on `json.startup` at `src/cli/status.ts:316`, so
`ocx status --json` **already exposes** `startup.routingKind`. The human
renderer is what drops it. `src/cli/index.ts:845`:

```ts
if (status.json.proxy.pid || status.json.proxy.health.ok) {
  console.log(`✅ Proxy: ${status.proxyLabel}`);
}
```

That boolean never consults `startup.routingKind`. A live PID or a good
`/healthz` is sufficient for the green check.

Worse, the next line reinforces it. `startupHealthSummary`
(`src/codex/autostart-health.ts:143`) renders native routing as *"native Codex
routing (no opencodex restart dependency)"*, and `deriveStartupHealth` marks it
`rebootSafe: true`. That is correct on its own terms — there is genuinely no
restart dependency when nothing routes — but printed under a green proxy it
reads as a second all-clear.

`ocx doctor` already prints the missing token. `src/cli/doctor.ts:986`:

```ts
console.log(`       routing=${startup.routingKind}, service=${...}, shim=${...}`);
```

So the fix is not new computation. It is routing the value that already exists
to the surface people actually run.

## #2412 — the ineligible verdict carries no message

`src/codex/shim.ts:2043`:

```ts
if (!existsSync(file.wrapperPath) || !hasUsableBackingPath(file)) return { status: "ineligible" };
```

No `message` field. That is why the condition is invisible: the CLI warns only
when one exists. `src/cli/codex-shim-autorestore.ts:35`:

```ts
} else if ((result.status === "deferred" || result.status === "ineligible") && result.message) {
  deps.warn(`⚠️  ${result.message}`);
}
```

A mise/asdf/volta upgrade rewrites the install tree in place, destroying both
`codex` and its sibling `codex.opencodex-real` (`backupPathFor`,
`src/codex/shim.ts:601`). `hasUsableBackingPath` (`:481`) then returns false,
the silent ineligible fires, and `ocx start` / `ocx ensure` /
`ocx service repair` all proceed to report success.

`diagnoseCodexShim` (`src/codex/shim.ts:2156`) already produces the exact
diagnostic string the reporter pasted. The information exists; nothing routes it
to the commands that matter.

## The common root

In all three, the correct value is computed and then discarded on the way to the
human: a validated union collapsed into a two-arm ternary, a routing kind
carried in JSON but not printed, a diagnosis produced by one command and absent
from three others. None of the three fixes changes what OpenCodex does. They
change what it admits.
